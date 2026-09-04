import type { AgentSummary } from "@openbot/contracts/ipc";
import type { AgentClient, AgentProvider } from "../agent-client";
import type { AgentStore } from "../agent-store";
import { BROWSER_DYNAMIC_TOOLS } from "../browser-host";
import { mergeConversationSnapshots } from "../conversation-snapshots";
import type { MailboxStore } from "../mailbox-store";
import { OPENBOT_DYNAMIC_TOOLS } from "../openbot-tools";
import { decodeRecordResponse, decodeThreadResponse, getString, type ResponseDecoder } from "../protocol";
import type { AgentMemories } from "./agent-memories";
import type { ContextCompaction } from "./context-compaction";
import type { ConversationRuntime } from "./conversation-runtime";
import { agentNamesById, estimateTokens, renderHandoffMessage, summarizeOldMessages } from "./delivery-content";
import { developerInstructions } from "./developer-instructions";
import { isArchivedThreadError, isMissingProviderSessionError } from "./thread-items";

export interface ThreadLifecycleHooks {
  /** Keeps the `agent-service` logger (and its prefix) as the single writer. */
  logRecovery(agentId: string, provider: AgentProvider, outcome: "resumed" | "replaced"): void;
}

export interface ThreadLifecycleOptions {
  store: AgentStore;
  mailbox: MailboxStore;
  conversation: ConversationRuntime;
  memories: AgentMemories;
  compaction: ContextCompaction;
  hooks: ThreadLifecycleHooks;
}

/**
 * Provider-thread lifecycle: binds an agent to a provider session, recovers
 * archived or missing sessions, and carries visible history across a session
 * replacement via a budgeted handoff.
 *
 * Owns the pending-handoff map (written when a replacement thread starts,
 * consumed by the drain scheduler) and the pending-runtime-refresh set
 * (written by `refreshAgentRuntime`, consumed before the next turn starts).
 * Never imports the facade; the drain scheduler takes this class directly.
 */
export class ThreadLifecycle {
  readonly #store: AgentStore;
  readonly #mailbox: MailboxStore;
  readonly #conversation: ConversationRuntime;
  readonly #memories: AgentMemories;
  readonly #compaction: ContextCompaction;
  readonly #hooks: ThreadLifecycleHooks;
  readonly #pendingHandoffs = new Map<string, string>();
  readonly #pendingRuntimeRefreshes = new Set<string>();

  constructor(options: ThreadLifecycleOptions) {
    this.#store = options.store;
    this.#mailbox = options.mailbox;
    this.#conversation = options.conversation;
    this.#memories = options.memories;
    this.#compaction = options.compaction;
    this.#hooks = options.hooks;
  }

  refreshAgentRuntime(agentId: string): void {
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error("The selected agent no longer exists.");
    this.#pendingRuntimeRefreshes.add(agentId);
    this.applyPendingRuntimeRefresh(agent);
  }

  consumePendingHandoff(threadId: string): string | undefined {
    return this.#pendingHandoffs.get(threadId);
  }

  deletePendingHandoff(threadId: string): void {
    this.#pendingHandoffs.delete(threadId);
  }

  dispose(): void {
    this.#pendingHandoffs.clear();
    this.#pendingRuntimeRefreshes.clear();
  }

  async ensureThread(agent: AgentSummary, client: AgentClient): Promise<string> {
    const publicThreadId = await this.#store.ensureThreadId(agent.id);
    const currentAgent = this.#store.list().find((candidate) => candidate.id === agent.id) ?? agent;
    const session = this.#store.activeProviderSession(agent.id);
    if (session) {
      if (this.#conversation.loadedClientFor(session.externalSessionId) !== client) {
        try {
          await this.resumeThread(currentAgent, client, session.externalSessionId);
        } catch (error) {
          if (!isMissingProviderSessionError(error, client.provider)) throw error;
          this.retireProviderSession(currentAgent, session.externalSessionId);
          const replacementThreadId = await this.startProviderThread(currentAgent, client, publicThreadId);
          this.#hooks.logRecovery(currentAgent.id, client.provider, "replaced");
          return replacementThreadId;
        }
      }
      this.#conversation.bindThread(session.externalSessionId, agent.id);
      return session.externalSessionId;
    }

    return this.startProviderThread(currentAgent, client, publicThreadId);
  }

  async startProviderThread(agent: AgentSummary, client: AgentClient, publicThreadId: string): Promise<string> {
    const response = await client.request(
      "thread/start",
      {
        model: agent.model,
        effort: agent.reasoningEffort,
        cwd: agent.workspacePath,
        runtimeWorkspaceRoots: [agent.workspacePath, this.#store.sharedRoot],
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
        developerInstructions: developerInstructions(agent, this.#store.sharedRoot, this.#memories.listFor(agent.id)),
        ephemeral: false,
        serviceName: "openbot",
        dynamicTools: [...BROWSER_DYNAMIC_TOOLS, OPENBOT_DYNAMIC_TOOLS],
      },
      decodeThreadResponse,
    );
    const externalThreadId = response.thread.id;
    this.#store.bindProviderSession(agent.id, externalThreadId);
    this.#conversation.bindThread(externalThreadId, agent.id);
    this.#conversation.markThreadLoaded(externalThreadId, client);
    this.#conversation.ensureSnapshot(agent.id, publicThreadId);
    const handoff = this.buildProviderHandoff(agent.id, publicThreadId);
    if (handoff) this.#pendingHandoffs.set(externalThreadId, handoff);
    return externalThreadId;
  }

  async resumeThread(agent: AgentSummary, client: AgentClient, externalThreadId: string): Promise<void> {
    const params = {
      threadId: externalThreadId,
      model: agent.model,
      effort: agent.reasoningEffort,
      cwd: agent.workspacePath,
      runtimeWorkspaceRoots: [agent.workspacePath, this.#store.sharedRoot],
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      developerInstructions: developerInstructions(agent, this.#store.sharedRoot, this.#memories.listFor(agent.id)),
      dynamicTools: [...BROWSER_DYNAMIC_TOOLS, OPENBOT_DYNAMIC_TOOLS],
    };

    try {
      await client.request("thread/resume", params, decodeRecordResponse);
    } catch (error) {
      if (client.provider !== "codex" || !isArchivedThreadError(error)) throw error;
      await client.request("thread/unarchive", { threadId: externalThreadId }, decodeRecordResponse);
      await client.request("thread/resume", params, decodeRecordResponse);
    }
    this.#conversation.markThreadLoaded(externalThreadId, client);
  }

  retireProviderSession(agent: AgentSummary, externalThreadId: string): void {
    const session = this.#store.activeProviderSession(agent.id);
    if (session?.externalSessionId !== externalThreadId || !agent.threadId) return;
    this.#store.database.deactivateProviderSessions(agent.threadId);
    this.#conversation.unbindThread(externalThreadId);
    this.#conversation.unloadThread(externalThreadId);
    this.#compaction.forgetThread(externalThreadId);
    this.#pendingHandoffs.delete(externalThreadId);
  }

  async requestWithArchivedThreadRecovery<T>(
    agent: AgentSummary,
    client: AgentClient,
    method: string,
    params: unknown,
    decoder: ResponseDecoder<T>,
  ): Promise<T> {
    try {
      return await client.request(method, params, decoder);
    } catch (error) {
      if (client.provider !== "codex" || !isArchivedThreadError(error)) throw error;
      const threadId = getString(params, "threadId");
      if (!threadId) throw error;
      await this.resumeThread(agent, client, threadId);
      return client.request(method, params, decoder);
    }
  }

  logRecovery(agentId: string, provider: AgentProvider, outcome: "resumed" | "replaced"): void {
    this.#hooks.logRecovery(agentId, provider, outcome);
  }

  applyPendingRuntimeRefresh(agent: AgentSummary): void {
    if (!this.#pendingRuntimeRefreshes.has(agent.id)) return;
    const session = this.#store.activeProviderSession(agent.id);
    if (!session || !agent.threadId) {
      this.#pendingRuntimeRefreshes.delete(agent.id);
      return;
    }
    const activeTurnId =
      this.#conversation.snapshot(agent.id)?.activeTurnId ??
      this.#store.database.readConversation(agent.id, agent.threadId).activeTurnId;
    if (activeTurnId) return;
    this.#store.database.deactivateProviderSessions(agent.threadId);
    this.#conversation.unbindThread(session.externalSessionId);
    this.#conversation.unloadThread(session.externalSessionId);
    this.#compaction.forgetThread(session.externalSessionId);
    this.#pendingHandoffs.delete(session.externalSessionId);
    this.#pendingRuntimeRefreshes.delete(agent.id);
  }

  buildProviderHandoff(agentId: string, threadId: string): string | null {
    if (this.#store.database.listProviderSessions(threadId).length < 2) return null;
    const persisted = this.#store.database.readConversation(agentId, threadId);
    const messages = mergeConversationSnapshots(persisted, {
      agentId,
      threadId,
      activeTurnId: null,
      revision: persisted.revision,
      messages: this.#mailbox.conversationMessages(agentId),
    }).messages.filter(
      (message) =>
        ["user", "assistant", "agent"].includes(message.author) &&
        message.itemType !== "commentary" &&
        (!message.delivery || ["completed", "failed", "interrupted"].includes(message.delivery.status)),
    );
    if (messages.length === 0) return null;

    const agentNames = agentNamesById(this.#store.list());
    const rendered = messages.map((message) => renderHandoffMessage(message, agentNames));
    const budgetTokens = 60_000;
    const fullText = rendered.join("\n\n");
    if (estimateTokens(fullText) <= budgetTokens) {
      return [
        "Continue this OpenBot conversation. The following transcript is user-visible history from the previous provider.",
        "Do not repeat completed work unless the current message asks for it.",
        "--- previous transcript ---",
        fullText,
        "--- end previous transcript ---",
      ].join("\n");
    }

    const newest: string[] = [];
    let newestTokens = 0;
    const newestBudget = Math.floor(budgetTokens * 0.85);
    let split = rendered.length;
    while (split > 0) {
      const candidate = rendered[split - 1];
      const tokens = estimateTokens(candidate);
      if (newestTokens + tokens > newestBudget) break;
      newest.unshift(candidate);
      newestTokens += tokens;
      split -= 1;
    }
    const oldMessages = messages.slice(0, split);
    const summaryText = summarizeOldMessages(oldMessages, budgetTokens - newestTokens, agentNames);
    this.#store.database.saveThreadSummary(
      threadId,
      oldMessages.at(-1)?.id ?? null,
      summaryText,
      estimateTokens(summaryText),
    );
    return [
      "Continue this OpenBot conversation. The oldest visible history was summarized because the provider handoff exceeded its context budget.",
      "--- saved summary of older history ---",
      summaryText,
      "--- full recent transcript ---",
      newest.join("\n\n"),
      "--- end previous transcript ---",
    ].join("\n");
  }
}

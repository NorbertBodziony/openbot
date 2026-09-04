import type {
  AgentApproval,
  AgentApprovalKind,
  AgentEvent,
  AgentPromptQuestion,
  AgentPromptResolution,
  AgentRuntimeSnapshot,
  BrowserTab,
  BrowserTakeoverRequest,
  RespondToApprovalInput,
  RespondToBrowserTakeoverInput,
  RespondToPromptInput,
} from "@openbot/contracts/ipc";
import { AGENT_RUNTIME_ATTENTION_LIMIT } from "@openbot/contracts/ipc";
import type { AgentClient } from "../agent-client";
import {
  type AppServerRequest,
  type DynamicToolCallParams,
  type DynamicToolResult,
  getRecord,
  getString,
  type RequestId,
} from "../protocol";
import type { ConversationRuntime } from "./conversation-runtime";
import {
  HOSTED_SITE_APPROVAL_METHOD,
  type HostedSiteApprovalTarget,
  type HostedSiteMutationContext,
} from "./hosted-site-coordinator";
import type { HostedSiteMutationTool } from "./hosted-site-events";
import {
  approvalPermissions,
  browserTakeoverError,
  browserTakeoverResult,
  commandText,
  dynamicPromptResult,
  mcpElicitationQuestion,
  mcpElicitationResult,
  promptQuestions,
  promptResolution,
  questionPromptText,
  validPromptQuestions,
} from "./prompts";
import { compactRuntimeApproval, compactRuntimeQuestion } from "./runtime-snapshot";
import { isDynamicToolCall } from "./thread-items";

interface PendingPrompt {
  client: AgentClient;
  id: RequestId;
  responseKind: "dynamic-tool" | "mcp-elicitation" | "user-input";
  params: unknown;
  agentId: string;
  publicThreadId: string;
  turnId: string;
  messageId: string;
  questions: AgentPromptQuestion[];
}

interface PendingApproval {
  client: AgentClient;
  id: RequestId;
  method: string;
  params: unknown;
  approval: AgentApproval;
  hostedSiteMutation?: HostedSiteMutationContext;
}

interface PendingBrowserTakeover {
  params: DynamicToolCallParams;
  request: BrowserTakeoverRequest;
  resolve: (result: DynamicToolResult) => void;
}

/**
 * The hosted-site half of an approval, narrow enough that the registry never learns what a site is.
 * `HostedSiteCoordinator` satisfies it.
 */
export interface HostedSiteApprovals {
  prepareApproval(
    client: AgentClient,
    request: AppServerRequest,
    params: DynamicToolCallParams,
    tool: HostedSiteMutationTool,
  ): Promise<{ approval: AgentApproval; mutation: HostedSiteMutationContext } | null>;
  resolveApproval(
    mutation: HostedSiteMutationContext,
    target: HostedSiteApprovalTarget,
    decision: "accept" | "decline",
  ): Promise<void>;
}

/**
 * How an outstanding question feeds back into a routine run's status. Implemented by the facade in
 * this PR and handed to `RoutineScheduler` in the next.
 */
export interface RoutineAttention {
  markNeedsAttention(turnId: string | null): void;
  markRunningForTurn(turnId: string | null): void;
}

export interface AttentionRegistryOptions {
  conversation: ConversationRuntime;
  browser: { listTabs(): BrowserTab[] };
  hostedSites: HostedSiteApprovals;
  routines: RoutineAttention;
  emit(event: AgentEvent): void;
  emitError(code: string, error: unknown, agentId?: string): void;
  emitRuntimeSnapshot(): void;
}

export type RuntimeAttention = Pick<
  AgentRuntimeSnapshot,
  "attentionComplete" | "pendingPrompts" | "pendingApprovals" | "pendingBrowserTakeovers"
>;

/**
 * Everything an agent can be blocked on waiting for the user: a question, an approval, a request to
 * take over a browser tab.
 *
 * The three live together because they are one queue as far as the product is concerned — the
 * runtime snapshot budgets them against a single attention limit in that order, duplication refuses
 * while any of them is outstanding, and a turn ending clears all three at once. Each also owes the
 * provider a response, so every path out of these maps either answers the request or cancels it;
 * an entry silently dropped is an agent stuck forever.
 */
export class AttentionRegistry {
  readonly #conversation: ConversationRuntime;
  readonly #browser: { listTabs(): BrowserTab[] };
  readonly #hostedSites: HostedSiteApprovals;
  readonly #routines: RoutineAttention;
  readonly #emit: (event: AgentEvent) => void;
  readonly #emitError: (code: string, error: unknown, agentId?: string) => void;
  readonly #emitRuntimeSnapshot: () => void;
  readonly #prompts = new Map<RequestId, PendingPrompt>();
  readonly #approvals = new Map<RequestId, PendingApproval>();
  readonly #takeovers = new Map<RequestId, PendingBrowserTakeover>();

  constructor(options: AttentionRegistryOptions) {
    this.#conversation = options.conversation;
    this.#browser = options.browser;
    this.#hostedSites = options.hostedSites;
    this.#routines = options.routines;
    this.#emit = options.emit;
    this.#emitError = options.emitError;
    this.#emitRuntimeSnapshot = options.emitRuntimeSnapshot;
  }

  hasAttentionFor(agentId: string): boolean {
    return (
      [...this.#prompts.values()].some((pending) => pending.agentId === agentId) ||
      [...this.#approvals.values()].some((pending) => pending.approval.agentId === agentId) ||
      [...this.#takeovers.values()].some((pending) => pending.request.agentId === agentId)
    );
  }

  /** The attention section of the runtime snapshot, budgeted prompts first and takeovers last. */
  runtimeAttention(): RuntimeAttention {
    const attentionComplete =
      this.#prompts.size + this.#approvals.size + this.#takeovers.size <= AGENT_RUNTIME_ATTENTION_LIMIT;
    let remainingAttention = AGENT_RUNTIME_ATTENTION_LIMIT;
    const pendingPrompts = [...this.#prompts.values()].slice(0, remainingAttention).map((pending) => ({
      requestId: pending.id,
      agentId: pending.agentId,
      threadId: pending.publicThreadId,
      turnId: pending.turnId,
      questions: pending.questions.map(compactRuntimeQuestion),
    }));
    remainingAttention -= pendingPrompts.length;
    const pendingApprovals = [...this.#approvals.values()]
      .slice(0, remainingAttention)
      .map((pending) => compactRuntimeApproval(pending.approval));
    remainingAttention -= pendingApprovals.length;
    const pendingBrowserTakeovers = [...this.#takeovers.values()]
      .slice(0, remainingAttention)
      .map((pending) => structuredClone(pending.request));
    return { attentionComplete, pendingPrompts, pendingApprovals, pendingBrowserTakeovers };
  }

  async respondToPrompt(input: RespondToPromptInput): Promise<void> {
    const pending = this.#prompts.get(input.requestId);
    if (!pending) throw new Error("This prompt is no longer active.");
    const questionIds = new Set(pending.questions.map((question) => question.id));
    if (Object.keys(input.answers).some((id) => !questionIds.has(id))) {
      throw new Error("A prompt answer does not match an active question.");
    }
    this.#routines.markRunningForTurn(getString(pending.params, "turnId"));

    const result =
      pending.responseKind === "dynamic-tool"
        ? dynamicPromptResult(input.answers)
        : pending.responseKind === "mcp-elicitation"
          ? mcpElicitationResult(pending.params, input.answers)
          : {
              answers: Object.fromEntries(
                Object.entries(input.answers).map(([id, values]) => [id, { answers: values }]),
              ),
            };
    pending.client.respond(pending.id, result);
    this.#prompts.delete(input.requestId);
    this.#emit({ type: "agent-input-resolved", kind: "prompt", requestId: input.requestId, agentId: pending.agentId });
    try {
      this.#resolvePersistedPrompt(pending, promptResolution(pending.questions, input.answers));
    } catch (error) {
      this.#emitError("prompt_persistence_failed", error, pending.agentId);
    }
    this.#emitRuntimeSnapshot();
  }

  async respondToApproval(input: RespondToApprovalInput): Promise<void> {
    const pending = this.#approvals.get(input.requestId);
    if (!pending) throw new Error("This approval is no longer active.");
    this.#routines.markRunningForTurn(getString(pending.params, "turnId"));

    if (pending.hostedSiteMutation) {
      this.#approvals.delete(input.requestId);
      await this.#hostedSites.resolveApproval(
        pending.hostedSiteMutation,
        { client: pending.client, id: pending.id, agentId: pending.approval.agentId },
        input.decision,
      );
    } else if (pending.approval.kind === "permissions") {
      const permissions = getRecord(pending.params, "permissions") ?? {};
      pending.client.respond(pending.id, {
        permissions: input.decision === "accept" ? permissions : {},
        scope: "turn",
      });
    } else if (pending.method === "applyPatchApproval" || pending.method === "execCommandApproval") {
      pending.client.respond(pending.id, {
        decision:
          input.decision === "accept" ? "approved" : { denied: { rejection: "The user declined this action." } },
      });
    } else {
      pending.client.respond(pending.id, { decision: input.decision });
    }
    this.#approvals.delete(input.requestId);
    this.#emit({
      type: "agent-input-resolved",
      kind: "approval",
      requestId: input.requestId,
      agentId: pending.approval.agentId,
    });
    this.#emitRuntimeSnapshot();
  }

  async respondToBrowserTakeover(input: RespondToBrowserTakeoverInput): Promise<void> {
    const pending = this.#takeovers.get(input.requestId);
    if (!pending) throw new Error("This browser takeover is no longer active.");
    this.#routines.markRunningForTurn(pending.request.turnId);
    this.#resolveBrowserTakeover(input.requestId, pending, input.decision);
  }

  surfaceApproval(client: AgentClient, request: AppServerRequest, kind: AgentApprovalKind): void {
    const threadId = getString(request.params, "threadId");
    const turnId = getString(request.params, "turnId") ?? (kind === "file-change" ? String(request.id) : null);
    const agentId = threadId ? this.#conversation.agentForThread(threadId) : undefined;
    if (!threadId || !turnId || !agentId) {
      this.#respondToMalformedApproval(client, request);
      return;
    }

    const approval: AgentApproval = {
      requestId: request.id,
      agentId,
      threadId: this.#conversation.publicThreadId(agentId, threadId),
      turnId,
      kind,
      command: commandText(request.params),
      cwd: getString(request.params, "cwd"),
      reason: getString(request.params, "reason"),
      grantRoot: getString(request.params, "grantRoot"),
      permissions: kind === "permissions" ? approvalPermissions(request.params) : null,
    };
    this.#approvals.set(request.id, {
      client,
      id: request.id,
      method: request.method,
      params: request.params,
      approval,
    });
    this.#routines.markNeedsAttention(turnId);
    this.#emit({ type: "approval", approval });
  }

  async surfaceHostedSiteApproval(
    client: AgentClient,
    request: AppServerRequest,
    params: DynamicToolCallParams,
    tool: HostedSiteMutationTool,
  ): Promise<void> {
    const prepared = await this.#hostedSites.prepareApproval(client, request, params, tool);
    if (!prepared) return;
    this.#approvals.set(request.id, {
      client,
      id: request.id,
      method: HOSTED_SITE_APPROVAL_METHOD,
      params,
      approval: prepared.approval,
      hostedSiteMutation: prepared.mutation,
    });
    this.#routines.markNeedsAttention(prepared.approval.turnId);
    this.#emit({ type: "approval", approval: prepared.approval });
  }

  surfaceLegacyApproval(client: AgentClient, request: AppServerRequest): void {
    const threadId = getString(request.params, "conversationId");
    const agentId = threadId ? this.#conversation.agentForThread(threadId) : undefined;
    if (!threadId || !agentId) {
      this.#respondToMalformedApproval(client, request);
      return;
    }

    const kind: AgentApprovalKind = request.method === "execCommandApproval" ? "command" : "file-change";
    const approval: AgentApproval = {
      requestId: request.id,
      agentId,
      threadId: this.#conversation.publicThreadId(agentId, threadId),
      turnId: getString(request.params, "turnId") ?? String(request.id),
      kind,
      command: commandText(request.params),
      cwd: getString(request.params, "cwd"),
      reason: getString(request.params, "reason"),
      grantRoot: getString(request.params, "grantRoot"),
      permissions: null,
    };
    this.#approvals.set(request.id, {
      client,
      id: request.id,
      method: request.method,
      params: request.params,
      approval,
    });
    this.#routines.markNeedsAttention(approval.turnId);
    this.#emit({ type: "approval", approval });
  }

  surfaceBrowserTakeover(request: AppServerRequest): Promise<DynamicToolResult> {
    if (!isDynamicToolCall(request.params)) return Promise.resolve(browserTakeoverError());
    const params = request.params;
    const { threadId, turnId } = params;
    const agentId = this.#conversation.agentForThread(threadId);
    const args = getRecord(params, "arguments");
    const tabId = getString(args, "tabId");
    const publicThreadId = agentId ? this.#conversation.publicThreadId(agentId, threadId) : null;
    const tab = tabId ? this.#browser.listTabs().find((candidate) => candidate.id === tabId) : undefined;
    if (
      !agentId ||
      !turnId ||
      !tabId ||
      !publicThreadId ||
      !tab ||
      tab.ownerThreadId !== publicThreadId ||
      tab.ownerAgentId !== agentId
    ) {
      return Promise.resolve(browserTakeoverError());
    }

    const takeover: BrowserTakeoverRequest = {
      requestId: request.id,
      agentId,
      threadId: publicThreadId,
      turnId,
      tabId,
    };
    return new Promise((resolve) => {
      this.#takeovers.set(request.id, {
        params,
        request: takeover,
        resolve,
      });
      this.#routines.markNeedsAttention(turnId);
      this.#emit({ type: "browser-takeover-requested", request: takeover });
    });
  }

  surfaceDynamicPrompt(client: AgentClient, request: AppServerRequest): void {
    const threadId = getString(request.params, "threadId");
    const turnId = getString(request.params, "turnId");
    const agentId = threadId ? this.#conversation.agentForThread(threadId) : undefined;
    const publicThreadId = threadId && agentId ? this.#conversation.publicThreadId(agentId, threadId) : null;
    const args = getRecord(request.params, "arguments");
    const questions = promptQuestions(args);
    if (!threadId || !turnId || !agentId || !publicThreadId || !validPromptQuestions(questions)) {
      client.respond(request.id, {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "OpenBot could not create a user question.",
          },
        ],
      });
      return;
    }

    const messageId = this.#persistQuestionPrompt(agentId, publicThreadId, turnId, request.id, questions);
    this.#prompts.set(request.id, {
      client,
      id: request.id,
      responseKind: "dynamic-tool",
      params: request.params,
      agentId,
      publicThreadId,
      turnId,
      messageId,
      questions,
    });
    this.#routines.markNeedsAttention(turnId);
    this.#emit({
      type: "prompt",
      requestId: request.id,
      agentId,
      threadId: publicThreadId,
      turnId,
      questions,
    });
  }

  surfacePrompt(client: AgentClient, request: AppServerRequest): void {
    const threadId = getString(request.params, "threadId");
    const turnId = getString(request.params, "turnId");
    const agentId = threadId ? this.#conversation.agentForThread(threadId) : undefined;
    if (!threadId || !turnId || !agentId) {
      client.respond(request.id, { answers: {} });
      return;
    }

    const questions = promptQuestions(request.params);
    if (!validPromptQuestions(questions)) {
      client.respond(request.id, { answers: {} });
      return;
    }
    const publicThreadId = this.#conversation.publicThreadId(agentId, threadId);
    const messageId = this.#persistQuestionPrompt(agentId, publicThreadId, turnId, request.id, questions);
    this.#prompts.set(request.id, {
      client,
      id: request.id,
      responseKind: "user-input",
      params: request.params,
      agentId,
      publicThreadId,
      turnId,
      messageId,
      questions,
    });
    this.#routines.markNeedsAttention(turnId);
    this.#emit({
      type: "prompt",
      requestId: request.id,
      agentId,
      threadId: publicThreadId,
      turnId,
      questions,
    });
  }

  surfaceMcpElicitation(client: AgentClient, request: AppServerRequest): void {
    const threadId = getString(request.params, "threadId");
    const turnId = getString(request.params, "turnId");
    const agentId = threadId ? this.#conversation.agentForThread(threadId) : undefined;
    const publicThreadId = threadId && agentId ? this.#conversation.publicThreadId(agentId, threadId) : null;
    const question = mcpElicitationQuestion(request.params);
    if (!threadId || !turnId || !agentId || !publicThreadId || !question) {
      client.respond(request.id, { action: "decline", content: null, _meta: null });
      this.#emitError(
        "mcp_safety_handoff",
        "A local plugin requested an unsupported security hand-off, so OpenBot declined it.",
        agentId,
      );
      return;
    }

    const questions = [question];
    const messageId = this.#persistQuestionPrompt(agentId, publicThreadId, turnId, request.id, questions);
    this.#prompts.set(request.id, {
      client,
      id: request.id,
      responseKind: "mcp-elicitation",
      params: request.params,
      agentId,
      publicThreadId,
      turnId,
      messageId,
      questions,
    });
    this.#routines.markNeedsAttention(turnId);
    this.#emit({
      type: "prompt",
      requestId: request.id,
      agentId,
      threadId: publicThreadId,
      turnId,
      questions,
    });
  }

  /** A turn ending expires its questions, drops its approvals and cancels its takeovers. */
  clearForTurn(threadId: string, turnId: string): void {
    for (const [requestId, pending] of this.#prompts) {
      const pendingThreadId = getString(pending.params, "threadId");
      const pendingTurnId = getString(pending.params, "turnId");
      if (pendingThreadId === threadId && pendingTurnId === turnId) {
        this.#resolvePersistedPrompt(pending, { status: "expired" });
        this.#prompts.delete(requestId);
      }
    }
    for (const [requestId, pending] of this.#approvals) {
      const pendingThreadId = getString(pending.params, "threadId") ?? getString(pending.params, "conversationId");
      const pendingTurnId = getString(pending.params, "turnId");
      if (pendingThreadId === threadId && (!pendingTurnId || pendingTurnId === turnId)) {
        this.#approvals.delete(requestId);
      }
    }
    for (const [requestId, pending] of this.#takeovers) {
      if (pending.params.threadId === threadId && pending.params.turnId === turnId) {
        this.#resolveBrowserTakeover(requestId, pending, "cancel");
      }
    }
  }

  clearPrompts(client?: AgentClient): void {
    for (const [requestId, pending] of this.#prompts) {
      if (client && pending.client !== client) continue;
      this.#resolvePersistedPrompt(pending, { status: "expired" });
      this.#prompts.delete(requestId);
    }
  }

  clearBrowserTakeovers(): void {
    for (const [requestId, pending] of this.#takeovers) {
      this.#resolveBrowserTakeover(requestId, pending, "cancel");
    }
  }

  clearApprovals(): void {
    this.#approvals.clear();
  }

  /** A takeover whose tab disappeared can never be answered, so the tab list closing one cancels it. */
  cancelTakeoversForMissingTabs(tabs: BrowserTab[]): void {
    for (const [requestId, pending] of this.#takeovers) {
      if (!tabs.some((tab) => tab.id === pending.request.tabId)) {
        this.#resolveBrowserTakeover(requestId, pending, "cancel");
      }
    }
  }

  #respondToMalformedApproval(client: AgentClient, request: AppServerRequest): void {
    if (request.method === "item/permissions/requestApproval") {
      client.respond(request.id, { permissions: {}, scope: "turn" });
      return;
    }
    if (request.method === "applyPatchApproval" || request.method === "execCommandApproval") {
      client.respond(request.id, {
        decision: { denied: { rejection: "OpenBot could not identify this approval." } },
      });
      return;
    }
    client.respond(request.id, { decision: "decline" });
  }

  #resolveBrowserTakeover(
    requestId: RequestId,
    pending: PendingBrowserTakeover,
    decision: RespondToBrowserTakeoverInput["decision"],
  ): void {
    this.#takeovers.delete(requestId);
    this.#emit({
      type: "browser-takeover-resolved",
      requestId: pending.request.requestId,
      agentId: pending.request.agentId,
    });
    this.#emitRuntimeSnapshot();
    pending.resolve(browserTakeoverResult(decision));
  }

  #persistQuestionPrompt(
    agentId: string,
    publicThreadId: string,
    turnId: string,
    requestId: RequestId,
    questions: AgentPromptQuestion[],
  ): string {
    const snapshot = this.#conversation.ensureSnapshot(agentId, publicThreadId);
    const messageId = `question-prompt:${turnId}:${String(requestId)}`;
    const existing = snapshot.messages.find((message) => message.id === messageId);
    if (!existing) {
      snapshot.messages.push({
        id: messageId,
        turnId,
        author: "assistant",
        source: "assistant",
        text: questionPromptText(questions, null),
        createdAt: new Date().toISOString(),
        status: "completed",
        itemType: "question_prompt",
        questionPrompt: {
          requestId,
          questions: structuredClone(questions),
          resolution: null,
        },
      });
      this.#conversation.emitConversation(snapshot, "prompt.requested", { turnId, requestId });
    }
    return messageId;
  }

  #resolvePersistedPrompt(pending: PendingPrompt, resolution: AgentPromptResolution): void {
    const snapshot = this.#conversation.ensureSnapshot(pending.agentId, pending.publicThreadId);
    const message = snapshot.messages.find((candidate) => candidate.id === pending.messageId);
    if (!message?.questionPrompt || message.questionPrompt.resolution !== null) return;
    message.questionPrompt.resolution = structuredClone(resolution);
    message.text = questionPromptText(message.questionPrompt.questions, resolution);
    this.#conversation.emitConversation(snapshot, "prompt.resolved", {
      turnId: pending.turnId,
      requestId: pending.id,
      status: resolution.status,
    });
  }
}

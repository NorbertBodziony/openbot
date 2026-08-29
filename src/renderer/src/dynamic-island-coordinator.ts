import type {
  AgentEvent,
  AgentRuntimeWorkItem,
  DynamicIslandAction,
  DynamicIslandPresentation,
  QueueSnapshot,
  ScopedAgentEvent,
} from "@openbot/contracts/ipc";
import {
  countDynamicIslandAttention,
  createDynamicIslandPresentation,
  type DynamicIslandMessageSource,
  type DynamicIslandPresentationInput,
  selectDynamicIslandPresentation,
} from "./dynamic-island-presentation";

type ServerRuntime = DynamicIslandPresentationInput & {
  seenIncomingMessageIds: Set<string>;
  resolvedPrompts: Map<string, string>;
  receivedRuntimeSnapshot: boolean;
};

export class DynamicIslandCoordinator {
  readonly #servers = new Map<string, ServerRuntime>();

  serverState(
    serverId: string,
  ): Pick<
    DynamicIslandPresentationInput,
    "activeTurns" | "queues" | "pendingPrompts" | "pendingApprovals" | "failedTurns"
  > | null {
    const runtime = this.#servers.get(serverId);
    if (!runtime) return null;
    return structuredClone({
      activeTurns: runtime.activeTurns,
      queues: runtime.queues,
      pendingPrompts: runtime.pendingPrompts,
      pendingApprovals: runtime.pendingApprovals,
      failedTurns: runtime.failedTurns,
    });
  }

  replaceServer(input: DynamicIslandPresentationInput): void {
    const previous = this.#servers.get(input.serverId);
    const resolvedPrompts = previous?.resolvedPrompts ?? new Map();
    const pendingApprovals = { ...input.pendingApprovals };
    const pendingPrompts = { ...input.pendingPrompts };
    for (const [botId, requestId] of resolvedPrompts) {
      const prompt = pendingPrompts[botId];
      if (prompt?.type === "prompt" && String(prompt.requestId) === requestId) pendingPrompts[botId] = undefined;
      else resolvedPrompts.delete(botId);
    }
    this.#servers.set(input.serverId, {
      ...input,
      pendingApprovals,
      pendingPrompts,
      seenIncomingMessageIds: previous?.seenIncomingMessageIds ?? new Set(),
      resolvedPrompts,
      receivedRuntimeSnapshot: previous?.receivedRuntimeSnapshot ?? false,
    });
  }

  retainServers(serverIds: readonly string[]): void {
    const retained = new Set(serverIds);
    for (const serverId of this.#servers.keys()) {
      if (!retained.has(serverId)) this.#servers.delete(serverId);
    }
  }

  applyEvent({ serverId, event }: ScopedAgentEvent, activeServerId: string): void {
    const runtime = this.#runtime(serverId);
    switch (event.type) {
      case "bots-changed":
        runtime.bots = event.bots;
        return;
      case "runtime-snapshot":
        this.#replaceRuntimeSnapshot(serverId, runtime, event.snapshot, serverId !== activeServerId);
        return;
      case "conversation": {
        runtime.activeTurns[event.snapshot.botId] = event.snapshot.activeTurnId;
        const messages = event.snapshot.messages.flatMap(toDynamicIslandMessage);
        const previousMessages = runtime.liveMessages[event.snapshot.botId];
        runtime.liveMessages[event.snapshot.botId] = messages;
        if (serverId !== activeServerId) {
          if (previousMessages === undefined) this.#seedIncoming(runtime, messages);
          else {
            const previousIds = new Set(previousMessages.map((message) => message.id));
            this.#recordIncoming(
              runtime,
              event.snapshot.botId,
              messages.filter((message) => !previousIds.has(message.id)),
            );
          }
        }
        return;
      }
      case "conversation-delta": {
        const messages = runtime.liveMessages[event.botId] ?? [];
        const existing = messages.find((message) => message.id === event.messageId);
        if (existing) existing.body += event.delta;
        else {
          const message = {
            id: event.messageId,
            author: "bot",
            body: event.delta,
            time: event.createdAt,
            createdAt: event.createdAt,
          };
          runtime.liveMessages[event.botId] = [...messages, message];
          if (serverId !== activeServerId) this.#recordIncoming(runtime, event.botId, [message]);
        }
        return;
      }
      case "queue-changed":
        runtime.queues[event.snapshot.botId] = event.snapshot;
        return;
      case "turn-started":
        runtime.activeTurns[event.botId] = event.turnId;
        delete runtime.failedTurns[event.botId];
        return;
      case "turn-completed":
        runtime.activeTurns[event.botId] = null;
        runtime.pendingPrompts[event.botId] = undefined;
        runtime.pendingApprovals[event.botId] = undefined;
        if (event.status === "failed") runtime.failedTurns[event.botId] = event.turnId;
        else delete runtime.failedTurns[event.botId];
        return;
      case "prompt":
        runtime.resolvedPrompts.delete(event.botId);
        runtime.pendingPrompts[event.botId] = event;
        return;
      case "approval":
        runtime.pendingApprovals[event.approval.botId] = event.approval;
        return;
      case "browser-takeover-requested":
        runtime.pendingPrompts[event.request.botId] = event;
        return;
      case "browser-takeover-resolved": {
        const pending = runtime.pendingPrompts[event.botId];
        if (pending?.type === "browser-takeover-requested" && pending.request.requestId === event.requestId) {
          runtime.pendingPrompts[event.botId] = undefined;
        }
        return;
      }
      default:
        return;
    }
  }

  resolveAction(action: DynamicIslandAction): void {
    if (action.type === "open-app") return;
    const runtime = this.#servers.get(action.serverId);
    if (!runtime) return;
    if (action.type === "answer-prompt") {
      const prompt = runtime.pendingPrompts[action.botId];
      if (prompt?.type === "prompt" && String(prompt.requestId) === String(action.requestId)) {
        runtime.pendingPrompts[action.botId] = undefined;
        runtime.resolvedPrompts.set(action.botId, String(action.requestId));
      }
    }
    if (action.type === "open-failure" && runtime.failedTurns[action.botId] === action.turnId) {
      delete runtime.failedTurns[action.botId];
    }
  }

  presentation(serverOrder: readonly string[]): DynamicIslandPresentation {
    let attentionCount = 0;
    const ordered = serverOrder.flatMap((serverId) => {
      const runtime = this.#servers.get(serverId);
      if (runtime) attentionCount += countDynamicIslandAttention(runtime);
      return runtime ? [createDynamicIslandPresentation(runtime)] : [];
    });
    return selectDynamicIslandPresentation(ordered, attentionCount);
  }

  #runtime(serverId: string): ServerRuntime {
    const existing = this.#servers.get(serverId);
    if (existing) return existing;
    const runtime: ServerRuntime = {
      serverId,
      bots: [],
      activeTurns: {},
      queues: {},
      unreadReplies: {},
      unreadMessageIds: {},
      liveMessages: {},
      pendingPrompts: {},
      pendingApprovals: {},
      failedTurns: {},
      seenIncomingMessageIds: new Set(),
      resolvedPrompts: new Map(),
      receivedRuntimeSnapshot: false,
    };
    this.#servers.set(serverId, runtime);
    return runtime;
  }

  #recordIncoming(runtime: ServerRuntime, botId: string, messages: DynamicIslandMessageSource[]): void {
    for (const message of messages) {
      if (message.author !== "bot" || runtime.seenIncomingMessageIds.has(message.id)) continue;
      runtime.seenIncomingMessageIds.add(message.id);
      runtime.unreadReplies[botId] = (runtime.unreadReplies[botId] ?? 0) + 1;
      runtime.unreadMessageIds ??= {};
      runtime.unreadMessageIds[botId] ??= message.id;
    }
  }

  #seedIncoming(runtime: ServerRuntime, messages: DynamicIslandMessageSource[]): void {
    for (const message of messages) {
      if (message.author === "bot") runtime.seenIncomingMessageIds.add(message.id);
    }
  }

  #replaceRuntimeSnapshot(
    serverId: string,
    runtime: ServerRuntime,
    snapshot: Extract<AgentEvent, { type: "runtime-snapshot" }>["snapshot"],
    trackIncoming: boolean,
  ): void {
    const liveMessages: Record<string, DynamicIslandMessageSource[]> = {};
    for (const message of snapshot.latestMessages) {
      const converted = {
        id: message.id,
        author: "bot",
        body: message.text,
        time: message.createdAt,
        createdAt: message.createdAt,
      };
      liveMessages[message.botId] = [converted];
      if (!trackIncoming) continue;
      if (!runtime.receivedRuntimeSnapshot) this.#seedIncoming(runtime, [converted]);
      else if (!(runtime.liveMessages[message.botId] ?? []).some((previous) => previous.id === message.id)) {
        this.#recordIncoming(runtime, message.botId, [converted]);
      }
    }
    const pendingPrompts: DynamicIslandPresentationInput["pendingPrompts"] = {};
    for (const prompt of snapshot.pendingPrompts) pendingPrompts[prompt.botId] = { type: "prompt", ...prompt };
    for (const request of snapshot.pendingBrowserTakeovers) {
      pendingPrompts[request.botId] = { type: "browser-takeover-requested", request };
    }
    this.replaceServer({
      serverId,
      bots: snapshot.bots,
      activeTurns: Object.fromEntries(snapshot.activeTurns.map((turn) => [turn.botId, turn.turnId])),
      queues: queueSnapshotsFromRuntimeWork(snapshot.work),
      unreadReplies: { ...runtime.unreadReplies },
      unreadMessageIds: { ...runtime.unreadMessageIds },
      liveMessages,
      pendingPrompts,
      pendingApprovals: Object.fromEntries(snapshot.pendingApprovals.map((approval) => [approval.botId, approval])),
      failedTurns: Object.fromEntries(snapshot.failedTurns.map((turn) => [turn.botId, turn.turnId])),
    });
    this.#runtime(serverId).receivedRuntimeSnapshot = true;
  }
}

export function queueSnapshotsFromRuntimeWork(work: readonly AgentRuntimeWorkItem[]): Record<string, QueueSnapshot> {
  const queues: Record<string, QueueSnapshot> = {};
  for (const item of work) {
    const queue = queues[item.botId] ?? { botId: item.botId, deliveries: [] };
    queues[item.botId] = queue;
    queue.deliveries.push({
      id: item.id,
      messageId: item.id,
      recipientBotId: item.botId,
      sender: { kind: "user" },
      text: item.text,
      attachments: [],
      replyToMessageId: null,
      status: item.status,
      position: null,
      turnId: item.turnId,
      error: item.error,
      createdAt: "",
    });
  }
  return queues;
}

function toDynamicIslandMessage(
  message: Extract<AgentEvent, { type: "conversation" }>["snapshot"]["messages"][number],
) {
  if (message.author !== "assistant" && message.author !== "agent") return [];
  return [{ id: message.id, author: "bot", body: message.text, time: message.createdAt, createdAt: message.createdAt }];
}

import type {
  AgentEvent,
  BotSummary,
  DynamicIslandAction,
  DynamicIslandPresentation,
  ScopedAgentEvent,
} from "@openbot/contracts/ipc";
import {
  createDynamicIslandPresentation,
  type DynamicIslandMessageSource,
  type DynamicIslandPresentationInput,
  selectDynamicIslandPresentation,
} from "./dynamic-island-presentation";

type ServerRuntime = DynamicIslandPresentationInput & {
  seenIncomingMessageIds: Set<string>;
  resolvedApprovals: Map<string, string>;
  resolvedPrompts: Map<string, string>;
};

export class DynamicIslandCoordinator {
  readonly #servers = new Map<string, ServerRuntime>();

  replaceServer(input: DynamicIslandPresentationInput): void {
    const previous = this.#servers.get(input.serverId);
    const resolvedApprovals = previous?.resolvedApprovals ?? new Map();
    const resolvedPrompts = previous?.resolvedPrompts ?? new Map();
    const pendingApprovals = { ...input.pendingApprovals };
    const pendingPrompts = { ...input.pendingPrompts };
    for (const [botId, requestId] of resolvedApprovals) {
      const approval = pendingApprovals[botId];
      if (approval && String(approval.requestId) === requestId) pendingApprovals[botId] = undefined;
      else resolvedApprovals.delete(botId);
    }
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
      resolvedApprovals,
      resolvedPrompts,
    });
  }

  setBots(serverId: string, bots: BotSummary[]): void {
    this.#runtime(serverId).bots = bots;
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
      case "conversation": {
        runtime.activeTurns[event.snapshot.botId] = event.snapshot.activeTurnId;
        const messages = event.snapshot.messages.flatMap(toDynamicIslandMessage);
        runtime.liveMessages[event.snapshot.botId] = messages;
        if (serverId !== activeServerId) this.#recordIncoming(runtime, event.snapshot.botId, messages);
        return;
      }
      case "conversation-delta": {
        const messages = runtime.liveMessages[event.botId] ?? [];
        const existing = messages.find((message) => message.id === event.messageId);
        if (existing) existing.body += event.delta;
        else {
          const message = { id: event.messageId, author: "bot", body: event.delta, time: event.createdAt };
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
        runtime.resolvedApprovals.delete(event.approval.botId);
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
    if (action.type === "approve-attention") {
      const approval = runtime.pendingApprovals[action.botId];
      if (approval && String(approval.requestId) === String(action.requestId)) {
        runtime.pendingApprovals[action.botId] = undefined;
        runtime.resolvedApprovals.set(action.botId, String(action.requestId));
      }
    }
    if (action.type === "answer-prompt") {
      const prompt = runtime.pendingPrompts[action.botId];
      if (prompt?.type === "prompt" && String(prompt.requestId) === String(action.requestId)) {
        runtime.pendingPrompts[action.botId] = undefined;
        runtime.resolvedPrompts.set(action.botId, String(action.requestId));
      }
    }
  }

  presentation(serverOrder: readonly string[]): DynamicIslandPresentation {
    const ordered = serverOrder.flatMap((serverId) => {
      const runtime = this.#servers.get(serverId);
      return runtime ? [createDynamicIslandPresentation(runtime)] : [];
    });
    return selectDynamicIslandPresentation(ordered);
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
      resolvedApprovals: new Map(),
      resolvedPrompts: new Map(),
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
}

function toDynamicIslandMessage(
  message: Extract<AgentEvent, { type: "conversation" }>["snapshot"]["messages"][number],
) {
  if (message.author !== "assistant" && message.author !== "agent") return [];
  return [{ id: message.id, author: "bot", body: message.text, time: message.createdAt }];
}

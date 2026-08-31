import type {
  AgentEvent,
  AgentRuntimeWorkItem,
  DynamicIslandAction,
  DynamicIslandPresentation,
  QueueSnapshot,
  ScopedAgentEvent,
} from "@openbot/contracts/ipc";
import { cleanAgentMessageText } from "./agent-message-text";
import {
  countDynamicIslandAttention,
  createDynamicIslandPresentation,
  type DynamicIslandMessageSource,
  type DynamicIslandPresentationInput,
  selectDynamicIslandPresentation,
} from "./dynamic-island-presentation";

type ServerRuntime = DynamicIslandPresentationInput & {
  incomingMessageAnchors: Map<string, string>;
  completedBots: Set<string>;
  lastRecordedMessageIds: Map<string, string>;
  receivedConversations: Set<string>;
  resolvedPrompts: Map<string, string>;
  rawMessageBodies: Map<string, string>;
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
    const botIds = new Set(input.bots.map((bot) => bot.id));
    const incomingMessageAnchors = activeMessageAnchors(input.liveMessages, previous?.incomingMessageAnchors);
    const completedBots = new Set(previous?.completedBots);
    const lastRecordedMessageIds = new Map(previous?.lastRecordedMessageIds);
    for (const botId of incomingMessageAnchors.keys()) if (!botIds.has(botId)) incomingMessageAnchors.delete(botId);
    for (const botId of completedBots) if (!botIds.has(botId)) completedBots.delete(botId);
    for (const botId of lastRecordedMessageIds.keys()) if (!botIds.has(botId)) lastRecordedMessageIds.delete(botId);
    const receivedConversations = [...(previous?.receivedConversations ?? [])].filter((botId) => botIds.has(botId));
    const liveMessages = compactLiveMessages(input.liveMessages);
    const rawMessageBodies = new Map(previous?.rawMessageBodies);
    const retainedMessageKeys = new Set<string>();
    for (const [botId, messages] of Object.entries(liveMessages)) {
      for (const message of messages) {
        const key = dynamicIslandMessageKey(botId, message.id);
        retainedMessageKeys.add(key);
        if (!rawMessageBodies.has(key)) rawMessageBodies.set(key, message.body);
      }
    }
    for (const key of rawMessageBodies.keys()) {
      if (!retainedMessageKeys.has(key)) rawMessageBodies.delete(key);
    }
    this.#servers.set(input.serverId, {
      ...input,
      pendingApprovals,
      pendingPrompts,
      liveMessages,
      incomingMessageAnchors,
      completedBots,
      lastRecordedMessageIds,
      receivedConversations: new Set([...receivedConversations, ...Object.keys(input.liveMessages)]),
      resolvedPrompts,
      rawMessageBodies,
      receivedRuntimeSnapshot: previous?.receivedRuntimeSnapshot ?? false,
    });
  }

  retainServers(serverIds: readonly string[]): void {
    const retained = new Set(serverIds);
    for (const serverId of this.#servers.keys()) {
      if (!retained.has(serverId)) this.#servers.delete(serverId);
    }
  }

  applyEvent({ serverId, event, bufferedLive }: ScopedAgentEvent, activeServerId: string): void {
    const runtime = this.#runtime(serverId);
    switch (event.type) {
      case "bots-changed":
        runtime.bots = event.bots;
        this.#retainBotMessages(runtime, new Set(event.bots.map((bot) => bot.id)));
        return;
      case "runtime-snapshot":
        this.#replaceRuntimeSnapshot(serverId, runtime, event.snapshot, serverId !== activeServerId);
        return;
      case "conversation": {
        runtime.activeTurns[event.snapshot.botId] = event.snapshot.activeTurnId;
        deleteDynamicIslandMessageBodies(runtime.rawMessageBodies, event.snapshot.botId);
        for (const message of event.snapshot.messages) {
          const key = dynamicIslandMessageKey(event.snapshot.botId, message.id);
          if (message.author !== "user" && message.status === "streaming") {
            runtime.rawMessageBodies.set(key, message.text);
          } else runtime.rawMessageBodies.delete(key);
        }
        const messages = event.snapshot.messages.flatMap(toDynamicIslandMessage);
        const anchorId = runtime.incomingMessageAnchors.get(event.snapshot.botId);
        const receivedConversation = runtime.receivedConversations.has(event.snapshot.botId);
        const latest = messages.at(-1);
        if (latest) runtime.liveMessages[event.snapshot.botId] = [latest];
        else if (event.snapshot.messages.length === 0) runtime.liveMessages[event.snapshot.botId] = [];
        if (serverId !== activeServerId) {
          if (anchorId) {
            const anchorIndex = messages.findIndex((message) => message.id === anchorId);
            if (anchorIndex >= 0) {
              const incoming = messages.slice(anchorIndex + 1);
              this.#recordIncoming(
                runtime,
                event.snapshot.botId,
                incoming.length > 0 ? incoming : bufferedLive && latest ? [latest] : [],
              );
            }
          } else if (receivedConversation) this.#recordIncoming(runtime, event.snapshot.botId, messages);
          else if (bufferedLive && latest) this.#recordIncoming(runtime, event.snapshot.botId, [latest]);
        }
        if (latest) runtime.incomingMessageAnchors.set(event.snapshot.botId, latest.id);
        else if (event.snapshot.messages.length === 0) runtime.incomingMessageAnchors.delete(event.snapshot.botId);
        runtime.receivedConversations.add(event.snapshot.botId);
        return;
      }
      case "conversation-delta": {
        const messages = runtime.liveMessages[event.botId] ?? [];
        const existing = messages.find((message) => message.id === event.messageId);
        if (existing) {
          const key = dynamicIslandMessageKey(event.botId, event.messageId);
          const rawBody = (runtime.rawMessageBodies.get(key) ?? existing.body) + event.delta;
          runtime.rawMessageBodies.set(key, rawBody);
          existing.body = cleanAgentMessageText(rawBody);
        }
        return;
      }
      case "queue-changed":
        runtime.queues[event.snapshot.botId] = event.snapshot;
        return;
      case "turn-started":
        runtime.completedBots.delete(event.botId);
        runtime.activeTurns[event.botId] = event.turnId;
        delete runtime.failedTurns[event.botId];
        return;
      case "turn-completed":
        if (
          serverId !== activeServerId &&
          event.status === "completed" &&
          runtime.activeTurns[event.botId] === event.turnId
        ) {
          runtime.completedBots.add(event.botId);
        }
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
      case "agent-input-resolved":
        if (event.kind === "prompt") {
          const prompt = runtime.pendingPrompts[event.botId];
          if (prompt?.type === "prompt" && String(prompt.requestId) === String(event.requestId)) {
            runtime.pendingPrompts[event.botId] = undefined;
            runtime.resolvedPrompts.set(event.botId, String(event.requestId));
          }
        } else {
          const approval = runtime.pendingApprovals[event.botId];
          if (approval && String(approval.requestId) === String(event.requestId)) {
            runtime.pendingApprovals[event.botId] = undefined;
          }
        }
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
    if (action.type === "respond-approval") {
      const approval = runtime.pendingApprovals[action.botId];
      if (approval && String(approval.requestId) === String(action.requestId)) {
        runtime.pendingApprovals[action.botId] = undefined;
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
      incomingMessageAnchors: new Map(),
      completedBots: new Set(),
      lastRecordedMessageIds: new Map(),
      receivedConversations: new Set(),
      resolvedPrompts: new Map(),
      rawMessageBodies: new Map(),
      receivedRuntimeSnapshot: false,
    };
    this.#servers.set(serverId, runtime);
    return runtime;
  }

  #recordIncoming(runtime: ServerRuntime, botId: string, messages: DynamicIslandMessageSource[]): void {
    for (const message of messages) {
      if (message.author !== "bot") continue;
      if (runtime.lastRecordedMessageIds.get(botId) === message.id) continue;
      runtime.unreadReplies[botId] = (runtime.unreadReplies[botId] ?? 0) + 1;
      runtime.unreadMessageIds ??= {};
      runtime.unreadMessageIds[botId] ??= message.id;
      runtime.lastRecordedMessageIds.set(botId, message.id);
    }
  }

  #retainBotMessages(runtime: ServerRuntime, botIds: ReadonlySet<string>): void {
    for (const botId of runtime.incomingMessageAnchors.keys()) {
      if (!botIds.has(botId)) runtime.incomingMessageAnchors.delete(botId);
    }
    for (const botId of runtime.completedBots) if (!botIds.has(botId)) runtime.completedBots.delete(botId);
    for (const botId of runtime.lastRecordedMessageIds.keys()) {
      if (!botIds.has(botId)) runtime.lastRecordedMessageIds.delete(botId);
    }
    for (const botId of runtime.receivedConversations) {
      if (!botIds.has(botId)) runtime.receivedConversations.delete(botId);
    }
    for (const botId of Object.keys(runtime.liveMessages)) {
      if (!botIds.has(botId)) delete runtime.liveMessages[botId];
    }
    for (const key of runtime.rawMessageBodies.keys()) {
      if (!botIds.has(key.slice(0, key.indexOf("\0")))) runtime.rawMessageBodies.delete(key);
    }
  }

  #replaceRuntimeSnapshot(
    serverId: string,
    runtime: ServerRuntime,
    snapshot: Extract<AgentEvent, { type: "runtime-snapshot" }>["snapshot"],
    trackIncoming: boolean,
  ): void {
    const liveMessages: Record<string, DynamicIslandMessageSource[]> = {};
    const incomingMessageAnchors = new Map(runtime.incomingMessageAnchors);
    for (const botId of new Set(snapshot.latestMessages.map((message) => message.botId))) {
      deleteDynamicIslandMessageBodies(runtime.rawMessageBodies, botId);
    }
    for (const message of snapshot.latestMessages) {
      runtime.rawMessageBodies.set(dynamicIslandMessageKey(message.botId, message.id), message.text);
      const converted = {
        id: message.id,
        author: "bot",
        body: cleanAgentMessageText(message.text),
        time: message.createdAt,
        createdAt: message.createdAt,
      };
      liveMessages[message.botId] = [converted];
      incomingMessageAnchors.set(message.botId, message.id);
      if (!trackIncoming) continue;
      if (
        runtime.completedBots.has(message.botId) ||
        (runtime.receivedRuntimeSnapshot && runtime.incomingMessageAnchors.get(message.botId) !== message.id)
      ) {
        this.#recordIncoming(runtime, message.botId, [converted]);
      }
    }
    runtime.completedBots.clear();
    const pendingPrompts: DynamicIslandPresentationInput["pendingPrompts"] = snapshot.attentionComplete
      ? {}
      : { ...runtime.pendingPrompts };
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
      pendingApprovals: {
        ...(snapshot.attentionComplete ? {} : runtime.pendingApprovals),
        ...Object.fromEntries(snapshot.pendingApprovals.map((approval) => [approval.botId, approval])),
      },
      failedTurns: Object.fromEntries(snapshot.failedTurns.map((turn) => [turn.botId, turn.turnId])),
    });
    const nextRuntime = this.#runtime(serverId);
    nextRuntime.incomingMessageAnchors = incomingMessageAnchors;
    nextRuntime.receivedRuntimeSnapshot = true;
  }
}

function dynamicIslandMessageKey(botId: string, messageId: string): string {
  return `${botId}\0${messageId}`;
}

function deleteDynamicIslandMessageBodies(messages: Map<string, string>, botId: string): void {
  const prefix = `${botId}\0`;
  for (const key of messages.keys()) {
    if (key.startsWith(prefix)) messages.delete(key);
  }
}

function compactLiveMessages(
  messagesByBot: Record<string, DynamicIslandMessageSource[]>,
): Record<string, DynamicIslandMessageSource[]> {
  return Object.fromEntries(
    Object.entries(messagesByBot).map(([botId, messages]) => {
      const latest = latestBotMessage(messages);
      return [botId, latest ? [latest] : []];
    }),
  );
}

function activeMessageAnchors(
  messagesByBot: Record<string, DynamicIslandMessageSource[]>,
  previous = new Map<string, string>(),
): Map<string, string> {
  const anchors = new Map(previous);
  for (const [botId, messages] of Object.entries(messagesByBot)) {
    const latest = latestBotMessage(messages);
    if (latest) anchors.set(botId, latest.id);
    else anchors.delete(botId);
  }
  return anchors;
}

function latestBotMessage(messages: readonly DynamicIslandMessageSource[]): DynamicIslandMessageSource | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.author === "bot") return message;
  }
  return undefined;
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

export function reconcileQueuesWithRuntimeWork(
  current: Record<string, QueueSnapshot>,
  work: readonly AgentRuntimeWorkItem[],
  activeTurns: ReadonlyMap<string, string>,
): Record<string, QueueSnapshot> {
  const runtime = queueSnapshotsFromRuntimeWork(work);
  const queues: Record<string, QueueSnapshot> = {};
  for (const botId of new Set([...Object.keys(current), ...Object.keys(runtime)])) {
    const existing = current[botId] ?? runtime[botId];
    if (!existing) continue;
    const active = runtime[botId]?.deliveries ?? [];
    const activeIds = new Set(active.map((delivery) => delivery.id));
    queues[botId] = {
      ...existing,
      deliveries: [
        ...active,
        ...existing.deliveries.filter(
          (delivery) =>
            ((delivery.status !== "starting" && delivery.status !== "running") ||
              (delivery.turnId === activeTurns.get(botId) && !runtime[botId])) &&
            !activeIds.has(delivery.id),
        ),
      ],
    };
  }
  return queues;
}

function toDynamicIslandMessage(
  message: Extract<AgentEvent, { type: "conversation" }>["snapshot"]["messages"][number],
) {
  if (
    (message.author !== "assistant" && message.author !== "agent") ||
    message.itemType === "commentary" ||
    message.itemType === "question_prompt" ||
    message.itemType === "agent_attachment"
  ) {
    return [];
  }
  return [
    {
      id: message.id,
      author: "bot",
      body: cleanAgentMessageText(message.text),
      time: message.createdAt,
      createdAt: message.createdAt,
    },
  ];
}

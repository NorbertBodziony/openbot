// How an invalidation turns back into state the renderer can show.
//
// A host does not send a new conversation page when a message lands. It sends
// "conversation 42 changed to revision 7", and this file fetches revision 7. That indirection is
// what keeps a busy agent from pushing a full page down the socket on every token, and it is why
// the interesting code here is about *not* fetching:
//
//   - **Coalescing.** While one refetch is in flight, further invalidations for the same agent
//     raise the wanted revision instead of starting a second request. One fetch per burst, and the
//     loop reruns only if the revision moved while it was away.
//   - **Generations.** A refetch started before a reconnect must not emit after it: its answer
//     describes a session that is over. Every event bumps the generation, and a slow response
//     checks it before emitting.
//
// The fallback path is for hosts too old to replay events on connect. It reads the whole agent list
// and one page each, which is expensive, so it runs once per connection rather than per event.

import type { AgentEvent, ConversationPage, QueueSnapshot } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { decodeBotSummaries, decodeQueueSnapshot } from "./remote-agent-decoding";
import { decodeConversationPageFromHost } from "./remote-conversation-decoding";
import type { RemoteRequestFn } from "./remote-server-client";
import { addRemotePreviewUrls, pageQuery } from "./remote-server-urls";

// One in-flight conversation refetch, and the newest revision asked for while it was running.
// `sequence` counts announcements that did not move the revision: a read on another device changes
// the page's unread counts without changing its content revision, so the revision alone cannot tell
// "nothing has happened" from "something happened that this page still has to be refetched for".
interface ConversationRefresh {
  revision: number;
  sequence: number;
}

// One in-flight queue refetch. The queue has no revision, so "changed again" is all there is to say.
interface QueueRefresh {
  dirty: boolean;
}

const FALLBACK_CONVERSATION_LIMIT = 1;
const INVALIDATED_CONVERSATION_LIMIT = 50;

export interface RemoteEventRefreshOptions {
  request: RemoteRequestFn;
  /** False once the user removes a server. A refetch in flight for it stops emitting. */
  hasServer: (serverId: string) => boolean;
  emit: (serverId: string, event: AgentEvent, bufferedLive?: boolean) => void;
}

export class RemoteEventRefresh {
  readonly #request: RemoteRequestFn;
  readonly #hasServer: (serverId: string) => boolean;
  readonly #emit: (serverId: string, event: AgentEvent, bufferedLive?: boolean) => void;
  readonly #conversations = new Map<string, ConversationRefresh>();
  readonly #queues = new Map<string, QueueRefresh>();
  readonly #generations = new Map<string, number>();

  constructor(options: RemoteEventRefreshOptions) {
    this.#request = options.request;
    this.#hasServer = options.hasServer;
    this.#emit = options.emit;
  }

  /**
   * One event from a host. An invalidation starts a refetch; anything else is already the state and
   * goes straight out. `bufferedLive` marks an event that arrived while the fallback was loading,
   * so the renderer can tell it apart from the snapshot it is patching.
   */
  forward(serverId: string, event: AgentEvent, bufferedLive = false): void {
    this.#advance(serverId);
    if (event.type === "conversation-invalidated") {
      void this.#refreshConversationPage(serverId, event.botId, event.revision);
    } else if (event.type === "queue-invalidated") {
      void this.#refreshQueue(serverId, event.botId);
    } else {
      const remoteEvent = addRemotePreviewUrls(event, serverId);
      if (bufferedLive) this.#emit(serverId, remoteEvent, true);
      else this.#emit(serverId, remoteEvent);
    }
  }

  /**
   * Builds the current state from scratch, for a host that cannot replay what was missed. One agent
   * failing is not the server failing, so each is caught on its own.
   */
  async refreshAgentState(serverId: string): Promise<void> {
    const generation = this.#advance(serverId);
    const bots = await this.#request(serverId, TEAM_API_ROUTES.agents.all, decodeBotSummaries);
    if (this.#generations.get(serverId) !== generation) return;
    this.#emit(serverId, { type: "bots-changed", bots });
    await Promise.all(
      bots.map(async (bot) => {
        try {
          const [page, queue] = await Promise.all([
            this.#conversationPage(serverId, bot.id, FALLBACK_CONVERSATION_LIMIT),
            this.#request(serverId, TEAM_API_ROUTES.agent.queue(bot.id), decodeQueueSnapshot),
          ]);
          if (this.#generations.get(serverId) !== generation) return;
          const { pageInfo: _, references: __, readState: ___, ...snapshot } = page;
          this.#emit(serverId, { type: "conversation", snapshot });
          this.#emit(serverId, { type: "queue-changed", snapshot: queue });
        } catch {
          // A failed bot refresh must not discard the server or other bots.
        }
      }),
    );
  }

  forget(serverId: string): void {
    this.#generations.delete(serverId);
    for (const key of this.#conversations.keys()) {
      if (key.startsWith(`${serverId}\0`)) this.#conversations.delete(key);
    }
    for (const key of this.#queues.keys()) {
      if (key.startsWith(`${serverId}\0`)) this.#queues.delete(key);
    }
  }

  clear(): void {
    this.#generations.clear();
    this.#conversations.clear();
    this.#queues.clear();
  }

  async #refreshConversationPage(serverId: string, botId: string, revision: number): Promise<void> {
    const key = `${serverId}\0${botId}`;
    const pending = this.#conversations.get(key);
    if (pending) {
      if (pending.revision === revision) pending.sequence += 1;
      pending.revision = Math.max(pending.revision, revision);
      return;
    }
    const request = { revision, sequence: 0 };
    this.#conversations.set(key, request);
    try {
      while (this.#hasServer(serverId)) {
        const requestedRevision = request.revision;
        const requestedSequence = request.sequence;
        let page: ConversationPage;
        try {
          page = await this.#conversationPage(serverId, botId, INVALIDATED_CONVERSATION_LIMIT);
        } catch {
          // Something arrived while this failed, so the retry is for that one, not this one.
          if (request.sequence !== requestedSequence || request.revision !== requestedRevision) continue;
          return;
        }
        // A read cursor can change without changing the conversation's revision, so the page in hand
        // is already stale even though its revision is current.
        if (request.sequence !== requestedSequence) continue;
        // The host can answer with a page older than the revision it announced. Loop only if
        // something asked again in the meantime; otherwise the announcement was the stale one.
        if (page.revision >= request.revision) {
          this.#emit(serverId, { type: "conversation-page", page });
          return;
        }
        if (request.revision === requestedRevision) return;
      }
    } finally {
      if (this.#conversations.get(key) === request) this.#conversations.delete(key);
    }
  }

  async #refreshQueue(serverId: string, botId: string): Promise<void> {
    const key = `${serverId}\0${botId}`;
    const pending = this.#queues.get(key);
    if (pending) {
      pending.dirty = true;
      return;
    }
    const request = { dirty: false };
    this.#queues.set(key, request);
    try {
      do {
        request.dirty = false;
        let snapshot: QueueSnapshot;
        try {
          snapshot = await this.#request(serverId, TEAM_API_ROUTES.agent.queue(botId), decodeQueueSnapshot);
        } catch {
          if (request.dirty) continue;
          return;
        }
        if (!this.#hasServer(serverId)) return;
        this.#emit(serverId, { type: "queue-changed", snapshot });
      } while (request.dirty);
    } finally {
      if (this.#queues.get(key) === request) this.#queues.delete(key);
    }
  }

  #conversationPage(serverId: string, botId: string, limit: number): Promise<ConversationPage> {
    return this.#request(
      serverId,
      `${TEAM_API_ROUTES.agent.conversationPage(botId)}${pageQuery({ type: "latest" }, limit)}`,
      decodeConversationPageFromHost,
    );
  }

  /**
   * Marks everything in flight as belonging to a previous session. A response that started before
   * this call will notice and stay quiet.
   */
  #advance(serverId: string): number {
    const generation = (this.#generations.get(serverId) ?? 0) + 1;
    this.#generations.set(serverId, generation);
    return generation;
  }
}

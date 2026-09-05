import type {
  DirectConversationPage,
  DirectConversationSnapshot,
  DirectMessage,
  DirectMessageRealtimeEvent,
  DirectThreadSummary,
  DirectTypingRealtimeEvent,
} from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, flush, onSettled } from "solid-js";
import { desktopAnalytics } from "./analytics";
import { preserveKnownDirectUnread } from "./features/conversation/conversation-read-state";
import { usePlatform } from "./platform";
import { usePresence } from "./presence";
import { createScopeGuard } from "./scope-lifetime";
import { useServers } from "./servers";
import { createSimpleContext } from "./simple-context";

/**
 * Person-to-person conversations on the active team server: the thread list, the
 * page of messages open for each member, and who is typing.
 *
 * **This domain owns `activeDirectMemberId`, and that is a deliberate departure
 * from the inventory in the plan**, which parked it in a `selection` context
 * alongside `activeAgentId`. `selection` exists to break one cycle: `selectAgent`
 * writes to agents, conversation and direct messages at once while conversation
 * has to read `activeAgent()` back. The direct-message half has no such cycle -
 * twelve of the thirteen readers of `activeDirectMemberId` are the functions in
 * this file, and the command that writes it (`selectDirectMember`) already has
 * to live above every domain it touches. Splitting the id away from the
 * conversations it indexes would buy nothing and cost an extra edge.
 *
 * Three consequences of that ownership, in the order they bite:
 *
 * - **`selectDirectMember` is still in the controller and calls
 *   `openDirectConversation` for its second half.** Its first half closes agent
 *   setup, prunes agent history and clears the settings request - three domains
 *   this one is nested under, so it can never move down here. What did move is
 *   everything from "stop typing at the person we are leaving" onward.
 * - **`markDirectMessagesRead` keys its in-flight operations by server**
 *   (`${serverId}\0${memberId}`) and re-checks `activeServerId()` after every
 *   await. Those checks are what stop a read for the previous server landing on
 *   the new one; they are the idiom the keyed server scope removes later, and
 *   until then removing one is a silent cross-server bug.
 * - **Nothing is torn down by hand.** The provider is mounted inside the keyed
 *   server scope, so a switch disposes it outright. `directConversationPages`,
 *   `directOlderLoading`, `directOlderErrors` and `directConversationLoading`
 *   used to survive a switch, which was a leak rather than a decision; they no
 *   longer do, and that is the one behaviour this move changes.
 *
 * The load counter is a plain nonce rather than a per-member map because only
 * one direct conversation is open at a time: any newer request, for any member,
 * invalidates the one in flight. A request left in flight by a server switch
 * needs no nonce at all - its owner is gone.
 */
const DirectMessages = createSimpleContext({
  name: "Direct messages",
  init: () => {
    const { appFocused, peopleEnabled } = usePlatform();
    const { activeServer, activeServerId, activeServerSupportsCapability } = useServers();
    const { currentTeamMember, directPeople } = usePresence();
    const scopeIsCurrent = createScopeGuard();

    const [directThreads, setDirectThreads] = createSignal<DirectThreadSummary[]>([]);
    const [directConversations, setDirectConversations] = createSignal<Record<string, DirectConversationSnapshot>>({});
    const [activeDirectMemberId, setActiveDirectMemberId] = createSignal<string | null>(null);
    const [directConversationLoading, setDirectConversationLoading] = createSignal(false);
    const [directConversationError, setDirectConversationError] = createSignal<string | null>(null);
    const [directConversationPages, setDirectConversationPages] = createSignal<
      Record<string, DirectConversationPage["pageInfo"]>
    >({});
    const [directOlderLoading, setDirectOlderLoading] = createSignal<Record<string, boolean>>({});
    const [directOlderErrors, setDirectOlderErrors] = createSignal<Record<string, string | null>>({});
    const [directTypingMemberIds, setDirectTypingMemberIds] = createSignal<Set<string>>(new Set());
    const directConversationReadOperations = new Map<string, Promise<void>>();
    let directConversationRequest = 0;

    const activeDirectMember = createMemo(() =>
      peopleEnabled ? directPeople().find((member) => member.id === activeDirectMemberId()) : undefined,
    );

    async function refreshDirectThreads(): Promise<void> {
      if (!currentTeamMember() || !activeServerSupportsCapability("direct-messages")) {
        setDirectThreads([]);
        return;
      }
      try {
        setDirectThreads(await window.openbot.servers.listDirectThreads());
      } catch {
        setDirectThreads([]);
      }
    }

    function pruneInactiveDirectHistory(memberId: string): void {
      const snapshot = directConversations()[memberId];
      if (!snapshot || snapshot.messages.length <= 50) return;
      setDirectConversations((current) => {
        const conversation = current[memberId];
        if (!conversation || conversation.messages.length <= 50) return current;
        return {
          ...current,
          [memberId]: { ...conversation, messages: conversation.messages.slice(-50) },
        };
      });
      setDirectConversationPages((current) => ({
        ...current,
        [memberId]: { hasOlder: true, olderCursor: null },
      }));
    }

    async function openDirectConversation(memberId: string): Promise<void> {
      const previousMemberId = activeDirectMemberId();
      if (previousMemberId && previousMemberId !== memberId) {
        pruneInactiveDirectHistory(previousMemberId);
        void window.openbot.servers
          .setDirectTyping({ memberId: previousMemberId, typing: false })
          .catch(() => undefined);
      }
      setActiveDirectMemberId(memberId);
      setDirectConversationLoading(true);
      setDirectConversationError(null);
      const request = ++directConversationRequest;
      try {
        const snapshot = await window.openbot.servers.readDirectConversationPage({
          memberId,
          anchor: { type: "latest" },
          limit: 50,
        });
        if (request !== directConversationRequest) return;
        setDirectConversations((current) => ({
          ...current,
          [memberId]: snapshot,
        }));
        setDirectConversationPages((current) => ({ ...current, [memberId]: snapshot.pageInfo }));
        if (appFocused() && (snapshot.readState?.unreadCount ?? 0) > 0) {
          void markDirectMessagesRead(memberId, snapshot.messages.at(-1)?.sequence).catch(() => undefined);
        }
      } catch (error) {
        if (request !== directConversationRequest) return;
        setDirectConversationError(error instanceof Error ? error.message : "The messages could not load.");
      } finally {
        if (request === directConversationRequest) setDirectConversationLoading(false);
      }
    }

    async function loadOlderDirectMessages(memberId = activeDirectMemberId()): Promise<void> {
      if (!memberId || directOlderLoading()[memberId]) return;
      const pageInfo = directConversationPages()[memberId];
      if (!pageInfo?.hasOlder || !pageInfo.olderCursor) return;
      const cursor = pageInfo.olderCursor;
      const request = directConversationRequest;
      setDirectOlderLoading((current) => ({ ...current, [memberId]: true }));
      setDirectOlderErrors((current) => ({ ...current, [memberId]: null }));
      try {
        const page = await window.openbot.servers.readDirectConversationPage({
          memberId,
          anchor: { type: "before", cursor },
          limit: 50,
        });
        if (request !== directConversationRequest || activeDirectMemberId() !== memberId) return;
        if (directConversationPages()[memberId]?.olderCursor !== cursor) return;
        setDirectConversations((current) => {
          const existing = current[memberId];
          if (!existing) return current;
          const ids = new Set(page.messages.map((message) => message.id));
          return {
            ...current,
            [memberId]: {
              ...existing,
              messages: [...page.messages, ...existing.messages.filter((message) => !ids.has(message.id))],
              revision: Math.max(existing.revision, page.revision),
              readState: page.readState ?? existing.readState,
            },
          };
        });
        setDirectConversationPages((current) => ({ ...current, [memberId]: page.pageInfo }));
      } catch (error) {
        setDirectOlderErrors((current) => ({
          ...current,
          [memberId]: error instanceof Error ? error.message : "Older messages could not load.",
        }));
      } finally {
        setDirectOlderLoading((current) => ({ ...current, [memberId]: false }));
      }
    }

    async function openDirectMessage(memberId: string, messageId: string): Promise<void> {
      const request = ++directConversationRequest;
      try {
        const page = await window.openbot.servers.readDirectConversationPage({
          memberId,
          anchor: { type: "around", messageId },
          limit: 50,
        });
        if (request !== directConversationRequest || activeDirectMemberId() !== memberId) return;
        setDirectConversations((current) => ({ ...current, [memberId]: page }));
        setDirectConversationPages((current) => ({ ...current, [memberId]: page.pageInfo }));
      } catch (error) {
        if (request !== directConversationRequest || activeDirectMemberId() !== memberId) return;
        setDirectOlderErrors((current) => ({
          ...current,
          [memberId]: error instanceof Error ? error.message : "The unread message could not load.",
        }));
      }
    }

    async function sendDirectMessage(
      text: string,
      clientMessageId: string,
    ): Promise<{ message: DirectMessage; readError?: string }> {
      const memberId = activeDirectMemberId();
      if (!memberId) throw new Error("Select a person first.");
      const analytics = desktopAnalytics.scope();
      const serverKind = activeServer()?.kind ?? "unknown";
      let message: DirectMessage;
      try {
        message = await window.openbot.servers.sendDirectMessage({
          memberId,
          text,
          clientMessageId,
        });
      } catch (error) {
        analytics.track("message_send", {
          channel: "direct",
          attachment_count: 0,
          is_reply: false,
          result: "failed",
          failure_code: "send_failed",
          server_kind: serverKind,
        });
        throw error;
      }
      mergeDirectMessage(memberId, message);
      analytics.track("message_send", {
        channel: "direct",
        attachment_count: 0,
        is_reply: false,
        result: "succeeded",
        delivery_count: 1,
        server_kind: serverKind,
      });
      let readError: string | undefined;
      try {
        await markDirectMessagesRead(memberId, message.sequence);
      } catch (error) {
        readError = error instanceof Error ? error.message : "Could not mark messages as read.";
      }
      await refreshDirectThreads();
      return { message, ...(readError ? { readError } : {}) };
    }

    async function markDirectMessagesRead(memberId = activeDirectMemberId(), throughSequence?: number): Promise<void> {
      if (!memberId) return;
      const serverId = activeServerId();
      const requestKey = `${serverId}\0${memberId}`;
      const snapshot = directConversations()[memberId];
      const boundary = throughSequence ?? snapshot?.messages.at(-1)?.sequence ?? 0;
      const previousOperation = directConversationReadOperations.get(requestKey) ?? Promise.resolve();
      const operation: Promise<void> = previousOperation
        .catch(() => undefined)
        .then(async () => {
          if (!scopeIsCurrent()) return;
          const readState = await window.openbot.servers.markDirectRead({
            memberId,
            throughSequence: boundary,
          });
          if (!scopeIsCurrent()) return;
          setDirectConversations((current) => {
            const currentSnapshot = current[memberId];
            if (!currentSnapshot) return current;
            const nextReadState =
              appFocused() && activeDirectMemberId() === memberId
                ? readState
                : preserveKnownDirectUnread(readState, boundary, currentSnapshot.messages, currentTeamMember()?.id);
            return { ...current, [memberId]: { ...currentSnapshot, readState: nextReadState } };
          });
          await refreshDirectThreads();
          const latestSequence = directConversations()[memberId]?.messages.at(-1)?.sequence ?? boundary;
          if (
            directConversationReadOperations.get(requestKey) === operation &&
            appFocused() &&
            activeDirectMemberId() === memberId &&
            latestSequence > boundary
          ) {
            queueMicrotask(() => {
              const latestVisibleSequence = directConversations()[memberId]?.messages.at(-1)?.sequence ?? boundary;
              if (
                scopeIsCurrent() &&
                appFocused() &&
                activeDirectMemberId() === memberId &&
                latestVisibleSequence > boundary
              ) {
                void markDirectMessagesRead(memberId, latestVisibleSequence).catch(() => undefined);
              }
            });
          }
        });
      directConversationReadOperations.set(requestKey, operation);
      try {
        await operation;
      } finally {
        if (directConversationReadOperations.get(requestKey) === operation) {
          directConversationReadOperations.delete(requestKey);
        }
      }
    }

    function setDirectTyping(typing: boolean): void {
      const memberId = activeDirectMemberId();
      if (!memberId) return;
      void window.openbot.servers.setDirectTyping({ memberId, typing }).catch(() => undefined);
    }

    function mergeDirectMessage(memberId: string, message: DirectMessage): void {
      setDirectConversations((current) => {
        const snapshot = current[memberId] ?? {
          threadId: message.threadId,
          otherMemberId: memberId,
          messages: [],
          revision: 0,
          readState: { unreadCount: 0, firstUnreadMessageId: null, throughSequence: 0 },
        };
        if (snapshot.messages.some((candidate) => candidate.id === message.id)) return current;
        const readState = snapshot.readState ?? {
          unreadCount: 0,
          firstUnreadMessageId: null,
          throughSequence: 0,
        };
        const incomingUnread =
          message.senderMemberId !== currentTeamMember()?.id && message.sequence > readState.throughSequence;
        const visibleIncomingMessage = incomingUnread && activeDirectMemberId() === memberId && appFocused();
        let nextReadState = readState;
        if (visibleIncomingMessage && readState.unreadCount === 0) {
          nextReadState = {
            unreadCount: 0,
            firstUnreadMessageId: null,
            throughSequence: message.sequence,
          };
        } else if (incomingUnread && !visibleIncomingMessage) {
          nextReadState = {
            ...readState,
            unreadCount: readState.unreadCount + 1,
            firstUnreadMessageId: readState.firstUnreadMessageId ?? message.id,
          };
        }
        return {
          ...current,
          [memberId]: {
            ...snapshot,
            messages: [...snapshot.messages, message].sort((left, right) => left.sequence - right.sequence),
            revision: Math.max(snapshot.revision, message.sequence),
            readState: nextReadState,
          },
        };
      });
    }

    function handleDirectMessageEvent(event: DirectMessageRealtimeEvent): void {
      const currentMemberId = currentTeamMember()?.id;
      if (!currentMemberId || !event.memberIds.includes(currentMemberId)) return;
      const otherMemberId =
        event.message.senderMemberId === currentMemberId
          ? event.message.recipientMemberId
          : event.message.senderMemberId;
      const markVisibleMessageRead =
        event.message.senderMemberId !== currentMemberId &&
        activeDirectMemberId() === otherMemberId &&
        appFocused() &&
        (directConversations()[otherMemberId]?.readState?.unreadCount ?? 0) === 0;
      mergeDirectMessage(otherMemberId, event.message);
      if (markVisibleMessageRead) {
        void markDirectMessagesRead(otherMemberId, event.message.sequence).catch(() => undefined);
      } else {
        void refreshDirectThreads();
      }
    }

    function handleDirectTypingEvent(event: DirectTypingRealtimeEvent): void {
      if (event.recipientMemberId !== currentTeamMember()?.id) return;
      setDirectTypingMemberIds((current) => {
        const next = new Set(current);
        if (event.typing) next.add(event.senderMemberId);
        else next.delete(event.senderMemberId);
        return next;
      });
    }

    /**
     * Leaves the open direct conversation without opening another. The commands
     * that call it - creating an agent, selecting one - live above this domain
     * because each also writes to agents and conversation.
     */
    function clearDirectSelection(): void {
      setActiveDirectMemberId(null);
    }

    /** Invalidates the conversation load in flight. Runs before a server switch commits. */
    function cancelDirectConversationRequests(): void {
      directConversationRequest += 1;
    }

    /** The direct-message slice of the teardown `selectServer` runs. */
    // A member can leave the team while their conversation is open. Dropping the
    // selection is what closes the pane; the request bump stops the load that was
    // already on its way from re-opening it.
    createEffect(
      () => ({
        memberId: activeDirectMemberId(),
        memberExists: activeDirectMember() !== undefined,
      }),
      ({ memberId, memberExists }) => {
        if (memberId && !memberExists) {
          cancelDirectConversationRequests();
          setActiveDirectMemberId(null);
          setDirectConversationError(null);
          setDirectConversationLoading(false);
        }
      },
    );

    createEffect(
      () => currentTeamMember()?.id ?? null,
      (memberId) => {
        if (!peopleEnabled) return;
        if (!memberId) {
          setDirectThreads([]);
          return;
        }
        void refreshDirectThreads();
      },
    );

    onSettled(() => {
      if (!peopleEnabled) return undefined;
      const unsubscribeMessage = window.openbot.servers.onDirectMessage((event) =>
        flush(() => handleDirectMessageEvent(event)),
      );
      const unsubscribeTyping = window.openbot.servers.onDirectTyping((event) =>
        flush(() => handleDirectTypingEvent(event)),
      );
      return () => {
        unsubscribeMessage();
        unsubscribeTyping();
      };
    });

    return {
      directThreads,
      directConversations,
      activeDirectMemberId,
      activeDirectMember,
      directConversationLoading,
      directConversationError,
      directConversationPages,
      directOlderLoading,
      directOlderErrors,
      directTypingMemberIds,
      refreshDirectThreads,
      openDirectConversation,
      loadOlderDirectMessages,
      openDirectMessage,
      sendDirectMessage,
      markDirectMessagesRead,
      setDirectTyping,
      clearDirectSelection,
      cancelDirectConversationRequests,
    };
  },
});

export const DirectMessagesProvider = DirectMessages.provider;
export const useDirectMessages = DirectMessages.use;

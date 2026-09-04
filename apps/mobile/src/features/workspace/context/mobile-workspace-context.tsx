import {
  type AgentEvent,
  type BotSummary,
  type ConversationMessage,
  type ConversationSnapshot,
  type CreateBotInput,
  isAvatarHue,
  type TeamRealtimeEvent,
  type UpdateBotInput,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import {
  createRemoteConnectionRecovery,
  createWorkspacePreferences,
  decodeTeamProtocolSupportV1,
  mergeRemoteUnreadIds,
  type RemoteConnectionStage,
  RemoteTeamDirectoryClient,
  type RemoteTeamHost,
  type RemoteWorkspacePreferences,
  remoteConnectionFailure,
  remoteRecoveryMessage,
  resyncRemoteConversations,
  TEAM_CONVERSATION_UNREAD_CAPABILITY,
  TEAM_PROTOCOL_V3,
} from "@openbot/team-client";
import { fetch } from "expo/fetch";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, AppState, View } from "react-native";

import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import {
  RemoteTeamTransport,
  type RemoteTeamTransportRef,
} from "@/features/workspace/components/remote-team-transport";
import { trustedHostKeys } from "@/features/workspace/model/trusted-host-keys";
import {
  MAX_PINNED_BOTS,
  type MobileBot,
  type MobileServer,
  type MobileServerDirectoryState,
  type MobileWorkspaceContextValue,
} from "@/features/workspace/model/workspace-types";

export type {
  MobileBot,
  MobileServer,
  MobileServerDirectoryState,
  MobileServerKind,
  MobileServerState,
  MobileWorkspaceContextValue,
  ToggleBotPinResult,
} from "@/features/workspace/model/workspace-types";
export { MAX_PINNED_BOTS } from "@/features/workspace/model/workspace-types";

const SERVER_ACCENTS = ["#cdadec", "#6960f1", "#e3b866", "#5b9ce2", "#85c7a2"] as const;
type RemoteBot = Pick<
  BotSummary,
  "id" | "name" | "title" | "description" | "preview" | "updatedAt" | "avatarSeed" | "avatarHue"
>;
const EMPTY_SERVER: MobileServer = {
  id: "unavailable",
  name: "OpenBot",
  kind: "local",
  state: "connecting",
  connectionMessage: null,
  address: null,
  accent: SERVER_ACCENTS[0],
  publicKey: "",
  membershipId: "",
};

const MobileWorkspaceContext = createContext<MobileWorkspaceContextValue | null>(null);

export function MobileWorkspaceProvider({ children }: PropsWithChildren) {
  const { session } = useMobileSession();
  if (!session) throw new Error("MobileWorkspaceProvider requires a signed-in mobile session.");

  const directory = useMemo(
    () =>
      new RemoteTeamDirectoryClient({
        apiUrl: session.apiUrl,
        token: session.sessionToken,
        fetch,
        hostKeys: trustedHostKeys(session.apiUrl, session.user.id),
        pairedHost: session.host,
      }),
    [session.apiUrl, session.sessionToken, session.user.id, session.host],
  );
  const transport = useRef<RemoteTeamTransportRef | null>(null);
  const [transportReady, setTransportReady] = useState(false);
  const loadGeneration = useRef(0);
  const connectionStage = useRef<RemoteConnectionStage>("connection");
  const directoryGeneration = useRef(0);
  const recovery = useRef<ReturnType<typeof createRemoteConnectionRecovery> | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const foregroundRef = useRef(foreground);
  const [servers, setServers] = useState<MobileServer[]>([]);
  const [serverDirectoryState, setServerDirectoryState] = useState<MobileServerDirectoryState>("loading");
  const [serverDirectoryError, setServerDirectoryError] = useState<string | null>(null);
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const [bots, setBots] = useState<MobileBot[]>([]);
  // Keep former bot IDs too, so leaving also removes cached chats of deleted bots.
  const serverBotIds = useRef(new Map<string, Set<string>>());
  const removedServers = useRef(new Set<string>());
  const readRefreshSequence = useRef(0);
  const serverCapabilities = useRef(new Map<string, string[]>());
  const [activeServerId, setActiveServerId] = useState<string | null>(session.host?.hostId ?? null);
  const activeServerPublicKey = servers.find((server) => server.id === activeServerId)?.publicKey;
  const [conversations, setConversations] = useState<Record<string, ConversationSnapshot>>({});
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const preferenceStore = useMemo(
    () =>
      createWorkspacePreferences(session.apiUrl, session.user.id, {
        get: (key) => SecureStore.getItem(key),
        set: (key, value) =>
          SecureStore.setItem(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
      }),
    [session.apiUrl, session.user.id],
  );
  const [preferences, setPreferences] = useState<Record<string, RemoteWorkspacePreferences>>({});
  const hiddenBotIds = (activeServerId ? preferences[activeServerId]?.hidden : null) ?? [];
  const pinnedBotIds = (activeServerId ? preferences[activeServerId]?.pinned : null) ?? [];
  const readWrites = useRef(new Map<string, Promise<void>>());
  const [unreadBotIds, setUnreadBotIds] = useState<string[]>([]);

  const installHosts = useCallback((hosts: RemoteTeamHost[]) => {
    setServers((current) => {
      const states = new Map(current.map((server) => [server.id, server.state]));
      const messages = new Map(current.map((server) => [server.id, server.connectionMessage]));
      return hosts.map((host, index) => ({
        id: host.hostId,
        name: host.name,
        kind: host.role === "owner" ? "local" : "remote",
        state: states.get(host.hostId) ?? "offline",
        connectionMessage: messages.get(host.hostId) ?? null,
        address: null,
        accent: SERVER_ACCENTS[index % SERVER_ACCENTS.length] ?? SERVER_ACCENTS[0],
        publicKey: current.find((server) => server.id === host.hostId)?.publicKey ?? host.devicePublicKey,
        membershipId: host.membershipId,
      }));
    });
    setActiveServerId((current) => (hosts.some((host) => host.hostId === current) ? current : null));
  }, []);

  const refreshHosts = useCallback(async () => {
    const generation = ++directoryGeneration.current;
    setServerDirectoryState("loading");
    setServerDirectoryError(null);
    try {
      const hosts = await directory.listHosts();
      if (generation !== directoryGeneration.current) return;
      installHosts(hosts);
      setServerDirectoryState("ready");
    } catch (error) {
      if (generation !== directoryGeneration.current) return;
      setServerDirectoryState("error");
      setServerDirectoryError(error instanceof Error ? error.message : "The server directory is unavailable.");
      throw error;
    }
  }, [directory, installHosts]);

  useEffect(() => {
    void refreshHosts().catch(() => undefined);
    return () => {
      directoryGeneration.current += 1;
    };
  }, [refreshHosts]);

  const request = useCallback(
    async <T,>(method: string, path: string, decode: (value: unknown) => T, body?: TeamProtocolV2Json): Promise<T> => {
      const client = transport.current;
      if (!client) throw new Error("The mobile transport is not ready.");
      return client.request(method, path, decode, body);
    },
    [],
  );

  const replaceServerBots = useCallback((serverId: string, summaries: RemoteBot[]) => {
    const knownIds = serverBotIds.current.get(serverId) ?? new Set<string>();
    for (const bot of summaries) knownIds.add(bot.id);
    serverBotIds.current.set(serverId, knownIds);
    setBots((current) => [
      ...current.filter((bot) => bot.serverId !== serverId),
      ...summaries.map((bot) => projectBot(serverId, bot)),
    ]);
  }, []);

  const loadServer = useCallback(
    async (server: MobileServer) => {
      const currentGeneration = ++loadGeneration.current;
      connectionStage.current = "preferences";
      const saved = preferenceStore.read(server.id);
      setPreferences((current) => ({ ...current, [server.id]: saved }));
      const client = transport.current;
      if (!client) throw new Error("The mobile transport is not ready.");
      connectionStage.current = "connection";
      await client.connect(server.id, server.publicKey);
      if (currentGeneration !== loadGeneration.current) return;
      connectionStage.current = "compatibility";
      const compatibility = await request("GET", "/v1/compatibility", decodeTeamProtocolSupportV1);
      if (currentGeneration !== loadGeneration.current) return;
      if (compatibility.protocol.minimum > TEAM_PROTOCOL_V3 || compatibility.protocol.maximum < TEAM_PROTOCOL_V3) {
        throw new Error("Update OpenBot Mobile or the desktop app before connecting.");
      }
      serverCapabilities.current.set(server.id, compatibility.capabilities);
      connectionStage.current = "agents";
      const summaries = await request("GET", "/v1/agents", decodeBotSummaries);
      if (currentGeneration !== loadGeneration.current) return;
      replaceServerBots(server.id, summaries);
      const readSequence = ++readRefreshSequence.current;
      connectionStage.current = "reads";
      const reads = await request("GET", "/v1/agents/conversation-reads", decodeConversationReads);
      if (currentGeneration !== loadGeneration.current) return;
      if (readSequence === readRefreshSequence.current) {
        setUnreadBotIds((current) => mergeRemoteUnreadIds(current, reads));
      }
      connectionStage.current = "conversations";
      await resyncRemoteConversations({
        botIds: summaries.map((bot) => bot.id),
        cached: conversationsRef.current,
        load: (botId) => request("GET", `/v1/agents/${encodeURIComponent(botId)}/conversation`, decodeConversation),
        apply: (snapshot) => setConversations((current) => storeNewestSnapshot(current, snapshot)),
        isCurrent: () => currentGeneration === loadGeneration.current,
      });
      if (currentGeneration !== loadGeneration.current) return;
      connectionStage.current = "connection";
      setServers((current) =>
        current.map((candidate) =>
          candidate.id === server.id ? { ...candidate, state: "online", connectionMessage: null } : candidate,
        ),
      );
    },
    [replaceServerBots, request, preferenceStore],
  );

  useEffect(() => {
    if (!transportReady || !activeServerId || !activeServerPublicKey) return;
    const server = serversRef.current.find((candidate) => candidate.id === activeServerId);
    if (!server?.publicKey) return;
    let lastFailure: string | null = null;
    let failureReported = false;
    const controller = createRemoteConnectionRecovery(
      () => loadServer(server),
      (error) => {
        if (!failureReported) lastFailure = remoteConnectionFailure(connectionStage.current, error);
        failureReported = true;
        const connectionMessage = lastFailure;
        setServers((current) =>
          current.map((candidate) =>
            candidate.id === server.id ? { ...candidate, state: "offline", connectionMessage } : candidate,
          ),
        );
      },
      (status) => {
        if (status.phase === "connecting") failureReported = false;
        if (status.phase === "online") {
          lastFailure = null;
          failureReported = false;
        }
        setServers((current) =>
          current.map((candidate) =>
            candidate.id === server.id
              ? {
                  ...candidate,
                  state:
                    status.phase === "online" ? "online" : status.phase === "connecting" ? "connecting" : "offline",
                  connectionMessage: remoteRecoveryMessage(status, lastFailure),
                }
              : candidate,
          ),
        );
      },
    );
    recovery.current = controller;
    controller.setActive(foregroundRef.current);
    return () => {
      controller.dispose();
      if (recovery.current === controller) recovery.current = null;
      loadGeneration.current += 1;
    };
  }, [activeServerId, activeServerPublicKey, loadServer, transportReady]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      const active = state === "active";
      foregroundRef.current = active;
      setForeground(active);
      recovery.current?.setActive(active);
    });
    return () => subscription.remove();
  }, []);

  const loadConversation = useCallback(
    async (botId: string) => {
      const generation = loadGeneration.current;
      const snapshot = await request("GET", `/v1/agents/${encodeURIComponent(botId)}/conversation`, decodeConversation);
      if (generation === loadGeneration.current) setConversations((current) => storeNewestSnapshot(current, snapshot));
      return snapshot;
    },
    [request],
  );

  const refreshConversationReads = useCallback(async () => {
    const sequence = ++readRefreshSequence.current;
    const generation = loadGeneration.current;
    const reads = await request("GET", "/v1/agents/conversation-reads", decodeConversationReads);
    if (sequence !== readRefreshSequence.current || generation !== loadGeneration.current) return;
    setUnreadBotIds((current) => mergeRemoteUnreadIds(current, reads));
  }, [request]);

  const handleTeamEvent = useCallback(
    (serverId: string, event: AgentEvent | TeamRealtimeEvent) => {
      if (removedServers.current.has(serverId)) return;
      if (
        event.type === "conversation" ||
        event.type === "conversation-invalidated" ||
        event.type === "turn-completed"
      ) {
        void refreshConversationReads().catch(() => undefined);
      }
      if (event.type === "bots-changed") replaceServerBots(serverId, event.bots);
      else if (event.type === "conversation") {
        const knownIds = serverBotIds.current.get(serverId) ?? new Set<string>();
        knownIds.add(event.snapshot.botId);
        serverBotIds.current.set(serverId, knownIds);
        setConversations((current) => storeNewestSnapshot(current, event.snapshot));
      } else if (event.type === "conversation-delta") {
        setConversations((current) => {
          const snapshot = current[event.botId];
          if (!snapshot || event.revision <= snapshot.revision) return current;
          const messageIndex = snapshot.messages.findIndex((message) => message.id === event.messageId);
          const messages = [...snapshot.messages];
          if (messageIndex === -1) {
            messages.push({
              id: event.messageId,
              turnId: event.turnId,
              author: "assistant",
              source: "assistant",
              text: event.delta,
              createdAt: event.createdAt,
              status: "streaming",
            });
          } else {
            const message = messages[messageIndex];
            if (!message) return current;
            messages[messageIndex] = { ...message, text: message.text + event.delta, status: "streaming" };
          }
          return {
            ...current,
            [event.botId]: {
              ...snapshot,
              threadId: event.threadId,
              activeTurnId: event.turnId,
              revision: event.revision,
              messages,
            },
          };
        });
      } else if (event.type === "conversation-page") {
        const readState = event.page.readState;
        if (readState) {
          readRefreshSequence.current += 1;
          setUnreadBotIds((current) => mergeRemoteUnreadIds(current, { [event.page.botId]: readState }));
        } else void refreshConversationReads().catch(() => undefined);
        if (conversationsRef.current[event.page.botId]) void loadConversation(event.page.botId).catch(() => undefined);
      } else if (event.type === "conversation-invalidated" || event.type === "turn-completed") {
        if (conversationsRef.current[event.botId]) void loadConversation(event.botId).catch(() => undefined);
      } else if (event.type === "team-identity") {
        setServers((current) =>
          current.map((server) => (server.id === serverId ? { ...server, name: event.serverName } : server)),
        );
      }
    },
    [loadConversation, replaceServerBots, refreshConversationReads],
  );

  const markBotRead = useCallback(
    (botId: string, visibleMessageId?: string | null) => {
      if (
        visibleMessageId === null &&
        (!activeServerId ||
          !serverCapabilities.current.get(activeServerId)?.includes(TEAM_CONVERSATION_UNREAD_CAPABILITY))
      ) {
        Alert.alert("Update required", "Update this desktop server to mark conversations unread.");
        return;
      }
      const sequence = ++readRefreshSequence.current;
      const generation = loadGeneration.current;
      setUnreadBotIds((current) =>
        visibleMessageId === null ? [...new Set([...current, botId])] : current.filter((id) => id !== botId),
      );
      const write = (readWrites.current.get(botId) ?? Promise.resolve())
        .then(async () => {
          if (generation !== loadGeneration.current) return;
          const snapshot =
            visibleMessageId !== undefined
              ? null
              : (conversationsRef.current[botId] ?? (await loadConversation(botId)));
          if (generation !== loadGeneration.current) return;
          const throughMessageId = visibleMessageId !== undefined ? visibleMessageId : snapshot?.messages.at(-1)?.id;
          if (throughMessageId === undefined) return;
          const reads = await request(
            "POST",
            `/v1/agents/${encodeURIComponent(botId)}/conversation/${visibleMessageId === null ? "unread" : "read"}`,
            (value) => decodeConversationReads({ [botId]: value }),
            visibleMessageId === null ? {} : { throughMessageId },
          );
          if (generation === loadGeneration.current && sequence === readRefreshSequence.current) {
            setUnreadBotIds((current) => mergeRemoteUnreadIds(current, reads));
          }
        })
        .catch(() => {
          if (generation === loadGeneration.current) void refreshConversationReads().catch(() => undefined);
          if (visibleMessageId === null) Alert.alert("Could not mark unread", "Reconnect to the server and try again.");
        });
      readWrites.current.set(botId, write);
      void write.finally(() => {
        if (readWrites.current.get(botId) === write) readWrites.current.delete(botId);
      });
    },
    [request, refreshConversationReads, loadConversation, activeServerId],
  );

  const updatePreferences = useCallback(
    (serverId: string, change: (current: RemoteWorkspacePreferences) => RemoteWorkspacePreferences) => {
      try {
        const next = change(preferenceStore.read(serverId));
        preferenceStore.write(serverId, next);
        setPreferences((current) => ({ ...current, [serverId]: next }));
        return next;
      } catch {
        Alert.alert("Could not save chat preferences", "Your previous preferences have been kept. Please try again.");
        return null;
      }
    },
    [preferenceStore],
  );

  const value = useMemo<MobileWorkspaceContextValue>(() => {
    const activeServer = servers.find((server) => server.id === activeServerId) ?? EMPTY_SERVER;
    return {
      servers,
      serverDirectoryState,
      serverDirectoryError,
      bots,
      activeServer,
      activeBots: preferences[activeServer.id]
        ? bots.filter((bot) => bot.serverId === activeServer.id && !hiddenBotIds.includes(bot.id))
        : [],
      hiddenBots: bots.filter((bot) => bot.serverId === activeServer.id && hiddenBotIds.includes(bot.id)),
      pinnedBotIds,
      unreadBotIds,
      conversations,
      selectServer: setActiveServerId,
      leaveServer: async (serverId) => {
        const server = serversRef.current.find((candidate) => candidate.id === serverId);
        if (server?.kind !== "remote") throw new Error("Only joined remote servers can be left.");
        await directory.leaveHost(server.id, server.membershipId);
        removedServers.current.add(serverId);
        directoryGeneration.current += 1;
        const removedIds = serverBotIds.current.get(serverId) ?? new Set<string>();
        serverBotIds.current.delete(serverId);
        if (activeServerId === serverId) {
          recovery.current?.dispose();
          loadGeneration.current += 1;
          await transport.current?.disconnect().catch(() => undefined);
          setActiveServerId(session.host?.hostId ?? null);
        }
        setServers((current) => current.filter((candidate) => candidate.id !== serverId));
        setBots((current) => current.filter((bot) => bot.serverId !== serverId));
        setConversations((current) =>
          Object.fromEntries(Object.entries(current).filter(([id]) => !removedIds.has(id))),
        );
        updatePreferences(serverId, () => ({ hidden: [], pinned: [] }));
        setUnreadBotIds((current) => current.filter((id) => !removedIds.has(id)));
      },
      refreshServers: refreshHosts,
      addRemoteServer: async ({ inviteUrl }) => {
        const host = await directory.acceptInvite(inviteUrl);
        removedServers.current.delete(host.hostId);
        setServers((current) => [
          ...current.filter((server) => server.id !== host.hostId),
          {
            id: host.hostId,
            name: host.name,
            kind: "remote",
            state: "offline",
            connectionMessage: null,
            address: null,
            accent: SERVER_ACCENTS[0],
            publicKey: host.devicePublicKey,
            membershipId: host.membershipId,
          },
        ]);
        setActiveServerId(host.hostId);
        // Membership is already committed. Directory failure must not reuse the consumed invite.
        void refreshHosts().catch(() => undefined);
      },
      createBot: async (input: CreateBotInput) => {
        const created = await request("POST", "/v1/agents", decodeBot, {
          name: input.name,
          description: input.description,
          avatarSeed: input.avatarSeed,
          avatarHue: input.avatarHue,
          initialMessage: input.initialMessage,
        });
        setBots((current) => [...current.filter((bot) => bot.id !== created.id), projectBot(activeServer.id, created)]);
      },
      updateBot: async (input: UpdateBotInput) => {
        const updated = await request(
          "PATCH",
          `/v1/agents/${encodeURIComponent(input.botId)}`,
          decodeBot,
          updateBotPayload(input),
        );
        setBots((current) => current.map((bot) => (bot.id === updated.id ? projectBot(bot.serverId, updated) : bot)));
      },
      deleteBot: async (botId) => {
        await request("DELETE", `/v1/agents/${encodeURIComponent(botId)}`, ignoreResponse);
      },
      duplicateBot: async (botId) => {
        await request("POST", `/v1/agents/${encodeURIComponent(botId)}/duplicate`, ignoreResponse, {
          operationId: Crypto.randomUUID(),
        });
      },
      loadConversation,
      sendMessage: async (botId, text) => {
        await request("POST", `/v1/agents/${encodeURIComponent(botId)}/messages`, ignoreResponse, {
          text,
          attachmentDraftIds: [],
          replyToMessageId: null,
        });
      },
      hideBot: (botId) => {
        updatePreferences(activeServer.id, (current) => ({
          hidden: [...new Set([...current.hidden, botId])],
          pinned: current.pinned.filter((id) => id !== botId),
        }));
      },
      unhideBot: (botId) => {
        updatePreferences(activeServer.id, (current) => ({
          ...current,
          hidden: current.hidden.filter((id) => id !== botId),
        }));
      },
      markBotRead,
      markBotUnread: (botId) => {
        markBotRead(botId, null);
      },
      toggleBotPin: (botId) => {
        if (pinnedBotIds.includes(botId)) {
          return updatePreferences(activeServer.id, (current) => ({
            ...current,
            pinned: current.pinned.filter((id) => id !== botId),
          }))
            ? "unpinned"
            : "error";
        }
        const bot = bots.find((item) => item.id === botId);
        const pinnedOnServer = pinnedBotIds.filter((id) =>
          bots.some((item) => item.id === id && item.serverId === bot?.serverId),
        );
        if (pinnedOnServer.length >= MAX_PINNED_BOTS) return "limit";
        return updatePreferences(activeServer.id, (current) => ({
          ...current,
          pinned: [...new Set([...current.pinned, botId])],
        }))
          ? "pinned"
          : "error";
      },
    };
  }, [
    activeServerId,
    bots,
    conversations,
    directory,
    hiddenBotIds,
    loadConversation,
    markBotRead,
    pinnedBotIds,
    refreshHosts,
    request,
    serverDirectoryError,
    serverDirectoryState,
    servers,
    session.host,
    unreadBotIds,
    preferences,
    updatePreferences,
  ]);

  const setTransport = useCallback((instance: RemoteTeamTransportRef | null) => {
    transport.current = instance;
    setTransportReady(Boolean(instance));
  }, []);

  return (
    <MobileWorkspaceContext.Provider value={value}>
      <View className="flex-1">
        {children}
        <RemoteTeamTransport
          active={foreground}
          ref={setTransport}
          directory={directory}
          onConnectionUpdate={(update) => {
            if (activeServerId === update.hostId && recovery.current) {
              if (update.state === "offline")
                recovery.current.offline(new Error(update.message ?? "The desktop went offline."));
              if (update.resync) recovery.current.refresh();
              return;
            }
            setServers((current) =>
              current.map((server) =>
                server.id === update.hostId
                  ? { ...server, state: update.state, connectionMessage: update.message }
                  : server,
              ),
            );
          }}
          onTeamEvent={handleTeamEvent}
        />
      </View>
    </MobileWorkspaceContext.Provider>
  );
}

export function useMobileWorkspace(): MobileWorkspaceContextValue {
  const value = useContext(MobileWorkspaceContext);
  if (!value) throw new Error("useMobileWorkspace must be used within MobileWorkspaceProvider.");
  return value;
}

function projectBot(serverId: string, bot: RemoteBot): MobileBot {
  return {
    id: bot.id,
    serverId,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    preview: bot.preview,
    updatedLabel: formatUpdatedAt(bot.updatedAt),
    avatarSeed: bot.avatarSeed,
    avatarHue: bot.avatarHue,
  };
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function decodeBot(value: unknown): RemoteBot {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    !isString(value.name) ||
    !isString(value.title) ||
    !isString(value.description) ||
    !isString(value.preview) ||
    (value.updatedAt !== null && !isString(value.updatedAt)) ||
    !isString(value.avatarSeed) ||
    (value.avatarHue !== null && !isAvatarHue(value.avatarHue))
  ) {
    throw new Error("The server returned an invalid bot.");
  }
  return {
    id: value.id,
    name: value.name,
    title: value.title,
    description: value.description,
    preview: value.preview,
    updatedAt: value.updatedAt,
    avatarSeed: value.avatarSeed,
    avatarHue: value.avatarHue,
  };
}

function decodeBotSummaries(value: unknown): RemoteBot[] {
  if (!Array.isArray(value)) throw new Error("The server returned an invalid bot list.");
  return value.map(decodeBot);
}

function decodeConversation(value: unknown): ConversationSnapshot {
  if (
    !isDynamicRecord(value) ||
    !isString(value.botId) ||
    (value.threadId !== null && !isString(value.threadId)) ||
    (value.activeTurnId !== null && !isString(value.activeTurnId)) ||
    !isNumber(value.revision) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.messages)
  ) {
    throw new Error("The server returned an invalid conversation.");
  }
  return {
    botId: value.botId,
    threadId: value.threadId,
    activeTurnId: value.activeTurnId,
    revision: value.revision,
    messages: value.messages.map(decodeConversationMessage),
  };
}

function decodeConversationReads(value: unknown): Record<string, { unreadCount: number }> {
  if (!isDynamicRecord(value)) throw new Error("The server returned invalid read states.");
  const reads: Record<string, { unreadCount: number }> = {};
  for (const [botId, readState] of Object.entries(value)) {
    if (
      !isDynamicRecord(readState) ||
      !isNumber(readState.unreadCount) ||
      !Number.isSafeInteger(readState.unreadCount) ||
      readState.unreadCount < 0
    ) {
      throw new Error("The server returned an invalid read state.");
    }
    reads[botId] = { unreadCount: readState.unreadCount };
  }
  return reads;
}

function decodeConversationMessage(value: unknown): ConversationMessage {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    !isConversationAuthor(value.author) ||
    !isString(value.text) ||
    !isString(value.createdAt) ||
    !isConversationStatus(value.status)
  ) {
    throw new Error("The server returned an invalid conversation message.");
  }
  return {
    id: value.id,
    author: value.author,
    text: value.text,
    createdAt: value.createdAt,
    status: value.status,
    ...(isString(value.turnId) ? { turnId: value.turnId } : {}),
    ...(isConversationSource(value.source) ? { source: value.source } : {}),
  };
}

function isConversationAuthor(value: unknown): value is ConversationMessage["author"] {
  return value === "user" || value === "assistant" || value === "agent" || value === "system";
}

function isConversationStatus(value: unknown): value is ConversationMessage["status"] {
  return value === "streaming" || value === "completed" || value === "failed" || value === "interrupted";
}

function isConversationSource(value: unknown): value is NonNullable<ConversationMessage["source"]> {
  return value === "user" || value === "assistant" || value === "agent" || value === "system" || value === "routine";
}

function ignoreResponse(): void {}

function updateBotPayload(input: UpdateBotInput): TeamProtocolV2Json {
  return {
    botId: input.botId,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.notifications === undefined ? {} : { notifications: input.notifications }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    ...(input.avatarSeed === undefined ? {} : { avatarSeed: input.avatarSeed }),
    ...(input.avatarHue === undefined ? {} : { avatarHue: input.avatarHue }),
  };
}

function storeNewestSnapshot(
  conversations: Record<string, ConversationSnapshot>,
  snapshot: ConversationSnapshot,
): Record<string, ConversationSnapshot> {
  const current = conversations[snapshot.botId];
  return current && current.revision > snapshot.revision
    ? conversations
    : { ...conversations, [snapshot.botId]: snapshot };
}

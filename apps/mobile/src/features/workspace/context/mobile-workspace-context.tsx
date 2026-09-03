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
  decodeTeamProtocolSupportV1,
  RemoteTeamDirectoryClient,
  type RemoteTeamHost,
  TEAM_PROTOCOL_V3,
} from "@openbot/team-client";
import { fetch } from "expo/fetch";
import * as Crypto from "expo-crypto";
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
import { View } from "react-native";

import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import {
  RemoteTeamTransport,
  type RemoteTeamTransportRef,
} from "@/features/workspace/components/remote-team-transport";
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
};

const MobileWorkspaceContext = createContext<MobileWorkspaceContextValue | null>(null);

export function MobileWorkspaceProvider({ children }: PropsWithChildren) {
  const { session } = useMobileSession();
  if (!session) throw new Error("MobileWorkspaceProvider requires a signed-in mobile session.");

  const directory = useMemo(
    () => new RemoteTeamDirectoryClient({ apiUrl: session.apiUrl, token: session.sessionToken, fetch }),
    [session.apiUrl, session.sessionToken],
  );
  const transport = useRef<RemoteTeamTransportRef | null>(null);
  const [transportReady, setTransportReady] = useState(false);
  const loadGeneration = useRef(0);
  const lastAttemptedServerId = useRef<string | null>(null);
  const [connectionRetrySequence, setConnectionRetrySequence] = useState(0);
  const [servers, setServers] = useState<MobileServer[]>([]);
  const [serverDirectoryState, setServerDirectoryState] = useState<MobileServerDirectoryState>("loading");
  const [serverDirectoryError, setServerDirectoryError] = useState<string | null>(null);
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Record<string, ConversationSnapshot>>({});
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const [hiddenBotIds, setHiddenBotIds] = useState<string[]>([]);
  const [pinnedBotIds, setPinnedBotIds] = useState<string[]>([]);
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
        publicKey: host.devicePublicKey,
      }));
    });
    setActiveServerId((current) =>
      hosts.some((host) => host.hostId === current)
        ? current
        : (hosts.find((host) => host.role === "owner")?.hostId ?? hosts[0]?.hostId ?? null),
    );
  }, []);

  const refreshHosts = useCallback(async () => {
    setServerDirectoryState("loading");
    setServerDirectoryError(null);
    try {
      installHosts(await directory.listHosts());
      setServerDirectoryState("ready");
    } catch (error) {
      setServerDirectoryState("error");
      setServerDirectoryError(error instanceof Error ? error.message : "The server directory is unavailable.");
      throw error;
    }
  }, [directory, installHosts]);

  useEffect(() => {
    let active = true;
    void directory
      .listHosts()
      .then((hosts) => {
        if (active) {
          installHosts(hosts);
          setServerDirectoryState("ready");
          setServerDirectoryError(null);
        }
      })
      .catch((error) => {
        if (active) {
          setServers([]);
          setServerDirectoryState("error");
          setServerDirectoryError(error instanceof Error ? error.message : "The server directory is unavailable.");
        }
      });
    return () => {
      active = false;
    };
  }, [directory, installHosts]);

  const request = useCallback(
    async <T,>(method: string, path: string, decode: (value: unknown) => T, body?: TeamProtocolV2Json): Promise<T> => {
      const client = transport.current;
      if (!client) throw new Error("The mobile transport is not ready.");
      return client.request(method, path, decode, body);
    },
    [],
  );

  const replaceServerBots = useCallback((serverId: string, summaries: RemoteBot[]) => {
    setBots((current) => [
      ...current.filter((bot) => bot.serverId !== serverId),
      ...summaries.map((bot) => projectBot(serverId, bot)),
    ]);
  }, []);

  const loadServer = useCallback(
    async (server: MobileServer) => {
      const currentGeneration = ++loadGeneration.current;
      const client = transport.current;
      if (!client) throw new Error("The mobile transport is not ready.");
      await client.connect(server.id, server.publicKey);
      if (currentGeneration !== loadGeneration.current) return;
      const compatibility = await request("GET", "/v1/compatibility", decodeTeamProtocolSupportV1);
      if (currentGeneration !== loadGeneration.current) return;
      if (compatibility.protocol.minimum > TEAM_PROTOCOL_V3 || compatibility.protocol.maximum < TEAM_PROTOCOL_V3) {
        throw new Error("Update OpenBot Mobile or the desktop app before connecting.");
      }
      const summaries = await request("GET", "/v1/agents", decodeBotSummaries);
      if (currentGeneration !== loadGeneration.current) return;
      replaceServerBots(server.id, summaries);
      const reads = await request("GET", "/v1/agents/conversation-reads", decodeConversationReads);
      if (currentGeneration !== loadGeneration.current) return;
      setUnreadBotIds((current) => [
        ...current.filter((id) => !summaries.some((bot) => bot.id === id)),
        ...Object.entries(reads)
          .filter(([, state]) => state.unreadCount > 0)
          .map(([id]) => id),
      ]);
    },
    [replaceServerBots, request],
  );

  useEffect(() => {
    if (!transportReady || !activeServerId) return;
    const server = serversRef.current.find((candidate) => candidate.id === activeServerId);
    if (!server?.publicKey) return;
    const retrying = connectionRetrySequence > 0 && lastAttemptedServerId.current === server.id;
    lastAttemptedServerId.current = server.id;
    const timer = setTimeout(
      () => {
        setServers((current) =>
          current.map((candidate) =>
            candidate.id === server.id ? { ...candidate, state: "connecting", connectionMessage: null } : candidate,
          ),
        );
        void loadServer(server).catch((error) => {
          const connectionMessage = error instanceof Error ? error.message : "The server connection failed.";
          setServers((current) =>
            current.map((candidate) =>
              candidate.id === server.id ? { ...candidate, state: "offline", connectionMessage } : candidate,
            ),
          );
          setConnectionRetrySequence((current) => current + 1);
        });
      },
      retrying ? 3_000 : 0,
    );
    return () => {
      clearTimeout(timer);
      loadGeneration.current += 1;
    };
  }, [activeServerId, connectionRetrySequence, loadServer, transportReady]);

  const loadConversation = useCallback(
    async (botId: string) => {
      const snapshot = await request("GET", `/v1/agents/${encodeURIComponent(botId)}/conversation`, decodeConversation);
      setConversations((current) => storeNewestSnapshot(current, snapshot));
      return snapshot;
    },
    [request],
  );

  const handleTeamEvent = useCallback(
    (serverId: string, event: AgentEvent | TeamRealtimeEvent) => {
      if (event.type === "bots-changed") replaceServerBots(serverId, event.bots);
      else if (event.type === "conversation") {
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
      } else if (event.type === "conversation-invalidated" || event.type === "turn-completed") {
        if (conversationsRef.current[event.botId]) void loadConversation(event.botId).catch(() => undefined);
      } else if (event.type === "team-identity") {
        setServers((current) =>
          current.map((server) => (server.id === serverId ? { ...server, name: event.serverName } : server)),
        );
      }
    },
    [loadConversation, replaceServerBots],
  );

  const markBotRead = useCallback(
    (botId: string) => {
      setUnreadBotIds((current) => (current.includes(botId) ? current.filter((id) => id !== botId) : current));
      const throughMessageId = conversationsRef.current[botId]?.messages.at(-1)?.id ?? null;
      void request("POST", `/v1/agents/${encodeURIComponent(botId)}/conversation/read`, ignoreResponse, {
        throughMessageId,
      }).catch(() => undefined);
    },
    [request],
  );

  const value = useMemo<MobileWorkspaceContextValue>(() => {
    const activeServer = servers.find((server) => server.id === activeServerId) ?? servers[0] ?? EMPTY_SERVER;
    return {
      servers,
      serverDirectoryState,
      serverDirectoryError,
      bots,
      activeServer,
      activeBots: bots.filter((bot) => bot.serverId === activeServer.id && !hiddenBotIds.includes(bot.id)),
      hiddenBots: bots.filter((bot) => bot.serverId === activeServer.id && hiddenBotIds.includes(bot.id)),
      pinnedBotIds,
      unreadBotIds,
      conversations,
      selectServer: setActiveServerId,
      refreshServers: refreshHosts,
      addRemoteServer: async ({ inviteUrl }) => {
        const invite = await directory.acceptInvite(inviteUrl);
        await refreshHosts();
        setActiveServerId(invite.hostId);
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
        setHiddenBotIds((current) => (current.includes(botId) ? current : [...current, botId]));
        setPinnedBotIds((current) => current.filter((id) => id !== botId));
        setUnreadBotIds((current) => current.filter((id) => id !== botId));
      },
      unhideBot: (botId) => setHiddenBotIds((current) => current.filter((id) => id !== botId)),
      markBotRead,
      markBotUnread: (botId) => {
        setUnreadBotIds((current) => (current.includes(botId) ? current : [...current, botId]));
      },
      toggleBotPin: (botId) => {
        if (pinnedBotIds.includes(botId)) {
          setPinnedBotIds((current) => current.filter((id) => id !== botId));
          return "unpinned";
        }
        const bot = bots.find((item) => item.id === botId);
        const pinnedOnServer = pinnedBotIds.filter((id) =>
          bots.some((item) => item.id === id && item.serverId === bot?.serverId),
        );
        if (pinnedOnServer.length >= MAX_PINNED_BOTS) return "limit";
        setPinnedBotIds((current) => [...current, botId]);
        return "pinned";
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
    unreadBotIds,
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
          ref={setTransport}
          directory={directory}
          onConnectionUpdate={(update) => {
            setServers((current) =>
              current.map((server) =>
                server.id === update.hostId
                  ? { ...server, state: update.state, connectionMessage: update.message }
                  : server,
              ),
            );
            if (update.state === "offline" && activeServerId === update.hostId) {
              setConnectionRetrySequence((current) => current + 1);
            }
            if (update.resync) {
              const server = serversRef.current.find((candidate) => candidate.id === update.hostId);
              if (server) void loadServer(server).catch(() => undefined);
            }
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

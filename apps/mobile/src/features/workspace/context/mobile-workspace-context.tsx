import { createContext, type PropsWithChildren, useCallback, useContext, useMemo, useState } from "react";

import { MOCK_BOTS, MOCK_SERVERS } from "@/features/workspace/model/workspace-fixtures";
import {
  MAX_PINNED_BOTS,
  type MobileBot,
  type MobileWorkspaceContextValue,
} from "@/features/workspace/model/workspace-types";

export type {
  MobileBot,
  MobileServer,
  MobileServerKind,
  MobileServerState,
  MobileWorkspaceContextValue,
  ToggleBotPinResult,
} from "@/features/workspace/model/workspace-types";
export { MAX_PINNED_BOTS } from "@/features/workspace/model/workspace-types";

const MobileWorkspaceContext = createContext<MobileWorkspaceContextValue | null>(null);

export function MobileWorkspaceProvider({ children }: PropsWithChildren) {
  const [servers, setServers] = useState(MOCK_SERVERS);
  const [bots, setBots] = useState(MOCK_BOTS);
  const [activeServerId, setActiveServerId] = useState(MOCK_SERVERS[0].id);
  const [hiddenBotIds, setHiddenBotIds] = useState<string[]>([]);
  const [pinnedBotIds, setPinnedBotIds] = useState<string[]>([]);
  const [unreadBotIds, setUnreadBotIds] = useState<string[]>([]);
  const markBotRead = useCallback((botId: string) => {
    setUnreadBotIds((current) => (current.includes(botId) ? current.filter((id) => id !== botId) : current));
  }, []);

  const value = useMemo<MobileWorkspaceContextValue>(() => {
    const activeServer = servers.find((server) => server.id === activeServerId) ?? servers[0];

    return {
      servers,
      bots,
      activeServer,
      activeBots: bots.filter((bot) => bot.serverId === activeServer.id && !hiddenBotIds.includes(bot.id)),
      hiddenBots: bots.filter((bot) => hiddenBotIds.includes(bot.id)),
      pinnedBotIds,
      unreadBotIds,
      selectServer: setActiveServerId,
      addRemoteServer: ({ inviteUrl }) => {
        //! MOCK DATA RENDERED HERE
        const invitation = new URL(inviteUrl);
        const id = `remote-${Date.now()}`;
        const invitedName = invitation.searchParams.get("server")?.trim();
        const fallbackName = invitation.hostname === "openbot.run" ? "Invited server" : invitation.hostname;
        setServers((current) => [
          ...current,
          {
            id,
            name: invitedName || fallbackName,
            kind: "remote",
            state: "online",
            address: invitation.toString(),
            accent: "#5b9ce2",
          },
        ]);
        setActiveServerId(id);
      },
      deleteBot: (botId) => {
        setBots((current) => current.filter((bot) => bot.id !== botId));
        setHiddenBotIds((current) => current.filter((id) => id !== botId));
        setPinnedBotIds((current) => current.filter((id) => id !== botId));
        setUnreadBotIds((current) => current.filter((id) => id !== botId));
      },
      duplicateBot: (botId) => {
        setBots((current) => {
          const sourceIndex = current.findIndex((bot) => bot.id === botId);
          const source = current[sourceIndex];
          if (!source) return current;

          const duplicateId = `${source.id}-copy-${Date.now()}`;
          const duplicate: MobileBot = {
            ...source,
            id: duplicateId,
            name: `${source.name} copy`,
            updatedLabel: "Now",
            avatarSeed: `${source.avatarSeed}:${duplicateId}`,
          };

          return [...current.slice(0, sourceIndex + 1), duplicate, ...current.slice(sourceIndex + 1)];
        });
      },
      hideBot: (botId) => {
        setHiddenBotIds((current) => (current.includes(botId) ? current : [...current, botId]));
        setPinnedBotIds((current) => current.filter((id) => id !== botId));
        setUnreadBotIds((current) => current.filter((id) => id !== botId));
      },
      unhideBot: (botId) => {
        setHiddenBotIds((current) => current.filter((id) => id !== botId));
      },
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
  }, [activeServerId, bots, hiddenBotIds, markBotRead, pinnedBotIds, servers, unreadBotIds]);

  return <MobileWorkspaceContext.Provider value={value}>{children}</MobileWorkspaceContext.Provider>;
}

export function useMobileWorkspace(): MobileWorkspaceContextValue {
  const value = useContext(MobileWorkspaceContext);
  if (!value) throw new Error("useMobileWorkspace must be used within MobileWorkspaceProvider.");
  return value;
}

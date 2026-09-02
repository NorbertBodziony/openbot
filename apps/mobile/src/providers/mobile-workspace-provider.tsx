import { createContext, type PropsWithChildren, useContext, useMemo, useState } from "react";

export type MobileServerKind = "local" | "remote";
export type MobileServerState = "online" | "offline";

export interface MobileServer {
  id: string;
  name: string;
  kind: MobileServerKind;
  state: MobileServerState;
  address: string | null;
  accent: string;
}

export interface MobileBot {
  id: string;
  serverId: string;
  name: string;
  title: string;
  preview: string;
  updatedLabel: string;
  avatarSeed: string;
}

interface AddRemoteServerInput {
  inviteUrl: string;
}

interface MobileWorkspaceContextValue {
  servers: MobileServer[];
  bots: MobileBot[];
  activeServer: MobileServer;
  activeBots: MobileBot[];
  selectServer: (serverId: string) => void;
  addRemoteServer: (input: AddRemoteServerInput) => void;
}

const MOCK_SERVERS: MobileServer[] = [
  {
    id: "local",
    name: "My MacBook Pro",
    kind: "local",
    state: "online",
    address: null,
    accent: "#cdadec",
  },
  {
    id: "openbot-team",
    name: "OpenBot team",
    kind: "remote",
    state: "online",
    address: "team.openbot.run",
    accent: "#6960f1",
  },
  {
    id: "studio",
    name: "Studio Mac",
    kind: "remote",
    state: "offline",
    address: "studio.example.com",
    accent: "#e3b866",
  },
];

const MOCK_BOTS: MobileBot[] = [
  {
    id: "chief",
    serverId: "local",
    name: "Chief",
    title: "Chief of staff",
    preview: "I pulled together the latest project notes and next steps.",
    updatedLabel: "10:00",
    avatarSeed: "chief:quiet-lead",
  },
  {
    id: "research",
    serverId: "local",
    name: "Research",
    title: "Research partner",
    preview: "Three useful sources are ready for your review.",
    updatedLabel: "Yesterday",
    avatarSeed: "research:curious-reader",
  },
  {
    id: "builder",
    serverId: "local",
    name: "Builder",
    title: "Product engineer",
    preview: "The mobile navigation prototype is ready to test.",
    updatedLabel: "Mon",
    avatarSeed: "builder:bright-spark",
  },
  {
    id: "sales",
    serverId: "openbot-team",
    name: "Sales Outbound",
    title: "Outbound specialist",
    preview: "The follow-up draft is ready to send.",
    updatedLabel: "09:20",
    avatarSeed: "sales:outbound-energy",
  },
  {
    id: "ops",
    serverId: "openbot-team",
    name: "Operations",
    title: "Team coordinator",
    preview: "All systems are healthy. Two approvals need your attention.",
    updatedLabel: "Tue",
    avatarSeed: "operations:steady-hand",
  },
];

const MobileWorkspaceContext = createContext<MobileWorkspaceContextValue | null>(null);

export function MobileWorkspaceProvider({ children }: PropsWithChildren) {
  const [servers, setServers] = useState(MOCK_SERVERS);
  const [bots] = useState(MOCK_BOTS);
  const [activeServerId, setActiveServerId] = useState(MOCK_SERVERS[0].id);

  const value = useMemo<MobileWorkspaceContextValue>(() => {
    const activeServer = servers.find((server) => server.id === activeServerId) ?? servers[0];

    return {
      servers,
      bots,
      activeServer,
      activeBots: bots.filter((bot) => bot.serverId === activeServer.id),
      selectServer: setActiveServerId,
      addRemoteServer: ({ inviteUrl }) => {
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
    };
  }, [activeServerId, bots, servers]);

  return <MobileWorkspaceContext.Provider value={value}>{children}</MobileWorkspaceContext.Provider>;
}

export function useMobileWorkspace(): MobileWorkspaceContextValue {
  const value = useContext(MobileWorkspaceContext);
  if (!value) throw new Error("useMobileWorkspace must be used within MobileWorkspaceProvider.");
  return value;
}

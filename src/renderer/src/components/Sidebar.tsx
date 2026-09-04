import type {
  BotAvatarHue,
  DirectThreadSummary,
  SidebarLayoutAction,
  SidebarLayoutSnapshot,
  TeamPresenceMember,
} from "@openbot/contracts/ipc";
import type { BotProfile } from "../data";
import type { SidebarPinnedItem } from "../sidebar-pins";
import { SidebarDialogs } from "./sidebar/SidebarDialogs";
import { SidebarNav } from "./sidebar/SidebarNav";
import { SidebarSearch } from "./sidebar/SidebarSearch";
import { SidebarTopbar } from "./sidebar/SidebarTopbar";
import { createSidebarScope, SidebarScopeContext } from "./sidebar/sidebar-scope";

export interface SidebarProps {
  serverName: string;
  onOpenServerSettings: (trigger: HTMLElement) => void;
  bots: BotProfile[];
  activeBotId: string;
  showPeople?: boolean;
  people: TeamPresenceMember[];
  directThreads: DirectThreadSummary[];
  activeDirectMemberId: string | null;
  agentStates: Record<string, SidebarAgentState>;
  layout: SidebarLayoutSnapshot;
  layoutMutable?: boolean;
  collapsedSectionIds: string[];
  onMutateLayout: (action: SidebarLayoutAction) => Promise<void>;
  onToggleSection: (sectionId: string) => void;
  pinnedItems: SidebarPinnedItem[];
  peopleOrder: string[];
  onPin: (item: SidebarPinnedItem) => void;
  onUnpin: (item: SidebarPinnedItem) => void;
  onReorderPinned: (items: SidebarPinnedItem[]) => void;
  onReorderPeople: (memberIds: string[]) => void;
  onSelectBot: (botId: string) => void;
  onSelectPerson: (memberId: string) => void;
  onPreloadDirectConversation?: () => void;
  onCreateBot: () => void;
  onEditBot: (botId: string) => void;
  duplicateSupported?: boolean;
  duplicatingBotIds?: ReadonlySet<string>;
  onDuplicateBot?: (botId: string) => Promise<void>;
  onDeleteBot: (botId: string) => Promise<void>;
  compact: boolean;
  onExpand: () => void;
  onOpenMarketplace: () => void;
  emptyAction?: {
    label: string;
    avatarSeed: string;
    avatarHue: BotAvatarHue | null;
    onSelect: () => void;
  };
}

export type SidebarAgentState = { kind: "working" } | { kind: "responded" } | { kind: "unread"; count: number };

export type ResolvedPinnedItem = { ref: SidebarPinnedItem; bot: BotProfile };

export function Sidebar(props: SidebarProps) {
  const scope = createSidebarScope(props);
  return (
    <SidebarScopeContext value={scope}>
      <aside
        id="bot-sidebar"
        aria-label="Bot navigation"
        class={["sidebar panel-edge", { "sidebar-compact": props.compact }]}
      >
        <SidebarTopbar />

        <SidebarSearch />

        <SidebarNav />

        <SidebarDialogs />
      </aside>
    </SidebarScopeContext>
  );
}

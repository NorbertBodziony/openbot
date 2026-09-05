import type {
  AvatarHue,
  DirectThreadSummary,
  SidebarLayoutAction,
  SidebarLayoutSnapshot,
  TeamPresenceMember,
} from "@openbot/contracts/ipc";
import type { AgentProfile } from "../data";
import type { SidebarPinnedItem } from "../sidebar-pins";
import { SidebarDialogs } from "./sidebar/SidebarDialogs";
import { SidebarNav } from "./sidebar/SidebarNav";
import { SidebarSearch } from "./sidebar/SidebarSearch";
import { SidebarTopbar } from "./sidebar/SidebarTopbar";
import { createSidebarScope, SidebarScopeContext } from "./sidebar/sidebar-scope";

export interface SidebarProps {
  serverName: string;
  onOpenServerSettings: (trigger: HTMLElement) => void;
  agents: AgentProfile[];
  activeAgentId: string;
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
  onSelectAgent: (agentId: string) => void;
  onSelectPerson: (memberId: string) => void;
  onPreloadDirectConversation?: () => void;
  onCreateAgent: () => void;
  onEditAgent: (agentId: string) => void;
  duplicateSupported?: boolean;
  duplicatingAgentIds?: ReadonlySet<string>;
  onDuplicateAgent?: (agentId: string) => Promise<void>;
  onDeleteAgent: (agentId: string) => Promise<void>;
  compact: boolean;
  onExpand: () => void;
  onOpenMarketplace: () => void;
  emptyAction?: {
    label: string;
    avatarSeed: string;
    avatarHue: AvatarHue | null;
    onSelect: () => void;
  };
}

export type SidebarAgentState = { kind: "working" } | { kind: "responded" } | { kind: "unread"; count: number };

export type ResolvedPinnedItem = { ref: SidebarPinnedItem; agent: AgentProfile };

export function Sidebar(props: SidebarProps) {
  const scope = createSidebarScope(props);
  return (
    <SidebarScopeContext value={scope}>
      <aside
        id="agent-sidebar"
        aria-label="Agent navigation"
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

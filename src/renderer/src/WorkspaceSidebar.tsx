import { createMemo } from "solid-js";
import { useAgentActions } from "./agent-actions";
import { useAgents } from "./agents";
import { Sidebar } from "./components/Sidebar";
import { useConversation } from "./conversation";
import { useDirectMessages } from "./direct-messages";
import { useLayout } from "./layout";
import { DirectConversation } from "./lazy-views";
import { useNavigation } from "./navigation";
import { usePresence } from "./presence";
import { useServerSettings } from "./server-settings";
import { useServers } from "./servers";
import { useSettings } from "./settings";
import { useSidebar } from "./sidebar";
import { computeSidebarAgentStates } from "./sidebar-agent-states";
import { useTurns } from "./turns";

/**
 * The list of Agents and people. It reads the most domains of any pane, and every
 * one of them for the same reason: a sidebar row shows who exists, who is
 * working, who has replied and who is pinned, which is four domains before any
 * of the actions on the row context menu.
 *
 * `peopleEnabled` arrives as a prop because the shell already computes it to
 * decide which pane renders. Deriving it a second time here would let the two
 * answers disagree for a frame.
 */
export function WorkspaceSidebar(props: { peopleEnabled: boolean }) {
  const layout = useLayout();
  const { activeServer, activeServerSupportsCapability } = useServers();
  const { openServerSettings } = useServerSettings();
  const { setSkillsMarketplaceOpen } = useSettings();
  const { agentList, activeAgent, agentSetupDraft, duplicatingAgentIds, openBotSetup } = useAgents();
  const { editAgent, duplicateAgent, deleteAgent } = useAgentActions();
  const { activeTurns, queues } = useTurns();
  const { unreadReplies, recentReplies } = useConversation();
  const { directPeople } = usePresence();
  const { activeDirectMember, activeDirectMemberId, directThreads } = useDirectMessages();
  const { selectAgent, selectDirectMember } = useNavigation();
  const {
    sidebarLayout,
    collapsedSidebarSectionIds,
    mutateSidebarLayout,
    toggleSidebarSection,
    pinnedSidebarItems,
    sidebarPeopleOrder,
    pinSidebarItem,
    unpinSidebarItem,
    reorderPinnedSidebarItems,
    reorderSidebarPeople,
  } = useSidebar();

  const sidebarAgentStates = createMemo(() =>
    computeSidebarAgentStates({
      agentIds: agentList().map((agent) => agent.id),
      activeTurns: activeTurns(),
      queues: queues(),
      unreadReplies: unreadReplies(),
      recentReplies: recentReplies(),
    }),
  );

  return (
    <Sidebar
      serverName={activeServer()?.name ?? "Local"}
      onOpenServerSettings={(trigger) => {
        const server = activeServer();
        if (server) openServerSettings(server.id, trigger);
      }}
      agents={agentList()}
      activeAgentId={activeDirectMember() ? "" : (activeAgent()?.id ?? "")}
      showPeople={props.peopleEnabled}
      people={directPeople()}
      directThreads={directThreads()}
      activeDirectMemberId={activeDirectMemberId()}
      agentStates={sidebarAgentStates()}
      layout={sidebarLayout()}
      layoutMutable={activeServerSupportsCapability("sidebar-layout")}
      collapsedSectionIds={collapsedSidebarSectionIds()}
      onMutateLayout={mutateSidebarLayout}
      onToggleSection={toggleSidebarSection}
      pinnedItems={pinnedSidebarItems()}
      peopleOrder={sidebarPeopleOrder()}
      onPin={pinSidebarItem}
      onUnpin={unpinSidebarItem}
      onReorderPinned={reorderPinnedSidebarItems}
      onReorderPeople={reorderSidebarPeople}
      onSelectAgent={selectAgent}
      onSelectPerson={(memberId) => void selectDirectMember(memberId)}
      onPreloadDirectConversation={props.peopleEnabled ? () => void DirectConversation.preload() : undefined}
      onCreateAgent={openBotSetup}
      onEditAgent={editAgent}
      duplicateSupported={activeServerSupportsCapability("agent-duplication")}
      duplicatingAgentIds={duplicatingAgentIds()}
      onDuplicateAgent={duplicateAgent}
      onDeleteAgent={deleteAgent}
      compact={layout.leftPanelCompact()}
      onExpand={layout.expandSidebar}
      onOpenMarketplace={() => setSkillsMarketplaceOpen(true)}
      emptyAction={
        agentList().length === 0
          ? {
              label: "Create your first agent",
              avatarSeed: agentSetupDraft().avatarSeed,
              avatarHue: agentSetupDraft().avatarHue,
              onSelect: openBotSetup,
            }
          : undefined
      }
    />
  );
}

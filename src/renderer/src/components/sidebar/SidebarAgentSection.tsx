/**
 * One agent section - the unassigned one included. A custom section stays visible while empty so it
 * can be dropped into, but only when nothing is being searched for: during a search an empty
 * section is noise, not a target.
 */

import { SIDEBAR_UNASSIGNED_SECTION_ID } from "@openbot/contracts/ipc";
import { For, Show } from "solid-js";
import { SidebarAgentRow } from "./SidebarAgentRow";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarAgentSection(sectionProps: { sectionId: string }) {
  const {
    customSectionById,
    dragOffset,
    filteredBotsBySection,
    normalizedQuery,
    sectionDragClasses,
    sectionIsCollapsed,
  } = useSidebarScope();
  const sectionId = () => sectionProps.sectionId;
  const bots = () => filteredBotsBySection().get(sectionId()) ?? [];
  const name = () =>
    sectionId() === SIDEBAR_UNASSIGNED_SECTION_ID ? "Unassigned" : (customSectionById().get(sectionId())?.name ?? "");
  return (
    <Show when={name() && (bots().length > 0 || (customSectionById().has(sectionId()) && !normalizedQuery()))}>
      <section
        class={["sidebar-chat-group sidebar-section", sectionDragClasses(sectionId())]}
        style={`--sidebar-section-drag-y: ${dragOffset(sectionId()).y}px;`}
        aria-label={name()}
        data-section-id={sectionId()}
      >
        <SidebarSectionHeader sectionId={sectionId()} name={name()} />
        <div
          class="sidebar-section-collapse"
          data-collapsed={sectionIsCollapsed(sectionId()) ? "" : undefined}
          aria-hidden={sectionIsCollapsed(sectionId()) ? "true" : undefined}
          inert={sectionIsCollapsed(sectionId()) ? true : undefined}
        >
          <div id={`sidebar-section-body-${sectionId()}`} class="sidebar-section-body">
            <For each={bots()}>{(bot) => <SidebarAgentRow bot={bot} />}</For>
          </div>
        </div>
      </section>
    </Show>
  );
}

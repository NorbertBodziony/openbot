/**
 * Every section in the order the layout gives, plus the draft section a create is editing. The
 * draft sits after the list rather than inside it because it has no id yet, so nothing in the
 * layout order can place it.
 */

import { SIDEBAR_PEOPLE_SECTION_ID } from "@openbot/contracts/ipc";
import { For, Show } from "solid-js";
import { SidebarAgentSection } from "./SidebarAgentSection";
import { SidebarPeopleSection } from "./SidebarPeopleSection";
import { SidebarSectionEditor } from "./SidebarSectionEditor";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarSectionList() {
  const { pending, props } = useSidebarScope();
  return (
    <>
      <For each={props.layout.order}>
        {(sectionId) =>
          sectionId === SIDEBAR_PEOPLE_SECTION_ID ? (
            <SidebarPeopleSection sectionId={sectionId} />
          ) : (
            <SidebarAgentSection sectionId={sectionId} />
          )
        }
      </For>
      <Show when={pending.sectionEditor?.target.kind === "create"}>
        <section class="sidebar-chat-group sidebar-section sidebar-section-draft" aria-label="New section">
          <SidebarSectionEditor />
        </section>
      </Show>
    </>
  );
}

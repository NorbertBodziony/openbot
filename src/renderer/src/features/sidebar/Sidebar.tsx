import { SidebarDialogs } from "./SidebarDialogs";
import { SidebarNav } from "./SidebarNav";
import { SidebarSearch } from "./SidebarSearch";
import { SidebarTopbar } from "./SidebarTopbar";
import { createSidebarScope, SidebarScopeContext } from "./sidebar-scope";
import type { SidebarProps } from "./sidebar-types";

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

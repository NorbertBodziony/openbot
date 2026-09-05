/** The search field, and the compact-mode button that expands the sidebar to reach it. */

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { Button, Input } from "../../components/ui";
import { SearchIcon } from "./SidebarIcons";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarSearch() {
  const { expandToSearch, props, query, setQuery, setSearchInputElement } = useSidebarScope();
  return (
    <div class="sidebar-search-wrap">
      <label class="search-field" aria-hidden={props.compact ? "true" : undefined}>
        <span class="sr-only">Search chats</span>
        <SearchIcon />
        <Input
          ref={setSearchInputElement}
          type="search"
          value={query()}
          onValueChange={setQuery}
          placeholder="Search"
          aria-label="Search chats"
          tabindex={props.compact ? -1 : 0}
          maxlength={INPUT_LIMITS.agentName}
        />
      </label>
      <Button
        variant="ghost"
        type="button"
        class="sidebar-compact-search"
        aria-label="Expand sidebar and search chats"
        aria-hidden={props.compact ? undefined : "true"}
        tabindex={props.compact ? 0 : -1}
        onClick={expandToSearch}
      >
        <SearchIcon />
      </Button>
    </div>
  );
}

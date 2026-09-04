/**
 * The search field: what the user typed, the folded form every filter compares against, and the
 * element `expandToSearch` aims at - a collapsed sidebar has to open before it has one to focus.
 */

import { createMemo, createSignal } from "solid-js";
import type { SidebarProps } from "../../Sidebar";

export function createSidebarSearchStore(deps: { props: SidebarProps }) {
  const [query, setQuery] = createSignal("");
  const normalizedQuery = createMemo(() => query().trim().toLowerCase());

  let searchInput: HTMLInputElement | undefined;

  const setSearchInputElement = (element: HTMLInputElement) => {
    searchInput = element;
  };

  function expandToSearch(): void {
    deps.props.onExpand();
    queueMicrotask(() => searchInput?.focus());
  }

  return { expandToSearch, normalizedQuery, query, setQuery, setSearchInputElement };
}

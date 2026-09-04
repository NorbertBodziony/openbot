/**
 * The DOM half of the sidebar drag: what it queries, what it measures, and the drag card it builds.
 * Kept apart from the model so the geometry can be produced in one place and read as plain values.
 */

import type {
  AgentDragSlot,
  DragSlot,
  PersonDragSlot,
  SectionDragSlot,
  SidebarDragGeometry,
} from "./sidebar-drag-model";

/**
 * Everything `measureSidebarDragSlots` asks the list for. Each name is emitted by exactly one JSX
 * site: `sectionRegion` by the People and agent sections, `agentRow` by the agent row, `personRow`
 * by the people section, `pinnedTile` by the pinned group. Renaming one here without renaming the
 * emitter leaves an empty slot map behind: the drag starts, tracks nothing and drops nowhere, and
 * no test fails loudly on it.
 */
export const SIDEBAR_DRAG_SELECTORS = {
  agentRow: "[data-agent-id]",
  personRow: "[data-person-id]",
  pinnedEmptyDrop: ".sidebar-pinned-empty-drop",
  pinnedGroup: ".sidebar-pinned-group",
  pinnedTile: "[data-pinned-key]",
  section: ".sidebar-section",
  sectionRegion: "[data-section-id]",
} as const;

/** One pass over the list: every slot cache plus the two rectangles the drop resolver guards on. */
export interface SidebarDragMeasurement {
  agents: Map<string, AgentDragSlot>;
  geometry: SidebarDragGeometry;
  people: Map<string, PersonDragSlot>;
  pinned: DragSlot[];
  sections: Map<string, SectionDragSlot>;
}

export function measureSidebarDragSlots(
  list: HTMLElement,
  assignedSectionId: (agentId: string) => string,
): SidebarDragMeasurement {
  const sections = new Map<string, SectionDragSlot>();
  const agents = new Map<string, AgentDragSlot>();
  const people = new Map<string, PersonDragSlot>();
  const pinned: DragSlot[] = [];
  const pinnedGroup = list.querySelector<HTMLElement>(SIDEBAR_DRAG_SELECTORS.pinnedGroup);
  const pinnedTarget = pinnedGroup?.querySelector<HTMLElement>(SIDEBAR_DRAG_SELECTORS.pinnedEmptyDrop) ?? pinnedGroup;
  const geometry: SidebarDragGeometry = {
    list: list.getBoundingClientRect(),
    pinned: pinnedTarget?.getBoundingClientRect() ?? null,
  };
  for (const section of list.querySelectorAll<HTMLElement>(SIDEBAR_DRAG_SELECTORS.sectionRegion)) {
    const sectionId = section.dataset.sectionId;
    if (!sectionId) continue;
    const bounds = section.getBoundingClientRect();
    sections.set(sectionId, {
      bottom: bounds.bottom,
      sectionId,
      top: bounds.top,
      centerY: bounds.top + bounds.height / 2,
    });
  }
  for (const row of list.querySelectorAll<HTMLElement>(SIDEBAR_DRAG_SELECTORS.agentRow)) {
    const agentId = row.dataset.agentId;
    if (!agentId) continue;
    const bounds = row.getBoundingClientRect();
    agents.set(agentId, {
      agentId,
      bottom: bounds.bottom,
      centerY: bounds.top + bounds.height / 2,
      element: row,
      height: bounds.height,
      sectionId: assignedSectionId(agentId),
      top: bounds.top,
    });
  }
  for (const row of list.querySelectorAll<HTMLElement>(SIDEBAR_DRAG_SELECTORS.personRow)) {
    const memberId = row.dataset.personId;
    if (!memberId) continue;
    const bounds = row.getBoundingClientRect();
    people.set(memberId, {
      bottom: bounds.bottom,
      centerY: bounds.top + bounds.height / 2,
      element: row,
      memberId,
      top: bounds.top,
    });
  }
  for (const item of list.querySelectorAll<HTMLElement>(SIDEBAR_DRAG_SELECTORS.pinnedTile)) {
    const key = item.dataset.pinnedKey;
    if (!key) continue;
    const bounds = item.getBoundingClientRect();
    pinned.push({
      bottom: bounds.bottom,
      centerX: bounds.left + bounds.width / 2,
      centerY: bounds.top + bounds.height / 2,
      key,
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
    });
  }
  return { agents, geometry, people, pinned, sections };
}

/** Takes the drop highlight off every section and off the pinned group. */
export function clearSidebarDragDecorations(list: HTMLElement | undefined): void {
  list?.querySelector(SIDEBAR_DRAG_SELECTORS.pinnedGroup)?.classList.remove("sidebar-pinned-group-agent-drop-target");
  for (const section of list?.querySelectorAll<HTMLElement>(SIDEBAR_DRAG_SELECTORS.section) ?? []) {
    section.classList.remove(
      "sidebar-section-agent-drop-target",
      "sidebar-section-drop-before",
      "sidebar-section-drop-after",
    );
  }
}

export function createSidebarAgentDragCard(source: HTMLElement): HTMLElement {
  const card = document.createElement("div");
  card.className = "bot-row sidebar-pinned-row sidebar-agent-drag-card";

  const sourceAvatar = source.querySelector(".bot-row-avatar")?.cloneNode(true);
  if (sourceAvatar instanceof HTMLElement) {
    sourceAvatar.classList.add("sidebar-pinned-avatar");
    card.append(sourceAvatar);
  }

  const copy = document.createElement("span");
  copy.className = "bot-row-copy sidebar-pinned-copy";
  const name = document.createElement("strong");
  name.className = "sidebar-pinned-name";
  name.textContent =
    source
      .querySelector(".sidebar-pinned-name, .bot-row-title strong, .bot-row-heading > strong")
      ?.textContent?.trim() ?? "Chat";
  copy.append(name);

  const titleText = source.querySelector(".sidebar-pinned-title, .bot-role-badge")?.textContent?.trim();
  if (titleText) {
    const title = document.createElement("span");
    title.className = "z-badge z-badge-variant-secondary sidebar-pinned-title";
    title.dataset.slot = "badge";
    title.dataset.variant = "secondary";
    title.dataset.size = "sm";
    const label = document.createElement("span");
    label.textContent = titleText;
    title.append(label);
    copy.append(title);
  }

  card.append(copy);
  return card;
}

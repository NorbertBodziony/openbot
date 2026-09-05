import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  SIDEBAR_PEOPLE_SECTION_ID,
  SIDEBAR_UNASSIGNED_SECTION_ID,
  type SidebarLayoutAction,
  type SidebarLayoutSnapshot,
  type SidebarSection,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { isUuidV4 } from "@openbot/contracts/validation";
import { legacyAgentId } from "./workspace-paths";

interface StoredSidebarLayout extends SidebarLayoutSnapshot {
  version: 2;
}

interface LegacyStoredSidebarLayout extends Omit<SidebarLayoutSnapshot, "agentOrder"> {
  version: 1;
}

interface SidebarLayoutStoreEvents {
  changed: [layout: SidebarLayoutSnapshot];
}

const DEFAULT_LAYOUT: SidebarLayoutSnapshot = {
  revision: 0,
  sections: [],
  order: [SIDEBAR_PEOPLE_SECTION_ID, SIDEBAR_UNASSIGNED_SECTION_ID],
  agentAssignments: {},
  agentOrder: [],
};

export class SidebarLayoutStore extends EventEmitter<SidebarLayoutStoreEvents> {
  readonly #path: string;
  #layout = structuredClone(DEFAULT_LAYOUT);
  #operationQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    super();
    this.#path = path;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8"));
      if (isStoredSidebarLayout(parsed)) this.#layout = snapshotFromStored(parsed);
      else if (isLegacyStoredSidebarLayout(parsed))
        this.#layout = { ...snapshotFromLegacyStored(parsed), agentOrder: [] };
      else throw new Error("Invalid sidebar layout state.");
    } catch (error) {
      if (isMissingFile(error)) return;
      const backupPath = `${this.#path}.corrupt-${Date.now()}`;
      await rename(this.#path, backupPath).catch(() => undefined);
      this.#layout = structuredClone(DEFAULT_LAYOUT);
    }
  }

  getSnapshot(): SidebarLayoutSnapshot {
    return structuredClone(this.#layout);
  }

  mutate(action: SidebarLayoutAction, agentIds: ReadonlySet<string>): Promise<SidebarLayoutSnapshot> {
    return this.#enqueue(async () => {
      const next = applySidebarLayoutAction(this.#layout, action, agentIds);
      if (next === this.#layout) return this.getSnapshot();
      await this.#commit(next);
      return this.getSnapshot();
    });
  }

  removeAgent(agentId: string): Promise<SidebarLayoutSnapshot> {
    return this.#enqueue(async () => {
      if (!(agentId in this.#layout.agentAssignments) && !this.#layout.agentOrder.includes(agentId)) {
        return this.getSnapshot();
      }
      const agentAssignments = { ...this.#layout.agentAssignments };
      delete agentAssignments[agentId];
      await this.#commit({
        ...this.#layout,
        revision: this.#layout.revision + 1,
        agentAssignments,
        agentOrder: this.#layout.agentOrder.filter((candidate) => candidate !== agentId),
      });
      return this.getSnapshot();
    });
  }

  placeDuplicateAfter(
    sourceAgentId: string,
    duplicateAgentId: string,
    orderedAgentIds: readonly string[],
  ): Promise<SidebarLayoutSnapshot> {
    return this.#enqueue(async () => {
      const agentIds = new Set(orderedAgentIds);
      if (!agentIds.has(sourceAgentId) || !agentIds.has(duplicateAgentId)) throw new Error("Unknown agent.");
      const sectionId = this.#layout.agentAssignments[sourceAgentId] ?? null;
      const order = normalizedAgentOrder(this.#layout.agentOrder, agentIds).filter(
        (agentId) => agentId !== duplicateAgentId,
      );
      const sourceIndex = order.indexOf(sourceAgentId);
      if (sourceIndex < 0) throw new Error("Unknown source agent order.");
      const beforeAgentId =
        order
          .slice(sourceIndex + 1)
          .find((agentId) => (this.#layout.agentAssignments[agentId] ?? null) === sectionId) ?? null;
      const next = applySidebarLayoutAction(
        this.#layout,
        { type: "move-agent", agentId: duplicateAgentId, sectionId, beforeAgentId },
        agentIds,
      );
      if (next === this.#layout) return this.getSnapshot();
      await this.#commit(next);
      return this.getSnapshot();
    });
  }

  /**
   * Drops the agents that are gone -- but renames the ones that only look gone first. This layout is a
   * JSON file outside the database, so migration v13 renamed every agent in SQLite and left the sidebar
   * still filing them under `bot-<uuid>`. Filtering straight against the new roster would read that as
   * "these agents no longer exist" and commit the deletion, so a user with a dozen agents in named groups
   * comes back to all of them unassigned, in an order they never chose, with nothing to undo it.
   */
  reconcileAgents(agentIds: ReadonlySet<string>): Promise<SidebarLayoutSnapshot> {
    return this.#enqueue(async () => {
      const renamedFrom = new Map<string, string>();
      for (const agentId of agentIds) {
        const legacyId = legacyAgentId(agentId);
        if (legacyId !== agentId) renamedFrom.set(legacyId, agentId);
      }
      // An id still in the roster answers for itself, which is why that test comes first: v13 declines to
      // rename onto an id that is taken, so an agent spelled `bot-<uuid>` can be sitting beside the
      // `agent-<uuid>` it would otherwise have become, and this entry belongs to the one the user filed.
      const currentId = (agentId: string) => (agentIds.has(agentId) ? agentId : (renamedFrom.get(agentId) ?? agentId));
      const agentAssignments = Object.fromEntries(
        Object.entries(this.#layout.agentAssignments)
          .map(([agentId, sectionId]) => [currentId(agentId), sectionId] as const)
          .filter(([agentId]) => agentIds.has(agentId)),
      );
      const agentOrder = this.#layout.agentOrder.map(currentId).filter((agentId) => agentIds.has(agentId));
      if (
        Object.keys(agentAssignments).length === Object.keys(this.#layout.agentAssignments).length &&
        Object.keys(agentAssignments).every((agentId) => agentId in this.#layout.agentAssignments) &&
        agentOrder.length === this.#layout.agentOrder.length &&
        agentOrder.every((agentId, index) => agentId === this.#layout.agentOrder[index])
      ) {
        return this.getSnapshot();
      }
      await this.#commit({ ...this.#layout, revision: this.#layout.revision + 1, agentAssignments, agentOrder });
      return this.getSnapshot();
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationQueue.then(operation, operation);
    this.#operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #commit(next: SidebarLayoutSnapshot): Promise<void> {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    const stored: StoredSidebarLayout = { version: 2, ...next };
    await writeFile(temporary, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.#path);
    this.#layout = next;
    this.emit("changed", this.getSnapshot());
  }
}

function applySidebarLayoutAction(
  current: SidebarLayoutSnapshot,
  action: SidebarLayoutAction,
  agentIds: ReadonlySet<string>,
): SidebarLayoutSnapshot {
  switch (action.type) {
    case "create": {
      if (current.sections.length >= INPUT_LIMITS.sidebarSections) {
        throw new Error(`A server can have up to ${INPUT_LIMITS.sidebarSections} sidebar sections.`);
      }
      const name = validSectionName(action.name, current.sections);
      if (action.agentId !== undefined && !agentIds.has(action.agentId)) throw new Error("Unknown agent.");
      const section: SidebarSection = { id: randomUUID(), name };
      return {
        revision: current.revision + 1,
        sections: [...current.sections, section],
        order: [...current.order, section.id],
        agentAssignments:
          action.agentId === undefined
            ? { ...current.agentAssignments }
            : { ...current.agentAssignments, [action.agentId]: section.id },
        agentOrder: [...current.agentOrder],
      };
    }
    case "rename": {
      const section = requireCustomSection(current, action.sectionId);
      const name = validSectionName(
        action.name,
        current.sections.filter((candidate) => candidate.id !== section.id),
      );
      if (name === section.name) return current;
      return {
        ...current,
        revision: current.revision + 1,
        sections: current.sections.map((candidate) =>
          candidate.id === section.id ? { ...candidate, name } : candidate,
        ),
      };
    }
    case "delete": {
      requireCustomSection(current, action.sectionId);
      return {
        revision: current.revision + 1,
        sections: current.sections.filter((section) => section.id !== action.sectionId),
        order: current.order.filter((sectionId) => sectionId !== action.sectionId),
        agentAssignments: Object.fromEntries(
          Object.entries(current.agentAssignments).filter(([, sectionId]) => sectionId !== action.sectionId),
        ),
        agentOrder: [...current.agentOrder],
      };
    }
    case "move": {
      const index = current.order.indexOf(action.sectionId);
      if (index < 0) throw new Error("Unknown sidebar section.");
      const targetIndex = index + (action.direction === "up" ? -1 : 1) * (action.steps ?? 1);
      if (targetIndex < 0 || targetIndex >= current.order.length) return current;
      const order = [...current.order];
      const [movedSectionId] = order.splice(index, 1);
      if (!movedSectionId) return current;
      order.splice(targetIndex, 0, movedSectionId);
      return { ...current, revision: current.revision + 1, order };
    }
    case "assign": {
      if (!agentIds.has(action.agentId)) throw new Error("Unknown agent.");
      if (action.sectionId !== null) requireCustomSection(current, action.sectionId);
      const agentAssignments = { ...current.agentAssignments };
      if (action.sectionId === null) delete agentAssignments[action.agentId];
      else agentAssignments[action.agentId] = action.sectionId;
      if (agentAssignments[action.agentId] === current.agentAssignments[action.agentId]) return current;
      if (action.sectionId === null && !(action.agentId in current.agentAssignments)) return current;
      return { ...current, revision: current.revision + 1, agentAssignments };
    }
    case "move-agent": {
      if (!agentIds.has(action.agentId)) throw new Error("Unknown agent.");
      if (action.sectionId !== null) requireCustomSection(current, action.sectionId);
      if (action.beforeAgentId !== null) {
        if (!agentIds.has(action.beforeAgentId) || action.beforeAgentId === action.agentId) {
          throw new Error("Unknown agent order target.");
        }
        const targetSectionId = current.agentAssignments[action.beforeAgentId] ?? null;
        if (targetSectionId !== action.sectionId) throw new Error("Agent order target belongs to another section.");
      }

      const agentOrder = normalizedAgentOrder(current.agentOrder, agentIds).filter(
        (agentId) => agentId !== action.agentId,
      );
      let insertionIndex = agentOrder.length;
      if (action.beforeAgentId !== null) {
        insertionIndex = agentOrder.indexOf(action.beforeAgentId);
      } else {
        for (const [index, agentId] of agentOrder.entries()) {
          if ((current.agentAssignments[agentId] ?? null) === action.sectionId) insertionIndex = index + 1;
        }
      }
      agentOrder.splice(insertionIndex, 0, action.agentId);

      const agentAssignments = { ...current.agentAssignments };
      if (action.sectionId === null) delete agentAssignments[action.agentId];
      else agentAssignments[action.agentId] = action.sectionId;
      if (
        arraysEqual(agentOrder, current.agentOrder) &&
        agentAssignments[action.agentId] === current.agentAssignments[action.agentId]
      ) {
        return current;
      }
      return { ...current, revision: current.revision + 1, agentAssignments, agentOrder };
    }
  }
}

function normalizedAgentOrder(order: readonly string[], agentIds: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const agentId of [...order, ...agentIds]) {
    if (!agentIds.has(agentId) || seen.has(agentId)) continue;
    seen.add(agentId);
    normalized.push(agentId);
  }
  return normalized;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validSectionName(name: string, existing: readonly SidebarSection[]): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Section name is required.");
  if (trimmed.length > INPUT_LIMITS.sidebarSectionName) throw new Error("Section name is too long.");
  if (existing.some((section) => section.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) {
    throw new Error("Section names must be unique.");
  }
  return trimmed;
}

function requireCustomSection(layout: SidebarLayoutSnapshot, sectionId: string): SidebarSection {
  const section = layout.sections.find((candidate) => candidate.id === sectionId);
  if (!section) throw new Error("Unknown sidebar section.");
  return section;
}

function isStoredSidebarLayout(value: unknown): value is StoredSidebarLayout {
  if (!isDynamicRecord(value) || value.version !== 2 || !isNumber(value.revision)) return false;
  if (!isStoredSidebarLayoutBody(value) || !Array.isArray(value.agentOrder)) return false;
  return (
    value.agentOrder.every(
      (agentId) => isString(agentId) && agentId.length > 0 && agentId.length <= INPUT_LIMITS.identifier,
    ) && new Set(value.agentOrder).size === value.agentOrder.length
  );
}

function isLegacyStoredSidebarLayout(value: unknown): value is LegacyStoredSidebarLayout {
  return isDynamicRecord(value) && value.version === 1 && isStoredSidebarLayoutBody(value);
}

function isStoredSidebarLayoutBody(value: unknown): boolean {
  if (!isDynamicRecord(value)) return false;
  if (!isNumber(value.revision)) return false;
  if (!Number.isInteger(value.revision) || value.revision < 0) return false;
  if (!Array.isArray(value.sections) || value.sections.length > INPUT_LIMITS.sidebarSections) return false;
  if (!Array.isArray(value.order) || !isDynamicRecord(value.agentAssignments)) return false;

  const sections: SidebarSection[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const candidate of value.sections) {
    if (!isDynamicRecord(candidate) || !isString(candidate.id) || !isString(candidate.name)) return false;
    if (!isUuidV4(candidate.id) || candidate.name !== candidate.name.trim() || !candidate.name) return false;
    if (candidate.name.length > INPUT_LIMITS.sidebarSectionName) return false;
    const normalizedName = candidate.name.toLocaleLowerCase();
    if (ids.has(candidate.id) || names.has(normalizedName)) return false;
    ids.add(candidate.id);
    names.add(normalizedName);
    sections.push({ id: candidate.id, name: candidate.name });
  }

  const expectedOrder = new Set([SIDEBAR_PEOPLE_SECTION_ID, SIDEBAR_UNASSIGNED_SECTION_ID, ...ids]);
  if (
    value.order.length !== expectedOrder.size ||
    !value.order.every((sectionId) => isString(sectionId) && expectedOrder.has(sectionId)) ||
    new Set(value.order).size !== value.order.length
  ) {
    return false;
  }
  return Object.entries(value.agentAssignments).every(
    ([agentId, sectionId]) =>
      agentId.length > 0 && agentId.length <= INPUT_LIMITS.identifier && isString(sectionId) && ids.has(sectionId),
  );
}

function snapshotFromStored(stored: StoredSidebarLayout): SidebarLayoutSnapshot {
  return {
    revision: stored.revision,
    sections: stored.sections.map((section) => ({ ...section })),
    order: [...stored.order],
    agentAssignments: { ...stored.agentAssignments },
    agentOrder: [...stored.agentOrder],
  };
}

function snapshotFromLegacyStored(stored: LegacyStoredSidebarLayout): Omit<SidebarLayoutSnapshot, "agentOrder"> {
  return {
    revision: stored.revision,
    sections: stored.sections.map((section) => ({ ...section })),
    order: [...stored.order],
    agentAssignments: { ...stored.agentAssignments },
  };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

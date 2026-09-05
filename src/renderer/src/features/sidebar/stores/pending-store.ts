/**
 * The two changes the sidebar can have half-made: a delete confirmation waiting on the user, and an
 * open section-name editor. Both live in one store because only one of each can exist, and because
 * closing either is then what discards what the failed attempt was saying.
 */

import type { SidebarSection } from "@openbot/contracts/ipc";
import { createMemo, createStore } from "solid-js";
import type { SidebarProps } from "../Sidebar";

/**
 * The one delete confirmation the sidebar can have open: an agent, or a custom section, never both.
 * The attempt's progress and the reason it failed live inside the record rather than beside it, so
 * closing the dialog cannot leave a "Deleting…" button or the previous attempt's message behind.
 */
interface SidebarPendingDelete {
  deleting: boolean;
  error: string | null;
  /** The agent or the section, whichever `kind` names. */
  id: string;
  /** Which of the two confirmations is on screen. Each dialog renders from one arm. */
  kind: "agent" | "section";
}

/** What the section editor is editing: a section about to exist, or the one being renamed. */
type SidebarSectionEditorTarget = { kind: "create"; agentId?: string } | { kind: "rename"; sectionId: string };

/**
 * The open section-name editor. The name as typed, its validation message and the save in flight
 * hang off the editor because none of them means anything without one - a name left behind by a
 * closed editor is what every `startCreateSection` had to remember to clear.
 */
interface SidebarSectionEditor {
  error: string | null;
  name: string;
  saving: boolean;
  target: SidebarSectionEditorTarget;
}

/** The two changes the sidebar can have half-made, each waiting on the user rather than on data. */
interface SidebarPending {
  deletion: SidebarPendingDelete | null;
  sectionEditor: SidebarSectionEditor | null;
}

export function createSidebarPendingStore(deps: {
  customSectionById: () => Map<string, SidebarSection>;
  props: SidebarProps;
}) {
  const { customSectionById, props } = deps;

  const [pending, setPending] = createStore<SidebarPending>({ deletion: null, sectionEditor: null });
  // Both dialogs read these: only one confirmation exists, and each dialog only renders while it is
  // the one. That is also why a section delete no longer needs its own pair of flags.
  const deleting = () => pending.deletion?.deleting === true;
  const deleteError = () => pending.deletion?.error ?? null;
  let sectionNameInput: HTMLInputElement | undefined;

  const deleteTarget = createMemo(() => {
    const deletion = pending.deletion;
    return deletion?.kind === "agent" ? props.agents.find((agent) => agent.id === deletion.id) : undefined;
  });
  const sectionDeleteTarget = createMemo(() => {
    const deletion = pending.deletion;
    return deletion?.kind === "section"
      ? props.layout.sections.find((section) => section.id === deletion.id)
      : undefined;
  });

  function openDelete(kind: SidebarPendingDelete["kind"], id: string): void {
    setPending((state) => {
      state.deletion = { deleting: false, error: null, id, kind };
    });
  }

  /** Closing the confirmation is what discards a failed attempt's message; nothing else has to. */
  function closeDelete(): void {
    setPending((state) => {
      state.deletion = null;
    });
  }

  /** Marks the confirmation as running and drops what the previous attempt said. */
  function beginDelete(): void {
    setPending((state) => {
      if (!state.deletion) return;
      state.deletion.deleting = true;
      state.deletion.error = null;
    });
  }

  /** A failed delete leaves the confirmation open, no longer running, saying why. */
  function failDelete(cause: unknown): void {
    setPending((state) => {
      if (!state.deletion) return;
      state.deletion.deleting = false;
      state.deletion.error = cause instanceof Error ? cause.message : String(cause);
    });
  }

  async function confirmDelete() {
    const deletion = pending.deletion;
    if (deletion?.kind !== "agent" || deletion.deleting) return;
    beginDelete();
    try {
      await props.onDeleteAgent(deletion.id);
      closeDelete();
    } catch (error) {
      failDelete(error);
    }
  }

  const setSectionNameInput = (element: HTMLInputElement) => {
    sectionNameInput = element;
  };

  /**
   * The editor mounts and unmounts as `pending.sectionEditor` moves between create and rename, and
   * the new element can claim the slot before the old one is torn down - so only the element that
   * still holds it may clear it. Clearing unconditionally would leave `focusSectionName` focusing a
   * detached input, which is the silent half of "bad name, no second chance to fix it".
   */
  const releaseSectionNameInput = (element: HTMLInputElement | undefined) => {
    if (sectionNameInput === element) sectionNameInput = undefined;
  };

  function updateSectionEditorName(value: string): void {
    setPending((state) => {
      if (!state.sectionEditor) return;
      state.sectionEditor.name = value;
      state.sectionEditor.error = null;
    });
  }

  function focusSectionName(): void {
    queueMicrotask(() => {
      sectionNameInput?.focus();
      sectionNameInput?.select();
    });
  }

  function startCreateSection(agentId?: string): void {
    props.onExpand();
    setPending((state) => {
      state.sectionEditor = {
        error: null,
        name: "",
        saving: false,
        target: { kind: "create", ...(agentId ? { agentId } : {}) },
      };
    });
    focusSectionName();
  }

  function startRenameSection(sectionId: string): void {
    const section = customSectionById().get(sectionId);
    if (!section) return;
    props.onExpand();
    setPending((state) => {
      state.sectionEditor = { error: null, name: section.name, saving: false, target: { kind: "rename", sectionId } };
    });
    focusSectionName();
  }

  function cancelSectionEditor(): void {
    if (pending.sectionEditor?.saving) return;
    setPending((state) => {
      state.sectionEditor = null;
    });
  }

  /** The editor owns its validation message, so it cannot be read once the editor has closed. */
  function setSectionNameError(message: string): void {
    setPending((state) => {
      if (state.sectionEditor) state.sectionEditor.error = message;
    });
  }

  async function saveSectionEditor(): Promise<void> {
    const editor = pending.sectionEditor;
    if (!editor || editor.saving) return;
    const name = editor.name.trim();
    if (!name) {
      setSectionNameError("Section name is required.");
      focusSectionName();
      return;
    }
    const target = editor.target;
    const duplicate = props.layout.sections.some(
      (section) =>
        section.name.toLocaleLowerCase() === name.toLocaleLowerCase() &&
        !(target.kind === "rename" && target.sectionId === section.id),
    );
    if (duplicate) {
      setSectionNameError("Section names must be unique.");
      focusSectionName();
      return;
    }
    setPending((state) => {
      if (!state.sectionEditor) return;
      state.sectionEditor.error = null;
      state.sectionEditor.saving = true;
    });
    try {
      await props.onMutateLayout(
        target.kind === "create"
          ? { type: "create", name, ...(target.agentId ? { agentId: target.agentId } : {}) }
          : { type: "rename", sectionId: target.sectionId, name },
      );
      // The editor closes on success, which is also what releases the save it was holding.
      setPending((state) => {
        state.sectionEditor = null;
      });
    } catch (error) {
      setPending((state) => {
        if (!state.sectionEditor) return;
        state.sectionEditor.error = error instanceof Error ? error.message : String(error);
        state.sectionEditor.saving = false;
      });
      focusSectionName();
    }
  }

  async function confirmSectionDelete(): Promise<void> {
    const deletion = pending.deletion;
    if (deletion?.kind !== "section" || deletion.deleting) return;
    beginDelete();
    try {
      await props.onMutateLayout({ type: "delete", sectionId: deletion.id });
      closeDelete();
    } catch (error) {
      failDelete(error);
    }
  }

  return {
    cancelSectionEditor,
    closeDelete,
    confirmDelete,
    confirmSectionDelete,
    deleteError,
    deleteTarget,
    deleting,
    openDelete,
    pending,
    releaseSectionNameInput,
    saveSectionEditor,
    sectionDeleteTarget,
    setSectionNameInput,
    startCreateSection,
    startRenameSection,
    updateSectionEditorName,
  };
}

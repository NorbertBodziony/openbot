/**
 * The one section name field, used both for a section being created and for one being renamed.
 * Zero-prop because `pending.sectionEditor` already says which of the two it is, and because one
 * element means one `sectionNameInput` slot for `focusSectionName` to aim at.
 */

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { onCleanup, Show } from "solid-js";
import { ChevronDown, Input } from "../../components/ui";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarSectionEditor() {
  const {
    cancelSectionEditor,
    pending,
    releaseSectionNameInput,
    saveSectionEditor,
    setSectionNameInput,
    updateSectionEditorName,
  } = useSidebarScope();
  const editor = () => pending.sectionEditor;
  // The ref callback runs without an owner in Solid 2, so the cleanup has to be registered here, in
  // the component body, or it never runs and `focusSectionName` keeps aiming at a detached input.
  let element: HTMLInputElement | undefined;
  onCleanup(() => releaseSectionNameInput(element));
  return (
    <header class="sidebar-section-editor-wrap">
      <Input
        ref={(input: HTMLInputElement) => {
          element = input;
          setSectionNameInput(input);
        }}
        class="sidebar-section-editor"
        value={editor()?.name ?? ""}
        onValueChange={updateSectionEditorName}
        maxlength={INPUT_LIMITS.sidebarSectionName}
        aria-label={editor()?.target.kind === "rename" ? "Rename section" : "New section name"}
        aria-invalid={editor()?.error ? "true" : undefined}
        title={editor()?.error ?? undefined}
        disabled={editor()?.saving === true}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void saveSectionEditor();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancelSectionEditor();
          }
        }}
        onBlur={cancelSectionEditor}
      />
      <ChevronDown class="sidebar-section-editor-chevron size-4" aria-hidden="true" />
      <Show when={editor()?.error}>
        {(message) => (
          <span class="sr-only" role="alert">
            {message()}
          </span>
        )}
      </Show>
    </header>
  );
}

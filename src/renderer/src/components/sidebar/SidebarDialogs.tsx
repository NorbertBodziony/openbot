/**
 * The two confirmations the sidebar can be waiting on - one agent, one section. Both read the same
 * `deleting` and `deleteError`, because only one confirmation exists at a time.
 */

import { Show } from "solid-js";
import { AgentAvatar } from "../AgentAvatar";
import { AlertDialog, Button, Trash2 } from "../ui";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarDialogs() {
  const { closeDelete, confirmDelete, confirmSectionDelete, deleteError, deleteTarget, deleting, sectionDeleteTarget } =
    useSidebarScope();
  return (
    <>
      <AlertDialog.Root
        open={Boolean(deleteTarget())}
        onOpenChange={(open) => {
          if (!open && !deleting()) closeDelete();
        }}
      >
        <Show when={deleteTarget()}>
          {(bot) => (
            <AlertDialog.Portal>
              <AlertDialog.Overlay class="bot-delete-backdrop">
                <AlertDialog.Content class="bot-delete-dialog">
                  <AgentAvatar
                    bot={bot()}
                    style={{
                      width: "44px",
                      height: "44px",
                      "margin-bottom": "15px",
                    }}
                  />
                  <AlertDialog.Title>Delete {bot().name}?</AlertDialog.Title>
                  <AlertDialog.Description>
                    This removes the agent and its OpenBot conversation from the app. Its queue, memories, routines, and
                    workspace are deleted. History stored separately by the connected CLI provider is not deleted.
                  </AlertDialog.Description>
                  <Show when={deleteError()}>{(message) => <p class="bot-delete-error">{message()}</p>}</Show>
                  <div class="bot-delete-actions">
                    <Button variant="outline" type="button" disabled={deleting()} onClick={closeDelete}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      type="button"
                      class="bot-delete-confirm"
                      disabled={deleting()}
                      onClick={() => void confirmDelete()}
                    >
                      {deleting() ? "Deleting…" : "Delete"}
                    </Button>
                  </div>
                </AlertDialog.Content>
              </AlertDialog.Overlay>
            </AlertDialog.Portal>
          )}
        </Show>
      </AlertDialog.Root>

      <AlertDialog.Root
        open={Boolean(sectionDeleteTarget())}
        onOpenChange={(open) => {
          if (!open && !deleting()) closeDelete();
        }}
      >
        <Show when={sectionDeleteTarget()}>
          {(section) => (
            <AlertDialog.Portal>
              <AlertDialog.Overlay class="bot-delete-backdrop">
                <AlertDialog.Content class="bot-delete-dialog sidebar-section-delete-dialog">
                  <span class="sidebar-section-delete-icon" aria-hidden="true">
                    <Trash2 class="size-5" />
                  </span>
                  <AlertDialog.Title>Delete {section().name}?</AlertDialog.Title>
                  <AlertDialog.Description>
                    Agents in this section will move to Unassigned. No agents will be deleted.
                  </AlertDialog.Description>
                  <Show when={deleteError()}>{(message) => <p class="bot-delete-error">{message()}</p>}</Show>
                  <div class="bot-delete-actions">
                    <Button variant="outline" type="button" disabled={deleting()} onClick={closeDelete}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      type="button"
                      class="bot-delete-confirm"
                      disabled={deleting()}
                      onClick={() => void confirmSectionDelete()}
                    >
                      {deleting() ? "Deleting…" : "Delete"}
                    </Button>
                  </div>
                </AlertDialog.Content>
              </AlertDialog.Overlay>
            </AlertDialog.Portal>
          )}
        </Show>
      </AlertDialog.Root>
    </>
  );
}

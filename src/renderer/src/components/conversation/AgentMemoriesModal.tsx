import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AgentMemory } from "@openbot/contracts/ipc";
import { createEffect, createSignal, For, onSettled, Show } from "solid-js";
import { desktopAnalytics } from "../../analytics";
import { createScrollFades } from "../createScrollFades";
import { Button, Dialog, IconButton, Plus, Textarea, Trash2, X } from "../ui";

interface AgentMemoriesModalProps {
  agentId: string;
  agentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCountChange: (count: number) => void;
}

export function AgentMemoriesModal(props: AgentMemoriesModalProps) {
  const [memories, setMemories] = createSignal<AgentMemory[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [addOpen, setAddOpen] = createSignal(false);
  const [newText, setNewText] = createSignal("");
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editingText, setEditingText] = createSignal("");
  const [savingId, setSavingId] = createSignal<string | null>(null);
  const [clearConfirmation, setClearConfirmation] = createSignal(false);
  const scrollFades = createScrollFades();
  let modalContent: HTMLDivElement | undefined;
  let newMemoryInput: HTMLTextAreaElement | undefined;
  let editingInput: HTMLTextAreaElement | undefined;
  let confirmationTrigger: HTMLButtonElement | undefined;

  onSettled(() => scrollFades.stop);

  async function loadMemories(showLoading = true): Promise<void> {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const next = await window.openbot.agent.listMemories(props.agentId);
      setMemories(next);
      props.onCountChange(next.length);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load memories.");
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  createEffect(
    () => [props.open, props.agentId] as const,
    ([open]) => {
      if (!open) return;
      setEditingId(null);
      setAddOpen(false);
      setNewText("");
      setClearConfirmation(false);
      void loadMemories();
    },
  );

  createEffect(
    () => [props.open, props.agentId] as const,
    ([open, agentId]) => {
      if (!open) return;
      return window.openbot.agent.onEvent((event) => {
        if (event.type !== "memories-changed" || event.agentId !== agentId) return;
        void loadMemories(false);
      });
    },
  );

  async function createMemory(): Promise<void> {
    const text = newText().trim();
    if (!text || memories().length >= INPUT_LIMITS.agentMemories) return;
    const analytics = desktopAnalytics.scope();
    let operationSucceeded = false;
    setSavingId("new");
    setError(null);
    try {
      await window.openbot.agent.createMemory({ agentId: props.agentId, text });
      analytics.track("memory_action", { action: "create", result: "succeeded" });
      operationSucceeded = true;
      setNewText("");
      setAddOpen(false);
      await loadMemories(false);
    } catch (caught) {
      if (!operationSucceeded) {
        analytics.track("memory_action", { action: "create", result: "failed", failure_code: "create_failed" });
      }
      setError(caught instanceof Error ? caught.message : "Could not save the memory.");
    } finally {
      setSavingId(null);
    }
  }

  function startEditing(memory: AgentMemory): void {
    if (savingId()) return;
    setEditingId(memory.id);
    setEditingText(memory.text);
    setAddOpen(false);
    setError(null);
    queueMicrotask(() => {
      editingInput?.focus();
      editingInput?.setSelectionRange(memory.text.length, memory.text.length);
    });
  }

  function openAddComposer(): void {
    setEditingId(null);
    setAddOpen(true);
    setError(null);
    queueMicrotask(() => newMemoryInput?.focus());
  }

  function cancelAddComposer(): void {
    setAddOpen(false);
    setNewText("");
  }

  async function updateMemory(memory: AgentMemory): Promise<void> {
    const text = editingText().trim();
    if (!text) return;
    if (text === memory.text) {
      setEditingId(null);
      return;
    }
    const analytics = desktopAnalytics.scope();
    let operationSucceeded = false;
    setSavingId(memory.id);
    setError(null);
    try {
      await window.openbot.agent.updateMemory({ agentId: props.agentId, memoryId: memory.id, text });
      analytics.track("memory_action", { action: "update", result: "succeeded" });
      operationSucceeded = true;
      setEditingId(null);
      await loadMemories(false);
    } catch (caught) {
      if (!operationSucceeded) {
        analytics.track("memory_action", { action: "update", result: "failed", failure_code: "update_failed" });
      }
      setError(caught instanceof Error ? caught.message : "Could not update the memory.");
    } finally {
      setSavingId(null);
    }
  }

  async function deleteMemory(memory: AgentMemory): Promise<void> {
    const analytics = desktopAnalytics.scope();
    let operationSucceeded = false;
    setSavingId(memory.id);
    setError(null);
    try {
      await window.openbot.agent.deleteMemory({ agentId: props.agentId, memoryId: memory.id });
      analytics.track("memory_action", { action: "delete", result: "succeeded" });
      operationSucceeded = true;
      if (editingId() === memory.id) setEditingId(null);
      await loadMemories(false);
    } catch (caught) {
      if (!operationSucceeded) {
        analytics.track("memory_action", { action: "delete", result: "failed", failure_code: "delete_failed" });
      }
      setError(caught instanceof Error ? caught.message : "Could not delete the memory.");
    } finally {
      setSavingId(null);
    }
  }

  async function clearMemories(): Promise<void> {
    const analytics = desktopAnalytics.scope();
    let operationSucceeded = false;
    setSavingId("clear");
    setError(null);
    try {
      await window.openbot.agent.clearMemories(props.agentId);
      analytics.track("memory_action", { action: "clear", result: "succeeded" });
      operationSucceeded = true;
      setClearConfirmation(false);
      setEditingId(null);
      await loadMemories(false);
    } catch (caught) {
      if (!operationSucceeded) {
        analytics.track("memory_action", { action: "clear", result: "failed", failure_code: "clear_failed" });
      }
      setError(caught instanceof Error ? caught.message : "Could not clear the memories.");
    } finally {
      setSavingId(null);
    }
  }

  function cancelConfirmation(): void {
    setClearConfirmation(false);
    queueMicrotask(() => confirmationTrigger?.focus());
  }

  return (
    <>
      <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay class="agent-memories-overlay" />
          <Dialog.Content
            ref={(element) => (modalContent = element)}
            class="agent-memories-modal"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              modalContent?.focus({ preventScroll: true });
            }}
          >
            <header class="agent-memories-header">
              <div class="agent-memories-heading">
                <Dialog.Title>Memories</Dialog.Title>
                <Dialog.Description class="sr-only">Saved memories for {props.agentName}</Dialog.Description>
              </div>
              <div class="agent-memories-header-actions">
                <IconButton
                  label="Add memory"
                  class="agent-memories-add-button"
                  variant="ghost"
                  disabled={loading() || memories().length >= INPUT_LIMITS.agentMemories}
                  onClick={openAddComposer}
                >
                  <Plus />
                </IconButton>
                <IconButton label="Close memories" variant="ghost" onClick={() => props.onOpenChange(false)}>
                  <X />
                </IconButton>
              </div>
            </header>

            <div class="agent-memories-body">
              <Show when={addOpen()}>
                <section class="agent-memory-composer" aria-label="Add memory">
                  <Textarea
                    ref={(element) => (newMemoryInput = element)}
                    class="agent-memory-input"
                    rows="2"
                    maxlength={INPUT_LIMITS.agentMemoryText}
                    value={newText()}
                    placeholder="Add a durable fact or preference"
                    aria-label="New memory"
                    onValueChange={setNewText}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelAddComposer();
                      }
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void createMemory();
                      }
                    }}
                  />
                  <div class="agent-memory-composer-actions">
                    <Button size="sm" variant="ghost" onClick={cancelAddComposer}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="default"
                      disabled={!newText().trim()}
                      loading={savingId() === "new"}
                      onClick={() => void createMemory()}
                    >
                      Save memory
                    </Button>
                  </div>
                </section>
              </Show>

              <Show when={memories().length >= INPUT_LIMITS.agentMemories}>
                <p class="agent-memory-limit" role="status">
                  This agent has reached the limit of {INPUT_LIMITS.agentMemories} memories. Edit, merge, or delete a
                  memory before you add another one.
                </p>
              </Show>
              <Show when={!clearConfirmation() ? error() : null}>
                {(message) => (
                  <p class="agent-memory-error" role="alert">
                    {message()}
                  </p>
                )}
              </Show>

              <Show when={!loading()} fallback={<p class="agent-memory-state">Loading memories…</p>}>
                <Show
                  when={memories().length > 0}
                  fallback={<p class="agent-memory-state">This agent has no saved memories yet.</p>}
                >
                  <ul
                    ref={scrollFades.bind}
                    class={["agent-memory-list", scrollFades.classes()]}
                    onScroll={scrollFades.measure}
                  >
                    <For each={memories()}>
                      {(memory) => (
                        <li class="agent-memory-row">
                          <Show
                            when={editingId() === memory.id}
                            fallback={
                              <>
                                <Button
                                  type="button"
                                  class="agent-memory-row-main"
                                  variant="ghost"
                                  aria-label={`Edit memory: ${memory.text}`}
                                  onClick={() => startEditing(memory)}
                                >
                                  <span class="agent-memory-text">{memory.text}</span>
                                  <span class="agent-memory-meta">
                                    {memory.origin === "automatic" ? "Learned automatically" : "Added manually"}
                                    {" · "}
                                    {formatMemoryDate(memory.updatedAt)}
                                  </span>
                                </Button>
                                <IconButton
                                  label="Delete memory"
                                  class="agent-memory-delete-button"
                                  variant="destructive-ghost"
                                  disabled={savingId() === memory.id}
                                  onClick={() => void deleteMemory(memory)}
                                >
                                  <Trash2 />
                                </IconButton>
                              </>
                            }
                          >
                            <div class="agent-memory-editor">
                              <Textarea
                                ref={(element) => (editingInput = element)}
                                class="agent-memory-input"
                                rows="2"
                                maxlength={INPUT_LIMITS.agentMemoryText}
                                value={editingText()}
                                aria-label="Edit memory"
                                onValueChange={setEditingText}
                                onKeyDown={(event) => {
                                  if (event.key !== "Escape") return;
                                  event.preventDefault();
                                  event.stopPropagation();
                                  setEditingId(null);
                                }}
                              />
                              <div class="agent-memory-editor-actions">
                                <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                                  Cancel
                                </Button>
                                <Button
                                  size="sm"
                                  variant="default"
                                  disabled={!editingText().trim()}
                                  loading={savingId() === memory.id}
                                  onClick={() => void updateMemory(memory)}
                                >
                                  Save
                                </Button>
                              </div>
                            </div>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </Show>
            </div>
            <Show when={!loading() && memories().length > 0}>
              <footer class="agent-memories-footer">
                <Button
                  ref={(element) => (confirmationTrigger = element)}
                  size="sm"
                  variant="destructive"
                  onClick={() => setClearConfirmation(true)}
                >
                  Clear all memories
                </Button>
              </footer>
            </Show>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={clearConfirmation()}
        onOpenChange={(open) => {
          if (!open && savingId() !== "clear") cancelConfirmation();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay class="agent-memory-confirm-overlay" />
          <Dialog.Content class="agent-memory-confirm-dialog">
            <div class="agent-memory-confirm-content">
              <Dialog.Title>Clear all memories?</Dialog.Title>
              <Dialog.Description>
                OpenBot will permanently remove all {memories().length} saved memories for {props.agentName}. Original
                messages will stay in the conversation history.
              </Dialog.Description>
              <Show when={error()}>
                {(message) => (
                  <p class="agent-memory-error" role="alert">
                    {message()}
                  </p>
                )}
              </Show>
              <div class="agent-memory-confirm-actions">
                <Button variant="ghost" disabled={savingId() === "clear"} onClick={cancelConfirmation}>
                  Cancel
                </Button>
                <Button variant="destructive" loading={savingId() === "clear"} onClick={() => void clearMemories()}>
                  Clear all memories
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function formatMemoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

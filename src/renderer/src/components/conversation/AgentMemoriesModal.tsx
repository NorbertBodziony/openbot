import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { BotMemory } from "@openbot/contracts/ipc";
import { createEffect, createSignal, For, onSettled, Show } from "solid-js";
import { Button, Dialog, IconButton, Plus, Textarea, Trash2, X } from "../ui";

interface AgentMemoriesModalProps {
  botId: string;
  botName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCountChange: (count: number) => void;
}

export function AgentMemoriesModal(props: AgentMemoriesModalProps) {
  const [memories, setMemories] = createSignal<BotMemory[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [addOpen, setAddOpen] = createSignal(false);
  const [newText, setNewText] = createSignal("");
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editingText, setEditingText] = createSignal("");
  const [savingId, setSavingId] = createSignal<string | null>(null);
  const [clearConfirmation, setClearConfirmation] = createSignal(false);
  const [fadeAtTop, setFadeAtTop] = createSignal(false);
  const [fadeAtBottom, setFadeAtBottom] = createSignal(false);
  let modalContent: HTMLDivElement | undefined;
  let memoryList: HTMLUListElement | undefined;
  let memoryListResizeObserver: ResizeObserver | undefined;
  let newMemoryInput: HTMLTextAreaElement | undefined;
  let editingInput: HTMLTextAreaElement | undefined;
  let confirmationTrigger: HTMLButtonElement | undefined;

  function updateScrollFades(): void {
    if (!memoryList) return;
    const remaining = memoryList.scrollHeight - memoryList.scrollTop - memoryList.clientHeight;
    setFadeAtTop(memoryList.scrollTop > 2);
    setFadeAtBottom(remaining > 2);
  }

  function bindMemoryList(element: HTMLUListElement): void {
    memoryList = element;
    memoryListResizeObserver?.disconnect();
    memoryListResizeObserver = new ResizeObserver(updateScrollFades);
    memoryListResizeObserver.observe(element);
    window.requestAnimationFrame(updateScrollFades);
  }

  onSettled(() => () => memoryListResizeObserver?.disconnect());

  async function loadMemories(showLoading = true): Promise<void> {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const next = await window.openbot.agent.listMemories(props.botId);
      setMemories(next);
      props.onCountChange(next.length);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load memories.");
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  createEffect(
    () => [props.open, props.botId] as const,
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
    () => [props.open, props.botId] as const,
    ([open, botId]) => {
      if (!open) return;
      return window.openbot.agent.onEvent((event) => {
        if (event.type !== "memories-changed" || event.botId !== botId) return;
        void loadMemories(false);
      });
    },
  );

  async function createMemory(): Promise<void> {
    const text = newText().trim();
    if (!text || memories().length >= INPUT_LIMITS.agentMemories) return;
    setSavingId("new");
    setError(null);
    try {
      await window.openbot.agent.createMemory({ botId: props.botId, text });
      setNewText("");
      setAddOpen(false);
      await loadMemories(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the memory.");
    } finally {
      setSavingId(null);
    }
  }

  function startEditing(memory: BotMemory): void {
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

  async function updateMemory(memory: BotMemory): Promise<void> {
    const text = editingText().trim();
    if (!text) return;
    if (text === memory.text) {
      setEditingId(null);
      return;
    }
    setSavingId(memory.id);
    setError(null);
    try {
      await window.openbot.agent.updateMemory({ botId: props.botId, memoryId: memory.id, text });
      setEditingId(null);
      await loadMemories(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the memory.");
    } finally {
      setSavingId(null);
    }
  }

  async function deleteMemory(memory: BotMemory): Promise<void> {
    setSavingId(memory.id);
    setError(null);
    try {
      await window.openbot.agent.deleteMemory({ botId: props.botId, memoryId: memory.id });
      if (editingId() === memory.id) setEditingId(null);
      await loadMemories(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the memory.");
    } finally {
      setSavingId(null);
    }
  }

  async function clearMemories(): Promise<void> {
    setSavingId("clear");
    setError(null);
    try {
      await window.openbot.agent.clearMemories(props.botId);
      setClearConfirmation(false);
      setEditingId(null);
      await loadMemories(false);
    } catch (caught) {
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
                <Dialog.Description class="sr-only">Saved memories for {props.botName}</Dialog.Description>
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
                    ref={bindMemoryList}
                    class={[
                      "agent-memory-list",
                      {
                        "scroll-fade-top": fadeAtTop(),
                        "scroll-fade-bottom": fadeAtBottom(),
                      },
                    ]}
                    onScroll={updateScrollFades}
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
                OpenBot will permanently remove all {memories().length} saved memories for {props.botName}. Original
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

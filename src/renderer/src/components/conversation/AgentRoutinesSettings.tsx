import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { Routine, RoutineRun, RoutineSchedule } from "@openbot/contracts/ipc";
import { createEffect, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import { desktopAnalytics } from "../../analytics";
import { Button, CirclePause, Clock3, Dialog, Input, Plus, Switch, Textarea } from "../ui";
import { BackIcon, SettingsForwardIcon } from "./ConversationIcons";
import { RoutineRunHistory } from "./RoutineRunHistory";
import { RoutineScheduleEditor } from "./RoutineScheduleEditor";
import { defaultRoutineSchedule, routineScheduleSummary } from "./routine-schedule-ui";

export type AgentRoutinesView = "list" | "editor";

export interface RoutineSelectionRequest {
  routineId: string;
  routineName: string;
  nonce: number;
}

type PendingRoutineExit =
  | "list"
  | "close"
  | { kind: "routine-selection"; routine: Routine | null; routineName: string }
  | { kind: "conversation-message"; messageId: string };

interface RoutineDraft {
  id: string | null;
  name: string;
  instruction: string;
  active: boolean;
  schedule: RoutineSchedule;
}

interface AgentRoutinesSettingsProps {
  botId: string;
  onCountChange: (count: number) => void;
  onViewChange?: (view: AgentRoutinesView) => void;
  onBack?: () => void;
  onClose?: () => void;
  selectionRequest?: RoutineSelectionRequest | null;
  onSelectionRequestHandled?: (nonce: number) => void;
  onOpenRun?: (messageId: string) => void;
}

export function AgentRoutinesSettings(props: AgentRoutinesSettingsProps) {
  const [routines, setRoutines] = createSignal<Routine[]>([]);
  const [draft, setDraft] = createSignal<RoutineDraft | null>(null);
  const [runs, setRuns] = createSignal<RoutineRun[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [routinesLoaded, setRoutinesLoaded] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [testing, setTesting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [scheduleExpanded, setScheduleExpanded] = createSignal(false);
  const [pendingExit, setPendingExit] = createSignal<PendingRoutineExit | null>(null);
  const [fadeAtTop, setFadeAtTop] = createSignal(false);
  const [fadeAtBottom, setFadeAtBottom] = createSignal(false);
  let routinesBody: HTMLDivElement | undefined;
  let routinesBodyResizeObserver: ResizeObserver | undefined;
  let draftRevision = 0;

  function updateScrollFades(): void {
    if (!routinesBody) return;
    const remaining = routinesBody.scrollHeight - routinesBody.scrollTop - routinesBody.clientHeight;
    setFadeAtTop(routinesBody.scrollTop > 2);
    setFadeAtBottom(remaining > 2);
  }

  function bindRoutinesBody(element: HTMLDivElement): void {
    routinesBody = element;
    routinesBodyResizeObserver?.disconnect();
    routinesBodyResizeObserver = new ResizeObserver(updateScrollFades);
    routinesBodyResizeObserver.observe(element);
    window.requestAnimationFrame(updateScrollFades);
  }

  onCleanup(() => routinesBodyResizeObserver?.disconnect());

  createEffect(
    () => (draft() ? "editor" : "list"),
    (view) => {
      props.onViewChange?.(view);
    },
  );

  async function loadRoutines(): Promise<void> {
    try {
      const next = await window.openbot.agent.listRoutines(props.botId);
      setRoutines(next);
      setRoutinesLoaded(true);
      props.onCountChange(next.length);
      const selected = draft();
      if (selected?.id && !next.some((routine) => routine.id === selected.id)) closeEditor();
    } catch (caught) {
      setRoutinesLoaded(false);
      setError(messageForError(caught, "Could not load routines."));
    } finally {
      setLoading(false);
    }
  }

  async function loadRuns(routineId: string): Promise<void> {
    try {
      setRuns(
        await window.openbot.agent.listRoutineRuns({
          botId: props.botId,
          routineId,
          limit: 10,
        }),
      );
    } catch (caught) {
      setError(messageForError(caught, "Could not load run history."));
    }
  }

  onSettled(() => {
    const unsubscribe = window.openbot.agent.onEvent((event) => {
      if (event.type !== "routines-changed" || event.botId !== props.botId) return;
      void loadRoutines();
      const routineId = draft()?.id;
      if (routineId) void loadRuns(routineId);
    });
    return unsubscribe;
  });

  createEffect(
    () => props.botId,
    () => {
      closeEditor();
      setLoading(true);
      setRoutinesLoaded(false);
      void loadRoutines();
    },
  );

  let lastSelectionRequestNonce: number | undefined;
  createEffect(
    () => ({
      request: props.selectionRequest,
      loading: loading(),
      loaded: routinesLoaded(),
      routines: routines(),
    }),
    ({ request, loading: isLoading, loaded, routines: currentRoutines }) => {
      if (!request || isLoading || request.nonce === lastSelectionRequestNonce) return;
      lastSelectionRequestNonce = request.nonce;
      props.onSelectionRequestHandled?.(request.nonce);
      if (!loaded) return;
      requestRoutineSelection(request, currentRoutines.find((routine) => routine.id === request.routineId) ?? null);
    },
  );

  createEffect(
    () => [draft(), routines().length, runs().length, loading(), scheduleExpanded(), confirmDelete(), error()] as const,
    () => {
      window.requestAnimationFrame(updateScrollFades);
    },
  );

  function openRoutine(routine: Routine): void {
    setConfirmDelete(false);
    setScheduleExpanded(false);
    setError(null);
    draftRevision = 0;
    setDirty(false);
    setDraft({
      id: routine.id,
      name: routine.name,
      instruction: routine.instruction,
      active: routine.active,
      schedule: structuredClone(routine.trigger.schedule),
    });
    void loadRuns(routine.id);
  }

  function createDraft(): void {
    setConfirmDelete(false);
    setScheduleExpanded(false);
    setRuns([]);
    setError(null);
    draftRevision = 0;
    setDirty(false);
    setDraft({
      id: null,
      name: "",
      instruction: "",
      active: true,
      schedule: defaultRoutineSchedule("daily"),
    });
  }

  function closeEditor(): void {
    setDraft(null);
    setRuns([]);
    setError(null);
    draftRevision = 0;
    setDirty(false);
    setConfirmDelete(false);
    setScheduleExpanded(false);
    setPendingExit(null);
  }

  function requestRoutineSelection(request: RoutineSelectionRequest, routine: Routine | null): void {
    const current = draft();
    if (routine && current?.id === routine.id) {
      if (!dirty()) openRoutine(routine);
      return;
    }
    const target: PendingRoutineExit = {
      kind: "routine-selection",
      routine,
      routineName: request.routineName,
    };
    if (current && dirty() && !isBlankNewDraft(current)) {
      setPendingExit(target);
      return;
    }
    performExit(target);
  }

  function requestExit(target: PendingRoutineExit): void {
    if (saving()) return;
    const current = draft();
    if (current && dirty() && !isBlankNewDraft(current)) {
      setPendingExit(target);
      return;
    }
    performExit(target);
  }

  function requestOpenRun(messageId: string): void {
    requestExit({ kind: "conversation-message", messageId });
  }

  function performExit(target: PendingRoutineExit): void {
    setPendingExit(null);
    if (target === "list") {
      closeEditor();
      return;
    }
    if (target === "close") {
      props.onClose?.();
      return;
    }
    if (target.kind === "conversation-message") {
      props.onOpenRun?.(target.messageId);
      return;
    }
    closeEditor();
    if (target.routine) {
      openRoutine(target.routine);
      return;
    }
    setError(`Routine "${target.routineName}" no longer exists.`);
  }

  function discardChanges(): void {
    const target = pendingExit();
    if (target) performExit(target);
  }

  function changeDraft(change: (current: RoutineDraft) => RoutineDraft): void {
    setDraft((current) => (current ? change(current) : current));
    draftRevision += 1;
    setDirty(true);
  }

  async function saveDraft(): Promise<void> {
    const current = draft();
    if (!current || !dirty() || !validDraft(current) || saving()) return;
    const savingRevision = draftRevision;
    setSaving(true);
    setError(null);
    const startedAt = performance.now();
    const action = current.id ? "update" : "create";
    try {
      const saved = current.id
        ? await window.openbot.agent.updateRoutine({
            botId: props.botId,
            routineId: current.id,
            name: current.name.trim(),
            instruction: current.instruction.trim(),
            active: current.active,
            schedule: current.schedule,
          })
        : await window.openbot.agent.createRoutine({
            botId: props.botId,
            name: current.name.trim(),
            instruction: current.instruction.trim(),
            active: current.active,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            schedule: current.schedule,
          });
      setRoutines((items) => {
        const next = [saved, ...items.filter((routine) => routine.id !== saved.id)];
        props.onCountChange(next.length);
        return next;
      });
      setDraft((latest) => (latest && latest.id === current.id ? { ...latest, id: saved.id } : latest));
      if (draftRevision === savingRevision) setDirty(false);
      if (!current.id) void loadRuns(saved.id);
      trackRoutineAction(action, current.schedule, startedAt, "succeeded");
    } catch (caught) {
      trackRoutineAction(action, current.schedule, startedAt, "failed");
      setError(messageForError(caught, "Could not save this routine."));
    } finally {
      setSaving(false);
    }
  }

  async function deleteRoutine(): Promise<void> {
    const current = draft();
    if (!current?.id) {
      closeEditor();
      return;
    }
    const startedAt = performance.now();
    try {
      await window.openbot.agent.deleteRoutine({
        botId: props.botId,
        routineId: current.id,
      });
      setRoutines((items) => {
        const next = items.filter((routine) => routine.id !== current.id);
        props.onCountChange(next.length);
        return next;
      });
      closeEditor();
      trackRoutineAction("delete", current.schedule, startedAt, "succeeded");
    } catch (caught) {
      trackRoutineAction("delete", current.schedule, startedAt, "failed");
      setError(messageForError(caught, "Could not delete this routine."));
    }
  }

  async function testRun(): Promise<void> {
    const current = draft();
    if (!current?.id || testing()) return;
    setTesting(true);
    setError(null);
    const startedAt = performance.now();
    try {
      await window.openbot.agent.testRoutine({
        botId: props.botId,
        routineId: current.id,
      });
      await loadRuns(current.id);
      trackRoutineAction("test", current.schedule, startedAt, "succeeded");
    } catch (caught) {
      trackRoutineAction("test", current.schedule, startedAt, "failed");
      setError(messageForError(caught, "Could not start the test run."));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div class="agent-routines-settings">
      <header class="agent-settings-header agent-routines-header">
        <Button
          variant="ghost"
          type="button"
          class="agent-settings-nav-button"
          aria-label={draft() ? "Back to Routines" : "Back to settings"}
          disabled={Boolean(draft() && saving())}
          onClick={() => (draft() ? requestExit("list") : props.onBack?.())}
        >
          <BackIcon />
        </Button>
        <div class="agent-routines-heading">
          <h2>{draft() ? "Routine" : "Routines"}</h2>
        </div>
        <Show
          when={!draft()}
          fallback={
            <Button
              variant="ghost"
              type="button"
              class="agent-settings-nav-button"
              aria-label="Close details"
              disabled={saving()}
              onClick={() => requestExit("close")}
            >
              <SettingsForwardIcon />
            </Button>
          }
        >
          <Button
            variant="ghost"
            type="button"
            class="agent-settings-nav-button"
            aria-label="Create Routine"
            onClick={createDraft}
          >
            <Plus aria-hidden="true" />
          </Button>
        </Show>
      </header>
      <div
        ref={bindRoutinesBody}
        class={[
          "agent-routines-body",
          {
            "scroll-fade-top": fadeAtTop(),
            "scroll-fade-bottom": fadeAtBottom(),
          },
        ]}
        onScroll={updateScrollFades}
      >
        <Show
          when={draft()}
          fallback={
            <div class="agent-routines-list-view">
              <Show when={!loading()} fallback={<p class="agent-routines-empty">Loading routines…</p>}>
                <Show when={routines().length > 0} fallback={<p class="agent-routines-empty">No routines yet.</p>}>
                  <div class="agent-routines-list">
                    <For each={routines()}>
                      {(routine) => (
                        <Button
                          variant="ghost"
                          type="button"
                          class="agent-routine-row"
                          onClick={() => openRoutine(routine)}
                        >
                          <span
                            class={
                              routine.active ? "agent-routine-status-icon-active" : "agent-routine-status-icon-paused"
                            }
                          >
                            <Show when={routine.active} fallback={<CirclePause aria-hidden="true" />}>
                              <Clock3 aria-hidden="true" />
                            </Show>
                          </span>
                          <span>
                            <strong>{routine.name}</strong>
                            <small>
                              {routine.active ? routineScheduleSummary(routine.trigger.schedule) : "Paused"}
                            </small>
                          </span>
                        </Button>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </div>
          }
        >
          {(current) => (
            <div class="agent-routine-editor">
              <div class="agent-routine-editor-actions">
                <div class="agent-routine-active-toggle">
                  <Switch
                    id="routine-active"
                    aria-label="Routine active"
                    checked={current().active}
                    onChange={(active) => changeDraft((value) => ({ ...value, active }))}
                  />
                  <label for="routine-active">{current().active ? "Active" : "Paused"}</label>
                </div>
                <div class="agent-routine-action-buttons">
                  <Show
                    when={!confirmDelete()}
                    fallback={
                      <>
                        <Button variant="destructive" type="button" size="sm" onClick={() => void deleteRoutine()}>
                          Delete now
                        </Button>
                        <Button variant="secondary" type="button" size="sm" onClick={() => setConfirmDelete(false)}>
                          Cancel
                        </Button>
                      </>
                    }
                  >
                    <Button variant="destructive" type="button" size="sm" onClick={() => setConfirmDelete(true)}>
                      Delete
                    </Button>
                    <Show
                      when={dirty()}
                      fallback={
                        <Button
                          type="button"
                          size="sm"
                          class="agent-routine-test"
                          disabled={!current().id || testing() || !validDraft(current())}
                          loading={testing()}
                          loadingLabel="Starting…"
                          onClick={() => void testRun()}
                        >
                          Test run
                        </Button>
                      }
                    >
                      <Button
                        type="button"
                        size="sm"
                        disabled={saving() || !validDraft(current())}
                        loading={saving()}
                        loadingLabel="Saving…"
                        onClick={() => void saveDraft()}
                      >
                        Save
                      </Button>
                    </Show>
                  </Show>
                </div>
              </div>

              <label class="agent-settings-field">
                <span>Name</span>
                <Input
                  value={current().name}
                  placeholder="Morning brief"
                  maxlength={INPUT_LIMITS.routineName}
                  onValueChange={(name) => changeDraft((value) => ({ ...value, name }))}
                />
              </label>
              <label class="agent-settings-field agent-routine-instruction-field">
                <span>Instruction</span>
                <Textarea
                  value={current().instruction}
                  placeholder="Describe what this agent should do."
                  maxlength={INPUT_LIMITS.routineInstruction}
                  onValueChange={(instruction) => changeDraft((value) => ({ ...value, instruction }))}
                />
              </label>

              <RoutineScheduleEditor
                schedule={current().schedule}
                expanded={scheduleExpanded()}
                onExpandedChange={setScheduleExpanded}
                onChange={(schedule) => changeDraft((value) => ({ ...value, schedule }))}
              />

              <RoutineRunHistory runs={runs()} onOpenRun={props.onOpenRun ? requestOpenRun : undefined} />
            </div>
          )}
        </Show>
        <Show when={error()}>
          {(message) => (
            <p class="agent-settings-save-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
      </div>
      <Dialog.Root
        open={pendingExit() !== null}
        onOpenChange={(open) => {
          if (!open) setPendingExit(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay class="agent-memory-confirm-overlay" />
          <Dialog.Content class="agent-memory-confirm-dialog">
            <div class="agent-memory-confirm-content">
              <Dialog.Title>Discard changes?</Dialog.Title>
              <Dialog.Description>Your unsaved changes to this routine will be lost.</Dialog.Description>
              <div class="agent-memory-confirm-actions">
                <Button variant="ghost" type="button" onClick={() => setPendingExit(null)}>
                  Keep editing
                </Button>
                <Button variant="destructive" type="button" onClick={discardChanges}>
                  Discard changes
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function validDraft(draft: RoutineDraft): boolean {
  return Boolean(draft.name.trim() && draft.instruction.trim());
}

function isBlankNewDraft(draft: RoutineDraft): boolean {
  return draft.id === null && !draft.name.trim() && !draft.instruction.trim();
}
function messageForError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function trackRoutineAction(
  action: "create" | "update" | "delete" | "test",
  schedule: RoutineSchedule,
  startedAt: number,
  result: "succeeded" | "failed",
): void {
  desktopAnalytics.track("routine_action", {
    action,
    trigger_type: schedule.kind,
    delay_ms: Math.max(0, Math.round(performance.now() - startedAt)),
    result,
  });
}

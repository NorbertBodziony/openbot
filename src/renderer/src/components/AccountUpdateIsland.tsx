import type { UpdateStatus } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { Button, Download, RefreshCw, Spinner } from "./ui";

interface AccountUpdateIslandProps {
  updateStatus: UpdateStatus;
  errorMessage?: string | null;
  onUpdateAction: () => Promise<void>;
}

interface UpdateProgressValueProps {
  active: boolean;
  value: number;
}

const VISIBLE_UPDATE_PHASES = new Set<UpdateStatus["phase"]>([
  "available",
  "downloading",
  "preparing",
  "ready",
  "installing",
]);

function UpdateProgressValue(props: UpdateProgressValueProps) {
  let digitGroup: HTMLSpanElement | undefined;
  const characters = () => `${props.value}`.split("");

  createEffect(
    () => ({ active: props.active, value: props.value }),
    ({ active }) => {
      if (!active || !digitGroup) return;

      digitGroup.classList.remove("is-animating");
      void digitGroup.offsetHeight;
      digitGroup.classList.add("is-animating");
    },
  );

  return (
    <span class="account-update-island__progress-value">
      <span ref={digitGroup} class="account-update-island__progress-digits t-digit-group">
        <For each={characters()}>
          {(character, index) => {
            const stagger = () => {
              if (index() === characters().length - 2) return "1";
              if (index() === characters().length - 1) return "2";
              return undefined;
            };
            return (
              <span class="t-digit" data-stagger={stagger()}>
                {character}
              </span>
            );
          }}
        </For>
      </span>
      <span class="account-update-island__progress-suffix">%</span>
    </span>
  );
}

export function AccountUpdateIsland(props: AccountUpdateIslandProps) {
  const [actionPending, setActionPending] = createSignal(false);
  const phase = () => props.updateStatus.phase;
  const errorMessage = createMemo(() => {
    const message = props.errorMessage?.trim() || props.updateStatus.message?.trim();
    return message || "Update failed. Try again.";
  });
  const failed = createMemo(() => Boolean(props.errorMessage) || phase() === "error");
  const open = createMemo(() => failed() || VISIBLE_UPDATE_PHASES.has(phase()));
  const downloading = createMemo(() => phase() === "downloading");
  const busy = createMemo(() => actionPending() || ["downloading", "preparing", "installing"].includes(phase()));
  const ready = createMemo(() => !failed() && (phase() === "ready" || phase() === "installing"));
  const progress = createMemo(() => {
    const value = props.updateStatus.progress;
    return value === null ? null : Math.min(100, Math.max(0, Math.round(value)));
  });
  const actionLabel = createMemo(() => (failed() ? "Retry" : ready() ? "Restart" : "Download"));
  const busyLabel = createMemo(() => {
    if (actionPending() && failed()) return "Retrying";
    if (downloading() && progress() !== null) return null;
    if (phase() === "preparing") return "Preparing";
    if (phase() === "installing" || (actionPending() && ready())) return "Restarting";
    return "Starting";
  });
  const accessibleActionLabel = createMemo(() => {
    if (actionPending() && failed()) return "Retrying update";
    if (downloading() && progress() !== null) return `Downloading update, ${progress()}%`;
    if (phase() === "preparing") return "Preparing update";
    if (phase() === "installing" || (actionPending() && ready())) return "Restarting to update";
    if (failed()) return `Retry update. ${errorMessage()}`;
    return `${ready() ? "Restart to update" : "Download update"}. ${
      ready() ? "Update ready" : "New update available"
    }.`;
  });

  createEffect(
    () => phase(),
    () => {
      setActionPending(false);
    },
  );

  async function runUpdateAction(): Promise<void> {
    if (!open() || busy()) return;
    setActionPending(true);
    try {
      await props.onUpdateAction();
    } finally {
      setActionPending(false);
    }
  }

  return (
    <div
      class="account-update-island t-panel-slide"
      data-open={open() ? "true" : "false"}
      data-phase={phase()}
      aria-hidden={open() ? undefined : "true"}
      inert={open() ? undefined : true}
    >
      <div
        class="account-update-island__copy t-update-text-swap"
        data-state={failed() ? "error" : ready() ? "ready" : "available"}
        role="status"
        aria-live="polite"
      >
        <strong data-text="available" aria-hidden={ready() || failed() ? "true" : undefined}>
          New update available
        </strong>
        <strong data-text="ready" aria-hidden={ready() && !failed() ? undefined : "true"}>
          Update ready
        </strong>
        <strong data-text="error" aria-hidden={failed() ? undefined : "true"} title={errorMessage()}>
          {errorMessage()}
        </strong>
      </div>
      <div class="account-update-island__action-shell" data-downloading={busy() ? "true" : "false"}>
        <Button
          type="button"
          size="xs"
          class="account-update-island__action"
          aria-label={accessibleActionLabel()}
          aria-busy={busy() ? "true" : undefined}
          disabled={!open() || busy()}
          onClick={() => void runUpdateAction()}
        >
          <span class="account-update-island__action-content">
            <span class="account-update-island__icon t-icon-swap" data-state={busy() ? "b" : "a"}>
              <span class="t-icon" data-icon="a" aria-hidden="true">
                <Show when={failed() || ready()} fallback={<Download />}>
                  <RefreshCw />
                </Show>
              </span>
              <span class="t-icon" data-icon="b" aria-hidden="true">
                <Spinner size="sm" />
              </span>
            </span>
            <span
              class="account-update-island__action-label t-update-text-swap"
              data-state={busy() ? "progress" : "action"}
              aria-hidden="true"
            >
              <span data-text="action">{actionLabel()}</span>
              <span data-text="progress">
                <Show
                  when={downloading() && progress() !== null}
                  fallback={<span class="account-update-island__busy-label">{busyLabel()}</span>}
                >
                  <UpdateProgressValue active={busy()} value={progress() ?? 0} />
                </Show>
              </span>
            </span>
          </span>
        </Button>
        <Show when={downloading() && progress() !== null}>
          <span
            class="sr-only"
            role="progressbar"
            aria-valuenow={progress() ?? 0}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-label="Update download progress"
          />
        </Show>
      </div>
    </div>
  );
}

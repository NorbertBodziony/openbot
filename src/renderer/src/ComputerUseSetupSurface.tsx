import type { MacPermissionId } from "@openbot/contracts/ipc";
import { createSignal, onSettled, Show } from "solid-js";
import { Button, CircleCheck, FolderOpen, GripVertical, Monitor, MousePointer2, TriangleAlert } from "./components/ui";

const PERMISSION_COPY: Record<MacPermissionId, { title: string; icon: typeof Monitor }> = {
  "screen-recording": { title: "Screen Recording", icon: Monitor },
  accessibility: { title: "Accessibility", icon: MousePointer2 },
};

export function ComputerUseSetupSurface() {
  const desktopApi = window.openbot;
  const query = new URLSearchParams(window.location.search);
  const permission: MacPermissionId =
    query.get("permission") === "accessibility" ? "accessibility" : "screen-recording";
  const copy = PERMISSION_COPY[permission];
  const PermissionIcon = copy.icon;
  const [state, setState] = createSignal<Awaited<ReturnType<typeof window.openbot.getComputerUseMacSetupState>> | null>(
    null,
  );
  const [dragging, setDragging] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let disposed = false;
  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };

  onSettled(() => {
    window.addEventListener("keydown", closeOnEscape);
    void desktopApi
      .getComputerUseMacSetupState()
      .then((next) => {
        if (!disposed) setState(next);
      })
      .catch((cause) => {
        if (!disposed) setError(errorMessage(cause, "Computer Use could not be loaded."));
      });
    return () => {
      disposed = true;
      window.removeEventListener("keydown", closeOnEscape);
    };
  });

  async function reveal(): Promise<void> {
    setError(null);
    try {
      await desktopApi.revealComputerUseHelper();
    } catch (cause) {
      setError(errorMessage(cause, "Computer Use could not be shown in Finder."));
    }
  }

  function close(): void {
    void desktopApi.closeComputerUsePermissionSetup();
  }

  return (
    <main class="computer-use-setup-surface">
      <header class="computer-use-setup-header">
        <span class="computer-use-setup-permission-icon" aria-hidden="true">
          <PermissionIcon />
        </span>
        <div>
          <h1>Add Computer Use to {copy.title}</h1>
          <p>Drag this app into the list in System Settings.</p>
        </div>
      </header>

      <Show
        when={state()?.status === "available"}
        fallback={
          <div class="computer-use-setup-unavailable" role={error() ? "alert" : "status"}>
            <TriangleAlert aria-hidden="true" />
            <span>{error() ?? state()?.message ?? "Loading Computer Use…"}</span>
          </div>
        }
      >
        <Button
          type="button"
          variant="ghost"
          class={`computer-use-drag-card${dragging() ? " is-dragging" : ""}`}
          draggable="true"
          aria-label={`Drag ${state()?.helperName ?? "Codex Computer Use"} into System Settings, or press to show it in Finder`}
          onClick={() => void reveal()}
          onDragStart={(event) => {
            event.preventDefault();
            setDragging(true);
            setError(null);
            void desktopApi
              .startComputerUseHelperDrag()
              .catch((cause) => setError(errorMessage(cause, "Computer Use could not be dragged.")))
              .finally(() => setDragging(false));
          }}
          onDragEnd={() => {
            setDragging(false);
          }}
        >
          <span class="computer-use-drag-handle" aria-hidden="true">
            <GripVertical />
          </span>
          <span class="computer-use-drag-icon" aria-hidden="true">
            <Show when={state()?.helperIconDataUrl} fallback={<Monitor />}>
              {(source) => <img src={source()} alt="" />}
            </Show>
          </span>
          <strong>{state()?.helperName}.app</strong>
          <span>Drag to add</span>
        </Button>
      </Show>

      <Show when={error()}>
        <p class="computer-use-setup-error" role="alert">
          {error()}
        </p>
      </Show>

      <footer class="computer-use-setup-footer">
        <p>Can’t drag? Show it in Finder, then use +.</p>
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={state()?.status !== "available"}
            onClick={() => void reveal()}
          >
            <FolderOpen aria-hidden="true" />
            Show in Finder
          </Button>
          <Button type="button" size="sm" onClick={close}>
            <CircleCheck aria-hidden="true" />
            Done
          </Button>
        </div>
      </footer>
    </main>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

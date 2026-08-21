import type { RemoteDesktopSession, ServerSummary } from "@openbot/contracts/ipc";
import { Portal } from "@solidjs/web";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { z } from "zod";
import { Button, NativeSelect } from "./ui";

interface RemoteDesktopWorkspaceProps {
  visible: boolean;
  platform: "darwin" | "win32" | "linux";
  server: ServerSummary;
  session: RemoteDesktopSession | undefined;
  connecting: boolean;
  connectionError: string | null;
  onHide: () => void;
  onDisconnect: () => Promise<void>;
  onRetry: () => Promise<void>;
  onSelectDisplay: (serverId: string, displayId: string) => Promise<void>;
}

type ViewerState = "idle" | "connecting" | "connected" | "error";
const viewerMessageSchema = z.object({
  source: z.literal("openbot-moonlight"),
  type: z.literal("viewer-state"),
  sessionId: z.string().min(1),
  state: z.enum(["connecting", "connected", "error"]),
  transport: z.enum(["p2p", "relay"]).optional(),
  message: z.string().optional(),
});

export function RemoteDesktopWorkspace(props: RemoteDesktopWorkspaceProps) {
  const [viewerState, setViewerState] = createSignal<ViewerState>("idle");
  const [viewerError, setViewerError] = createSignal<string | null>(null);
  const [viewerTransport, setViewerTransport] = createSignal<"p2p" | "relay" | null>(null);
  const [actionBusy, setActionBusy] = createSignal<"retry" | "disconnect" | "display" | null>(null);
  let workspaceElement: HTMLElement | undefined;
  let viewerFrame: HTMLIFrameElement | undefined;
  let activeSessionId = "";

  const viewerSource = createMemo(() => {
    const session = props.session;
    return session ? `${session.viewerUrl}#${session.viewerGrant}` : undefined;
  });
  const effectiveState = createMemo<ViewerState>(() => {
    if (props.connectionError) return "error";
    if (props.connecting) return "connecting";
    return viewerState();
  });
  const transportLabel = createMemo(() => {
    const transport = viewerTransport();
    if (transport === "p2p") return "P2P";
    if (transport === "relay") return "Relay";
    return "Connecting";
  });

  createEffect(
    () => props.visible,
    (visible) => {
      if (!workspaceElement) return;
      workspaceElement.inert = !visible;
      if (visible) requestAnimationFrame(() => workspaceElement?.focus());
    },
  );

  createEffect(
    () => ({ session: props.session, connecting: props.connecting, connectionError: props.connectionError }),
    ({ session, connecting, connectionError }) => {
      if (!session) {
        if (!connecting) {
          activeSessionId = "";
          setViewerState(connectionError ? "error" : "idle");
          setViewerTransport(null);
        }
        return;
      }
      if (session.id !== activeSessionId) {
        activeSessionId = session.id;
        setViewerError(null);
        setViewerState(
          session.phase === "connected" ? "connected" : session.phase === "error" ? "error" : "connecting",
        );
      } else if (session.phase === "connected" || session.phase === "error") {
        setViewerState(session.phase);
      }
      if (session.transport === "p2p" || session.transport === "relay") setViewerTransport(session.transport);
    },
  );

  const receiveViewerState = (event: MessageEvent) => {
    const session = props.session;
    if (!session || event.source !== viewerFrame?.contentWindow || event.origin !== new URL(session.viewerUrl).origin) {
      return;
    }
    const parsed = viewerMessageSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.sessionId !== session.id) return;
    setViewerState(parsed.data.state);
    if (parsed.data.transport) setViewerTransport(parsed.data.transport);
    setViewerError(parsed.data.state === "error" ? (parsed.data.message ?? "Remote control failed.") : null);
  };
  window.addEventListener("message", receiveViewerState);
  onCleanup(() => window.removeEventListener("message", receiveViewerState));

  async function retry() {
    if (actionBusy()) return;
    setActionBusy("retry");
    setViewerError(null);
    setViewerState("connecting");
    try {
      await props.onRetry();
    } catch (error) {
      setViewerState("error");
      setViewerError(error instanceof Error ? error.message : "Could not start remote control.");
    } finally {
      setActionBusy(null);
    }
  }

  async function disconnect() {
    if (actionBusy()) return;
    setActionBusy("disconnect");
    setViewerError(null);
    try {
      await props.onDisconnect();
    } catch (error) {
      setViewerState("error");
      setViewerError(error instanceof Error ? error.message : "Could not disconnect remote control.");
      setActionBusy(null);
    }
  }

  async function selectDisplay(displayId: string) {
    if (actionBusy()) return;
    setActionBusy("display");
    setViewerState("connecting");
    setViewerError(null);
    try {
      await props.onSelectDisplay(props.server.id, displayId);
    } catch (error) {
      setViewerState("error");
      setViewerError(error instanceof Error ? error.message : "Could not switch the shared monitor.");
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <Portal>
      <main
        ref={(element) => (workspaceElement = element)}
        class={[
          "remote-desktop-workspace",
          `remote-desktop-workspace-${props.platform}`,
          { "remote-desktop-workspace-visible": props.visible },
        ]}
        aria-hidden={props.visible ? undefined : "true"}
        aria-label="Remote control"
        tabindex={-1}
      >
        <header class="window-drag remote-desktop-header">
          <div class="remote-desktop-heading">
            <span class={`remote-desktop-status remote-desktop-status-${effectiveState()}`} aria-hidden="true" />
            <div>
              <strong>Remote control</strong>
              <span>{props.server.name}</span>
            </div>
          </div>

          <div class="remote-desktop-toolbar-status" aria-live="polite">
            <span>{transportLabel()}</span>
            <span aria-hidden="true">·</span>
            <span>Keyboard and pointer enabled</span>
            <span aria-hidden="true">·</span>
            <span>Shared control</span>
          </div>

          <div class="no-drag remote-desktop-actions">
            <Show when={(props.session?.displays.length ?? 0) > 1}>
              <NativeSelect
                class="remote-desktop-display-select"
                aria-label="Remote display"
                value={props.session?.selectedDisplayId ?? ""}
                disabled={actionBusy() !== null}
                onChange={(event) => void selectDisplay(event.currentTarget.value)}
              >
                {props.session?.displays.map((display) => (
                  <option value={display.id}>{display.label}</option>
                ))}
              </NativeSelect>
            </Show>
            <Button type="button" class="remote-desktop-back-button" onClick={props.onHide}>
              <BackIcon />
              Back to OpenBot
            </Button>
            <Button
              type="button"
              class="remote-desktop-disconnect-button"
              disabled={actionBusy() !== null}
              loading={actionBusy() === "disconnect"}
              onClick={() => void disconnect()}
            >
              Disconnect
            </Button>
          </div>
        </header>

        <div class="remote-desktop-stage">
          <Show when={viewerSource()}>
            {(source) => (
              <iframe
                ref={(element) => (viewerFrame = element)}
                class="remote-desktop-viewer"
                title="Sunshine remote desktop"
                src={source()}
                sandbox="allow-scripts allow-forms allow-same-origin allow-pointer-lock"
                allow="fullscreen; keyboard-map"
                onLoad={() => setViewerState("connecting")}
                onError={() => {
                  setViewerState("error");
                  setViewerError("The Moonlight viewer could not load.");
                }}
              />
            )}
          </Show>
          <Show when={props.server.state !== "online"}>
            <DesktopEmptyState title="Host is offline" message="Reconnect to the host before you open its desktop." />
          </Show>
          <Show when={props.server.state === "online" && !props.server.remoteDesktopAvailable}>
            <DesktopEmptyState title="Update required" message="This host requires Sunshine remote control support." />
          </Show>
          <Show when={effectiveState() === "connecting"}>
            <div class="remote-desktop-overlay" role="status">
              <span class="remote-desktop-spinner" />
              <strong>{props.session?.message ?? "Connecting to the host…"}</strong>
              <span>OpenBot is creating a direct P2P connection.</span>
            </div>
          </Show>
          <Show when={effectiveState() === "error" || props.session?.errorCode}>
            <div class="remote-desktop-overlay remote-desktop-error" role="alert">
              <strong>Could not open the desktop</strong>
              <span>{viewerError() ?? props.connectionError ?? props.session?.message}</span>
              <Button type="button" loading={actionBusy() === "retry"} onClick={() => void retry()}>
                Try again
              </Button>
            </div>
          </Show>
        </div>
      </main>
    </Portal>
  );
}

function DesktopEmptyState(props: { title: string; message: string }) {
  return (
    <div class="remote-desktop-overlay">
      <span class="remote-desktop-empty-mark">
        <MonitorIcon />
      </span>
      <strong>{props.title}</strong>
      <span>{props.message}</span>
    </div>
  );
}

function BackIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="m11.5 5-5 5 5 5M7 10h7" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

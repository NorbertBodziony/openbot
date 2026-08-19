import RFB from "@novnc/novnc";
import type { RemoteMacSession, ServerSummary } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { PanelResizer } from "./PanelResizer";

export const REMOTE_DESKTOP_PANEL_STORAGE_KEY = "openbot:remote-desktop-panel-width";
export const REMOTE_DESKTOP_PANEL_DEFAULT = 520;
export const REMOTE_DESKTOP_PANEL_MIN = 320;
export const REMOTE_DESKTOP_PANEL_MAX = 1800;
const CONVERSATION_PANEL_MIN = 96;

interface RemoteMacPanelProps {
  server: ServerSummary | undefined;
  session: RemoteMacSession | undefined;
  width: number;
  maxWidth: () => number;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
  onClose: () => void;
  onConnect: (hostname: string, serverId: string | null) => Promise<void>;
  onDisconnect: (sessionId: string) => Promise<void>;
}

type ViewerState = "idle" | "connecting" | "connected" | "error";

export function RemoteMacPanel(props: RemoteMacPanelProps) {
  const [viewerState, setViewerState] = createSignal<ViewerState>("idle");
  const [viewerError, setViewerError] = createSignal<string | null>(null);
  const [viewOnly, setViewOnly] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  let panelElement: HTMLElement | undefined;
  let viewerElement: HTMLDivElement | undefined;
  let rfb: RFB | undefined;
  let requestedConnectionKey = "";

  const canConnect = createMemo(
    () =>
      props.server?.kind === "remote" &&
      props.server.state === "online" &&
      Boolean(props.server.apiUrl),
  );
  const sessionBusy = () =>
    props.session?.phase === "starting_tunnel" ||
    props.session?.phase === "checking_vnc" ||
    props.session?.phase === "disconnecting";

  createEffect(
    () => ({
      server: props.server,
      session: props.session,
      canConnect: canConnect(),
      sessionBusy: sessionBusy(),
      onConnect: props.onConnect,
    }),
    ({ server, session, canConnect: ready, sessionBusy: connecting, onConnect }) => {
      if (!server || !ready || connecting) return;
      if (session?.phase === "connected" || session?.errorCode) return;
      const key = `${server.id}:${server.apiUrl}`;
      if (requestedConnectionKey === key) return;
      requestedConnectionKey = key;
      void connect(server, onConnect, false, connecting);
    },
  );

  createEffect(
    () => ({
      url: props.session?.websocketUrl,
      sessionId: props.session?.id,
      targetElement: viewerElement,
      readOnly: viewOnly(),
    }),
    ({ url, sessionId, targetElement, readOnly }) => {
      rfb?.disconnect();
      rfb = undefined;
      setViewerError(null);
      if (!url || !targetElement) {
        setViewerState("idle");
        return;
      }

      setViewerState("connecting");
      const client = new RFB(targetElement, url, { shared: true });
      rfb = client;
      client.scaleViewport = true;
      client.resizeSession = false;
      client.focusOnClick = true;
      client.showDotCursor = true;
      const paletteBackground = getComputedStyle(targetElement)
        .getPropertyValue("--openbot-vnc-background")
        .trim();
      if (paletteBackground) client.background = paletteBackground;
      client.qualityLevel = 7;
      client.compressionLevel = 2;
      client.viewOnly = readOnly;

      const handleConnect = () => {
        setViewerState("connected");
        setViewerError(null);
      };
      const handleDisconnect = (event: CustomEvent<{ clean: boolean }>) => {
        if (!event.detail.clean) {
          setViewerState("error");
          setViewerError("The remote desktop connection ended unexpectedly.");
        } else {
          setViewerState("idle");
        }
      };
      const handleCredentials = () => {
        setViewerState("connecting");
        if (!sessionId) {
          setViewerState("error");
          setViewerError("The Remote Desktop session is unavailable.");
          return;
        }
        void window.openbot.remoteMac
          .getCredentials(sessionId)
          .then((credentials) => {
            if (rfb !== client) return;
            if (!credentials) {
              setViewerState("error");
              setViewerError("The host owner must configure Remote Desktop access.");
              return;
            }
            client.sendCredentials(credentials);
          })
          .catch((error) => {
            if (rfb !== client) return;
            setViewerState("error");
            setViewerError(
              error instanceof Error
                ? error.message
                : "OpenBot could not authorize Remote Desktop access.",
            );
          });
      };
      const handleSecurityFailure = (event: CustomEvent<{ reason?: string }>) => {
        setViewerState("error");
        setViewerError(event.detail.reason || "macOS rejected the remote desktop credentials.");
      };
      client.addEventListener("connect", handleConnect);
      client.addEventListener("disconnect", handleDisconnect);
      client.addEventListener("credentialsrequired", handleCredentials);
      client.addEventListener("securityfailure", handleSecurityFailure);

      onCleanup(() => {
        client.removeEventListener("connect", handleConnect);
        client.removeEventListener("disconnect", handleDisconnect);
        client.removeEventListener("credentialsrequired", handleCredentials);
        client.removeEventListener("securityfailure", handleSecurityFailure);
        client.disconnect();
        if (rfb === client) rfb = undefined;
      });
    },
  );

  createEffect(
    () => viewOnly(),
    (readOnly) => {
      if (rfb) rfb.viewOnly = readOnly;
    },
  );

  async function connect(
    server: ServerSummary | undefined,
    onConnect: RemoteMacPanelProps["onConnect"],
    force = false,
    currentlyBusy = busy(),
  ) {
    if (!server?.apiUrl || currentlyBusy) return;
    const hostname = server.vncHostname ?? new URL(server.apiUrl).hostname;
    if (force) requestedConnectionKey = `${server.id}:${server.apiUrl}`;
    setBusy(true);
    setViewerError(null);
    try {
      await onConnect(hostname, server.id);
    } catch (error) {
      setViewerState("error");
      setViewerError(error instanceof Error ? error.message : "Could not connect to this Mac.");
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    const session = props.session;
    if (session) await props.onDisconnect(session.id);
    requestedConnectionKey = "";
    await connect(props.server, props.onConnect, true);
  }

  return (
    <aside
      ref={(element) => (panelElement = element)}
      id="remote-desktop-side-panel"
      class="remote-desktop-panel"
      aria-label="Remote desktop"
      style={`--remote-desktop-panel-width: ${props.width}px`}
    >
      <PanelResizer
        class="right-panel-resizer"
        label="Resize remote desktop panel"
        controls="remote-desktop-side-panel"
        direction="right"
        value={props.width}
        defaultValue={REMOTE_DESKTOP_PANEL_DEFAULT}
        min={REMOTE_DESKTOP_PANEL_MIN}
        max={() =>
          Math.min(
            REMOTE_DESKTOP_PANEL_MAX,
            Math.max(REMOTE_DESKTOP_PANEL_MIN, props.maxWidth() - CONVERSATION_PANEL_MIN),
          )
        }
        onResize={props.onResize}
        onResizeEnd={props.onResizeEnd}
      />
      <header class="remote-desktop-header">
        <div class="remote-desktop-heading">
          <span
            class={`remote-desktop-status remote-desktop-status-${viewerState()}`}
            aria-hidden="true"
          />
          <div>
            <strong>Remote desktop</strong>
            <span>{props.server?.name ?? "No remote host"}</span>
          </div>
        </div>
        <div class="remote-desktop-actions">
          <Show when={viewerState() === "connected"}>
            <button
              type="button"
              class={["remote-desktop-mode", { "remote-desktop-mode-active": !viewOnly() }]}
              aria-label={viewOnly() ? "Enable remote control" : "Use view-only mode"}
              onClick={() => setViewOnly((current) => !current)}
            >
              {viewOnly() ? "View only" : "Control"}
            </button>
            <button
              type="button"
              class="remote-desktop-icon-button"
              aria-label="Enter remote desktop full screen"
              onClick={() => void panelElement?.requestFullscreen()}
            >
              <FullscreenIcon />
            </button>
          </Show>
          <button
            type="button"
            class="remote-desktop-icon-button"
            aria-label="Close remote desktop"
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      <div class="remote-desktop-shared-note">
        <SharedIcon />
        <span>Shared by all agents on this host</span>
      </div>

      <div class="remote-desktop-stage">
        <div class="remote-desktop-viewer" ref={(element) => (viewerElement = element)} />

        <Show when={props.server?.kind !== "remote"}>
          <DesktopEmptyState
            title="Select a remote host"
            message="Remote desktop is available for agents that run on a remote Mac."
          />
        </Show>
        <Show when={props.server?.kind === "remote" && props.server?.state !== "online"}>
          <DesktopEmptyState
            title="Host is offline"
            message="Reconnect to the host before you open its desktop."
          />
        </Show>
        <Show when={sessionBusy() || busy() || viewerState() === "connecting"}>
          <div class="remote-desktop-overlay" role="status">
            <span class="remote-desktop-spinner" />
            <strong>{props.session?.message ?? "Connecting to the Mac…"}</strong>
            <span>The secure tunnel can take a few seconds.</span>
          </div>
        </Show>
        <Show when={props.session?.errorCode || viewerState() === "error"}>
          <div class="remote-desktop-overlay remote-desktop-error" role="alert">
            <strong>Could not open the desktop</strong>
            <span>{viewerError() ?? props.session?.message}</span>
            <button type="button" onClick={() => void retry()}>
              Try again
            </button>
          </div>
        </Show>
        <Show
          when={
            canConnect() &&
            props.session?.phase === "idle" &&
            !props.session.errorCode &&
            viewerState() === "idle"
          }
        >
          <div class="remote-desktop-overlay">
            <span class="remote-desktop-empty-mark">
              <MonitorIcon />
            </span>
            <strong>Desktop disconnected</strong>
            <span>Reconnect when you want to view or control this Mac again.</span>
            <button type="button" onClick={() => void connect(props.server, props.onConnect, true)}>
              Connect
            </button>
          </div>
        </Show>
      </div>

      <footer class="remote-desktop-footer">
        <span>{viewOnly() ? "View only" : "Keyboard and pointer control enabled"}</span>
        <Show when={props.session?.phase === "connected" ? props.session : undefined}>
          {(session) => (
            <button type="button" onClick={() => void props.onDisconnect(session().id)}>
              Disconnect
            </button>
          )}
        </Show>
      </footer>
    </aside>
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

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="m5.5 5.5 9 9m0-9-9 9" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M7.5 4H4v3.5M12.5 4H16v3.5M16 12.5V16h-3.5M7.5 16H4v-3.5" />
    </svg>
  );
}

function SharedIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <circle cx="7" cy="8" r="2.4" />
      <circle cx="13.5" cy="8.5" r="1.8" />
      <path d="M2.8 15c.5-2.3 2-3.5 4.2-3.5s3.8 1.2 4.3 3.5M11.4 12.3c.6-.5 1.3-.8 2.2-.8 1.9 0 3.1 1 3.6 3" />
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

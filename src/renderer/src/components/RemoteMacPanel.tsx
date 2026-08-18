import { createSignal, For, Show } from "solid-js";
import type { RemoteMacSession, ServerSummary } from "../../../shared/ipc";

interface RemoteMacPanelProps {
  server: ServerSummary | undefined;
  sessions: RemoteMacSession[];
  onClose: () => void;
  onConnect: (hostname: string, serverId: string | null) => Promise<void>;
  onDisconnect: (sessionId: string) => Promise<void>;
}

export function RemoteMacPanel(props: RemoteMacPanelProps) {
  const [hostname, setHostname] = createSignal(props.server?.vncHostname ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const visibleSessions = () =>
    props.sessions.filter((session) => !props.server || session.serverId === props.server.id);

  async function connect() {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await props.onConnect(hostname(), props.server?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect to Remote Mac.");
    } finally {
      setBusy(false);
    }
  }

  async function retry(session: RemoteMacSession) {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await props.onDisconnect(session.id);
      await props.onConnect(session.hostname, session.serverId);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not retry the Remote Mac connection.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="remote-dialog-backdrop" role="presentation">
      <section
        class="remote-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-mac-title"
      >
        <header>
          <div>
            <span class="remote-dialog-eyebrow">Screen Sharing</span>
            <h2 id="remote-mac-title">Remote Mac</h2>
          </div>
          <button type="button" aria-label="Close" onClick={props.onClose}>
            ×
          </button>
        </header>
        <p>
          OpenBot creates a local tunnel. Screen Sharing asks for the macOS account and password.
        </p>
        <label class="remote-field">
          <span>Tunnel hostname</span>
          <input
            value={hostname()}
            placeholder="example.trycloudflare.com"
            spellcheck={false}
            onInput={(event) => setHostname(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          class="remote-primary-button"
          disabled={busy()}
          onClick={() => void connect()}
        >
          {busy() ? "Connecting…" : "Connect"}
        </button>
        <Show when={error()}>{(message) => <p class="remote-dialog-error">{message()}</p>}</Show>
        <div class="remote-session-list">
          <For each={visibleSessions()}>
            {(session) => (
              <article>
                <div>
                  <strong>{session.hostname}</strong>
                  <span
                    class={`remote-session-phase remote-session-phase-${session.errorCode ? "error" : session.phase}`}
                  >
                    {session.errorCode ?? session.phase.replaceAll("_", " ")}
                  </span>
                </div>
                <p>{session.message}</p>
                <Show when={session.localPort}>
                  <small>127.0.0.1:{session.localPort}</small>
                </Show>
                <Show when={session.errorCode}>
                  <button
                    type="button"
                    class="remote-secondary-button"
                    disabled={busy()}
                    onClick={() => void retry(session)}
                  >
                    Retry
                  </button>
                </Show>
                <Show when={session.phase !== "idle" && !session.errorCode}>
                  <button
                    type="button"
                    class="remote-secondary-button"
                    onClick={() => void props.onDisconnect(session.id)}
                  >
                    Disconnect
                  </button>
                </Show>
              </article>
            )}
          </For>
        </div>
      </section>
    </div>
  );
}

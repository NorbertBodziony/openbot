import { createSignal, Show } from "solid-js";

interface JoinServerDialogProps {
  inviteUrl: string;
  onClose: () => void;
  onJoin: (input: { inviteUrl: string; username: string; password: string }) => Promise<void>;
}

export function JoinServerDialog(props: JoinServerDialogProps) {
  const [inviteUrl, setInviteUrl] = createSignal(props.inviteUrl);
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function join() {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await props.onJoin({ inviteUrl: inviteUrl(), username: username(), password: password() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not join the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      class="remote-dialog-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.currentTarget === event.target && !busy()) props.onClose();
      }}
    >
      <section class="remote-dialog" role="dialog" aria-modal="true" aria-labelledby="join-title">
        <header>
          <div>
            <span class="remote-dialog-eyebrow">Remote server</span>
            <h2 id="join-title">Join an OpenBot team</h2>
          </div>
          <button type="button" aria-label="Close" onClick={props.onClose}>
            ×
          </button>
        </header>
        <p>Paste the one-time invitation link. Choose a login that you will use on this server.</p>
        <label class="remote-field">
          <span>Invitation link</span>
          <textarea
            value={inviteUrl()}
            onInput={(event) => setInviteUrl(event.currentTarget.value)}
            rows="3"
            spellcheck={false}
          />
        </label>
        <label class="remote-field">
          <span>Username</span>
          <input
            value={username()}
            onInput={(event) => setUsername(event.currentTarget.value)}
            autocomplete="username"
          />
        </label>
        <label class="remote-field">
          <span>Password</span>
          <input
            type="password"
            value={password()}
            onInput={(event) => setPassword(event.currentTarget.value)}
            autocomplete="new-password"
          />
          <small>Use at least 12 characters. OpenBot does not save this password.</small>
        </label>
        <Show when={error()}>{(message) => <p class="remote-dialog-error">{message()}</p>}</Show>
        <footer>
          <button
            type="button"
            class="remote-secondary-button"
            disabled={busy()}
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            class="remote-primary-button"
            disabled={busy()}
            onClick={() => void join()}
          >
            {busy() ? "Joining…" : "Join server"}
          </button>
        </footer>
      </section>
    </div>
  );
}

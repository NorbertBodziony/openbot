import { createSignal, onMount, Show } from "solid-js";

interface FullAccessConsentProps {
  onAccept: () => Promise<void>;
}

export function FullAccessConsent(props: FullAccessConsentProps) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let acceptButton: HTMLButtonElement | undefined;
  onMount(() => acceptButton?.focus());

  async function accept(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await props.onAccept();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "OpenBot could not save your choice.");
      setBusy(false);
    }
  }

  return (
    <main class="full-access-screen">
      <section
        class="full-access-consent"
        role="dialog"
        aria-modal="true"
        aria-labelledby="full-access-title"
        aria-describedby="full-access-description"
      >
        <div class="full-access-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <title>Full access</title>
            <path d="M12 2.8 19 5.7v5.8c0 4.6-2.8 8.1-7 9.7-4.2-1.6-7-5.1-7-9.7V5.7L12 2.8Z" />
            <path d="M9.2 11.8 11 13.6l3.9-4" />
          </svg>
        </div>
        <p class="full-access-eyebrow">Before you begin</p>
        <h1 id="full-access-title">OpenBot agents can control this Mac</h1>
        <p id="full-access-description" class="full-access-intro">
          Agents run locally with full access so they can complete real work. They do not ask for
          OpenBot approval before acting.
        </p>
        <ul>
          <li>Read, create, modify, and delete files your account can access</li>
          <li>Run commands, use the network, and control the embedded browser</li>
          <li>Use Computer Use after you grant the required macOS permissions</li>
        </ul>
        <div class="full-access-note">
          Keep backups and avoid using OpenBot around files or accounts you would not trust an agent
          to change. Codex and installed plugins may still require their own safety hand-offs.
        </div>
        <Show when={error()}>
          <p class="full-access-error" role="alert">
            {error()}
          </p>
        </Show>
        <button
          ref={acceptButton}
          type="button"
          class="full-access-accept"
          disabled={busy()}
          onClick={() => void accept()}
        >
          {busy() ? "Enabling agents…" : "I understand — enable agents"}
        </button>
      </section>
    </main>
  );
}

import { createMemo, createSignal, For, onMount, Show } from "solid-js";

interface FullAccessConsentProps {
  reviewing?: boolean;
  onAccept?: () => Promise<void>;
  onClose?: () => void;
}

const ACCESS_ITEMS = [
  {
    id: "files",
    title: "Files",
    description: "Read, create, change, and delete files available to your account.",
  },
  {
    id: "commands",
    title: "Commands and network",
    description: "Run local commands and connect to internet services.",
  },
  {
    id: "browser",
    title: "Embedded browser",
    description: "Open, read, and control pages in OpenBot.",
  },
  {
    id: "apps",
    title: "Mac apps",
    description: "Control apps after you grant the required macOS permissions.",
  },
] as const;

export function FullAccessConsent(props: FullAccessConsentProps) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [selected, setSelected] = createSignal<Set<string>>(
    new Set(props.reviewing ? ACCESS_ITEMS.map((item) => item.id) : []),
  );
  const allSelected = createMemo(() => ACCESS_ITEMS.every((item) => selected().has(item.id)));
  let firstControl: HTMLInputElement | HTMLButtonElement | undefined;
  onMount(() => firstControl?.focus());

  function toggle(id: string, checked: boolean): void {
    const next = new Set(selected());
    if (checked) next.add(id);
    else next.delete(id);
    setSelected(next);
  }

  async function accept(): Promise<void> {
    if (!props.onAccept || !allSelected()) return;
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
        <p class="full-access-eyebrow">Agent permissions</p>
        <h1 id="full-access-title">Agent access</h1>
        <p id="full-access-description" class="full-access-intro">
          {props.reviewing
            ? "OpenBot agents have the access below."
            : "OpenBot currently uses one full-access mode. Select every item to continue."}
        </p>
        <div class="full-access-options">
          <For each={ACCESS_ITEMS}>
            {(item, index) => (
              <label class="full-access-option">
                <input
                  ref={(element) => {
                    if (index() === 0) firstControl = element;
                  }}
                  type="checkbox"
                  checked={selected().has(item.id)}
                  disabled={props.reviewing || busy()}
                  onChange={(event) => toggle(item.id, event.currentTarget.checked)}
                />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.description}</small>
                </span>
              </label>
            )}
          </For>
        </div>
        <div class="full-access-note">
          Agents do not ask for OpenBot approval before each action. Keep backups. Do not give an
          agent a task near files or accounts that it must not change.
        </div>
        <Show when={error()}>
          <p class="full-access-error" role="alert">
            {error()}
          </p>
        </Show>
        <Show
          when={props.reviewing}
          fallback={
            <button
              type="button"
              class="full-access-accept"
              disabled={busy() || !allSelected()}
              onClick={() => void accept()}
            >
              {busy() ? "Enabling access…" : "Enable access"}
            </button>
          }
        >
          <button
            ref={(element) => (firstControl = element)}
            type="button"
            class="full-access-accept"
            onClick={props.onClose}
          >
            Done
          </button>
        </Show>
      </section>
    </main>
  );
}

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { createSignal, Show, untrack } from "solid-js";
import { Button, Dialog, Field, IconButton, Input, X } from "./ui";

const joinTeamSignalUrl = new URL("../assets/join-team-signal.webp", import.meta.url).href;

interface JoinServerDialogProps {
  inviteUrl: string;
  accountEmail: string;
  onClose: () => void;
  onJoin: (input: { inviteUrl: string }) => Promise<void>;
}

export function JoinServerDialog(props: JoinServerDialogProps) {
  const [inviteUrl, setInviteUrl] = createSignal(untrack(() => props.inviteUrl));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let inviteInput: HTMLInputElement | undefined;

  async function join() {
    const normalizedInviteUrl = inviteUrl().trim();
    if (busy() || !normalizedInviteUrl) return;
    setBusy(true);
    setError(null);
    try {
      await props.onJoin({ inviteUrl: normalizedInviteUrl });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not join the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy() && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="join-server-backdrop">
          <Dialog.Content
            as="section"
            class="join-server-dialog"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              queueMicrotask(() => inviteInput?.focus({ preventScroll: true }));
            }}
          >
            <img class="join-server-artwork" src={joinTeamSignalUrl} alt="" draggable={false} />
            <IconButton
              class="join-server-close"
              label="Close"
              tooltip="Close"
              variant="ghost"
              disabled={busy()}
              onClick={props.onClose}
            >
              <X />
            </IconButton>

            <div class="join-server-content">
              <header class="join-server-header">
                <div class="join-server-heading">
                  <Dialog.Title as="h2">Join an OpenBot team</Dialog.Title>
                  <Dialog.Description>Paste a one-time invite to connect OpenBot to your team.</Dialog.Description>
                </div>
              </header>

              <form
                class="join-server-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void join();
                }}
              >
                <Field label="Invitation link" htmlFor="join-server-invite-url">
                  <Input
                    ref={(element) => (inviteInput = element)}
                    id="join-server-invite-url"
                    class="join-server-link-input"
                    type="text"
                    inputmode="url"
                    autocomplete="off"
                    placeholder="openbot://join?invite=…"
                    value={inviteUrl()}
                    onInput={(event) => {
                      setInviteUrl(event.currentTarget.value);
                      setError(null);
                    }}
                    maxlength={INPUT_LIMITS.inviteUrl}
                    spellcheck={false}
                    disabled={busy()}
                    required
                  />
                </Field>

                <div class="join-server-feedback">
                  <Show when={error()}>
                    {(message) => (
                      <p class="join-server-error" role="alert">
                        {message()}
                      </p>
                    )}
                  </Show>
                </div>

                <p class="join-server-account">
                  Joining as <strong>{props.accountEmail}</strong>
                </p>

                <footer class="join-server-actions">
                  <Button type="button" variant="ghost" size="lg" disabled={busy()} onClick={props.onClose}>
                    Cancel
                  </Button>
                  <Button
                    class="join-server-submit"
                    type="submit"
                    variant="primary"
                    size="lg"
                    fullWidth
                    loading={busy()}
                    loadingLabel="Joining…"
                    disabled={!inviteUrl().trim()}
                  >
                    Join server
                  </Button>
                </footer>
              </form>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { createSignal, Show, untrack } from "solid-js";
import { Button, Dialog, Textarea } from "./ui";

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

  async function join() {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await props.onJoin({ inviteUrl: inviteUrl() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not join the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy() && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="remote-dialog-backdrop">
          <Dialog.Content as="section" class="remote-dialog">
            <header>
              <div>
                <span class="remote-dialog-eyebrow">Remote server</span>
                <Dialog.Title as="h2" id="join-title">
                  Join an OpenBot team
                </Dialog.Title>
              </div>
              <Button type="button" aria-label="Close" disabled={busy()} onClick={props.onClose}>
                ×
              </Button>
            </header>
            <Dialog.Description>
              Paste the one-time invitation link. You will join with your signed-in OpenBot account.
            </Dialog.Description>
            <label class="remote-field">
              <span>Invitation link</span>
              <Textarea
                value={inviteUrl()}
                onInput={(event) => setInviteUrl(event.currentTarget.value)}
                rows="3"
                maxlength={INPUT_LIMITS.inviteUrl}
                spellcheck={false}
              />
            </label>
            <div class="remote-account-chip">
              <span aria-hidden="true">@</span>
              <div>
                <small>Joining as</small>
                <strong>{props.accountEmail}</strong>
              </div>
            </div>
            <Show when={error()}>{(message) => <p class="remote-dialog-error">{message()}</p>}</Show>
            <footer>
              <Button
                type="button"
                class="remote-secondary-button"
                disabled={busy() || !inviteUrl().trim()}
                onClick={props.onClose}
              >
                Cancel
              </Button>
              <Button type="button" class="remote-primary-button" disabled={busy()} onClick={() => void join()}>
                {busy() ? "Joining…" : "Join server"}
              </Button>
            </footer>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

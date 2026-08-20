import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { InvitePreview, JoinServerInput } from "@openbot/contracts/ipc";
import { createSignal, onSettled, Show, untrack } from "solid-js";
import { Button, Dialog, Field, IconButton, Input, X } from "./ui";

const joinTeamSignalUrl = new URL("../assets/join-team-signal.webp", import.meta.url).href;

interface JoinServerDialogProps {
  inviteUrl: string;
  accountEmail: string;
  onClose: () => void;
  onPreview: (input: JoinServerInput) => Promise<InvitePreview>;
  onJoin: (input: JoinServerInput) => Promise<void>;
}

export function JoinServerDialog(props: JoinServerDialogProps) {
  const [inviteUrl, setInviteUrl] = createSignal(untrack(() => props.inviteUrl));
  const [preview, setPreview] = createSignal<InvitePreview | null>(null);
  const [phase, setPhase] = createSignal<"idle" | "previewing" | "joining">("idle");
  const [error, setError] = createSignal<string | null>(null);
  let inviteInput: HTMLInputElement | undefined;

  const busy = () => phase() !== "idle";

  onSettled(() => {
    if (inviteUrl().trim()) void reviewInvite();
  });

  async function reviewInvite(): Promise<void> {
    const normalizedInviteUrl = inviteUrl().trim();
    if (busy() || !normalizedInviteUrl) return;
    setPhase("previewing");
    setError(null);
    try {
      setPreview(await props.onPreview({ inviteUrl: normalizedInviteUrl }));
    } catch (cause) {
      setPreview(null);
      setError(errorMessage(cause, "Could not verify this invitation."));
    } finally {
      setPhase("idle");
    }
  }

  async function join(): Promise<void> {
    const normalizedInviteUrl = inviteUrl().trim();
    if (busy() || !normalizedInviteUrl) return;
    if (!preview()) {
      await reviewInvite();
      return;
    }
    setPhase("joining");
    setError(null);
    try {
      await props.onJoin({ inviteUrl: normalizedInviteUrl });
      setPhase("idle");
    } catch (cause) {
      setError(errorMessage(cause, "Could not join the host."));
      setPhase("idle");
    }
  }

  function resetInvite(): void {
    setPreview(null);
    setError(null);
    queueMicrotask(() => inviteInput?.focus({ preventScroll: true }));
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
              if (!inviteUrl().trim()) queueMicrotask(() => inviteInput?.focus({ preventScroll: true }));
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
                  <Dialog.Description>
                    {preview() ? "Confirm the verified host before you connect." : "Review a one-time invitation."}
                  </Dialog.Description>
                </div>
              </header>

              <form
                class="join-server-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void join();
                }}
              >
                <Show
                  when={preview()}
                  fallback={
                    <Field label="Invitation link" htmlFor="join-server-invite-url">
                      <Input
                        ref={(element) => (inviteInput = element)}
                        id="join-server-invite-url"
                        class="join-server-link-input"
                        type="text"
                        inputmode="url"
                        autocomplete="off"
                        placeholder="https://openbot.run/join?…"
                        value={inviteUrl()}
                        onInput={(event) => {
                          setInviteUrl(event.currentTarget.value);
                          setPreview(null);
                          setError(null);
                        }}
                        maxlength={INPUT_LIMITS.inviteUrl}
                        spellcheck={false}
                        disabled={busy()}
                        required
                      />
                    </Field>
                  }
                >
                  {(item) => <InvitePreviewCard preview={item()} accountEmail={props.accountEmail} />}
                </Show>

                <div class="join-server-feedback">
                  <Show when={error()}>
                    {(message) => (
                      <p class="join-server-error" role="alert">
                        {message()}
                      </p>
                    )}
                  </Show>
                </div>

                <Show when={!preview()}>
                  <p class="join-server-account">
                    Joining as <strong>{props.accountEmail}</strong>
                  </p>
                </Show>

                <footer class="join-server-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="lg"
                    disabled={busy()}
                    onClick={() => (preview() ? resetInvite() : props.onClose())}
                  >
                    {preview() ? "Use another" : "Cancel"}
                  </Button>
                  <Button
                    class="join-server-submit"
                    type="submit"
                    variant="primary"
                    size="lg"
                    fullWidth
                    loading={busy()}
                    loadingLabel={phase() === "joining" ? "Connecting…" : "Checking…"}
                    disabled={!inviteUrl().trim()}
                  >
                    {preview() ? "Connect to host" : "Review invitation"}
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

export function InvitePreviewCard(props: { preview: InvitePreview; accountEmail: string }) {
  return (
    <section class="join-server-preview" aria-label="Verified invitation">
      <div class="join-server-preview-signal" aria-hidden="true">
        <i />
        <span />
      </div>
      <div class="join-server-preview-heading">
        <span class="join-server-verified">Verified host</span>
        <strong>{props.preview.serverName}</strong>
        <small>{props.preview.apiHostname}</small>
      </div>
      <dl>
        <div>
          <dt>Access</dt>
          <dd>{props.preview.role === "admin" ? "Admin" : "Member"}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{formatInviteDate(props.preview.expiresAt)}</dd>
        </div>
        <div>
          <dt>Account</dt>
          <dd>{props.accountEmail}</dd>
        </div>
      </dl>
      <Show when={props.preview.emailBound}>
        <p>This invitation only works for its email recipient.</p>
      </Show>
    </section>
  );
}

function formatInviteDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

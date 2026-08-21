import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { InvitePreview, JoinServerInput } from "@openbot/contracts/ipc";
import { createSignal, onSettled, Show, untrack } from "solid-js";
import { Button, Dialog, Field, IconButton, Input, ShieldCheck, X } from "./ui";

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
              <Show when={!preview()}>
                <header class="join-server-header">
                  <div class="join-server-heading">
                    <Dialog.Title as="h2">Join a server</Dialog.Title>
                    <Dialog.Description>Paste an invite link to continue.</Dialog.Description>
                  </div>
                </header>
              </Show>

              <form
                class="join-server-form"
                data-state={preview() ? "verified" : "empty"}
                onSubmit={(event) => {
                  event.preventDefault();
                  void join();
                }}
              >
                <Show
                  when={preview()}
                  fallback={
                    <Field label="Invite link" htmlFor="join-server-invite-url">
                      <Input
                        ref={(element) => (inviteInput = element)}
                        id="join-server-invite-url"
                        class="join-server-link-input"
                        type="text"
                        inputmode="url"
                        autocomplete="off"
                        placeholder="https://openbot.run/join?…"
                        value={inviteUrl()}
                        onValueChange={(value) => {
                          setInviteUrl(value);
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
                  {(item) => <InvitePreviewCard preview={item()} accountEmail={props.accountEmail} variant="dialog" />}
                </Show>

                <Show when={error()}>
                  {(message) => (
                    <p class="join-server-error" role="alert">
                      {message()}
                    </p>
                  )}
                </Show>

                <Show when={!preview()}>
                  <p class="join-server-account">
                    Joining as <strong>{props.accountEmail}</strong>
                  </p>
                </Show>

                <footer class="join-server-actions">
                  <Show
                    when={preview()}
                    fallback={
                      <>
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
                          loadingLabel="Checking…"
                          disabled={!inviteUrl().trim()}
                        >
                          Review invite
                        </Button>
                      </>
                    }
                  >
                    <Button
                      class="join-server-submit"
                      type="submit"
                      variant="primary"
                      size="lg"
                      fullWidth
                      loading={busy()}
                      loadingLabel="Connecting…"
                    >
                      Connect to host
                    </Button>
                    <Button type="button" variant="link" disabled={busy()} onClick={resetInvite}>
                      Use another invite
                    </Button>
                  </Show>
                </footer>
              </form>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface InvitePreviewCardProps {
  preview: InvitePreview;
  accountEmail: string;
  variant?: "embedded" | "dialog";
}

export function InvitePreviewCard(props: InvitePreviewCardProps) {
  return (
    <Show
      when={props.variant === "dialog"}
      fallback={
        <section class="join-server-preview" data-variant="embedded" aria-label="Verified invitation">
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
      }
    >
      <section class="join-server-dialog-invite" aria-label="Verified invitation">
        <div class="join-server-identity-mark" aria-hidden="true">
          {serverInitials(props.preview.serverName)}
        </div>
        <div class="join-server-identity">
          <Dialog.Title as="h2">{props.preview.serverName}</Dialog.Title>
          <Dialog.Description class="join-server-identity-host">
            <span title={props.preview.apiHostname}>{props.preview.apiHostname}</span>
            <span class="join-server-identity-verified" role="img" aria-label="Verified host" title="Verified host">
              <ShieldCheck aria-hidden="true" />
            </span>
          </Dialog.Description>
        </div>
      </section>
    </Show>
  );
}

function serverInitials(value: string): string {
  return (
    value
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "O"
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

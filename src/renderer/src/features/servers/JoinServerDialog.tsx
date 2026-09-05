import { AppLogo } from "@openbot/brand";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { InvitePreview, JoinServerInput } from "@openbot/contracts/ipc";
import { createSignal, onCleanup, onSettled, Show, untrack } from "solid-js";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Button,
  Dialog,
  Field,
  Heading,
  IconButton,
  Input,
  OctagonX,
  Text,
  X,
} from "../../components/ui";

interface JoinServerDialogProps {
  inviteUrl: string;
  accountEmail: string;
  onClose: () => void;
  onPreview: (input: JoinServerInput) => Promise<InvitePreview>;
  onJoin: (input: JoinServerInput) => Promise<void>;
}

type DialogPhase = "idle" | "previewing" | "joining";

export function JoinServerDialog(props: JoinServerDialogProps) {
  const [inviteUrl, setInviteUrl] = createSignal(untrack(() => props.inviteUrl));
  const [preview, setPreview] = createSignal<InvitePreview | null>(null);
  const [phase, setPhase] = createSignal<DialogPhase>("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [rendered, setRendered] = createSignal(true);
  const [opened, setOpened] = createSignal(false);
  const [closing, setClosing] = createSignal(false);
  const [inputShaking, setInputShaking] = createSignal(false);
  const [joinErrorShaking, setJoinErrorShaking] = createSignal(false);
  let inviteInput: HTMLInputElement | undefined;
  let joinErrorAlert: HTMLDivElement | undefined;
  let openFrame: number | undefined;
  let closeTimer: number | undefined;
  let inputShakeTimer: number | undefined;
  let joinErrorShakeTimer: number | undefined;

  const busy = () => phase() !== "idle" || closing();
  const page = () => (preview() ? "2" : "1");
  const previewError = () => (preview() ? null : error());
  const joinError = () => (preview() ? error() : null);
  const dialogTitle = () => preview()?.serverName ?? "Join a server";
  const dialogDescription = () => {
    const item = preview();
    return item ? `Verified invitation from ${item.apiHostname}.` : "Paste an invite link to continue.";
  };

  onSettled(() => {
    openFrame = window.requestAnimationFrame(() => {
      openFrame = undefined;
      setOpened(true);
    });
    if (inviteUrl().trim()) void reviewInvite();
  });

  onCleanup(() => {
    if (openFrame !== undefined) window.cancelAnimationFrame(openFrame);
    if (closeTimer !== undefined) window.clearTimeout(closeTimer);
    if (inputShakeTimer !== undefined) window.clearTimeout(inputShakeTimer);
    if (joinErrorShakeTimer !== undefined) window.clearTimeout(joinErrorShakeTimer);
  });

  async function reviewInvite(): Promise<void> {
    const normalizedInviteUrl = inviteUrl().trim();
    if (busy() || !normalizedInviteUrl) return;
    clearInputMotion();
    setPhase("previewing");
    setError(null);
    try {
      setPreview(await props.onPreview({ inviteUrl: normalizedInviteUrl }));
    } catch (cause) {
      setPreview(null);
      setError(errorMessage(cause, "Could not verify this invitation."));
      queueMicrotask(showInputError);
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
    clearJoinErrorMotion();
    setPhase("joining");
    setError(null);
    try {
      await props.onJoin({ inviteUrl: normalizedInviteUrl });
      setPhase("idle");
      startClose();
    } catch (cause) {
      setError(errorMessage(cause, "Could not join the host."));
      setPhase("idle");
      queueMicrotask(showJoinError);
    }
  }

  function resetInvite(): void {
    if (busy()) return;
    clearJoinErrorMotion();
    setPreview(null);
    setError(null);
    queueMicrotask(() => inviteInput?.focus({ preventScroll: true }));
  }

  function requestClose(): void {
    if (busy()) return;
    startClose();
  }

  function startClose(): void {
    setClosing(true);
    setOpened(false);
    closeTimer = window.setTimeout(
      () => {
        closeTimer = undefined;
        setClosing(false);
        setRendered(false);
        props.onClose();
      },
      prefersReducedMotion() ? 0 : motionDuration("--modal-close-dur", 150),
    );
  }

  function showInputError(): void {
    if (!inviteInput) return;
    if (inputShakeTimer !== undefined) window.clearTimeout(inputShakeTimer);
    setInputShaking(false);
    void inviteInput.offsetWidth;
    setInputShaking(true);
    inputShakeTimer = window.setTimeout(() => {
      inputShakeTimer = undefined;
      setInputShaking(false);
    }, shakeDuration() + 20);
  }

  function clearInputMotion(): void {
    if (inputShakeTimer !== undefined) window.clearTimeout(inputShakeTimer);
    inputShakeTimer = undefined;
    setInputShaking(false);
  }

  function showJoinError(): void {
    if (!joinErrorAlert) return;
    if (joinErrorShakeTimer !== undefined) window.clearTimeout(joinErrorShakeTimer);
    setJoinErrorShaking(false);
    void joinErrorAlert.offsetWidth;
    setJoinErrorShaking(true);
    joinErrorShakeTimer = window.setTimeout(() => {
      joinErrorShakeTimer = undefined;
      setJoinErrorShaking(false);
    }, shakeDuration() + 20);
  }

  function clearJoinErrorMotion(): void {
    if (joinErrorShakeTimer !== undefined) window.clearTimeout(joinErrorShakeTimer);
    joinErrorShakeTimer = undefined;
    setJoinErrorShaking(false);
  }

  return (
    <Dialog.Root open={rendered()} onOpenChange={(open) => !open && requestClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="join-server-backdrop" data-motion={closing() ? "closing" : "open"}>
          <Dialog.Content
            as="section"
            class={`join-server-dialog t-modal${closing() ? " is-closing" : opened() ? " is-open" : ""}`}
            aria-busy={busy() ? "true" : undefined}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              if (!inviteUrl().trim()) queueMicrotask(() => inviteInput?.focus({ preventScroll: true }));
            }}
          >
            <Dialog.Title class="sr-only">{dialogTitle()}</Dialog.Title>
            <Dialog.Description class="sr-only">{dialogDescription()}</Dialog.Description>

            <IconButton
              class="join-server-close"
              label="Close"
              tooltip="Close"
              variant="ghost"
              disabled={busy()}
              onClick={requestClose}
            >
              <X />
            </IconButton>

            <div class="join-server-content">
              <div
                class="join-server-pages t-page-slide"
                data-page={page()}
                data-preview-error={previewError() ? "" : undefined}
                data-error={joinError() ? "" : undefined}
              >
                <form
                  class="join-server-page t-page"
                  data-page-id="1"
                  aria-hidden={page() === "1" ? undefined : "true"}
                  inert={page() !== "1"}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void reviewInvite();
                  }}
                >
                  <header class="join-server-header join-server-header-entry">
                    <AppLogo variant="production" class="join-server-entry-logo" />
                    <Heading as="h2" size="lg">
                      Join a server
                    </Heading>
                    <Text tone="muted">Paste the invitation you received from a server owner.</Text>
                  </header>

                  <Field
                    class={`join-server-field t-input-wrap${previewError() ? " is-error" : ""}`}
                    label="Invite link"
                    htmlFor="join-server-invite-url"
                    error={previewError() ? <span class="t-error-msg">{previewError()}</span> : undefined}
                  >
                    <Input
                      ref={(element) => (inviteInput = element)}
                      id="join-server-invite-url"
                      class={`join-server-link-input t-input${previewError() ? " is-error" : ""}${inputShaking() ? " is-shaking" : ""}`}
                      type="text"
                      inputmode="url"
                      autocomplete="off"
                      placeholder="https://openbot.run/join?…"
                      value={inviteUrl()}
                      onValueChange={(value) => {
                        clearInputMotion();
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

                  <footer class="join-server-actions">
                    <Button
                      class="join-server-submit"
                      type="submit"
                      variant="default"
                      fullWidth
                      loading={phase() === "previewing"}
                      loadingLabel="Checking…"
                      disabled={!inviteUrl().trim() || busy()}
                    >
                      Review invite
                    </Button>
                    <Button type="button" variant="ghost" disabled={busy()} onClick={requestClose}>
                      Cancel
                    </Button>
                  </footer>
                </form>

                <form
                  class="join-server-page t-page"
                  data-page-id="2"
                  aria-hidden={page() === "2" ? undefined : "true"}
                  inert={page() !== "2"}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void join();
                  }}
                >
                  <Show when={preview()}>
                    {(item) => (
                      <section class="join-server-header join-server-header-verified" aria-label="Verified invitation">
                        <AppLogo variant="production" class="join-server-identity-logo" />
                        <Text class="join-server-invite-eyebrow" tone="secondary">
                          You’ve been invited to join
                        </Text>
                        <Heading as="h2" size="lg">
                          {item().serverName}
                        </Heading>
                        <Text class="join-server-hostname" title={item().apiHostname} tone="muted" truncate>
                          {item().apiHostname}
                        </Text>
                      </section>
                    )}
                  </Show>

                  <Show when={joinError()}>
                    {(message) => (
                      <Alert
                        ref={(element) => (joinErrorAlert = element)}
                        class={`join-server-alert t-input${joinErrorShaking() ? " is-shaking" : ""}`}
                        tone="danger"
                        role="alert"
                      >
                        <AlertIcon>
                          <OctagonX />
                        </AlertIcon>
                        <AlertContent>
                          <AlertTitle>Connection failed</AlertTitle>
                          <AlertDescription>{message()}</AlertDescription>
                        </AlertContent>
                      </Alert>
                    )}
                  </Show>

                  <footer class="join-server-actions join-server-actions-verified">
                    <Button
                      class="join-server-submit"
                      type="submit"
                      variant="default"
                      fullWidth
                      loading={phase() === "joining"}
                      loadingLabel="Connecting…"
                      disabled={busy()}
                    >
                      Connect
                    </Button>
                    <Button type="button" variant="ghost" disabled={busy()} onClick={resetInvite}>
                      Use another invite
                    </Button>
                  </footer>
                </form>
              </div>
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
}

export function InvitePreviewCard(props: InvitePreviewCardProps) {
  return (
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
  );
}

function motionDuration(name: string, fallback: number): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (value.endsWith("ms")) return Number.parseFloat(value) || fallback;
  if (value.endsWith("s")) return (Number.parseFloat(value) || fallback / 1_000) * 1_000;
  return Number.parseFloat(value) || fallback;
}

function shakeDuration(): number {
  return motionDuration("--shake-dur-a", 80) * 2 + motionDuration("--shake-dur-b", 60) * 2;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
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

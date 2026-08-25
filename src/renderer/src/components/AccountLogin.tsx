import { AppLogo } from "@openbot/brand";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AppVariant, CentralAuthIssue, CentralAuthState } from "@openbot/contracts/ipc";
import { normalizeEmailAddress, normalizeOneTimeCode } from "@openbot/contracts/validation";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { OtpInput, type OtpInputStatus } from "./OtpInput";
import { ArrowLeft, Button, Input, RefreshCw } from "./ui";

interface AccountLoginProps {
  variant: AppVariant;
  state: CentralAuthState;
  onRetry: () => Promise<void>;
  onRequestEmailCode: (email: string) => Promise<void>;
  onVerifyEmailCode: (challengeId: string, code: string) => Promise<void>;
  onReset: () => Promise<void>;
}

type PendingAction = "retry" | "send" | "verify" | "resend" | "reset";
type LoginStep = "email" | "code";
type LoginTransition = "none" | "forward" | "back";

const FIELD_ISSUES = new Set([
  "invalid_email",
  "invalid_sign_in_code",
  "sign_in_code_expired",
  "too_many_code_attempts",
]);
const NEW_CODE_ISSUES = new Set(["sign_in_code_expired", "too_many_code_attempts"]);

export function AccountLogin(props: AccountLoginProps) {
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [presentedEmailError, setPresentedEmailError] = createSignal<string | null>(null);
  const [emailErrorActive, setEmailErrorActive] = createSignal(false);
  const [emailShaking, setEmailShaking] = createSignal(false);
  const [codeError, setCodeError] = createSignal<string | null>(null);
  const [localError, setLocalError] = createSignal<string | null>(null);
  const [pendingAction, setPendingAction] = createSignal<PendingAction | null>(null);
  const [issueVisible, setIssueVisible] = createSignal(true);
  const [issueBlockedUntil, setIssueBlockedUntil] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const [loginTransition, setLoginTransition] = createSignal<LoginTransition>("none");
  let emailInput: HTMLInputElement | undefined;
  let emailShakeTimer: number | undefined;
  let emailRevertTimer: number | undefined;
  let emailMessageTimer: number | undefined;

  const clock = window.setInterval(() => setNow(Date.now()), 1_000);
  onCleanup(() => {
    window.clearInterval(clock);
    clearEmailErrorTimers();
  });

  const codeSent = () => props.state.status === "code_sent";
  const verified = () => props.state.status === "signed_in";
  const loginStep = (): LoginStep => (codeSent() || verified() ? "code" : "email");
  const challenge = () => (props.state.status === "code_sent" ? props.state : undefined);
  const connecting = () => props.state.status === "loading";
  const currentIssue = (): CentralAuthIssue | undefined => {
    if (props.state.status === "error") return props.state.issue;
    return props.state.status === "code_sent" ? props.state.issue : undefined;
  };
  const displayedIssue = () => (issueVisible() ? currentIssue() : undefined);
  const unavailable = () => props.state.status === "error" && props.state.issue.code === "auth_api_unavailable";
  const unavailableIssue = () => (unavailable() && props.state.status === "error" ? props.state.issue : undefined);
  const codeExpiresIn = () => (props.state.status === "code_sent" ? secondsUntil(props.state.expiresAt, now()) : 0);
  const codeNeedsReplacement = () => {
    const issue = currentIssue();
    return Boolean(issue && NEW_CODE_ISSUES.has(issue.code)) || (codeSent() && codeExpiresIn() === 0);
  };
  const resendAvailableIn = () => {
    if (props.state.status !== "code_sent") return 0;
    return secondsUntil(Math.max(props.state.resendAvailableAt, issueBlockedUntil()), now());
  };
  const emailRetryIn = () => {
    const issue = currentIssue();
    return issue?.retryAfterSeconds ? secondsUntil(issueBlockedUntil(), now()) : 0;
  };
  const emailBusy = () => pendingAction() === "send" || props.state.status === "signing_in";
  const codeBusy = () => pendingAction() === "verify";
  const resendBusy = () => pendingAction() === "resend";
  const formIssue = createMemo(() => {
    const issue = displayedIssue();
    return issue && !FIELD_ISSUES.has(issue.code) ? issue : undefined;
  });
  const displayedCodeError = () => {
    const visibleIssue = displayedIssue();
    const issue = currentIssue();
    if (codeError()) return codeError();
    if (visibleIssue?.code === "invalid_sign_in_code") return visibleIssue.message;
    return issue && NEW_CODE_ISSUES.has(issue.code) ? issue.message : null;
  };
  const otpStatus = (): OtpInputStatus => {
    if (verified()) return "success";
    if (codeBusy()) return "verifying";
    if (displayedCodeError()) return "error";
    return "idle";
  };

  createEffect(
    () => loginStep(),
    (step, previousStep) => {
      if (!previousStep || step === previousStep) return;
      setLoginTransition(step === "code" ? "forward" : "back");
    },
  );

  createEffect(
    () => currentIssue(),
    (issue) => {
      setNow(Date.now());
      setIssueVisible(true);
      setIssueBlockedUntil(issue?.retryAfterSeconds ? Date.now() + issue.retryAfterSeconds * 1_000 : 0);
      if (issue?.code === "invalid_email") showEmailError(issue.message);
    },
  );

  createEffect(
    () => (props.state.status === "code_sent" ? props.state.challengeId : null),
    (challengeId, previousChallengeId) => {
      if (!challengeId) return;
      setNow(Date.now());
      if (!previousChallengeId || challengeId === previousChallengeId) return;
      setCode("");
      setCodeError(null);
    },
  );

  createEffect(
    () => props.state.status,
    (status, previousStatus) => {
      if (status === previousStatus) return;
      if (status === "signed_out" || (status === "error" && !unavailable())) {
        queueMicrotask(() => emailInput?.focus());
      }
    },
  );

  function validateEmail(value: string): string | null {
    if (!value.trim()) return "Enter your email address.";
    return normalizeEmailAddress(value) ? null : "Enter a valid email address.";
  }

  function clearEmailErrorTimers(): void {
    if (emailShakeTimer !== undefined) window.clearTimeout(emailShakeTimer);
    if (emailRevertTimer !== undefined) window.clearTimeout(emailRevertTimer);
    if (emailMessageTimer !== undefined) window.clearTimeout(emailMessageTimer);
    emailShakeTimer = undefined;
    emailRevertTimer = undefined;
    emailMessageTimer = undefined;
  }

  function motionDuration(name: string, fallback: number): number {
    const value = Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
  }

  function hideEmailError(): void {
    clearEmailErrorTimers();
    setEmailErrorActive(false);
    setEmailShaking(false);
    emailMessageTimer = window.setTimeout(
      () => {
        emailMessageTimer = undefined;
        setPresentedEmailError(null);
      },
      motionDuration("--revert-dur", 280),
    );
  }

  function showEmailError(message: string): void {
    clearEmailErrorTimers();
    setPresentedEmailError(message);
    setEmailErrorActive(true);

    setEmailShaking(false);
    if (emailInput) void emailInput.offsetWidth;
    setEmailShaking(true);

    const shakeDuration = motionDuration("--shake-dur-a", 80) * 2 + motionDuration("--shake-dur-b", 60) * 2;
    emailShakeTimer = window.setTimeout(() => {
      emailShakeTimer = undefined;
      setEmailShaking(false);
    }, shakeDuration + 20);

    emailRevertTimer = window.setTimeout(() => {
      emailRevertTimer = undefined;
      setEmailErrorActive(false);
      emailMessageTimer = window.setTimeout(
        () => {
          emailMessageTimer = undefined;
          setPresentedEmailError(null);
        },
        motionDuration("--revert-dur", 280),
      );
    }, shakeDuration + motionDuration("--revert-hold", 3_000));
  }

  function handleEmailInput(value: string): void {
    setEmail(value);
    setIssueVisible(false);
    setLocalError(null);
    hideEmailError();
  }

  function handleCodeInput(value: string): void {
    setCode(value);
    setIssueVisible(false);
    setLocalError(null);
    setCodeError(null);
  }

  async function submitEmail(): Promise<void> {
    if (pendingAction() || emailBusy() || emailRetryIn() > 0) return;
    const validationError = validateEmail(email());
    if (validationError) {
      showEmailError(validationError);
      emailInput?.focus();
      return;
    }
    const normalizedEmail = normalizeEmailAddress(email());
    if (!normalizedEmail) return;
    setEmail(normalizedEmail);
    setIssueVisible(false);
    setLocalError(null);
    setPendingAction("send");
    try {
      await props.onRequestEmailCode(normalizedEmail);
    } catch {
      setLocalError("Something went wrong while sending the code. Try again.");
    } finally {
      setPendingAction(null);
    }
  }

  async function submitCode(value = code()): Promise<void> {
    if (props.state.status !== "code_sent" || pendingAction() || codeBusy() || codeNeedsReplacement()) return;
    const normalizedCode = normalizeOneTimeCode(value);
    if (!normalizedCode) {
      setCodeError("Enter the full 8-character code.");
      return;
    }
    setCodeError(null);
    setIssueVisible(false);
    setLocalError(null);
    setPendingAction("verify");
    try {
      await props.onVerifyEmailCode(props.state.challengeId, formatCode(normalizedCode));
    } catch {
      setLocalError("Something went wrong while verifying the code. Try again.");
    } finally {
      setPendingAction(null);
    }
  }

  async function resendCode(): Promise<void> {
    if (props.state.status !== "code_sent" || pendingAction() || resendBusy() || resendAvailableIn() > 0) return;
    setIssueVisible(false);
    setLocalError(null);
    setPendingAction("resend");
    try {
      await props.onRequestEmailCode(props.state.email);
    } catch {
      setLocalError("Something went wrong while sending a new code. Try again.");
    } finally {
      setPendingAction(null);
    }
  }

  async function retryConnection(): Promise<void> {
    if (pendingAction()) return;
    setPendingAction("retry");
    setLocalError(null);
    try {
      await props.onRetry();
    } catch {
      setLocalError("OpenBot still can’t reach the account service.");
    } finally {
      setPendingAction(null);
    }
  }

  async function resetEmail(): Promise<void> {
    if (pendingAction()) return;
    setPendingAction("reset");
    setLocalError(null);
    try {
      await props.onReset();
      setCode("");
      setCodeError(null);
      setIssueVisible(false);
    } catch {
      setLocalError("OpenBot couldn’t restart sign in. Try again.");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <main class="account-login-screen">
      <div class="account-login-shell">
        <header class="account-login-brand-lockup">
          <AppLogo variant={props.variant} animation="blink" interactive class="account-login-logo" />
          <span class="account-login-wordmark">OpenBot</span>
        </header>

        <section
          class="account-login"
          data-step={loginStep()}
          data-transition={loginTransition()}
          aria-labelledby="account-login-title"
          aria-describedby="account-login-description"
        >
          <h1 id="account-login-title" class="account-login-title">
            {connecting()
              ? "Connecting to OpenBot"
              : unavailable()
                ? "Service unavailable"
                : verified()
                  ? "You’re signed in"
                  : codeSent()
                    ? "Check your inbox"
                    : "Sign in to OpenBot"}
          </h1>
          <p id="account-login-description" class="account-login-description">
            <Show
              when={challenge() || verified()}
              fallback={
                connecting()
                  ? "Starting the account service. This usually takes a moment."
                  : unavailable()
                    ? (currentIssue()?.message ?? "OpenBot can’t reach the account service right now.")
                    : "We’ll email you a one-time code."
              }
            >
              {verified() ? (
                "Your code was accepted."
              ) : (
                <>
                  We sent a code to <strong>{challenge()?.email}</strong>.
                </>
              )}
            </Show>
          </p>

          <Show when={connecting()}>
            <div class="account-login-loader" role="status" aria-live="polite">
              <span class="account-login-spinner" aria-hidden="true" />
              <span>Connecting securely…</span>
            </div>
          </Show>

          <Show when={unavailableIssue()}>
            <Show when={localError()}>
              {(message) => (
                <p class="account-login-error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <Button
              variant="default"
              type="button"
              class="account-login-primary"
              disabled={pendingAction() === "retry"}
              onClick={() => void retryConnection()}
            >
              <Show when={pendingAction() === "retry"} fallback="Try again">
                <span class="account-login-button-spinner" aria-hidden="true" />
                Connecting…
              </Show>
            </Button>
          </Show>

          <Show when={!connecting() && !unavailable()}>
            <Show
              when={challenge() || verified()}
              fallback={
                <form
                  class="account-login-form"
                  data-auth-panel="email"
                  aria-busy={emailBusy() ? "true" : "false"}
                  novalidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitEmail();
                  }}
                >
                  <label class="sr-only" for="account-email">
                    Email
                  </label>
                  <div class={`account-login-email-field t-input-wrap${emailErrorActive() ? " is-error" : ""}`}>
                    <Input
                      ref={(element) => (emailInput = element)}
                      class={`t-input${emailErrorActive() ? " is-error" : ""}${emailShaking() ? " is-shaking" : ""}`}
                      id="account-email"
                      type="email"
                      autocomplete="email"
                      autocapitalize="none"
                      inputmode="email"
                      spellcheck={false}
                      placeholder="you@example.com"
                      maxlength={INPUT_LIMITS.email}
                      value={email()}
                      aria-invalid={emailErrorActive() ? "true" : undefined}
                      aria-describedby={emailErrorActive() ? "account-email-error" : undefined}
                      autofocus
                      onBlur={() => {
                        const validationError = validateEmail(email());
                        if (validationError) showEmailError(validationError);
                        else hideEmailError();
                      }}
                      onValueChange={handleEmailInput}
                    />
                    <p
                      id="account-email-error"
                      class="account-login-field-error t-error-msg"
                      role="alert"
                      aria-hidden={emailErrorActive() ? undefined : "true"}
                    >
                      {presentedEmailError()}
                    </p>
                  </div>

                  <Show when={formIssue()}>
                    {(issue) => (
                      <p class="account-login-error" role="alert">
                        {issue().message}
                      </p>
                    )}
                  </Show>
                  <Show when={localError()}>
                    {(message) => (
                      <p class="account-login-error" role="alert">
                        {message()}
                      </p>
                    )}
                  </Show>

                  <Button
                    variant="default"
                    type="submit"
                    class="account-login-primary"
                    disabled={emailBusy() || !email().trim() || emailRetryIn() > 0}
                  >
                    <Show
                      when={emailBusy()}
                      fallback={
                        emailRetryIn() > 0 ? `Try again in ${formatTimer(emailRetryIn())}` : "Send sign-in code"
                      }
                    >
                      <span class="account-login-button-spinner" aria-hidden="true" />
                      Sending code…
                    </Show>
                  </Button>
                </form>
              }
            >
              <div
                class="account-login-form"
                data-auth-panel="code"
                aria-busy={codeBusy() || resendBusy() ? "true" : "false"}
              >
                <OtpInput
                  value={code()}
                  status={otpStatus()}
                  hint="Enter all 8 characters to continue."
                  errorMessage={displayedCodeError()}
                  successMessage="Verified. Opening OpenBot…"
                  disabled={codeNeedsReplacement() || resendBusy()}
                  autofocus
                  onChange={handleCodeInput}
                  onComplete={(value) => void submitCode(value)}
                />

                <Show when={challenge()?.developmentCode}>
                  {(developmentCode) => (
                    <p class="account-login-development-code">Development code: {developmentCode()}</p>
                  )}
                </Show>
                <Show when={formIssue()}>
                  {(issue) => (
                    <p class="account-login-error" role="alert">
                      {issue().message}
                    </p>
                  )}
                </Show>
                <Show when={localError()}>
                  {(message) => (
                    <p class="account-login-error" role="alert">
                      {message()}
                    </p>
                  )}
                </Show>

                <Show when={!verified()}>
                  <Show when={codeNeedsReplacement()}>
                    <Button
                      variant="default"
                      type="button"
                      class="account-login-primary"
                      disabled={pendingAction() !== null || resendAvailableIn() > 0}
                      onClick={() => void resendCode()}
                    >
                      <Show
                        when={resendBusy()}
                        fallback={
                          resendAvailableIn() > 0
                            ? `Send a new code in ${formatTimer(resendAvailableIn())}`
                            : "Send a new code"
                        }
                      >
                        <span class="account-login-button-spinner" aria-hidden="true" />
                        Sending new code…
                      </Show>
                    </Button>
                  </Show>

                  <div class="account-login-code-actions">
                    <Button
                      type="button"
                      class="account-login-code-action account-login-code-action-change"
                      variant="ghost"
                      size="sm"
                      disabled={pendingAction() !== null}
                      onClick={() => void resetEmail()}
                    >
                      <ArrowLeft size={14} aria-hidden="true" />
                      Change email
                    </Button>
                    <Show when={!codeNeedsReplacement()}>
                      <Button
                        type="button"
                        class="account-login-code-action account-login-code-action-resend"
                        variant="ghost"
                        size="sm"
                        disabled={pendingAction() !== null || resendAvailableIn() > 0}
                        loading={resendBusy()}
                        loadingLabel="Sending…"
                        onClick={() => void resendCode()}
                      >
                        <RefreshCw size={14} aria-hidden="true" />
                        {resendAvailableIn() > 0 ? `Resend in ${formatTimer(resendAvailableIn())}` : "Resend code"}
                      </Button>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>
          </Show>
        </section>
      </div>
    </main>
  );
}

function formatCode(value: string): string {
  const compact = normalizeOneTimeCode(value) ?? value.replaceAll("-", "");
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

function secondsUntil(timestamp: number, now: number): number {
  return Math.max(0, Math.ceil((timestamp - now) / 1_000));
}

function formatTimer(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

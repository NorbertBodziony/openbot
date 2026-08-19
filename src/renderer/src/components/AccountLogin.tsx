import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AppVariant, CentralAuthIssue, CentralAuthState } from "@openbot/contracts/ipc";
import {
  normalizeEmailAddress,
  normalizeOneTimeCode,
  ONE_TIME_CODE_ALPHABET,
  ONE_TIME_CODE_LENGTH,
} from "@openbot/contracts/validation";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { AppLogo } from "./AppLogo";

interface AccountLoginProps {
  variant: AppVariant;
  state: CentralAuthState;
  onRetry: () => Promise<void>;
  onRequestEmailCode: (email: string) => Promise<void>;
  onVerifyEmailCode: (challengeId: string, code: string) => Promise<void>;
  onReset: () => Promise<void>;
}

type PendingAction = "retry" | "send" | "verify" | "resend" | "reset";

const FIELD_ISSUES = new Set(["invalid_email", "invalid_sign_in_code"]);
const NEW_CODE_ISSUES = new Set(["sign_in_code_expired", "too_many_code_attempts"]);

export function AccountLogin(props: AccountLoginProps) {
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [emailTouched, setEmailTouched] = createSignal(false);
  const [emailError, setEmailError] = createSignal<string | null>(null);
  const [codeError, setCodeError] = createSignal<string | null>(null);
  const [localError, setLocalError] = createSignal<string | null>(null);
  const [pendingAction, setPendingAction] = createSignal<PendingAction | null>(null);
  const [issueVisible, setIssueVisible] = createSignal(true);
  const [issueBlockedUntil, setIssueBlockedUntil] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  let emailInput: HTMLInputElement | undefined;
  let codeInput: HTMLInputElement | undefined;

  const clock = window.setInterval(() => setNow(Date.now()), 1_000);
  onCleanup(() => window.clearInterval(clock));

  const codeSent = () => props.state.status === "code_sent";
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
    const issue = displayedIssue();
    return Boolean(issue && NEW_CODE_ISSUES.has(issue.code)) || (codeSent() && codeExpiresIn() === 0);
  };
  const resendAvailableIn = () => {
    if (props.state.status !== "code_sent") return 0;
    return secondsUntil(Math.max(props.state.resendAvailableAt, issueBlockedUntil()), now());
  };
  const emailRetryIn = () => {
    const issue = displayedIssue();
    return issue?.retryAfterSeconds ? secondsUntil(issueBlockedUntil(), now()) : 0;
  };
  const emailBusy = () => pendingAction() === "send" || props.state.status === "signing_in";
  const codeBusy = () => pendingAction() === "verify";
  const resendBusy = () => pendingAction() === "resend";
  const formIssue = createMemo(() => {
    const issue = displayedIssue();
    return issue && !FIELD_ISSUES.has(issue.code) ? issue : undefined;
  });
  const displayedEmailError = () => {
    const issue = displayedIssue();
    return emailError() ?? (issue?.code === "invalid_email" ? issue.message : null);
  };
  const displayedCodeError = () => {
    const issue = displayedIssue();
    return codeError() ?? (issue?.code === "invalid_sign_in_code" ? issue.message : null);
  };

  createEffect(
    () => currentIssue(),
    (issue) => {
      setIssueVisible(true);
      setIssueBlockedUntil(issue?.retryAfterSeconds ? Date.now() + issue.retryAfterSeconds * 1_000 : 0);
    },
  );

  createEffect(
    () => (props.state.status === "code_sent" ? props.state.challengeId : null),
    (challengeId, previousChallengeId) => {
      if (!challengeId || !previousChallengeId || challengeId === previousChallengeId) return;
      setCode("");
      setCodeError(null);
      queueMicrotask(() => codeInput?.focus());
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

  function handleEmailInput(value: string): void {
    setEmail(value);
    setIssueVisible(false);
    setLocalError(null);
    if (emailTouched()) setEmailError(validateEmail(value));
  }

  function handleCodeInput(value: string): void {
    const formatted = formatCode(value);
    setCode(formatted);
    setIssueVisible(false);
    setLocalError(null);
    if (codeError()) setCodeError(normalizeOneTimeCode(formatted) ? null : "Enter the full 8-character code.");
  }

  async function submitEmail(): Promise<void> {
    if (emailBusy() || emailRetryIn() > 0) return;
    setEmailTouched(true);
    const validationError = validateEmail(email());
    setEmailError(validationError);
    if (validationError) {
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

  async function submitCode(): Promise<void> {
    if (props.state.status !== "code_sent" || codeBusy() || codeNeedsReplacement()) return;
    const normalizedCode = normalizeOneTimeCode(code());
    if (!normalizedCode) {
      setCodeError("Enter the full 8-character code.");
      codeInput?.focus();
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
    if (props.state.status !== "code_sent" || resendBusy() || resendAvailableIn() > 0) return;
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
          <span class="account-login-brand" aria-hidden="true">
            <AppLogo variant={props.variant} animation="blink" class="account-login-logo" />
          </span>
          <span class="account-login-wordmark">OpenBot</span>
        </header>

        <section
          class="account-login"
          aria-labelledby="account-login-title"
          aria-describedby="account-login-description"
        >
          <div class="account-login-heading">
            <h1 id="account-login-title">
              {connecting()
                ? "Connecting to OpenBot"
                : unavailable()
                  ? "Service unavailable"
                  : codeSent()
                    ? "Check your inbox"
                    : "Sign in to OpenBot"}
            </h1>
            <p id="account-login-description" class="account-login-description">
              <Show
                when={challenge()}
                fallback={
                  connecting()
                    ? "Starting the account service. This usually takes a moment."
                    : unavailable()
                      ? "OpenBot can’t reach the account service right now."
                      : "Enter your email and we’ll send you a one-time sign-in code."
                }
              >
                {(activeChallenge) => (
                  <>
                    We sent an 8-character code to <strong>{activeChallenge().email}</strong>.
                  </>
                )}
              </Show>
            </p>
          </div>

          <Show when={connecting()}>
            <div class="account-login-loader" role="status" aria-live="polite">
              <span class="account-login-spinner" aria-hidden="true" />
              <span>Connecting securely…</span>
            </div>
          </Show>

          <Show when={unavailableIssue()}>
            {(issue) => (
              <div class="account-login-stack">
                <AuthNotice message={issue().message} />
                <Show when={localError()}>{(message) => <AuthNotice message={message()} />}</Show>
                <button
                  type="button"
                  class="account-login-primary"
                  disabled={pendingAction() === "retry"}
                  onClick={() => void retryConnection()}
                >
                  <Show when={pendingAction() === "retry"} fallback="Try again">
                    <span class="account-login-button-content">
                      <span class="account-login-button-spinner" aria-hidden="true" />
                      Connecting…
                    </span>
                  </Show>
                </button>
              </div>
            )}
          </Show>

          <Show when={!connecting() && !unavailable()}>
            <Show
              when={challenge()}
              fallback={
                <form
                  class="account-login-form"
                  aria-busy={emailBusy() ? "true" : "false"}
                  novalidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitEmail();
                  }}
                >
                  <div class="account-login-field">
                    <label for="account-email">Email</label>
                    <input
                      ref={(element) => (emailInput = element)}
                      id="account-email"
                      type="email"
                      autocomplete="email"
                      autocapitalize="none"
                      inputmode="email"
                      spellcheck={false}
                      placeholder="you@example.com"
                      maxlength={INPUT_LIMITS.email}
                      value={email()}
                      aria-invalid={displayedEmailError() ? "true" : undefined}
                      aria-describedby={displayedEmailError() ? "account-email-error" : undefined}
                      autofocus
                      onBlur={() => {
                        setEmailTouched(true);
                        setEmailError(validateEmail(email()));
                      }}
                      onInput={(event) => handleEmailInput(event.currentTarget.value)}
                    />
                    <Show when={displayedEmailError()}>
                      {(message) => (
                        <p id="account-email-error" class="account-login-field-error" role="alert">
                          {message()}
                        </p>
                      )}
                    </Show>
                  </div>

                  <Show when={formIssue()}>{(issue) => <AuthNotice message={issue().message} />}</Show>
                  <Show when={localError()}>{(message) => <AuthNotice message={message()} />}</Show>

                  <button
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
                      <span class="account-login-button-content">
                        <span class="account-login-button-spinner" aria-hidden="true" />
                        Sending code…
                      </span>
                    </Show>
                  </button>
                </form>
              }
            >
              {(challenge) => (
                <form
                  class="account-login-form"
                  aria-busy={codeBusy() || resendBusy() ? "true" : "false"}
                  novalidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitCode();
                  }}
                >
                  <div class="account-login-field">
                    <label for="account-code">One-time code</label>
                    <input
                      ref={(element) => (codeInput = element)}
                      id="account-code"
                      class="account-login-code"
                      type="text"
                      autocomplete="one-time-code"
                      autocapitalize="characters"
                      inputmode="text"
                      spellcheck={false}
                      placeholder="XXXX-XXXX"
                      maxlength={ONE_TIME_CODE_LENGTH + 1}
                      value={code()}
                      aria-invalid={displayedCodeError() ? "true" : undefined}
                      aria-describedby={displayedCodeError() ? "account-code-error" : "account-code-meta"}
                      autofocus
                      onInput={(event) => handleCodeInput(event.currentTarget.value)}
                    />
                    <Show when={displayedCodeError()}>
                      {(message) => (
                        <p id="account-code-error" class="account-login-field-error" role="alert">
                          {message()}
                        </p>
                      )}
                    </Show>
                  </div>

                  <Show when={challenge().developmentCode}>
                    {(developmentCode) => (
                      <p class="account-login-development-code">Development code: {developmentCode()}</p>
                    )}
                  </Show>
                  <Show when={formIssue()}>{(issue) => <AuthNotice message={issue().message} />}</Show>
                  <Show when={localError()}>{(message) => <AuthNotice message={message()} />}</Show>

                  <Show
                    when={codeNeedsReplacement()}
                    fallback={
                      <button type="submit" class="account-login-primary" disabled={codeBusy() || resendBusy()}>
                        <Show when={codeBusy()} fallback="Verify code">
                          <span class="account-login-button-content">
                            <span class="account-login-button-spinner" aria-hidden="true" />
                            Verifying…
                          </span>
                        </Show>
                      </button>
                    }
                  >
                    <button
                      type="button"
                      class="account-login-primary"
                      disabled={resendBusy() || resendAvailableIn() > 0}
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
                        <span class="account-login-button-content">
                          <span class="account-login-button-spinner" aria-hidden="true" />
                          Sending new code…
                        </span>
                      </Show>
                    </button>
                  </Show>

                  <div id="account-code-meta" class="account-login-code-meta">
                    <span>{codeExpiresIn() > 0 ? `Expires in ${formatTimer(codeExpiresIn())}` : "Code expired"}</span>
                    <button
                      type="button"
                      disabled={resendBusy() || resendAvailableIn() > 0}
                      onClick={() => void resendCode()}
                    >
                      {resendAvailableIn() > 0 ? `Resend in ${formatTimer(resendAvailableIn())}` : "Resend code"}
                    </button>
                  </div>

                  <button
                    type="button"
                    class="account-login-link"
                    disabled={pendingAction() !== null}
                    onClick={() => void resetEmail()}
                  >
                    Use a different email
                  </button>
                </form>
              )}
            </Show>
          </Show>
        </section>

        <p class="account-login-note">Passwordless sign-in · Codes expire after 10 minutes</p>
      </div>
    </main>
  );
}

function AuthNotice(props: { message: string }) {
  return (
    <div class="account-login-error" role="alert">
      <span class="account-login-error-mark" aria-hidden="true">
        !
      </span>
      <span>{props.message}</span>
    </div>
  );
}

function formatCode(value: string): string {
  const compact = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "")
    .split("")
    .filter((character) => ONE_TIME_CODE_ALPHABET.includes(character))
    .join("")
    .slice(0, ONE_TIME_CODE_LENGTH);
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

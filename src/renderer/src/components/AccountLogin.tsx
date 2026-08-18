import { createSignal, Show } from "solid-js";
import type { CentralAuthState } from "../../../shared/ipc";

interface AccountLoginProps {
  state: CentralAuthState;
  onRequestEmailCode: (email: string) => Promise<void>;
  onVerifyEmailCode: (challengeId: string, code: string) => Promise<void>;
  onReset: () => Promise<void>;
}

export function AccountLogin(props: AccountLoginProps) {
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");

  const codeSent = () => props.state.status === "code_sent";
  const busy = () => props.state.status === "loading" || props.state.status === "signing_in";

  return (
    <main class="account-login-screen">
      <section
        class="account-login"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-login-title"
        aria-describedby="account-login-description"
      >
        <div class="account-login-brand" aria-hidden="true">
          <span>O</span>
        </div>
        <p class="account-login-wordmark">OpenBot</p>
        <h1 id="account-login-title">{codeSent() ? "Check your email" : "Sign in"}</h1>
        <p id="account-login-description" class="account-login-description">
          {props.state.status === "code_sent"
            ? `Enter the 8-character code sent to ${props.state.email}.`
            : "Enter your email. We will send you a one-time code."}
        </p>

        <Show when={props.state.status === "error"}>
          <p class="account-login-error" role="alert">
            {props.state.status === "error" ? props.state.message : ""}
          </p>
        </Show>
        <Show when={props.state.status === "code_sent" && props.state.error}>
          <p class="account-login-error" role="alert">
            {props.state.status === "code_sent" ? props.state.error : ""}
          </p>
        </Show>

        <Show
          when={codeSent()}
          fallback={
            <form
              class="account-login-form"
              onSubmit={(event) => {
                event.preventDefault();
                void props.onRequestEmailCode(email().trim());
              }}
            >
              <label for="account-email">Email</label>
              <input
                id="account-email"
                type="email"
                autocomplete="email"
                inputmode="email"
                placeholder="you@example.com"
                value={email()}
                onInput={(event) => setEmail(event.currentTarget.value)}
                autofocus
                required
              />
              <button type="submit" disabled={busy() || !email().trim()}>
                {props.state.status === "signing_in" ? "Sending code…" : "Continue"}
              </button>
            </form>
          }
        >
          <form
            class="account-login-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (props.state.status !== "code_sent") return;
              void props.onVerifyEmailCode(props.state.challengeId, code());
            }}
          >
            <label for="account-code">One-time code</label>
            <input
              id="account-code"
              class="account-login-code"
              type="text"
              autocomplete="one-time-code"
              inputmode="text"
              placeholder="XXXX-XXXX"
              maxlength={9}
              value={code()}
              onInput={(event) => setCode(formatCode(event.currentTarget.value))}
              autofocus
              required
            />
            <Show when={props.state.status === "code_sent" && props.state.developmentCode}>
              <p class="account-login-development-code">
                Development code:{" "}
                {props.state.status === "code_sent" && props.state.developmentCode}
              </p>
            </Show>
            <button type="submit" disabled={code().replace("-", "").length !== 8}>
              Verify code
            </button>
            <button type="button" class="account-login-link" onClick={() => void props.onReset()}>
              Use a different email
            </button>
          </form>
        </Show>

        <p class="account-login-note">No password. The code expires after 10 minutes.</p>
      </section>
    </main>
  );
}

function formatCode(value: string): string {
  const compact = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "")
    .slice(0, 8);
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

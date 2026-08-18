import {
  createEffect,
  createMemo,
  createSignal,
  For,
  flush,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import type {
  AgentProviderId,
  AgentProviderState,
  AgentStatus,
  AppSetupState,
  CentralAuthState,
  DesktopPlatform,
  MacPermissionId,
  MacPermissionsState,
} from "../../../shared/ipc";
import { ProviderPicker, type ProviderPickerOption } from "./ProviderPicker";

interface InitialSetupProps {
  reviewing?: boolean;
  state: AppSetupState;
  agentStatus: AgentStatus;
  platform: DesktopPlatform;
  authState: CentralAuthState;
  onSave: (provider: AgentProviderId) => Promise<void>;
  onRequestEmailCode: (email: string) => Promise<void>;
  onVerifyEmailCode: (challengeId: string, code: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onClose?: () => void;
}

const PROVIDERS: Array<{
  id: AgentProviderId;
  name: string;
}> = [
  {
    id: "codex",
    name: "Codex",
  },
  {
    id: "claude",
    name: "Claude",
  },
];

const PERMISSIONS: Array<{
  id: MacPermissionId;
  title: string;
  description: string;
}> = [
  {
    id: "screen-recording",
    title: "Screen Recording",
    description: "Let Computer Use see what is on your screen.",
  },
  {
    id: "accessibility",
    title: "Accessibility",
    description: "Let Computer Use control apps on your Mac.",
  },
];

const EMPTY_PERMISSIONS: MacPermissionsState = {
  screenRecording: "unknown",
  accessibility: "unknown",
};

export function InitialSetup(props: InitialSetupProps) {
  const [selectedProvider, setSelectedProvider] = createSignal<AgentProviderId | null>(
    untrack(() => props.state.preferredProvider),
  );
  const [permissions, setPermissions] = createSignal(EMPTY_PERMISSIONS);
  const [saving, setSaving] = createSignal(false);
  const [permissionBusy, setPermissionBusy] = createSignal<MacPermissionId | null>(null);
  const [error, setError] = createSignal("");
  const [accountEmail, setAccountEmail] = createSignal("");
  const [accountCode, setAccountCode] = createSignal("");
  const providerOptions = createMemo<ProviderPickerOption[]>(() =>
    PROVIDERS.map((provider) => {
      const status = props.agentStatus.providers?.find((candidate) => candidate.id === provider.id);
      return {
        ...provider,
        state: status?.state ?? fallbackProviderState(props.agentStatus),
        message: status?.message,
        email: status?.email,
      };
    }),
  );
  const availableProviders = createMemo(() =>
    providerOptions().filter((provider) => provider.state === "available"),
  );

  createEffect(
    () => ({
      options: providerOptions(),
      available: availableProviders(),
      selected: selectedProvider(),
      preferredProvider: props.state.preferredProvider,
    }),
    ({ options, available, selected, preferredProvider }) => {
      if (selected && options.some((provider) => provider.id === selected)) return;
      const preferred = options.find((provider) => provider.id === preferredProvider);
      setSelectedProvider(preferred?.id ?? available[0]?.id ?? null);
    },
  );

  async function refreshPermissions(): Promise<void> {
    if (props.platform !== "darwin") return;
    try {
      const next = await window.openbot.getMacPermissions();
      flush(() => setPermissions(next));
    } catch (cause) {
      setError(errorMessage(cause, "OpenBot could not read macOS permissions."));
    }
  }

  onSettled(() => {
    void refreshPermissions();
    const handleFocus = () => void refreshPermissions();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  });

  async function requestPermission(permission: MacPermissionId): Promise<void> {
    if (permissionBusy()) return;
    setPermissionBusy(permission);
    setError("");
    try {
      const next = await window.openbot.requestMacPermission(permission);
      flush(() => setPermissions(next));
    } catch (cause) {
      setError(errorMessage(cause, "OpenBot could not open this macOS permission."));
    } finally {
      setPermissionBusy(null);
    }
  }

  async function save(): Promise<void> {
    const provider = selectedProvider();
    if (!provider || saving()) return;
    setSaving(true);
    setError("");
    try {
      await props.onSave(provider);
    } catch (cause) {
      setError(errorMessage(cause, "OpenBot could not save your provider."));
      setSaving(false);
    }
  }

  return (
    <main class="initial-setup-screen">
      <section
        class="initial-setup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="initial-setup-title"
        aria-describedby="initial-setup-description"
      >
        <header class="initial-setup-header">
          <p class="initial-setup-eyebrow">OpenBot setup</p>
          <h1 id="initial-setup-title">
            {props.reviewing ? "Providers & permissions" : "Choose your provider"}
          </h1>
          <p id="initial-setup-description" class="initial-setup-intro">
            {props.reviewing
              ? "Choose the default provider for new agents and review macOS permissions."
              : "New agents will use this provider by default. Each agent can use a different provider later."}
          </p>
        </header>

        <section class="setup-account" aria-labelledby="setup-account-title">
          <div class="setup-account-copy">
            <p class="initial-setup-section-label">OpenBot account</p>
            <h2 id="setup-account-title">
              {props.authState.status === "signed_in"
                ? props.authState.user.name || props.authState.user.email
                : props.authState.status === "code_sent"
                  ? "Enter your sign-in code"
                  : "Sign in with your email"}
            </h2>
            <p>
              {props.authState.status === "signed_in"
                ? props.authState.user.email
                : props.authState.status === "code_sent"
                  ? `We sent an 8-character code to ${props.authState.email}.`
                  : "Your verified email identifies you when a host grants access."}
            </p>
            <Show when={props.authState.status === "error"}>
              <p class="setup-account-error" role="alert">
                {props.authState.status === "error" ? props.authState.message : ""}
              </p>
            </Show>
            <Show when={props.authState.status === "code_sent" && props.authState.error}>
              <p class="setup-account-error" role="alert">
                {props.authState.status === "code_sent" ? props.authState.error : ""}
              </p>
            </Show>
            <Show when={props.authState.status === "code_sent" && props.authState.developmentCode}>
              <p class="setup-account-development-code">
                Development code:{" "}
                {props.authState.status === "code_sent" ? props.authState.developmentCode : ""}
              </p>
            </Show>
          </div>
          <Show
            when={props.authState.status === "signed_in"}
            fallback={
              <Show
                when={props.authState.status === "code_sent"}
                fallback={
                  <form
                    class="setup-account-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void props.onRequestEmailCode(accountEmail());
                    }}
                  >
                    <input
                      type="email"
                      autocomplete="email"
                      aria-label="Email address"
                      placeholder="you@example.com"
                      value={accountEmail()}
                      onInput={(event) => setAccountEmail(event.currentTarget.value)}
                      required
                    />
                    <button
                      type="submit"
                      class="setup-google-button"
                      disabled={
                        !accountEmail().trim() ||
                        props.authState.status === "loading" ||
                        props.authState.status === "signing_in"
                      }
                    >
                      {props.authState.status === "signing_in" ? "Sending…" : "Send code"}
                    </button>
                  </form>
                }
              >
                <form
                  class="setup-account-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (props.authState.status !== "code_sent") return;
                    void props.onVerifyEmailCode(props.authState.challengeId, accountCode());
                  }}
                >
                  <input
                    type="text"
                    autocomplete="one-time-code"
                    aria-label="Sign-in code"
                    placeholder="XXXX-XXXX"
                    maxlength={9}
                    value={accountCode()}
                    onInput={(event) => setAccountCode(event.currentTarget.value.toUpperCase())}
                    required
                  />
                  <button
                    type="submit"
                    class="setup-google-button"
                    disabled={accountCode().replace(/[\s-]/gu, "").length !== 8}
                  >
                    Verify code
                  </button>
                </form>
              </Show>
            }
          >
            <button
              type="button"
              class="setup-account-signout"
              onClick={() => void props.onLogout()}
            >
              Sign out
            </button>
          </Show>
        </section>

        <ProviderPicker
          value={selectedProvider()}
          options={providerOptions()}
          ariaLabel="Default provider"
          label="Default provider"
          hint="Used for new agents. You can change it for each agent later."
          disabled={saving()}
          allowUnavailableSelection
          focusFirst
          onChange={setSelectedProvider}
        />

        <Show when={props.platform === "darwin"}>
          <section class="mac-permissions" aria-labelledby="mac-permissions-title">
            <div class="mac-permissions-heading">
              <div>
                <h2 id="mac-permissions-title">Mac permissions</h2>
                <p>Optional. Computer Use needs both permissions.</p>
              </div>
            </div>
            <div class="mac-permission-list">
              <For each={PERMISSIONS}>
                {(permission) => {
                  const state = () => permissionState(permissions(), permission.id);
                  return (
                    <div class="mac-permission-row">
                      <span class="mac-permission-copy">
                        <strong>{permission.title}</strong>
                        <small>{permission.description}</small>
                      </span>
                      <button
                        type="button"
                        class={[
                          "mac-permission-action",
                          { "mac-permission-allowed": state() === "granted" },
                        ]}
                        disabled={
                          permissionBusy() !== null ||
                          state() === "granted" ||
                          state() === "restricted"
                        }
                        onClick={() => void requestPermission(permission.id)}
                      >
                        {permissionBusy() === permission.id
                          ? "Checking…"
                          : permissionLabel(state())}
                      </button>
                    </div>
                  );
                }}
              </For>
            </div>
          </section>
        </Show>

        <Show when={error()}>
          <p class="initial-setup-error" role="alert">
            {error()}
          </p>
        </Show>

        <div class="initial-setup-actions">
          <Show when={props.reviewing}>
            <button type="button" class="initial-setup-secondary" onClick={props.onClose}>
              Cancel
            </button>
          </Show>
          <button
            type="button"
            class="initial-setup-save"
            disabled={saving() || !selectedProvider()}
            onClick={() => void save()}
          >
            {saving()
              ? "Saving…"
              : props.reviewing
                ? "Save changes"
                : selectedProvider()
                  ? `Continue with ${providerName(selectedProvider())}`
                  : "Choose a provider"}
          </button>
        </div>
      </section>
    </main>
  );
}

function permissionState(
  permissions: MacPermissionsState,
  permission: MacPermissionId,
): MacPermissionsState["screenRecording"] {
  return permission === "screen-recording"
    ? permissions.screenRecording
    : permissions.accessibility;
}

function permissionLabel(state: MacPermissionsState["screenRecording"]): string {
  if (state === "granted") return "Allowed";
  if (state === "denied" || state === "unknown") return "Open Settings";
  if (state === "restricted") return "Restricted";
  return "Allow";
}

function providerName(provider: AgentProviderId | null): string {
  return provider === "claude" ? "Claude" : "Codex";
}

function fallbackProviderState(status: AgentStatus): AgentProviderState {
  return status.phase === "starting" || status.phase === "restarting" ? "checking" : "error";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

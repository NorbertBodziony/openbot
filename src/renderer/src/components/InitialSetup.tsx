import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type {
  AgentProviderId,
  AgentProviderState,
  AgentStatus,
  AppSetupState,
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
  onSave: (provider: AgentProviderId) => Promise<void>;
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
    props.state.preferredProvider,
  );
  const [permissions, setPermissions] = createSignal(EMPTY_PERMISSIONS);
  const [saving, setSaving] = createSignal(false);
  const [permissionBusy, setPermissionBusy] = createSignal<MacPermissionId | null>(null);
  const [error, setError] = createSignal("");
  const providerOptions = createMemo<ProviderPickerOption[]>(() =>
    PROVIDERS.map((provider) => {
      const status = props.agentStatus.providers?.find((candidate) => candidate.id === provider.id);
      return {
        ...provider,
        state: status?.state ?? fallbackProviderState(props.agentStatus),
        message: status?.message,
      };
    }),
  );
  const availableProviders = createMemo(() =>
    providerOptions().filter((provider) => provider.state === "available"),
  );

  createEffect(() => {
    const available = availableProviders();
    const selected = selectedProvider();
    if (selected && available.some((provider) => provider.id === selected)) return;
    const preferred = available.find((provider) => provider.id === props.state.preferredProvider);
    setSelectedProvider(preferred?.id ?? available[0]?.id ?? null);
  });

  async function refreshPermissions(): Promise<void> {
    if (props.platform !== "darwin") return;
    try {
      setPermissions(await window.openbot.getMacPermissions());
    } catch (cause) {
      setError(errorMessage(cause, "OpenBot could not read macOS permissions."));
    }
  }

  onMount(() => {
    void refreshPermissions();
    const handleFocus = () => void refreshPermissions();
    window.addEventListener("focus", handleFocus);
    onCleanup(() => window.removeEventListener("focus", handleFocus));
  });

  async function requestPermission(permission: MacPermissionId): Promise<void> {
    if (permissionBusy()) return;
    setPermissionBusy(permission);
    setError("");
    try {
      setPermissions(await window.openbot.requestMacPermission(permission));
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

        <ProviderPicker
          value={selectedProvider()}
          options={providerOptions()}
          ariaLabel="Default provider"
          label="Default provider"
          hint="Used for new agents. You can change it for each agent later."
          disabled={saving()}
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
                        class="mac-permission-action"
                        classList={{ "mac-permission-allowed": state() === "granted" }}
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

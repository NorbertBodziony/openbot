import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentProviderId,
  AgentProviderState,
  AgentStatus,
  AppSetupState,
  DesktopPlatform,
  InvitePreview,
  JoinServerInput,
  MacPermissionId,
  MacPermissionsState,
} from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, flush, onCleanup, onSettled, Show, untrack } from "solid-js";
import { InvitePreviewCard } from "./JoinServerDialog";
import { ProviderPicker, type ProviderPickerOption } from "./ProviderPicker";
import { Button, Dialog, Textarea } from "./ui";

interface InitialSetupProps {
  reviewing?: boolean;
  state: AppSetupState;
  agentStatus: AgentStatus;
  platform: DesktopPlatform;
  accountEmail: string;
  inviteUrl?: string;
  onSave: (provider: AgentProviderId) => Promise<void>;
  onPreviewInvite: (input: JoinServerInput) => Promise<InvitePreview>;
  onJoinRemote: (input: JoinServerInput, provider: AgentProviderId) => Promise<void>;
  onLogout: () => Promise<void>;
  onClose?: () => void;
}

type SetupRoute = "local" | "remote";

const PROVIDERS: Array<{ id: AgentProviderId; name: string }> = [
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude" },
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
  const initialInviteUrl = untrack(() => props.inviteUrl?.trim() ?? "");
  const [route, setRoute] = createSignal<SetupRoute | null>(
    untrack(() => (props.reviewing ? "local" : initialInviteUrl ? "remote" : null)),
  );
  const [selectedProvider, setSelectedProvider] = createSignal<AgentProviderId | null>(
    untrack(() => props.state.preferredProvider),
  );
  const [permissions, setPermissions] = createSignal(EMPTY_PERMISSIONS);
  const [saving, setSaving] = createSignal(false);
  const [permissionBusy, setPermissionBusy] = createSignal<MacPermissionId | null>(null);
  const [error, setError] = createSignal("");
  const [inviteUrl, setInviteUrl] = createSignal(initialInviteUrl);
  const [invitePreview, setInvitePreview] = createSignal<InvitePreview | null>(null);
  let permissionRevision = 0;
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
  const availableProviders = createMemo(() => providerOptions().filter((provider) => provider.state === "available"));

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
      setSelectedProvider(preferred?.id ?? available[0]?.id ?? options[0]?.id ?? null);
    },
  );

  createEffect(
    () => props.inviteUrl?.trim() ?? "",
    (nextInviteUrl) => {
      if (!nextInviteUrl || nextInviteUrl === inviteUrl()) return;
      setInviteUrl(nextInviteUrl);
      setInvitePreview(null);
      setRoute("remote");
      void previewRemote(nextInviteUrl);
    },
  );

  onSettled(() => {
    if (initialInviteUrl) void previewRemote(initialInviteUrl);
  });

  async function loadPermissions(): Promise<void> {
    const revision = ++permissionRevision;
    try {
      const next = await window.openbot.getMacPermissions();
      if (revision === permissionRevision) flush(() => setPermissions(next));
    } catch (cause) {
      setError(errorMessage(cause, "OpenBot could not read macOS permissions."));
    }
  }

  createEffect(
    () => ({ route: route(), platform: props.platform }),
    ({ route: currentRoute, platform }) => {
      if (platform === "darwin" && currentRoute === "local") void loadPermissions();
    },
  );

  const handleFocus = () => {
    const shouldRefresh = untrack(() => props.platform === "darwin" && route() === "local");
    if (shouldRefresh) void loadPermissions();
  };
  window.addEventListener("focus", handleFocus);
  onCleanup(() => window.removeEventListener("focus", handleFocus));

  async function requestPermission(permission: MacPermissionId): Promise<void> {
    if (permissionBusy()) return;
    const revision = ++permissionRevision;
    setPermissionBusy(permission);
    setError("");
    try {
      const next = await window.openbot.requestMacPermission(permission);
      if (revision === permissionRevision) flush(() => setPermissions(next));
    } catch (cause) {
      setError(errorMessage(cause, "OpenBot could not open this macOS permission."));
    } finally {
      setPermissionBusy(null);
    }
  }

  function chooseRoute(nextRoute: SetupRoute): void {
    setError("");
    setRoute(nextRoute);
  }

  async function saveLocal(): Promise<void> {
    const provider = selectedProvider();
    if (!provider || saving()) return;
    setSaving(true);
    setError("");
    try {
      await props.onSave(provider);
    } catch (cause) {
      setError(errorMessage(cause, "OpenBot could not save your local setup."));
      setSaving(false);
    }
  }

  async function previewRemote(value = inviteUrl().trim()): Promise<boolean> {
    if (!value || saving()) return false;
    setSaving(true);
    setError("");
    try {
      setInvitePreview(await props.onPreviewInvite({ inviteUrl: value }));
      return true;
    } catch (cause) {
      setInvitePreview(null);
      setError(errorMessage(cause, "OpenBot could not verify this invitation."));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function connectRemote(): Promise<void> {
    const provider = selectedProvider() ?? "codex";
    if (saving()) return;
    if (!invitePreview()) {
      await previewRemote();
      return;
    }
    setSaving(true);
    setError("");
    try {
      await props.onJoinRemote({ inviteUrl: inviteUrl().trim() }, provider);
    } catch (cause) {
      setError(errorMessage(cause, "OpenBot could not connect to this host."));
      setSaving(false);
    }
  }

  const title = () => {
    if (props.reviewing) return "Providers & permissions";
    if (route() === "local") return "Set up this computer";
    if (route() === "remote") return "Connect to a host";
    return "Where will OpenBot run?";
  };

  const description = () => {
    if (props.reviewing) {
      return "Choose the default provider for local agents and review macOS permissions.";
    }
    if (route() === "local") {
      return "Agents, conversations, and files stay on this computer.";
    }
    if (route() === "remote") {
      return "Use an invitation from the person who runs your OpenBot host.";
    }
    return "Use this computer, or connect to an OpenBot host that runs somewhere else.";
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && props.onClose?.()}>
      <main class="initial-setup-screen">
        <Dialog.Content as="section" class="initial-setup">
          <header class="initial-setup-header">
            <div class="initial-setup-account-row">
              <Show when={!props.reviewing && route()}>
                <Button
                  type="button"
                  class="initial-setup-back"
                  aria-label="Back to connection choice"
                  onClick={() => {
                    setError("");
                    setRoute(null);
                  }}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="m12.5 4.5-5 5 5 5" />
                  </svg>
                </Button>
              </Show>
              <span class="initial-setup-account">
                <i aria-hidden="true" />
                {props.accountEmail}
              </span>
              <Button type="button" class="initial-setup-signout" onClick={() => void props.onLogout()}>
                Sign out
              </Button>
            </div>
            <p class="initial-setup-eyebrow">OpenBot setup</p>
            <Dialog.Title as="h1" id="initial-setup-title">
              {title()}
            </Dialog.Title>
            <Dialog.Description as="p" id="initial-setup-description" class="initial-setup-intro">
              {description()}
            </Dialog.Description>
          </header>

          <Show when={!props.reviewing && route() === null}>
            <ul class="setup-route-list" aria-label="Connection type">
              <li>
                <Button type="button" class="setup-route-button" onClick={() => chooseRoute("local")}>
                  <span class="setup-route-icon setup-route-icon-local" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <title>Local computer</title>
                      <rect x="3" y="4" width="18" height="13" rx="2.5" />
                      <path d="M8 21h8M12 17v4" />
                    </svg>
                    <i />
                  </span>
                  <span class="setup-route-copy">
                    <strong>Use this computer</strong>
                    <small>Run Codex or Claude locally. Keep all OpenBot data here.</small>
                  </span>
                  <RouteArrow />
                </Button>
              </li>
              <li>
                <Button type="button" class="setup-route-button" onClick={() => chooseRoute("remote")}>
                  <span class="setup-route-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <title>Remote host</title>
                      <rect x="3" y="3" width="18" height="7" rx="2.5" />
                      <rect x="3" y="14" width="18" height="7" rx="2.5" />
                      <path d="M7 6.5h.01M7 17.5h.01" />
                    </svg>
                    <i />
                  </span>
                  <span class="setup-route-copy">
                    <strong>Connect to a host</strong>
                    <small>Use agents and conversations from an existing OpenBot host.</small>
                  </span>
                  <RouteArrow />
                </Button>
              </li>
            </ul>
          </Show>

          <Show when={route() === "local"}>
            <div class="setup-local-content">
              <ProviderPicker
                value={selectedProvider()}
                options={providerOptions()}
                ariaLabel="Default provider"
                label="Default provider"
                hint="Used for new local agents. You can change it for each agent later."
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
                            <Button
                              type="button"
                              class={["mac-permission-action", { "mac-permission-allowed": state() === "granted" }]}
                              disabled={permissionBusy() !== null || state() === "granted" || state() === "restricted"}
                              onClick={() => void requestPermission(permission.id)}
                            >
                              {permissionBusy() === permission.id ? "Checking…" : permissionLabel(state())}
                            </Button>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </section>
              </Show>
            </div>
          </Show>

          <Show when={!props.reviewing && route() === "remote"}>
            <form
              class="setup-remote-form"
              onSubmit={(event) => {
                event.preventDefault();
                void connectRemote();
              }}
            >
              <Show
                when={invitePreview()}
                fallback={
                  <label>
                    <span>Host invitation</span>
                    <Textarea
                      rows="3"
                      maxlength={INPUT_LIMITS.inviteUrl}
                      value={inviteUrl()}
                      onInput={(event) => {
                        setInviteUrl(event.currentTarget.value);
                        setInvitePreview(null);
                        setError("");
                      }}
                      placeholder="Paste an https://openbot.run/join invitation link"
                      spellcheck={false}
                      autofocus
                      required
                    />
                  </label>
                }
              >
                {(preview) => (
                  <>
                    <InvitePreviewCard preview={preview()} accountEmail={props.accountEmail} />
                    <Button
                      type="button"
                      class="setup-remote-change"
                      disabled={saving()}
                      onClick={() => {
                        setInvitePreview(null);
                        setError("");
                      }}
                    >
                      Use another invitation
                    </Button>
                  </>
                )}
              </Show>
              <Show when={!invitePreview()}>
                <p class="setup-remote-note">
                  You will join as <strong>{props.accountEmail}</strong>. Email invitations only work for the address
                  that received them.
                </p>
              </Show>
            </form>
          </Show>

          <Show when={error()}>
            <p class="initial-setup-error" role="alert">
              {error()}
            </p>
          </Show>

          <Show when={route() !== null}>
            <div class="initial-setup-actions">
              <Show when={props.reviewing}>
                <Button type="button" class="initial-setup-secondary" onClick={props.onClose}>
                  Cancel
                </Button>
              </Show>
              <Button
                type="button"
                class="initial-setup-save"
                disabled={
                  saving() ||
                  (route() === "local" && !selectedProvider()) ||
                  (route() === "remote" && !inviteUrl().trim())
                }
                onClick={() => (route() === "local" ? void saveLocal() : void connectRemote())}
              >
                {saving()
                  ? route() === "remote"
                    ? "Connecting…"
                    : "Saving…"
                  : props.reviewing
                    ? "Save changes"
                    : route() === "remote"
                      ? invitePreview()
                        ? "Connect to host"
                        : "Review invitation"
                      : selectedProvider()
                        ? `Continue with ${providerName(selectedProvider())}`
                        : "Choose a provider"}
              </Button>
            </div>
          </Show>
        </Dialog.Content>
      </main>
    </Dialog.Root>
  );
}

function RouteArrow() {
  return (
    <svg class="setup-route-arrow" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10h11M11 6l4 4-4 4" />
    </svg>
  );
}

function permissionState(
  permissions: MacPermissionsState,
  permission: MacPermissionId,
): MacPermissionsState["screenRecording"] {
  return permission === "screen-recording" ? permissions.screenRecording : permissions.accessibility;
}

function permissionLabel(
  state: MacPermissionsState["screenRecording"],
): "Allowed" | "Open Settings" | "Restricted" | "Allow" {
  if (state === "granted") return "Allowed";
  if (state === "denied" || state === "unknown") return "Open Settings";
  if (state === "restricted") return "Restricted";
  return "Allow";
}

function providerName(provider: AgentProviderId | null): "Claude" | "Codex" {
  return provider === "claude" ? "Claude" : "Codex";
}

function fallbackProviderState(status: AgentStatus): AgentProviderState {
  return status.phase === "starting" || status.phase === "restarting" ? "checking" : "error";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

import type {
  AgentProviderId,
  AgentStatus,
  AppInfo,
  AvatarImageInput,
  CentralAuthUser,
  ProviderRuntimeStatus,
  UpdateStatus,
} from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import type { GeneralSettingsValue } from "../app-settings";
import { normalizeAvatarFile } from "../avatar-image";
import { presentUpdateStatus } from "../update-status";
import { ProviderPicker, type ProviderPickerOption } from "./ProviderPicker";
import { SettingsDialogShell } from "./SettingsDialogShell";
import {
  Badge,
  Bell,
  Button,
  Card,
  Field,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Palette,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Settings,
  SettingsSection,
  SlidersHorizontal,
  SwitchField,
  Tabs,
  Text,
  UserAvatar,
  UserRound,
} from "./ui";

export interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: GeneralSettingsValue;
  onValueChange: (value: GeneralSettingsValue) => void;
  appInfo: AppInfo | null;
  updateStatus: UpdateStatus;
  onUpdateAction: () => Promise<void>;
  account: CentralAuthUser;
  onUpdateAccountAvatar: (image: AvatarImageInput | null) => Promise<void>;
  processAvatarFile?: (file: File) => Promise<AvatarImageInput>;
  agentStatus?: AgentStatus;
  providerRuntimeStatuses?: Partial<Record<AgentProviderId, ProviderRuntimeStatus>>;
  onDownloadProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onCancelProviderDownload?: (provider: AgentProviderId) => void | Promise<void>;
  onConnectProvider?: (provider: AgentProviderId) => void | Promise<void>;
  restoreFocusTarget?: HTMLElement | null;
}

type SettingsTab = "general" | "profile";

type SettingsNavItem =
  | { value: SettingsTab; label: string; icon: typeof Settings; enabled: true }
  | {
      value: "appearance" | "notifications" | "advanced";
      label: string;
      icon: typeof Settings;
      enabled: false;
    };

const navItems: ReadonlyArray<SettingsNavItem> = [
  { value: "general", label: "General", icon: Settings, enabled: true },
  { value: "profile", label: "Profile", icon: UserRound, enabled: true },
  { value: "appearance", label: "Appearance", icon: Palette, enabled: false },
  { value: "notifications", label: "Notifications", icon: Bell, enabled: false },
  { value: "advanced", label: "Advanced", icon: SlidersHorizontal, enabled: false },
];

const linkTargetOptions: GeneralSettingsValue["externalLinkTarget"][] = ["Default browser", "OpenBot"];

export function SettingsModal(props: SettingsModalProps) {
  const [activeTab, setActiveTab] = createSignal<SettingsTab>("general");
  const [profileName, setProfileName] = createSignal("");
  const [avatarBusy, setAvatarBusy] = createSignal(false);
  const [avatarError, setAvatarError] = createSignal<string | null>(null);
  const [updateError, setUpdateError] = createSignal<string | null>(null);
  const [selectedProvider, setSelectedProvider] = createSignal<AgentProviderId | null>(null);
  let modalElement: HTMLElement | undefined;
  let avatarFileInput: HTMLInputElement | undefined;

  const accountName = () => props.account.name?.trim() || props.account.email.split("@")[0] || props.account.email;

  createEffect(
    () => props.account.name,
    () => {
      setProfileName(accountName());
    },
  );

  const title = () => (activeTab() === "general" ? "General" : "Profile");
  const description = () =>
    activeTab() === "general" ? "Control how OpenBot behaves on this computer." : "Manage how you appear in OpenBot.";
  const updatePresentation = createMemo(() => presentUpdateStatus(props.updateStatus));
  const installedVersion = () => props.updateStatus.currentVersion || props.appInfo?.version || "Unknown";
  const updateMessage = () =>
    updateError() ??
    (props.updateStatus.phase === "error" ? props.updateStatus.message : null) ??
    (props.updateStatus.phase === "up-to-date" ? "OpenBot is up to date." : "Installed version");
  const providerOptions = createMemo<ProviderPickerOption[]>(() =>
    (["codex", "claude", "grok"] as const).map((provider) => {
      const agent = props.agentStatus?.providers?.find((candidate) => candidate.id === provider);
      const runtime = props.providerRuntimeStatuses?.[provider];
      return {
        id: provider,
        name: provider === "codex" ? "ChatGPT" : provider === "claude" ? "Claude" : "Grok",
        description: "Available on this computer",
        state: agent?.state ?? "not-installed",
        message: agent?.message,
        email: agent?.email,
        connectionState: agent?.connectionState,
        checkError: agent?.checkError,
        runtimeStatus:
          runtime?.phase === "not-downloaded" && (agent?.state === "available" || agent?.state === "sign-in-required")
            ? { ...runtime, phase: "ready", version: agent.version ?? null }
            : runtime,
      };
    }),
  );
  const tabsProps = {
    get value() {
      return activeTab();
    },
    onChange(value: string) {
      if (value === "general" || value === "profile") setActiveTab(value);
    },
    orientation: "vertical" as const,
    activationMode: "automatic" as const,
  };

  function updateSetting<Key extends keyof GeneralSettingsValue>(key: Key, value: GeneralSettingsValue[Key]): void {
    props.onValueChange({ ...props.value, [key]: value });
  }

  async function runUpdateAction(): Promise<void> {
    if (updatePresentation().busy || !updatePresentation().supported) return;
    setUpdateError(null);
    try {
      await props.onUpdateAction();
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : "Could not update OpenBot.");
    }
  }

  async function updateAvatar(image: AvatarImageInput | null): Promise<void> {
    if (avatarBusy()) return;
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      await props.onUpdateAccountAvatar(image);
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : "Could not update your profile photo.");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function uploadAvatar(file: File | undefined): Promise<void> {
    if (!file || avatarBusy()) return;
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const image = await (props.processAvatarFile ?? normalizeAvatarFile)(file);
      await props.onUpdateAccountAvatar(image);
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : "Could not process your profile photo.");
    } finally {
      setAvatarBusy(false);
      if (avatarFileInput) avatarFileInput.value = "";
    }
  }

  return (
    <Tabs.Root {...tabsProps} class="settings-modal-tabs-root">
      <SettingsDialogShell
        class="app-settings-modal-shell"
        open={props.open}
        onOpenChange={props.onOpenChange}
        title={title()}
        description={description()}
        contentKey={activeTab()}
        restoreFocusTarget={props.restoreFocusTarget}
        onContentElement={(element) => (modalElement = element)}
        sidebar={
          <Tabs.List class="settings-modal-nav" aria-label="Settings sections">
            {navItems.map((item) => {
              const NavIcon = item.icon;
              return (
                <Tabs.Trigger
                  class="settings-modal-nav-item"
                  value={item.value}
                  disabled={!item.enabled}
                  title={item.enabled ? undefined : "Coming soon"}
                  aria-current={activeTab() === item.value ? "page" : undefined}
                >
                  <NavIcon aria-hidden="true" />
                  <span>{item.label}</span>
                  {!item.enabled && (
                    <span class="settings-modal-nav-status" aria-hidden="true">
                      Soon
                    </span>
                  )}
                </Tabs.Trigger>
              );
            })}
          </Tabs.List>
        }
      >
        <Tabs.Content value="general" class="settings-modal-tab-panel" data-tab="general">
          <SettingsSection title="AI providers">
            <ProviderPicker
              value={selectedProvider()}
              options={providerOptions()}
              ariaLabel="AI providers"
              embedded
              allowUnavailableSelection
              onChange={setSelectedProvider}
              onDownloadProvider={props.onDownloadProvider}
              onCancelProviderDownload={props.onCancelProviderDownload}
              onConnectProvider={props.onConnectProvider}
            />
          </SettingsSection>

          <SettingsSection title="App behavior">
            <ItemGroup class="settings-modal-card" surface="subtle">
              <SwitchField
                checked={props.value.launchAtLogin}
                onChange={(checked) => updateSetting("launchAtLogin", checked)}
                label="Launch OpenBot at login"
                description="Open the app when you sign in to this computer."
              />
              <SwitchField
                checked={props.value.keepRunningInBackground}
                onChange={(checked) => updateSetting("keepRunningInBackground", checked)}
                label="Keep OpenBot running in the background"
                description="Keep active tasks running after you close the window."
              />
            </ItemGroup>
          </SettingsSection>

          <SettingsSection title="Workspace">
            <ItemGroup class="settings-modal-card" surface="subtle">
              <SwitchField
                checked={props.value.restoreLastWorkspace}
                onChange={(checked) => updateSetting("restoreLastWorkspace", checked)}
                label="Restore the last workspace on launch"
                description="Open the workspace and tasks from your previous session."
              />
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemTitle>Open external links in</ItemTitle>
                  <ItemDescription>Choose where links from conversations open.</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Select<GeneralSettingsValue["externalLinkTarget"]>
                    class="settings-modal-select"
                    options={linkTargetOptions}
                    value={props.value.externalLinkTarget}
                    onChange={(value) => value && updateSetting("externalLinkTarget", value)}
                    placement="bottom-end"
                    itemComponent={(selectProps) => (
                      <SelectItem item={selectProps.item}>{selectProps.item.rawValue}</SelectItem>
                    )}
                  >
                    <SelectTrigger size="sm" aria-label="Open external links in">
                      <SelectValue<GeneralSettingsValue["externalLinkTarget"]>>
                        {(state) => state.selectedOption()}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent mount={modalElement} />
                  </Select>
                </ItemActions>
              </Item>
            </ItemGroup>
          </SettingsSection>

          <SettingsSection title="Notifications">
            <ItemGroup class="settings-modal-card" surface="subtle">
              <SwitchField
                checked={props.value.desktopNotifications}
                onChange={(checked) => updateSetting("desktopNotifications", checked)}
                label="Desktop notifications"
                description="Show a notification when an agent needs attention."
              />
              <SwitchField
                checked={props.value.taskCompletionSound}
                onChange={(checked) => updateSetting("taskCompletionSound", checked)}
                label="Play a sound when a task finishes"
                description="Use a short sound for completed tasks."
              />
            </ItemGroup>
          </SettingsSection>

          <Show when={props.appInfo?.platform === "darwin"}>
            <SettingsSection title="MacBook notch">
              <ItemGroup class="settings-modal-card" surface="subtle">
                <SwitchField
                  checked={props.value.macBookNotch}
                  onChange={(checked) => updateSetting("macBookNotch", checked)}
                  label="Show status in the MacBook notch"
                  description="Show bot activity and items that need attention at the top of each display."
                />
                <SwitchField
                  checked={props.value.macBookNotchIdle}
                  disabled={!props.value.macBookNotch}
                  onChange={(checked) => updateSetting("macBookNotchIdle", checked)}
                  label="Show idle island"
                  description="Show the OpenBot logo and greeting when no status is active."
                />
                <SwitchField
                  checked={props.value.macBookNotchAdditionalDisplays}
                  disabled={!props.value.macBookNotch}
                  onChange={(checked) => updateSetting("macBookNotchAdditionalDisplays", checked)}
                  label="Show on additional displays"
                  description="Show Dynamic Island on connected external displays."
                />
                <SwitchField
                  checked={props.value.macBookNotchHaptics}
                  disabled={!props.value.macBookNotch}
                  onChange={(checked) => updateSetting("macBookNotchHaptics", checked)}
                  label="Haptic feedback"
                  description="Use the Force Touch trackpad to confirm Dynamic Island interactions."
                />
              </ItemGroup>
            </SettingsSection>
          </Show>

          <SettingsSection title="Updates">
            <ItemGroup class="settings-modal-card" surface="subtle">
              <SwitchField
                checked={props.value.autoDownloadUpdates}
                onChange={(checked) => updateSetting("autoDownloadUpdates", checked)}
                label="Automatically download updates"
                description="Download new versions when they become available."
              />
              <Item class="settings-modal-row settings-modal-update-row">
                <ItemContent>
                  <ItemTitle>OpenBot version</ItemTitle>
                  <ItemDescription
                    class={updateError() || props.updateStatus.phase === "error" ? "settings-modal-error" : undefined}
                  >
                    {updateMessage()}
                  </ItemDescription>
                </ItemContent>
                <ItemActions class="settings-modal-update-actions">
                  <Badge tone={props.updateStatus.phase === "up-to-date" ? "success" : "accent"}>
                    v{installedVersion()}
                  </Badge>
                  <Button
                    variant="outline"
                    type="button"
                    size="sm"
                    loading={updatePresentation().busy}
                    loadingLabel={updatePresentation().actionLabel}
                    disabled={!updatePresentation().supported}
                    onClick={() => void runUpdateAction()}
                  >
                    {updatePresentation().supported ? updatePresentation().actionLabel : "Updates unavailable"}
                  </Button>
                </ItemActions>
              </Item>
            </ItemGroup>
          </SettingsSection>

          <SettingsSection title="Privacy">
            <ItemGroup class="settings-modal-card" surface="subtle">
              <SwitchField
                checked={props.value.productAnalytics}
                onChange={(checked) => updateSetting("productAnalytics", checked)}
                label="Share product analytics"
                description="Send usage and reliability metadata with your account ID and email to OpenBot's self-hosted analytics."
              />
            </ItemGroup>
          </SettingsSection>
        </Tabs.Content>

        <Tabs.Content value="profile" class="settings-modal-tab-panel" data-tab="profile">
          <SettingsSection title="Account">
            <Card class="settings-modal-card settings-modal-profile-card">
              <div class="settings-modal-profile-summary">
                <UserAvatar user={props.account} class="settings-modal-avatar" decorative />
                <div class="settings-modal-profile-copy">
                  <span class="settings-modal-row-title">{accountName()}</span>
                  <Text tone="muted" variant="caption">
                    {props.account.email}
                  </Text>
                </div>
                <div class="settings-modal-profile-actions">
                  <Input
                    ref={(element) => (avatarFileInput = element)}
                    class="sr-only"
                    type="file"
                    aria-label="Upload profile photo"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) => void uploadAvatar(event.currentTarget.files?.[0])}
                  />
                  <Button
                    variant="outline"
                    type="button"
                    size="sm"
                    loading={avatarBusy()}
                    loadingLabel="Updating…"
                    onClick={() => avatarFileInput?.click()}
                  >
                    Change photo
                  </Button>
                  <Show when={props.account.avatarUrl}>
                    <Button
                      variant="destructive-ghost"
                      type="button"
                      size="sm"
                      disabled={avatarBusy()}
                      onClick={() => void updateAvatar(null)}
                    >
                      Remove
                    </Button>
                  </Show>
                </div>
              </div>
              <Show when={avatarError()}>{(message) => <p class="settings-modal-profile-error">{message()}</p>}</Show>
            </Card>
          </SettingsSection>

          <SettingsSection title="Profile details">
            <Card class="settings-modal-card settings-modal-profile-fields">
              <Field
                label="Display name"
                description="This name is visible in shared workspaces."
                htmlFor="settings-profile-name"
              >
                <Input id="settings-profile-name" value={profileName()} onValueChange={setProfileName} />
              </Field>
              <SwitchField
                defaultChecked
                label="Show activity status"
                description="Let workspace members see when you are active."
              />
            </Card>
          </SettingsSection>
        </Tabs.Content>
      </SettingsDialogShell>
    </Tabs.Root>
  );
}

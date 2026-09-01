import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentProviderId,
  AgentStatus,
  AppInfo,
  AvatarImageInput,
  CentralAuthUser,
  ProviderRuntimeStatus,
  UpdateStatus,
} from "@openbot/contracts/ipc";
import { normalizeAccountName, validateProfileName } from "@openbot/contracts/validation";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import type { GeneralSettingsValue } from "../app-settings";
import { normalizeAvatarFile } from "../avatar-image";
import { presentUpdateStatus } from "../update-status";
import { ProviderPicker, type ProviderPickerOption } from "./ProviderPicker";
import { SettingsDialogShell } from "./SettingsDialogShell";
import {
  Button,
  CircleArrowDown,
  ImageRemoveButton,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Settings,
  SettingsSection,
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
  onUpdateAccountName: (name: string) => Promise<void>;
  onUpdateAccountAvatar: (image: AvatarImageInput | null) => Promise<void>;
  processAvatarFile?: (file: File) => Promise<AvatarImageInput>;
  agentStatus?: AgentStatus;
  providerRuntimeStatuses?: Partial<Record<AgentProviderId, ProviderRuntimeStatus>>;
  onDownloadProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onCancelProviderDownload?: (provider: AgentProviderId) => void | Promise<void>;
  onConnectProvider?: (provider: AgentProviderId) => void | Promise<void>;
  restoreFocusTarget?: HTMLElement | null;
}

type SettingsTab = "general" | "profile" | "updates";

type SettingsNavItem = { value: SettingsTab; label: string; icon: typeof Settings };

const navItems: ReadonlyArray<SettingsNavItem> = [
  { value: "general", label: "General", icon: Settings },
  { value: "profile", label: "Profile", icon: UserRound },
  { value: "updates", label: "Updates", icon: CircleArrowDown },
];

const tabDetails: Record<SettingsTab, { title: string; description: string }> = {
  general: { title: "General", description: "Control how OpenBot behaves on this computer." },
  profile: { title: "Profile", description: "Manage how you appear in OpenBot." },
  updates: { title: "Updates", description: "Keep OpenBot current on this computer." },
};

const linkTargetOptions: GeneralSettingsValue["externalLinkTarget"][] = ["Default browser", "OpenBot"];
type UpdateTrack = "Stable";
const updateTrackOptions: UpdateTrack[] = ["Stable"];

export function SettingsModal(props: SettingsModalProps) {
  const [activeTab, setActiveTab] = createSignal<SettingsTab>("general");
  const [savedProfileName, setSavedProfileName] = createSignal("");
  const [profileName, setProfileName] = createSignal("");
  const [profileNameTouched, setProfileNameTouched] = createSignal(false);
  const [profileNameBusy, setProfileNameBusy] = createSignal(false);
  const [profileSaveError, setProfileSaveError] = createSignal<string | null>(null);
  const [avatarBusy, setAvatarBusy] = createSignal(false);
  const [avatarError, setAvatarError] = createSignal<string | null>(null);
  const [updateError, setUpdateError] = createSignal<string | null>(null);
  const [selectedProvider, setSelectedProvider] = createSignal<AgentProviderId | null>(null);
  let modalElement: HTMLElement | undefined;
  let avatarFileInput: HTMLInputElement | undefined;
  let profileNameInput: HTMLInputElement | undefined;

  const accountName = () => props.account.name?.trim() || props.account.email.split("@")[0] || props.account.email;

  createEffect(
    () => props.account.name,
    () => {
      const name = accountName();
      setSavedProfileName(normalizeAccountName(name));
      setProfileName(name);
      setProfileNameTouched(false);
      setProfileSaveError(null);
    },
  );

  const profileNameValidation = createMemo(() => validateProfileName(profileName()));
  const normalizedProfileName = () => profileNameValidation().name;
  const profileNameError = () => {
    switch (profileNameValidation().error) {
      case "unsafe":
        return "Remove line breaks and hidden or control characters.";
      case "required":
        return "Enter a display name.";
      case "too-short":
        return `Use at least ${INPUT_LIMITS.profileNameMin} characters.`;
      case "too-long":
        return `Use no more than ${INPUT_LIMITS.profileName} characters.`;
      case null:
        return null;
    }
  };
  const visibleProfileNameError = () => profileSaveError() ?? (profileNameTouched() ? profileNameError() : null);
  const profileNameDirty = () => normalizedProfileName() !== savedProfileName();

  const title = () => tabDetails[activeTab()].title;
  const description = () => tabDetails[activeTab()].description;
  const updatePresentation = createMemo(() => presentUpdateStatus(props.updateStatus));
  const installedVersion = () => props.updateStatus.currentVersion || props.appInfo?.version || "Unknown";
  const targetUpdate = () =>
    props.updateStatus.availableVersion
      ? `OpenBot v${props.updateStatus.availableVersion}`
      : "The latest OpenBot update";
  const updateMessage = () => {
    if (updateError()) return updateError();
    switch (props.updateStatus.phase) {
      case "idle":
        return "Check for updates to find the latest Stable release.";
      case "checking":
        return "Checking the Stable track for updates…";
      case "available":
        return `${targetUpdate()} is available to download.`;
      case "downloading":
        return `Downloading ${targetUpdate()}${
          props.updateStatus.progress === null ? "…" : ` · ${Math.round(props.updateStatus.progress)}%`
        }`;
      case "preparing":
        return `Preparing ${targetUpdate()}…`;
      case "ready":
        return `${targetUpdate()} is ready. Restart to apply.`;
      case "installing":
        return `Restarting to apply ${targetUpdate()}…`;
      case "up-to-date":
        return "OpenBot is up to date on the Stable track.";
      case "error":
        return props.updateStatus.message ?? "OpenBot could not check for updates.";
      case "unsupported":
        return props.updateStatus.message ?? "Updates are unavailable in this build.";
    }
  };
  const updateMessageClass = () => {
    if (updateError() || props.updateStatus.phase === "error")
      return "settings-modal-update-status settings-modal-error";
    if (["available", "downloading", "preparing", "ready", "installing"].includes(props.updateStatus.phase)) {
      return "settings-modal-update-status settings-modal-update-status-active";
    }
    return "settings-modal-update-status";
  };
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
      if (value === "general" || value === "profile" || value === "updates") setActiveTab(value);
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

  function updateProfileName(value: string): void {
    setProfileName(value);
    setProfileSaveError(null);
    if (validateProfileName(value).error) return;
    setProfileNameTouched(false);
  }

  function resetProfileName(): void {
    setProfileName(savedProfileName());
    setProfileNameTouched(false);
    setProfileSaveError(null);
  }

  async function saveProfileName(): Promise<void> {
    if (profileNameBusy()) return;
    setProfileNameTouched(true);
    setProfileSaveError(null);
    if (profileNameError()) {
      queueMicrotask(() => profileNameInput?.focus({ preventScroll: true }));
      return;
    }
    if (!profileNameDirty()) return;
    const name = normalizedProfileName();
    setProfileNameBusy(true);
    try {
      await props.onUpdateAccountName(name);
      setSavedProfileName(name);
      setProfileName(name);
      setProfileNameTouched(false);
    } catch (error) {
      setProfileSaveError(error instanceof Error ? error.message : "Could not update your display name.");
      queueMicrotask(() => profileNameInput?.focus({ preventScroll: true }));
    } finally {
      setProfileNameBusy(false);
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
        footer={
          <Show when={profileNameDirty()}>
            <section class="settings-modal-save-bar" aria-label="Unsaved changes">
              <Text variant="caption" tone="muted">
                Changes not saved
              </Text>
              <div class="settings-modal-save-actions">
                <Button type="button" size="sm" variant="ghost" disabled={profileNameBusy()} onClick={resetProfileName}>
                  Reset
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  loading={profileNameBusy()}
                  loadingLabel="Saving…"
                  disabled={profileNameBusy()}
                  onClick={() => void saveProfileName()}
                >
                  Save
                </Button>
              </div>
            </section>
          </Show>
        }
        sidebar={
          <Tabs.List class="settings-modal-nav" aria-label="Settings sections">
            {navItems.map((item) => {
              const NavIcon = item.icon;
              return (
                <Tabs.Trigger
                  class="settings-modal-nav-item"
                  value={item.value}
                  aria-current={activeTab() === item.value ? "page" : undefined}
                >
                  <NavIcon aria-hidden="true" />
                  <span>{item.label}</span>
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
            <ItemGroup class="settings-modal-card">
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
            <ItemGroup class="settings-modal-card">
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
            <ItemGroup class="settings-modal-card">
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
              <ItemGroup class="settings-modal-card">
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

          <SettingsSection title="Privacy">
            <ItemGroup class="settings-modal-card">
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
          <SettingsSection title="Identity">
            <Input
              ref={(element) => (avatarFileInput = element)}
              class="sr-only"
              type="file"
              aria-label="Upload profile photo"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => void uploadAvatar(event.currentTarget.files?.[0])}
            />
            <ItemGroup class="settings-modal-card">
              <Item class="settings-identity-name-row">
                <ItemContent>
                  <ItemTitle id="settings-profile-name-label">Display name</ItemTitle>
                  <ItemDescription id="settings-profile-name-description">
                    Visible in shared workspaces.
                  </ItemDescription>
                </ItemContent>
                <ItemActions
                  class="settings-identity-name-control"
                  data-invalid={visibleProfileNameError() ? "" : undefined}
                >
                  <Input
                    ref={(element) => (profileNameInput = element)}
                    class="settings-identity-name-input"
                    id="settings-profile-name"
                    size="md"
                    value={profileName()}
                    aria-labelledby="settings-profile-name-label"
                    aria-describedby={
                      visibleProfileNameError() ? "settings-profile-name-error" : "settings-profile-name-description"
                    }
                    aria-invalid={visibleProfileNameError() ? "true" : undefined}
                    onValueChange={updateProfileName}
                    onBlur={() => {
                      if (!profileNameDirty()) return;
                      setProfileNameTouched(true);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || event.isComposing) return;
                      event.preventDefault();
                      void saveProfileName();
                    }}
                  />
                  <span
                    id="settings-profile-name-error"
                    class="ui-field-error settings-identity-name-error"
                    role="alert"
                    aria-hidden={visibleProfileNameError() ? undefined : "true"}
                  >
                    {visibleProfileNameError() ?? ""}
                  </span>
                </ItemActions>
              </Item>
              <Item class="settings-identity-image-row">
                <ItemContent>
                  <ItemTitle>Profile photo</ItemTitle>
                  <ItemDescription class={avatarError() ? "settings-modal-error" : undefined}>
                    {avatarError() ?? "Shown with your profile in OpenBot."}
                  </ItemDescription>
                </ItemContent>
                <ItemActions class="settings-identity-image-control">
                  <div class="settings-identity-image-picker ui-removable-image">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-lg"
                      class="settings-identity-image-trigger settings-modal-profile-photo-trigger"
                      aria-label={props.account.avatarUrl ? "Edit profile photo" : "Add profile photo"}
                      disabled={avatarBusy()}
                      onClick={() => avatarFileInput?.click()}
                    >
                      <UserAvatar user={props.account} class="settings-modal-avatar" decorative />
                    </Button>
                    <Show when={props.account.avatarUrl && !avatarBusy()}>
                      <ImageRemoveButton label="Remove profile photo" onClick={() => void updateAvatar(null)} />
                    </Show>
                  </div>
                </ItemActions>
              </Item>
            </ItemGroup>
          </SettingsSection>

          <SettingsSection title="Account">
            <ItemGroup class="settings-modal-card">
              <Item class="settings-modal-account-email-row">
                <ItemContent>
                  <ItemTitle>Email</ItemTitle>
                  <ItemDescription>Used to sign in to OpenBot.</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Text as="span" class="settings-modal-readonly-value" variant="body">
                    {props.account.email}
                  </Text>
                </ItemActions>
              </Item>
            </ItemGroup>
          </SettingsSection>
        </Tabs.Content>

        <Tabs.Content value="updates" class="settings-modal-tab-panel" data-tab="updates">
          <SettingsSection title="OpenBot updates">
            <ItemGroup class="settings-modal-card">
              <Item class="settings-modal-row settings-modal-update-track-row">
                <ItemContent>
                  <ItemTitle>Update track</ItemTitle>
                  <ItemDescription>Stable receives tested OpenBot releases.</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Select<UpdateTrack>
                    class="settings-modal-update-track-select"
                    options={updateTrackOptions}
                    value="Stable"
                    onChange={() => undefined}
                    placement="bottom-end"
                    itemComponent={(selectProps) => (
                      <SelectItem item={selectProps.item}>{selectProps.item.rawValue}</SelectItem>
                    )}
                  >
                    <SelectTrigger size="sm" aria-label="Update track">
                      <SelectValue<UpdateTrack>>{(state) => state.selectedOption()}</SelectValue>
                    </SelectTrigger>
                    <SelectContent mount={modalElement} />
                  </Select>
                </ItemActions>
              </Item>
              <Item class="settings-modal-row settings-modal-update-row">
                <ItemContent>
                  <ItemTitle>Version {installedVersion()}</ItemTitle>
                  <ItemDescription>Updates follow the Stable track.</ItemDescription>
                  <ItemDescription class={updateMessageClass()}>{updateMessage()}</ItemDescription>
                </ItemContent>
                <ItemActions class="settings-modal-update-actions">
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
              <SwitchField
                checked={props.value.autoDownloadUpdates}
                onChange={(checked) => updateSetting("autoDownloadUpdates", checked)}
                label="Automatically download updates"
                description="Download new versions when they become available."
              />
            </ItemGroup>
          </SettingsSection>
        </Tabs.Content>
      </SettingsDialogShell>
    </Tabs.Root>
  );
}

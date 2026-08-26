import type { AppInfo, UpdateStatus } from "@openbot/contracts/ipc";
import { createMemo, createSignal } from "solid-js";
import type { GeneralSettingsValue } from "../app-settings";
import { presentUpdateStatus } from "../update-status";
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
  const [profileName, setProfileName] = createSignal("OpenBot user");
  const [updateError, setUpdateError] = createSignal<string | null>(null);
  let modalElement: HTMLElement | undefined;

  const title = () => (activeTab() === "general" ? "General" : "Profile");
  const description = () =>
    activeTab() === "general" ? "Control how OpenBot behaves on this computer." : "Manage how you appear in OpenBot.";
  const updatePresentation = createMemo(() => presentUpdateStatus(props.updateStatus));
  const installedVersion = () => props.updateStatus.currentVersion || props.appInfo?.version || "Unknown";
  const updateMessage = () =>
    updateError() ??
    (props.updateStatus.phase === "error" ? props.updateStatus.message : null) ??
    (props.updateStatus.phase === "up-to-date" ? "OpenBot is up to date." : "Installed version");
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

  return (
    <Tabs.Root {...tabsProps}>
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
        </Tabs.Content>

        <Tabs.Content value="profile" class="settings-modal-tab-panel" data-tab="profile">
          <SettingsSection title="Account">
            <Card class="settings-modal-card settings-modal-profile-card">
              <div class="settings-modal-profile-summary">
                <div class="settings-modal-avatar" aria-hidden="true">
                  OB
                </div>
                <div class="settings-modal-profile-copy">
                  <span class="settings-modal-row-title">{profileName()}</span>
                  <Text tone="muted" variant="caption">
                    person@example.com
                  </Text>
                </div>
                <Button variant="outline" type="button" size="sm">
                  Change avatar
                </Button>
              </div>
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

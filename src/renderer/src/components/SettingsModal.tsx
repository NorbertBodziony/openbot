import { createSignal, Show } from "solid-js";
import { SettingsDialogShell } from "./SettingsDialogShell";
import {
  Badge,
  Bell,
  Button,
  Card,
  Check,
  ChevronDown,
  Field,
  Heading,
  Input,
  Palette,
  Select,
  Settings,
  SlidersHorizontal,
  Switch,
  Text,
  UserRound,
} from "./ui";

export interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

const linkTargetOptions = ["Default browser", "OpenBot"];

export function SettingsModal(props: SettingsModalProps) {
  const [activeTab, setActiveTab] = createSignal<SettingsTab>("general");
  const [linkTarget, setLinkTarget] = createSignal("Default browser");
  const [profileName, setProfileName] = createSignal("OpenBot user");
  const [updateChecked, setUpdateChecked] = createSignal(false);
  let modalElement: HTMLElement | undefined;

  function selectTab(tab: SettingsTab): void {
    setActiveTab(tab);
  }

  const title = () => (activeTab() === "general" ? "General" : "Profile");
  const description = () =>
    activeTab() === "general" ? "Control how OpenBot behaves on this computer." : "Manage how you appear in OpenBot.";

  return (
    <SettingsDialogShell
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={title()}
      description={description()}
      contentKey={activeTab()}
      onContentElement={(element) => (modalElement = element)}
      sidebar={
        <>
          <Text class="settings-modal-label" variant="label" tone="secondary">
            Settings
          </Text>
          <nav class="settings-modal-nav" aria-label="Settings sections">
            {navItems.map((item) => {
              const NavIcon = item.icon;
              return (
                <Button
                  type="button"
                  class="settings-modal-nav-item"
                  variant="ghost"
                  aria-current={activeTab() === item.value ? "page" : undefined}
                  disabled={!item.enabled}
                  title={item.enabled ? undefined : "Coming soon"}
                  onClick={() => item.enabled && selectTab(item.value)}
                >
                  <NavIcon aria-hidden="true" />
                  <span>{item.label}</span>
                  {!item.enabled && (
                    <span class="settings-modal-nav-status" aria-hidden="true">
                      Soon
                    </span>
                  )}
                </Button>
              );
            })}
          </nav>
        </>
      }
    >
      <Show
        when={activeTab() === "general"}
        fallback={
          <div class="settings-modal-tab-panel" data-tab="profile">
            <section class="settings-modal-group" aria-labelledby="settings-profile-account">
              <Heading id="settings-profile-account" as="h3" size="sm" tone="secondary">
                Account
              </Heading>
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
                  <Button type="button" size="sm">
                    Change avatar
                  </Button>
                </div>
              </Card>
            </section>

            <section class="settings-modal-group" aria-labelledby="settings-profile-details">
              <Heading id="settings-profile-details" as="h3" size="sm" tone="secondary">
                Profile details
              </Heading>
              <Card class="settings-modal-card settings-modal-profile-fields">
                <Field
                  label="Display name"
                  description="This name is visible in shared workspaces."
                  htmlFor="settings-profile-name"
                >
                  <Input id="settings-profile-name" value={profileName()} onValueChange={setProfileName} />
                </Field>
                <Switch
                  defaultChecked
                  label="Show activity status"
                  description="Let workspace members see when you are active."
                />
              </Card>
            </section>
          </div>
        }
      >
        <div class="settings-modal-tab-panel" data-tab="general">
          <section class="settings-modal-group" aria-labelledby="settings-app-behavior">
            <Heading id="settings-app-behavior" as="h3" size="sm" tone="secondary">
              App behavior
            </Heading>
            <Card class="settings-modal-card">
              <Switch
                defaultChecked
                label="Launch OpenBot at login"
                description="Open the app when you sign in to this computer."
              />
              <Switch
                label="Keep OpenBot running in the background"
                description="Keep active tasks running after you close the window."
              />
            </Card>
          </section>

          <section class="settings-modal-group" aria-labelledby="settings-workspace">
            <Heading id="settings-workspace" as="h3" size="sm" tone="secondary">
              Workspace
            </Heading>
            <Card class="settings-modal-card">
              <Switch
                defaultChecked
                label="Restore the last workspace on launch"
                description="Open the workspace and tasks from your previous session."
              />
              <div class="settings-modal-row">
                <div class="settings-modal-row-copy">
                  <span class="settings-modal-row-title">Open external links in</span>
                  <Text tone="muted" variant="caption">
                    Choose where links from conversations open.
                  </Text>
                </div>
                <Select.Root<string>
                  options={linkTargetOptions}
                  value={linkTarget()}
                  onChange={(value) => value && setLinkTarget(value)}
                  placement="bottom-end"
                  gutter={4}
                  sameWidth
                  itemComponent={(selectProps) => (
                    <Select.Item class="settings-modal-select-item" item={selectProps.item}>
                      <Select.ItemLabel>{selectProps.item.rawValue}</Select.ItemLabel>
                      <Select.ItemIndicator class="settings-modal-select-indicator">
                        <Check aria-hidden="true" />
                      </Select.ItemIndicator>
                    </Select.Item>
                  )}
                >
                  <Select.Trigger class="settings-modal-select-trigger" aria-label="Open external links in">
                    <Select.Value<string>>{(state) => state.selectedOption()}</Select.Value>
                    <ChevronDown aria-hidden="true" />
                  </Select.Trigger>
                  <Select.HiddenSelect />
                  <Select.Portal mount={modalElement}>
                    <Select.Content class="settings-modal-select-content">
                      <Select.Listbox class="settings-modal-select-listbox" />
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              </div>
            </Card>
          </section>

          <section class="settings-modal-group" aria-labelledby="settings-notifications">
            <Heading id="settings-notifications" as="h3" size="sm" tone="secondary">
              Notifications
            </Heading>
            <Card class="settings-modal-card">
              <Switch
                defaultChecked
                label="Desktop notifications"
                description="Show a notification when an agent needs attention."
              />
              <Switch label="Play a sound when a task finishes" description="Use a short sound for completed tasks." />
            </Card>
          </section>

          <section class="settings-modal-group" aria-labelledby="settings-updates">
            <Heading id="settings-updates" as="h3" size="sm" tone="secondary">
              Updates
            </Heading>
            <Card class="settings-modal-card">
              <Switch
                defaultChecked
                label="Automatically download updates"
                description="Download new versions when they become available."
              />
              <div class="settings-modal-row">
                <div class="settings-modal-row-copy">
                  <span class="settings-modal-row-title">OpenBot version</span>
                  <div class="settings-modal-version">
                    <Text tone="muted" variant="caption">
                      Installed version
                    </Text>
                    <Badge tone={updateChecked() ? "success" : "accent"}>
                      {updateChecked() ? "Up to date" : "0.1.11"}
                    </Badge>
                  </div>
                </div>
                <Button type="button" size="sm" onClick={() => setUpdateChecked(true)}>
                  {updateChecked() ? "Checked" : "Check for updates"}
                </Button>
              </div>
            </Card>
          </section>
        </div>
      </Show>
    </SettingsDialogShell>
  );
}

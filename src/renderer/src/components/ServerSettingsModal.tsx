import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AvatarImageInput,
  HostStatus,
  InviteSummary,
  ServerSummary,
  TeamInviteSummary,
  TeamPresenceMember,
  TeamRole,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import { normalizeEmailAddress } from "@openbot/contracts/validation";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { normalizeAvatarFile } from "../avatar-image";
import { SettingsDialogShell } from "./SettingsDialogShell";
import { teamMemberName } from "./TeamPersonAvatar";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  AlertDialog,
  AlertIcon,
  AlertTitle,
  Badge,
  Button,
  buttonVariants,
  Card,
  Check,
  CopyButton,
  DropdownMenu,
  Ellipsis,
  Field,
  Image,
  ImageRemoveButton,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  Search,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Settings,
  SettingsSection,
  ShieldCheck,
  SlidingTabs,
  SwitchField,
  Tabs,
  Text,
  Trash2,
  toast,
  truncateMiddle,
  UserRound,
  UsersRound,
} from "./ui";

export interface ServerSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platform: "darwin" | "win32" | "linux";
  server: ServerSummary;
  hostStatus?: HostStatus | null;
  members: TeamPresenceMember[];
  invites: TeamInviteSummary[];
  loading?: boolean;
  loadError?: string | null;
  restoreFocusTarget?: HTMLElement | null;
  onRetry: () => Promise<void>;
  onSaveIdentity: (input: { serverName: string; logo?: AvatarImageInput | null }) => Promise<void>;
  onSetPublished: (published: boolean) => Promise<void>;
  onCreateInvite: (input: { role: "admin" | "member"; email?: string }) => Promise<InviteSummary>;
  onUpdateMember: (input: UpdateTeamMemberInput) => Promise<void>;
  onRemoveMember: (memberId: string) => Promise<void>;
  onRevokeInvite: (inviteId: string) => Promise<void>;
}

type Section = "general" | "members" | "desktop";
type InviteMode = "link" | "email";
type InviteRole = Exclude<TeamRole, "owner">;

const ROLE_OPTIONS = ["Member", "Admin"];
const INVITE_LINK_PLACEHOLDER = "Create a private one-time link.";
const sections: Record<Section, { title: string; description: string }> = {
  general: { title: "General", description: "Manage this server’s identity and published access." },
  members: { title: "Members", description: "Invite people and manage access to this server." },
  desktop: { title: "Remote desktop", description: "Configure or connect to this server’s desktop." },
};

export function ServerSettingsModal(props: ServerSettingsModalProps) {
  const [section, setSection] = createSignal<Section>("general");
  const [savedName, setSavedName] = createSignal("");
  const [draftName, setDraftName] = createSignal("");
  const [savedLogoUrl, setSavedLogoUrl] = createSignal<string | null>(null);
  const [draftLogoUrl, setDraftLogoUrl] = createSignal<string | null>(null);
  const [draftLogo, setDraftLogo] = createSignal<AvatarImageInput | null | undefined>(undefined);
  const [identityEditing, setIdentityEditing] = createSignal(false);
  const [nameTouched, setNameTouched] = createSignal(false);
  const [nameShaking, setNameShaking] = createSignal(false);
  const [logoError, setLogoError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [inviteMode, setInviteMode] = createSignal<InviteMode>("email");
  const [inviteRole, setInviteRole] = createSignal<InviteRole>("member");
  const [inviteEmail, setInviteEmail] = createSignal("");
  const [inviteEmailError, setInviteEmailError] = createSignal<string | null>(null);
  const [inviteResult, setInviteResult] = createSignal<InviteSummary | null>(null);
  const [inviteLinkValue, setInviteLinkValue] = createSignal("");
  const [memberSearch, setMemberSearch] = createSignal("");
  const [removeMemberId, setRemoveMemberId] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Date.now());
  let modalElement: HTMLElement | undefined;
  let logoInput: HTMLInputElement | undefined;
  let nameInput: HTMLInputElement | undefined;
  let removeMemberTrigger: HTMLElement | undefined;
  let inviteLinkInput: HTMLInputElement | undefined;
  let syncedServerId = "";
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let inviteLinkSwapTimer: ReturnType<typeof setTimeout> | undefined;
  const objectUrls: string[] = [];

  const local = () => props.server.kind === "local";
  const configured = () => (local() ? Boolean(props.hostStatus?.configured) : true);
  const canEditIdentity = () => local();
  const canManage = () => configured() && (local() || props.server.role === "admin" || props.server.role === "owner");
  const actionsAvailable = () => local() || props.server.state === "online";
  const published = () => (local() ? props.hostStatus?.phase === "online" : props.server.state === "online");
  const address = () => (local() ? props.hostStatus?.apiUrl : props.server.apiUrl);
  const trimmedName = () => draftName().trim();
  const nameError = () => {
    if (!canEditIdentity()) return null;
    if (trimmedName().length < INPUT_LIMITS.serverNameMin)
      return `Enter at least ${INPUT_LIMITS.serverNameMin} characters.`;
    if (trimmedName().length > INPUT_LIMITS.serverName)
      return `Use no more than ${INPUT_LIMITS.serverName} characters.`;
    return null;
  };
  const visibleNameError = () => (nameTouched() ? nameError() : null);
  const identityDirty = () =>
    canEditIdentity() &&
    (trimmedName() !== savedName() || draftLogo() !== undefined || draftLogoUrl() !== savedLogoUrl());
  const activeInvites = createMemo(() =>
    props.invites.filter((item) => item.usedAt === null && Date.parse(item.expiresAt) > now()),
  );
  const filteredMembers = createMemo(() => {
    const query = memberSearch().trim().toLowerCase();
    if (!query) return props.members;
    return props.members.filter((member) =>
      [teamMemberName(member), member.email, member.username].some((value) => value?.toLowerCase().includes(query)),
    );
  });
  const removeMember = createMemo(() => props.members.find((member) => member.id === removeMemberId()) ?? null);
  const canInvite = createMemo(
    () =>
      canManage() &&
      published() &&
      busy() === null &&
      (inviteMode() === "link" || normalizeEmailAddress(inviteEmail()) !== null),
  );

  createEffect(
    () => ({
      open: props.open,
      id: props.server.id,
      name: props.server.kind === "local" && !props.hostStatus?.configured ? "" : props.server.name,
      logoUrl: props.server.logoUrl,
      editing: identityEditing(),
    }),
    ({ open, id, name, logoUrl, editing }) => {
      if (!open) return;
      if (syncedServerId !== id) {
        syncedServerId = id;
        setSection("general");
        setIdentityEditing(false);
        setNameTouched(false);
        setNameShaking(false);
        setMemberSearch("");
        setInviteResult(null);
        resetInviteLink();
      }
      if (!editing) {
        setSavedName(name);
        setDraftName(name);
        setSavedLogoUrl(logoUrl);
        setDraftLogoUrl(logoUrl);
        setDraftLogo(undefined);
        setNameTouched(false);
        setNameShaking(false);
      }
    },
  );

  createEffect(
    () => ({ invites: props.invites, currentTime: now() }),
    ({ invites, currentTime }) => {
      const nextExpiry = invites
        .filter((item) => item.usedAt === null)
        .map((item) => Date.parse(item.expiresAt))
        .filter((value) => value > currentTime)
        .sort((left, right) => left - right)[0];
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = nextExpiry
        ? setTimeout(() => setNow(Date.now()), Math.min(nextExpiry - currentTime + 1, 2_147_483_647))
        : undefined;
    },
  );

  onCleanup(() => {
    if (expiryTimer) clearTimeout(expiryTimer);
    if (inviteLinkSwapTimer) clearTimeout(inviteLinkSwapTimer);
    for (const url of objectUrls) URL.revokeObjectURL(url);
  });

  function resetInviteLink(): void {
    if (inviteLinkSwapTimer) clearTimeout(inviteLinkSwapTimer);
    inviteLinkSwapTimer = undefined;
    inviteLinkInput?.classList.remove("is-exit", "is-enter-start");
    setInviteLinkValue("");
  }

  function swapInviteLink(next: string): void {
    const element = inviteLinkInput;
    if (!element || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)) {
      setInviteLinkValue(next);
      return;
    }
    if (inviteLinkSwapTimer) clearTimeout(inviteLinkSwapTimer);
    const duration =
      Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--text-swap-dur")) || 150;
    element.classList.add("is-exit");
    inviteLinkSwapTimer = setTimeout(() => {
      inviteLinkSwapTimer = undefined;
      setInviteLinkValue(next);
      element.classList.remove("is-exit");
      element.classList.add("is-enter-start");
      void element.offsetHeight;
      element.classList.remove("is-enter-start");
    }, duration);
  }

  async function run(key: string, action: () => Promise<void>): Promise<boolean> {
    if (busy()) return false;
    setBusy(key);
    try {
      await action();
      return true;
    } catch (error) {
      toast.error("Server action failed", {
        description: error instanceof Error ? error.message : "The server action failed.",
      });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function chooseLogo(file: File | undefined): Promise<void> {
    if (!file) return;
    setLogoError(null);
    try {
      const image = await normalizeAvatarFile(file);
      const url = URL.createObjectURL(file);
      objectUrls.push(url);
      setIdentityEditing(true);
      setDraftLogo(image);
      setDraftLogoUrl(url);
    } catch (error) {
      setLogoError(error instanceof Error ? error.message : "OpenBot could not read this image.");
    }
  }

  function resetIdentity(): void {
    setDraftName(savedName());
    setDraftLogoUrl(savedLogoUrl());
    setDraftLogo(undefined);
    setIdentityEditing(false);
    setNameTouched(false);
    setNameShaking(false);
    setLogoError(null);
  }

  function updateDraftName(value: string): void {
    const namePristine = value.trim() === savedName();
    const logoPristine = draftLogo() === undefined && draftLogoUrl() === savedLogoUrl();
    setDraftName(value);
    setIdentityEditing(!(namePristine && logoPristine));
    if (namePristine) {
      setNameTouched(false);
      setNameShaking(false);
    } else if (!nameError()) {
      setNameShaking(false);
    }
  }

  function restartNameShake(): void {
    setNameShaking(false);
    queueMicrotask(() => {
      if (!nameInput || !nameError()) return;
      void nameInput.offsetWidth;
      setNameShaking(true);
    });
  }

  async function saveIdentity(): Promise<void> {
    setNameTouched(true);
    if (nameError()) {
      restartNameShake();
      queueMicrotask(() => nameInput?.focus({ preventScroll: true }));
      return;
    }
    if (!identityDirty()) return;
    const logo = draftLogo();
    const saved = await run("identity", () =>
      props.onSaveIdentity({
        serverName: trimmedName(),
        ...(logo === undefined ? {} : { logo }),
      }),
    );
    if (!saved) return;
    setSavedName(trimmedName());
    setSavedLogoUrl(draftLogoUrl());
    setDraftLogo(undefined);
    setIdentityEditing(false);
    setNameTouched(false);
    setNameShaking(false);
  }

  function showCopyError(): void {
    toast.error("Copy failed", { description: "OpenBot could not copy this value." });
  }

  async function createInvite(): Promise<void> {
    const email = inviteMode() === "email" ? normalizeEmailAddress(inviteEmail()) : null;
    if (inviteMode() === "email" && !email) {
      setInviteEmailError("Enter a valid email address.");
      return;
    }
    let result: InviteSummary | undefined;
    const saved = await run("invite", async () => {
      result = await props.onCreateInvite({ role: inviteRole(), ...(email ? { email } : {}) });
    });
    if (!saved || !result) return;
    setInviteResult(result);
    if (!result.email) swapInviteLink(result.inviteUrl);
    setInviteEmailError(null);
    if (email) setInviteEmail("");
  }

  const sectionTabsProps = {
    get value() {
      return section();
    },
    orientation: "vertical" as const,
    activationMode: "automatic" as const,
    onChange(value: string) {
      if (value === "general" || value === "members" || value === "desktop") setSection(value);
    },
  };

  const inviteTabsProps = {
    get value() {
      return inviteMode();
    },
    onChange(value: string) {
      if (value !== "link" && value !== "email") return;
      setInviteMode(value);
      setInviteResult(null);
      resetInviteLink();
      setInviteEmailError(null);
    },
  };

  return (
    <Tabs.Root {...sectionTabsProps} class="settings-modal-tabs-root">
      <SettingsDialogShell
        class="server-settings-modal-shell"
        open={props.open}
        onOpenChange={props.onOpenChange}
        title={sections[section()].title}
        description={sections[section()].description}
        contentKey={`${props.server.id}:${section()}`}
        closeLabel="Close server settings"
        restoreFocusTarget={props.restoreFocusTarget}
        onContentElement={(element) => (modalElement = element)}
        floatingContent={
          <Show when={props.loadError}>
            <Alert
              class="server-settings-error-toast"
              data-with-save-bar={section() === "general" && identityDirty() ? "" : undefined}
              tone="danger"
              role="alert"
            >
              <AlertIcon>
                <ShieldCheck />
              </AlertIcon>
              <AlertContent>
                <AlertTitle>Server settings unavailable</AlertTitle>
                <AlertDescription>{props.loadError}</AlertDescription>
              </AlertContent>
              <AlertActions>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  loading={props.loading}
                  onClick={() => void run("retry", props.onRetry)}
                >
                  <RefreshCw aria-hidden="true" />
                  Retry
                </Button>
              </AlertActions>
            </Alert>
          </Show>
        }
        footer={
          <Show when={section() === "general" && identityDirty()}>
            <section class="settings-modal-save-bar" aria-label="Unsaved changes">
              <Text variant="caption" tone="muted">
                Changes not saved
              </Text>
              <div class="settings-modal-save-actions">
                <Button type="button" size="sm" variant="ghost" disabled={Boolean(busy())} onClick={resetIdentity}>
                  Reset
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  loading={busy() === "identity"}
                  loadingLabel="Saving…"
                  disabled={Boolean(busy())}
                  onClick={() => void saveIdentity()}
                >
                  Save
                </Button>
              </div>
            </section>
          </Show>
        }
        sidebar={
          <Tabs.List class="settings-modal-nav" aria-label="Server settings sections">
            <Tabs.Trigger class="settings-modal-nav-item" value="general">
              <Settings aria-hidden="true" />
              <span>General</span>
            </Tabs.Trigger>
            <Tabs.Trigger class="settings-modal-nav-item" value="members">
              <UsersRound aria-hidden="true" />
              <span>Members</span>
            </Tabs.Trigger>
            <Show when={props.platform === "darwin"}>
              <Tabs.Trigger class="settings-modal-nav-item" value="desktop">
                <Monitor aria-hidden="true" />
                <span>Remote desktop</span>
              </Tabs.Trigger>
            </Show>
          </Tabs.List>
        }
      >
        <Tabs.Content value="general" class="settings-modal-tab-panel server-settings-panel" data-tab="general">
          <GeneralPanel />
        </Tabs.Content>
        <Tabs.Content value="members" class="settings-modal-tab-panel server-settings-panel" data-tab="members">
          <MembersPanel />
        </Tabs.Content>
        <Tabs.Content value="desktop" class="settings-modal-tab-panel server-settings-panel" data-tab="desktop">
          <DesktopPanel />
        </Tabs.Content>
      </SettingsDialogShell>

      <AlertDialog.Root
        open={Boolean(removeMember())}
        onOpenChange={(open) => {
          if (!open && busy() !== `remove:${removeMemberId()}`) setRemoveMemberId(null);
        }}
      >
        <Show when={removeMember()}>
          {(member) => (
            <AlertDialog.Portal>
              <AlertDialog.Overlay class="server-settings-confirm-backdrop">
                <AlertDialog.Content
                  class="server-settings-confirm-dialog"
                  onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    queueMicrotask(() => removeMemberTrigger?.focus({ preventScroll: true }));
                  }}
                >
                  <span class="server-settings-confirm-icon" aria-hidden="true">
                    <Trash2 />
                  </span>
                  <AlertDialog.Title>Remove {teamMemberName(member())}?</AlertDialog.Title>
                  <AlertDialog.Description>
                    This person will lose access to the server and its shared conversations.
                  </AlertDialog.Description>
                  <div class="server-settings-confirm-actions">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy() === `remove:${member().id}`}
                      onClick={() => setRemoveMemberId(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      loading={busy() === `remove:${member().id}`}
                      loadingLabel="Removing…"
                      onClick={() =>
                        void run(`remove:${member().id}`, async () => {
                          await props.onRemoveMember(member().id);
                          setRemoveMemberId(null);
                        })
                      }
                    >
                      Remove member
                    </Button>
                  </div>
                </AlertDialog.Content>
              </AlertDialog.Overlay>
            </AlertDialog.Portal>
          )}
        </Show>
      </AlertDialog.Root>
    </Tabs.Root>
  );

  function GeneralPanel() {
    return (
      <>
        <SettingsSection title="Identity">
          <Input
            ref={(element) => (logoInput = element)}
            hidden
            type="file"
            aria-label="Server logo"
            accept="image/png,image/jpeg,image/webp"
            disabled={!canEditIdentity()}
            onChange={(event) => {
              void chooseLogo(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
          <ItemGroup class="settings-modal-card">
            <Show
              when={canEditIdentity()}
              fallback={
                <Item class="server-settings-readonly-name">
                  <ItemContent>
                    <ItemTitle>Server name</ItemTitle>
                    <ItemDescription>Only the server owner can change this name.</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Text as="span" class="server-settings-readonly-value" variant="body">
                      {props.server.name}
                    </Text>
                  </ItemActions>
                </Item>
              }
            >
              <Item class="settings-identity-name-row">
                <ItemContent>
                  <ItemTitle id="server-settings-name-label">Server name</ItemTitle>
                  <ItemDescription id="server-settings-name-description">
                    Shown in invitations and shared spaces.
                  </ItemDescription>
                </ItemContent>
                <ItemActions class="settings-identity-name-control" data-invalid={visibleNameError() ? "" : undefined}>
                  <Input
                    ref={(element) => (nameInput = element)}
                    class={nameShaking() ? "settings-identity-name-input is-shaking" : "settings-identity-name-input"}
                    id="server-settings-name"
                    size="md"
                    maxlength={INPUT_LIMITS.serverName}
                    placeholder="e.g. Design studio"
                    value={draftName()}
                    aria-labelledby="server-settings-name-label"
                    aria-describedby={
                      visibleNameError() ? "server-settings-name-error" : "server-settings-name-description"
                    }
                    aria-invalid={visibleNameError() ? "true" : undefined}
                    onValueChange={updateDraftName}
                    onBlur={() => {
                      if (trimmedName() === savedName()) return;
                      setNameTouched(true);
                      if (nameError()) restartNameShake();
                    }}
                    onAnimationEnd={() => setNameShaking(false)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || event.isComposing) return;
                      event.preventDefault();
                      void saveIdentity();
                    }}
                  />
                  <span
                    id="server-settings-name-error"
                    class="ui-field-error settings-identity-name-error"
                    role="alert"
                    aria-hidden={visibleNameError() ? undefined : "true"}
                  >
                    {visibleNameError() ?? ""}
                  </span>
                </ItemActions>
              </Item>
            </Show>
            <Item class="settings-identity-image-row">
              <ItemContent>
                <ItemTitle>Server logo</ItemTitle>
                <ItemDescription class={logoError() ? "server-settings-item-error" : undefined}>
                  {logoError() ??
                    (canEditIdentity()
                      ? "Shown to everyone who connects."
                      : "Only the server owner can change this logo.")}
                </ItemDescription>
              </ItemContent>
              <ItemActions class="settings-identity-image-control">
                <Show
                  when={canEditIdentity()}
                  fallback={<ServerLogo name={draftName() || props.server.name} url={draftLogoUrl()} />}
                >
                  <div class="settings-identity-image-picker ui-removable-image">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-lg"
                      class="settings-identity-image-trigger server-settings-logo-trigger"
                      aria-label={draftLogoUrl() ? "Edit server logo" : "Add server logo"}
                      onClick={() => logoInput?.click()}
                    >
                      <Show
                        when={draftLogoUrl()}
                        fallback={<Image class="server-settings-logo-placeholder" aria-hidden="true" />}
                      >
                        {(logoUrl) => <ServerLogo name={draftName() || props.server.name} url={logoUrl()} />}
                      </Show>
                    </Button>
                    <Show when={draftLogoUrl()}>
                      <ImageRemoveButton
                        class="server-settings-logo-remove"
                        label="Remove server logo"
                        onClick={() => {
                          setIdentityEditing(true);
                          setDraftLogoUrl(null);
                          setDraftLogo(null);
                          setLogoError(null);
                        }}
                      />
                    </Show>
                  </div>
                </Show>
              </ItemActions>
            </Item>
          </ItemGroup>
        </SettingsSection>
        <SettingsSection title="Access">
          <ItemGroup class="settings-modal-card">
            <SwitchField
              class="server-settings-publish-setting"
              size="default"
              checked={published()}
              disabled={!local() || !configured() || Boolean(busy())}
              onChange={(value) => void run("publish", () => props.onSetPublished(value))}
              label={local() ? "Publish this server" : "Server is published"}
              description={accessDescription()}
            />
            <Item class="server-settings-address-setting">
              <ItemContent>
                <ItemTitle>Server address</ItemTitle>
                <ItemDescription>Use this address to connect to the server.</ItemDescription>
              </ItemContent>
              <Show
                when={address()}
                fallback={
                  <Badge tone="neutral" size="md" shape="pill">
                    Private
                  </Badge>
                }
              >
                {(serverAddress) => (
                  <CopyButton
                    value={serverAddress()}
                    label={truncateMiddle(serverAddress(), 31)}
                    copiedLabel="Copied"
                    aria-label="Copy server address"
                    title={serverAddress()}
                    onCopyError={showCopyError}
                    class="server-settings-address-control"
                  />
                )}
              </Show>
            </Item>
          </ItemGroup>
        </SettingsSection>
      </>
    );
  }

  function MembersPanel() {
    return (
      <>
        <Show when={!configured() || !published()}>
          <Alert class="server-settings-members-alert" tone="warning" role="status">
            <AlertIcon>
              <ShieldCheck />
            </AlertIcon>
            <AlertContent>
              <AlertTitle>{configured() ? "Invitations are paused" : "Server setup is required"}</AlertTitle>
              <AlertDescription>
                {configured()
                  ? "Publish the server in General to invite new people."
                  : "Save the server identity in General first."}
              </AlertDescription>
            </AlertContent>
          </Alert>
        </Show>
        <Show when={canManage()}>{inviteComposer()}</Show>
        <SettingsSection
          class="server-settings-members-section"
          title="Server members"
          description={<>{props.members.length} members</>}
          actions={
            <label class="server-settings-search">
              <Search aria-hidden="true" />
              <span class="sr-only">Search members</span>
              <Input
                size="sm"
                type="search"
                placeholder="Search members"
                value={memberSearch()}
                onValueChange={setMemberSearch}
              />
            </label>
          }
        >
          <ItemGroup class="settings-modal-card server-settings-members-list" data-testid="server-members-list">
            <Show
              when={filteredMembers().length > 0}
              fallback={
                <Item class="server-settings-empty-row">
                  <ItemContent>
                    <ItemDescription>No members match this search.</ItemDescription>
                  </ItemContent>
                </Item>
              }
            >
              <For each={filteredMembers()}>{(member) => memberRow(member)}</For>
            </Show>
          </ItemGroup>
        </SettingsSection>
        <Show when={canManage()}>{pendingInvites()}</Show>
      </>
    );
  }

  function inviteComposer() {
    return (
      <SlidingTabs.Root {...inviteTabsProps}>
        <SettingsSection
          class="server-settings-invite-section"
          title="Invite people"
          description="Invitations can be used once and expire after 24 hours."
          actions={
            <SlidingTabs.List aria-label="Invitation method">
              <SlidingTabs.Trigger value="email">Email</SlidingTabs.Trigger>
              <SlidingTabs.Trigger value="link">Invite link</SlidingTabs.Trigger>
            </SlidingTabs.List>
          }
        >
          <Card class="server-settings-invite-card">
            <div class="server-settings-invite-composer">
              <SlidingTabs.ContentSlot>
                <SlidingTabs.Content value="email" class="server-settings-invite-mode-panel">
                  <Field class="server-settings-invite-email-field" label="Email address" error={inviteEmailError()}>
                    <Input
                      size="md"
                      type="email"
                      autocomplete="email"
                      maxlength={INPUT_LIMITS.email}
                      disabled={!published()}
                      placeholder="person@company.com"
                      value={inviteEmail()}
                      onValueChange={(value) => {
                        setInviteEmail(value);
                        setInviteEmailError(null);
                      }}
                      onBlur={() =>
                        inviteEmail() &&
                        !normalizeEmailAddress(inviteEmail()) &&
                        setInviteEmailError("Enter a valid email address.")
                      }
                    />
                  </Field>
                </SlidingTabs.Content>
                <SlidingTabs.Content value="link" class="server-settings-invite-mode-panel">
                  <Input
                    ref={(element) => (inviteLinkInput = element)}
                    class="server-settings-invite-link-input t-text-swap"
                    size="md"
                    readonly
                    aria-label="Invitation link"
                    placeholder={INVITE_LINK_PLACEHOLDER}
                    value={inviteLinkValue()}
                    title={inviteLinkValue() || undefined}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </SlidingTabs.Content>
              </SlidingTabs.ContentSlot>
              <Select<string>
                options={ROLE_OPTIONS}
                value={roleLabel(inviteRole())}
                disabled={!published()}
                placement="bottom-end"
                onChange={(value) => value && setInviteRole(value === "Admin" ? "admin" : "member")}
                itemComponent={(item) => <SelectItem item={item.item}>{item.item.rawValue}</SelectItem>}
              >
                <SelectTrigger class="server-settings-role-select" size="sm" aria-label="Invitation role">
                  <SelectValue<string>>{(state) => state.selectedOption()}</SelectValue>
                </SelectTrigger>
                <SelectContent />
              </Select>
              <Show
                when={inviteMode() === "link" && inviteResult() && !inviteResult()?.email ? inviteResult() : null}
                fallback={
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    loading={busy() === "invite"}
                    disabled={!canInvite()}
                    onClick={() => void createInvite()}
                  >
                    {inviteMode() === "email" ? "Send invite" : "Create link"}
                  </Button>
                }
              >
                {(result) => (
                  <CopyButton
                    class="server-settings-invite-copy"
                    value={result().inviteUrl}
                    label="Copy link"
                    copiedLabel="Copied"
                    size="sm"
                    variant="default"
                    onCopyError={showCopyError}
                  />
                )}
              </Show>
            </div>
            <Show when={inviteResult()?.email ? inviteResult() : null}>
              {(result) => (
                <Alert class="server-settings-invite-result" tone="success" role="status">
                  <AlertIcon>
                    <Check />
                  </AlertIcon>
                  <AlertContent>
                    <AlertTitle>{result().email ? "Invitation sent" : "Invitation link ready"}</AlertTitle>
                    <AlertDescription>{result().email}</AlertDescription>
                  </AlertContent>
                </Alert>
              )}
            </Show>
          </Card>
        </SettingsSection>
      </SlidingTabs.Root>
    );
  }

  function memberRow(member: TeamPresenceMember) {
    return (
      <Item class="server-settings-member-row" data-disabled={member.disabled ? "" : undefined}>
        <ItemContent>
          <ItemTitle>{teamMemberName(member)}</ItemTitle>
          <ItemDescription class="server-settings-member-meta">{member.email ?? member.username}</ItemDescription>
        </ItemContent>
        <ItemActions class="server-settings-member-actions">
          <Show when={member.role !== "owner"} fallback={<Badge tone="accent">Owner</Badge>}>
            <Text variant="label-sm" tone="secondary">
              {roleLabel(member.role)}
            </Text>
            <Show when={canManage() && actionsAvailable()}>
              <MemberActionsMenu
                member={member}
                mount={modalElement}
                onRoleChange={(role) =>
                  void run(`member:${member.id}`, () => props.onUpdateMember({ memberId: member.id, role }))
                }
                onPausedChange={(disabled) =>
                  void run(`member:${member.id}`, () => props.onUpdateMember({ memberId: member.id, disabled }))
                }
                onRemove={(trigger) => {
                  removeMemberTrigger = trigger;
                  setRemoveMemberId(member.id);
                }}
              />
            </Show>
          </Show>
        </ItemActions>
      </Item>
    );
  }

  function pendingInvites() {
    return (
      <SettingsSection
        title="Pending invitations"
        actions={
          <Text variant="caption" tone="muted">
            {activeInvites().length} pending
          </Text>
        }
      >
        <ItemGroup class="settings-modal-card server-settings-invites-list">
          <Show
            when={activeInvites().length > 0}
            fallback={
              <Item class="server-settings-empty-row">
                <ItemContent>
                  <ItemDescription>No pending invitations.</ItemDescription>
                </ItemContent>
              </Item>
            }
          >
            <For each={activeInvites()}>
              {(invite) => (
                <Item class="server-settings-invite-row">
                  <ItemContent>
                    <ItemTitle>{invite.email ?? "Private invitation link"}</ItemTitle>
                    <ItemDescription>
                      {roleLabel(invite.role)} · Expires {formatDate(invite.expiresAt)}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive-ghost"
                      disabled={!actionsAvailable() || Boolean(busy())}
                      onClick={() => void run(`invite:${invite.id}`, () => props.onRevokeInvite(invite.id))}
                    >
                      Revoke
                    </Button>
                  </ItemActions>
                </Item>
              )}
            </For>
          </Show>
        </ItemGroup>
      </SettingsSection>
    );
  }

  function DesktopPanel() {
    return (
      <SettingsSection title="Remote desktop access">
        <ItemGroup class="settings-modal-card server-settings-desktop-card">
          <Show when={local()} fallback={remoteDesktopConnection()}>
            <Item size="spacious">
              <ItemMedia class="server-settings-desktop-icon">
                <Monitor />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>OpenBot Remote Host Gateway</ItemTitle>
                <ItemDescription class="server-settings-desktop-description">
                  Every active server member can control this host. There is no separate remote desktop password.
                </ItemDescription>
              </ItemContent>
              <ItemActions class="server-settings-desktop-meta">
                <Badge tone={props.hostStatus?.remoteDesktopReady ? "success" : "warning"} shape="pill" dot>
                  {props.hostStatus?.remoteDesktopReady ? "Service ready" : "Host component not installed"}
                </Badge>
                <Text as="span" variant="caption" tone="muted">
                  Unattended: {props.hostStatus?.remoteDesktopUnattended ? "enabled" : "not available"} · Active
                  sessions: {props.hostStatus?.remoteDesktopActiveSessions ?? 0}/
                  {props.hostStatus?.remoteDesktopMaxSessions ?? 4}
                </Text>
              </ItemActions>
            </Item>
          </Show>
        </ItemGroup>
      </SettingsSection>
    );
  }

  function remoteDesktopConnection() {
    return (
      <Item size="spacious">
        <ItemMedia class="server-settings-desktop-icon">
          <Monitor />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Remote control</ItemTitle>
          <ItemDescription class="server-settings-desktop-description">
            {props.server.remoteDesktopAvailable
              ? "WebRTC control is available for all active members."
              : "Update required or remote control is unavailable."}
          </ItemDescription>
          <Badge
            class="server-settings-desktop-status"
            tone={props.server.remoteDesktopAvailable ? "success" : "warning"}
            shape="pill"
            dot
          >
            {props.server.remoteDesktopAvailable ? "Service available" : "Update required"}
          </Badge>
        </ItemContent>
        <ItemActions class="server-settings-desktop-hint">
          <Text as="span" variant="caption" tone="muted">
            Start Remote Control from the monitor button in the server header.
          </Text>
        </ItemActions>
      </Item>
    );
  }

  function accessDescription() {
    if (!local())
      return published()
        ? "The host is online. Publication is controlled by its owner."
        : "The host is offline. Publication is controlled by its owner.";
    if (!configured()) return "Save the server identity before publishing.";
    return published()
      ? "Reachable online. Only invited people can sign in."
      : "Not reachable online. Existing members and invitations remain.";
  }
}

function ServerLogo(props: { name: string; url: string | null }) {
  const [failed, setFailed] = createSignal(false);
  createEffect(
    () => props.url,
    () => {
      setFailed(false);
    },
  );
  return (
    <span class="server-settings-logo" aria-hidden="true">
      <Show when={!failed() ? props.url : null} fallback={<span>{initials(props.name)}</span>}>
        {(url) => <img src={url()} alt="" draggable={false} onError={() => setFailed(true)} />}
      </Show>
    </span>
  );
}

function MemberActionsMenu(props: {
  member: TeamPresenceMember;
  mount: HTMLElement | undefined;
  onRoleChange: (role: InviteRole) => void;
  onPausedChange: (paused: boolean) => void;
  onRemove: (trigger: HTMLElement) => void;
}) {
  const name = () => teamMemberName(props.member);
  let triggerElement: HTMLElement | undefined;
  return (
    <DropdownMenu.Root placement="bottom-end" gutter={4} modal={false}>
      <DropdownMenu.Trigger
        ref={(element) => (triggerElement = element)}
        class={`${buttonVariants({ variant: "ghost", size: "icon-sm" })} ui-icon-button server-settings-member-menu-trigger`}
        aria-label={`Actions for ${name()}`}
      >
        <Ellipsis aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal mount={props.mount}>
        <DropdownMenu.Content class="server-settings-member-menu">
          <DropdownMenu.Item
            disabled={props.member.disabled}
            onSelect={() => props.onRoleChange(props.member.role === "admin" ? "member" : "admin")}
          >
            {props.member.role === "admin" ? <UserRound aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
            {props.member.role === "admin" ? "Make member" : "Make admin"}
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => props.onPausedChange(!props.member.disabled)}>
            {props.member.disabled ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
            {props.member.disabled ? "Restore access" : "Pause access"}
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            class="ui-action-menu-danger"
            onSelect={() => triggerElement && props.onRemove(triggerElement)}
          >
            <Trash2 aria-hidden="true" />
            Remove member
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function roleLabel(role: TeamRole): "Owner" | "Admin" | "Member" {
  if (role === "owner") return "Owner";
  return role === "admin" ? "Admin" : "Member";
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  return (
    (parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : value.trim().slice(0, 2)).toUpperCase() || "OB"
  );
}

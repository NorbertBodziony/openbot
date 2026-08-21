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
import { TeamPersonAvatar, teamMemberName } from "./TeamPersonAvatar";
import {
  Badge,
  Button,
  Card,
  Check,
  ChevronDown,
  Copy,
  DropdownMenu,
  Ellipsis,
  Field,
  Heading,
  Input,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  Search,
  Select,
  Settings,
  ShieldCheck,
  Switch,
  Tabs,
  Text,
  Trash2,
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
  const [logoError, setLogoError] = createSignal<string | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [addressCopied, setAddressCopied] = createSignal(false);
  const [inviteMode, setInviteMode] = createSignal<InviteMode>("email");
  const [inviteRole, setInviteRole] = createSignal<InviteRole>("member");
  const [inviteEmail, setInviteEmail] = createSignal("");
  const [inviteEmailError, setInviteEmailError] = createSignal<string | null>(null);
  const [inviteResult, setInviteResult] = createSignal<InviteSummary | null>(null);
  const [inviteCopied, setInviteCopied] = createSignal(false);
  const [memberSearch, setMemberSearch] = createSignal("");
  const [removeMemberId, setRemoveMemberId] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Date.now());
  let modalElement: HTMLElement | undefined;
  let logoInput: HTMLInputElement | undefined;
  let syncedServerId = "";
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
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
  const visibleNameError = () => (identityEditing() && nameTouched() ? nameError() : null);
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
  const onlineCount = createMemo(() => props.members.filter((member) => member.online && !member.disabled).length);
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
        setMemberSearch("");
        setActionError(null);
        setInviteResult(null);
      }
      if (!editing) {
        setSavedName(name);
        setDraftName(name);
        setSavedLogoUrl(logoUrl);
        setDraftLogoUrl(logoUrl);
        setDraftLogo(undefined);
        setNameTouched(false);
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
    for (const url of objectUrls) URL.revokeObjectURL(url);
  });

  async function run(key: string, action: () => Promise<void>): Promise<boolean> {
    if (busy()) return false;
    setBusy(key);
    setActionError(null);
    try {
      await action();
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The server action failed.");
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
    setLogoError(null);
    setActionError(null);
  }

  async function saveIdentity(): Promise<void> {
    setNameTouched(true);
    if (!identityDirty() || nameError()) return;
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
  }

  async function copyText(value: string, copied: (value: boolean) => void): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      copied(true);
    } catch {
      copied(false);
      setActionError("OpenBot could not copy this value.");
    }
  }

  function copyAddress(): void {
    const value = address();
    if (value) void copyText(value, setAddressCopied);
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
    setInviteCopied(false);
    setInviteEmailError(null);
    if (email) setInviteEmail("");
  }

  return (
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
        <>
          <Show when={props.loadError || actionError()}>
            <div
              class="server-settings-notice server-settings-error server-settings-error-toast"
              data-with-save-bar={section() === "general" && identityDirty() ? "" : undefined}
              role="alert"
            >
              <ShieldCheck aria-hidden="true" />
              <div>
                <strong>Server action failed</strong>
                <span>{actionError() ?? props.loadError}</span>
              </div>
              <Show when={props.loadError}>
                <Button
                  type="button"
                  size="md"
                  variant="ghost"
                  loading={props.loading}
                  onClick={() => void run("retry", props.onRetry)}
                >
                  <RefreshCw aria-hidden="true" />
                  Retry
                </Button>
              </Show>
            </div>
          </Show>
          <Show when={section() === "general" && identityDirty()}>
            <section class="server-settings-save-bar" aria-label="Unsaved identity changes">
              <Text variant="caption" tone="secondary">
                Unsaved changes
              </Text>
              <div class="server-settings-save-actions">
                <Button type="button" size="md" variant="ghost" disabled={Boolean(busy())} onClick={resetIdentity}>
                  Reset
                </Button>
                <Button
                  type="button"
                  size="md"
                  variant="primary"
                  loading={busy() === "identity"}
                  loadingLabel="Saving…"
                  disabled={Boolean(busy())}
                  onClick={() => void saveIdentity()}
                >
                  Save changes
                </Button>
              </div>
            </section>
          </Show>
        </>
      }
      sidebar={
        <nav class="settings-modal-nav" aria-label="Server settings sections">
          <NavItem
            active={section() === "general"}
            label="General"
            icon={Settings}
            onSelect={() => setSection("general")}
          />
          <NavItem
            active={section() === "members"}
            label="Members"
            icon={UsersRound}
            onSelect={() => setSection("members")}
          />
          <Show when={props.platform === "darwin"}>
            <NavItem
              active={section() === "desktop"}
              label="Remote desktop"
              icon={Monitor}
              onSelect={() => setSection("desktop")}
            />
          </Show>
        </nav>
      }
    >
      <Show when={section() === "general"}>
        <GeneralPanel />
      </Show>
      <Show when={section() === "members"}>
        <MembersPanel />
      </Show>
      <Show when={section() === "desktop"}>
        <DesktopPanel />
      </Show>
    </SettingsDialogShell>
  );

  function GeneralPanel() {
    return (
      <div class="settings-modal-tab-panel server-settings-panel" data-tab="general">
        <section class="server-settings-general-section" aria-labelledby="server-identity-heading">
          <Heading id="server-identity-heading" class="server-settings-section-heading" as="h3" size="sm">
            Identity
          </Heading>
          <Card class="server-settings-general-card">
            <Input
              ref={(element) => (logoInput = element)}
              class="sr-only"
              type="file"
              aria-label="Server logo"
              accept="image/png,image/jpeg,image/webp"
              disabled={!canEditIdentity()}
              onChange={(event) => {
                void chooseLogo(event.currentTarget.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
            <div class="server-settings-general-row server-settings-logo-row">
              <div class="server-settings-general-copy">
                <Text as="strong" variant="label">
                  Server logo
                </Text>
                <Text as="span" variant="caption" tone={logoError() ? "danger" : "muted"}>
                  {logoError() ??
                    (canEditIdentity()
                      ? "Shown to everyone who connects."
                      : "Only the server owner can change this logo.")}
                </Text>
              </div>
              <div class="server-settings-logo-control">
                <ServerLogo name={draftName() || props.server.name} url={draftLogoUrl()} />
                <Show when={canEditIdentity()}>
                  <div class="server-settings-logo-actions">
                    <Button
                      type="button"
                      size="md"
                      variant="ghost"
                      aria-label="Change server logo"
                      onClick={() => logoInput?.click()}
                    >
                      Change
                    </Button>
                    <Show when={draftLogoUrl()}>
                      <Button
                        type="button"
                        size="md"
                        variant="ghost"
                        aria-label="Remove server logo"
                        onClick={() => {
                          setIdentityEditing(true);
                          setDraftLogoUrl(null);
                          setDraftLogo(null);
                          setLogoError(null);
                        }}
                      >
                        Remove
                      </Button>
                    </Show>
                  </div>
                </Show>
              </div>
            </div>
            <Show
              when={canEditIdentity()}
              fallback={
                <div class="server-settings-general-row server-settings-readonly-name">
                  <div class="server-settings-general-copy">
                    <Text as="strong" variant="label">
                      Server name
                    </Text>
                    <Text as="span" variant="caption" tone="muted">
                      Only the server owner can change this name.
                    </Text>
                  </div>
                  <Text as="span" class="server-settings-readonly-value" variant="body">
                    {props.server.name}
                  </Text>
                </div>
              }
            >
              <Field
                class="server-settings-general-row server-settings-name-field"
                label="Server name"
                description="Shown in invitations and shared spaces."
                error={visibleNameError() ?? undefined}
                htmlFor="server-settings-name"
              >
                <Input
                  id="server-settings-name"
                  size="lg"
                  maxlength={INPUT_LIMITS.serverName}
                  value={draftName()}
                  onValueChange={(value) => {
                    setIdentityEditing(true);
                    setDraftName(value);
                    setActionError(null);
                  }}
                  onBlur={() => setNameTouched(true)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.isComposing) return;
                    event.preventDefault();
                    void saveIdentity();
                  }}
                />
              </Field>
            </Show>
          </Card>
        </section>
        <section class="server-settings-general-section" aria-labelledby="server-access-heading">
          <Heading id="server-access-heading" class="server-settings-section-heading" as="h3" size="sm">
            Access
          </Heading>
          <Card class="server-settings-general-card">
            <Switch
              class="server-settings-general-row server-settings-publish-setting"
              size="md"
              checked={published()}
              disabled={!local() || !configured() || Boolean(busy())}
              onChange={(value) => void run("publish", () => props.onSetPublished(value))}
              label={local() ? "Publish this server" : "Server is published"}
              description={accessDescription()}
            />
            <div class="server-settings-general-row server-settings-address-setting">
              <div class="server-settings-general-copy">
                <Text as="strong" variant="label">
                  Server address
                </Text>
                <Text as="span" variant="caption" tone="muted">
                  Use this address to connect to the server.
                </Text>
              </div>
              <div class="server-settings-address-control">
                <code>{address() ?? "Not available while private"}</code>
                <Button type="button" size="md" variant="ghost" disabled={!address()} onClick={copyAddress}>
                  <Copy aria-hidden="true" />
                  {addressCopied() ? "Copied" : "Copy address"}
                </Button>
              </div>
            </div>
          </Card>
        </section>
      </div>
    );
  }

  function MembersPanel() {
    return (
      <div class="settings-modal-tab-panel server-settings-panel" data-tab="members">
        <Show when={!configured() || !published()}>
          <div class="server-settings-notice" role="status">
            <ShieldCheck aria-hidden="true" />
            <div>
              <strong>{configured() ? "Invitations are paused" : "Server setup is required"}</strong>
              <span>
                {configured()
                  ? "Publish the server in General to invite new people."
                  : "Save the server identity in General first."}
              </span>
            </div>
          </div>
        </Show>
        <Show when={canManage()}>{inviteComposer()}</Show>
        <section class="settings-modal-group" aria-labelledby="server-members-heading">
          <div class="server-settings-section-title server-settings-members-heading">
            <div>
              <Heading id="server-members-heading" as="h3" size="sm" tone="secondary">
                Server members
              </Heading>
              <Text variant="caption" tone="muted">
                {props.members.length} members · {onlineCount()} online
              </Text>
            </div>
            <label class="server-settings-search">
              <Search aria-hidden="true" />
              <span class="sr-only">Search members</span>
              <Input
                type="search"
                placeholder="Search members"
                value={memberSearch()}
                onValueChange={setMemberSearch}
              />
            </label>
          </div>
          <Card class="server-settings-people-card server-settings-members-list" data-testid="server-members-list">
            <Show
              when={filteredMembers().length > 0}
              fallback={<p class="server-settings-empty">No members match this search.</p>}
            >
              <For each={filteredMembers()}>{(member) => memberRow(member)}</For>
            </Show>
          </Card>
        </section>
        <Show when={canManage()}>{pendingInvites()}</Show>
      </div>
    );
  }

  function inviteComposer() {
    return (
      <section class="settings-modal-group" aria-labelledby="invite-people-heading">
        <Heading id="invite-people-heading" as="h3" size="sm" tone="secondary">
          Invite people
        </Heading>
        <Card class="server-settings-people-card server-settings-invite-card">
          <Tabs.Root
            value={inviteMode()}
            onChange={(value) => {
              if (value !== "link" && value !== "email") return;
              setInviteMode(value);
              setInviteResult(null);
              setInviteEmailError(null);
            }}
          >
            <Tabs.List class="server-settings-invite-tabs" aria-label="Invitation method">
              <Tabs.Trigger value="email">Email</Tabs.Trigger>
              <Tabs.Trigger value="link">Invite link</Tabs.Trigger>
            </Tabs.List>
            <div class="server-settings-invite-composer">
              <Tabs.Content value="email" class="server-settings-invite-mode-panel">
                <label class="server-settings-invite-email-control">
                  <span class="sr-only">Email address</span>
                  <Input
                    size="lg"
                    type="email"
                    autocomplete="email"
                    maxlength={INPUT_LIMITS.email}
                    disabled={!published()}
                    aria-invalid={inviteEmailError() ? "true" : undefined}
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
                </label>
              </Tabs.Content>
              <Tabs.Content value="link" class="server-settings-invite-mode-panel">
                <Text variant="body-sm" tone="secondary">
                  Create a private one-time link.
                </Text>
              </Tabs.Content>
              <SettingsSelect
                label="Invitation role"
                options={ROLE_OPTIONS}
                value={roleLabel(inviteRole())}
                disabled={!published()}
                mount={modalElement}
                onChange={(value) => setInviteRole(value === "Admin" ? "admin" : "member")}
              />
              <Button
                type="button"
                size="lg"
                variant="primary"
                loading={busy() === "invite"}
                disabled={!canInvite()}
                onClick={() => void createInvite()}
              >
                {inviteMode() === "email" ? "Send invite" : "Create link"}
              </Button>
            </div>
            <Show when={inviteEmailError()}>
              {(message) => (
                <Text variant="caption" tone="danger" role="alert">
                  {message()}
                </Text>
              )}
            </Show>
            <Text class="server-settings-invite-help" variant="caption" tone="muted">
              Invitations can be used once and expire after 24 hours.
            </Text>
            <Show when={inviteResult()}>
              {(result) => (
                <div class="server-settings-invite-result" role="status">
                  <Check aria-hidden="true" />
                  <div>
                    <strong>{result().email ? "Invitation sent" : "Invitation link ready"}</strong>
                    <span>{result().email ?? "The private link"}</span>
                  </div>
                  <Show when={!result().email}>
                    <Button
                      type="button"
                      size="md"
                      variant="ghost"
                      onClick={() => void copyText(result().inviteUrl, setInviteCopied)}
                    >
                      {inviteCopied() ? "Copied" : "Copy link"}
                    </Button>
                  </Show>
                </div>
              )}
            </Show>
          </Tabs.Root>
        </Card>
      </section>
    );
  }

  function memberRow(member: TeamPresenceMember) {
    return (
      <div class="server-settings-member-wrap" data-disabled={member.disabled ? "" : undefined}>
        <div class="server-settings-member-row">
          <div class="server-settings-member-identity">
            <TeamPersonAvatar member={member} />
            <div class="server-settings-row-copy">
              <strong>{teamMemberName(member)}</strong>
              <div class="server-settings-member-meta">
                <span>{member.email ?? member.username}</span>
                <span aria-hidden="true">·</span>
                <span
                  class="server-settings-member-status"
                  data-state={member.disabled ? "paused" : member.online ? "online" : "offline"}
                >
                  <span aria-hidden="true" />
                  {member.disabled ? "Paused" : member.online ? "Online" : "Offline"}
                </span>
              </div>
            </div>
          </div>
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
                onRemove={() => setRemoveMemberId(member.id)}
              />
            </Show>
          </Show>
        </div>
        <Show when={removeMemberId() === member.id}>
          <div class="server-settings-remove-confirmation" role="alert">
            <span>Remove this member from the server?</span>
            <Button type="button" size="md" onClick={() => setRemoveMemberId(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="md"
              variant="danger"
              loading={busy() === `remove:${member.id}`}
              onClick={() =>
                void run(`remove:${member.id}`, async () => {
                  await props.onRemoveMember(member.id);
                  setRemoveMemberId(null);
                })
              }
            >
              Remove member
            </Button>
          </div>
        </Show>
      </div>
    );
  }

  function pendingInvites() {
    return (
      <section class="settings-modal-group" aria-labelledby="pending-invitations-heading">
        <div class="server-settings-section-title">
          <Heading id="pending-invitations-heading" as="h3" size="sm" tone="secondary">
            Pending invitations
          </Heading>
          <Text variant="caption" tone="muted">
            {activeInvites().length} pending
          </Text>
        </div>
        <Card class="server-settings-people-card server-settings-invites-list">
          <Show
            when={activeInvites().length > 0}
            fallback={<p class="server-settings-empty">No pending invitations.</p>}
          >
            <For each={activeInvites()}>
              {(invite) => (
                <div class="server-settings-invite-row">
                  <div class="server-settings-row-copy">
                    <strong>{invite.email ?? "Private invitation link"}</strong>
                    <span>
                      {roleLabel(invite.role)} · Expires {formatDate(invite.expiresAt)}
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="md"
                    variant="ghost"
                    disabled={!actionsAvailable() || Boolean(busy())}
                    onClick={() => void run(`invite:${invite.id}`, () => props.onRevokeInvite(invite.id))}
                  >
                    Revoke
                  </Button>
                </div>
              )}
            </For>
          </Show>
        </Card>
      </section>
    );
  }

  function DesktopPanel() {
    return (
      <div class="settings-modal-tab-panel server-settings-panel" data-tab="desktop">
        <section class="server-settings-general-section" aria-labelledby="remote-desktop-heading">
          <Heading id="remote-desktop-heading" class="server-settings-section-heading" as="h3" size="sm">
            Remote desktop access
          </Heading>
          <Card class="server-settings-general-card server-settings-desktop-card">
            <Show when={local()} fallback={remoteDesktopConnection()}>
              <div class="server-settings-desktop-content">
                <div class="server-settings-general-copy">
                  <Text as="strong" variant="label">
                    OpenBot Remote Host Gateway
                  </Text>
                  <Text as="span" variant="caption" tone="muted">
                    Every active server member can control this host. There is no separate remote desktop password.
                  </Text>
                </div>
                <div class="server-settings-desktop-meta">
                  <Badge tone={props.hostStatus?.remoteDesktopReady ? "success" : "warning"} shape="pill" dot>
                    {props.hostStatus?.remoteDesktopReady ? "Service ready" : "Host component not installed"}
                  </Badge>
                  <Text as="span" variant="caption" tone="muted">
                    Unattended: {props.hostStatus?.remoteDesktopUnattended ? "enabled" : "not available"} · Active
                    sessions: {props.hostStatus?.remoteDesktopActiveSessions ?? 0}/
                    {props.hostStatus?.remoteDesktopMaxSessions ?? 4}
                  </Text>
                </div>
              </div>
            </Show>
          </Card>
        </section>
      </div>
    );
  }

  function remoteDesktopConnection() {
    return (
      <div class="server-settings-desktop-content">
        <div class="server-settings-general-copy">
          <Text as="strong" variant="label">
            Remote control
          </Text>
          <Text as="span" variant="caption" tone="muted">
            {props.server.remoteDesktopAvailable
              ? "WebRTC control is available for all active members."
              : "Update required or remote control is unavailable."}
          </Text>
          <Badge
            class="server-settings-desktop-status"
            tone={props.server.remoteDesktopAvailable ? "success" : "warning"}
            shape="pill"
            dot
          >
            {props.server.remoteDesktopAvailable ? "Service available" : "Update required"}
          </Badge>
        </div>
        <Text as="span" variant="caption" tone="muted">
          Start Remote Control from the monitor button in the server header.
        </Text>
      </div>
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

function NavItem(props: { active: boolean; label: string; icon: typeof Settings; onSelect: () => void }) {
  const Icon = props.icon;
  return (
    <Button
      type="button"
      class="settings-modal-nav-item"
      variant="ghost"
      aria-current={props.active ? "page" : undefined}
      onClick={props.onSelect}
    >
      <Icon aria-hidden="true" />
      <span>{props.label}</span>
    </Button>
  );
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
  onRemove: () => void;
}) {
  const name = () => teamMemberName(props.member);
  return (
    <DropdownMenu.Root placement="bottom-end" gutter={4} modal={false}>
      <DropdownMenu.Trigger
        class="ui-button ui-icon-button server-settings-member-menu-trigger"
        data-variant="ghost"
        data-size="md"
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
          <DropdownMenu.Item class="ui-action-menu-danger" onSelect={props.onRemove}>
            <Trash2 aria-hidden="true" />
            Remove member
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SettingsSelect(props: {
  label: string;
  options: string[];
  value: string;
  disabled?: boolean;
  mount: HTMLElement | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <Select.Root<string>
      options={props.options}
      value={props.value}
      disabled={props.disabled}
      onChange={(value) => value && props.onChange(value)}
      placement="bottom-end"
      gutter={4}
      sameWidth
      itemComponent={(item) => (
        <Select.Item class="settings-modal-select-item" item={item.item}>
          <Select.ItemLabel>{item.item.rawValue}</Select.ItemLabel>
          <Select.ItemIndicator class="settings-modal-select-indicator">
            <Check aria-hidden="true" />
          </Select.ItemIndicator>
        </Select.Item>
      )}
    >
      <Select.Trigger class="settings-modal-select-trigger server-settings-role-select" aria-label={props.label}>
        <Select.Value<string>>{(state) => state.selectedOption()}</Select.Value>
        <ChevronDown aria-hidden="true" />
      </Select.Trigger>
      <Select.HiddenSelect />
      <Select.Portal mount={props.mount}>
        <Select.Content class="settings-modal-select-content">
          <Select.Listbox class="settings-modal-select-listbox" />
        </Select.Content>
      </Select.Portal>
    </Select.Root>
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

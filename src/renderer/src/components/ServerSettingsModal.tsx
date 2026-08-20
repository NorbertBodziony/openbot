import { isAvatarMimeType } from "@openbot/contracts/avatar-images";
import { AVATAR_IMAGE_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { TeamInviteSummary, TeamPresenceMember, TeamRole } from "@openbot/contracts/ipc";
import { normalizeEmailAddress } from "@openbot/contracts/validation";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
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
  IconButton,
  Input,
  Search,
  Select,
  Settings,
  ShieldCheck,
  Switch,
  Tabs,
  Text,
  Trash2,
  UsersRound,
} from "./ui";

export interface ServerSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ServerSettingsSection = "general" | "members";
type InviteMode = "link" | "email";
type InviteRole = Exclude<TeamRole, "owner">;

const SERVER_ADDRESS = "https://team.example.com";
const INVITE_ROLE_OPTIONS = ["Member", "Admin"];

const INITIAL_MEMBERS: TeamPresenceMember[] = [
  {
    id: "member-self",
    username: "norbert",
    email: "person@example.com",
    name: "Norbert",
    role: "owner",
    createdAt: "2026-01-10T08:00:00.000Z",
    disabled: false,
    online: true,
    typingBotId: null,
  },
  {
    id: "member-alice",
    username: "alice",
    email: "alice@example.com",
    name: "Alice Chen",
    role: "admin",
    createdAt: "2026-02-01T08:00:00.000Z",
    disabled: false,
    online: true,
    typingBotId: "chief",
  },
  {
    id: "member-jon",
    username: "jon",
    email: "jon@example.com",
    name: "Jon Bell",
    role: "member",
    createdAt: "2026-03-15T08:00:00.000Z",
    disabled: false,
    online: false,
    typingBotId: null,
  },
  {
    id: "member-maya",
    username: "maya",
    email: "maya@example.com",
    name: "Maya Singh",
    role: "member",
    createdAt: "2026-04-11T08:00:00.000Z",
    disabled: false,
    online: true,
    typingBotId: null,
  },
];

const INITIAL_INVITES: TeamInviteSummary[] = [
  {
    id: "invite-1",
    role: "member",
    expiresAt: "2026-08-29T10:00:00.000Z",
    usedAt: null,
    email: "new-person@example.com",
  },
];

const sectionDetails: Record<ServerSettingsSection, { title: string; description: string }> = {
  general: { title: "General", description: "Manage this server’s identity and published access." },
  members: { title: "Members", description: "Invite people and manage access to this server." },
};

export function ServerSettingsModal(props: ServerSettingsModalProps) {
  const [activeSection, setActiveSection] = createSignal<ServerSettingsSection>("general");
  const [published, setPublished] = createSignal(true);
  const [savedName, setSavedName] = createSignal("OpenBot team");
  const [draftName, setDraftName] = createSignal("OpenBot team");
  const [savedLogoUrl, setSavedLogoUrl] = createSignal<string | null>(null);
  const [draftLogoUrl, setDraftLogoUrl] = createSignal<string | null>(null);
  const [logoError, setLogoError] = createSignal<string | null>(null);
  const [addressCopied, setAddressCopied] = createSignal(false);
  const [inviteMode, setInviteMode] = createSignal<InviteMode>("email");
  const [inviteRole, setInviteRole] = createSignal<InviteRole>("member");
  const [inviteEmail, setInviteEmail] = createSignal("");
  const [inviteEmailError, setInviteEmailError] = createSignal<string | null>(null);
  const [inviteResult, setInviteResult] = createSignal<{ email: string | null; url: string } | null>(null);
  const [inviteCopied, setInviteCopied] = createSignal(false);
  const [invites, setInvites] = createSignal(INITIAL_INVITES);
  const [members, setMembers] = createSignal(INITIAL_MEMBERS);
  const [memberRoles, setMemberRoles] = createSignal<Record<string, InviteRole>>({});
  const [pausedMemberIds, setPausedMemberIds] = createSignal<string[]>([]);
  const [memberSearch, setMemberSearch] = createSignal("");
  const [removeMemberId, setRemoveMemberId] = createSignal<string | null>(null);
  let modalElement: HTMLElement | undefined;
  let logoInput: HTMLInputElement | undefined;
  const localLogoUrls: string[] = [];
  let inviteSequence = 2;

  onCleanup(() => {
    for (const url of localLogoUrls) URL.revokeObjectURL(url);
  });

  const currentSection = () => sectionDetails[activeSection()];
  const trimmedName = () => draftName().trim();
  const nameError = () => {
    if (trimmedName().length < INPUT_LIMITS.serverNameMin) {
      return `Enter at least ${INPUT_LIMITS.serverNameMin} characters.`;
    }
    if (trimmedName().length > INPUT_LIMITS.serverName) {
      return `Use no more than ${INPUT_LIMITS.serverName} characters.`;
    }
    return null;
  };
  const identityDirty = () => trimmedName() !== savedName() || draftLogoUrl() !== savedLogoUrl();
  const filteredMembers = createMemo(() => {
    const query = memberSearch().trim().toLowerCase();
    if (!query) return members();
    return members().filter((member) =>
      [teamMemberName(member), member.email, member.username].some((value) => value?.toLowerCase().includes(query)),
    );
  });
  const onlineMembers = createMemo(
    () => members().filter((member) => member.online && !pausedMemberIds().includes(member.id)).length,
  );

  function memberRole(member: TeamPresenceMember): TeamRole {
    if (member.role === "owner") return "owner";
    return memberRoles()[member.id] ?? member.role;
  }

  function memberDisabled(member: TeamPresenceMember): boolean {
    return pausedMemberIds().includes(member.id);
  }

  function changeDraftName(value: string): void {
    setDraftName(value);
  }

  function saveIdentity(): void {
    if (!identityDirty() || nameError()) return;
    setSavedName(trimmedName());
    setSavedLogoUrl(draftLogoUrl());
  }

  function resetIdentity(): void {
    setDraftName(savedName());
    setDraftLogoUrl(savedLogoUrl());
    setLogoError(null);
  }

  function chooseLogo(file: File | undefined): void {
    if (!file) return;
    setLogoError(null);
    if (!isAvatarMimeType(file.type)) {
      setLogoError("Choose a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > AVATAR_IMAGE_LIMITS.sourceBytes) {
      setLogoError("Choose an image smaller than 10 MB.");
      return;
    }
    const logoUrl = URL.createObjectURL(file);
    localLogoUrls.push(logoUrl);
    setDraftLogoUrl(logoUrl);
  }

  async function copyText(value: string, onCopied: (copied: boolean) => void): Promise<void> {
    onCopied(true);
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Storybook keeps the local success state because this prototype does not use a real server action.
    }
  }

  function createInvite(): void {
    if (!published()) return;
    const normalizedEmail = inviteMode() === "email" ? normalizeEmailAddress(inviteEmail()) : null;
    if (inviteMode() === "email" && !normalizedEmail) {
      setInviteEmailError("Enter a valid email address.");
      return;
    }
    const id = `invite-${inviteSequence++}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    const email = normalizedEmail ?? null;
    const url = `openbot://invite/${id}`;
    setInvites((items) => [...items, { id, role: inviteRole(), expiresAt, usedAt: null, email }]);
    setInviteResult({ email, url });
    setInviteCopied(false);
    setInviteEmailError(null);
    if (email) setInviteEmail("");
  }

  function updateMember(memberId: string, patch: Partial<Pick<TeamPresenceMember, "role" | "disabled">>): void {
    const nextRole = patch.role;
    if (nextRole && nextRole !== "owner") {
      setMemberRoles((roles) => ({ ...roles, [memberId]: nextRole }));
    }
    if (patch.disabled !== undefined) {
      setPausedMemberIds((memberIds) =>
        patch.disabled
          ? [...memberIds.filter((id) => id !== memberId), memberId]
          : memberIds.filter((id) => id !== memberId),
      );
    }
  }

  function removeMember(memberId: string): void {
    setMembers((items) => items.filter((member) => member.id !== memberId));
    setRemoveMemberId(null);
  }

  return (
    <SettingsDialogShell
      class="server-settings-modal-shell"
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={currentSection().title}
      description={currentSection().description}
      contentKey={activeSection()}
      closeLabel="Close server settings"
      onContentElement={(element) => (modalElement = element)}
      floatingContent={
        <Show when={activeSection() === "general" && identityDirty()}>
          <section class="server-settings-save-bar" aria-label="Unsaved identity changes">
            <Text variant="caption" tone="secondary">
              Unsaved changes
            </Text>
            <div class="server-settings-save-actions">
              <Button type="button" size="md" variant="ghost" onClick={resetIdentity}>
                Reset
              </Button>
              <Button type="button" size="md" variant="primary" disabled={Boolean(nameError())} onClick={saveIdentity}>
                Save changes
              </Button>
            </div>
          </section>
        </Show>
      }
      sidebar={
        <nav class="settings-modal-nav" aria-label="Server settings sections">
          <ServerNavItem
            active={activeSection() === "general"}
            label="General"
            icon={Settings}
            onSelect={() => setActiveSection("general")}
          />
          <ServerNavItem
            active={activeSection() === "members"}
            label="Members"
            icon={UsersRound}
            onSelect={() => setActiveSection("members")}
          />
        </nav>
      }
    >
      <Show when={activeSection() === "general"}>
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
                onChange={(event) => {
                  chooseLogo(event.currentTarget.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
              <div class="server-settings-general-row server-settings-logo-row">
                <div class="server-settings-general-copy">
                  <Text as="strong" variant="label">
                    Server logo
                  </Text>
                  <Show
                    when={logoError()}
                    fallback={
                      <Text as="span" variant="caption" tone="muted">
                        PNG, JPEG, or WebP. Maximum 10 MB.
                      </Text>
                    }
                  >
                    {(message) => (
                      <Text as="span" variant="caption" tone="danger" role="alert">
                        {message()}
                      </Text>
                    )}
                  </Show>
                </div>
                <div class="server-settings-logo-control">
                  <ServerLogo name={draftName()} url={draftLogoUrl()} />
                  <div class="server-settings-logo-actions">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label="Change server logo"
                      onClick={() => logoInput?.click()}
                    >
                      Change
                    </Button>
                    <Show when={draftLogoUrl()}>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label="Remove server logo"
                        onClick={() => {
                          setDraftLogoUrl(null);
                          setLogoError(null);
                        }}
                      >
                        Remove
                      </Button>
                    </Show>
                  </div>
                </div>
              </div>
              <Field
                class="server-settings-general-row server-settings-name-field"
                label="Server name"
                description="Shown in invitations and shared spaces."
                error={draftName().length > 0 ? (nameError() ?? undefined) : undefined}
                htmlFor="server-settings-name"
              >
                <Input
                  id="server-settings-name"
                  maxlength={INPUT_LIMITS.serverName}
                  value={draftName()}
                  onInput={(event) => changeDraftName(event.currentTarget.value)}
                />
              </Field>
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
                onChange={(next) => {
                  setPublished(next);
                  setAddressCopied(false);
                }}
                label="Publish this server"
                description={
                  published()
                    ? "Reachable online. Only invited people can sign in."
                    : "Not reachable online. Existing members and invitations remain."
                }
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
                  <code>{published() ? SERVER_ADDRESS : "Not available while private"}</code>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={!published()}
                    onClick={() => void copyText(SERVER_ADDRESS, setAddressCopied)}
                  >
                    <Copy aria-hidden="true" />
                    {addressCopied() ? "Copied" : "Copy address"}
                  </Button>
                </div>
              </div>
            </Card>
          </section>
        </div>
      </Show>

      <Show when={activeSection() === "invitations"}>
        <div class="settings-modal-tab-panel server-settings-panel" data-tab="invitations">
          <Show when={!published()}>
            <div class="server-settings-notice" role="status">
              <ShieldCheck aria-hidden="true" />
              <div>
                <strong>Invitation creation is paused</strong>
                <span>Publish the server in General to create new invitations. Existing invitations are kept.</span>
              </div>
            </div>
          </Show>
          <section class="settings-modal-group" aria-labelledby="create-invitation-heading">
            <Heading id="create-invitation-heading" as="h3" size="sm" tone="secondary">
              Invite a person
            </Heading>
            <Card class="settings-modal-card server-settings-invite-card">
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
                  <Tabs.Trigger value="link">
                    <Link2 aria-hidden="true" />
                    Invitation link
                  </Tabs.Trigger>
                  <Tabs.Trigger value="email">
                    <Mail aria-hidden="true" />
                    Email invitation
                  </Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content value="email" class="server-settings-email-panel">
                  <Field
                    label="Email address"
                    description="Only this address can accept the invitation."
                    error={inviteEmailError() ?? undefined}
                    htmlFor="server-invite-email"
                  >
                    <Input
                      id="server-invite-email"
                      type="email"
                      autocomplete="email"
                      maxlength={INPUT_LIMITS.email}
                      disabled={!published()}
                      placeholder="person@company.com"
                      value={inviteEmail()}
                      onInput={(event) => {
                        setInviteEmail(event.currentTarget.value);
                        setInviteEmailError(null);
                      }}
                    />
                  </Field>
                </Tabs.Content>
              </Tabs.Root>
              <div class="server-settings-invite-actions">
                <SettingsSelect
                  label="Invitation role"
                  options={INVITE_ROLE_OPTIONS}
                  value={roleLabel(inviteRole())}
                  disabled={!published()}
                  mount={modalElement}
                  onChange={(value) => setInviteRole(value === "Admin" ? "admin" : "member")}
                />
                <Button type="button" disabled={!published()} onClick={createInvite}>
                  {inviteMode() === "email" ? "Send invitation" : "Create invitation link"}
                </Button>
              </div>
              <Text variant="caption" tone="muted">
                Invitations can be used once and expire after 24 hours.
              </Text>
              <Show when={inviteResult()}>
                {(result) => (
                  <div class="server-settings-invite-result" role="status">
                    <Check aria-hidden="true" />
                    <div>
                      <strong>{result().email ? "Invitation sent" : "Invitation link ready"}</strong>
                      <span>{result().email ?? "The private link"} can be used once during the next 24 hours.</span>
                    </div>
                    <Show when={!result().email}>
                      <Button type="button" size="sm" onClick={() => void copyText(result().url, setInviteCopied)}>
                        {inviteCopied() ? "Copied" : "Copy link"}
                      </Button>
                    </Show>
                  </div>
                )}
              </Show>
            </Card>
          </section>

          <section class="settings-modal-group" aria-labelledby="pending-invitations-heading">
            <div class="server-settings-section-title">
              <Heading id="pending-invitations-heading" as="h3" size="sm" tone="secondary">
                Pending invitations
              </Heading>
              <Badge tone="neutral" shape="pill">
                {invites().length}
              </Badge>
            </div>
            <Card class="settings-modal-card server-settings-list-card">
              <Show when={invites().length > 0} fallback={<p class="server-settings-empty">No pending invitations.</p>}>
                <For each={invites()}>
                  {(invite) => (
                    <div class="server-settings-list-row">
                      <div class="server-settings-row-icon">
                        {invite.email ? <Mail aria-hidden="true" /> : <Link2 aria-hidden="true" />}
                      </div>
                      <div class="server-settings-row-copy">
                        <strong>{invite.email ?? "Private invitation link"}</strong>
                        <span>
                          {roleLabel(invite.role)} · Expires {formatDate(invite.expiresAt)}
                        </span>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setInvites((items) => items.filter((item) => item.id !== invite.id))}
                      >
                        Revoke
                      </Button>
                    </div>
                  )}
                </For>
              </Show>
            </Card>
          </section>
        </div>
      </Show>

      <Show when={activeSection() === "members"}>
        <div class="settings-modal-tab-panel server-settings-panel" data-tab="members">
          <section class="settings-modal-group" aria-labelledby="server-members-heading">
            <div class="server-settings-section-title server-settings-members-heading">
              <div>
                <Heading id="server-members-heading" as="h3" size="sm" tone="secondary">
                  Server members
                </Heading>
                <Text variant="caption" tone="muted">
                  {onlineMembers()} online · {members().length} total
                </Text>
              </div>
              <label class="server-settings-search">
                <Search aria-hidden="true" />
                <span class="sr-only">Search members</span>
                <Input
                  type="search"
                  placeholder="Search members"
                  value={memberSearch()}
                  onInput={(event) => setMemberSearch(event.currentTarget.value)}
                />
              </label>
            </div>
            <Card
              class="settings-modal-card server-settings-list-card server-settings-members-list"
              data-testid="server-members-list"
            >
              <Show
                when={filteredMembers().length > 0}
                fallback={<p class="server-settings-empty">No members match this search.</p>}
              >
                <For each={filteredMembers()}>
                  {(member) => (
                    <div class="server-settings-member-wrap" data-disabled={memberDisabled(member) ? "" : undefined}>
                      <div class="server-settings-member-row">
                        <TeamPersonAvatar member={member} />
                        <div class="server-settings-row-copy">
                          <strong>{teamMemberName(member)}</strong>
                          <span>{member.email ?? member.username}</span>
                          <small>
                            {memberDisabled(member) ? "Access paused" : member.online ? "Online" : "Offline"}
                          </small>
                        </div>
                        <Show
                          when={member.role !== "owner"}
                          fallback={
                            <Badge tone="accent" shape="pill">
                              Owner
                            </Badge>
                          }
                        >
                          <SettingsSelect
                            label={`Role for ${teamMemberName(member)}`}
                            options={INVITE_ROLE_OPTIONS}
                            value={roleLabel(memberRole(member))}
                            disabled={memberDisabled(member)}
                            mount={modalElement}
                            onChange={(value) =>
                              updateMember(member.id, { role: value === "Admin" ? "admin" : "member" })
                            }
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => updateMember(member.id, { disabled: !memberDisabled(member) })}
                          >
                            {memberDisabled(member) ? "Restore access" : "Pause access"}
                          </Button>
                          <IconButton
                            label={`Remove ${teamMemberName(member)}`}
                            tooltip={`Remove ${teamMemberName(member)}`}
                            variant="ghost"
                            onClick={() => setRemoveMemberId(member.id)}
                          >
                            <Trash2 aria-hidden="true" />
                          </IconButton>
                        </Show>
                      </div>
                      <Show when={removeMemberId() === member.id}>
                        <div class="server-settings-remove-confirmation" role="alert">
                          <span>Remove this member and end all active sessions?</span>
                          <Button type="button" size="sm" onClick={() => setRemoveMemberId(null)}>
                            Cancel
                          </Button>
                          <Button type="button" size="sm" variant="danger" onClick={() => removeMember(member.id)}>
                            Remove member
                          </Button>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </Card>
          </section>

          <section class="settings-modal-group" aria-labelledby="active-sessions-heading">
            <div class="server-settings-section-title">
              <Heading id="active-sessions-heading" as="h3" size="sm" tone="secondary">
                Active sessions
              </Heading>
              <Badge tone="neutral" shape="pill">
                {sessions().length}
              </Badge>
            </div>
            <Card class="settings-modal-card server-settings-list-card" data-testid="server-sessions-list">
              <Show when={sessions().length > 0} fallback={<p class="server-settings-empty">No active sessions.</p>}>
                <For each={sessions()}>
                  {(session) => {
                    const member = () => members().find((item) => item.id === session.memberId);
                    const displayName = () => {
                      const currentMember = member();
                      return currentMember ? teamMemberName(currentMember) : session.username;
                    };
                    return (
                      <div class="server-settings-list-row">
                        <div class="server-settings-row-icon">
                          <ShieldCheck aria-hidden="true" />
                        </div>
                        <div class="server-settings-row-copy">
                          <strong>{displayName()}</strong>
                          <span>Expires {formatDate(session.expiresAt)}</span>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setSessions((items) => items.filter((item) => item.id !== session.id))}
                        >
                          Sign out
                        </Button>
                      </div>
                    );
                  }}
                </For>
              </Show>
            </Card>
          </section>
        </div>
      </Show>
    </SettingsDialogShell>
  );
}

function ServerNavItem(props: { active: boolean; label: string; icon: typeof Settings; onSelect: () => void }) {
  const NavIcon = props.icon;
  return (
    <Button
      type="button"
      class="settings-modal-nav-item"
      variant="ghost"
      aria-current={props.active ? "page" : undefined}
      onClick={props.onSelect}
    >
      <NavIcon aria-hidden="true" />
      <span>{props.label}</span>
    </Button>
  );
}

function ServerLogo(props: { name: string; url: string | null }) {
  return (
    <span class="server-settings-logo" aria-hidden="true">
      <Show when={props.url} fallback={<span>{initials(props.name)}</span>}>
        {(url) => <img src={url()} alt="" draggable={false} />}
      </Show>
    </span>
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
      itemComponent={(selectProps) => (
        <Select.Item class="settings-modal-select-item" item={selectProps.item}>
          <Select.ItemLabel>{selectProps.item.rawValue}</Select.ItemLabel>
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
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  if (parts.length > 1) return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  return value.trim().slice(0, 2).toUpperCase() || "OB";
}

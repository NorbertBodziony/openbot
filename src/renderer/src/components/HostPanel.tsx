import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  HostStatus,
  InviteSummary,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamPresenceSnapshot,
  TeamRole,
  TeamSessionSummary,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type Element as SolidElement,
} from "solid-js";

type AdminSection = "overview" | "people" | "desktop";

interface HostPanelProps {
  status: HostStatus;
  members: TeamMemberSummary[];
  invites: TeamInviteSummary[];
  sessions: TeamSessionSummary[];
  presence: TeamPresenceSnapshot;
  accountEmail: string;
  onClose: () => void;
  onConfigure: (input: { serverName: string }) => Promise<void>;
  onConfigureRemoteDesktop: (password: string) => Promise<void>;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onCreateInvite: (input: {
    role: Exclude<TeamRole, "owner">;
    email?: string;
  }) => Promise<InviteSummary>;
  onUpdateMember: (input: UpdateTeamMemberInput) => Promise<void>;
  onRemoveMember: (memberId: string) => Promise<void>;
  onRevokeSession: (sessionId: string) => Promise<void>;
  onRevokeInvite: (inviteId: string) => Promise<void>;
  onCopyAddressUpdate: () => Promise<void>;
}

export function HostPanel(props: HostPanelProps) {
  const [serverName, setServerName] = createSignal("");
  const [section, setSection] = createSignal<AdminSection>("overview");
  const [inviteMode, setInviteMode] = createSignal<"link" | "email">("link");
  const [inviteEmail, setInviteEmail] = createSignal("");
  const [inviteRole, setInviteRole] = createSignal<"admin" | "member">("member");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [invite, setInvite] = createSignal<InviteSummary | null>(null);
  const [inviteCopied, setInviteCopied] = createSignal(false);
  const [removeMemberId, setRemoveMemberId] = createSignal<string | null>(null);
  const [remoteDesktopPassword, setRemoteDesktopPassword] = createSignal("");
  const [currentTime, setCurrentTime] = createSignal(Date.now());
  const activeInvites = createMemo(() =>
    props.invites.filter(
      (item) => item.usedAt === null && Date.parse(item.expiresAt) > currentTime(),
    ),
  );
  const online = createMemo(() => props.status.phase === "online");
  let inviteExpiryTimer: ReturnType<typeof setTimeout> | undefined;

  createEffect(
    () => ({
      now: currentTime(),
      expiries: props.invites
        .filter((item) => item.usedAt === null)
        .map((item) => Date.parse(item.expiresAt)),
    }),
    ({ now, expiries }) => {
      if (inviteExpiryTimer) clearTimeout(inviteExpiryTimer);
      const nextExpiry = expiries.filter((expiry) => expiry > now).sort((a, b) => a - b)[0];
      inviteExpiryTimer = nextExpiry
        ? setTimeout(() => setCurrentTime(Date.now()), nextExpiry - now + 1)
        : undefined;
    },
  );
  onCleanup(() => {
    if (inviteExpiryTimer) clearTimeout(inviteExpiryTimer);
  });

  async function run(action: () => Promise<void>) {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The server action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite(created: InviteSummary): Promise<void> {
    try {
      await navigator.clipboard.writeText(created.inviteUrl);
      setInviteCopied(true);
    } catch {
      setInviteCopied(false);
    }
  }

  async function createInvite() {
    await run(async () => {
      const email = inviteMode() === "email" ? inviteEmail().trim() : undefined;
      const created = await props.onCreateInvite({
        role: inviteRole(),
        ...(email ? { email } : {}),
      });
      setInvite(created);
      setInviteCopied(false);
      if (inviteMode() === "link") await copyInvite(created);
      else setInviteEmail("");
    });
  }

  async function removeMember(memberId: string): Promise<void> {
    await run(async () => {
      await props.onRemoveMember(memberId);
      setRemoveMemberId(null);
    });
  }

  return (
    <div class="remote-dialog-backdrop" role="presentation">
      <section
        class={[
          "remote-dialog remote-host-dialog",
          { "remote-host-dialog-setup": !props.status.configured },
        ]}
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-title"
      >
        <header class="remote-admin-header">
          <div>
            <span class="remote-dialog-eyebrow">
              {props.status.configured ? "Server administration" : "This Mac"}
            </span>
            <h2 id="host-title">
              {props.status.configured
                ? (props.status.serverName ?? "OpenBot server")
                : "Host a team"}
            </h2>
          </div>
          <button type="button" aria-label="Close" onClick={props.onClose}>
            ×
          </button>
        </header>

        <Show
          when={props.status.configured}
          fallback={
            <HostSetup
              accountEmail={props.accountEmail}
              serverName={serverName()}
              busy={busy()}
              onServerName={setServerName}
              onCreate={() =>
                void run(() => props.onConfigure({ serverName: serverName().trim() }))
              }
            />
          }
        >
          <div class="remote-admin-shell">
            <nav class="remote-admin-nav" aria-label="Server administration">
              <AdminNavButton
                active={section() === "overview"}
                label="Overview"
                icon="pulse"
                onSelect={() => setSection("overview")}
              />
              <AdminNavButton
                active={section() === "people"}
                label="People"
                count={props.members.length}
                icon="people"
                onSelect={() => setSection("people")}
              />
              <AdminNavButton
                active={section() === "desktop"}
                label="Remote desktop"
                icon="screen"
                onSelect={() => setSection("desktop")}
              />
              <div class="remote-admin-nav-state">
                <i class={online() ? "online" : ""} />
                <span>{online() ? "Server online" : "Server offline"}</span>
              </div>
            </nav>

            <main class="remote-admin-content">
              <Show when={section() === "overview"}>
                <section class="remote-admin-view" aria-labelledby="server-overview-title">
                  <div class="remote-admin-view-heading">
                    <div>
                      <span class="remote-admin-kicker">Local host</span>
                      <h3 id="server-overview-title">Server overview</h3>
                      <p>Check access endpoints and control this hosted server.</p>
                    </div>
                    <span class={["remote-admin-status-pill", { online: online() }]}>
                      {online() ? "Online" : "Offline"}
                    </span>
                  </div>
                  <div class="remote-status-grid">
                    <StatusCard
                      label="Team API"
                      online={props.status.apiOnline}
                      value={props.status.apiUrl ?? "Not running"}
                    />
                    <StatusCard
                      label="Remote Mac"
                      online={props.status.vncOnline}
                      value={props.status.vncHostname ?? "Not available"}
                    />
                  </div>
                  <fieldset class="remote-admin-metrics">
                    <legend class="sr-only">Server access summary</legend>
                    <Metric value={props.members.length} label="People" />
                    <Metric value={activeInvites().length} label="Pending invites" />
                    <Metric value={props.sessions.length} label="Active sessions" />
                  </fieldset>
                  <section class="remote-admin-control-card">
                    <div>
                      <h3>Host controls</h3>
                      <p>{props.status.message ?? "Control the local server process."}</p>
                    </div>
                    <div class="remote-host-actions">
                      <Show
                        when={online()}
                        fallback={
                          <button
                            type="button"
                            class="remote-primary-button"
                            disabled={busy() || props.status.phase === "starting"}
                            onClick={() => void run(props.onStart)}
                          >
                            {props.status.phase === "starting" ? "Starting…" : "Start server"}
                          </button>
                        }
                      >
                        <button
                          type="button"
                          class="remote-secondary-button"
                          disabled={busy()}
                          onClick={() => void run(props.onStop)}
                        >
                          Stop server
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="remote-secondary-button"
                        disabled={!props.status.apiOnline || busy()}
                        onClick={() => void run(props.onCopyAddressUpdate)}
                      >
                        Copy address update
                      </button>
                    </div>
                  </section>
                </section>
              </Show>

              <Show when={section() === "people"}>
                <section class="remote-admin-view" aria-labelledby="people-access-title">
                  <div class="remote-admin-view-heading">
                    <div>
                      <span class="remote-admin-kicker">Access control</span>
                      <h3 id="people-access-title">People and invitations</h3>
                      <p>Add people by email or create a private one-time link.</p>
                    </div>
                  </div>

                  <section class="remote-invite-composer" aria-labelledby="invite-team-title">
                    <div class="remote-section-heading">
                      <div>
                        <h3 id="invite-team-title">Invite a person</h3>
                        <p>Each invitation can be used once and expires automatically.</p>
                      </div>
                      <label>
                        <span>Role</span>
                        <select
                          aria-label="Invitation role"
                          value={inviteRole()}
                          onChange={(event) =>
                            setInviteRole(event.currentTarget.value as "admin" | "member")
                          }
                        >
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </select>
                      </label>
                    </div>
                    <div class="remote-invite-tabs" role="tablist" aria-label="Invitation method">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={inviteMode() === "link" ? "true" : "false"}
                        class={inviteMode() === "link" ? "active" : ""}
                        onClick={() => {
                          setInviteMode("link");
                          setInvite(null);
                        }}
                      >
                        Invitation link
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={inviteMode() === "email" ? "true" : "false"}
                        class={inviteMode() === "email" ? "active" : ""}
                        onClick={() => {
                          setInviteMode("email");
                          setInvite(null);
                        }}
                      >
                        Email invitation
                      </button>
                    </div>
                    <Show when={inviteMode() === "email"}>
                      <label class="remote-field remote-invite-email">
                        <span>Email address</span>
                        <input
                          type="email"
                          aria-label="Email address"
                          autocomplete="email"
                          maxlength={INPUT_LIMITS.email}
                          value={inviteEmail()}
                          placeholder="person@company.com"
                          onInput={(event) => setInviteEmail(event.currentTarget.value)}
                        />
                        <small>Only this email address can accept the invitation.</small>
                      </label>
                    </Show>
                    <button
                      type="button"
                      class="remote-primary-button remote-invite-submit"
                      disabled={
                        !props.status.apiOnline ||
                        busy() ||
                        (inviteMode() === "email" && !inviteEmail().trim())
                      }
                      onClick={() => void createInvite()}
                    >
                      {busy()
                        ? "Creating…"
                        : inviteMode() === "email"
                          ? "Send email invitation"
                          : "Create invitation link"}
                    </button>
                    <Show when={!props.status.apiOnline}>
                      <p class="remote-inline-note">Start the server before you invite people.</p>
                    </Show>
                    <Show when={invite()}>
                      {(item) => (
                        <InviteResult
                          invite={item()}
                          copied={inviteCopied()}
                          onCopy={() => void copyInvite(item())}
                        />
                      )}
                    </Show>
                  </section>

                  <AdminList title="Members" count={props.members.length}>
                    <For each={props.members}>
                      {(member) => (
                        <MemberRow
                          member={member}
                          online={
                            props.presence.members.find((item) => item.id === member.id)?.online ??
                            false
                          }
                          typing={Boolean(
                            props.presence.members.find((item) => item.id === member.id)
                              ?.typingBotId,
                          )}
                          busy={busy()}
                          confirmingRemoval={removeMemberId() === member.id}
                          onChangeRole={(role) =>
                            void run(() => props.onUpdateMember({ memberId: member.id, role }))
                          }
                          onToggleAccess={() =>
                            void run(() =>
                              props.onUpdateMember({
                                memberId: member.id,
                                disabled: !member.disabled,
                              }),
                            )
                          }
                          onAskRemove={() => setRemoveMemberId(member.id)}
                          onCancelRemove={() => setRemoveMemberId(null)}
                          onRemove={() => void removeMember(member.id)}
                        />
                      )}
                    </For>
                  </AdminList>

                  <AdminList title="Pending invitations" count={activeInvites().length}>
                    <Show
                      when={activeInvites().length > 0}
                      fallback={<EmptyAdminList>New invitations will appear here.</EmptyAdminList>}
                    >
                      <For each={activeInvites()}>
                        {(item) => (
                          <div class="remote-access-row">
                            <IdentityMark value={item.email ?? "Link"} muted />
                            <div class="remote-access-copy">
                              <strong>{item.email ?? "Shareable invitation link"}</strong>
                              <span>
                                {roleLabel(item.role)} · Expires {formatDate(item.expiresAt)}
                              </span>
                            </div>
                            <button
                              type="button"
                              class="remote-text-button remote-text-button-danger"
                              disabled={busy()}
                              onClick={() => void run(() => props.onRevokeInvite(item.id))}
                            >
                              Revoke
                            </button>
                          </div>
                        )}
                      </For>
                    </Show>
                  </AdminList>

                  <AdminList title="Active sessions" count={props.sessions.length}>
                    <Show
                      when={props.sessions.length > 0}
                      fallback={<EmptyAdminList>No active member sessions.</EmptyAdminList>}
                    >
                      <For each={props.sessions}>
                        {(item) => (
                          <div class="remote-access-row">
                            <IdentityMark value={item.username} muted />
                            <div class="remote-access-copy">
                              <strong>{item.username}</strong>
                              <span>Expires {formatDate(item.expiresAt)}</span>
                            </div>
                            <button
                              type="button"
                              class="remote-text-button"
                              disabled={busy()}
                              onClick={() => void run(() => props.onRevokeSession(item.id))}
                            >
                              Sign out
                            </button>
                          </div>
                        )}
                      </For>
                    </Show>
                  </AdminList>
                </section>
              </Show>

              <Show when={section() === "desktop"}>
                <section class="remote-admin-view" aria-labelledby="desktop-access-title">
                  <div class="remote-admin-view-heading">
                    <div>
                      <span class="remote-admin-kicker">Screen control</span>
                      <h3 id="desktop-access-title">Remote desktop access</h3>
                      <p>Every active server member can control this Mac without a second login.</p>
                    </div>
                    <span
                      class={[
                        "remote-desktop-access-state",
                        { ready: props.status.remoteDesktopCredentialConfigured },
                      ]}
                    >
                      {props.status.remoteDesktopCredentialConfigured ? "Managed" : "Setup needed"}
                    </span>
                  </div>
                  <section class="remote-desktop-access-card">
                    <div class="remote-desktop-access-instructions">
                      <span>Set the same password on this Mac</span>
                      <p>
                        Open System Settings → General → Sharing → Screen Sharing. Enable “VNC
                        viewers may control screen with password”, then enter the same dedicated
                        password below.
                      </p>
                    </div>
                    <label class="remote-field remote-desktop-password-field">
                      <span>Dedicated VNC password</span>
                      <input
                        type="password"
                        autocomplete="new-password"
                        minlength={1}
                        maxlength={INPUT_LIMITS.remoteDesktopPassword}
                        value={remoteDesktopPassword()}
                        placeholder={
                          props.status.remoteDesktopCredentialConfigured
                            ? "Enter a new password to replace it"
                            : "1–8 characters"
                        }
                        onInput={(event) => setRemoteDesktopPassword(event.currentTarget.value)}
                      />
                      <small>Do not use your macOS account password.</small>
                    </label>
                    <button
                      type="button"
                      class="remote-primary-button remote-desktop-password-save"
                      disabled={busy() || !remoteDesktopPassword()}
                      onClick={() =>
                        void run(async () => {
                          await props.onConfigureRemoteDesktop(remoteDesktopPassword());
                          setRemoteDesktopPassword("");
                        })
                      }
                    >
                      {props.status.remoteDesktopCredentialConfigured
                        ? "Replace VNC password"
                        : "Save VNC password"}
                    </button>
                  </section>
                </section>
              </Show>
            </main>
          </div>
        </Show>
        <Show when={error()}>{(message) => <p class="remote-dialog-error">{message()}</p>}</Show>
      </section>
    </div>
  );
}

function HostSetup(props: {
  accountEmail: string;
  serverName: string;
  busy: boolean;
  onServerName: (value: string) => void;
  onCreate: () => void;
}) {
  return (
    <div class="remote-host-setup">
      <p>
        This Mac will use your signed-in OpenBot account as the owner. You can invite other people
        after the server is ready.
      </p>
      <label class="remote-field">
        <span>Server name</span>
        <input
          value={props.serverName}
          minlength={2}
          maxlength={INPUT_LIMITS.serverName}
          placeholder="Design studio"
          onInput={(event) => props.onServerName(event.currentTarget.value)}
        />
      </label>
      <div class="remote-account-chip">
        <span aria-hidden="true">@</span>
        <div>
          <small>Owner account</small>
          <strong>{props.accountEmail}</strong>
        </div>
      </div>
      <button
        type="button"
        class="remote-primary-button"
        disabled={props.busy || props.serverName.trim().length < 2}
        onClick={props.onCreate}
      >
        {props.busy ? "Creating…" : "Create team server"}
      </button>
    </div>
  );
}

function AdminNavButton(props: {
  active: boolean;
  label: string;
  icon: "pulse" | "people" | "screen";
  count?: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      class={["remote-admin-nav-button", { active: props.active }]}
      aria-current={props.active ? "page" : undefined}
      onClick={props.onSelect}
    >
      <AdminIcon name={props.icon} />
      <span>{props.label}</span>
      <Show when={props.count !== undefined}>
        <small aria-hidden="true">{props.count}</small>
      </Show>
    </button>
  );
}

function AdminIcon(props: { name: "pulse" | "people" | "screen" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <Show when={props.name === "pulse"}>
        <path d="M3 10h3l1.5-4 3 8 1.7-4H17" />
      </Show>
      <Show when={props.name === "people"}>
        <circle cx="7.2" cy="7" r="2.4" />
        <circle cx="13.7" cy="7.8" r="1.8" />
        <path d="M2.9 15c.4-2.6 2-4 4.5-4s4.1 1.4 4.5 4M12 11.6c2.7-.5 4.4.7 4.8 3.1" />
      </Show>
      <Show when={props.name === "screen"}>
        <rect x="2.8" y="3.7" width="14.4" height="10.2" rx="1.7" />
        <path d="M7.4 16.3h5.2M10 13.9v2.4" />
      </Show>
    </svg>
  );
}

function StatusCard(props: { label: string; online: boolean; value: string }) {
  return (
    <div class="remote-status-card">
      <span>
        <i class={props.online ? "online" : ""} />
        {props.label}
      </span>
      <strong>{props.online ? "Online" : "Offline"}</strong>
      <small>{props.value}</small>
    </div>
  );
}

function Metric(props: { value: number; label: string }) {
  return (
    <div>
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </div>
  );
}

function AdminList(props: { title: string; count: number; children: SolidElement }) {
  return (
    <section class="remote-admin-list">
      <header>
        <h3>{props.title}</h3>
        <span>{props.count}</span>
      </header>
      <div>{props.children}</div>
    </section>
  );
}

function EmptyAdminList(props: { children: SolidElement }) {
  return <p class="remote-admin-empty">{props.children}</p>;
}

function MemberRow(props: {
  member: TeamMemberSummary;
  online: boolean;
  typing: boolean;
  busy: boolean;
  confirmingRemoval: boolean;
  onChangeRole: (role: "admin" | "member") => void;
  onToggleAccess: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}) {
  const displayName = () => props.member.name ?? props.member.email ?? props.member.username;
  return (
    <div class={["remote-access-row-wrap", { disabled: props.member.disabled }]}>
      <div class="remote-access-row">
        <IdentityMark value={displayName()} />
        <div class="remote-access-copy">
          <strong>{displayName()}</strong>
          <span>{props.member.email ?? props.member.username}</span>
          <small class={["remote-member-presence", { online: props.online }]}>
            <i aria-hidden="true" />
            {props.typing ? "Typing now" : props.online ? "Online" : "Offline"}
          </small>
        </div>
        <Show
          when={props.member.role !== "owner"}
          fallback={<span class="remote-role-badge">Owner</span>}
        >
          <label class="remote-role-select">
            <span class="sr-only">Role for {displayName()}</span>
            <select
              value={props.member.role}
              disabled={props.busy || props.member.disabled}
              onChange={(event) =>
                props.onChangeRole(event.currentTarget.value as "admin" | "member")
              }
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button
            type="button"
            class="remote-text-button"
            disabled={props.busy}
            onClick={props.onToggleAccess}
          >
            {props.member.disabled ? "Restore access" : "Pause access"}
          </button>
          <button
            type="button"
            class="remote-more-button"
            aria-label={`Remove ${displayName()}`}
            disabled={props.busy}
            onClick={props.onAskRemove}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20">
              <circle cx="7.2" cy="6.2" r="2.4" />
              <path d="M2.9 14.7c.4-2.7 1.9-4 4.4-4 1.2 0 2.2.3 3 .9M12.4 13.2h4.7" />
            </svg>
          </button>
        </Show>
      </div>
      <Show when={props.confirmingRemoval}>
        <div class="remote-remove-confirmation" role="alert">
          <span>Remove this person and end all active sessions?</span>
          <button type="button" onClick={props.onCancelRemove} disabled={props.busy}>
            Cancel
          </button>
          <button type="button" class="danger" onClick={props.onRemove} disabled={props.busy}>
            Remove person
          </button>
        </div>
      </Show>
    </div>
  );
}

function IdentityMark(props: { value: string; muted?: boolean }) {
  return (
    <span class={["remote-identity-mark", { muted: Boolean(props.muted) }]} aria-hidden="true">
      {initials(props.value)}
    </span>
  );
}

function InviteResult(props: { invite: InviteSummary; copied: boolean; onCopy: () => void }) {
  return (
    <div class="remote-invite-result" role="status">
      <Show
        when={!props.invite.email}
        fallback={
          <div>
            <strong>Invitation sent</strong>
            <span>
              {props.invite.email} can join until {formatDate(props.invite.expiresAt)}.
            </span>
          </div>
        }
      >
        <div>
          <strong>{props.copied ? "Link copied" : "Invitation link ready"}</strong>
          <span>It expires {formatDate(props.invite.expiresAt)}.</span>
        </div>
        <button type="button" onClick={props.onCopy}>
          {props.copied ? "Copy again" : "Copy link"}
        </button>
      </Show>
    </div>
  );
}

function roleLabel(role: Exclude<TeamRole, "owner">): string {
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
  const local = value.split("@")[0] ?? value;
  const parts = local.split(/[._\-\s]+/u).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]?.[0]}${parts[1]?.[0]}` : local.slice(0, 2)).toUpperCase();
}

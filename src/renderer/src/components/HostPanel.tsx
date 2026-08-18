import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  HostStatus,
  InviteSummary,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamRole,
  TeamSessionSummary,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import { createSignal, For, Show } from "solid-js";

interface HostPanelProps {
  status: HostStatus;
  members: TeamMemberSummary[];
  invites: TeamInviteSummary[];
  sessions: TeamSessionSummary[];
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
  onRevokeSession: (sessionId: string) => Promise<void>;
  onRevokeInvite: (inviteId: string) => Promise<void>;
  onCopyAddressUpdate: () => Promise<void>;
}

export function HostPanel(props: HostPanelProps) {
  const [serverName, setServerName] = createSignal("");
  const [inviteMode, setInviteMode] = createSignal<"link" | "email">("link");
  const [inviteEmail, setInviteEmail] = createSignal("");
  const [inviteRole, setInviteRole] = createSignal<"admin" | "member">("member");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [invite, setInvite] = createSignal<InviteSummary | null>(null);
  const [remoteDesktopPassword, setRemoteDesktopPassword] = createSignal("");

  async function run(action: () => Promise<void>) {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Host action failed.");
    } finally {
      setBusy(false);
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
      if (inviteMode() === "link") await navigator.clipboard.writeText(created.inviteUrl);
      else setInviteEmail("");
    });
  }

  return (
    <div class="remote-dialog-backdrop" role="presentation">
      <section
        class="remote-dialog remote-host-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-title"
      >
        <header>
          <div>
            <span class="remote-dialog-eyebrow">This Mac</span>
            <h2 id="host-title">Host an OpenBot team</h2>
          </div>
          <button type="button" aria-label="Close" onClick={props.onClose}>
            ×
          </button>
        </header>

        <Show
          when={props.status.configured}
          fallback={
            <div class="remote-host-setup">
              <p>
                This Mac will use your signed-in OpenBot account as the owner. No separate host
                password is needed.
              </p>
              <label class="remote-field">
                <span>Server name</span>
                <input
                  value={serverName()}
                  minlength={2}
                  maxlength={INPUT_LIMITS.serverName}
                  onInput={(event) => setServerName(event.currentTarget.value)}
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
                disabled={busy()}
                onClick={() => void run(() => props.onConfigure({ serverName: serverName() }))}
              >
                {busy() ? "Creating…" : "Create team server"}
              </button>
            </div>
          }
        >
          <div class="remote-status-grid">
            <StatusCard
              label="Team API"
              online={props.status.apiOnline}
              value={props.status.apiUrl ?? "Not running"}
            />
            <StatusCard
              label="Remote Mac"
              online={props.status.vncOnline}
              value={props.status.vncHostname ?? "Screen Sharing is unavailable"}
            />
          </div>
          <p class="remote-host-message">{props.status.message}</p>
          <div class="remote-host-actions">
            <Show
              when={props.status.phase === "online"}
              fallback={
                <button
                  type="button"
                  class="remote-primary-button"
                  disabled={busy() || props.status.phase === "starting"}
                  onClick={() => void run(props.onStart)}
                >
                  {props.status.phase === "starting" ? "Starting…" : "Start host"}
                </button>
              }
            >
              <button
                type="button"
                class="remote-secondary-button"
                disabled={busy()}
                onClick={() => void run(props.onStop)}
              >
                Stop host
              </button>
            </Show>
            <button
              type="button"
              class="remote-secondary-button"
              disabled={!props.status.apiOnline || busy()}
              onClick={() =>
                void run(async () => {
                  await props.onCopyAddressUpdate();
                })
              }
            >
              Copy address update
            </button>
          </div>
          <section class="remote-desktop-access-card" aria-labelledby="desktop-access-title">
            <div class="remote-section-heading">
              <div>
                <h3 id="desktop-access-title">Remote desktop access</h3>
                <p>Team membership gives access. Members do not enter a second password.</p>
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
            <div class="remote-desktop-access-instructions">
              <span>On this Mac</span>
              <p>
                In System Settings, open General → Sharing → Screen Sharing. Enable “VNC viewers may
                control screen with password” and enter the same dedicated password below.
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
              class="remote-secondary-button remote-desktop-password-save"
              disabled={busy() || !remoteDesktopPassword()}
              onClick={() =>
                void run(async () => {
                  await props.onConfigureRemoteDesktop(remoteDesktopPassword());
                  setRemoteDesktopPassword("");
                })
              }
            >
              {props.status.remoteDesktopCredentialConfigured
                ? "Replace password"
                : "Save password"}
            </button>
          </section>
          <section class="remote-invite-composer" aria-labelledby="invite-team-title">
            <div class="remote-section-heading">
              <div>
                <h3 id="invite-team-title">Invite someone</h3>
                <p>Create a one-time link or send it to a verified email address.</p>
              </div>
              <label>
                <span>Access</span>
                <select
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
                class={inviteMode() === "link" ? "active" : ""}
                onClick={() => setInviteMode("link")}
              >
                Copy link
              </button>
              <button
                type="button"
                class={inviteMode() === "email" ? "active" : ""}
                onClick={() => setInviteMode("email")}
              >
                Send email
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
                <small>Only this OpenBot account can accept the invitation.</small>
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
                ? "Working…"
                : inviteMode() === "email"
                  ? "Send invitation"
                  : "Create and copy link"}
            </button>
          </section>
          <Show when={invite()}>
            {(item) => (
              <p class="remote-invite-result">
                {item().email ? `Invitation sent to ${item().email}.` : "Invitation link copied."}{" "}
                It expires {new Date(item().expiresAt).toLocaleString()}.
              </p>
            )}
          </Show>
          <div class="remote-members">
            <h3>Team members</h3>
            <For each={props.members}>
              {(member) => (
                <div>
                  <span>
                    {member.name ?? member.email ?? member.username}
                    <Show when={member.name && member.email}>
                      <small>{member.email}</small>
                    </Show>
                    <small>{member.disabled ? "disabled" : member.role}</small>
                  </span>
                  <Show when={member.role !== "owner"}>
                    <span class="remote-management-actions">
                      <button
                        type="button"
                        class="remote-secondary-button"
                        disabled={busy()}
                        onClick={() =>
                          void run(() =>
                            props.onUpdateMember({
                              memberId: member.id,
                              role: member.role === "admin" ? "member" : "admin",
                            }),
                          )
                        }
                      >
                        Make {member.role === "admin" ? "member" : "admin"}
                      </button>
                      <button
                        type="button"
                        class="remote-secondary-button"
                        disabled={busy()}
                        onClick={() =>
                          void run(() =>
                            props.onUpdateMember({
                              memberId: member.id,
                              disabled: !member.disabled,
                            }),
                          )
                        }
                      >
                        {member.disabled ? "Enable" : "Disable"}
                      </button>
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </div>
          <div class="remote-members">
            <h3>Active sessions</h3>
            <Show when={props.sessions.length} fallback={<p>No active sessions.</p>}>
              <For each={props.sessions}>
                {(session) => (
                  <div>
                    <span>
                      {session.username}
                      <small>Expires {new Date(session.expiresAt).toLocaleDateString()}</small>
                    </span>
                    <button
                      type="button"
                      class="remote-secondary-button"
                      disabled={busy()}
                      onClick={() => void run(() => props.onRevokeSession(session.id))}
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </div>
          <div class="remote-members">
            <h3>Invitations</h3>
            <Show when={props.invites.length} fallback={<p>No active invitations.</p>}>
              <For each={props.invites}>
                {(item) => (
                  <div>
                    <span>
                      {item.email ?? "Shareable link"}
                      <small>
                        {item.role} ·{" "}
                        {item.usedAt
                          ? "used"
                          : `Expires ${new Date(item.expiresAt).toLocaleString()}`}
                      </small>
                    </span>
                    <button
                      type="button"
                      class="remote-secondary-button"
                      disabled={busy()}
                      onClick={() => void run(() => props.onRevokeInvite(item.id))}
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>
        <Show when={error()}>{(message) => <p class="remote-dialog-error">{message()}</p>}</Show>
      </section>
    </div>
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

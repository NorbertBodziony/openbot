import { createSignal, For, Show } from "solid-js";
import type {
  HostStatus,
  InviteSummary,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamRole,
  TeamSessionSummary,
  UpdateTeamMemberInput,
} from "../../../shared/ipc";

interface HostPanelProps {
  status: HostStatus;
  members: TeamMemberSummary[];
  invites: TeamInviteSummary[];
  sessions: TeamSessionSummary[];
  onClose: () => void;
  onConfigure: (input: { serverName: string; username: string; password: string }) => Promise<void>;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onCreateInvite: (role: Exclude<TeamRole, "owner">) => Promise<InviteSummary>;
  onUpdateMember: (input: UpdateTeamMemberInput) => Promise<void>;
  onRevokeSession: (sessionId: string) => Promise<void>;
  onRevokeInvite: (inviteId: string) => Promise<void>;
  onCopyAddressUpdate: () => Promise<void>;
}

export function HostPanel(props: HostPanelProps) {
  const [serverName, setServerName] = createSignal("");
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [invite, setInvite] = createSignal<InviteSummary | null>(null);

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

  async function createInvite(role: "admin" | "member") {
    await run(async () => {
      const created = await props.onCreateInvite(role);
      setInvite(created);
      await navigator.clipboard.writeText(created.inviteUrl);
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
                Create the owner account. Other people will create accounts from one-time links.
              </p>
              <label class="remote-field">
                <span>Server name</span>
                <input
                  value={serverName()}
                  onInput={(event) => setServerName(event.currentTarget.value)}
                />
              </label>
              <label class="remote-field">
                <span>Owner username</span>
                <input
                  autocomplete="username"
                  value={username()}
                  onInput={(event) => setUsername(event.currentTarget.value)}
                />
              </label>
              <label class="remote-field">
                <span>Owner password</span>
                <input
                  type="password"
                  autocomplete="new-password"
                  value={password()}
                  onInput={(event) => setPassword(event.currentTarget.value)}
                />
                <small>Use at least 12 characters.</small>
              </label>
              <button
                type="button"
                class="remote-primary-button"
                disabled={busy()}
                onClick={() =>
                  void run(() =>
                    props.onConfigure({
                      serverName: serverName(),
                      username: username(),
                      password: password(),
                    }),
                  )
                }
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
              onClick={() => void createInvite("member")}
            >
              Copy member invite
            </button>
            <button
              type="button"
              class="remote-secondary-button"
              disabled={!props.status.apiOnline || busy()}
              onClick={() => void createInvite("admin")}
            >
              Copy admin invite
            </button>
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
          <Show when={invite()}>
            {(item) => (
              <p class="remote-invite-result">
                Invite copied. It expires {new Date(item().expiresAt).toLocaleString()}.
              </p>
            )}
          </Show>
          <div class="remote-members">
            <h3>Team members</h3>
            <For each={props.members}>
              {(member) => (
                <div>
                  <span>
                    {member.username}
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
                      {item.role}
                      <small>
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

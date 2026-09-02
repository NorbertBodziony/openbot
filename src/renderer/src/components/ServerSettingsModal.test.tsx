import type { HostStatus, ServerSummary, TeamPresenceMember } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { ServerSettingsModal, type ServerSettingsModalProps } from "./ServerSettingsModal";
import { Toaster } from "./ui";

const localServer: ServerSummary = {
  id: "local",
  name: "Local",
  logoUrl: null,
  kind: "local",
  state: "online",
  apiUrl: null,
  remoteDesktopAvailable: false,
  role: null,
  active: true,
};

const remoteServer: ServerSummary = {
  id: "remote-1",
  name: "Studio Team",
  logoUrl: null,
  kind: "remote",
  state: "online",
  apiUrl: "https://studio.example.com",
  remoteDesktopAvailable: true,
  role: "admin",
  active: false,
};

const unconfiguredHost: HostStatus = {
  phase: "unconfigured",
  configured: false,
  enabledOnLaunch: false,
  serverId: null,
  serverName: null,
  logoUrl: null,
  apiUrl: null,
  apiOnline: false,
  remoteDesktopReady: false,
  remoteDesktopUnattended: false,
  remoteDesktopActiveSessions: 0,
  remoteDesktopMaxSessions: 4,
  message: null,
};

const configuredHost: HostStatus = {
  ...unconfiguredHost,
  phase: "online",
  configured: true,
  enabledOnLaunch: true,
  serverId: "local",
  serverName: "Local",
  apiUrl: "https://team.example.com",
  apiOnline: true,
};

const members: TeamPresenceMember[] = [
  {
    id: "owner-1",
    username: "owner@example.com",
    email: "owner@example.com",
    name: "Server Owner",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    disabled: false,
    online: true,
    typingBotId: null,
  },
  {
    id: "alice-1",
    username: "alice",
    email: "alice@example.com",
    name: "Alice Chen",
    role: "member",
    createdAt: "2026-02-01T00:00:00.000Z",
    disabled: false,
    online: false,
    typingBotId: null,
  },
];

function props(overrides: Partial<ServerSettingsModalProps> = {}): ServerSettingsModalProps {
  return {
    open: true,
    onOpenChange: vi.fn(),
    platform: "darwin",
    server: localServer,
    hostStatus: unconfiguredHost,
    members: [],
    invites: [],
    loading: false,
    loadError: null,
    onRetry: vi.fn(async () => undefined),
    onSaveIdentity: vi.fn(async () => undefined),
    onSetPublished: vi.fn(async () => undefined),
    onCreateInvite: vi.fn(async (input) => ({
      id: "invite-new",
      role: input.role,
      expiresAt: "2099-01-01T00:00:00.000Z",
      usedAt: null,
      inviteUrl: "https://studio.example.com/invite/new",
      email: input.email ?? null,
    })),
    onUpdateMember: vi.fn(async () => undefined),
    onRemoveMember: vi.fn(async () => undefined),
    onRevokeInvite: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("ServerSettingsModal", () => {
  it("saves the first local identity without publishing it", async () => {
    const onSaveIdentity = vi.fn(async () => undefined);
    const onSetPublished = vi.fn(async () => undefined);
    render(() => <ServerSettingsModal {...props({ onSaveIdentity, onSetPublished })} />);

    const name = screen.getByRole("textbox", { name: "Server name" });
    expect(name).toHaveValue("");
    expect(screen.getByRole("switch", { name: "Publish this server" })).toBeDisabled();

    await fireEvent.input(name, { target: { value: "Draft Team" } });
    await fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(name).toHaveValue("");
    await fireEvent.input(name, { target: { value: "Studio Team" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaveIdentity).toHaveBeenCalledWith({ serverName: "Studio Team" }));
    expect(onSetPublished).not.toHaveBeenCalled();
  });

  it("shows a failed identity action and keeps the draft", async () => {
    const onSaveIdentity = vi.fn(async () => {
      throw new Error("The identity could not save.");
    });
    render(() => (
      <>
        <ServerSettingsModal {...props({ onSaveIdentity })} />
        <Toaster />
      </>
    ));

    const name = screen.getByRole("textbox", { name: "Server name" });
    await fireEvent.input(name, { target: { value: "Studio Team" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Server action failed")).toBeInTheDocument();
    expect(screen.getByText("The identity could not save.")).toBeInTheDocument();
    expect(name).toHaveValue("Studio Team");
  });

  it("publishes a configured local server and keeps first setup disabled", async () => {
    const onSetPublished = vi.fn(async () => undefined);
    const { unmount } = render(() => (
      <ServerSettingsModal {...props({ hostStatus: configuredHost, onSetPublished })} />
    ));

    const publishSwitch = screen.getByRole("switch", { name: "Publish this server" });
    expect(publishSwitch).toBeEnabled();
    await fireEvent.click(publishSwitch);
    await waitFor(() => expect(onSetPublished).toHaveBeenCalledWith(false));

    unmount();
    render(() => <ServerSettingsModal {...props({ hostStatus: unconfiguredHost, onSetPublished })} />);
    expect(screen.getByRole("switch", { name: "Publish this server" })).toBeDisabled();
  });

  it("validates the server name and returns an erased draft to its pristine state", async () => {
    const onSaveIdentity = vi.fn(async () => undefined);
    render(() => <ServerSettingsModal {...props({ onSaveIdentity })} />);

    const name = screen.getByRole("textbox", { name: "Server name" });
    await fireEvent.input(name, { target: { value: "Tiny" } });
    await waitFor(() => expect(name).toHaveValue("Tiny"));
    expect(screen.queryByText("Enter at least 6 characters.")).not.toBeInTheDocument();

    await fireEvent.blur(name);
    const error = screen.getByText("Enter at least 6 characters.");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAttribute("aria-describedby", error.id);
    expect(screen.getByRole("region", { name: "Unsaved changes" })).toBeInTheDocument();

    await fireEvent.input(name, { target: { value: "" } });
    expect(screen.queryByText("Enter at least 6 characters.")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).not.toBeInTheDocument();
    expect(name).not.toHaveAttribute("aria-invalid");

    await fireEvent.input(name, { target: { value: "Tiny" } });
    await fireEvent.blur(name);
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(name).toHaveFocus();

    await fireEvent.input(name, { target: { value: "Studio Team" } });
    expect(screen.queryByText("Enter at least 6 characters.")).not.toBeInTheDocument();
    expect(name).not.toHaveAttribute("aria-invalid");
    await fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() => expect(onSaveIdentity).toHaveBeenCalledWith({ serverName: "Studio Team" }));
  });

  it("keeps remote member settings read-only", async () => {
    render(() => (
      <ServerSettingsModal {...props({ server: { ...remoteServer, role: "member" }, hostStatus: null, members })} />
    ));

    expect(screen.queryByRole("textbox", { name: "Server name" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("tab", { name: "Members" }));
    expect(screen.getByText("Alice Chen")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send invite" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Actions for Alice Chen" })).not.toBeInTheDocument();
  });

  it("moves through settings tabs with the keyboard", async () => {
    render(() => <ServerSettingsModal {...props({ server: remoteServer, hostStatus: null, members })} />);

    const generalTab = screen.getByRole("tab", { name: "General" });
    generalTab.focus();
    await fireEvent.keyDown(generalTab, { key: "ArrowDown" });

    const membersTab = screen.getByRole("tab", { name: "Members" });
    await waitFor(() => expect(membersTab).toHaveAttribute("aria-selected", "true"));
    expect(membersTab).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Members" })).toBeInTheDocument();
  });

  it("confirms member removal and restores focus after cancellation", async () => {
    const onRemoveMember = vi.fn(async () => undefined);
    render(() => (
      <ServerSettingsModal {...props({ server: remoteServer, hostStatus: null, members, onRemoveMember })} />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Members" }));
    const memberActions = screen.getByRole("button", { name: "Actions for Alice Chen" });

    await fireEvent.pointerDown(memberActions, { button: 0 });
    await fireEvent.pointerUp(memberActions, { button: 0 });
    await fireEvent.pointerUp(await screen.findByRole("menuitem", { name: "Remove member" }), { button: 0 });
    expect(await screen.findByRole("alertdialog", { name: "Remove Alice Chen?" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(memberActions).toHaveFocus());
    expect(onRemoveMember).not.toHaveBeenCalled();

    await fireEvent.pointerDown(memberActions, { button: 0 });
    await fireEvent.pointerUp(memberActions, { button: 0 });
    await fireEvent.pointerUp(await screen.findByRole("menuitem", { name: "Remove member" }), { button: 0 });
    await fireEvent.click(await screen.findByRole("button", { name: "Remove member" }));

    await waitFor(() => expect(onRemoveMember).toHaveBeenCalledWith("alice-1"));
  });

  it("lets a remote administrator invite, search, revoke, and pause access", async () => {
    const onCreateInvite = vi.fn(async (input: { role: "admin" | "member"; email?: string }) => ({
      id: "invite-new",
      role: input.role,
      expiresAt: "2099-01-01T00:00:00.000Z",
      usedAt: null,
      inviteUrl: "https://studio.example.com/invite/new",
      email: input.email ?? null,
    }));
    const onUpdateMember = vi.fn(async () => undefined);
    const onRevokeInvite = vi.fn(async () => undefined);
    render(() => (
      <ServerSettingsModal
        {...props({
          server: remoteServer,
          hostStatus: null,
          members,
          invites: [
            {
              id: "invite-old",
              role: "member",
              expiresAt: "2099-01-01T00:00:00.000Z",
              usedAt: null,
              email: "pending@example.com",
            },
          ],
          onCreateInvite,
          onUpdateMember,
          onRevokeInvite,
        })}
      />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Members" }));
    await fireEvent.input(screen.getByRole("textbox", { name: "Email address" }), {
      target: { value: "new@example.com" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith({ role: "member", email: "new@example.com" }));

    await fireEvent.input(screen.getByRole("searchbox", { name: "Search members" }), {
      target: { value: "alice" },
    });
    expect(screen.getByText("Alice Chen")).toBeInTheDocument();
    expect(screen.queryByText("Server Owner")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(onRevokeInvite).toHaveBeenCalledWith("invite-old"));
    const memberActions = screen.getByRole("button", { name: "Actions for Alice Chen" });
    await fireEvent.pointerDown(memberActions, { button: 0 });
    await fireEvent.pointerUp(memberActions, { button: 0 });
    await fireEvent.pointerUp(await screen.findByRole("menuitem", { name: "Pause access" }), { button: 0 });
    await waitFor(() => expect(onUpdateMember).toHaveBeenCalledWith({ memberId: "alice-1", disabled: true }));
  });

  it("associates invite validation with the email field and creates invite links", async () => {
    const onCreateInvite = vi.fn(async (input: { role: "admin" | "member"; email?: string }) => ({
      id: "invite-new",
      role: input.role,
      expiresAt: "2099-01-01T00:00:00.000Z",
      usedAt: null,
      inviteUrl: "https://studio.example.com/invite/new",
      email: input.email ?? null,
    }));
    render(() => (
      <ServerSettingsModal {...props({ server: remoteServer, hostStatus: null, members, onCreateInvite })} />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Members" }));
    const email = screen.getByRole("textbox", { name: "Email address" });
    await fireEvent.input(email, { target: { value: "invalid" } });
    await fireEvent.blur(email);

    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("Enter a valid email address.");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAttribute("aria-describedby", error.id);

    await fireEvent.click(screen.getByRole("tab", { name: "Invite link" }));
    expect(screen.queryByText("Enter a valid email address.")).not.toBeInTheDocument();
    const inviteLink = screen.getByRole("textbox", { name: "Invitation link" });
    expect(inviteLink).toHaveValue("");
    await fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith({ role: "member" }));
    expect(await screen.findByRole("button", { name: "Copy link" })).toBeInTheDocument();
    await waitFor(() => expect(inviteLink).toHaveValue("https://studio.example.com/invite/new"));
  });
});

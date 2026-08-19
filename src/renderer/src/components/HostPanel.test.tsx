import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { HostPanel } from "./HostPanel";

describe("HostPanel", () => {
  it("shows the shared server-name limit during host setup", () => {
    const onConfigure = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <HostPanel
        platform="darwin"
        accountEmail="owner@example.com"
        status={{
          phase: "unconfigured",
          configured: false,
          enabledOnLaunch: false,
          serverId: null,
          serverName: null,
          apiUrl: null,
          vncHostname: null,
          apiOnline: false,
          vncOnline: false,
          remoteDesktopCredentialConfigured: false,
          message: "Configure this host.",
        }}
        members={[]}
        invites={[]}
        sessions={[]}
        presence={{ serverId: null, members: [], updatedAt: "" }}
        onClose={vi.fn()}
        onConfigure={onConfigure}
        onConfigureRemoteDesktop={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCreateInvite={vi.fn()}
        onUpdateMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeSession={vi.fn()}
        onRevokeInvite={vi.fn()}
        onCopyAddressUpdate={vi.fn()}
      />
    ));

    expect(screen.getByRole("textbox", { name: "Server name" })).toHaveAttribute(
      "maxlength",
      String(INPUT_LIMITS.serverName),
    );
    expect(screen.getByText(/Only people you invite can sign in/)).toBeInTheDocument();
  });

  it("keeps publishing controls on Windows without macOS Remote Desktop setup", () => {
    render(() => (
      <HostPanel
        platform="win32"
        accountEmail="owner@example.com"
        status={{
          phase: "idle",
          configured: true,
          enabledOnLaunch: false,
          serverId: "server-1",
          serverName: "Studio PC",
          apiUrl: null,
          vncHostname: null,
          apiOnline: false,
          vncOnline: false,
          remoteDesktopCredentialConfigured: false,
          message: "This OpenBot is private.",
        }}
        members={[]}
        invites={[]}
        sessions={[]}
        presence={{ serverId: "server-1", members: [], updatedAt: "" }}
        onClose={vi.fn()}
        onConfigure={vi.fn()}
        onConfigureRemoteDesktop={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCreateInvite={vi.fn()}
        onUpdateMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeSession={vi.fn()}
        onRevokeInvite={vi.fn()}
        onCopyAddressUpdate={vi.fn()}
      />
    ));

    expect(screen.getByRole("button", { name: "Make public" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remote desktop" })).toBeNull();
    expect(screen.queryByText("Remote Mac")).toBeNull();
  });

  it("sends an email-bound invitation from the configured host", async () => {
    const onCreateInvite = vi.fn().mockResolvedValue({
      id: "invite-1",
      role: "member",
      email: "alice@example.com",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      usedAt: null,
      inviteUrl: "openbot://join?invite=token",
    });
    render(() => (
      <HostPanel
        platform="darwin"
        accountEmail="owner@example.com"
        status={{
          phase: "online",
          configured: true,
          enabledOnLaunch: true,
          serverId: "server-1",
          serverName: "Studio Mac",
          apiUrl: "https://studio.trycloudflare.com",
          vncHostname: null,
          apiOnline: true,
          vncOnline: false,
          remoteDesktopCredentialConfigured: false,
          message: "This OpenBot is public. Only invited people can sign in.",
        }}
        members={[]}
        invites={[]}
        sessions={[]}
        presence={{ serverId: "server-1", members: [], updatedAt: "" }}
        onClose={vi.fn()}
        onConfigure={vi.fn()}
        onConfigureRemoteDesktop={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCreateInvite={onCreateInvite}
        onUpdateMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeSession={vi.fn()}
        onRevokeInvite={vi.fn()}
        onCopyAddressUpdate={vi.fn()}
      />
    ));

    await fireEvent.click(screen.getByRole("button", { name: /^People/ }));
    await fireEvent.click(screen.getByRole("tab", { name: "Email invitation" }));
    const emailInput = screen.getByRole("textbox", { name: "Email address" });
    expect(emailInput).toHaveAttribute("maxlength", String(INPUT_LIMITS.email));
    await fireEvent.input(emailInput, {
      target: { value: "alice@example.com" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Send email invitation" }));

    await waitFor(() =>
      expect(onCreateInvite).toHaveBeenCalledWith({
        role: "member",
        email: "alice@example.com",
      }),
    );
    expect(await screen.findByText("Invitation sent")).toBeInTheDocument();
    expect(screen.getByText(/alice@example.com can join until/)).toBeInTheDocument();
  });

  it("removes a member only after inline confirmation", async () => {
    const onRemoveMember = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <HostPanel
        platform="darwin"
        accountEmail="owner@example.com"
        status={{
          phase: "online",
          configured: true,
          enabledOnLaunch: true,
          serverId: "server-1",
          serverName: "Studio Mac",
          apiUrl: "https://studio.teams.openbot.run",
          vncHostname: null,
          apiOnline: true,
          vncOnline: false,
          remoteDesktopCredentialConfigured: false,
          message: "This OpenBot is public. Only invited people can sign in.",
        }}
        members={[
          {
            id: "owner-1",
            username: "owner@example.com",
            email: "owner@example.com",
            name: null,
            role: "owner",
            createdAt: "2026-08-18T10:00:00.000Z",
            disabled: false,
          },
          {
            id: "member-1",
            username: "alice@example.com",
            email: "alice@example.com",
            name: "Alice",
            role: "member",
            createdAt: "2026-08-18T11:00:00.000Z",
            disabled: false,
          },
        ]}
        invites={[]}
        sessions={[]}
        presence={{
          serverId: "server-1",
          updatedAt: "2026-08-18T11:01:00.000Z",
          members: [
            {
              id: "member-1",
              username: "alice@example.com",
              email: "alice@example.com",
              name: "Alice",
              role: "member",
              createdAt: "2026-08-18T11:00:00.000Z",
              disabled: false,
              online: true,
              typingBotId: "chief",
            },
          ],
        }}
        onClose={vi.fn()}
        onConfigure={vi.fn()}
        onConfigureRemoteDesktop={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCreateInvite={vi.fn()}
        onUpdateMember={vi.fn()}
        onRemoveMember={onRemoveMember}
        onRevokeSession={vi.fn()}
        onRevokeInvite={vi.fn()}
        onCopyAddressUpdate={vi.fn()}
      />
    ));

    await fireEvent.click(screen.getByRole("button", { name: /^People/ }));
    expect(screen.getByText("Typing now")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove owner@example.com" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Remove Alice" }));
    expect(screen.getByText(/end all active sessions/)).toBeInTheDocument();
    expect(onRemoveMember).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Remove person" }));
    await waitFor(() => expect(onRemoveMember).toHaveBeenCalledWith("member-1"));
  });

  it("creates and copies a one-time invitation link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onCreateInvite = vi.fn().mockResolvedValue({
      id: "invite-link",
      role: "admin",
      email: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      usedAt: null,
      inviteUrl: "openbot://join?invite=private-token",
    });
    render(() => (
      <HostPanel
        platform="darwin"
        accountEmail="owner@example.com"
        status={{
          phase: "online",
          configured: true,
          enabledOnLaunch: true,
          serverId: "server-1",
          serverName: "Studio Mac",
          apiUrl: "https://studio.teams.openbot.run",
          vncHostname: null,
          apiOnline: true,
          vncOnline: false,
          remoteDesktopCredentialConfigured: false,
          message: "This OpenBot is public. Only invited people can sign in.",
        }}
        members={[]}
        invites={[]}
        sessions={[]}
        presence={{ serverId: "server-1", members: [], updatedAt: "" }}
        onClose={vi.fn()}
        onConfigure={vi.fn()}
        onConfigureRemoteDesktop={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCreateInvite={onCreateInvite}
        onUpdateMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeSession={vi.fn()}
        onRevokeInvite={vi.fn()}
        onCopyAddressUpdate={vi.fn()}
      />
    ));

    await fireEvent.click(screen.getByRole("button", { name: /^People/ }));
    await fireEvent.change(screen.getByRole("combobox", { name: "Invitation role" }), {
      target: { value: "admin" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Create invitation link" }));

    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith({ role: "admin" }));
    expect(writeText).toHaveBeenCalledWith("openbot://join?invite=private-token");
    expect(await screen.findByText("Link copied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy again" })).toBeInTheDocument();
  });
});

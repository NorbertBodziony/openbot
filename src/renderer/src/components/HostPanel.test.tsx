import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { HostPanel } from "./HostPanel";

describe("HostPanel", () => {
  it("shows the shared server-name limit during host setup", () => {
    render(() => (
      <HostPanel
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
        onClose={vi.fn()}
        onConfigure={vi.fn()}
        onConfigureRemoteDesktop={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCreateInvite={vi.fn()}
        onUpdateMember={vi.fn()}
        onRevokeSession={vi.fn()}
        onRevokeInvite={vi.fn()}
        onCopyAddressUpdate={vi.fn()}
      />
    ));

    expect(screen.getByRole("textbox", { name: "Server name" })).toHaveAttribute(
      "maxlength",
      String(INPUT_LIMITS.serverName),
    );
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
          message: "The team server is online.",
        }}
        members={[]}
        invites={[]}
        sessions={[]}
        onClose={vi.fn()}
        onConfigure={vi.fn()}
        onConfigureRemoteDesktop={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCreateInvite={onCreateInvite}
        onUpdateMember={vi.fn()}
        onRevokeSession={vi.fn()}
        onRevokeInvite={vi.fn()}
        onCopyAddressUpdate={vi.fn()}
      />
    ));

    await fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    const emailInput = screen.getByRole("textbox", { name: "Email address" });
    expect(emailInput).toHaveAttribute("maxlength", String(INPUT_LIMITS.email));
    await fireEvent.input(emailInput, {
      target: { value: "alice@example.com" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    await waitFor(() =>
      expect(onCreateInvite).toHaveBeenCalledWith({
        role: "member",
        email: "alice@example.com",
      }),
    );
    expect(await screen.findByText(/Invitation sent to alice@example.com/)).toBeInTheDocument();
  });
});

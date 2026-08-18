import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { HostPanel } from "./HostPanel";

describe("HostPanel", () => {
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
          message: "The team server is online.",
        }}
        members={[]}
        invites={[]}
        sessions={[]}
        onClose={vi.fn()}
        onConfigure={vi.fn()}
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
    await fireEvent.input(screen.getByRole("textbox", { name: "Email address" }), {
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

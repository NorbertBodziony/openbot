import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { JoinServerDialog } from "./JoinServerDialog";

const preview = {
  serverId: "00000000-0000-4000-8000-000000000000",
  serverName: "Studio host",
  apiHostname: "studio-host.openbot.run",
  role: "member" as const,
  expiresAt: "2026-08-21T10:00:00.000Z",
  emailBound: true,
};

const defaultProps = {
  inviteUrl: "",
  accountEmail: "person@example.com",
  onClose: vi.fn(),
  onPreview: vi.fn(async () => preview),
  onJoin: vi.fn(async () => undefined),
};

describe("JoinServerDialog", () => {
  it("focuses the invite field and keeps Cancel available when the field is empty", async () => {
    const onClose = vi.fn();
    render(() => <JoinServerDialog {...defaultProps} onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: "Join a server" })).toBeInTheDocument();
    const inviteField = screen.getByRole("textbox", { name: "Invite link" });
    await waitFor(() => expect(inviteField).toHaveFocus());
    expect(screen.getByRole("button", { name: "Review invite" })).toBeDisabled();

    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("previews before it consumes the trimmed invitation", async () => {
    let resolveJoin: (() => void) | undefined;
    const onJoin = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveJoin = resolve;
        }),
    );
    const onClose = vi.fn();
    const inviteUrl = "https://openbot.run/join?invite=token";
    render(() => (
      <JoinServerDialog {...defaultProps} inviteUrl={`  ${inviteUrl}  `} onJoin={onJoin} onClose={onClose} />
    ));

    await waitFor(() => expect(defaultProps.onPreview).toHaveBeenCalledWith({ inviteUrl }));
    expect(await screen.findByRole("dialog", { name: "Studio host" })).toBeInTheDocument();
    const verifiedInvitation = screen.getByRole("region", { name: "Verified invitation" });
    expect(within(verifiedInvitation).queryByText("Member access")).not.toBeInTheDocument();
    expect(within(verifiedInvitation).queryByText(/Expires/)).not.toBeInTheDocument();
    expect(within(verifiedInvitation).queryByText(/Joining as/)).not.toBeInTheDocument();
    expect(within(verifiedInvitation).queryByText("person@example.com")).not.toBeInTheDocument();
    expect(
      within(verifiedInvitation).queryByText("This invite is restricted to this account."),
    ).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith({ inviteUrl }));
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use another invite" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();

    resolveJoin?.();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("shows a preview error, clears it on edit, and permits a retry", async () => {
    const onPreview = vi
      .fn<() => Promise<typeof preview>>()
      .mockRejectedValueOnce(new Error("The OpenBot invitation link is invalid."))
      .mockResolvedValueOnce(preview);
    const onJoin = vi.fn(async () => undefined);
    render(() => (
      <JoinServerDialog
        {...defaultProps}
        inviteUrl="https://openbot.run/join?invite=bad"
        onPreview={onPreview}
        onJoin={onJoin}
      />
    ));

    expect(await screen.findByRole("alert")).toHaveTextContent("The OpenBot invitation link is invalid.");
    const inviteField = screen.getByRole("textbox", { name: "Invite link" });
    await fireEvent.input(inviteField, { target: { value: "https://openbot.run/join?invite=good" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Review invite" }));
    expect(await screen.findByRole("dialog", { name: "Studio host" })).toBeInTheDocument();
    expect(onJoin).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledOnce());
  });

  it("returns to the invite field and restores focus", async () => {
    render(() => <JoinServerDialog {...defaultProps} inviteUrl="https://openbot.run/join?invite=valid" />);

    expect(await screen.findByRole("dialog", { name: "Studio host" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Use another invite" }));

    const inviteField = screen.getByRole("textbox", { name: "Invite link" });
    await waitFor(() => expect(inviteField).toHaveFocus());
  });

  it("shows a join error and permits a retry", async () => {
    const onJoin = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("OpenBot could not connect to this host."))
      .mockResolvedValueOnce(undefined);
    render(() => (
      <JoinServerDialog {...defaultProps} inviteUrl="https://openbot.run/join?invite=valid" onJoin={onJoin} />
    ));

    expect(await screen.findByRole("dialog", { name: "Studio host" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("OpenBot could not connect to this host.");

    await fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(2));
  });
});

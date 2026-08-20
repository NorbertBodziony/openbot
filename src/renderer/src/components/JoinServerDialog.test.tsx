import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
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

    const inviteField = screen.getByRole("textbox", { name: "Invitation link" });
    await waitFor(() => expect(inviteField).toHaveFocus());
    expect(screen.getByRole("button", { name: "Review invitation" })).toBeDisabled();

    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("previews before it consumes the trimmed invitation", async () => {
    let resolveJoin: (() => void) | undefined;
    const onJoin = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveJoin = resolve;
        }),
    );
    const inviteUrl = "https://openbot.run/join?invite=token";
    render(() => <JoinServerDialog {...defaultProps} inviteUrl={`  ${inviteUrl}  `} onJoin={onJoin} />);

    await waitFor(() => expect(defaultProps.onPreview).toHaveBeenCalledWith({ inviteUrl }));
    expect(await screen.findByText("Studio host")).toBeInTheDocument();
    expect(screen.getByText("person@example.com")).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Connect to host" }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith({ inviteUrl }));
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use another" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();

    resolveJoin?.();
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
    const inviteField = screen.getByRole("textbox", { name: "Invitation link" });
    await fireEvent.input(inviteField, { target: { value: "https://openbot.run/join?invite=good" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Review invitation" }));
    expect(await screen.findByText("Studio host")).toBeInTheDocument();
    expect(onJoin).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Connect to host" }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledOnce());
  });
});

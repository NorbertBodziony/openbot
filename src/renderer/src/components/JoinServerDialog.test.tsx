import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { JoinServerDialog } from "./JoinServerDialog";

const defaultProps = {
  inviteUrl: "",
  accountEmail: "person@example.com",
  onClose: vi.fn(),
  onJoin: vi.fn(async () => undefined),
};

describe("JoinServerDialog", () => {
  it("focuses the invite field and keeps Cancel available when the field is empty", async () => {
    const onClose = vi.fn();
    render(() => <JoinServerDialog {...defaultProps} onClose={onClose} />);

    const inviteField = screen.getByRole("textbox", { name: "Invitation link" });
    await waitFor(() => expect(inviteField).toHaveFocus());
    expect(screen.getByRole("button", { name: "Join server" })).toBeDisabled();

    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("submits the trimmed invitation through the form and locks controls while joining", async () => {
    let resolveJoin: (() => void) | undefined;
    const onClose = vi.fn();
    const onJoin = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveJoin = resolve;
        }),
    );
    render(() => (
      <JoinServerDialog
        {...defaultProps}
        inviteUrl="  openbot://join?invite=token  "
        onClose={onClose}
        onJoin={onJoin}
      />
    ));

    const inviteField = screen.getByRole("textbox", { name: "Invitation link" });
    const form = inviteField.closest("form");
    if (!(form instanceof HTMLFormElement)) throw new Error("Expected the invitation field inside a form.");
    await fireEvent.submit(form);

    await waitFor(() => expect(onJoin).toHaveBeenCalledWith({ inviteUrl: "openbot://join?invite=token" }));
    expect(screen.getByRole("button", { name: "Joining…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(inviteField).toBeDisabled();

    await fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    resolveJoin?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "Join server" })).toBeEnabled());
  });

  it("shows an accessible error, clears it on edit, and permits a retry", async () => {
    const onJoin = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("The OpenBot invitation link is invalid."))
      .mockResolvedValueOnce(undefined);
    render(() => <JoinServerDialog {...defaultProps} inviteUrl="openbot://join?invite=bad" onJoin={onJoin} />);

    await fireEvent.click(screen.getByRole("button", { name: "Join server" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The OpenBot invitation link is invalid.");

    const inviteField = screen.getByRole("textbox", { name: "Invitation link" });
    await fireEvent.input(inviteField, { target: { value: "openbot://join?invite=good" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Join server" }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(2));
    expect(onJoin).toHaveBeenLastCalledWith({ inviteUrl: "openbot://join?invite=good" });
  });
});

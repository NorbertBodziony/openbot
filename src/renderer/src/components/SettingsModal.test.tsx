import type { AvatarImageInput, CentralAuthUser, UpdateStatus } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GENERAL_SETTINGS } from "../app-settings";
import { SettingsModal } from "./SettingsModal";

const account: CentralAuthUser = {
  id: "user-1",
  email: "norbert@example.com",
  name: "Norbert",
  avatarUrl: null,
};

const idleUpdateStatus: UpdateStatus = {
  phase: "idle",
  currentVersion: "0.2.1",
  availableVersion: null,
  progress: null,
  checkedAt: null,
  message: null,
  errorCode: null,
};

describe("SettingsModal", () => {
  it("keeps dependent notch options selected but unavailable while the MacBook notch is disabled", () => {
    render(() => (
      <SettingsModal
        open
        onOpenChange={() => undefined}
        value={{ ...DEFAULT_GENERAL_SETTINGS, macBookNotch: false }}
        onValueChange={() => undefined}
        appInfo={{ name: "OpenBot", version: "0.2.1", platform: "darwin", variant: "dev" }}
        updateStatus={idleUpdateStatus}
        onUpdateAction={vi.fn(async () => undefined)}
        account={account}
        onUpdateAccountName={vi.fn(async () => undefined)}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
      />
    ));

    expect(screen.getByRole("switch", { name: "Haptic feedback" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Haptic feedback" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Show idle island" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Show idle island" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Show on additional displays" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Show on additional displays" })).toBeDisabled();
  });

  it("keeps General preferences controlled across close and reopen", async () => {
    const [open, setOpen] = createSignal(true);
    const [value, setValue] = createSignal({ ...DEFAULT_GENERAL_SETTINGS });
    let openTrigger: HTMLButtonElement | undefined;

    render(() => (
      <>
        <button ref={(element) => (openTrigger = element)} type="button" onClick={() => setOpen(true)}>
          Open settings
        </button>
        <SettingsModal
          open={open()}
          onOpenChange={setOpen}
          value={value()}
          onValueChange={setValue}
          appInfo={{ name: "OpenBot", version: "0.2.1", platform: "darwin", variant: "dev" }}
          updateStatus={idleUpdateStatus}
          onUpdateAction={vi.fn(async () => undefined)}
          account={account}
          onUpdateAccountName={vi.fn(async () => undefined)}
          onUpdateAccountAvatar={vi.fn(async () => undefined)}
          restoreFocusTarget={openTrigger}
        />
      </>
    ));

    const launchSwitch = screen.getByRole("switch", { name: "Launch OpenBot at login" });
    await fireEvent.click(launchSwitch);
    expect(value().launchAtLogin).toBe(false);

    const select = screen.getByRole("button", { name: /^Open external links in/ });
    await fireEvent.pointerDown(select, { pointerType: "mouse", button: 0 });
    await fireEvent.click(screen.getByRole("option", { name: "OpenBot" }));
    expect(value().externalLinkTarget).toBe("OpenBot");
    await fireEvent.click(screen.getByRole("switch", { name: "Share product analytics" }));
    expect(value().productAnalytics).toBe(false);

    await fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());
    await fireEvent.click(screen.getByRole("button", { name: "Open settings" }));

    expect(await screen.findByRole("switch", { name: "Launch OpenBot at login" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: /^Open external links in/ })).toHaveTextContent("OpenBot");
    expect(screen.getByRole("switch", { name: "Share product analytics" })).not.toBeChecked();
  });

  it("runs the updater and reflects its live status", async () => {
    const [status, setStatus] = createSignal<UpdateStatus>(idleUpdateStatus);
    const onUpdateAction = vi.fn(async () => {
      setStatus({ ...idleUpdateStatus, phase: "up-to-date", checkedAt: "2026-08-26T12:00:00.000Z" });
    });

    render(() => (
      <SettingsModal
        open
        onOpenChange={() => undefined}
        value={DEFAULT_GENERAL_SETTINGS}
        onValueChange={() => undefined}
        appInfo={{ name: "OpenBot", version: "0.2.1", platform: "darwin", variant: "dev" }}
        updateStatus={status()}
        onUpdateAction={onUpdateAction}
        account={account}
        onUpdateAccountName={vi.fn(async () => undefined)}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
      />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Updates" }));
    await fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(onUpdateAction).toHaveBeenCalledOnce());
    expect(await screen.findByText("OpenBot is up to date on the Stable track.")).toBeInTheDocument();
  });

  it("shows the Stable track and the target update across download states", async () => {
    const [status, setStatus] = createSignal<UpdateStatus>({
      ...idleUpdateStatus,
      phase: "available",
      availableVersion: "0.3.0",
    });

    render(() => (
      <SettingsModal
        open
        onOpenChange={() => undefined}
        value={DEFAULT_GENERAL_SETTINGS}
        onValueChange={() => undefined}
        appInfo={{ name: "OpenBot", version: "0.2.1", platform: "darwin", variant: "dev" }}
        updateStatus={status()}
        onUpdateAction={vi.fn(async () => undefined)}
        account={account}
        onUpdateAccountName={vi.fn(async () => undefined)}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
      />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Updates" }));
    await fireEvent.pointerDown(screen.getByRole("button", { name: /^Update track/ }), {
      pointerType: "mouse",
      button: 0,
    });
    expect(screen.getByRole("option", { name: "Stable" })).toHaveAttribute("aria-selected", "true");
    await fireEvent.click(screen.getByRole("option", { name: "Stable" }));

    expect(screen.getByText("Version 0.2.1")).toBeInTheDocument();
    expect(screen.getByText("OpenBot v0.3.0 is available to download.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download update" })).toBeEnabled();

    setStatus({ ...status(), phase: "downloading", progress: 42 });
    expect(await screen.findByText("Downloading OpenBot v0.3.0 · 42%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Downloading update…" })).toBeDisabled();

    setStatus({ ...status(), phase: "ready", progress: 100 });
    expect(await screen.findByText("OpenBot v0.3.0 is ready. Restart to apply.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart to update" })).toBeEnabled();
  });

  it("disables busy update actions and shows action failures", async () => {
    const onUpdateAction = vi.fn(async () => {
      throw new Error("Update service is offline.");
    });
    const view = render(() => (
      <SettingsModal
        open
        onOpenChange={() => undefined}
        value={DEFAULT_GENERAL_SETTINGS}
        onValueChange={() => undefined}
        appInfo={{ name: "OpenBot", version: "0.2.1", platform: "darwin", variant: "dev" }}
        updateStatus={idleUpdateStatus}
        onUpdateAction={onUpdateAction}
        account={account}
        onUpdateAccountName={vi.fn(async () => undefined)}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
      />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Updates" }));
    await fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Update service is offline.")).toBeInTheDocument();

    view.unmount();
    render(() => (
      <SettingsModal
        open
        onOpenChange={() => undefined}
        value={DEFAULT_GENERAL_SETTINGS}
        onValueChange={() => undefined}
        appInfo={{ name: "OpenBot", version: "0.2.1", platform: "darwin", variant: "dev" }}
        updateStatus={{ ...idleUpdateStatus, phase: "checking" }}
        onUpdateAction={onUpdateAction}
        account={account}
        onUpdateAccountName={vi.fn(async () => undefined)}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
      />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Updates" }));
    expect(screen.getByRole("button", { name: "Checking for updates…" })).toBeDisabled();
  });

  it("resets a display-name draft and saves its trimmed value", async () => {
    const [currentAccount, setCurrentAccount] = createSignal({ ...account });
    const onUpdateAccountName = vi.fn(async (name: string) => {
      setCurrentAccount((current) => ({ ...current, name }));
    });

    render(() => (
      <SettingsModal
        open
        onOpenChange={() => undefined}
        value={DEFAULT_GENERAL_SETTINGS}
        onValueChange={() => undefined}
        appInfo={{ name: "OpenBot", version: "0.2.1", platform: "darwin", variant: "dev" }}
        updateStatus={idleUpdateStatus}
        onUpdateAction={vi.fn(async () => undefined)}
        account={currentAccount()}
        onUpdateAccountName={onUpdateAccountName}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
      />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Profile" }));
    const input = screen.getByRole("textbox", { name: "Display name" });
    await fireEvent.input(input, { target: { value: "Unsaved name" } });
    await fireEvent.click(screen.getByRole("tab", { name: "Updates" }));
    await fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await fireEvent.click(screen.getByRole("tab", { name: "Profile" }));
    expect(input).toHaveValue("Norbert");
    expect(onUpdateAccountName).not.toHaveBeenCalled();

    await fireEvent.input(input, { target: { value: "  No\u0308ra\u00a0\u00a0Bot  " } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdateAccountName).toHaveBeenCalledWith("Nöra Bot"));
    expect(input).toHaveValue("Nöra Bot");
  });

  it("keeps an invalid display name focused and does not save it", async () => {
    const onUpdateAccountName = vi.fn(async () => undefined);
    render(() => (
      <SettingsModal
        open
        onOpenChange={() => undefined}
        value={DEFAULT_GENERAL_SETTINGS}
        onValueChange={() => undefined}
        appInfo={{ name: "OpenBot", version: "0.2.1", platform: "darwin", variant: "dev" }}
        updateStatus={idleUpdateStatus}
        onUpdateAction={vi.fn(async () => undefined)}
        account={account}
        onUpdateAccountName={onUpdateAccountName}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
      />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Profile" }));
    const input = screen.getByRole("textbox", { name: "Display name" });
    await fireEvent.input(input, { target: { value: " " } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onUpdateAccountName).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a display name.");
    await waitFor(() => expect(input).toHaveFocus());

    await fireEvent.input(input, { target: { value: "No" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onUpdateAccountName).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("Use at least 3 characters.");

    await fireEvent.input(input, { target: { value: "Nor\u200bbert" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onUpdateAccountName).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("Remove line breaks and hidden or control characters.");
  });

  it("keeps the display-name draft after a save failure", async () => {
    const onUpdateAccountName = vi.fn(async () => {
      throw new Error("Profile service is offline.");
    });
    render(() => (
      <SettingsModal
        open
        onOpenChange={() => undefined}
        value={DEFAULT_GENERAL_SETTINGS}
        onValueChange={() => undefined}
        appInfo={{ name: "OpenBot", version: "0.2.1", platform: "darwin", variant: "dev" }}
        updateStatus={idleUpdateStatus}
        onUpdateAction={vi.fn(async () => undefined)}
        account={account}
        onUpdateAccountName={onUpdateAccountName}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
      />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Profile" }));
    const input = screen.getByRole("textbox", { name: "Display name" });
    await fireEvent.input(input, { target: { value: "Nora" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Profile service is offline.");
    expect(input).toHaveValue("Nora");
  });

  it("updates and removes the signed-in account avatar from Profile settings", async () => {
    const [currentAccount, setCurrentAccount] = createSignal({ ...account });
    const onUpdateAccountAvatar = vi.fn(async (image: AvatarImageInput | null) => {
      setCurrentAccount((current) => ({
        ...current,
        avatarUrl: image ? "data:image/webp;base64,cHJvZmlsZQ==" : null,
      }));
    });

    render(() => (
      <SettingsModal
        open
        onOpenChange={() => undefined}
        value={DEFAULT_GENERAL_SETTINGS}
        onValueChange={() => undefined}
        appInfo={{ name: "OpenBot", version: "0.2.1", platform: "darwin", variant: "dev" }}
        updateStatus={idleUpdateStatus}
        onUpdateAction={vi.fn(async () => undefined)}
        account={currentAccount()}
        onUpdateAccountName={vi.fn(async () => undefined)}
        onUpdateAccountAvatar={onUpdateAccountAvatar}
        processAvatarFile={async () => ({
          mimeType: "image/webp",
          bytes: new Uint8Array([1, 2, 3]),
        })}
      />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Profile" }));
    const input = screen.getByLabelText("Upload profile photo");
    const file = new File(["profile"], "profile.png", { type: "image/png" });
    await fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(onUpdateAccountAvatar).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "image/webp" })),
    );
    await fireEvent.click(await screen.findByRole("button", { name: "Remove profile photo" }));
    await waitFor(() => expect(onUpdateAccountAvatar).toHaveBeenLastCalledWith(null));
  });
});

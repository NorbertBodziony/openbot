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
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
      />
    ));

    await fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(onUpdateAction).toHaveBeenCalledOnce());
    expect(await screen.findByText("OpenBot is up to date.")).toBeInTheDocument();
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
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
      />
    ));

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
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
      />
    ));

    expect(screen.getByRole("button", { name: "Checking for updates…" })).toBeDisabled();
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
    await fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onUpdateAccountAvatar).toHaveBeenLastCalledWith(null));
  });
});

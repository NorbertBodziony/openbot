import type {
  AvatarImageInput,
  CentralAuthUser,
  HostedSitesDesktopApi,
  MobileConnectedDevice,
  UpdateStatus,
} from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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

  it("does not mark a normalized legacy display name as changed", async () => {
    render(() => (
      <SettingsModal
        open
        onOpenChange={() => undefined}
        value={DEFAULT_GENERAL_SETTINGS}
        onValueChange={() => undefined}
        appInfo={{ name: "OpenBot", version: "0.2.1", platform: "darwin", variant: "dev" }}
        updateStatus={idleUpdateStatus}
        onUpdateAction={vi.fn(async () => undefined)}
        account={{ ...account, name: "Jose\u0301" }}
        onUpdateAccountName={vi.fn(async () => undefined)}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
      />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Profile" }));

    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("Jose\u0301");
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
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

  it("lists a bot-published site with only Open and Delete actions", async () => {
    const site = {
      id: "site-1",
      hostname: "interactive-budget-planner-students-23456789ab.openbot.site",
      url: "https://interactive-budget-planner-students-23456789ab.openbot.site",
      title: "Student budget planner",
      description: "Plan a student budget.",
      framework: "vanilla" as const,
      status: "active" as const,
      fileCount: 3,
      size: 1_024,
      expiresAt: "2026-09-30T12:00:00.000Z",
      updatedAt: "2026-08-31T12:00:00.000Z",
    };
    const hostedSitesApi: HostedSitesDesktopApi = {
      list: vi.fn(async () => [site]),
      chooseDirectory: vi.fn(async () => "/tmp/student-budget-site"),
      publish: vi.fn(async () => site),
      replace: vi.fn(async () => site),
      delete: vi.fn(async () => undefined),
    };
    const openUrl = vi.fn(async () => undefined);
    vi.stubGlobal("openbot", { openUrl });
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
        onUpdateAccountName={vi.fn(async () => undefined)}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
        hostedSitesApi={hostedSitesApi}
      />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Hosted sites" }));
    expect(await screen.findByText(site.hostname)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: site.hostname }));
    await fireEvent.click(screen.getByRole("button", { name: `Open ${site.hostname}` }));

    expect(openUrl).toHaveBeenNthCalledWith(1, site.url);
    expect(openUrl).toHaveBeenNthCalledWith(2, site.url);
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Replace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Copy ${site.hostname} URL` })).not.toBeInTheDocument();
    expect(hostedSitesApi.chooseDirectory).not.toHaveBeenCalled();
    expect(hostedSitesApi.publish).not.toHaveBeenCalled();
    expect(hostedSitesApi.replace).not.toHaveBeenCalled();
  });

  it("confirms a hosted-site deletion and reloads the list", async () => {
    const site = {
      id: "site-to-delete",
      hostname: "temporary-project-site-23456789ab.openbot.site",
      url: "https://temporary-project-site-23456789ab.openbot.site",
      title: "Temporary project site",
      description: "Verify deletion and list refresh.",
      framework: "vanilla" as const,
      status: "active" as const,
      fileCount: 1,
      size: 256,
      expiresAt: "2026-09-30T12:00:00.000Z",
      updatedAt: "2026-08-31T12:00:00.000Z",
    };
    const hostedSitesApi: HostedSitesDesktopApi = {
      list: vi.fn().mockResolvedValueOnce([site]).mockResolvedValue([]),
      chooseDirectory: vi.fn(async () => "/tmp/queued-site"),
      publish: vi.fn(async () => site),
      replace: vi.fn(async () => site),
      delete: vi.fn(async () => undefined),
    };
    vi.spyOn(window, "confirm").mockReturnValue(true);
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
        onUpdateAccountName={vi.fn(async () => undefined)}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
        hostedSitesApi={hostedSitesApi}
      />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Hosted sites" }));
    expect(await screen.findByText(site.hostname)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: `Delete ${site.hostname}` }));

    expect(window.confirm).toHaveBeenCalledWith(
      `Delete ${site.hostname}? This address will immediately return 410 Gone.`,
    );
    await waitFor(() => expect(hostedSitesApi.delete).toHaveBeenCalledWith({ siteId: site.id }));
    await waitFor(() => expect(hostedSitesApi.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(site.hostname)).not.toBeInTheDocument());
  });

  it("shows a blocked hosted site and disables Open", async () => {
    const site = {
      id: "blocked-site",
      hostname: "blocked-project-site-23456789ab.openbot.site",
      url: "https://blocked-project-site-23456789ab.openbot.site",
      title: "Blocked project site",
      description: "A blocked hosted site.",
      framework: "vanilla" as const,
      status: "blocked" as const,
      fileCount: 1,
      size: 256,
      expiresAt: "2026-09-30T12:00:00.000Z",
      updatedAt: "2026-08-31T12:00:00.000Z",
    };
    const hostedSitesApi: HostedSitesDesktopApi = {
      list: vi.fn(async () => [site]),
      chooseDirectory: vi.fn(async () => null),
      publish: vi.fn(async () => site),
      replace: vi.fn(async () => site),
      delete: vi.fn(async () => undefined),
    };
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
        onUpdateAccountName={vi.fn(async () => undefined)}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
        hostedSitesApi={hostedSitesApi}
      />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Hosted sites" }));
    expect(await screen.findByText("Blocked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Open ${site.hostname}` })).toBeDisabled();
  });

  it("generates a one-time QR code from Mobile Connect settings", async () => {
    const onCreateMobileConnect = vi.fn(async () => ({
      qrData:
        "openbot://mobile-connect?api=https%3A%2F%2Fapi.openbot.run&ticket=mobile-ticket_1234567890abcdefghijklmnop",
      expiresAt: Date.now() + 120_000,
    }));
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
        onUpdateAccountName={vi.fn(async () => undefined)}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
        onCreateMobileConnect={onCreateMobileConnect}
      />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Mobile Connect" }));
    await fireEvent.click(screen.getByRole("button", { name: "Generate QR code" }));

    await waitFor(() => expect(onCreateMobileConnect).toHaveBeenCalledOnce());
    expect(await screen.findByRole("img", { name: "Mobile Connect sign-in QR code" })).toBeInTheDocument();
    expect(screen.getByText(/Expires in/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate new code" })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Connected devices" })).toBeInTheDocument();
    expect(screen.getByText("No connected devices")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Access is revoked immediately. The mobile app may keep showing its current screen until it is reopened or brought back from the background.",
      ),
    ).toBeInTheDocument();
  });

  it("confirms a new mobile connection before collapsing the QR code", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const devices: MobileConnectedDevice[] = [];
    const onListMobileConnectedDevices = vi.fn(async () => [...devices]);
    const view = render(() => (
      <SettingsModal
        open
        onOpenChange={() => undefined}
        value={DEFAULT_GENERAL_SETTINGS}
        onValueChange={() => undefined}
        appInfo={{ name: "OpenBot", version: "0.2.1", platform: "darwin", variant: "dev" }}
        updateStatus={idleUpdateStatus}
        onUpdateAction={vi.fn(async () => undefined)}
        account={account}
        onUpdateAccountName={vi.fn(async () => undefined)}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
        onCreateMobileConnect={async () => ({
          qrData: "openbot://mobile-connect?api=https%3A%2F%2Fapi.openbot.run&ticket=mobile-ticket_success_1234567890",
          expiresAt: Date.now() + 120_000,
        })}
        onListMobileConnectedDevices={onListMobileConnectedDevices}
        onRevokeMobileConnectedDevice={vi.fn(async () => undefined)}
      />
    ));

    try {
      await fireEvent.click(screen.getByRole("tab", { name: "Mobile Connect" }));
      await vi.advanceTimersByTimeAsync(0);
      await fireEvent.click(screen.getByRole("button", { name: "Generate QR code" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByRole("img", { name: "Mobile Connect sign-in QR code" })).toBeInTheDocument();
      const requestsBeforePolling = onListMobileConnectedDevices.mock.calls.length;

      devices.push({
        sessionId: "22222222-2222-4222-8222-222222222222",
        name: "Norbert’s iPhone",
        platform: "ios",
        connectedAt: Date.now(),
        lastActiveAt: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(onListMobileConnectedDevices).toHaveBeenCalledTimes(requestsBeforePolling);
      expect(screen.queryByText("Phone connected")).not.toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(1);
      expect(onListMobileConnectedDevices).toHaveBeenCalledTimes(requestsBeforePolling + 1);

      expect(screen.getByText("Phone connected")).toBeInTheDocument();
      expect(screen.getByText("Norbert’s iPhone is ready to use OpenBot.")).toBeInTheDocument();
      expect(screen.getByRole("table")).toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(1_200);
      expect(screen.queryByRole("img", { name: "Mobile Connect sign-in QR code" })).not.toBeInTheDocument();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("captures the existing device baseline before issuing a Mobile Connect ticket", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const existingDevice: MobileConnectedDevice = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      name: "Existing iPhone",
      platform: "ios",
      connectedAt: Date.now() - 60_000,
      lastActiveAt: Date.now(),
    };
    let resolveInitialDevices: ((devices: MobileConnectedDevice[]) => void) | undefined;
    const initialDevices = new Promise<MobileConnectedDevice[]>((resolve) => {
      resolveInitialDevices = resolve;
    });
    const onListMobileConnectedDevices = vi
      .fn<() => Promise<MobileConnectedDevice[]>>()
      .mockImplementationOnce(() => initialDevices)
      .mockImplementationOnce(() => initialDevices)
      .mockResolvedValue([existingDevice]);
    const onCreateMobileConnect = vi.fn(async () => ({
      qrData: "openbot://mobile-connect?api=https%3A%2F%2Fapi.openbot.run&ticket=mobile-ticket_baseline_1234567890",
      expiresAt: Date.now() + 120_000,
    }));
    const view = render(() => (
      <SettingsModal
        open
        onOpenChange={() => undefined}
        value={DEFAULT_GENERAL_SETTINGS}
        onValueChange={() => undefined}
        appInfo={{ name: "OpenBot", version: "0.2.1", platform: "darwin", variant: "dev" }}
        updateStatus={idleUpdateStatus}
        onUpdateAction={vi.fn(async () => undefined)}
        account={account}
        onUpdateAccountName={vi.fn(async () => undefined)}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
        onCreateMobileConnect={onCreateMobileConnect}
        onListMobileConnectedDevices={onListMobileConnectedDevices}
      />
    ));

    try {
      await fireEvent.click(screen.getByRole("tab", { name: "Mobile Connect" }));
      await fireEvent.click(screen.getByRole("button", { name: "Generate QR code" }));
      expect(onCreateMobileConnect).not.toHaveBeenCalled();

      resolveInitialDevices?.([existingDevice]);
      await vi.advanceTimersByTimeAsync(0);
      expect(onCreateMobileConnect).toHaveBeenCalledOnce();
      expect(screen.getByRole("img", { name: "Mobile Connect sign-in QR code" })).toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(screen.queryByText("Phone connected")).not.toBeInTheDocument();
      expect(screen.getByRole("img", { name: "Mobile Connect sign-in QR code" })).toBeInTheDocument();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("refreshes connected mobile devices once per minute while no QR code is active", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const onListMobileConnectedDevices = vi.fn(async () => []);
    const view = render(() => (
      <SettingsModal
        open
        onOpenChange={() => undefined}
        value={DEFAULT_GENERAL_SETTINGS}
        onValueChange={() => undefined}
        appInfo={{ name: "OpenBot", version: "0.2.1", platform: "darwin", variant: "dev" }}
        updateStatus={idleUpdateStatus}
        onUpdateAction={vi.fn(async () => undefined)}
        account={account}
        onUpdateAccountName={vi.fn(async () => undefined)}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
        onListMobileConnectedDevices={onListMobileConnectedDevices}
      />
    ));

    try {
      await fireEvent.click(screen.getByRole("tab", { name: "Mobile Connect" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(onListMobileConnectedDevices).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(59_999);
      expect(onListMobileConnectedDevices).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(onListMobileConnectedDevices).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("lists connected mobile devices and revokes one device session", async () => {
    const onListMobileConnectedDevices = vi.fn(async () => [
      {
        sessionId: "11111111-1111-4111-8111-111111111111",
        name: "Norbert’s iPhone",
        platform: "ios" as const,
        connectedAt: Date.now() - 60_000,
        lastActiveAt: Date.now(),
      },
    ]);
    const onRevokeMobileConnectedDevice = vi.fn(async () => undefined);
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
        onUpdateAccountName={vi.fn(async () => undefined)}
        onUpdateAccountAvatar={vi.fn(async () => undefined)}
        onListMobileConnectedDevices={onListMobileConnectedDevices}
        onRevokeMobileConnectedDevice={onRevokeMobileConnectedDevice}
      />
    ));

    await fireEvent.click(screen.getByRole("tab", { name: "Mobile Connect" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Disconnect Norbert’s iPhone" }));

    await waitFor(() =>
      expect(onRevokeMobileConnectedDevice).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111"),
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("No connected devices")).toBeInTheDocument();
  });
});

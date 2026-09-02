import type { BotSummary } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { App } from "./App";
import { desktopAnalytics } from "./analytics";
import { BOTS, emitAgentEvent, emitUpdateStatus, installOpenbotStub, trackAnalytics } from "./app-test-harness";

describe("OpenBot connected desktop shell", () => {
  beforeEach(() => {
    installOpenbotStub();
  });

  it("opens the dock surfaces and closes them through every close path", async () => {
    render(() => <App />);
    await waitFor(() => expect(window.openbot.agent.getUsage).toHaveBeenCalledTimes(1));

    const usageButton = await screen.findByRole("button", { name: "Weekly usage, 59% left" });
    await fireEvent.click(usageButton);
    const usageDialog = screen.getByRole("dialog", { name: "Weekly usage" });
    const usageProgress = within(usageDialog).getByRole("progressbar", { name: "Weekly usage remaining" });
    expect(usageProgress).toHaveAttribute("aria-valuenow", "59");
    expect(usageProgress).toHaveAttribute("aria-valuetext", "59% left");
    await fireEvent.click(within(usageDialog).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(window.openbot.agent.getUsage).toHaveBeenCalledTimes(2));
    await fireEvent.keyDown(usageDialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Weekly usage" })).not.toBeInTheDocument());

    const accountButton = screen.getByRole("button", { name: "Open account actions" });
    await fireEvent.click(accountButton);
    const accountDialog = screen.getByRole("dialog", { name: "Account actions" });
    expect(within(accountDialog).queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    await fireEvent.keyDown(accountDialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Account actions" })).not.toBeInTheDocument());

    await fireEvent.click(accountButton);
    const reopenedAccountDialog = await screen.findByRole("dialog", { name: "Account actions" });
    fireEvent.click(within(reopenedAccountDialog).getByRole("button", { name: "Send feedback" }));
    await waitFor(() => expect(window.openbot.openExternal).toHaveBeenCalledWith("feedback"));

    fireEvent.click(accountButton);
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    await waitFor(() => expect(window.openbot.openExternal).toHaveBeenCalledWith("message"));

    const settingsButton = screen.getByRole("button", { name: "Settings" });
    await fireEvent.click(settingsButton);
    let dialog = await screen.findByRole("dialog", { name: "General" });
    const launchSwitch = within(dialog).getByRole("switch", { name: "Launch OpenBot at login" });
    await fireEvent.click(launchSwitch);
    expect(launchSwitch).not.toBeChecked();

    await fireEvent.click(within(dialog).getByRole("button", { name: "Close settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());

    await fireEvent.click(settingsButton);
    dialog = await screen.findByRole("dialog", { name: "General" });
    await fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());

    await fireEvent.click(settingsButton);
    await screen.findByRole("dialog", { name: "General" });
    await fireEvent.pointerDown(screen.getByTestId("settings-modal-backdrop"), { button: 0 });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());
  });

  it("persists every settings preference through its own IPC channel", async () => {
    vi.mocked(window.openbot.update.getPreference).mockResolvedValue({ autoDownload: false });
    render(() => <App />);
    await fireEvent.click(await screen.findByRole("button", { name: "Settings" }));

    await fireEvent.click(await screen.findByRole("switch", { name: "Share product analytics" }));
    await waitFor(() => expect(window.openbot.setAnalyticsPreference).toHaveBeenCalledWith({ enabled: false }));

    const notchSwitch = await screen.findByRole("switch", { name: "Show status in the MacBook notch" });
    expect(notchSwitch).toBeChecked();
    await fireEvent.click(notchSwitch);
    await waitFor(() =>
      expect(window.openbot.dynamicIsland.setPreference).toHaveBeenCalledWith({
        enabled: false,
        hapticsEnabled: true,
        idleVisible: true,
        additionalDisplaysEnabled: true,
      }),
    );
    expect(notchSwitch).not.toBeChecked();

    await fireEvent.click(await screen.findByRole("tab", { name: "Updates" }));
    const autoDownload = await screen.findByRole("switch", { name: "Automatically download updates" });
    await waitFor(() => expect(autoDownload).not.toBeChecked());
    await fireEvent.click(autoDownload);
    await waitFor(() => expect(window.openbot.update.setPreference).toHaveBeenCalledWith({ autoDownload: true }));
  });

  it("does not open desktop analytics when the saved preference is disabled", async () => {
    vi.mocked(window.openbot.getAnalyticsPreference).mockResolvedValueOnce({ enabled: false });
    const setTrackingEnabled = vi.spyOn(desktopAnalytics, "setTrackingEnabled");
    render(() => <App />);

    await screen.findByRole("heading", { name: "Chief" });
    await waitFor(() => expect(setTrackingEnabled).toHaveBeenCalledWith(false));
    expect(trackAnalytics).not.toHaveBeenCalledWith("desktop_app_opened", expect.anything());
    setTrackingEnabled.mockRestore();
  });

  it("signs out from the account menu without removing local data", async () => {
    render(() => <App />);
    await fireEvent.click(await screen.findByRole("button", { name: "Open account actions" }));
    await fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(window.openbot.auth.logout).toHaveBeenCalledOnce());
    expect(trackAnalytics).toHaveBeenCalledWith("account_sign_out", { result: "succeeded" });
    expect(await screen.findByRole("heading", { name: "Sign in to OpenBot" })).toBeInTheDocument();
    expect(window.openbot.agent.deleteBot).not.toHaveBeenCalled();
  });

  it("shows an available update, downloads it, and exposes restart to install", async () => {
    vi.mocked(window.openbot.update.getStatus).mockResolvedValueOnce({
      phase: "available",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progress: null,
      checkedAt: "2026-08-12T22:00:00.000Z",
      message: null,
      errorCode: null,
    });
    render(() => <App />);

    expect(await screen.findByText("New update available")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open account actions" }));
    fireEvent.click(await screen.findByRole("button", { name: /Download update/ }));
    await waitFor(() => expect(window.openbot.update.download).toHaveBeenCalledOnce());
    expect(trackAnalytics).toHaveBeenCalledWith("update_action", {
      action: "download",
      result: "succeeded",
      phase: "downloading",
    });

    emitUpdateStatus?.({
      phase: "ready",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progress: 100,
      checkedAt: "2026-08-12T22:00:00.000Z",
      message: null,
      errorCode: null,
    });
    fireEvent.click(await screen.findByRole("button", { name: /Restart to update/ }));
    await waitFor(() => expect(window.openbot.update.install).toHaveBeenCalledOnce());
  });

  it("reports every update failure as a retryable action", async () => {
    vi.mocked(window.openbot.update.getStatus).mockResolvedValueOnce({
      phase: "available",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progress: null,
      checkedAt: null,
      message: null,
      errorCode: null,
    });
    vi.mocked(window.openbot.update.download)
      .mockResolvedValueOnce({
        phase: "error",
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        progress: null,
        checkedAt: "2026-08-12T22:00:00.000Z",
        message: "Could not check for updates. Try again.",
        errorCode: "download_failed",
      })
      .mockRejectedValueOnce(new Error("Could not download update. Try again."));
    render(() => <App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open account actions" }));
    fireEvent.click(await screen.findByRole("button", { name: /Download update/ }));

    await waitFor(() =>
      expect(trackAnalytics).toHaveBeenCalledWith("update_action", {
        action: "download",
        result: "failed",
        phase: "error",
        failure_code: "download_failed",
      }),
    );
    const retryAfterReturnedError = await screen.findByRole("button", {
      name: /Retry update.*Could not check for updates/,
    });
    expect(retryAfterReturnedError).toBeEnabled();

    fireEvent.click(retryAfterReturnedError);

    expect(await screen.findByRole("button", { name: /Retry update.*Could not download update/ })).toBeEnabled();
    await waitFor(() => expect(window.openbot.update.download).toHaveBeenCalledTimes(2));
    expect(window.openbot.update.check).not.toHaveBeenCalled();
  });

  it("keeps a toggle made before the stored preference finishes loading", async () => {
    let resolvePreference: ((value: { autoDownload: boolean }) => void) | undefined;
    vi.mocked(window.openbot.update.getPreference).mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePreference = resolve;
      }),
    );
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    await fireEvent.click(await screen.findByRole("tab", { name: "Updates" }));
    const toggle = await screen.findByRole("switch", { name: "Automatically download updates" });
    await fireEvent.click(toggle);
    await waitFor(() => expect(window.openbot.update.setPreference).toHaveBeenCalledWith({ autoDownload: false }));

    // The stored read finally lands with the value the user has just replaced. Painting it back would
    // leave the switch disagreeing with both disk and the main process.
    resolvePreference?.({ autoDownload: true });
    // Let the hydration continuation actually run, otherwise this asserts before it could apply.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(toggle).not.toBeChecked();
  });

  it("confirms an installed app version on the next launch", async () => {
    const configureAnalytics = vi.spyOn(desktopAnalytics, "configure").mockReturnValue(true);
    window.localStorage.setItem("openbot:analytics-app-version", "0.0.9");
    render(() => <App />);

    await waitFor(() =>
      expect(trackAnalytics).toHaveBeenCalledWith("app_updated", {
        from_version: "0.0.9",
        to_version: "0.1.0",
      }),
    );
    expect(window.localStorage.getItem("openbot:analytics-app-version")).toBe("0.1.0");
    configureAnalytics.mockRestore();
  });

  it("selects a provider and model from the conversation header", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    const trigger = screen.getByRole("button", { name: "Agent model: Luna" });
    await fireEvent.click(trigger);
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    expect(within(picker).getByText("0.144.1 (Codex CLI)")).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: "Luna, default" })).toHaveAttribute("aria-selected", "true");

    await fireEvent.click(within(picker).getByRole("tab", { name: /^Claude:/ }));
    expect(window.openbot.agent.updateBot).not.toHaveBeenCalled();
    expect(within(picker).getByText("2.1.231 (Claude Code)")).toBeInTheDocument();
    await fireEvent.click(within(picker).getByRole("option", { name: "Claude Opus 5, default" }));

    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        model: "claude-opus-5",
        provider: "claude",
        reasoningEffort: "medium",
      }),
    );
    expect(screen.getByRole("dialog", { name: "Choose agent model" })).toBeInTheDocument();
    const claudeTrigger = await screen.findByRole("button", {
      name: "Agent model: Claude Opus 5",
    });
    expect(claudeTrigger).toBeEnabled();
  });

  it("persists rapid model and effort changes in order as complete settings", async () => {
    const chief = BOTS.find((bot) => bot.id === "chief");
    if (!chief) throw new Error("Chief fixture is missing");
    let resolveModelUpdate!: (bot: BotSummary) => void;
    vi.mocked(window.openbot.agent.updateBot)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveModelUpdate = resolve;
          }),
      )
      .mockImplementationOnce(async (input) => ({
        ...chief,
        ...input,
        provider: "claude",
        model: "claude-opus-5",
      }));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "Agent model: Luna" }));
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("tab", { name: /^Claude:/ }));
    await fireEvent.click(within(picker).getByRole("option", { name: "Claude Opus 5, default" }));
    const effort = within(picker).getByRole("button", { name: /Agent reasoning effort/ });
    await fireEvent.pointerDown(effort, { pointerType: "mouse", button: 0 });
    await fireEvent.click(screen.getByRole("option", { name: "High" }));

    expect(window.openbot.agent.updateBot).toHaveBeenCalledTimes(1);
    expect(effort).toHaveTextContent("High");
    resolveModelUpdate({
      ...chief,
      provider: "claude",
      model: "claude-opus-5",
      reasoningEffort: "medium",
    });

    await waitFor(() =>
      expect(vi.mocked(window.openbot.agent.updateBot).mock.calls).toEqual([
        [
          {
            botId: "chief",
            provider: "claude",
            model: "claude-opus-5",
            reasoningEffort: "medium",
          },
        ],
        [
          {
            botId: "chief",
            reasoningEffort: "high",
          },
        ],
      ]),
    );
    expect(window.openbot.agent.updateBot).toHaveBeenLastCalledWith({
      botId: "chief",
      reasoningEffort: "high",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("button", { name: "Agent model: Claude Opus 5" })).toBeEnabled();
    expect(effort).toHaveTextContent("High");
  });

  it("rolls back a queued effort when its model save fails", async () => {
    let rejectModelUpdate!: (error: Error) => void;
    vi.mocked(window.openbot.agent.updateBot).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectModelUpdate = reject;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "Agent model: Luna" }));
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("option", { name: "Sol" }));
    const effort = within(picker).getByRole("button", { name: /Agent reasoning effort/ });
    await fireEvent.pointerDown(effort, { pointerType: "mouse", button: 0 });
    await fireEvent.click(screen.getByRole("option", { name: "Extra high" }));

    expect(window.openbot.agent.updateBot).toHaveBeenCalledTimes(1);
    rejectModelUpdate(new Error("Model failed"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not change effort. Try again.");
    expect(window.openbot.agent.updateBot).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Agent model: Luna" })).toBeEnabled();
    expect(effort).toHaveTextContent("Medium");
    await fireEvent.click(screen.getByRole("button", { name: "Agent model: Luna" }));
  });

  it("reconciles a concurrent model update after an effort save succeeds", async () => {
    let resolveEffortUpdate!: (bot: BotSummary) => void;
    vi.mocked(window.openbot.agent.updateBot).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveEffortUpdate = resolve;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "Agent model: Luna" }));
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    const effort = within(picker).getByRole("button", { name: /Agent reasoning effort/ });
    await fireEvent.pointerDown(effort, { pointerType: "mouse", button: 0 });
    await fireEvent.click(screen.getByRole("option", { name: "High" }));

    const chief = BOTS.find((bot) => bot.id === "chief");
    if (!chief) throw new Error("Chief fixture is missing");
    const concurrentBot = { ...chief, model: "gpt-5.6-sol" as const, reasoningEffort: "high" as const };
    emitAgentEvent?.({ type: "bots-changed", bots: BOTS.map((bot) => (bot.id === "chief" ? concurrentBot : bot)) });
    expect(screen.getByRole("button", { name: "Agent model: Luna" })).toBeEnabled();

    resolveEffortUpdate(concurrentBot);

    expect(await screen.findByRole("button", { name: "Agent model: Sol" })).toBeEnabled();
    expect(effort).toHaveTextContent("High");
    await fireEvent.click(screen.getByRole("button", { name: "Agent model: Sol" }));
  });

  it("does not roll back a newer effort when an older save fails", async () => {
    let rejectFirstUpdate!: (error: Error) => void;
    vi.mocked(window.openbot.agent.updateBot).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectFirstUpdate = reject;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "Agent model: Luna" }));
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    const effort = within(picker).getByRole("button", { name: /Agent reasoning effort/ });
    await fireEvent.pointerDown(effort, { pointerType: "mouse", button: 0 });
    await fireEvent.click(screen.getByRole("option", { name: "High" }));
    await fireEvent.pointerDown(effort, { pointerType: "mouse", button: 0 });
    await fireEvent.click(screen.getByRole("option", { name: "Low" }));

    expect(window.openbot.agent.updateBot).toHaveBeenCalledTimes(1);
    rejectFirstUpdate(new Error("Older effort failed"));
    await waitFor(() => expect(window.openbot.agent.updateBot).toHaveBeenCalledTimes(2));
    expect(window.openbot.agent.updateBot).toHaveBeenLastCalledWith({
      botId: "chief",
      reasoningEffort: "low",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(effort).toHaveTextContent("Low");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not roll back or report an effort failure after switching agents", async () => {
    let rejectUpdate!: (error: Error) => void;
    vi.mocked(window.openbot.agent.updateBot).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectUpdate = reject;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "Agent model: Luna" }));
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    const effort = within(picker).getByRole("button", { name: /Agent reasoning effort/ });
    await fireEvent.pointerDown(effort, { pointerType: "mouse", button: 0 });
    await fireEvent.click(screen.getByRole("option", { name: "High" }));
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    await screen.findByRole("heading", { name: "Sales Outbound" });

    rejectUpdate(new Error("Chief effort failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agent model: Luna" })).toBeEnabled();
  });

  it("shows unavailable providers without allowing their models", async () => {
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "ready",
      cliVersion: "0.144.1",
      auth: { kind: "chatgpt", email: "norbert@example.com" },
      providers: [
        { id: "codex", state: "available", version: "0.144.1", message: null },
        {
          id: "claude",
          state: "not-installed",
          version: null,
          message: "Claude CLI was not found.",
        },
      ],
      capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
      message: null,
      fullAccess: true,
    });
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "Agent model: Luna" }));
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("tab", { name: /Claude: Claude CLI was not found/ }));
    expect(within(picker).getByText("Claude CLI was not found.")).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: "Claude Opus 5, default" })).toBeDisabled();
    expect(window.openbot.agent.updateBot).not.toHaveBeenCalled();
  });

  it("rolls back a failed header model change and reports the error", async () => {
    vi.mocked(window.openbot.agent.updateBot).mockRejectedValueOnce(new Error("Provider failed"));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await screen.findByRole("button", { name: "Agent model: Luna" });

    await fireEvent.click(screen.getByRole("button", { name: "Agent model: Luna" }));
    await fireEvent.click(screen.getByRole("option", { name: "Sol" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not change model. Try again.");
    expect(screen.getByRole("button", { name: "Agent model: Luna" })).toBeEnabled();
    expect(
      screen.queryByRole("radiogroup", { name: "What do you want me helping with most?" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Chief")).toHaveAttribute("contenteditable", "true");
  });

  it("rolls back a failed header effort change and reports the error", async () => {
    vi.mocked(window.openbot.agent.updateBot).mockRejectedValueOnce(new Error("Effort failed"));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "Agent model: Luna" }));
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    const effort = within(picker).getByRole("button", { name: /Agent reasoning effort/ });
    await fireEvent.pointerDown(effort, { pointerType: "mouse", button: 0 });
    await fireEvent.click(screen.getByRole("option", { name: "High" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not change effort. Try again.");
    expect(effort).toHaveTextContent("Medium");
    expect(picker).toBeInTheDocument();
  });

  it("locks the header model picker during active work", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const trigger = screen.getByRole("button", { name: "Agent model: Luna" });
    await waitFor(() => expect(trigger).toBeEnabled());

    emitAgentEvent?.({
      type: "turn-started",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-1",
    });
    await waitFor(() => expect(trigger).toBeDisabled());

    emitAgentEvent?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-1",
      status: "completed",
    });
    await waitFor(() => expect(trigger).toBeEnabled());
    expect(trackAnalytics).not.toHaveBeenCalledWith("system_turn_started", expect.anything());
    expect(trackAnalytics).not.toHaveBeenCalledWith("system_turn_completed", expect.anything());
  });

  it("supports picker keyboard navigation and outside dismissal", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const trigger = screen.getByRole("button", { name: "Agent model: Luna" });

    await fireEvent.click(trigger);
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    const codex = within(picker).getByRole("tab", { name: /^ChatGPT:/ });
    await fireEvent.keyDown(codex, { key: "ArrowUp" });
    const claude = within(picker).getByRole("tab", { name: /^Claude:/ });
    expect(claude).toHaveAttribute("aria-selected", "true");

    await fireEvent.keyDown(picker, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose agent model" })).not.toBeInTheDocument();
    await fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Choose agent model" })).toBeInTheDocument();
    await fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Choose agent model" })).not.toBeInTheDocument();
  });

  it("edits the persisted model and thinking level in agent settings", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));

    const settings = await screen.findByRole("complementary", { name: "Agent settings" });
    const thinking = within(settings).getByRole("button", { name: /Agent reasoning level/ });
    expect(within(settings).getByRole("button", { name: "Agent model: Luna" })).toBeEnabled();
    expect(thinking).toHaveTextContent("Medium");

    await fireEvent.click(within(settings).getByRole("button", { name: "Agent model: Luna" }));
    let picker = within(settings).getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("tab", { name: /^Claude:/ }));
    await fireEvent.click(within(picker).getByRole("option", { name: "Claude Opus 5, default" }));
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        model: "claude-opus-5",
        provider: "claude",
        reasoningEffort: "medium",
      }),
    );
    expect(within(settings).getByRole("button", { name: "Agent model: Claude Opus 5" })).toBeEnabled();

    await fireEvent.click(within(settings).getByRole("button", { name: "Agent model: Claude Opus 5" }));
    picker = within(settings).getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("tab", { name: /^ChatGPT:/ }));
    await fireEvent.click(within(picker).getByRole("option", { name: "Sol" }));
    await fireEvent.pointerDown(thinking, { pointerType: "mouse", button: 0 });
    await fireEvent.click(screen.getByRole("option", { name: "Extra high" }));
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenLastCalledWith({
        botId: "chief",
        reasoningEffort: "xhigh",
      }),
    );
  });

  it("removes a custom agent avatar and keeps its generated avatar settings", async () => {
    vi.mocked(window.openbot.agent.listBots).mockResolvedValueOnce([
      { ...BOTS[0], avatarUrl: "openbot-avatar://agent/chief?v=image-1" },
    ]);
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    const settings = await screen.findByRole("complementary", { name: "Agent settings" });
    await fireEvent.click(within(settings).getByRole("button", { name: "Edit agent avatar" }));
    const editor = within(settings).getByRole("dialog", { name: "Avatar editor" });
    await fireEvent.click(within(editor).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(window.openbot.agent.setAvatar).toHaveBeenCalledWith({ botId: "chief", image: null }));
    expect(window.openbot.agent.updateBot).not.toHaveBeenCalledWith(
      expect.objectContaining({ avatarSeed: expect.any(String) }),
    );
  });

  it("keeps provider choices separate for each agent profile", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    let settings = await screen.findByRole("complementary", { name: "Agent settings" });
    await fireEvent.click(within(settings).getByRole("button", { name: "Agent model: Luna" }));
    let picker = within(settings).getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("tab", { name: /^Claude:/ }));
    await fireEvent.click(within(picker).getByRole("option", { name: "Claude Opus 5, default" }));

    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    settings = await screen.findByRole("complementary", { name: "Agent settings" });
    expect(within(settings).getByRole("button", { name: "Agent model: Luna" })).toBeEnabled();

    await fireEvent.click(within(settings).getByRole("button", { name: "Agent model: Luna" }));
    picker = within(settings).getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("tab", { name: /^Claude:/ }));
    await fireEvent.click(within(picker).getByRole("option", { name: "Claude Opus 5, default" }));
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "sales-outbound",
        model: "claude-opus-5",
        provider: "claude",
        reasoningEffort: "medium",
      }),
    );
  });

  it("does not remount agent text fields or discard in-progress edits on bot list refresh", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    const name = await screen.findByRole("textbox", { name: "Agent name" });
    name.focus();
    let draft = "";
    let refresh = 0;
    for (const character of "Draft coordinator name") {
      draft += character;
      await fireEvent.input(name, { target: { value: draft } });
      refresh += 1;
      emitAgentEvent?.({
        type: "bots-changed",
        bots: BOTS.map((bot) =>
          bot.id === "chief"
            ? { ...bot, preview: `Backend refresh ${refresh}`, notifications: refresh % 2 === 0 }
            : bot,
        ),
      });
      expect(name).toHaveValue(draft);
    }

    expect(screen.getByRole("textbox", { name: "Agent name" })).toBe(name);
    expect(name).toHaveValue("Draft coordinator name");

    const title = screen.getByRole("textbox", { name: "Agent title" });
    title.focus();
    draft = "";
    for (const character of "Research lead") {
      draft += character;
      await fireEvent.input(title, { target: { value: draft } });
      refresh += 1;
      emitAgentEvent?.({
        type: "bots-changed",
        bots: BOTS.map((bot) =>
          bot.id === "chief"
            ? { ...bot, preview: `Backend refresh ${refresh}`, notifications: refresh % 2 === 0 }
            : bot,
        ),
      });
      expect(title).toHaveValue(draft);
    }
    expect(screen.getByRole("textbox", { name: "Agent title" })).toBe(title);

    const description = screen.getByRole("textbox", { name: "Agent description" });
    description.focus();
    draft = "";
    for (const character of "Tracks every research request.") {
      draft += character;
      await fireEvent.input(description, { target: { value: draft } });
      refresh += 1;
      emitAgentEvent?.({
        type: "bots-changed",
        bots: BOTS.map((bot) =>
          bot.id === "chief"
            ? { ...bot, preview: `Backend refresh ${refresh}`, notifications: refresh % 2 === 0 }
            : bot,
        ),
      });
      expect(description).toHaveValue(draft);
    }
    expect(screen.getByRole("textbox", { name: "Agent description" })).toBe(description);
  });
});

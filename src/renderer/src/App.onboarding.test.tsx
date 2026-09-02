import type { AgentStatus, CentralAuthState } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { App } from "./App";
import { emitAgentEvent, emitAuth, emitInvite, installOpenbotStub, trackAnalytics } from "./app-test-harness";

describe("OpenBot connected desktop shell", () => {
  beforeEach(() => {
    installOpenbotStub();
  });

  it("shows the first-run onboarding before starting agents", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    render(() => <App />);

    expect(await screen.findByRole("heading", { name: "Meet OpenBot" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Where will OpenBot run?" })).not.toBeInTheDocument();
    expect(screen.queryByText("Verified. Opening OpenBot…")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Chief" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    const providers = screen.getByRole("radiogroup", { name: "Default provider" });
    const codex = within(providers).getByRole("radio", { name: /ChatGPT.*Connected/ });
    expect(codex).toBeChecked();
    await fireEvent.click(within(providers).getByRole("radio", { name: /Claude.*Connected/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open OpenBot" }));
    expect(window.openbot.saveSetup).toHaveBeenCalledWith({ preferredProvider: "claude" });
    expect(await screen.findByRole("heading", { name: "Chief" })).toBeInTheDocument();
  });

  it("connects bundled Claude and Grok providers", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "blocked",
      cliVersion: null,
      auth: { kind: "unknown" },
      providers: [
        { id: "codex", state: "sign-in-required", version: "0.149.1", message: "Connect ChatGPT." },
        { id: "claude", state: "sign-in-required", version: "2.1.246", message: "Sign in to Claude." },
        { id: "grok", state: "sign-in-required", version: "1.0.5", message: "Sign in to Grok." },
      ],
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: "Install a provider.",
      fullAccess: true,
    });
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Connect Claude" }));

    expect(window.openbot.connectClaude).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Restart Claude" })).toBeEnabled();
    await fireEvent.click(screen.getByRole("button", { name: "Connect Grok" }));
    expect(window.openbot.connectGrok).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Restart Grok" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("restarts provider connections independently and Refresh resets both", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    const disconnectedStatus: AgentStatus = {
      phase: "blocked",
      cliVersion: null,
      auth: { kind: "unknown" },
      providers: [
        { id: "codex", state: "sign-in-required", version: "0.149.1", message: null },
        { id: "claude", state: "sign-in-required", version: "2.1.246", message: null },
      ],
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: null,
      fullAccess: true,
    };
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce(disconnectedStatus);
    const bothConnecting: AgentStatus = {
      ...disconnectedStatus,
      providers: disconnectedStatus.providers?.map((provider) => ({
        ...provider,
        connectionState: "connecting" as const,
      })),
    };
    vi.mocked(window.openbot.connectChatGPT).mockResolvedValue(bothConnecting);
    vi.mocked(window.openbot.connectClaude).mockResolvedValue(bothConnecting);
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Connect ChatGPT" }));
    await fireEvent.click(screen.getByRole("button", { name: "Restart Claude" }));
    expect(screen.getByRole("button", { name: "Restart ChatGPT" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restart Claude" })).toBeEnabled();
    expect(window.openbot.connectChatGPT).toHaveBeenCalledTimes(1);
    expect(window.openbot.connectClaude).toHaveBeenCalledTimes(1);
    expect(trackAnalytics).toHaveBeenCalledWith("provider_action", {
      provider: "codex",
      action: "connect_started",
      result: "succeeded",
    });
    expect(trackAnalytics).toHaveBeenCalledWith("provider_action", {
      provider: "claude",
      action: "connect_started",
      result: "succeeded",
    });

    await fireEvent.click(screen.getByRole("button", { name: "Restart ChatGPT" }));
    expect(window.openbot.connectChatGPT).toHaveBeenCalledTimes(2);
    emitAgentEvent?.({
      type: "status",
      status: {
        ...disconnectedStatus,
        phase: "ready",
        providers: [
          {
            id: "codex",
            state: "sign-in-required",
            version: "0.149.1",
            message: "ChatGPT connection was not completed. Try again.",
          },
          {
            id: "claude",
            state: "available",
            version: "2.1.246",
            message: null,
            email: "claude@example.com",
          },
        ],
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("ChatGPT connection was not completed. Try again.");
    expect(trackAnalytics).toHaveBeenCalledWith("provider_action", {
      provider: "claude",
      action: "connect_completed",
      result: "succeeded",
    });
    await fireEvent.click(screen.getByRole("button", { name: "Refresh providers" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Reconnect ChatGPT" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Reconnect Claude" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refreshes provider detection and opens the matching sign-in guide", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "blocked",
      cliVersion: null,
      auth: { kind: "unknown" },
      providers: [
        { id: "codex", state: "sign-in-required", version: "0.149.1", message: "Connect ChatGPT." },
        { id: "claude", state: "sign-in-required", version: "2.1.246", message: "Sign in to Claude." },
      ],
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: "Install a provider.",
      fullAccess: true,
    });
    let finishRefresh: ((status: AgentStatus) => void) | undefined;
    vi.mocked(window.openbot.refreshAgentProviders).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
    );
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Refresh providers" }));
    expect(screen.getByRole("button", { name: "Checking providers" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Install / })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    expect(finishRefresh).toBeTypeOf("function");
    finishRefresh?.({
      phase: "ready",
      cliVersion: "2.1.231",
      auth: { kind: "claude", email: "claude@example.com" },
      providers: [
        { id: "codex", state: "sign-in-required", version: "0.144.1", message: "Sign in to ChatGPT." },
        {
          id: "claude",
          state: "available",
          version: "2.1.231",
          message: null,
          email: "claude@example.com",
        },
      ],
      capabilities: { chat: "ready", browser: "ready", computerUse: "unavailable" },
      message: null,
      fullAccess: true,
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Connect ChatGPT" })).toBeEnabled());
    expect(
      within(screen.getByRole("radiogroup", { name: "Default provider" })).getByRole("radio", { name: /Claude/ }),
    ).toBeChecked();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    const connectChatGPT = screen.getByRole("button", { name: "Connect ChatGPT" });
    await fireEvent.click(connectChatGPT);
    expect(window.openbot.connectChatGPT).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Restart ChatGPT" })).toBeEnabled();
  });

  it("refreshes providers after returning from a Connect browser flow", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "blocked",
      cliVersion: null,
      auth: { kind: "unknown" },
      providers: [
        { id: "codex", state: "sign-in-required", version: "0.149.1", message: "Connect ChatGPT." },
        { id: "claude", state: "sign-in-required", version: "2.1.246", message: "Connect Claude." },
      ],
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: null,
      fullAccess: true,
    });
    render(() => <App />);
    window.dispatchEvent(new Event("focus"));
    expect(window.openbot.refreshAgentProviders).not.toHaveBeenCalled();

    await fireEvent.click(await screen.findByRole("button", { name: "Connect ChatGPT" }));
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(window.openbot.refreshAgentProviders).toHaveBeenCalledTimes(1));
    expect(trackAnalytics).toHaveBeenCalledWith("provider_action", { action: "refresh", result: "succeeded" });
  });

  it("shows a provider-specific warning when Refresh cannot verify an existing connection", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({ completed: false, preferredProvider: null });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "ready",
      cliVersion: "0.149.1",
      auth: { kind: "chatgpt", email: "norbert@example.com" },
      providers: [
        {
          id: "codex",
          state: "available",
          version: "0.149.1",
          message: null,
          email: "norbert@example.com",
          checkError: "Could not verify ChatGPT. Keeping the existing connection.",
        },
      ],
      capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
      message: null,
      fullAccess: true,
    });

    render(() => <App />);

    expect(await screen.findByText("Could not verify ChatGPT. Keeping the existing connection.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reconnect ChatGPT" })).toBeEnabled();
  });

  it("shows a friendly inline error when a provider guide cannot open", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "blocked",
      cliVersion: null,
      auth: { kind: "unknown" },
      providers: [
        { id: "codex", state: "sign-in-required", version: "0.149.1", message: "Connect ChatGPT." },
        { id: "claude", state: "sign-in-required", version: "2.1.246", message: "Sign in to Claude." },
      ],
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: "Install a provider.",
      fullAccess: true,
    });
    vi.mocked(window.openbot.connectChatGPT).mockRejectedValueOnce(new Error("Raw IPC failure"));
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Connect ChatGPT" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("OpenBot could not connect ChatGPT. Try again.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Raw IPC failure");
    expect(trackAnalytics).toHaveBeenCalledWith("provider_action", {
      provider: "codex",
      action: "connect_started",
      result: "succeeded",
    });
    expect(trackAnalytics).toHaveBeenCalledWith("provider_action", {
      provider: "codex",
      action: "connect_completed",
      result: "failed",
      failure_code: "connect_failed",
    });
  });

  it("shows a native ChatGPT login failure reported after the browser opens", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "blocked",
      cliVersion: null,
      auth: { kind: "unknown" },
      providers: [
        { id: "codex", state: "sign-in-required", version: "0.149.1", message: "Connect ChatGPT." },
        { id: "claude", state: "sign-in-required", version: "2.1.246", message: "Sign in to Claude." },
      ],
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: "Connect ChatGPT.",
      fullAccess: true,
    });
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Connect ChatGPT" }));
    expect(screen.getByRole("button", { name: "Restart ChatGPT" })).toBeEnabled();

    emitAgentEvent?.({
      type: "status",
      status: {
        phase: "blocked",
        cliVersion: null,
        auth: { kind: "unknown" },
        providers: [
          {
            id: "codex",
            state: "sign-in-required",
            version: "0.149.1",
            message: "ChatGPT connection timed out. Try again.",
          },
          { id: "claude", state: "sign-in-required", version: "2.1.246", message: "Sign in to Claude." },
        ],
        capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
        message: "ChatGPT connection timed out. Try again.",
        fullAccess: true,
      },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("ChatGPT connection timed out. Try again.");
    expect(screen.getByRole("button", { name: "Connect ChatGPT" })).toBeEnabled();
  });

  it("connects to a remote host after account sign-in", async () => {
    const inviteUrl = "https://openbot.run/join?invite=test";
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.servers.takePendingInvite).mockResolvedValueOnce(inviteUrl);
    render(() => <App />);

    expect(await screen.findByRole("dialog", { name: "Connect to a host" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeInTheDocument();

    expect(screen.getAllByText(/person@example.com/).length).toBeGreaterThan(0);
    expect(await screen.findByText("Studio Mac")).toBeInTheDocument();
    await waitFor(() => expect(window.openbot.servers.previewInvite).toHaveBeenCalledWith({ inviteUrl }));
    expect(window.openbot.servers.join).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("button", { name: "Connect to host" }));

    await waitFor(() =>
      expect(window.openbot.servers.join).toHaveBeenCalledWith({
        inviteUrl,
      }),
    );
    await waitFor(() => expect(window.openbot.saveSetup).toHaveBeenCalledWith({ preferredProvider: "codex" }));
    expect(trackAnalytics).toHaveBeenCalledWith("team_action", {
      action: "server_joined",
      result: "succeeded",
      entry_point: "invite_deep_link",
    });
    expect(trackAnalytics).not.toHaveBeenCalledWith(
      "team_action",
      expect.objectContaining({ action: "server_selected" }),
    );
  });

  it("opens a verified invitation received while the configured app is running", async () => {
    const inviteUrl = "https://openbot.run/join?invite=second-instance";
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitInvite?.(inviteUrl);

    expect(await screen.findByRole("dialog", { name: "Studio Mac" })).toBeInTheDocument();
    await waitFor(() => expect(window.openbot.servers.previewInvite).toHaveBeenCalledWith({ inviteUrl }));
    expect(window.openbot.servers.join).not.toHaveBeenCalled();
  });

  it("lets a user request an email code from the initial screen", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.auth.getState).mockResolvedValueOnce({ status: "signed_out" });
    render(() => <App />);

    expect(await screen.findByRole("heading", { name: "Sign in to OpenBot" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Default provider" })).not.toBeInTheDocument();

    await fireEvent.input(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "person@example.com" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
    expect(window.openbot.auth.requestEmailCode).toHaveBeenCalledWith("person@example.com");
    await fireEvent.input(await screen.findByRole("textbox", { name: "One-time code" }), {
      target: { value: "ABCD-EFGH" },
    });
    expect(window.openbot.auth.verifyEmailCode).toHaveBeenCalledWith("challenge-1", "ABCD-EFGH");
    expect(trackAnalytics).toHaveBeenCalledWith("account_sign_in_started", { result: "code_sent" });
    expect(trackAnalytics).toHaveBeenCalledWith("account_sign_in_completed", { result: "succeeded" });
    expect(await screen.findByText("Verified. Opening OpenBot…")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Where will OpenBot run?" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Meet OpenBot" })).toBeInTheDocument();
  });

  it("shows a soft loader until the account API becomes available", async () => {
    vi.mocked(window.openbot.auth.getState).mockResolvedValueOnce({ status: "loading" });
    render(() => <App />);

    expect(await screen.findByRole("heading", { name: "Connecting to OpenBot" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Connecting securely…");
    expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeInTheDocument();

    emitAuth?.({ status: "signed_out" });
    expect(await screen.findByRole("heading", { name: "Sign in to OpenBot" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Email" })).toBeInTheDocument();
  });

  it("lets the user retry after the account API startup timeout", async () => {
    let finishRetry: ((state: CentralAuthState) => void) | undefined;
    vi.mocked(window.openbot.auth.getState).mockResolvedValueOnce({
      status: "error",
      issue: {
        code: "auth_api_unavailable",
        message: "OpenBot could not reach the account service.",
      },
    });
    vi.mocked(window.openbot.auth.retry).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRetry = resolve;
      }),
    );
    render(() => <App />);

    expect(await screen.findByRole("heading", { name: "Service unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(window.openbot.auth.retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "Connecting to OpenBot" })).toBeInTheDocument();
    finishRetry?.({ status: "signed_out" });
    expect(await screen.findByRole("heading", { name: "Sign in to OpenBot" })).toBeInTheDocument();
  });

  it("keeps a cold-start invitation until a signed-out user signs in", async () => {
    const inviteUrl = "https://openbot.run/join?invite=after-sign-in";
    vi.mocked(window.openbot.auth.getState).mockResolvedValueOnce({ status: "signed_out" });
    vi.mocked(window.openbot.servers.takePendingInvite).mockResolvedValueOnce(inviteUrl);
    render(() => <App />);

    expect(await screen.findByRole("heading", { name: "Sign in to OpenBot" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Chief" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Join a server" })).not.toBeInTheDocument();

    emitAuth?.({
      status: "signed_in",
      user: { id: "user-1", email: "person@example.com", name: null, avatarUrl: null },
    });

    expect(await screen.findByRole("dialog", { name: "Studio Mac" })).toBeInTheDocument();
    await waitFor(() => expect(window.openbot.servers.previewInvite).toHaveBeenCalledWith({ inviteUrl }));
  });

  it("lets the user choose a provider while provider checks are running", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "starting",
      cliVersion: null,
      auth: { kind: "unknown" },
      providers: [
        {
          id: "codex",
          state: "checking",
          version: null,
          message: null,
          email: null,
        },
        {
          id: "claude",
          state: "checking",
          version: null,
          message: null,
          email: null,
        },
      ],
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: null,
      fullAccess: true,
    });
    render(() => <App />);

    const providers = await screen.findByRole("radiogroup", { name: "Default provider" });
    const codex = within(providers).getByRole("radio", { name: /ChatGPT.*Checking/ });
    const claude = within(providers).getByRole("radio", { name: /Claude.*Checking/ });

    expect(codex).toBeEnabled();
    expect(claude).toBeEnabled();

    await fireEvent.click(claude);
    expect(claude).toBeChecked();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    emitAgentEvent?.({
      type: "status",
      status: {
        phase: "blocked",
        cliVersion: null,
        auth: { kind: "unknown" },
        providers: [
          {
            id: "codex",
            state: "not-installed",
            version: null,
            message: "Codex CLI is not installed.",
            email: null,
          },
          {
            id: "claude",
            state: "sign-in-required",
            version: "2.1.231",
            message: "Sign in to Claude.",
            email: null,
          },
        ],
        capabilities: {
          chat: "setup-required",
          browser: "ready",
          computerUse: "setup-required",
        },
        message: "Choose and configure a provider.",
        fullAccess: true,
      },
    });

    expect(claude).toBeChecked();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    emitAgentEvent?.({
      type: "status",
      status: {
        phase: "ready",
        cliVersion: "2.1.231",
        auth: { kind: "claude", email: "claude@example.com" },
        providers: [
          {
            id: "codex",
            state: "not-installed",
            version: null,
            message: "Codex CLI is not installed.",
            email: null,
          },
          {
            id: "claude",
            state: "available",
            version: "2.1.231",
            message: null,
            email: "claude@example.com",
          },
        ],
        capabilities: { chat: "ready", browser: "ready", computerUse: "setup-required" },
        message: null,
        fullAccess: true,
      },
    });

    expect(claude).toBeChecked();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("lets the user review providers and permissions from the account menu", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(await screen.findByRole("button", { name: "Open account actions" }));
    await fireEvent.click(screen.getByRole("button", { name: "Providers & permissions" }));

    expect(await screen.findByRole("dialog", { name: "Providers & permissions" })).toBeInTheDocument();
    const providers = screen.getByRole("radiogroup", { name: "Default provider" });
    expect(within(providers).getByRole("radio", { name: /Codex.*Connected/ })).toBeChecked();
    expect(within(providers).getByText("norbert@example.com")).toBeInTheDocument();
    expect(within(providers).getByText("claude@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await fireEvent.click(within(providers).getByRole("radio", { name: /Claude.*Connected/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(window.openbot.saveSetup).toHaveBeenLastCalledWith({ preferredProvider: "claude" });
    expect(screen.queryByRole("dialog", { name: "Providers & permissions" })).not.toBeInTheDocument();
  });

  it("opens the required first-Bot setup for a new user", async () => {
    vi.mocked(window.openbot.agent.listBots).mockResolvedValueOnce([]);
    render(() => <App />);

    expect(await screen.findByRole("heading", { name: "Create your first Bot" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Bot" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(window.openbot.agent.createBot).not.toHaveBeenCalled();
  });

  it("guides signed-out users before enabling chat", async () => {
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "blocked",
      cliVersion: "0.144.1",
      auth: { kind: "signed-out" },
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: "Run `codex login`, then restart OpenBot.",
      fullAccess: true,
    });
    render(() => <App />);

    expect(await screen.findByText("Agent CLI setup required")).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: /helping with most/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Chief")).toHaveAttribute("contenteditable", "false");
    fireEvent.click(screen.getByRole("button", { name: "Setup guide" }));
    await waitFor(() => expect(window.openbot.openExternal).toHaveBeenCalledWith("agent-setup"));
  });
});

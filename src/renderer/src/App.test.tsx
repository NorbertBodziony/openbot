import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../shared/ipc";
import { App } from "./App";

let emitAgentEvent: ((event: AgentEvent) => void) | undefined;

describe("Grok-style desktop shell", () => {
  beforeEach(() => {
    emitAgentEvent = undefined;
    Object.defineProperty(window, "infeld", {
      configurable: true,
      value: {
        getAppInfo: vi.fn().mockResolvedValue({
          name: "Infeld Bot",
          version: "0.1.0",
          platform: "darwin",
        }),
        agent: {
          getStatus: vi.fn().mockResolvedValue({
            phase: "ready",
            cliVersion: "0.144.1",
            auth: { kind: "chatgpt", planType: "pro" },
            capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
            message: null,
            fullAccess: true,
          }),
          listBots: vi.fn().mockRejectedValue(new Error("Keep fixture bots")),
          createBot: vi.fn().mockResolvedValue({
            id: "bot-new-1",
            name: "New agent",
            role: "New teammate",
            threadId: null,
            workspacePath: "/tmp/Infeld/Bots/bot-new-1",
            preview: "Ready for a local task.",
            updatedAt: null,
          }),
          readConversation: vi.fn().mockRejectedValue(new Error("Keep fixture messages")),
          sendMessage: vi.fn().mockResolvedValue({
            botId: "sales-outbound",
            threadId: "thread-1",
            turnId: "turn-1",
            mode: "start",
          }),
          interrupt: vi.fn().mockResolvedValue(undefined),
          respondToPrompt: vi.fn().mockResolvedValue(undefined),
          onEvent: vi.fn((listener) => {
            emitAgentEvent = listener;
            return () => undefined;
          }),
        },
        browser: {
          open: vi.fn().mockResolvedValue(undefined),
          activate: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          listTabs: vi.fn().mockResolvedValue([]),
          setVisible: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
  });

  it("renders the two-column navigation and conversation regions", () => {
    render(() => <App />);

    expect(screen.getByRole("complementary", { name: "Bot navigation" })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Bot details" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Sales Outbound" })).toBeInTheDocument();
  });

  it("filters chats and switches the active bot", async () => {
    render(() => <App />);

    const search = screen.getByRole("searchbox", { name: "Search chats" });
    await fireEvent.input(search, { target: { value: "Chief" } });

    expect(screen.getByRole("button", { name: /ChiefYesterday/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sales Outbound 15:05/ })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /ChiefYesterday/ }));
    expect(screen.getByRole("heading", { level: 1, name: "Chief" })).toBeInTheDocument();
  });

  it("sends a message from the composer", async () => {
    render(() => <App />);

    const composer = screen.getByRole("textbox", { name: "Message Sales Outbound" });
    await fireEvent.input(composer, { target: { value: "Run this every Monday." } });
    await fireEvent.keyDown(composer, { key: "Enter" });

    expect(screen.getByText("Run this every Monday.")).toBeInTheDocument();
    expect(composer).toHaveValue("");
    expect(window.infeld.agent.sendMessage).toHaveBeenCalledWith({
      botId: "sales-outbound",
      text: "Run this every Monday.",
    });
  });

  it("opens the computer screen modal and toggles voice state", async () => {
    render(() => <App />);

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    expect(screen.getByRole("dialog", { name: "Sales Outbound's screen" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Close screen" }));
    expect(
      screen.queryByRole("dialog", { name: "Sales Outbound's screen" }),
    ).not.toBeInTheDocument();

    const voice = screen.getByRole("button", { name: "Voice message" });
    await fireEvent.click(voice);
    expect(voice).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the recipient picker, then creates and selects a new agent", async () => {
    render(() => <App />);

    await fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    expect(screen.getByRole("combobox", { name: "To:" })).toHaveAttribute(
      "placeholder",
      "Search or create agents",
    );
    expect(screen.getByRole("option", { name: "Create new agent" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message agent" })).toBeDisabled();

    await fireEvent.click(screen.getByRole("option", { name: "Create new agent" }));

    expect(await screen.findByRole("heading", { level: 1, name: "New agent" })).toBeInTheDocument();
    expect(window.infeld.agent.createBot).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "Message New agent" })).toBeEnabled();
  });

  it("filters and selects an existing recipient from the new-agent flow", async () => {
    render(() => <App />);
    await fireEvent.click(screen.getByRole("button", { name: "New agent" }));

    const recipient = screen.getByRole("combobox", { name: "To:" });
    await fireEvent.input(recipient, { target: { value: "talent" } });
    expect(screen.getByRole("option", { name: "Talent Scout" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Chief" })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("option", { name: "Talent Scout" }));
    expect(screen.getByRole("heading", { level: 1, name: "Talent Scout" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "To:" })).not.toBeInTheDocument();
  });

  it("supports keyboard navigation and Escape in the recipient picker", async () => {
    render(() => <App />);
    await fireEvent.click(screen.getByRole("button", { name: "New agent" }));

    const recipient = screen.getByRole("combobox", { name: "To:" });
    await fireEvent.input(recipient, { target: { value: "chief" } });
    await fireEvent.keyDown(recipient, { key: "ArrowDown" });
    await fireEvent.keyDown(recipient, { key: "Enter" });
    expect(screen.getByRole("heading", { level: 1, name: "Chief" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    await fireEvent.keyDown(screen.getByRole("combobox", { name: "To:" }), { key: "Escape" });
    expect(screen.queryByRole("combobox", { name: "To:" })).not.toBeInTheDocument();
  });

  it("loads application metadata through the typed desktop bridge", async () => {
    render(() => <App />);

    expect(await screen.findByTestId("app-version")).toHaveTextContent("Version 0.1.0 · darwin");
    expect(window.infeld.getAppInfo).toHaveBeenCalledOnce();
    expect(await screen.findByTestId("agent-status")).toHaveTextContent(
      "Full access · Codex ready",
    );
  });

  it("routes a model question and the next reply through the prompt bridge", async () => {
    render(() => <App />);
    if (!emitAgentEvent) throw new Error("Agent listener was not registered.");

    emitAgentEvent({
      type: "prompt",
      requestId: "prompt-1",
      botId: "sales-outbound",
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Which account should I prioritize?",
          isSecret: false,
          options: null,
        },
      ],
    });
    expect(screen.getByText("1. Which account should I prioritize?")).toBeInTheDocument();

    const composer = screen.getByRole("textbox", { name: "Message Sales Outbound" });
    await fireEvent.input(composer, { target: { value: "Acme" } });
    await fireEvent.keyDown(composer, { key: "Enter" });

    expect(window.infeld.agent.respondToPrompt).toHaveBeenCalledWith({
      requestId: "prompt-1",
      answers: { choice: ["Acme"] },
    });
    expect(window.infeld.agent.sendMessage).not.toHaveBeenCalled();
  });
});

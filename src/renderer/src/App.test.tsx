import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AttachmentImportEvent, BotSummary } from "../../shared/ipc";
import { App } from "./App";

let emitAgentEvent: ((event: AgentEvent) => void) | undefined;
let emitAttachmentImport: ((event: AttachmentImportEvent) => void) | undefined;

const BOTS: BotSummary[] = [
  {
    id: "chief",
    name: "Chief",
    role: "Chief of staff",
    description: "Coordinates work",
    notifications: true,
    threadId: null,
    workspacePath: "/tmp/Infeld/Bots/chief",
    preview: "No messages yet",
    updatedAt: null,
  },
  {
    id: "sales-outbound",
    name: "Sales Outbound",
    role: "Outbound specialist",
    description: "",
    notifications: true,
    threadId: null,
    workspacePath: "/tmp/Infeld/Bots/sales-outbound",
    preview: "No messages yet",
    updatedAt: null,
  },
];

describe("Infeld connected desktop shell", () => {
  beforeEach(() => {
    emitAgentEvent = undefined;
    emitAttachmentImport = undefined;
    Object.defineProperty(window, "infeld", {
      configurable: true,
      value: {
        getAppInfo: vi
          .fn()
          .mockResolvedValue({ name: "Infeld Bot", version: "0.1.0", platform: "darwin" }),
        agent: {
          getStatus: vi.fn().mockResolvedValue({
            phase: "ready",
            cliVersion: "0.144.1",
            auth: { kind: "chatgpt", planType: "pro" },
            capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
            message: null,
            fullAccess: true,
          }),
          listBots: vi.fn().mockResolvedValue(BOTS),
          createBot: vi.fn().mockResolvedValue({ ...BOTS[0], id: "bot-new", name: "New agent" }),
          updateBot: vi.fn().mockImplementation(async (input) => ({
            ...BOTS.find((bot) => bot.id === input.botId),
            ...input,
          })),
          deleteBot: vi.fn().mockResolvedValue(undefined),
          readConversation: vi.fn().mockImplementation(async (botId) => ({
            botId,
            threadId: null,
            activeTurnId: null,
            messages: [],
          })),
          chooseAttachments: vi.fn().mockResolvedValue([]),
          onAttachmentImport: vi.fn((listener) => {
            emitAttachmentImport = listener;
            return () => undefined;
          }),
          discardDraftAttachment: vi.fn().mockResolvedValue(undefined),
          openAttachment: vi.fn().mockResolvedValue(undefined),
          sendMessage: vi.fn().mockResolvedValue({
            messageId: "message-1",
            deliveries: [
              { id: "delivery-1", recipientBotId: "chief", status: "queued", position: 1 },
            ],
          }),
          listQueue: vi
            .fn()
            .mockImplementation(async (botId) => ({ botId, paused: false, deliveries: [] })),
          cancelQueuedMessage: vi.fn().mockResolvedValue(undefined),
          setQueuePaused: vi.fn().mockResolvedValue(undefined),
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

  it("uses the backend bot list and shows local onboarding for a real empty snapshot", async () => {
    render(() => <App />);
    expect(await screen.findByRole("heading", { name: "Chief" })).toBeInTheDocument();
    expect(
      await screen.findByRole("listbox", { name: "What do you want me helping with most?" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Salesforce account queue/i)).not.toBeInTheDocument();
  });

  it("filters and switches backend bots", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await screen.findByRole("listbox", { name: "What do you want me helping with most?" });
    const search = screen.getByRole("searchbox", { name: "Search chats" });
    await fireEvent.input(search, { target: { value: "Sales" } });
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    expect(screen.getByRole("heading", { name: "Sales Outbound" })).toBeInTheDocument();
  });

  it("queues from the composer and clears only after success", async () => {
    render(() => <App />);
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    await fireEvent.input(composer, { target: { value: "Run this Monday" } });
    await fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() =>
      expect(window.infeld.agent.sendMessage).toHaveBeenCalledWith({
        botId: "chief",
        text: "Run this Monday",
        attachmentDraftIds: [],
      }),
    );
    await waitFor(() => expect(composer).toHaveValue(""));
  });

  it("keeps text and attachments when enqueue fails", async () => {
    vi.mocked(window.infeld.agent.sendMessage).mockRejectedValueOnce(
      new Error("Mailbox unavailable"),
    );
    render(() => <App />);
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    await fireEvent.input(composer, { target: { value: "Retry me" } });
    await fireEvent.keyDown(composer, { key: "Enter" });
    expect(await screen.findByText("Mailbox unavailable")).toBeInTheDocument();
    expect(composer).toHaveValue("Retry me");
  });

  it("supports picker and attachment-only messages", async () => {
    vi.mocked(window.infeld.agent.chooseAttachments).mockResolvedValueOnce([
      attachment("draft-1", "brief.pdf", "pdf"),
    ]);
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "Attach a file" }));
    await fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(window.infeld.agent.sendMessage).toHaveBeenCalledWith({
        botId: "chief",
        text: "",
        attachmentDraftIds: ["draft-1"],
      }),
    );
  });

  it("adds pathless pasted images reported by preload", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAttachmentImport?.({ type: "started" });
    emitAttachmentImport?.({
      type: "completed",
      attachments: [attachment("pasted-1", "pasted.png", "image")],
    });
    expect(await screen.findByText("pasted.png")).toBeInTheDocument();
  });

  it("shows and controls queued work", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: {
        botId: "chief",
        paused: true,
        deliveries: [
          {
            id: "delivery-1",
            messageId: "message-1",
            recipientBotId: "chief",
            sender: { kind: "user" },
            text: "Later",
            attachments: [],
            replyToMessageId: null,
            status: "queued",
            position: 1,
            turnId: null,
            error: null,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Resume queue" }));
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: {
        botId: "chief",
        paused: true,
        deliveries: [
          {
            id: "delivery-1",
            messageId: "message-1",
            recipientBotId: "chief",
            sender: { kind: "user" },
            text: "Later",
            attachments: [],
            replyToMessageId: null,
            status: "queued",
            position: 1,
            turnId: null,
            error: null,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Cancel queued message 1" }));
    expect(window.infeld.agent.cancelQueuedMessage).toHaveBeenCalled();
    expect(window.infeld.agent.setQueuePaused).toHaveBeenCalledWith({
      botId: "chief",
      paused: false,
    });
  });

  it("submits onboarding as the first queued user message", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await screen.findByRole("listbox", { name: "What do you want me helping with most?" });
    await fireEvent.click(screen.getByRole("option", { name: /Work & projects/ }));
    await waitFor(() =>
      expect(window.infeld.agent.sendMessage).toHaveBeenCalledWith({
        botId: "chief",
        text: "Work & projects",
        attachmentDraftIds: [],
      }),
    );
  });

  it("answers model prompts from a separate card while composer remains a queue", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await screen.findByRole("listbox", { name: "What do you want me helping with most?" });
    emitAgentEvent?.({
      type: "prompt",
      requestId: "prompt-1",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [
        {
          id: "account",
          header: "Account",
          question: "Which account?",
          isSecret: false,
          options: null,
        },
      ],
    });
    const answer = await screen.findByRole("textbox", { name: "Account" });
    await fireEvent.input(answer, { target: { value: "Acme" } });
    await fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() =>
      expect(window.infeld.agent.respondToPrompt).toHaveBeenCalledWith({
        requestId: "prompt-1",
        answers: { account: ["Acme"] },
      }),
    );
  });

  it("renders persistent outgoing and incoming agent exchanges", async () => {
    vi.mocked(window.infeld.agent.readConversation).mockImplementation(async (botId) => ({
      botId,
      threadId: "thread-1",
      activeTurnId: null,
      messages:
        botId === "chief"
          ? [
              {
                id: "outbox-message-1",
                author: "system",
                source: "system",
                text: "Prepare report",
                createdAt: new Date().toISOString(),
                status: "completed",
                exchange: {
                  direction: "outgoing",
                  messageId: "message-1",
                  senderBotId: "chief",
                  recipientBotIds: ["sales-outbound"],
                  replyToMessageId: null,
                  deliveries: [
                    {
                      id: "delivery-1",
                      recipientBotId: "sales-outbound",
                      status: "queued",
                      position: 1,
                      error: null,
                    },
                  ],
                },
              },
            ]
          : [],
    }));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    expect(await screen.findByText("Messaged")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 agent, show list" })).toBeInTheDocument();
  });

  it("persists settings and opens managed attachment actions", async () => {
    render(() => <App />);
    await fireEvent.click(await screen.findByRole("button", { name: "View agent settings" }));
    await screen.findByRole("listbox", { name: "What do you want me helping with most?" });
    const name = screen.getByRole("textbox", { name: "Agent name" });
    await fireEvent.input(name, { target: { value: "Coordinator" } });
    await fireEvent.blur(name);
    await waitFor(() =>
      expect(window.infeld.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        name: "Coordinator",
      }),
    );
    await fireEvent.click(screen.getByRole("button", { name: "Close details" }));

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: null,
        activeTurnId: null,
        messages: [
          {
            id: "file-message",
            author: "user",
            text: "",
            createdAt: new Date().toISOString(),
            status: "completed",
            attachments: [attachment("file-1", "brief.pdf", "pdf")],
          },
        ],
      },
    });
    await fireEvent.click(await screen.findByRole("button", { name: "Preview brief.pdf" }));
    expect(screen.getByRole("dialog", { name: "brief.pdf" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(window.infeld.agent.openAttachment).toHaveBeenCalledWith({
      attachmentId: "file-1",
      action: "reveal",
    });
  });

  it("opens bot actions on right click and edits the selected agent", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.contextMenu(screen.getByRole("button", { name: /Sales Outbound/ }), {
      clientX: 120,
      clientY: 90,
    });
    await fireEvent.click(screen.getByRole("menuitem", { name: "Edit agent" }));
    expect(await screen.findByRole("heading", { name: "Sales Outbound" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Agent settings" })).toBeInTheDocument();
  });

  it("confirms and persistently deletes a bot from its context menu", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const sales = screen.getByRole("button", { name: /Sales Outbound/ });
    await fireEvent.contextMenu(sales, { clientX: 120, clientY: 90 });
    await fireEvent.click(screen.getByRole("menuitem", { name: "Delete agent" }));
    expect(screen.getByRole("alertdialog", { name: "Delete Sales Outbound?" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(window.infeld.agent.deleteBot).toHaveBeenCalledWith("sales-outbound"));
    await waitFor(() => expect(sales).not.toBeInTheDocument());
  });
});

function attachment(id: string, name: string, kind: "image" | "pdf") {
  return {
    id,
    name,
    size: 2048,
    kind: kind === "image" ? ("image" as const) : ("file" as const),
    mimeType: kind === "image" ? "image/png" : "application/pdf",
    previewKind: kind,
    previewUrl: `infeld-attachment://file/${id}`,
  };
}

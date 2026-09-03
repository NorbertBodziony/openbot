import { serializeAttachmentReference } from "@openbot/contracts/attachment-references";
import { serializeChatTagReference } from "@openbot/contracts/chat-tag-references";
import type { DirectConversationSnapshot } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { App } from "./App";
import {
  attachment,
  confirmOnboardingModel,
  emitAgentEvent,
  emitAttachmentImport,
  emitDirectMessage,
  emitDirectTyping,
  emitPresence,
  installOpenbotStub,
  presenceMember,
  queuedDelivery,
  testServer,
  trackAnalytics,
} from "./app-test-harness";

describe("OpenBot connected desktop shell", () => {
  beforeEach(() => {
    installOpenbotStub();
  });

  it("keeps a failed send in the composer and clears it only after a successful retry", async () => {
    vi.mocked(window.openbot.agent.sendMessage).mockRejectedValueOnce(new Error("Mailbox unavailable"));
    render(() => <App />);
    await confirmOnboardingModel();
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Run this Monday";
    await fireEvent.input(composer);
    await waitFor(() =>
      expect(window.openbot.servers.setTyping).toHaveBeenCalledWith({
        botId: "chief",
        typing: true,
      }),
    );
    await fireEvent.keyDown(composer, { key: "Enter" });
    expect(await screen.findByText("Mailbox unavailable")).toBeInTheDocument();
    expect(composer).toHaveTextContent("Run this Monday");

    await fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith(
        { botId: "chief", text: "Run this Monday", attachmentDraftIds: [] },
        "local",
      ),
    );
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "delivery-1",
        },
        "local",
      ),
    );
    await waitFor(() => expect(composer).toHaveTextContent(""));
    expect(trackAnalytics).toHaveBeenCalledWith("message_send", {
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoning_effort: "medium",
      server_kind: "local",
      channel: "agent",
      attachment_count: 0,
      is_reply: false,
      result: "succeeded",
      delivery_count: 1,
    });
  });

  it("does not read an earlier agent reply again after sending a message", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "assistant-before-send",
            author: "assistant",
            text: "Earlier agent reply",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
        ],
      },
    });
    await screen.findByText("Earlier agent reply");
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.mocked(window.openbot.agent.markConversationRead).mockClear();

    const composer = screen.getByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Continue this work";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        { botId: "chief", throughMessageId: "delivery-1" },
        "local",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vi.mocked(window.openbot.agent.markConversationRead).mock.calls).toEqual([
      [{ botId: "chief", throughMessageId: "delivery-1" }, "local"],
    ]);
  });

  it("opens a private person thread and receives direct messages in real time", async () => {
    vi.mocked(window.openbot.servers.markDirectRead).mockRejectedValueOnce(new Error("Read state unavailable"));
    render(() => <App peopleEnabled />);
    await screen.findByRole("heading", { name: "Chief" });
    emitPresence?.({
      serverId: "server-1",
      updatedAt: "2026-08-19T10:00:00.000Z",
      members: [
        {
          id: "member-self",
          username: "person@example.com",
          email: "person@example.com",
          name: "Person",
          role: "owner",
          createdAt: "2026-08-18T10:00:00.000Z",
          disabled: false,
          online: true,
          typingBotId: null,
        },
        {
          id: "member-alice",
          username: "alice@example.com",
          email: "alice@example.com",
          name: "Alice",
          role: "member",
          createdAt: "2026-08-18T11:00:00.000Z",
          disabled: false,
          online: true,
          typingBotId: null,
        },
      ],
    });

    await fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));
    expect(await screen.findByRole("main", { name: "Direct conversation with Alice" })).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Message Alice" });
    await fireEvent.input(input, { target: { value: "Hello Alice" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(window.openbot.servers.sendDirectMessage).toHaveBeenCalledWith(
        expect.objectContaining({ memberId: "member-alice", text: "Hello Alice" }),
      ),
    );
    await waitFor(() =>
      expect(window.openbot.servers.markDirectRead).toHaveBeenCalledWith({
        memberId: "member-alice",
        throughSequence: 1,
      }),
    );
    expect(await screen.findByText("Hello Alice")).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveValue(""));
    expect(await screen.findByText("Read state unavailable")).toBeInTheDocument();
    expect(trackAnalytics).toHaveBeenCalledWith("message_send", {
      channel: "direct",
      attachment_count: 0,
      is_reply: false,
      result: "succeeded",
      delivery_count: 1,
      server_kind: "local",
    });

    emitDirectTyping?.({
      type: "team-direct-typing",
      senderMemberId: "member-alice",
      recipientMemberId: "member-self",
      typing: true,
    });
    expect(await screen.findByText("Alice is typing")).toBeInTheDocument();

    emitDirectMessage?.({
      type: "team-direct-message",
      memberIds: ["member-alice", "member-self"],
      message: {
        id: "message-alice-1",
        threadId: "thread-member-alice",
        senderMemberId: "member-alice",
        recipientMemberId: "member-self",
        text: "Hi. I am here.",
        createdAt: "2026-08-19T10:01:00.000Z",
        sequence: 2,
      },
    });
    const incomingMessage = await screen.findByText("Hi. I am here.");
    expect(incomingMessage).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "New messages" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(window.openbot.servers.markDirectRead).toHaveBeenCalledWith({
        memberId: "member-alice",
        throughSequence: 2,
      }),
    );
  });

  it("does not expose team conversations when the signed-in account is not a member", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitPresence?.({
      serverId: "server-smoke",
      updatedAt: "2026-08-19T10:00:00.000Z",
      members: [presenceMember("member-smoke", "codex-smoke@example.invalid", "Codex Smoke")],
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /codex-smoke@example\.invalid/i })).not.toBeInTheDocument();
    });
    expect(window.openbot.servers.readDirectConversation).not.toHaveBeenCalled();
    expect(window.openbot.servers.listDirectThreads).not.toHaveBeenCalled();
  });

  it("does not apply a stale direct-message load after another person is selected", async () => {
    let resolveAlice: ((snapshot: DirectConversationSnapshot) => void) | undefined;
    vi.mocked(window.openbot.servers.readDirectConversation).mockImplementation((memberId) => {
      if (memberId === "member-alice") {
        return new Promise((resolve) => {
          resolveAlice = resolve;
        });
      }
      return Promise.resolve({
        threadId: "thread-member-bob",
        otherMemberId: "member-bob",
        messages: [
          {
            id: "message-bob",
            threadId: "thread-member-bob",
            senderMemberId: "member-bob",
            recipientMemberId: "member-self",
            text: "Bob history",
            createdAt: "2026-08-19T09:00:00.000Z",
            sequence: 1,
          },
        ],
        revision: 1,
      });
    });
    render(() => <App peopleEnabled />);
    await screen.findByRole("heading", { name: "Chief" });
    emitPresence?.({
      serverId: "server-1",
      updatedAt: "2026-08-19T10:00:00.000Z",
      members: [
        presenceMember("member-self", "person@example.com", "Person"),
        presenceMember("member-alice", "alice@example.com", "Alice"),
        presenceMember("member-bob", "bob@example.com", "Bob"),
      ],
    });

    await fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));
    await fireEvent.click(screen.getByRole("button", { name: /Bob/ }));
    expect(await screen.findByText("Bob history")).toBeInTheDocument();
    resolveAlice?.({
      threadId: "thread-member-alice",
      otherMemberId: "member-alice",
      messages: [],
      revision: 0,
    });

    await waitFor(() => expect(screen.getByRole("main", { name: "Direct conversation with Bob" })).toBeInTheDocument());
    expect(screen.getByText("Bob history")).toBeInTheDocument();
  });

  it("replies to a message through the composer and keeps the reference in the queued input", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "assistant-1",
            author: "assistant",
            text: `Should ${serializeChatTagReference("agent", "Old Sales", "sales-outbound")} prepare the report?`,
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
        ],
      },
    });

    await screen.findByRole("button", { name: "Open agent Sales Outbound" });
    await fireEvent.click(screen.getByRole("button", { name: "Reply to Agent message" }));
    expect(screen.getByText("Replying to Agent")).toBeInTheDocument();

    const composer = screen.getByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Yes, today please";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith(
        {
          botId: "chief",
          text: "Yes, today please",
          attachmentDraftIds: [],
          replyToMessageId: "assistant-1",
        },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByText("Replying to Agent")).not.toBeInTheDocument());
  });

  it("sends an action for selected agent text without clearing the composer draft", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const answer = "The launch note needs a friendlier closing sentence.";
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "assistant-selection",
            author: "assistant",
            text: answer,
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
        ],
      },
    });

    const message = await screen.findByText(answer);
    const composer = screen.getByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Keep this draft";
    await fireEvent.input(composer);

    const text = message.firstChild;
    if (!text) throw new Error("Agent message did not render a text node");
    const quote = "friendlier closing sentence";
    const start = answer.indexOf(quote);
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + quote.length);
    Object.defineProperty(range, "getClientRects", {
      configurable: true,
      value: () => [{ top: 100, right: 320, bottom: 120, left: 120, width: 200, height: 20 }],
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    await fireEvent.pointerUp(message);

    await fireEvent.click(await screen.findByRole("button", { name: "Improve" }));
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith(
        {
          botId: "chief",
          text: "Improve this selected text.\n\n> friendlier closing sentence",
          attachmentDraftIds: [],
          replyToMessageId: "assistant-selection",
        },
        "local",
      ),
    );
    expect(composer).toHaveTextContent("Keep this draft");
  });

  it("reacts and copies resolved tags from message hover actions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(window.openbot.agent.listInstalledSkills).mockResolvedValueOnce([
      {
        skillId: "skill-1",
        slug: "release-notes",
        name: "Release Notes",
        installedVersion: 1,
        availableVersion: 1,
        state: "installed",
      },
    ]);
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "assistant-actions",
            author: "user",
            text: `Ask ${serializeChatTagReference("agent", "Old Sales", "sales-outbound")} to use ${serializeChatTagReference("skill", "Old Skill", "skill-1")} and review ${serializeAttachmentReference("tagged file", "attachment-1")}.`,
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
            attachments: [attachment("attachment-1", "@[Ops](agent:ops)", "pdf")],
          },
        ],
      },
    });

    await screen.findByRole("button", { name: "Open agent Sales Outbound" });
    await fireEvent.pointerDown(screen.getByRole("button", { name: "Add reaction" }), { button: 0 });
    await fireEvent.pointerUp(screen.getByRole("menuitemradio", { name: "React with ❤️" }), { button: 0 });
    expect(window.openbot.agent.setMessageReaction).toHaveBeenCalledWith({
      botId: "chief",
      messageId: "assistant-actions",
      emoji: "❤️",
    });
    expect(trackAnalytics).toHaveBeenCalledWith("reaction_action", { action: "add", result: "succeeded" });

    await fireEvent.pointerDown(screen.getByRole("button", { name: "More message actions" }), { button: 0 });
    await fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Copy" }), { button: 0 });
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "Ask @Sales Outbound to use Release Notes (skill) and review @[Ops](agent:ops).",
      ),
    );
  });

  it("lets the user remove only their own reaction while keeping the agent reaction read-only", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "user-reactions",
            author: "user",
            text: "The launch is approved.",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
            reaction: "❤️",
            reactions: [
              { emoji: "❤️", actor: { kind: "user" } },
              { emoji: "🎉", actor: { kind: "bot", botId: "chief" } },
            ],
          },
        ],
      },
    });

    await screen.findByRole("img", { name: "Chief reacted with 🎉" });
    await fireEvent.click(screen.getByRole("button", { name: "Remove your reaction ❤️" }));
    expect(window.openbot.agent.setMessageReaction).toHaveBeenCalledWith({
      botId: "chief",
      messageId: "user-reactions",
      emoji: null,
    });
    expect(trackAnalytics).toHaveBeenCalledWith("reaction_action", { action: "remove", result: "succeeded" });
    expect(screen.getByRole("img", { name: "Chief reacted with 🎉" })).toBeInTheDocument();
  });

  it("groups commentary into a settled thinking disclosure", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "user-open",
            turnId: "turn-open",
            author: "user",
            text: "Open x.com",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
          {
            id: "commentary-open",
            turnId: "turn-open",
            author: "assistant",
            text: "I’ll open x.com in the OpenBot browser.",
            createdAt: "2026-08-12T10:00:01.000Z",
            status: "completed",
            itemType: "commentary",
          },
          {
            id: "commentary-check",
            turnId: "turn-open",
            author: "assistant",
            text: "Checking that the page loaded.",
            createdAt: "2026-08-12T10:00:02.000Z",
            status: "completed",
            itemType: "commentary",
          },
          {
            id: "answer-open",
            turnId: "turn-open",
            author: "assistant",
            text: "Opened x.com.",
            createdAt: "2026-08-12T10:00:03.000Z",
            status: "completed",
            itemType: "final_answer",
          },
        ],
      },
    });

    const disclosure = await screen.findByRole("button", { name: "Show thinking details" });
    expect(screen.getByText("Thought for 2 seconds")).toBeInTheDocument();
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Opened x.com.")).toBeVisible();
    expect(screen.getByText("I’ll open x.com in the OpenBot browser.")).toBeInTheDocument();
    expect(screen.getByText("Checking that the page loaded.")).toBeInTheDocument();

    await fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("I’ll open x.com in the OpenBot browser.")).toBeVisible();

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 2,
        messages: [
          {
            id: "user-open",
            turnId: "turn-open",
            author: "user",
            text: "Open x.com",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
          {
            id: "answer-open",
            turnId: "turn-open",
            author: "assistant",
            text: "Opened x.com.",
            createdAt: "2026-08-12T10:00:03.000Z",
            status: "completed",
            itemType: "final_answer",
          },
        ],
      },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Show thinking details" })).toBe(disclosure));
    expect(screen.getByText("I’ll open x.com in the OpenBot browser.")).toBeVisible();
  });

  it("supports picker and attachment-only messages", async () => {
    const filePickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    await fireEvent.pointerDown(screen.getByRole("button", { name: "Add to prompt" }), { button: 0 });
    await fireEvent.pointerDown(screen.getByRole("menuitem", { name: /Attach image/ }), { button: 0 });
    expect(filePickerClick).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLInputElement>('input[type="file"][accept]')?.accept).toBe(
      ".png,.jpg,.jpeg,.gif,.webp,.avif",
    );
    await fireEvent.pointerDown(screen.getByRole("button", { name: "Add to prompt" }), { button: 0 });
    await fireEvent.pointerDown(screen.getByRole("menuitem", { name: /Add context/ }), { button: 0 });
    expect(filePickerClick).toHaveBeenCalledTimes(2);
    emitAttachmentImport?.({ type: "started", requestId: "picker-1", serverId: "local" });
    emitAttachmentImport?.({
      type: "completed",
      requestId: "picker-1",
      serverId: "local",
      attachments: [attachment("draft-1", "brief.pdf", "pdf")],
    });
    expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith(
        { botId: "chief", text: "", attachmentDraftIds: ["draft-1"] },
        "local",
      ),
    );
  });

  it("keeps an asynchronous attachment error with the bot that received the paste", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAttachmentImport?.({ type: "started", requestId: "paste-error", serverId: "local" });
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    emitAttachmentImport?.({
      type: "error",
      requestId: "paste-error",
      serverId: "local",
      message: "Attachment import failed",
    });

    expect(screen.queryByText("Attachment import failed")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Attachment import failed");
  });

  it("keeps an asynchronous pasted attachment on the server that received the paste", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitAttachmentImport?.({ type: "started", requestId: "paste-server-switch", serverId: "local" });
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );
    emitAttachmentImport?.({
      type: "completed",
      requestId: "paste-server-switch",
      serverId: "local",
      attachments: [attachment("pasted-local", "for-local.png", "image")],
    });

    expect(screen.queryByRole("button", { name: "Remove for-local.png" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    const removeAttachment = await screen.findByRole("button", { name: "Remove for-local.png" });
    await fireEvent.click(removeAttachment);
    expect(window.openbot.agent.discardDraftAttachment).toHaveBeenCalledWith("pasted-local", "local");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove for-local.png" })).not.toBeInTheDocument());
  });

  it("keeps foreground starts out of Queue and hides waiting work between turns", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const firstStarting = queuedDelivery("delivery-starting", "Current work", null, { status: "starting" });
    const second = queuedDelivery("delivery-next", "Next work", 1);
    const third = queuedDelivery("delivery-later", "Later work", 2);

    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: { botId: "chief", deliveries: [firstStarting] },
    });
    expect(screen.queryByRole("region", { name: "Message queue" })).not.toBeInTheDocument();

    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: { botId: "chief", deliveries: [firstStarting, second] },
    });
    await screen.findByRole("group", { name: "Queued message 1: Next work" });
    expect(screen.queryByRole("group", { name: /Current work/ })).not.toBeInTheDocument();

    emitAgentEvent?.({ type: "turn-started", botId: "chief", threadId: "thread-chief", turnId: "turn-live" });
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: {
        botId: "chief",
        deliveries: [
          { ...firstStarting, status: "running", turnId: "turn-live" },
          { ...second, status: "starting", position: null, turnId: "turn-live" },
          third,
        ],
      },
    });
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Message queue" }))
          .getAllByLabelText(/^Queued message/u)
          .map((item) => item.getAttribute("aria-label")),
      ).toEqual(["Queued message 2: Later work", "Queued message : Next work"]),
    );

    emitAgentEvent?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live",
      status: "completed",
    });
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: {
        botId: "chief",
        deliveries: [
          { ...second, position: 1, turnId: null },
          { ...third, position: 2 },
        ],
      },
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Message queue" })).not.toBeInTheDocument());

    const secondStarting = { ...second, status: "starting" as const, position: null, turnId: "turn-next" };
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: { botId: "chief", deliveries: [secondStarting, third] },
    });
    await screen.findByRole("group", { name: "Queued message 2: Later work" });
    expect(screen.queryByRole("group", { name: /Next work/ })).not.toBeInTheDocument();
  });

  it("keeps the complete Bot draft when creation fails", async () => {
    vi.mocked(window.openbot.agent.createBot).mockRejectedValueOnce(
      new Error("The first message could not be queued."),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "Create new Bot" }));
    await fireEvent.click(await screen.findByRole("button", { name: /^Writing Partner\./ }));
    const name = screen.getByRole("textbox", { name: "Name" });
    const purpose = screen.getByRole("textbox", { name: "What should this Bot help with?" });
    await fireEvent.input(name, { target: { value: "My Writing Partner" } });
    await fireEvent.click(screen.getByRole("button", { name: "Create Bot" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The first message could not be queued.");
    expect(name).toHaveValue("My Writing Partner");
    expect(purpose).toHaveValue(
      "Help me draft and improve messages and documents while keeping the writing clear and natural.",
    );
    expect(screen.getByRole("heading", { name: "Create a new Bot" })).toBeInTheDocument();
  });

  it("answers model prompts from a separate card while composer remains a queue", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
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
    const answer = await screen.findByRole("textbox", {
      name: "Custom answer for: Which account?",
    });
    await fireEvent.input(answer, { target: { value: "Acme" } });
    await fireEvent.keyDown(answer, { key: "Enter" });
    await waitFor(() =>
      expect(window.openbot.agent.respondToPrompt).toHaveBeenCalledWith({
        requestId: "prompt-1",
        answers: { account: ["Acme"] },
      }),
    );
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-1",
        activeTurnId: "turn-1",
        revision: 20,
        messages: [
          {
            id: "question-prompt:turn-1:prompt-1",
            turnId: "turn-1",
            author: "assistant",
            source: "assistant",
            text: "",
            createdAt: "2026-08-28T12:00:00.000Z",
            status: "completed",
            itemType: "question_prompt",
            questionPrompt: {
              requestId: "prompt-1",
              questions: [
                {
                  id: "account",
                  header: "Account",
                  question: "Which account?",
                  isSecret: false,
                  options: null,
                },
              ],
              resolution: {
                status: "answered",
                responses: { account: { status: "answered", answers: ["Acme"] } },
              },
            },
          },
        ],
      },
    });
    await waitFor(() => expect(screen.getByRole("region", { name: "Answers sent" })).toBeVisible());
    expect(screen.queryByRole("textbox", { name: "Custom answer for: Which account?" })).not.toBeInTheDocument();
  });

  it("keeps the prompt active and reports a delivery failure", async () => {
    vi.mocked(window.openbot.agent.respondToPrompt).mockRejectedValueOnce(new Error("Provider is offline."));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    emitAgentEvent?.({
      type: "prompt",
      requestId: "prompt-failure",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-failure",
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

    const answer = await screen.findByRole("textbox", { name: "Custom answer for: Which account?" });
    await fireEvent.input(answer, { target: { value: "Acme" } });
    await fireEvent.keyDown(answer, { key: "Enter" });

    expect(await screen.findByText("Provider is offline.")).toBeVisible();
    expect(screen.getByText("Answer failed")).toBeVisible();
    expect(answer).toBeEnabled();
  });

  it("replaces an active prompt when its resolution arrives from another client", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    emitAgentEvent?.({
      type: "prompt",
      requestId: "prompt-external",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-external",
      questions: [
        {
          id: "account",
          header: "Account",
          question: "Which external account?",
          isSecret: false,
          options: null,
        },
      ],
    });
    expect(await screen.findByRole("textbox", { name: "Custom answer for: Which external account?" })).toBeVisible();

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-1",
        activeTurnId: "turn-external",
        revision: 20,
        messages: [
          {
            id: "question-prompt:turn-external:prompt-external",
            turnId: "turn-external",
            author: "assistant",
            source: "assistant",
            text: "Question: Which external account?\nAnswer: External",
            createdAt: "2026-08-28T12:00:00.000Z",
            status: "completed",
            itemType: "question_prompt",
            questionPrompt: {
              requestId: "prompt-external",
              questions: [
                {
                  id: "account",
                  header: "Account",
                  question: "Which external account?",
                  isSecret: false,
                  options: null,
                },
              ],
              resolution: {
                status: "answered",
                responses: { account: { status: "answered", answers: ["External"] } },
              },
            },
          },
        ],
      },
    });

    await waitFor(() => expect(screen.getByRole("region", { name: "Answers sent" })).toBeVisible());
    expect(
      screen.queryByRole("textbox", { name: "Custom answer for: Which external account?" }),
    ).not.toBeInTheDocument();
  });

  it("hides an unresolved history record and mounts a rapid follow-up prompt", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-1",
        activeTurnId: "turn-first",
        revision: 20,
        messages: [
          {
            id: "question-prompt:turn-first:prompt-first",
            turnId: "turn-first",
            author: "assistant",
            source: "assistant",
            text: "Question: First question?",
            createdAt: "2026-08-28T12:00:00.000Z",
            status: "completed",
            itemType: "question_prompt",
            questionPrompt: {
              requestId: "prompt-first",
              questions: [
                {
                  id: "first",
                  header: "First",
                  question: "First question?",
                  isSecret: false,
                  options: null,
                },
              ],
              resolution: null,
            },
          },
        ],
      },
    });
    expect(screen.queryByRole("region", { name: "Questions expired" })).not.toBeInTheDocument();

    emitAgentEvent?.({
      type: "prompt",
      requestId: "prompt-first",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-first",
      questions: [
        {
          id: "first",
          header: "First",
          question: "First question?",
          isSecret: false,
          options: null,
        },
      ],
    });
    const firstAnswer = await screen.findByRole("textbox", { name: "Custom answer for: First question?" });
    await fireEvent.input(firstAnswer, { target: { value: "First answer" } });
    await fireEvent.keyDown(firstAnswer, { key: "Enter" });
    await screen.findByRole("region", { name: "Answers sent" });

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-1",
        activeTurnId: "turn-first",
        revision: 21,
        messages: [
          {
            id: "question-prompt:turn-first:prompt-first",
            turnId: "turn-first",
            author: "assistant",
            source: "assistant",
            text: "Question: First question?\nAnswer: First answer",
            createdAt: "2026-08-28T12:00:00.000Z",
            status: "completed",
            itemType: "question_prompt",
            questionPrompt: {
              requestId: "prompt-first",
              questions: [
                {
                  id: "first",
                  header: "First",
                  question: "First question?",
                  isSecret: false,
                  options: null,
                },
              ],
              resolution: {
                status: "answered",
                responses: { first: { status: "answered", answers: ["First answer"] } },
              },
            },
          },
        ],
      },
    });

    emitAgentEvent?.({
      type: "prompt",
      requestId: "prompt-second",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-second",
      questions: [
        {
          id: "second",
          header: "Second",
          question: "Second question?",
          isSecret: false,
          options: null,
        },
      ],
    });

    expect(await screen.findByRole("textbox", { name: "Custom answer for: Second question?" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Answers sent" })).not.toBeInTheDocument();
  });

  it("keeps an older resolved prompt when a new turn reuses its request ID", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-1",
        activeTurnId: null,
        revision: 20,
        messages: [
          {
            id: "question-prompt:turn-old:prompt-reused",
            turnId: "turn-old",
            author: "assistant",
            source: "assistant",
            text: "Question: Which account?\nAnswer: Acme",
            createdAt: "2026-08-28T12:00:00.000Z",
            status: "completed",
            itemType: "question_prompt",
            questionPrompt: {
              requestId: "prompt-reused",
              questions: [
                {
                  id: "account",
                  header: "Account",
                  question: "Which account?",
                  isSecret: false,
                  options: null,
                },
              ],
              resolution: {
                status: "answered",
                responses: { account: { status: "answered", answers: ["Acme"] } },
              },
            },
          },
        ],
      },
    });
    expect(await screen.findByRole("region", { name: "Answers sent" })).toBeVisible();

    emitAgentEvent?.({
      type: "prompt",
      requestId: "prompt-reused",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-new",
      questions: [
        {
          id: "goal",
          header: "Goal",
          question: "What should I do next?",
          isSecret: false,
          options: null,
        },
      ],
    });

    expect(await screen.findByRole("textbox", { name: "Custom answer for: What should I do next?" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Answers sent" })).toBeVisible();
  });

  it("renders command approvals and keeps the action pending while submitting", async () => {
    let resolveApproval: (() => void) | undefined;
    vi.mocked(window.openbot.agent.respondToApproval).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveApproval = resolve;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    emitAgentEvent?.({
      type: "approval",
      approval: {
        requestId: "approval-1",
        botId: "chief",
        threadId: "thread-1",
        turnId: "turn-1",
        kind: "command",
        command: "npm test -- --runInBand",
        cwd: "/Users/norbertbodziony/projects/openbot",
        reason: "Run the verification suite.",
        grantRoot: null,
        permissions: null,
      },
    });

    expect(await screen.findByText("Run this command?")).toBeInTheDocument();
    expect(screen.getByText("npm test -- --runInBand")).toBeInTheDocument();
    expect(screen.getByText("Run the verification suite.")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(window.openbot.agent.respondToApproval).toHaveBeenCalledWith({
      requestId: "approval-1",
      decision: "accept",
    });

    resolveApproval?.();
    await waitFor(() => expect(screen.queryByText("Run this command?")).not.toBeInTheDocument());
  });

  // A queue belongs to one server, and a server switch now discards that
  // server's whole subtree. The only thing that can bring the queue back is the
  // seed the rebuilt scope takes from the Dynamic Island coordinator, which
  // lives above the switch. Nothing else asserts that work queued on a server
  // is still queued after a visit somewhere else.
  it("restores the queue of a server the user comes back to", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: {
        botId: "chief",
        deliveries: [
          queuedDelivery("delivery-running", "Current work", null, { status: "starting" }),
          queuedDelivery("delivery-next", "Next work", 1),
        ],
      },
    });
    await screen.findByRole("group", { name: "Queued message 1: Next work" });

    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.queryByRole("group", { name: "Queued message 1: Next work" })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    expect(await screen.findByRole("group", { name: "Queued message 1: Next work" })).toBeInTheDocument();
  });
});

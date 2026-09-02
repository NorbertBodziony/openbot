import type { ConversationPage, DirectConversationSnapshot } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { App, AppControllerProvider, createAppController } from "./App";
import {
  emitAgentEvent,
  emitDirectMessage,
  emitDynamicIslandAction,
  emitPresence,
  installOpenbotStub,
  presenceMember,
  testConversationPage,
  testServer,
} from "./app-test-harness";

describe("OpenBot connected desktop shell", () => {
  beforeEach(() => {
    installOpenbotStub();
  });

  it("merges a refreshed remote conversation page without dropping loaded messages", async () => {
    const message = (id: string, text: string) => ({
      id,
      author: "assistant" as const,
      text,
      createdAt: "2026-08-30T02:00:00.000Z",
      status: "completed" as const,
    });
    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValue(
      testConversationPage("chief", [message("reply-old", "Loaded earlier")], {
        pageInfo: { hasOlder: true, olderCursor: "older" },
      }),
    );
    render(() => <App />);
    expect(await screen.findByText("Loaded earlier")).toBeInTheDocument();

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage("chief", [message("reply-new", "Fresh remote reply")], {
        revision: 2,
        pageInfo: { hasOlder: true, olderCursor: "older" },
      }),
    });

    expect(await screen.findByText("Fresh remote reply")).toBeInTheDocument();
    expect(screen.getByText("Loaded earlier")).toBeInTheDocument();
  });

  it("keeps the current read state when an older page returns stale read data", async () => {
    const latestMessage = {
      id: "reply-latest-page",
      author: "assistant" as const,
      text: "Latest reply",
      createdAt: "2026-08-30T02:02:00.000Z",
      status: "completed" as const,
    };
    const latestPage = testConversationPage("chief", [latestMessage], {
      readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
      pageInfo: { hasOlder: true, olderCursor: "older" },
    });
    let resolveOlderPage: ((page: ConversationPage) => void) | undefined;
    vi.mocked(window.openbot.agent.readConversationPage).mockImplementation(async (input) => {
      if (input.anchor?.type !== "before") return latestPage;
      return await new Promise((resolve) => {
        resolveOlderPage = resolve;
      });
    });

    function Harness() {
      const controller = createAppController({});
      return (
        <AppControllerProvider controller={controller}>
          <button type="button" onClick={() => void controller.loadOlderAgentMessages("chief")}>
            Load older agent messages
          </button>
          <output data-testid="agent-read-state">
            {controller.conversationReads().chief?.unreadCount ?? -1}|
            {controller
              .activeMessages()
              .map((message) => message.id)
              .join(",")}
          </output>
        </AppControllerProvider>
      );
    }

    render(() => <Harness />);
    await waitFor(() => expect(screen.getByTestId("agent-read-state")).toHaveTextContent("0|reply-latest-page"));
    await fireEvent.click(screen.getByRole("button", { name: "Load older agent messages" }));
    await waitFor(() => expect(resolveOlderPage).toBeDefined());

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage("chief", [latestMessage], {
        revision: 2,
        readState: { unreadCount: 1, firstUnreadMessageId: latestMessage.id, throughMessageId: null },
        pageInfo: { hasOlder: true, olderCursor: "older" },
      }),
    });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId("agent-read-state")).toHaveTextContent("0|reply-latest-page"));

    resolveOlderPage?.(
      testConversationPage(
        "chief",
        [
          {
            id: "reply-older-page",
            author: "assistant",
            text: "Older reply",
            createdAt: "2026-08-30T02:01:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 1, firstUnreadMessageId: latestMessage.id, throughMessageId: null },
        },
      ),
    );

    await waitFor(() =>
      expect(screen.getByTestId("agent-read-state")).toHaveTextContent("0|reply-older-page,reply-latest-page"),
    );
  });

  it("does not persist a redundant read for an already-read refreshed page", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-already-read",
            author: "assistant",
            text: "Historical visible reply",
            createdAt: "2026-08-30T02:02:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "reply-already-read" },
        },
      ),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.openbot.agent.markConversationRead).not.toHaveBeenCalled();
    expect(screen.queryByRole("status", { name: /new messages?/ })).not.toBeInTheDocument();
  });

  it("keeps a successful realtime read when a pending reload resolves later", async () => {
    let resolveInitialPage: ((page: ConversationPage) => void) | undefined;
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({
      chief: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
    });
    vi.mocked(window.openbot.agent.readConversationPage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitialPage = resolve;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await waitFor(() => expect(resolveInitialPage).toBeDefined());
    const unreadPage = testConversationPage(
      "chief",
      [
        {
          id: "reply-reload-race",
          author: "assistant",
          text: "Reply before the reload resolves",
          createdAt: "2026-08-30T02:02:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: { unreadCount: 1, firstUnreadMessageId: "reply-reload-race", throughMessageId: null },
      },
    );

    emitAgentEvent?.({ type: "conversation-page", page: unreadPage });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());

    resolveInitialPage?.(unreadPage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "New messages" })).not.toBeInTheDocument();
  });

  it("keeps a duplicate refreshed page read while persistence is pending", async () => {
    let resolveRead: ((state: NonNullable<ConversationPage["readState"]>) => void) | undefined;
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({
      chief: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
    });
    vi.mocked(window.openbot.agent.markConversationRead).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const duplicatePage = testConversationPage(
      "chief",
      [
        {
          id: "reply-pending-read",
          author: "assistant",
          text: "Reply with a pending read",
          createdAt: "2026-08-30T02:02:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: { unreadCount: 1, firstUnreadMessageId: "reply-pending-read", throughMessageId: null },
      },
    );

    emitAgentEvent?.({ type: "conversation-page", page: duplicatePage });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument();

    emitAgentEvent?.({ type: "conversation-page", page: duplicatePage });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument();

    resolveRead?.({ unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "reply-pending-read" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("restores a newer unread reply when its queued read fails", async () => {
    let resolveFirstRead: ((state: NonNullable<ConversationPage["readState"]>) => void) | undefined;
    let rejectSecondRead: ((error: Error) => void) | undefined;
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({
      chief: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
    });
    vi.mocked(window.openbot.agent.markConversationRead)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectSecondRead = reject;
          }),
      );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-read-a",
            author: "assistant",
            text: "First queued reply",
            createdAt: "2026-08-30T02:02:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-read-a", throughMessageId: null },
        },
      ),
    });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce());

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-read-a",
            author: "assistant",
            text: "First queued reply",
            createdAt: "2026-08-30T02:02:00.000Z",
            status: "completed",
          },
          {
            id: "reply-read-b",
            author: "assistant",
            text: "Newer queued reply",
            createdAt: "2026-08-30T02:03:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 3,
          readState: { unreadCount: 2, firstUnreadMessageId: "reply-read-a", throughMessageId: null },
        },
      ),
    });
    await screen.findByText("Newer queued reply");
    expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce();

    resolveFirstRead?.({ unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "reply-read-a" });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledTimes(2));
    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValueOnce(
      testConversationPage(
        "chief",
        [
          {
            id: "reply-read-b",
            author: "assistant",
            text: "Newer queued reply",
            createdAt: "2026-08-30T02:03:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 3,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-read-b", throughMessageId: "reply-read-a" },
        },
      ),
    );
    rejectSecondRead?.(new Error("Newer read unavailable"));

    expect(await screen.findByText("Newer read unavailable")).toBeInTheDocument();
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
  });

  it("retries an automatic read for the same message after persistence fails", async () => {
    vi.mocked(window.openbot.agent.markConversationRead).mockRejectedValueOnce(new Error("Read unavailable"));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const page = testConversationPage(
      "chief",
      [
        {
          id: "reply-read-retry",
          author: "assistant",
          text: "Visible reply that needs a retry",
          createdAt: "2026-08-30T02:02:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: { unreadCount: 1, firstUnreadMessageId: "reply-read-retry", throughMessageId: null },
      },
    );
    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValueOnce(page);

    emitAgentEvent?.({ type: "conversation-page", page });
    expect(await screen.findByText("Read unavailable")).toBeInTheDocument();
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();

    emitAgentEvent?.({ type: "conversation-page", page });
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenNthCalledWith(
        2,
        {
          botId: "chief",
          throughMessageId: "reply-read-retry",
        },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
  });

  it("does not carry a failed automatic read to the same bot on another server", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let selectedServerId = "local";
    let returningToLocal = false;
    let rejectLocalRead: ((error: Error) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => {
      selectedServerId = serverId;
      returningToLocal = serverId === "local";
      return [
        { ...local, active: serverId === "local" },
        { ...remote, active: serverId === "remote-1" },
      ];
    });
    vi.mocked(window.openbot.agent.readConversationPage).mockImplementation(async (input) => {
      if (selectedServerId === "remote-1") {
        return testConversationPage(
          input.botId,
          [
            {
              id: "reply-remote-loaded",
              author: "assistant",
              text: "Remote loaded reply",
              createdAt: "2026-08-30T02:02:30.000Z",
              status: "completed",
            },
          ],
          {
            readState: { unreadCount: 1, firstUnreadMessageId: "reply-remote-loaded", throughMessageId: null },
          },
        );
      }
      if (returningToLocal) {
        return testConversationPage(
          input.botId,
          [
            {
              id: "reply-local",
              author: "assistant",
              text: "Local reply after returning",
              createdAt: "2026-08-30T02:02:00.000Z",
              status: "completed",
            },
          ],
          {
            readState: { unreadCount: 1, firstUnreadMessageId: "reply-local", throughMessageId: null },
          },
        );
      }
      return testConversationPage(input.botId);
    });
    vi.mocked(window.openbot.agent.listConversationReads)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        chief: { unreadCount: 1, firstUnreadMessageId: "reply-remote", throughMessageId: null },
      })
      .mockResolvedValueOnce({
        chief: { unreadCount: 1, firstUnreadMessageId: "reply-local", throughMessageId: null },
      });
    vi.mocked(window.openbot.agent.markConversationRead).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectLocalRead = reject;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-local",
            author: "assistant",
            text: "Local visible reply",
            createdAt: "2026-08-30T02:02:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-local", throughMessageId: null },
        },
      ),
    });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce());

    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() => expect(window.openbot.servers.select).toHaveBeenCalledWith("remote-1"));
    await waitFor(() => expect(window.openbot.agent.listConversationReads).toHaveBeenCalledTimes(2));
    await screen.findByText("Remote loaded reply");
    expect(screen.getByRole("status", { name: "1 new message" })).toBeInTheDocument();
    rejectLocalRead?.(new Error("Local read unavailable"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-remote",
            author: "assistant",
            text: "Remote unread reply",
            createdAt: "2026-08-30T02:03:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-remote", throughMessageId: null },
        },
      ),
    });
    await screen.findByText("Remote unread reply");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce();
    expect(screen.queryByText("Local read unavailable")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "1 new message" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    await waitFor(() => expect(window.openbot.agent.listConversationReads).toHaveBeenCalledTimes(3));
    await screen.findByText("Local reply after returning");
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenNthCalledWith(
        2,
        { botId: "chief", throughMessageId: "reply-local" },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
  });

  it("keeps a queued read scoped to its original server", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolveFirstRead: ((state: NonNullable<ConversationPage["readState"]>) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockResolvedValueOnce([
      { ...local, active: false },
      { ...remote, active: true },
    ]);
    vi.mocked(window.openbot.agent.markConversationRead)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve;
          }),
      )
      .mockImplementationOnce(async (input) => ({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: input.throughMessageId,
      }));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-first-local",
            author: "assistant",
            text: "First local reply",
            createdAt: "2026-08-30T02:02:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-first-local", throughMessageId: null },
        },
      ),
    });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce());

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-first-local",
            author: "assistant",
            text: "First local reply",
            createdAt: "2026-08-30T02:02:00.000Z",
            status: "completed",
          },
          {
            id: "reply-second-local",
            author: "assistant",
            text: "Second local reply",
            createdAt: "2026-08-30T02:03:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 3,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-second-local", throughMessageId: null },
        },
      ),
    });
    await screen.findByText("Second local reply");
    expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce();

    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() => expect(window.openbot.agent.listConversationReads).toHaveBeenCalledTimes(2));
    resolveFirstRead?.({
      unreadCount: 1,
      firstUnreadMessageId: "reply-second-local",
      throughMessageId: "reply-first-local",
    });

    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledTimes(2));
    expect(window.openbot.agent.markConversationRead).toHaveBeenNthCalledWith(
      2,
      { botId: "chief", throughMessageId: "reply-second-local" },
      "local",
    );
  });

  it("does not mark an older boundary from a rejected conversation page", async () => {
    let resolveInitialPage: ((page: ConversationPage) => void) | undefined;
    vi.mocked(window.openbot.agent.readConversationPage).mockImplementation(
      async (): Promise<ConversationPage> =>
        await new Promise((resolve) => {
          resolveInitialPage = resolve;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-newer-boundary",
            author: "assistant",
            text: "Newest visible reply",
            createdAt: "2026-08-30T02:02:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-newer-boundary", throughMessageId: null },
        },
      ),
    });
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "reply-newer-boundary",
        },
        "local",
      ),
    );

    resolveInitialPage?.(
      testConversationPage(
        "chief",
        [
          {
            id: "reply-older-boundary",
            author: "assistant",
            text: "Older reply",
            createdAt: "2026-08-30T02:01:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 1,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-older-boundary", throughMessageId: null },
        },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.openbot.agent.markConversationRead).not.toHaveBeenCalledWith(
      {
        botId: "chief",
        throughMessageId: "reply-older-boundary",
      },
      "local",
    );
    expect(screen.getByText("Newest visible reply")).toBeInTheDocument();
  });

  it("retries an explicit chat-open reload when its page revision is stale", async () => {
    const unreadState = {
      unreadCount: 1,
      firstUnreadMessageId: "reply-current-revision",
      throughMessageId: null,
    };
    const currentPage = testConversationPage(
      "chief",
      [
        {
          id: "reply-current-revision",
          author: "assistant",
          text: "Current revision reply",
          createdAt: "2026-08-30T02:03:00.000Z",
          status: "completed",
        },
      ],
      { revision: 2, readState: unreadState },
    );
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({ chief: unreadState });
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValue({
      botId: "chief",
      threadId: currentPage.threadId,
      activeTurnId: null,
      revision: currentPage.revision,
      readState: unreadState,
      messages: currentPage.messages,
    });
    render(() => <App />);
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();

    vi.mocked(window.openbot.agent.readConversationPage)
      .mockResolvedValueOnce(
        testConversationPage(
          "chief",
          [
            {
              id: "reply-stale-revision",
              author: "assistant",
              text: "Stale revision reply",
              createdAt: "2026-08-30T02:02:00.000Z",
              status: "completed",
            },
          ],
          {
            revision: 1,
            readState: { unreadCount: 1, firstUnreadMessageId: "reply-stale-revision", throughMessageId: null },
          },
        ),
      )
      .mockResolvedValueOnce(currentPage);
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "reply-current-revision",
        },
        "local",
      ),
    );
    expect(window.openbot.agent.markConversationRead).not.toHaveBeenCalledWith(
      {
        botId: "chief",
        throughMessageId: "reply-stale-revision",
      },
      "local",
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
  });

  it("uses the latest visible reply after one stale retry without reloading the queue", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-applied-revision",
            author: "assistant",
            text: "Applied revision reply",
            createdAt: "2026-08-30T02:03:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "reply-applied-revision" },
        },
      ),
    });
    await screen.findByText("Applied revision reply");
    const stalePage = testConversationPage("chief", [], {
      revision: 1,
      readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
    });
    const callsBeforeOpen = vi.mocked(window.openbot.agent.readConversationPage).mock.calls.length;
    const queueCallsBeforeOpen = vi.mocked(window.openbot.agent.listQueue).mock.calls.length;
    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValue(stalePage);

    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    await waitFor(() => expect(window.openbot.agent.readConversationPage).toHaveBeenCalledTimes(callsBeforeOpen + 2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.openbot.agent.readConversationPage).toHaveBeenCalledTimes(callsBeforeOpen + 2);
    expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
      { botId: "chief", throughMessageId: "reply-applied-revision" },
      "local",
    );
    expect(window.openbot.agent.listQueue).toHaveBeenCalledTimes(queueCallsBeforeOpen);
  });

  it("applies an explicit read after an older automatic read", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const firstPage = testConversationPage(
      "chief",
      [
        {
          id: "reply-automatic-first",
          author: "assistant",
          text: "First automatic reply",
          createdAt: "2026-08-30T02:03:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: { unreadCount: 1, firstUnreadMessageId: "reply-automatic-first", throughMessageId: null },
      },
    );
    emitAgentEvent?.({ type: "conversation-page", page: firstPage });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce());

    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    await screen.findByRole("heading", { name: "Sales Outbound" });
    const newerPage = testConversationPage(
      "chief",
      [
        ...firstPage.messages,
        {
          id: "reply-explicit-newer",
          author: "assistant",
          text: "Newer reply while closed",
          createdAt: "2026-08-30T02:04:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 3,
        readState: {
          unreadCount: 1,
          firstUnreadMessageId: "reply-explicit-newer",
          throughMessageId: "reply-automatic-first",
        },
      },
    );
    emitAgentEvent?.({ type: "conversation-page", page: newerPage });
    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValueOnce(newerPage);

    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenNthCalledWith(
        2,
        { botId: "chief", throughMessageId: "reply-explicit-newer" },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
  });

  it("marks the latest visible reply when a chat-open reload fails", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    await screen.findByRole("heading", { name: "Sales Outbound" });
    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-before-load-failure",
            author: "assistant",
            text: "Visible reply before load failure",
            createdAt: "2026-08-30T02:04:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-before-load-failure", throughMessageId: null },
        },
      ),
    });
    vi.mocked(window.openbot.agent.readConversationPage).mockRejectedValueOnce(new Error("Reload unavailable"));

    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    expect(await screen.findByText("Reload unavailable")).toBeInTheDocument();
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        { botId: "chief", throughMessageId: "reply-before-load-failure" },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
  });

  it("shows and clears the unread boundary in an agent conversation", async () => {
    const readState = {
      unreadCount: 2,
      firstUnreadMessageId: "agent-new-1",
      throughMessageId: "agent-old",
    };
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({
      chief: readState,
    });
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValue({
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 3,
      readState,
      messages: [
        {
          id: "agent-old",
          author: "user",
          text: "Old message",
          createdAt: "2026-08-19T09:00:00.000Z",
          status: "completed",
        },
        {
          id: "agent-new-1",
          author: "agent",
          source: "agent",
          senderBotId: "sales-outbound",
          text: "First unseen agent answer",
          createdAt: "2026-08-19T09:01:00.000Z",
          status: "completed",
          exchange: {
            direction: "incoming",
            messageId: "agent-new-1",
            senderBotId: "sales-outbound",
            recipientBotIds: ["chief"],
            replyToMessageId: null,
            deliveries: [
              {
                id: "agent-new-1",
                recipientBotId: "chief",
                status: "completed",
                position: null,
                error: null,
              },
            ],
          },
        },
        {
          id: "agent-new-2",
          author: "assistant",
          text: "Second unseen answer",
          createdAt: "2026-08-19T09:02:00.000Z",
          status: "completed",
        },
      ],
    });
    vi.mocked(window.openbot.agent.markConversationRead).mockResolvedValueOnce({
      unreadCount: 0,
      firstUnreadMessageId: null,
      throughMessageId: "agent-new-2",
    });

    render(() => <App />);
    expect(await screen.findByRole("status", { name: "2 new messages" })).toBeInTheDocument();
    await screen.findByText("Message from");
    expect(screen.getByRole("separator", { name: "New messages" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Jump to 2 new messages" }));

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "agent-new-2",
        },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "2 new messages" })).not.toBeInTheDocument());
  });

  it("keeps a reply unread while the open agent chat is in the background and clears it on focus", async () => {
    const unreadPage = testConversationPage(
      "chief",
      [
        {
          id: "agent-background-answer",
          author: "assistant",
          text: "Ready while OpenBot was in the background",
          createdAt: "2026-08-19T09:03:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: {
          unreadCount: 1,
          firstUnreadMessageId: "agent-background-answer",
          throughMessageId: null,
        },
      },
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await waitFor(() => expect(emitDynamicIslandAction).toBeDefined());
    vi.mocked(window.openbot.agent.markConversationRead).mockClear();
    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValue(unreadPage);

    window.dispatchEvent(new Event("blur"));
    emitAgentEvent?.({ type: "conversation-page", page: unreadPage });

    expect(await screen.findByText("Ready while OpenBot was in the background")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "1 new message" })).toBeInTheDocument();
    expect(window.openbot.agent.markConversationRead).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        mode: "message",
        message: { messageId: "agent-background-answer" },
      }),
    );

    window.dispatchEvent(new Event("focus"));

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "agent-background-answer",
        },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        mode: "idle",
      }),
    );
  });

  it("keeps a queued snapshot unread when the app loses focus before rendering it", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    vi.mocked(window.openbot.agent.markConversationRead).mockClear();

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 2,
        messages: [
          {
            id: "agent-focus-race",
            author: "assistant",
            text: "Rendered after focus was lost",
            createdAt: "2026-08-19T09:03:30.000Z",
            status: "completed",
          },
        ],
      },
    });
    window.dispatchEvent(new Event("blur"));

    expect(await screen.findByText("Rendered after focus was lost")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "1 new message" })).toBeInTheDocument();
    expect(window.openbot.agent.markConversationRead).not.toHaveBeenCalled();
  });

  it("extends an in-flight focus read to a newer visible agent reply", async () => {
    const oldPage = testConversationPage(
      "chief",
      [
        {
          id: "agent-focus-old",
          author: "assistant",
          text: "Older background reply",
          createdAt: "2026-08-19T09:03:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: { unreadCount: 1, firstUnreadMessageId: "agent-focus-old", throughMessageId: null },
      },
    );
    const newPage = testConversationPage(
      "chief",
      [
        ...oldPage.messages,
        {
          id: "agent-focus-new",
          author: "assistant",
          text: "Newer reply during focus read",
          createdAt: "2026-08-19T09:04:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 3,
        readState: { unreadCount: 2, firstUnreadMessageId: "agent-focus-old", throughMessageId: null },
      },
    );
    let resolveFirstRead: ((state: NonNullable<ConversationPage["readState"]>) => void) | undefined;
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    window.dispatchEvent(new Event("blur"));
    emitAgentEvent?.({ type: "conversation-page", page: oldPage });
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValue(oldPage);
    vi.mocked(window.openbot.agent.markConversationRead)
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve;
          }),
      )
      .mockImplementation(async (input) => ({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: input.throughMessageId,
      }));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        { botId: "chief", throughMessageId: "agent-focus-old" },
        "local",
      ),
    );
    emitAgentEvent?.({ type: "conversation-page", page: newPage });
    expect(await screen.findByText("Newer reply during focus read")).toBeInTheDocument();
    resolveFirstRead?.({
      unreadCount: 1,
      firstUnreadMessageId: "agent-focus-new",
      throughMessageId: "agent-focus-old",
    });

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        { botId: "chief", throughMessageId: "agent-focus-new" },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: /new messages?/ })).not.toBeInTheDocument());
  });

  it("keeps a newer agent reply unread when an earlier focus read resolves in the background", async () => {
    const oldPage = testConversationPage(
      "chief",
      [
        {
          id: "agent-stale-read-old",
          author: "assistant",
          text: "Reply visible before focus",
          createdAt: "2026-08-19T09:03:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: { unreadCount: 1, firstUnreadMessageId: "agent-stale-read-old", throughMessageId: null },
      },
    );
    const newPage = testConversationPage(
      "chief",
      [
        ...oldPage.messages,
        {
          id: "agent-stale-read-new",
          author: "assistant",
          text: "Reply received after focus was lost",
          createdAt: "2026-08-19T09:04:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 3,
        readState: { unreadCount: 2, firstUnreadMessageId: "agent-stale-read-old", throughMessageId: null },
      },
    );
    let resolveFirstRead: ((state: NonNullable<ConversationPage["readState"]>) => void) | undefined;
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    window.dispatchEvent(new Event("blur"));
    emitAgentEvent?.({ type: "conversation-page", page: oldPage });
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValue(oldPage);
    vi.mocked(window.openbot.agent.markConversationRead)
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve;
          }),
      )
      .mockImplementation(async (input) => ({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: input.throughMessageId,
      }));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        { botId: "chief", throughMessageId: "agent-stale-read-old" },
        "local",
      ),
    );
    window.dispatchEvent(new Event("blur"));
    emitAgentEvent?.({ type: "conversation-page", page: newPage });
    expect(await screen.findByText("Reply received after focus was lost")).toBeInTheDocument();
    resolveFirstRead?.({
      unreadCount: 0,
      firstUnreadMessageId: null,
      throughMessageId: "agent-stale-read-old",
    });

    await waitFor(() => expect(screen.getByRole("status", { name: "1 new message" })).toBeInTheDocument());
    expect(window.openbot.agent.markConversationRead).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        { botId: "chief", throughMessageId: "agent-stale-read-new" },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: /new messages?/ })).not.toBeInTheDocument());
  });

  it("keeps another agent new until that agent is opened after focus returns", async () => {
    const unreadPage = testConversationPage(
      "sales-outbound",
      [
        {
          id: "sales-background-answer",
          author: "assistant",
          text: "Sales result from the background",
          createdAt: "2026-08-19T09:04:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: {
          unreadCount: 1,
          firstUnreadMessageId: "sales-background-answer",
          throughMessageId: null,
        },
      },
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    vi.mocked(window.openbot.agent.markConversationRead).mockClear();

    window.dispatchEvent(new Event("blur"));
    emitAgentEvent?.({ type: "conversation-page", page: unreadPage });
    window.dispatchEvent(new Event("focus"));

    const sales = screen.getByRole("button", { name: /Sales Outbound/ });
    await waitFor(() => expect(sales).toHaveTextContent("1 new reply"));
    expect(window.openbot.agent.markConversationRead).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        mode: "message",
        message: { bot: { id: "sales-outbound" }, messageId: "sales-background-answer" },
      }),
    );

    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValue(unreadPage);
    await fireEvent.click(sales);

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "sales-outbound",
          throughMessageId: "sales-background-answer",
        },
        "local",
      ),
    );
    await waitFor(() => expect(sales).not.toHaveTextContent("1 new reply"));
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        mode: "idle",
      }),
    );
  });

  it("shows a completed indicator only until the background app receives focus", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const chief = screen.getByRole("button", { name: /Chief/ });

    emitAgentEvent?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-foreground",
      status: "completed",
    });
    expect(chief).not.toHaveTextContent("Responded");

    window.dispatchEvent(new Event("blur"));
    emitAgentEvent?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-background",
      status: "completed",
    });
    expect(chief).toHaveTextContent("Responded");

    window.dispatchEvent(new Event("focus"));
    expect(chief).not.toHaveTextContent("Responded");
  });

  it("keeps a message read when it arrives in the open agent chat", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await waitFor(() => expect(window.openbot.agent.readConversation).toHaveBeenCalledWith("chief"));

    emitAgentEvent?.({
      type: "conversation-delta",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live",
      messageId: "agent-visible-answer",
      delta: "Visible as it arrives",
      createdAt: "2026-08-19T09:03:00.000Z",
      revision: 1,
    });

    await waitFor(() =>
      expect(document.querySelector('[data-chat-search-message="agent-visible-answer"]')).toHaveTextContent(
        "Visible as it arrives",
      ),
    );
    expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "New messages" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "agent-visible-answer",
        },
        "local",
      ),
    );
  });

  it("clears unread messages when entering an agent chat", async () => {
    const unreadState = {
      unreadCount: 1,
      firstUnreadMessageId: "sales-new",
      throughMessageId: null,
    };
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({
      "sales-outbound": unreadState,
    });
    vi.mocked(window.openbot.agent.readConversation).mockImplementation(async (botId) =>
      botId === "sales-outbound"
        ? {
            botId,
            threadId: "thread-sales",
            activeTurnId: null,
            revision: 1,
            readState: unreadState,
            messages: [
              {
                id: "sales-new",
                author: "assistant",
                text: "A new sales reply",
                createdAt: "2026-08-19T09:03:00.000Z",
                status: "completed",
              },
            ],
          }
        : {
            botId,
            threadId: null,
            activeTurnId: null,
            revision: 0,
            readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
            messages: [],
          },
    );

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));

    expect(await screen.findByText("A new sales reply")).toBeInTheDocument();
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "sales-outbound",
          throughMessageId: "sales-new",
        },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
    expect(screen.queryByRole("separator", { name: "New messages" })).not.toBeInTheDocument();
  });

  it("clears unread messages in the selected agent chat when queue loading fails", async () => {
    const unreadState = {
      unreadCount: 1,
      firstUnreadMessageId: "chief-new",
      throughMessageId: null,
    };
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({ chief: unreadState });
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValue({
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 1,
      readState: unreadState,
      messages: [
        {
          id: "chief-new",
          author: "assistant",
          text: "A new reply from Chief",
          createdAt: "2026-08-19T09:03:00.000Z",
          status: "completed",
        },
      ],
    });
    vi.mocked(window.openbot.agent.listQueue).mockRejectedValue(new Error("Queue unavailable"));

    render(() => <App />);
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
    await screen.findByText("A new reply from Chief");
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "chief-new",
        },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
    expect(screen.queryByRole("separator", { name: "New messages" })).not.toBeInTheDocument();
  });

  it("preserves explicit read intent when an agent status change supersedes the page request", async () => {
    const unreadState = {
      unreadCount: 1,
      firstUnreadMessageId: "chief-status-reply",
      throughMessageId: null,
    };
    const unreadPage = testConversationPage(
      "chief",
      [
        {
          id: "chief-status-reply",
          author: "assistant",
          text: "Reply visible after status change",
          createdAt: "2026-08-19T09:05:00.000Z",
          status: "completed",
        },
      ],
      { readState: unreadState },
    );
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({ chief: unreadState });
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValue({
      botId: "chief",
      threadId: unreadPage.threadId,
      activeTurnId: null,
      revision: unreadPage.revision,
      readState: unreadState,
      messages: unreadPage.messages,
    });
    render(() => <App />);
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();

    let resolveFirstPage: ((page: ConversationPage) => void) | undefined;
    let resolveSecondPage: ((page: ConversationPage) => void) | undefined;
    vi.mocked(window.openbot.agent.readConversationPage)
      .mockImplementationOnce(
        async (): Promise<ConversationPage> =>
          await new Promise((resolve) => {
            resolveFirstPage = resolve;
          }),
      )
      .mockImplementationOnce(
        async (): Promise<ConversationPage> =>
          await new Promise((resolve) => {
            resolveSecondPage = resolve;
          }),
      );
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    await waitFor(() => expect(resolveFirstPage).toBeDefined());

    const currentStatus = await window.openbot.agent.getStatus();
    emitAgentEvent?.({ type: "status", status: { ...currentStatus, phase: "starting" } });
    await waitFor(() => expect(resolveSecondPage).toBeDefined());
    resolveFirstPage?.(unreadPage);
    resolveSecondPage?.(unreadPage);

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "chief-status-reply",
        },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
  });

  it("marks a newer reply that arrives while an opened agent chat is being marked read", async () => {
    const unreadState = {
      unreadCount: 1,
      firstUnreadMessageId: "chief-old-reply",
      throughMessageId: null,
    };
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({ chief: unreadState });
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValue({
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 1,
      readState: unreadState,
      messages: [
        {
          id: "chief-old-reply",
          author: "assistant",
          text: "First visible reply",
          createdAt: "2026-08-19T09:03:00.000Z",
          status: "completed",
        },
      ],
    });
    let resolveInitialMark: ((state: NonNullable<ConversationPage["readState"]>) => void) | undefined;
    vi.mocked(window.openbot.agent.markConversationRead)
      .mockImplementationOnce(
        async (): Promise<NonNullable<ConversationPage["readState"]>> =>
          await new Promise((resolve) => {
            resolveInitialMark = resolve;
          }),
      )
      .mockImplementation(async (input) => ({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: input.throughMessageId,
      }));

    render(() => <App />);
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "chief-old-reply",
        },
        "local",
      ),
    );

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "chief-old-reply",
            author: "assistant",
            text: "First visible reply",
            createdAt: "2026-08-19T09:03:00.000Z",
            status: "completed",
          },
          {
            id: "chief-newer-reply",
            author: "assistant",
            text: "Newer visible reply",
            createdAt: "2026-08-19T09:04:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 2, firstUnreadMessageId: "chief-old-reply", throughMessageId: null },
        },
      ),
    });

    expect(await screen.findByText("Newer visible reply")).toBeInTheDocument();
    resolveInitialMark?.({
      unreadCount: 1,
      firstUnreadMessageId: "chief-newer-reply",
      throughMessageId: "chief-old-reply",
    });
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "chief-newer-reply",
        },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: /new messages?/ })).not.toBeInTheDocument());
  });

  it("keeps the agent unread state when marking it fails", async () => {
    const readState = {
      unreadCount: 1,
      firstUnreadMessageId: "agent-new",
      throughMessageId: null,
    };
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({
      chief: readState,
    });
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValue({
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 2,
      readState,
      messages: [
        {
          id: "agent-old-user",
          author: "user",
          text: "Previous request",
          createdAt: "2026-08-19T09:00:00.000Z",
          status: "completed",
        },
        {
          id: "agent-new",
          author: "assistant",
          text: "Unseen answer",
          createdAt: "2026-08-19T09:01:00.000Z",
          status: "completed",
        },
      ],
    });
    vi.mocked(window.openbot.agent.markConversationRead).mockRejectedValueOnce(new Error("Read state unavailable"));

    render(() => <App />);
    const banner = await screen.findByRole("status", { name: "1 new message" });
    await screen.findByText("Unseen answer");
    await fireEvent.click(within(banner).getByRole("button", { name: "Jump to 1 new message" }));

    expect(await screen.findByText("Read state unavailable")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "1 new message" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "New messages" })).toBeInTheDocument();
    expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
      {
        botId: "chief",
        throughMessageId: "agent-new",
      },
      "local",
    );
  });

  it("keeps an open private message unread in the background and clears it on focus", async () => {
    render(() => <App peopleEnabled />);
    await screen.findByRole("heading", { name: "Chief" });
    emitPresence?.({
      serverId: "server-1",
      updatedAt: "2026-08-19T10:00:00.000Z",
      members: [
        presenceMember("member-self", "person@example.com", "Person"),
        presenceMember("member-alice", "alice@example.com", "Alice"),
      ],
    });
    await fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));
    await waitFor(() => expect(window.openbot.servers.readDirectConversationPage).toHaveBeenCalled());
    vi.mocked(window.openbot.servers.markDirectRead).mockClear();

    window.dispatchEvent(new Event("blur"));
    emitDirectMessage?.({
      type: "team-direct-message",
      memberIds: ["member-alice", "member-self"],
      message: {
        id: "direct-background",
        threadId: "thread-member-alice",
        senderMemberId: "member-alice",
        recipientMemberId: "member-self",
        text: "Private result from the background",
        createdAt: "2026-08-19T10:01:00.000Z",
        sequence: 1,
      },
    });

    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
    expect(window.openbot.servers.markDirectRead).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("focus"));

    await waitFor(() =>
      expect(window.openbot.servers.markDirectRead).toHaveBeenCalledWith({
        memberId: "member-alice",
        throughSequence: 1,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
  });

  it("extends an in-flight focus read to a newer visible private message", async () => {
    let resolveFirstRead: ((state: NonNullable<DirectConversationSnapshot["readState"]>) => void) | undefined;
    vi.mocked(window.openbot.servers.readDirectConversation).mockResolvedValueOnce({
      threadId: "thread-member-alice",
      otherMemberId: "member-alice",
      revision: 1,
      readState: { unreadCount: 1, firstUnreadMessageId: "direct-focus-old", throughSequence: 0 },
      messages: [
        {
          id: "direct-focus-old",
          threadId: "thread-member-alice",
          senderMemberId: "member-alice",
          recipientMemberId: "member-self",
          text: "Older private background message",
          createdAt: "2026-08-19T10:00:00.000Z",
          sequence: 1,
        },
      ],
    });
    render(() => <App peopleEnabled />);
    await screen.findByRole("heading", { name: "Chief" });
    emitPresence?.({
      serverId: "server-1",
      updatedAt: "2026-08-19T10:00:00.000Z",
      members: [
        presenceMember("member-self", "person@example.com", "Person"),
        presenceMember("member-alice", "alice@example.com", "Alice"),
      ],
    });
    window.dispatchEvent(new Event("blur"));
    await fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
    vi.mocked(window.openbot.servers.markDirectRead)
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve;
          }),
      )
      .mockImplementation(async (input) => ({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughSequence: input.throughSequence,
      }));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(window.openbot.servers.markDirectRead).toHaveBeenCalledWith({
        memberId: "member-alice",
        throughSequence: 1,
      }),
    );
    emitDirectMessage?.({
      type: "team-direct-message",
      memberIds: ["member-alice", "member-self"],
      message: {
        id: "direct-focus-new",
        threadId: "thread-member-alice",
        senderMemberId: "member-alice",
        recipientMemberId: "member-self",
        text: "Newer private message during focus read",
        createdAt: "2026-08-19T10:01:00.000Z",
        sequence: 2,
      },
    });
    resolveFirstRead?.({
      unreadCount: 1,
      firstUnreadMessageId: "direct-focus-new",
      throughSequence: 1,
    });

    await waitFor(() =>
      expect(window.openbot.servers.markDirectRead).toHaveBeenCalledWith({
        memberId: "member-alice",
        throughSequence: 2,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: /new messages?/ })).not.toBeInTheDocument());
  });

  it("keeps a newer private message unread when an earlier focus read resolves in the background", async () => {
    let resolveFirstRead: ((state: NonNullable<DirectConversationSnapshot["readState"]>) => void) | undefined;
    vi.mocked(window.openbot.servers.readDirectConversation).mockResolvedValueOnce({
      threadId: "thread-member-alice",
      otherMemberId: "member-alice",
      revision: 1,
      readState: { unreadCount: 1, firstUnreadMessageId: "direct-stale-read-old", throughSequence: 0 },
      messages: [
        {
          id: "direct-stale-read-old",
          threadId: "thread-member-alice",
          senderMemberId: "member-alice",
          recipientMemberId: "member-self",
          text: "Private reply visible before focus",
          createdAt: "2026-08-19T10:00:00.000Z",
          sequence: 1,
        },
      ],
    });
    render(() => <App peopleEnabled />);
    await screen.findByRole("heading", { name: "Chief" });
    emitPresence?.({
      serverId: "server-1",
      updatedAt: "2026-08-19T10:00:00.000Z",
      members: [
        presenceMember("member-self", "person@example.com", "Person"),
        presenceMember("member-alice", "alice@example.com", "Alice"),
      ],
    });
    window.dispatchEvent(new Event("blur"));
    await fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
    vi.mocked(window.openbot.servers.markDirectRead)
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve;
          }),
      )
      .mockImplementation(async (input) => ({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughSequence: input.throughSequence,
      }));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(window.openbot.servers.markDirectRead).toHaveBeenCalledWith({
        memberId: "member-alice",
        throughSequence: 1,
      }),
    );
    window.dispatchEvent(new Event("blur"));
    emitDirectMessage?.({
      type: "team-direct-message",
      memberIds: ["member-alice", "member-self"],
      message: {
        id: "direct-stale-read-new",
        threadId: "thread-member-alice",
        senderMemberId: "member-alice",
        recipientMemberId: "member-self",
        text: "Private reply received after focus was lost",
        createdAt: "2026-08-19T10:01:00.000Z",
        sequence: 2,
      },
    });
    expect(await screen.findByText("Private reply received after focus was lost")).toBeInTheDocument();
    resolveFirstRead?.({ unreadCount: 0, firstUnreadMessageId: null, throughSequence: 1 });

    await waitFor(() => expect(screen.getByRole("status", { name: "1 new message" })).toBeInTheDocument());
    expect(window.openbot.servers.markDirectRead).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(window.openbot.servers.markDirectRead).toHaveBeenCalledWith({
        memberId: "member-alice",
        throughSequence: 2,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: /new messages?/ })).not.toBeInTheDocument());
  });

  it("shows and clears the unread boundary in a private conversation", async () => {
    vi.mocked(window.openbot.servers.readDirectConversation).mockResolvedValueOnce({
      threadId: "thread-member-alice",
      otherMemberId: "member-alice",
      revision: 1,
      readState: {
        unreadCount: 1,
        firstUnreadMessageId: "direct-new",
        throughSequence: 0,
      },
      messages: [
        {
          id: "direct-new",
          threadId: "thread-member-alice",
          senderMemberId: "member-alice",
          recipientMemberId: "member-self",
          text: "Private unseen message",
          createdAt: "2026-08-19T09:00:00.000Z",
          sequence: 1,
        },
      ],
    });
    render(() => <App peopleEnabled />);
    await screen.findByRole("heading", { name: "Chief" });
    emitPresence?.({
      serverId: "server-1",
      updatedAt: "2026-08-19T10:00:00.000Z",
      members: [
        presenceMember("member-self", "person@example.com", "Person"),
        presenceMember("member-alice", "alice@example.com", "Alice"),
      ],
    });
    window.dispatchEvent(new Event("blur"));
    await fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));

    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "New messages" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Jump to 1 new message" }));

    await waitFor(() =>
      expect(window.openbot.servers.markDirectRead).toHaveBeenCalledWith({
        memberId: "member-alice",
        throughSequence: 1,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
  });
});

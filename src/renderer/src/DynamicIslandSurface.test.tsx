import type { DynamicIslandPresentation } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamicIslandSurface } from "./DynamicIslandSurface";
import { createMockOpenBot } from "./preview/mock-openbot";

afterEach(() => vi.useRealTimers());

describe("DynamicIslandSurface", () => {
  it("keeps a new working presentation compact until hover intent", async () => {
    const mock = createMockOpenBot();
    let publish: ((presentation: DynamicIslandPresentation) => void) | undefined;
    mock.api.dynamicIsland.onPresentation = (listener) => {
      publish = listener;
      return () => {
        publish = undefined;
      };
    };
    Object.defineProperty(window, "openbot", { configurable: true, value: mock.api });
    render(() => <DynamicIslandSurface />);
    await waitFor(() => expect(publish).toBeDefined());
    vi.useFakeTimers();

    flush(() => {
      publish?.({
        serverId: "local",
        mode: "working",
        activeCount: 1,
        unreadCount: 0,
        attentionCount: 0,
        working: [
          {
            bot: { id: "chief", name: "Chief", avatarSeed: "chief", avatarHue: 215, avatarUrl: null },
            task: "Checking the release",
          },
        ],
        message: null,
        attention: [],
      });
    });
    expect(screen.queryByText("1 bot working")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand OpenBot working status" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await vi.advanceTimersByTimeAsync(7_000);
    expect(screen.queryByText("1 bot working")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand OpenBot working status" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    mock.dispose();
  });

  it("opens the selected message in the main OpenBot window", async () => {
    const mock = createMockOpenBot();
    const presentation: DynamicIslandPresentation = {
      serverId: "local",
      mode: "message",
      activeCount: 0,
      unreadCount: 1,
      attentionCount: 0,
      working: [],
      message: {
        bot: { id: "research", name: "Research", avatarSeed: "research", avatarHue: 215, avatarUrl: null },
        messageId: "reply-1",
        text: "The source check is ready.",
        createdAt: "2026-08-28T10:42:00.000Z",
      },
      attention: [],
    };
    const performAction = vi.fn(async () => undefined);
    mock.api.dynamicIsland.getPresentation = async () => presentation;
    mock.api.dynamicIsland.performAction = performAction;
    Object.defineProperty(window, "openbot", { configurable: true, value: mock.api });
    render(() => <DynamicIslandSurface />);

    await fireEvent.mouseEnter(await screen.findByRole("region", { name: "OpenBot chat update" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));

    await waitFor(() =>
      expect(performAction).toHaveBeenCalledWith({
        type: "open-message",
        serverId: "local",
        botId: "research",
        messageId: "reply-1",
      }),
    );
    mock.dispose();
  });

  it("sends a selected answer without opening the app", async () => {
    const mock = createMockOpenBot();
    const presentation: DynamicIslandPresentation = {
      serverId: "local",
      mode: "question",
      activeCount: 0,
      unreadCount: 0,
      attentionCount: 1,
      working: [],
      message: null,
      attention: [
        {
          id: "source-question",
          requestId: "source-question",
          bot: { id: "research", name: "Research", avatarSeed: "research", avatarHue: 215, avatarUrl: null },
          kind: "prompt",
          title: "Choose a source",
          detail: "Which source should I use?",
          options: [
            { label: "Official data", description: "Use the public dataset" },
            { label: "Industry report", description: "Use the detailed report" },
          ],
          questions: [
            {
              id: "source",
              header: "Choose a source",
              question: "Which source should I use?",
              isSecret: false,
              options: [
                { label: "Official data", description: "Use the public dataset" },
                { label: "Industry report", description: "Use the detailed report" },
              ],
            },
          ],
          approval: null,
        },
      ],
    };
    const performAction = vi.fn(async () => undefined);
    mock.api.dynamicIsland.getPresentation = async () => presentation;
    mock.api.dynamicIsland.performAction = performAction;
    Object.defineProperty(window, "openbot", { configurable: true, value: mock.api });
    render(() => <DynamicIslandSurface />);

    await fireEvent.mouseEnter(await screen.findByRole("region", { name: "OpenBot question from AI" }));
    const officialData = await screen.findByRole("button", { name: "Official data. Use the public dataset" });
    await fireEvent.click(officialData);
    await waitFor(() =>
      expect(performAction).toHaveBeenCalledWith({
        type: "answer-prompt",
        serverId: "local",
        botId: "research",
        requestId: "source-question",
        answers: { source: ["Official data"] },
      }),
    );
    mock.dispose();
  });

  it("collects multiple answers and sends them after the last question", async () => {
    const mock = createMockOpenBot();
    const presentation: DynamicIslandPresentation = {
      serverId: "local",
      mode: "question",
      activeCount: 0,
      unreadCount: 0,
      attentionCount: 1,
      working: [],
      message: null,
      attention: [
        {
          id: "research-questions",
          requestId: "research-questions",
          bot: { id: "research", name: "Research", avatarSeed: "research", avatarHue: 215, avatarUrl: null },
          kind: "prompt",
          title: "Choose a source",
          detail: "Which source should I use?",
          options: [
            { label: "Official data", description: "Use the public dataset" },
            { label: "Industry report", description: "Use the detailed report" },
          ],
          questions: [
            {
              id: "source",
              header: "Choose a source",
              question: "Which source should I use?",
              isSecret: false,
              options: [
                { label: "Official data", description: "Use the public dataset" },
                { label: "Industry report", description: "Use the detailed report" },
              ],
            },
            {
              id: "format",
              header: "Choose a format",
              question: "How should I present the result?",
              isSecret: false,
              options: [
                { label: "Short summary", description: "Lead with the conclusion" },
                { label: "Comparison table", description: "Show the sources side by side" },
              ],
            },
          ],
          approval: null,
        },
      ],
    };
    const performAction = vi.fn(async () => undefined);
    mock.api.dynamicIsland.getPresentation = async () => presentation;
    mock.api.dynamicIsland.performAction = performAction;
    Object.defineProperty(window, "openbot", { configurable: true, value: mock.api });
    render(() => <DynamicIslandSurface />);

    await fireEvent.mouseEnter(await screen.findByRole("region", { name: "OpenBot question from AI" }));
    await screen.findByRole("button", { name: "Official data. Use the public dataset" });
    await fireEvent.click(screen.getByRole("button", { name: "Official data. Use the public dataset" }));
    expect(await screen.findByText("How should I present the result?")).toBeVisible();
    expect(performAction).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("button", { name: "Comparison table. Show the sources side by side" }));
    await waitFor(() =>
      expect(performAction).toHaveBeenCalledWith({
        type: "answer-prompt",
        serverId: "local",
        botId: "research",
        requestId: "research-questions",
        answers: { source: ["Official data"], format: ["Comparison table"] },
      }),
    );
    mock.dispose();
  });

  it("keeps secret prompts in the full OpenBot flow", async () => {
    const mock = createMockOpenBot();
    const presentation: DynamicIslandPresentation = {
      serverId: "local",
      mode: "question",
      activeCount: 0,
      unreadCount: 0,
      attentionCount: 1,
      working: [],
      message: null,
      attention: [
        {
          id: "secret-question",
          requestId: "secret-question",
          bot: { id: "research", name: "Research", avatarSeed: "research", avatarHue: 215, avatarUrl: null },
          kind: "prompt",
          title: "Enter a token",
          detail: "Which token should I use?",
          options: null,
          questions: [
            {
              id: "token",
              header: "Enter a token",
              question: "Which token should I use?",
              isSecret: true,
              options: [{ label: "Saved token", description: "Use the stored credential" }],
            },
          ],
          approval: null,
        },
      ],
    };
    const performAction = vi.fn(async () => undefined);
    mock.api.dynamicIsland.getPresentation = async () => presentation;
    mock.api.dynamicIsland.performAction = performAction;
    Object.defineProperty(window, "openbot", { configurable: true, value: mock.api });
    render(() => <DynamicIslandSurface />);

    await fireEvent.mouseEnter(await screen.findByRole("region", { name: "OpenBot question from AI" }));
    await screen.findByRole("button", { name: "Answer in OpenBot" });

    expect(screen.queryByRole("button", { name: "Saved token. Use the stored credential" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Answer in OpenBot" }));
    await waitFor(() =>
      expect(performAction).toHaveBeenCalledWith({
        type: "review-attention",
        serverId: "local",
        botId: "research",
        requestId: "secret-question",
      }),
    );
    mock.dispose();
  });
});

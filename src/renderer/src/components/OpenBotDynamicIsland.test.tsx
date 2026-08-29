import type { DynamicIslandAction, DynamicIslandBotIdentity, DynamicIslandPresentation } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { OpenBotDynamicIsland } from "./OpenBotDynamicIsland";
import type { DynamicIslandViewState } from "./ui";

const BOT: DynamicIslandBotIdentity = {
  id: "research",
  name: "Research",
  avatarSeed: "research",
  avatarHue: 215,
  avatarUrl: null,
};

describe("OpenBotDynamicIsland mode transitions", () => {
  it("keeps an expanded island open and finishes with only the new interactive content", async () => {
    const controller = renderControlledIsland(workingPresentation(), "expanded");
    expect(screen.getByRole("button", { name: /Research/ })).toBeVisible();

    flush(() => controller.setPresentation(messagePresentation("reply-1")));

    expect(screen.getByRole("button", { name: "Collapse OpenBot chat update" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Open chat" })).toBeVisible());
    await waitFor(() => expect(screen.queryByRole("button", { name: /Research/ })).not.toBeInTheDocument());
  });

  it("makes outgoing controls inert as soon as the mode changes", () => {
    const controller = renderControlledIsland(workingPresentation(), "expanded");
    flush(() => controller.setPresentation(messagePresentation("reply-1")));

    const outgoingControl = document.querySelector<HTMLElement>(
      '[data-island-mode-slot="expanded"] > [data-island-mode-layer="outgoing"] button',
    );
    expect(outgoingControl).not.toBeNull();
    expect(outgoingControl?.closest("[inert]")).not.toBeNull();
  });

  it("ends a rapid series of updates and a return to idle on the newest mode", async () => {
    const controller = renderControlledIsland(workingPresentation(), "compact");

    flush(() => controller.setPresentation(messagePresentation("reply-1")));
    flush(() => controller.setPresentation(questionPresentation()));
    flush(() => controller.setPresentation(approvalPresentation()));
    flush(() => controller.setPresentation(idlePresentation()));

    await waitFor(() =>
      expect(document.querySelector('[data-island-mode-layer="incoming"][data-island-mode="idle"]')).not.toBeNull(),
    );
    await waitFor(() => expect(document.querySelector('[data-island-mode-layer="outgoing"]')).toBeNull());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open chat" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Official data/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("uses fresh data without retaining an outgoing layer for the same mode", async () => {
    const onAction = vi.fn<(action: DynamicIslandAction) => void>();
    const controller = renderControlledIsland(messagePresentation("reply-1"), "expanded", onAction);

    flush(() => controller.setPresentation(messagePresentation("reply-2")));
    await fireEvent.click(screen.getByRole("button", { name: "Open chat" }));

    expect(onAction).toHaveBeenCalledWith({
      type: "open-message",
      serverId: "local",
      botId: "research",
      messageId: "reply-2",
    });
    expect(document.querySelector('[data-island-mode-layer="outgoing"]')).toBeNull();
  });

  it("keeps the working row mounted while its task updates", async () => {
    const controller = renderControlledIsland(workingPresentation(), "expanded");
    const row = screen.getByRole("button", { name: /Research/ });
    row.focus();

    const next = workingPresentation();
    if (next.mode !== "working" || !next.working[0]) throw new Error("Working fixture is missing.");
    next.working[0] = { ...next.working[0], task: "Writing the summary" };
    flush(() => controller.setPresentation(next));

    expect(screen.getByText("Writing the summary")).toBeVisible();
    expect(screen.getByRole("button", { name: /Research/ })).toBe(row);
    expect(document.activeElement).toBe(row);
  });

  it("keeps message controls mounted while a message streams", () => {
    const controller = renderControlledIsland(messagePresentation("reply-1"), "expanded");
    const openChat = screen.getByRole("button", { name: "Open chat" });
    openChat.focus();

    const next = messagePresentation("reply-1");
    if (next.mode !== "message") throw new Error("Message fixture is missing.");
    next.message = { ...next.message, text: "The source check is ready with one more detail." };
    flush(() => controller.setPresentation(next));

    expect(screen.getByText("The source check is ready with one more detail.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open chat" })).toBe(openChat);
    expect(document.activeElement).toBe(openChat);
  });

  it("opens the full browser takeover context", async () => {
    const onAction = vi.fn<(action: DynamicIslandAction) => void>();
    renderControlledIsland(takeoverPresentation(), "expanded", onAction);

    await fireEvent.click(screen.getByRole("button", { name: "Take over" }));

    expect(onAction).toHaveBeenCalledWith({
      type: "review-attention",
      serverId: "local",
      botId: "research",
      requestId: "takeover-1",
    });
  });

  it("opens the failed task details", async () => {
    const onAction = vi.fn<(action: DynamicIslandAction) => void>();
    renderControlledIsland(failedPresentation(), "expanded", onAction);

    await fireEvent.click(screen.getByRole("button", { name: "Open details" }));

    expect(onAction).toHaveBeenCalledWith({
      type: "open-failure",
      serverId: "local",
      botId: "research",
      turnId: "turn-failed",
    });
  });

  it("opens the selected working bot", async () => {
    const onAction = vi.fn<(action: DynamicIslandAction) => void>();
    renderControlledIsland(workingPresentation(), "expanded", onAction);

    await fireEvent.click(screen.getByRole("button", { name: /Research/ }));

    expect(onAction).toHaveBeenCalledWith({ type: "open-bot", serverId: "local", botId: "research" });
  });

  it("opens approvals in the main app without authorizing hidden details", async () => {
    const onAction = vi.fn<(action: DynamicIslandAction) => void>();
    renderControlledIsland(approvalPresentation(), "expanded", onAction);

    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Review in OpenBot" }));

    expect(onAction).toHaveBeenCalledWith({
      type: "review-attention",
      serverId: "local",
      botId: "research",
      requestId: "approval-1",
    });
  });

  it("opens the main app from Idle", async () => {
    const onAction = vi.fn<(action: DynamicIslandAction) => void>();
    renderControlledIsland(idlePresentation(), "compact", onAction);

    await fireEvent.click(screen.getByRole("button", { name: "Expand Open OpenBot" }));

    expect(onAction).toHaveBeenCalledWith({ type: "open-app" });
  });

  it("requests feedback when an intermediate prompt answer advances the question", async () => {
    const onAction = vi.fn<(action: DynamicIslandAction) => void>();
    const onHaptic = vi.fn();
    const presentation = questionPresentation();
    presentation.item.questions.push({
      id: "format",
      header: "Choose a format",
      question: "How should I present it?",
      isSecret: false,
      options: [{ label: "Summary", description: "Keep it concise" }],
    });
    renderControlledIsland(presentation, "expanded", onAction, onHaptic);

    await fireEvent.click(screen.getByRole("button", { name: "Official data. Use the public dataset" }));

    expect(onHaptic).toHaveBeenCalledOnce();
    expect(onAction).not.toHaveBeenCalled();
    expect(await screen.findByText("How should I present it?")).toBeVisible();
  });
});

function renderControlledIsland(
  initialPresentation: DynamicIslandPresentation,
  initialState: DynamicIslandViewState,
  onAction: (action: DynamicIslandAction) => void = () => undefined,
  onHaptic: () => void = () => undefined,
) {
  let setPresentation: (presentation: DynamicIslandPresentation) => DynamicIslandPresentation = () =>
    initialPresentation;
  render(() => {
    const [presentation, updatePresentation] = createSignal(initialPresentation);
    const [state, setState] = createSignal(initialState);
    setPresentation = updatePresentation;
    return (
      <OpenBotDynamicIsland
        presentation={presentation()}
        state={state()}
        onStateChange={setState}
        onAction={onAction}
        onHaptic={onHaptic}
      />
    );
  });
  return { setPresentation };
}

function idlePresentation(): Extract<DynamicIslandPresentation, { mode: "idle" }> {
  return { serverId: "local", mode: "idle" };
}

function workingPresentation(): DynamicIslandPresentation {
  return {
    serverId: "local",
    mode: "working",
    working: [{ bot: BOT, task: "Checking sources" }],
  };
}

function messagePresentation(messageId: string): DynamicIslandPresentation {
  return {
    serverId: "local",
    mode: "message",
    unreadCount: 1,
    message: {
      bot: BOT,
      messageId,
      text: "The source check is ready.",
      createdAt: "2026-08-29T10:42:00.000Z",
    },
  };
}

function questionPresentation(): Extract<DynamicIslandPresentation, { mode: "question" }> {
  const options = [
    { label: "Official data", description: "Use the public dataset" },
    { label: "Industry report", description: "Use the detailed report" },
  ];
  return {
    serverId: "local",
    mode: "question",
    remainingCount: 0,
    item: {
      requestId: "source-question",
      bot: BOT,
      title: "Choose a source",
      detail: "Which source should I use?",
      questions: [
        {
          id: "source",
          header: "Choose a source",
          question: "Which source should I use?",
          isSecret: false,
          options,
        },
      ],
    },
  };
}

function approvalPresentation(): DynamicIslandPresentation {
  return {
    serverId: "local",
    mode: "approval",
    remainingCount: 0,
    item: {
      requestId: "approval-1",
      bot: BOT,
      title: "Command needs review",
      detail: "Install the locked dependencies.",
      approval: {
        kind: "command",
        command: "bun install --frozen-lockfile",
        cwd: "~/Projects/openbot",
        reason: "Install the locked dependencies.",
        grantRoot: null,
        permissions: null,
      },
    },
  };
}

function takeoverPresentation(): DynamicIslandPresentation {
  return {
    serverId: "local",
    mode: "takeover",
    item: {
      requestId: "takeover-1",
      bot: BOT,
      title: "Browser step needs you",
      detail: "Complete the sign-in, verification, or consent in the browser.",
    },
  };
}

function failedPresentation(): DynamicIslandPresentation {
  return {
    serverId: "local",
    mode: "failed",
    item: {
      turnId: "turn-failed",
      bot: BOT,
      title: "Task failed",
      detail: "The browser tab closed unexpectedly.",
    },
  };
}

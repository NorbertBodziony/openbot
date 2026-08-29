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

  it("ends a rapid series of updates on the newest mode", async () => {
    const controller = renderControlledIsland(workingPresentation(), "expanded");

    flush(() => controller.setPresentation(messagePresentation("reply-1")));
    flush(() => controller.setPresentation(questionPresentation()));
    flush(() => controller.setPresentation(approvalPresentation()));

    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeVisible());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open chat" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Official data/ })).not.toBeInTheDocument();
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
});

function renderControlledIsland(
  initialPresentation: DynamicIslandPresentation,
  initialState: DynamicIslandViewState,
  onAction: (action: DynamicIslandAction) => void = () => undefined,
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
        onLater={() => undefined}
      />
    );
  });
  return { setPresentation };
}

function basePresentation(): Omit<DynamicIslandPresentation, "mode"> {
  return {
    serverId: "local",
    activeCount: 0,
    unreadCount: 0,
    attentionCount: 0,
    working: [],
    message: null,
    attention: [],
  };
}

function workingPresentation(): DynamicIslandPresentation {
  return {
    ...basePresentation(),
    mode: "working",
    activeCount: 1,
    working: [{ bot: BOT, task: "Checking sources" }],
  };
}

function messagePresentation(messageId: string): DynamicIslandPresentation {
  return {
    ...basePresentation(),
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

function questionPresentation(): DynamicIslandPresentation {
  const options = [
    { label: "Official data", description: "Use the public dataset" },
    { label: "Industry report", description: "Use the detailed report" },
  ];
  return {
    ...basePresentation(),
    mode: "question",
    attentionCount: 1,
    attention: [
      {
        id: "source-question",
        requestId: "source-question",
        bot: BOT,
        kind: "prompt",
        title: "Choose a source",
        detail: "Which source should I use?",
        options,
        questions: [
          {
            id: "source",
            header: "Choose a source",
            question: "Which source should I use?",
            isSecret: false,
            options,
          },
        ],
        approval: null,
      },
    ],
  };
}

function approvalPresentation(): DynamicIslandPresentation {
  return {
    ...basePresentation(),
    mode: "approval",
    attentionCount: 1,
    attention: [
      {
        id: "approval-1",
        requestId: "approval-1",
        bot: BOT,
        kind: "approval",
        title: "Command needs review",
        detail: "Install the locked dependencies.",
        options: null,
        questions: null,
        approval: {
          kind: "command",
          command: "bun install --frozen-lockfile",
          cwd: "~/Projects/openbot",
          reason: "Install the locked dependencies.",
          grantRoot: null,
          permissions: null,
        },
      },
    ],
  };
}

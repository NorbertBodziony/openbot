import type {
  DynamicIslandAction,
  DynamicIslandAgentIdentity,
  DynamicIslandPresentation,
} from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { OpenBotDynamicIsland } from "./OpenBotDynamicIsland";
import type { DynamicIslandViewState } from "./ui";

const AGENT: DynamicIslandAgentIdentity = {
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
    // The stale mode layer stays mounted through the swap animation
    // (OpenBotDynamicIsland.tsx:570-577), so inert is what stops its buttons
    // from being focusable and clickable while the new mode is on screen.
    // The remaining tests only cover the layer eventually going away.
    const controller = renderControlledIsland(workingPresentation(), "expanded");
    flush(() => controller.setPresentation(messagePresentation("reply-1")));

    const staleControl = screen.getAllByRole("button", { hidden: true }).find((button) => button.closest("[inert]"));
    expect(staleControl).toBeDefined();
    expect(screen.getByRole("button", { name: "Open chat" }).closest("[inert]")).toBeNull();
  });

  it("ends a rapid series of updates and a return to idle on the newest mode", async () => {
    const controller = renderControlledIsland(workingPresentation(), "compact");

    flush(() => controller.setPresentation(messagePresentation("reply-1")));
    flush(() => controller.setPresentation(questionPresentation()));
    flush(() => controller.setPresentation(approvalPresentation()));
    flush(() => controller.setPresentation(idlePresentation()));

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
      agentId: "research",
      messageId: "reply-2",
    });
  });

  it("reviews, accepts, or declines approvals", async () => {
    const onAction = vi.fn<(action: DynamicIslandAction) => void>();
    renderControlledIsland(approvalPresentation(), "expanded", onAction);

    await fireEvent.click(screen.getByRole("button", { name: "Review in OpenBot" }));
    expect(onAction).toHaveBeenCalledWith({
      type: "review-attention",
      serverId: "local",
      agentId: "research",
      requestId: "approval-1",
    });

    await fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onAction).toHaveBeenCalledWith({
      type: "respond-approval",
      serverId: "local",
      agentId: "research",
      requestId: "approval-1",
      decision: "decline",
    });

    await fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onAction).toHaveBeenCalledWith({
      type: "respond-approval",
      serverId: "local",
      agentId: "research",
      requestId: "approval-1",
      decision: "accept",
    });
  });

  it("requires opening OpenBot before approving truncated requests", () => {
    const presentation = approvalPresentation();
    presentation.item.truncated = true;
    renderControlledIsland(presentation, "expanded", vi.fn());

    expect(screen.getByRole("button", { name: "Review in OpenBot" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
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
    working: [{ agent: AGENT, task: "Checking sources" }],
  };
}

function messagePresentation(messageId: string): DynamicIslandPresentation {
  return {
    serverId: "local",
    mode: "message",
    unreadCount: 1,
    message: {
      agent: AGENT,
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
      agent: AGENT,
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

function approvalPresentation(): Extract<DynamicIslandPresentation, { mode: "approval" }> {
  return {
    serverId: "local",
    mode: "approval",
    remainingCount: 0,
    item: {
      requestId: "approval-1",
      agent: AGENT,
      title: "Command needs review",
      detail: "Install the locked dependencies.",
      truncated: false,
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

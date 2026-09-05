import type {
  DynamicIslandPreference,
  DynamicIslandPresentation,
  DynamicIslandQuestionItem,
} from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockOpenBot } from "../../preview/mock-openbot";
import { DynamicIslandSurface } from "./DynamicIslandSurface";

const RESEARCH = {
  id: "research",
  name: "Research",
  avatarSeed: "research",
  avatarHue: 215 as const,
  avatarUrl: null,
};
const SOURCE_OPTIONS = [
  { label: "Official data", description: "Use the public dataset" },
  { label: "Industry report", description: "Use the detailed report" },
];

afterEach(() => vi.useRealTimers());

describe("DynamicIslandSurface", () => {
  it("hides only the idle island when that preference changes", async () => {
    const mock = createMockOpenBot();
    let updatePreference: ((preference: DynamicIslandPreference) => void) | undefined;
    let publish: ((presentation: DynamicIslandPresentation) => void) | undefined;
    mock.api.dynamicIsland.onPreference = (listener) => {
      updatePreference = listener;
      return () => {
        updatePreference = undefined;
      };
    };
    mock.api.dynamicIsland.onPresentation = (listener) => {
      publish = listener;
      return () => {
        publish = undefined;
      };
    };
    Object.defineProperty(window, "openbot", { configurable: true, value: mock.api });
    render(() => <DynamicIslandSurface />);

    expect(await screen.findByRole("button", { name: "Expand Open OpenBot" })).toBeVisible();
    flush(() =>
      updatePreference?.({
        enabled: true,
        hapticsEnabled: true,
        idleVisible: false,
        additionalDisplaysEnabled: true,
      }),
    );
    expect(screen.queryByRole("button", { name: "Expand Open OpenBot" })).not.toBeInTheDocument();

    flush(() => publish?.({ serverId: "local", mode: "working", working: [] }));
    expect(screen.getByRole("button", { name: "Expand OpenBot working status" })).toBeVisible();
    mock.dispose();
  });

  it("collects multiple answers and sends them after the last question", async () => {
    const formatQuestion: DynamicIslandQuestionItem = {
      id: "format",
      header: "Choose a format",
      question: "How should I present the result?",
      isSecret: false,
      options: [
        { label: "Short summary", description: "Lead with the conclusion" },
        { label: "Comparison table", description: "Show the sources side by side" },
      ],
    };
    const mock = createQuestionMock(questionPresentation("research-questions", [sourceQuestion(), formatQuestion]));
    render(() => <DynamicIslandSurface />);

    await fireEvent.mouseEnter(await screen.findByRole("region", { name: "OpenBot question from AI" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Official data. Use the public dataset" }));
    expect(await screen.findByText("How should I present the result?")).toBeVisible();
    expect(mock.performAction).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("button", { name: "Comparison table. Show the sources side by side" }));
    await waitFor(() =>
      expect(mock.performAction).toHaveBeenCalledWith({
        type: "answer-prompt",
        serverId: "local",
        agentId: "research",
        requestId: "research-questions",
        answers: { source: ["Official data"], format: ["Comparison table"] },
      }),
    );
    mock.dispose();
  });

  it("keeps secret prompts in the full OpenBot flow", async () => {
    const secretQuestion: DynamicIslandQuestionItem = {
      id: "token",
      header: "Enter a token",
      question: "Which token should I use?",
      isSecret: true,
      options: [{ label: "Saved token", description: "Use the stored credential" }],
    };
    const presentation = questionPresentation(
      "secret-question",
      [secretQuestion],
      "Enter a token",
      "Which token should I use?",
    );
    const mock = createQuestionMock(presentation);
    render(() => <DynamicIslandSurface />);

    await fireEvent.mouseEnter(await screen.findByRole("region", { name: "OpenBot question from AI" }));
    await screen.findByRole("button", { name: "Answer in OpenBot" });

    expect(screen.queryByRole("button", { name: "Saved token. Use the stored credential" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Answer in OpenBot" }));
    await waitFor(() =>
      expect(mock.performAction).toHaveBeenCalledWith({
        type: "review-attention",
        serverId: "local",
        agentId: "research",
        requestId: "secret-question",
      }),
    );
    mock.dispose();
  });

  it("does not replace a critical presentation while the pointer is inside", async () => {
    const mock = createQuestionMock(questionPresentation("question-locked", [sourceQuestion()]));
    let publish: ((presentation: DynamicIslandPresentation) => void) | undefined;
    mock.api.dynamicIsland.onPresentation = (listener) => {
      publish = listener;
      return () => {
        publish = undefined;
      };
    };
    render(() => <DynamicIslandSurface />);
    await screen.findByRole("region", { name: "OpenBot question from AI" });
    const anchor = screen.getByRole("group", { name: "Dynamic Island interaction area" });
    await fireEvent.mouseOver(anchor);

    flush(() => publish?.(approvalPresentation("approval-queued")));
    expect(screen.getByRole("region", { name: "OpenBot question from AI" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "OpenBot approval needed" })).not.toBeInTheDocument();

    await fireEvent.mouseOut(anchor);
    expect(await screen.findByRole("region", { name: "OpenBot approval request" })).toBeVisible();
    mock.dispose();
  });

  it("releases a queued critical presentation when keyboard focus leaves the collapsed panel", async () => {
    const mock = createQuestionMock(questionPresentation("question-keyboard", [sourceQuestion()]));
    let publish: ((presentation: DynamicIslandPresentation) => void) | undefined;
    mock.api.dynamicIsland.onPresentation = (listener) => {
      publish = listener;
      return () => {
        publish = undefined;
      };
    };
    render(() => <DynamicIslandSurface />);

    const expand = await screen.findByRole("button", { name: "Expand OpenBot question from AI" });
    expand.focus();
    await fireEvent.click(expand, { detail: 0 });
    expect(screen.getByRole("button", { name: "Collapse OpenBot question from AI" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    flush(() => publish?.(approvalPresentation("approval-after-keyboard")));
    expect(screen.getByRole("region", { name: "OpenBot question from AI" })).toBeVisible();

    const collapse = screen.getByRole("button", { name: "Collapse OpenBot question from AI" });
    await fireEvent.click(collapse, { detail: 0 });
    expect(screen.getByRole("region", { name: "OpenBot question from AI" })).toBeVisible();

    await fireEvent.focusOut(collapse, { relatedTarget: document.body });
    expect(await screen.findByRole("region", { name: "OpenBot approval request" })).toBeVisible();
    mock.dispose();
  });

  it("keeps a critical panel open when its direct action fails", async () => {
    const mock = createQuestionMock(questionPresentation("question-failed", [sourceQuestion()]));
    mock.performAction.mockRejectedValueOnce(new Error("The request is no longer active."));
    render(() => <DynamicIslandSurface />);

    await fireEvent.mouseEnter(await screen.findByRole("region", { name: "OpenBot question from AI" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Official data. Use the public dataset" }));

    await waitFor(() => expect(mock.performAction).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Collapse OpenBot question from AI" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    mock.dispose();
  });
});

function sourceQuestion(): DynamicIslandQuestionItem {
  return {
    id: "source",
    header: "Choose a source",
    question: "Which source should I use?",
    isSecret: false,
    options: SOURCE_OPTIONS,
  };
}

function questionPresentation(
  requestId: string,
  questions: DynamicIslandQuestionItem[],
  title = "Choose a source",
  detail = "Which source should I use?",
): DynamicIslandPresentation {
  return {
    serverId: "local",
    mode: "question",
    remainingCount: 0,
    item: { requestId, agent: RESEARCH, title, detail, questions },
  };
}

function createQuestionMock(presentation: DynamicIslandPresentation) {
  const mock = createMockOpenBot();
  const performAction = vi.fn(async () => undefined);
  mock.api.dynamicIsland.getPresentation = async () => presentation;
  mock.api.dynamicIsland.performAction = performAction;
  Object.defineProperty(window, "openbot", { configurable: true, value: mock.api });
  return { ...mock, performAction };
}

function approvalPresentation(requestId: string): DynamicIslandPresentation {
  return {
    serverId: "remote",
    mode: "approval",
    remainingCount: 0,
    item: {
      requestId,
      agent: RESEARCH,
      title: "Command needs review",
      detail: "Run the test suite.",
      truncated: false,
      approval: {
        kind: "command",
        command: "bun test",
        cwd: "/workspace",
        reason: "Run the test suite.",
        grantRoot: null,
        permissions: null,
      },
    },
  };
}

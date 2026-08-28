import type { AgentPromptQuestion } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { QuestionPromptBubble } from "./QuestionPromptBubble";

const questions: AgentPromptQuestion[] = [
  {
    id: "approach",
    header: "Approach",
    question: "Which approach should we use?",
    isSecret: false,
    options: [
      { label: "Session cookies", description: "Use the desktop session." },
      { label: "Bearer token", description: "Manage a separate token." },
    ],
  },
  {
    id: "rollout",
    header: "Rollout",
    question: "How should we release it?",
    isSecret: false,
    options: [
      { label: "Gradually", description: "Start with a small group." },
      { label: "At once", description: "Enable it for everyone." },
    ],
  },
];
const singleQuestion = questions.slice(0, 1);

describe("QuestionPromptBubble", () => {
  it("advances after a choice and submits after the final answer", async () => {
    const onSubmit = vi.fn(async () => true);
    render(() => <QuestionPromptBubble questions={questions} onSubmit={onSubmit} />);

    await fireEvent.click(screen.getByRole("radio", { name: /Session cookies/ }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Gradually/ })).toBeEnabled());
    expect(onSubmit).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("radio", { name: /Gradually/ }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ approach: ["Session cookies"], rollout: ["Gradually"] }),
    );
    await waitFor(() => expect(screen.getByRole("region", { name: "Answers sent" })).toBeVisible());
    expect(screen.getByRole("status")).toHaveTextContent("Answers sent");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("retries the selected option when the first delivery fails", async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(() => <QuestionPromptBubble questions={singleQuestion} onSubmit={onSubmit} />);

    const option = screen.getByRole("radio", { name: /Session cookies/ });
    await fireEvent.click(option);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(option).toBeChecked();

    await fireEvent.click(option);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenLastCalledWith({ approach: ["Session cookies"] });
  });

  it("presents a successful resolution when the bubble unmounts during its transition", async () => {
    const onResolutionPresented = vi.fn();
    const view = render(() => (
      <QuestionPromptBubble
        questions={singleQuestion}
        onSubmit={vi.fn(async () => true)}
        onResolutionPresented={onResolutionPresented}
      />
    ));

    await fireEvent.click(screen.getByRole("radio", { name: /Session cookies/ }));
    await screen.findByRole("region", { name: "Answers sent" });
    view.unmount();

    expect(onResolutionPresented).toHaveBeenCalledOnce();
  });

  it("returns to the first unresolved question before submitting", async () => {
    const onSubmit = vi.fn(async () => true);
    render(() => <QuestionPromptBubble questions={questions} onSubmit={onSubmit} />);

    await fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Gradually/ })).toBeEnabled());
    await fireEvent.click(screen.getByRole("radio", { name: /Gradually/ }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Session cookies/ })).toBeEnabled());
    expect(onSubmit).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("radio", { name: /Session cookies/ }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ approach: ["Session cookies"], rollout: ["Gradually"] }),
    );
  });

  it("keeps selected answers and custom drafts during navigation", async () => {
    render(() => <QuestionPromptBubble questions={questions} onSubmit={vi.fn(async () => false)} />);

    const firstDraft = screen.getByRole("textbox", { name: /Custom answer for: Which approach/ });
    await fireEvent.input(firstDraft, { target: { value: "Keep this draft" } });
    await fireEvent.click(screen.getByRole("radio", { name: /Session cookies/ }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Gradually/ })).toBeEnabled());

    await fireEvent.click(screen.getByRole("button", { name: "Previous question" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Session cookies/ })).toBeEnabled());
    expect(screen.getByRole("radio", { name: /Session cookies/ })).toBeChecked();
    expect(screen.getByRole("textbox", { name: /Custom answer for: Which approach/ })).toHaveValue("Keep this draft");
  });

  it("records a skipped question with an empty answer array", async () => {
    const onSubmit = vi.fn(async () => true);
    render(() => <QuestionPromptBubble questions={questions} onSubmit={onSubmit} />);

    await fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Gradually/ })).toBeEnabled());
    await fireEvent.click(screen.getByRole("radio", { name: /Gradually/ }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ approach: [], rollout: ["Gradually"] }));
    await waitFor(() => expect(screen.getByText("Skipped")).toBeVisible());
  });

  it("cancels the complete prompt with an empty answer map", async () => {
    const onSubmit = vi.fn(async () => true);
    render(() => <QuestionPromptBubble questions={questions} onSubmit={onSubmit} />);

    await fireEvent.click(screen.getByRole("button", { name: "Cancel questions" }));
    expect(onSubmit).toHaveBeenCalledWith({});
  });

  it("submits a custom answer with Enter", async () => {
    const onSubmit = vi.fn(async () => true);
    const customQuestion: AgentPromptQuestion[] = [
      {
        id: "outcome",
        header: "Outcome",
        question: "What should the agent produce?",
        isSecret: false,
        options: null,
      },
    ];
    render(() => <QuestionPromptBubble questions={customQuestion} onSubmit={onSubmit} />);

    const input = screen.getByRole("textbox", { name: /Custom answer/ });
    await fireEvent.input(input, { target: { value: "A working prototype" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ outcome: ["A working prototype"] }));
  });

  it("blocks all prompt interaction while an answer is pending", async () => {
    const onSubmit = vi.fn(async () => true);
    render(() => <QuestionPromptBubble questions={questions} pending onSubmit={onSubmit} />);

    expect(screen.getByRole("status")).toHaveTextContent("Sending");
    expect(screen.getByRole("button", { name: "Previous question" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next question" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel questions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Skip" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Session cookies/ })).toBeDisabled();
    await fireEvent.click(screen.getByRole("radio", { name: /Session cookies/ }));
    expect(screen.getByRole("heading", { name: "Which approach should we use?" })).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders a persisted resolution without interactive controls", () => {
    render(() => (
      <QuestionPromptBubble
        questions={questions}
        resolution={{
          status: "answered",
          responses: {
            approach: { status: "answered", answers: ["Session cookies"] },
            rollout: { status: "skipped" },
          },
        }}
        onSubmit={vi.fn(async () => false)}
      />
    ));

    expect(screen.getByRole("region", { name: "Answers sent" })).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByText("Skipped")).toBeVisible();
  });
});

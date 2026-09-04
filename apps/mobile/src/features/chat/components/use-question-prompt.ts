import type { AgentPromptResolution, RespondToPromptInput } from "@openbot/contracts/ipc";
import { useRef, useState } from "react";
import type { ChatMessage } from "@/features/chat/model/chat-messages";
import { answeredPromptResolution, nextUnansweredQuestion } from "@/features/chat/model/question-prompt";

interface PromptState {
  scope: string;
  index: number;
  answers: Record<string, string[]>;
  drafts: Record<string, string>;
  pending: boolean;
  failedAnswers: Record<string, string[]> | null;
  resolution: AgentPromptResolution | null;
}

function initialState(scope: string): PromptState {
  return { scope, index: 0, answers: {}, drafts: {}, pending: false, failedAnswers: null, resolution: null };
}

export function useQuestionPrompt(
  botId: string,
  message: Extract<ChatMessage, { kind: "question" }> | undefined,
  canSend: boolean,
  respond: (botId: string, input: RespondToPromptInput) => Promise<void>,
) {
  const scope = JSON.stringify([botId, message?.id]);
  const [stored, setState] = useState(() => initialState(scope));
  // A new form never inherits drafts (especially private answers) from its predecessor.
  const state = stored.scope === scope ? stored : initialState(scope);
  if (stored.scope !== scope) setState(state);
  const submitting = useRef(new Set<string>());
  const prompt = message?.prompt;
  const resolution = prompt?.resolution ?? state.resolution;
  const question = resolution ? undefined : prompt?.questions[state.index];
  const disabled = !canSend || state.pending || Boolean(resolution) || !prompt;

  function update(change: Partial<PromptState>): void {
    setState((current) => (current.scope === scope ? { ...current, ...change } : current));
  }

  async function submit(answers: Record<string, string[]>): Promise<void> {
    if (disabled || !prompt || submitting.current.has(scope)) return;
    submitting.current.add(scope);
    update({ pending: true, failedAnswers: null });
    try {
      await respond(botId, { requestId: prompt.requestId, answers });
      update({ resolution: answeredPromptResolution(prompt.questions, answers), answers: {}, drafts: {} });
    } catch {
      update({ failedAnswers: answers });
    } finally {
      submitting.current.delete(scope);
      update({ pending: false });
    }
  }

  function answer(values: string[]): void {
    if (disabled || !question || !prompt || submitting.current.has(scope)) return;
    const answers = { ...state.answers, [question.id]: values };
    const next = nextUnansweredQuestion(prompt.questions, answers, state.index);
    update({
      answers,
      drafts: { ...state.drafts, [question.id]: "" },
      failedAnswers: null,
      index: next ?? state.index,
    });
    if (next === null) void submit(answers);
  }

  return {
    messageId: message?.id,
    index: state.index,
    question,
    resolution,
    disabled,
    pending: state.pending,
    failedAnswers: state.failedAnswers,
    draft: question ? (state.drafts[question.id] ?? "") : "",
    setDraft: (text: string) => {
      if (question && !disabled) update({ drafts: { ...state.drafts, [question.id]: text } });
    },
    setIndex: (index: number) => {
      if (!disabled && prompt?.questions[index]) update({ index });
    },
    answer,
    submit,
  };
}

export type QuestionPromptController = ReturnType<typeof useQuestionPrompt>;

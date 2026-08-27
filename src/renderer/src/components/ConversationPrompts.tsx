import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AgentApproval, AgentPromptQuestion } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { Button, Input, LogIn, RadioGroup } from "./ui";

export function ChoiceCard(props: {
  title: string;
  hint?: string;
  choices: string[];
  customChoice?: string;
  pending?: boolean;
  onSubmit: (answer: string) => Promise<boolean>;
}) {
  const [answer, setAnswer] = createSignal("");
  const [customSelected, setCustomSelected] = createSignal(false);
  let customInput: HTMLInputElement | undefined;
  const selectedChoice = () => (customSelected() ? (props.customChoice ?? "") : answer());
  const submit = async () => {
    const value = answer().trim();
    if (value && !props.pending) await props.onSubmit(value);
  };
  return (
    <div class="choice-card">
      <div class="choice-card-heading">
        <div>
          <strong>{props.title}</strong>
          <span>{props.hint ?? "Pick whatever fits, or type your own."}</span>
        </div>
      </div>
      <RadioGroup.Root
        class="choice-options"
        aria-label={props.title}
        value={selectedChoice()}
        disabled={props.pending}
        onChange={(choice) => {
          if (choice === props.customChoice) {
            setAnswer("");
            setCustomSelected(true);
            queueMicrotask(() => customInput?.focus());
            return;
          }
          setCustomSelected(false);
          setAnswer(choice);
          void props.onSubmit(choice);
        }}
      >
        <For each={props.choices}>
          {(choice, index) => (
            <RadioGroup.Item class="choice-option-item" value={choice} disabled={props.pending}>
              <RadioGroup.ItemInput aria-label={choice} />
              <RadioGroup.ItemControl
                class={[
                  "choice-option",
                  {
                    "choice-option-selected": choice === props.customChoice ? customSelected() : answer() === choice,
                  },
                ]}
              >
                <span class="choice-key">{String.fromCharCode(65 + index())}</span>
                <span>{choice}</span>
              </RadioGroup.ItemControl>
            </RadioGroup.Item>
          )}
        </For>
      </RadioGroup.Root>
      <Input
        ref={(element) => (customInput = element)}
        class="choice-input"
        value={answer()}
        placeholder="Type your own answer"
        aria-label="Custom answer"
        maxlength={INPUT_LIMITS.promptAnswerText}
        disabled={props.pending}
        onValueChange={(value) => {
          setCustomSelected(true);
          setAnswer(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
        }}
      />
    </div>
  );
}

export function ApprovalCard(props: {
  variant: "questions" | "approval";
  questions?: AgentPromptQuestion[];
  approval?: AgentApproval;
  onSubmit?: (answers: Record<string, string[]>) => Promise<boolean>;
  onApprove?: () => Promise<boolean>;
  onReject?: () => Promise<boolean>;
}) {
  const [step, setStep] = createSignal(0);
  const [answers, setAnswers] = createSignal<Record<string, string>>({});
  const [customSelected, setCustomSelected] = createSignal<Record<string, boolean>>({});
  const [customEditing, setCustomEditing] = createSignal<Record<string, boolean>>({});
  const [submitting, setSubmitting] = createSignal(false);
  let customInput: HTMLInputElement | undefined;

  const currentQuestion = createMemo(() => props.questions?.[step()]);
  const currentAnswer = createMemo(() => {
    const question = currentQuestion();
    return question ? (answers()[question.id] ?? "").trim() : "";
  });
  const questionCount = () => props.questions?.length ?? 0;
  const canAdvance = () => Boolean(currentAnswer()) && !submitting();

  const setAnswer = (question: AgentPromptQuestion, answer: string, custom = false) => {
    setAnswers((current) => ({ ...current, [question.id]: answer }));
    setCustomSelected((current) => ({ ...current, [question.id]: custom }));
    if (!custom) {
      setCustomEditing((current) => ({ ...current, [question.id]: false }));
    }
  };

  createEffect(
    () => ({ question: currentQuestion(), editing: customEditing()[currentQuestion()?.id ?? ""] }),
    ({ question, editing }) => {
      if (question && editing) customInput?.focus();
    },
  );

  const submitQuestions = async (skip = false) => {
    if (submitting() || !props.onSubmit) return;
    const questions = props.questions ?? [];
    const result = skip
      ? {}
      : Object.fromEntries(questions.map((question) => [question.id, [answers()[question.id]?.trim() ?? ""]]));
    if (!skip && Object.values(result).some((value) => !value[0])) return;
    setSubmitting(true);
    const completed = await props.onSubmit(result);
    if (!completed) setSubmitting(false);
  };

  const submitApproval = async (decision: "accept" | "decline") => {
    if (submitting()) return;
    const handler = decision === "accept" ? props.onApprove : props.onReject;
    if (!handler) return;
    setSubmitting(true);
    const completed = await handler();
    if (!completed) setSubmitting(false);
  };

  return (
    <section
      class={["approval-card", `approval-card-${props.variant}`]}
      aria-label={props.variant === "questions" ? "Agent questions" : "Agent approval"}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || props.variant !== "questions" || !canAdvance()) return;
        if (!(event.target instanceof HTMLElement)) return;
        const target = event.target;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        event.preventDefault();
        if (step() === questionCount() - 1) void submitQuestions();
        else setStep((current) => Math.min(current + 1, questionCount() - 1));
      }}
    >
      <header class="approval-card-header">
        <span class="approval-card-icon" data-kind={props.variant}>
          <CardIcon variant={props.variant} />
        </span>
        <div>
          <strong>{props.variant === "questions" ? "Questions" : approvalTitle(props.approval)}</strong>
        </div>
      </header>

      <Show when={props.variant === "questions"}>
        <div class="approval-questions-viewport" aria-live="polite">
          <Show when={currentQuestion()} fallback={<p class="approval-card-empty">No questions are waiting.</p>}>
            {(question) => (
              <div class="approval-question">
                <div class="approval-question-prompt">{question().question}</div>
                <fieldset class="approval-options">
                  <legend class="sr-only">{question().question}</legend>
                  <For each={question().options ?? []}>
                    {(option, index) => (
                      <Button
                        variant="ghost"
                        type="button"
                        aria-pressed={
                          answers()[question().id] === option.label && !customSelected()[question().id]
                            ? "true"
                            : "false"
                        }
                        class={[
                          "approval-option",
                          {
                            "approval-option-selected":
                              answers()[question().id] === option.label && !customSelected()[question().id],
                          },
                        ]}
                        disabled={submitting()}
                        onClick={() => setAnswer(question(), option.label)}
                      >
                        <span class="approval-option-key">{String.fromCharCode(65 + index())}</span>
                        <span>
                          <strong>{option.label}</strong>
                          <Show when={option.description}>
                            <small>{option.description}</small>
                          </Show>
                        </span>
                      </Button>
                    )}
                  </For>
                  <Show
                    when={customEditing()[question().id]}
                    fallback={
                      <Button
                        variant="ghost"
                        type="button"
                        class={[
                          "approval-custom-option",
                          {
                            "approval-option-selected": customSelected()[question().id],
                          },
                        ]}
                        aria-pressed={customSelected()[question().id] ? "true" : "false"}
                        disabled={submitting()}
                        onClick={() => {
                          setCustomSelected((current) => ({ ...current, [question().id]: true }));
                          setCustomEditing((current) => ({ ...current, [question().id]: true }));
                        }}
                      >
                        <span class="approval-custom-icon">
                          <PencilIcon />
                        </span>
                        <span class="approval-custom-label">{answers()[question().id] || "Something else…"}</span>
                      </Button>
                    }
                  >
                    <label
                      class={[
                        "approval-custom-option",
                        "approval-custom-option-editing",
                        {
                          "approval-option-selected": customSelected()[question().id],
                          "approval-custom-option-disabled": submitting(),
                        },
                      ]}
                    >
                      <span class="approval-custom-icon">
                        <PencilIcon />
                      </span>
                      <Input
                        ref={(element) => (customInput = element)}
                        type={question().isSecret ? "password" : "text"}
                        value={answers()[question().id] ?? ""}
                        placeholder="Something else…"
                        aria-label={`Custom answer for: ${question().question}`}
                        maxlength={INPUT_LIMITS.promptAnswerText}
                        disabled={submitting()}
                        onKeyDown={(event) => event.stopPropagation()}
                        onValueChange={(value) => setAnswer(question(), value, true)}
                      />
                    </label>
                  </Show>
                </fieldset>
              </div>
            )}
          </Show>
        </div>
        <footer class="approval-card-footer">
          <nav class="approval-question-nav" aria-label={`Question ${step() + 1} of ${questionCount()}`}>
            <Button
              variant="ghost"
              type="button"
              class="approval-icon-button"
              aria-label="Previous question"
              disabled={step() === 0 || submitting()}
              onClick={() => setStep((current) => Math.max(0, current - 1))}
            >
              <ArrowIcon direction="left" />
            </Button>
            <span>{step() + 1}</span>
            <span class="approval-question-divider">/</span>
            <span>{questionCount()}</span>
            <Button
              variant="ghost"
              type="button"
              class="approval-icon-button"
              aria-label="Next question"
              disabled={step() >= questionCount() - 1 || !canAdvance()}
              onClick={() => setStep((current) => Math.min(current + 1, questionCount() - 1))}
            >
              <ArrowIcon direction="right" />
            </Button>
          </nav>
          <div class="approval-card-actions">
            <Button
              variant="ghost"
              type="button"
              class="approval-button approval-button-ghost"
              disabled={submitting()}
              onClick={() => void submitQuestions(true)}
            >
              Skip
            </Button>
            <Button
              variant="default"
              type="button"
              class="approval-button approval-button-primary"
              disabled={!canAdvance()}
              onClick={() => {
                if (step() === questionCount() - 1) void submitQuestions();
                else setStep((current) => Math.min(current + 1, questionCount() - 1));
              }}
            >
              {submitting() ? "Sending…" : step() === questionCount() - 1 ? "Continue" : "Next"}
              <ReturnIcon />
            </Button>
          </div>
        </footer>
      </Show>

      <Show when={props.variant === "approval" && props.approval}>
        {(approval) => (
          <>
            <div class="approval-card-content">
              <Show when={approval().command}>
                {(command) => (
                  <div class="approval-command-block">
                    <Show when={approval().cwd}>
                      <div class="approval-cwd">{approval().cwd}</div>
                    </Show>
                    <code>{command()}</code>
                  </div>
                )}
              </Show>
              <Show when={approval().kind === "file-change"}>
                <div class="approval-detail-row">
                  <span class="approval-detail-label">Files</span>
                  <strong>{approval().grantRoot ?? "Agent workspace"}</strong>
                </div>
              </Show>
              <Show when={approval().kind === "permissions"}>
                <PermissionDetails permissions={approval().permissions} />
              </Show>
              <Show when={approval().reason}>{(reason) => <p class="approval-reason">{reason()}</p>}</Show>
            </div>
            <footer class="approval-card-footer approval-card-footer-end">
              <div class="approval-card-actions">
                <Button
                  variant="ghost"
                  type="button"
                  class="approval-button approval-button-ghost"
                  disabled={submitting()}
                  onClick={() => void submitApproval("decline")}
                >
                  {submitting() ? "Waiting…" : "Reject"}
                </Button>
                <Button
                  variant="default"
                  type="button"
                  class="approval-button approval-button-primary"
                  disabled={submitting()}
                  onClick={() => void submitApproval("accept")}
                >
                  {submitting() ? "Sending…" : "Approve"}
                  <ReturnIcon />
                </Button>
              </div>
            </footer>
          </>
        )}
      </Show>
    </section>
  );
}

export function BrowserTakeoverCard(props: { onComplete: () => Promise<boolean>; onCancel: () => Promise<boolean> }) {
  const [submitting, setSubmitting] = createSignal(false);
  const submit = async (decision: "complete" | "cancel") => {
    if (submitting()) return;
    setSubmitting(true);
    const completed = await (decision === "complete" ? props.onComplete() : props.onCancel());
    if (!completed) setSubmitting(false);
  };

  return (
    <section class="approval-card approval-card-takeover" aria-label="Browser takeover">
      <header class="approval-card-header">
        <span class="approval-card-icon" data-kind="takeover">
          <LogIn aria-hidden="true" />
        </span>
        <div>
          <strong>Take over</strong>
        </div>
      </header>
      <div class="approval-card-content">
        <p class="approval-reason">Complete the authorization in the open browser, then let the agent continue.</p>
      </div>
      <footer class="approval-card-footer approval-card-footer-end">
        <div class="approval-card-actions">
          <Button
            variant="ghost"
            type="button"
            class="approval-button approval-button-ghost"
            disabled={submitting()}
            onClick={() => void submit("cancel")}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            type="button"
            class="approval-button approval-button-primary"
            disabled={submitting()}
            onClick={() => void submit("complete")}
          >
            {submitting() ? "Returning…" : "Done"}
            <ReturnIcon />
          </Button>
        </div>
      </footer>
    </section>
  );
}

function approvalTitle(approval: AgentApproval | undefined) {
  if (approval?.kind === "command") return "Run this command?";
  if (approval?.kind === "file-change") return "Approve file changes?";
  return "Grant permissions?";
}

function PermissionDetails(props: { permissions: AgentApproval["permissions"] }) {
  const details = createMemo(() => {
    const permissions = props.permissions;
    if (!permissions) return [];
    return [
      ...(permissions.network ? ["Network access"] : []),
      ...permissions.fileSystem.read.map((path) => `Read ${path}`),
      ...permissions.fileSystem.write.map((path) => `Write ${path}`),
    ];
  });
  return (
    <section class="approval-permissions" aria-label="Requested permissions">
      <For each={details()}>{(detail) => <span>{detail}</span>}</For>
    </section>
  );
}

function CardIcon(props: { variant: "questions" | "approval" }) {
  return props.variant === "questions" ? (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />
    </svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M10 2.5 16.2 5v4.3c0 3.8-2.4 6.5-6.2 8.2-3.8-1.7-6.2-4.4-6.2-8.2V5L10 2.5Z" />
      <path d="m7.3 10 1.8 1.8 3.7-4" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="m10.9 2.1 3 3M9.8 3.2l3 3M3 13l.6-3.1L10.9 2.6a1.4 1.4 0 0 1 2 0l.5.5a1.4 1.4 0 0 1 0 2L5.1 12.4z" />
    </svg>
  );
}

function ArrowIcon(props: { direction: "left" | "right" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d={props.direction === "left" ? "m9.5 3.5-4 4 4 4" : "m6.5 3.5 4 4-4 4"} />
    </svg>
  );
}

function ReturnIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M4 4.5h5.5a2.5 2.5 0 0 1 0 5H6.8M6.8 7.5l-2.8 2 2.8 2" />
    </svg>
  );
}

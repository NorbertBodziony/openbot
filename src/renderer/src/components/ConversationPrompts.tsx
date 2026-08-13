import { createSignal, For, Show } from "solid-js";
import type { AgentPromptQuestion } from "../../../shared/ipc";

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
      <div class="choice-options" role="listbox" aria-label={props.title}>
        <For each={props.choices}>
          {(choice, index) => (
            <button
              type="button"
              role="option"
              aria-selected={choice === props.customChoice ? customSelected() : answer() === choice}
              class="choice-option"
              classList={{
                "choice-option-selected":
                  choice === props.customChoice ? customSelected() : answer() === choice,
              }}
              disabled={props.pending}
              onClick={() => {
                if (choice === props.customChoice) {
                  setAnswer("");
                  setCustomSelected(true);
                  customInput?.focus();
                  return;
                }
                setCustomSelected(false);
                setAnswer(choice);
                void props.onSubmit(choice);
              }}
            >
              <span class="choice-key">{String.fromCharCode(65 + index())}</span>
              <span>{choice}</span>
            </button>
          )}
        </For>
      </div>
      <input
        ref={(element) => (customInput = element)}
        class="choice-input"
        value={answer()}
        placeholder="Type your own answer"
        aria-label="Custom answer"
        disabled={props.pending}
        onInput={(event) => {
          setCustomSelected(true);
          setAnswer(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
        }}
      />
    </div>
  );
}

export function PromptCard(props: {
  questions: AgentPromptQuestion[];
  onSubmit: (answers: Record<string, string[]>) => Promise<boolean>;
}) {
  const [answers, setAnswers] = createSignal<Record<string, string>>({});
  const [submitting, setSubmitting] = createSignal(false);
  const submit = async () => {
    if (submitting()) return;
    const result = Object.fromEntries(
      props.questions.map((question) => [question.id, [answers()[question.id]?.trim() ?? ""]]),
    );
    if (Object.values(result).some((value) => !value[0])) return;
    setSubmitting(true);
    await props.onSubmit(result);
    setSubmitting(false);
  };
  return (
    <section class="prompt-card" aria-label="Agent question">
      <For each={props.questions}>
        {(question) => (
          <div class="prompt-question">
            <strong>{question.question}</strong>
            <Show when={question.options?.length}>
              <div class="choice-options">
                <For each={question.options ?? []}>
                  {(option) => (
                    <button
                      type="button"
                      class="choice-option"
                      classList={{
                        "choice-option-selected": answers()[question.id] === option.label,
                      }}
                      onClick={() =>
                        setAnswers((current) => ({ ...current, [question.id]: option.label }))
                      }
                    >
                      <span>{option.label}</span>
                      <small>{option.description}</small>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <input
              class="choice-input"
              type={question.isSecret ? "password" : "text"}
              value={answers()[question.id] ?? ""}
              placeholder="Type your answer"
              aria-label={question.header}
              onInput={(event) =>
                setAnswers((current) => ({ ...current, [question.id]: event.currentTarget.value }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
          </div>
        )}
      </For>
      <button
        type="button"
        class="prompt-submit"
        disabled={submitting()}
        onClick={() => void submit()}
      >
        {submitting() ? "Sending…" : "Send answer"}
      </button>
    </section>
  );
}

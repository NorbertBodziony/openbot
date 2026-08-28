import type { ComponentProps, JSX } from "@solidjs/web";
import { createContext, omit, useContext } from "solid-js";
import { Button, type ButtonProps } from "./button";
import { Input, type InputProps } from "./form";
import { cx } from "./utils";

interface QuestionnaireContextValue {
  cancel: () => void;
  readonly current: number;
  readonly disabled: boolean;
  readonly first: boolean;
  readonly last: boolean;
  readonly total: number;
  next: () => void;
  previous: () => void;
  skip: () => void;
}

const QuestionnaireContext = createContext<QuestionnaireContextValue | null>(null);

function useQuestionnaireContext(component: string): QuestionnaireContextValue {
  const context = useContext(QuestionnaireContext);
  if (!context) throw new Error(`${component} must be used inside Questionnaire.Root.`);
  return context;
}

export interface QuestionnaireRootProps extends ComponentProps<"form"> {
  current: number;
  disabled?: boolean;
  total: number;
  onCancel?: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
  onSkip?: () => void;
}

function QuestionnaireRoot(props: QuestionnaireRootProps): JSX.Element {
  const others = omit(props, "class", "current", "disabled", "total", "onCancel", "onNext", "onPrevious", "onSkip");
  const context: QuestionnaireContextValue = {
    cancel: () => props.onCancel?.(),
    get current() {
      return props.current;
    },
    get disabled() {
      return Boolean(props.disabled);
    },
    get first() {
      return props.current <= 1;
    },
    get last() {
      return props.total === 0 || props.current >= props.total;
    },
    get total() {
      return props.total;
    },
    next: () => props.onNext?.(),
    previous: () => props.onPrevious?.(),
    skip: () => props.onSkip?.(),
  };

  return (
    <QuestionnaireContext value={context}>
      <form
        data-slot="questionnaire"
        data-current={props.current}
        data-disabled={props.disabled ? "" : undefined}
        data-total={props.total}
        class={cx("ui-questionnaire", props.class)}
        novalidate
        {...others}
      />
    </QuestionnaireContext>
  );
}

export interface QuestionnaireProgressState {
  current: number;
  first: boolean;
  last: boolean;
  total: number;
}

export interface QuestionnaireProgressProps extends Omit<ComponentProps<"div">, "children"> {
  children?: JSX.Element;
}

function QuestionnaireProgress(props: QuestionnaireProgressProps): JSX.Element {
  const context = useQuestionnaireContext("Questionnaire.Progress");
  const others = omit(props, "children", "class");
  const label = () => (context.total ? `Question ${context.current} of ${context.total}` : "No questions");

  return (
    <div
      data-slot="questionnaire-progress"
      class={cx("ui-questionnaire-progress", props.class)}
      role="progressbar"
      aria-label="Question progress"
      aria-live="polite"
      aria-valuemin={context.total ? 1 : undefined}
      aria-valuemax={context.total || undefined}
      aria-valuenow={context.total ? context.current : undefined}
      aria-valuetext={label()}
      {...others}
    >
      {props.children ?? `${context.current} / ${context.total}`}
    </div>
  );
}

export interface QuestionnaireItemProps extends ComponentProps<"section"> {
  active: boolean;
}

function QuestionnaireItem(props: QuestionnaireItemProps): JSX.Element {
  const others = omit(props, "active", "class");
  return (
    <section
      data-slot="questionnaire-item"
      data-active={props.active ? "" : undefined}
      class={cx("ui-questionnaire-item", props.class)}
      hidden={!props.active}
      {...others}
    />
  );
}

function QuestionnaireTitle(props: ComponentProps<"h2">): JSX.Element {
  const others = omit(props, "class");
  return <h2 data-slot="questionnaire-title" class={cx("ui-questionnaire-title", props.class)} {...others} />;
}

function QuestionnaireDescription(props: ComponentProps<"p">): JSX.Element {
  const others = omit(props, "class");
  return (
    <p data-slot="questionnaire-description" class={cx("ui-questionnaire-description", props.class)} {...others} />
  );
}

function QuestionnaireChoices(props: ComponentProps<"div">): JSX.Element {
  const others = omit(props, "class");
  return <div data-slot="questionnaire-choices" class={cx("ui-questionnaire-choices", props.class)} {...others} />;
}

export interface QuestionnaireChoiceProps extends Omit<ComponentProps<"label">, "onChange"> {
  checked: boolean;
  disabled?: boolean;
  name: string;
  value: string;
  onChange: (value: string) => void;
}

function QuestionnaireChoice(props: QuestionnaireChoiceProps): JSX.Element {
  const others = omit(props, "checked", "children", "class", "disabled", "name", "onChange", "value");
  return (
    <label
      data-slot="questionnaire-choice"
      data-checked={props.checked ? "" : undefined}
      data-disabled={props.disabled ? "" : undefined}
      class={cx("ui-questionnaire-choice", props.class)}
      {...others}
    >
      <input
        class="ui-questionnaire-choice-input"
        type="radio"
        name={props.name}
        value={props.value}
        checked={props.checked}
        disabled={props.disabled}
        onChange={() => props.onChange(props.value)}
      />
      {props.children}
    </label>
  );
}

function QuestionnaireInput(props: InputProps): JSX.Element {
  const others = omit(props, "class");
  return <Input data-slot="questionnaire-input" class={cx("ui-questionnaire-input", props.class)} {...others} />;
}

export interface QuestionnaireErrorProps extends ComponentProps<"p"> {
  visible?: boolean;
}

function QuestionnaireError(props: QuestionnaireErrorProps): JSX.Element {
  const others = omit(props, "class", "visible");
  return (
    <p
      data-slot="questionnaire-error"
      class={cx("ui-questionnaire-error", props.class)}
      role={props.visible === false ? undefined : "alert"}
      hidden={props.visible === false}
      {...others}
    />
  );
}

function QuestionnaireActions(props: ComponentProps<"div">): JSX.Element {
  const others = omit(props, "class");
  return <div data-slot="questionnaire-actions" class={cx("ui-questionnaire-actions", props.class)} {...others} />;
}

type QuestionnaireNavigationProps = Omit<ButtonProps, "onClick">;

function QuestionnairePrevious(props: QuestionnaireNavigationProps): JSX.Element {
  const context = useQuestionnaireContext("Questionnaire.Previous");
  const others = omit(props, "children", "disabled", "variant");
  return (
    <Button
      data-slot="questionnaire-previous"
      type="button"
      variant={props.variant ?? "ghost"}
      disabled={context.disabled || context.first || Boolean(props.disabled)}
      onClick={context.previous}
      {...others}
    >
      {props.children ?? "Previous"}
    </Button>
  );
}

function QuestionnaireSkip(props: QuestionnaireNavigationProps): JSX.Element {
  const context = useQuestionnaireContext("Questionnaire.Skip");
  const others = omit(props, "children", "disabled", "variant");
  return (
    <Button
      data-slot="questionnaire-skip"
      type="button"
      variant={props.variant ?? "ghost"}
      disabled={context.disabled || Boolean(props.disabled)}
      onClick={context.skip}
      {...others}
    >
      {props.children ?? "Skip"}
    </Button>
  );
}

function QuestionnaireCancel(props: QuestionnaireNavigationProps): JSX.Element {
  const context = useQuestionnaireContext("Questionnaire.Cancel");
  const others = omit(props, "children", "disabled", "variant");
  return (
    <Button
      data-slot="questionnaire-cancel"
      type="button"
      variant={props.variant ?? "ghost"}
      disabled={context.disabled || Boolean(props.disabled)}
      onClick={context.cancel}
      {...others}
    >
      {props.children ?? "Cancel"}
    </Button>
  );
}

function QuestionnaireNext(props: QuestionnaireNavigationProps): JSX.Element {
  const context = useQuestionnaireContext("Questionnaire.Next");
  const others = omit(props, "children", "disabled");
  return (
    <Button
      data-slot="questionnaire-next"
      type="button"
      aria-disabled={context.disabled || context.last || props.disabled ? "true" : undefined}
      disabled={context.disabled || context.last || Boolean(props.disabled)}
      onClick={context.next}
      {...others}
    >
      {props.children ?? "Next"}
    </Button>
  );
}

function QuestionnaireSubmit(props: ButtonProps): JSX.Element {
  const context = useQuestionnaireContext("Questionnaire.Submit");
  const others = omit(props, "children", "disabled");
  return (
    <Button
      data-slot="questionnaire-submit"
      type="submit"
      disabled={context.disabled || Boolean(props.disabled)}
      hidden={!context.last || context.total === 0}
      {...others}
    >
      {props.children ?? "Submit"}
    </Button>
  );
}

export const Questionnaire = {
  Root: QuestionnaireRoot,
  Progress: QuestionnaireProgress,
  Item: QuestionnaireItem,
  Title: QuestionnaireTitle,
  Description: QuestionnaireDescription,
  Choices: QuestionnaireChoices,
  Choice: QuestionnaireChoice,
  Input: QuestionnaireInput,
  Error: QuestionnaireError,
  Actions: QuestionnaireActions,
  Previous: QuestionnairePrevious,
  Skip: QuestionnaireSkip,
  Cancel: QuestionnaireCancel,
  Next: QuestionnaireNext,
  Submit: QuestionnaireSubmit,
};

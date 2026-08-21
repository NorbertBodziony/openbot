import type { ComponentProps, JSX } from "@solidjs/web";
import { createContext, createUniqueId, flush, omit, Show, useContext } from "solid-js";
import { cx } from "./utils";

export type ControlSize = "sm" | "md" | "lg";

interface ControlOptions {
  size?: ControlSize;
  invalid?: boolean;
}

interface FieldContextValue {
  controlId: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

interface TextControlOptions extends ControlOptions {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

export type InputProps = ComponentProps<"input"> & TextControlOptions;

export function Input(props: InputProps): JSX.Element {
  const local = props;
  const field = useContext(FieldContext);
  const inputProps = omit(
    props,
    "class",
    "size",
    "invalid",
    "id",
    "aria-label",
    "aria-labelledby",
    "aria-describedby",
    "aria-invalid",
    "required",
    "onValueChange",
    "onInput",
    "value",
    "defaultValue",
  );
  const describedBy = () => [local["aria-describedby"], field?.describedBy].filter(Boolean).join(" ") || undefined;
  if (!("value" in props)) {
    return (
      <input
        {...inputProps}
        defaultValue={local.defaultValue}
        class={cx("ui-input", local.class)}
        data-size={local.size ?? "md"}
        id={local.id ?? field?.controlId}
        aria-label={local["aria-label"]}
        aria-labelledby={local["aria-labelledby"]}
        aria-describedby={describedBy()}
        aria-invalid={local["aria-invalid"] ?? (local.invalid || field?.invalid ? "true" : undefined)}
        required={local.required ?? field?.required}
        onInput={
          local.onValueChange ? (event) => flush(() => local.onValueChange?.(event.currentTarget.value)) : local.onInput
        }
      />
    );
  }
  return (
    <input
      {...inputProps}
      value={local.value}
      class={cx("ui-input", local.class)}
      data-size={local.size ?? "md"}
      id={local.id ?? field?.controlId}
      aria-label={local["aria-label"]}
      aria-labelledby={local["aria-labelledby"]}
      aria-describedby={describedBy()}
      aria-invalid={local["aria-invalid"] ?? (local.invalid || field?.invalid ? "true" : undefined)}
      required={local.required ?? field?.required}
      onInput={
        local.onValueChange ? (event) => flush(() => local.onValueChange?.(event.currentTarget.value)) : local.onInput
      }
    />
  );
}

export type TextareaProps = ComponentProps<"textarea"> & TextControlOptions;

export function Textarea(props: TextareaProps): JSX.Element {
  const local = props;
  const field = useContext(FieldContext);
  const textareaProps = omit(
    props,
    "class",
    "size",
    "invalid",
    "id",
    "aria-label",
    "aria-labelledby",
    "aria-describedby",
    "aria-invalid",
    "required",
    "onValueChange",
    "onInput",
    "value",
    "defaultValue",
  );
  const describedBy = () => [local["aria-describedby"], field?.describedBy].filter(Boolean).join(" ") || undefined;
  if (!("value" in props)) {
    return (
      <textarea
        {...textareaProps}
        defaultValue={local.defaultValue}
        class={cx("ui-textarea", local.class)}
        data-size={local.size ?? "md"}
        id={local.id ?? field?.controlId}
        aria-label={local["aria-label"]}
        aria-labelledby={local["aria-labelledby"]}
        aria-describedby={describedBy()}
        aria-invalid={local["aria-invalid"] ?? (local.invalid || field?.invalid ? "true" : undefined)}
        required={local.required ?? field?.required}
        onInput={
          local.onValueChange ? (event) => flush(() => local.onValueChange?.(event.currentTarget.value)) : local.onInput
        }
      />
    );
  }
  return (
    <textarea
      {...textareaProps}
      value={local.value}
      class={cx("ui-textarea", local.class)}
      data-size={local.size ?? "md"}
      id={local.id ?? field?.controlId}
      aria-label={local["aria-label"]}
      aria-labelledby={local["aria-labelledby"]}
      aria-describedby={describedBy()}
      aria-invalid={local["aria-invalid"] ?? (local.invalid || field?.invalid ? "true" : undefined)}
      required={local.required ?? field?.required}
      onInput={
        local.onValueChange ? (event) => flush(() => local.onValueChange?.(event.currentTarget.value)) : local.onInput
      }
    />
  );
}

export type NativeSelectProps = ComponentProps<"select"> & ControlOptions;

export function NativeSelect(props: NativeSelectProps): JSX.Element {
  const local = props;
  const field = useContext(FieldContext);
  const others = omit(props, "class", "size", "invalid", "id", "aria-describedby", "aria-invalid", "required");
  const describedBy = () => [local["aria-describedby"], field?.describedBy].filter(Boolean).join(" ") || undefined;
  return (
    <select
      {...others}
      class={cx("ui-native-select", local.class)}
      data-size={local.size ?? "md"}
      id={local.id ?? field?.controlId}
      aria-describedby={describedBy()}
      aria-invalid={local["aria-invalid"] ?? (local.invalid || field?.invalid ? "true" : undefined)}
      required={local.required ?? field?.required}
    />
  );
}

export function Label(props: ComponentProps<"label">): JSX.Element {
  const local = props;
  const field = useContext(FieldContext);
  const others = omit(props, "class", "children", "for");
  return (
    <label class={cx("ui-label", local.class)} for={local.for ?? field?.controlId} {...others}>
      {local.children}
    </label>
  );
}

export interface FieldProps extends JSX.HTMLAttributes<HTMLDivElement> {
  label: JSX.Element;
  description?: JSX.Element;
  error?: JSX.Element;
  required?: boolean;
  htmlFor?: string;
}

export function Field(props: FieldProps): JSX.Element {
  const generatedId = createUniqueId();
  const local = props;
  const others = omit(props, "class", "children", "label", "description", "error", "required", "htmlFor");
  const descriptionId = `${generatedId}-description`;
  const errorId = `${generatedId}-error`;
  const fieldValue: FieldContextValue = {
    controlId: local.htmlFor ?? `${generatedId}-control`,
    get describedBy() {
      return local.error ? errorId : local.description ? descriptionId : undefined;
    },
    get invalid() {
      return Boolean(local.error);
    },
    get required() {
      return Boolean(local.required);
    },
  };
  return (
    <FieldContext value={fieldValue}>
      <div class={cx("ui-field", local.class)} data-invalid={local.error ? "" : undefined} {...others}>
        <Label>
          {local.label}
          <Show when={local.required}>
            <span class="ui-field-required" aria-hidden="true">
              *
            </span>
          </Show>
        </Label>
        {local.children}
        <Show when={local.description}>
          <div id={descriptionId} class="ui-field-description">
            {local.description}
          </div>
        </Show>
        <Show when={local.error}>
          <div id={errorId} class="ui-field-error" role="alert">
            {local.error}
          </div>
        </Show>
      </div>
    </FieldContext>
  );
}

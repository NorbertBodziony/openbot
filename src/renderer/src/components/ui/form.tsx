import type { ComponentProps, JSX } from "@solidjs/web";
import { createContext, createUniqueId, omit, Show, useContext } from "solid-js";
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

export type InputProps = ComponentProps<"input"> & ControlOptions;

export function Input(props: InputProps): JSX.Element {
  const local = props;
  const field = useContext(FieldContext);
  const others = omit(props, "class", "size", "invalid", "id", "aria-describedby", "aria-invalid", "required");
  const describedBy = () => [local["aria-describedby"], field?.describedBy].filter(Boolean).join(" ") || undefined;
  return (
    <input
      class={cx("ui-input", local.class)}
      data-size={local.size ?? "md"}
      id={local.id ?? field?.controlId}
      aria-describedby={describedBy()}
      aria-invalid={local["aria-invalid"] ?? (local.invalid || field?.invalid ? "true" : undefined)}
      required={local.required ?? field?.required}
      {...others}
    />
  );
}

export type TextareaProps = ComponentProps<"textarea"> & ControlOptions;

export function Textarea(props: TextareaProps): JSX.Element {
  const local = props;
  const field = useContext(FieldContext);
  const others = omit(props, "class", "size", "invalid", "id", "aria-describedby", "aria-invalid", "required");
  const describedBy = () => [local["aria-describedby"], field?.describedBy].filter(Boolean).join(" ") || undefined;
  return (
    <textarea
      class={cx("ui-textarea", local.class)}
      data-size={local.size ?? "md"}
      id={local.id ?? field?.controlId}
      aria-describedby={describedBy()}
      aria-invalid={local["aria-invalid"] ?? (local.invalid || field?.invalid ? "true" : undefined)}
      required={local.required ?? field?.required}
      {...others}
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
      class={cx("ui-native-select", local.class)}
      data-size={local.size ?? "md"}
      id={local.id ?? field?.controlId}
      aria-describedby={describedBy()}
      aria-invalid={local["aria-invalid"] ?? (local.invalid || field?.invalid ? "true" : undefined)}
      required={local.required ?? field?.required}
      {...others}
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
    describedBy: local.error ? errorId : local.description ? descriptionId : undefined,
    invalid: Boolean(local.error),
    required: Boolean(local.required),
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

import { type ButtonRootProps, Root } from "@kobalte/core/button";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import type { ComponentProps, JSX, ValidComponent } from "@solidjs/web";
import { cva, type VariantProps } from "class-variance-authority";
import { createEffect, createSignal, omit, onCleanup, Show } from "solid-js";
import { Check, Copy } from "./icons";
import { Spinner } from "./surface";
import { cx } from "./utils";

export const buttonVariants = cva("ui-button", {
  variants: {
    variant: {
      default: "ui-button-variant-default",
      outline: "ui-button-variant-outline",
      secondary: "ui-button-variant-secondary",
      ghost: "ui-button-variant-ghost",
      destructive: "ui-button-variant-destructive",
      "destructive-ghost": "ui-button-variant-destructive-ghost",
      link: "ui-button-variant-link",
    },
    size: {
      default: "ui-button-size-default",
      xs: "ui-button-size-xs",
      sm: "ui-button-size-sm",
      lg: "ui-button-size-lg",
      icon: "ui-button-size-icon",
      "icon-xs": "ui-button-size-icon-xs",
      "icon-sm": "ui-button-size-icon-sm",
      "icon-lg": "ui-button-size-icon-lg",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

type OpenBotButtonProps = VariantProps<typeof buttonVariants> & {
  class?: JSX.HTMLAttributes<HTMLElement>["class"];
  children?: JSX.Element;
  loading?: boolean;
  loadingLabel?: string;
  fullWidth?: boolean;
};

export type ButtonProps<T extends ValidComponent = "button"> = PolymorphicProps<T, ButtonRootProps<T>> &
  OpenBotButtonProps &
  Partial<Pick<ComponentProps<T>, "class">>;

export function Button<T extends ValidComponent = "button">(props: ButtonProps<T>): JSX.Element {
  const others = omit(
    props,
    "variant",
    "size",
    "class",
    "children",
    "loading",
    "loadingLabel",
    "fullWidth",
    "disabled",
  );
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: Solid 2's omit cannot preserve Kobalte's generic polymorphic props.
  const rootProps = others as PolymorphicProps<T, ButtonRootProps<T>>;

  return (
    <Root<T>
      class={cx(
        buttonVariants({ variant: props.variant ?? "default", size: props.size ?? "default" }),
        props.fullWidth && "ui-button-full",
        props.class,
      )}
      data-slot="button"
      data-variant={props.variant ?? "default"}
      data-size={props.size ?? "default"}
      disabled={Boolean(props.disabled || props.loading)}
      aria-busy={props.loading ? "true" : undefined}
      {...rootProps}
    >
      <Show when={props.loading}>
        <Spinner size="sm" />
      </Show>
      {props.loading && props.loadingLabel ? props.loadingLabel : props.children}
    </Root>
  );
}

export type IconButtonSize = Extract<ButtonSize, "icon" | "icon-xs" | "icon-sm" | "icon-lg">;

export interface IconButtonProps extends Omit<ButtonProps, "children" | "fullWidth" | "size"> {
  label: string;
  children: JSX.Element;
  tooltip?: string;
  size?: IconButtonSize;
}

export function IconButton(props: IconButtonProps): JSX.Element {
  const others = omit(props, "label", "tooltip", "children", "class", "size");
  return (
    <Button
      class={cx("ui-icon-button", props.class)}
      size={props.size ?? "icon-sm"}
      aria-label={props.label}
      title={props.tooltip ?? props.label}
      {...others}
    >
      {props.children}
    </Button>
  );
}

export interface CopyButtonProps extends Omit<ButtonProps, "children" | "onClick" | "type" | "value"> {
  value: string | null | undefined;
  label?: string;
  copiedLabel?: string;
  iconOnly?: boolean;
  onCopyError?: (error: unknown) => void;
}

export function CopyButton(props: CopyButtonProps): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  let resetTimer: number | undefined;
  const others = omit(props, "value", "label", "copiedLabel", "iconOnly", "onCopyError", "disabled", "class", "size");

  function clearResetTimer(): void {
    if (resetTimer === undefined) return;
    window.clearTimeout(resetTimer);
    resetTimer = undefined;
  }

  createEffect(
    () => props.value,
    () => {
      clearResetTimer();
      setCopied(false);
    },
  );

  onCleanup(clearResetTimer);

  async function copyValue(): Promise<void> {
    if (!props.value) return;
    try {
      await navigator.clipboard.writeText(props.value);
      clearResetTimer();
      setCopied(true);
      resetTimer = window.setTimeout(() => {
        resetTimer = undefined;
        setCopied(false);
      }, 1_500);
    } catch (error) {
      clearResetTimer();
      setCopied(false);
      props.onCopyError?.(error);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size={props.size ?? (props.iconOnly ? "icon-sm" : "sm")}
      class={cx(props.iconOnly && "ui-icon-button", props.class)}
      disabled={Boolean(props.disabled || !props.value)}
      data-copied={copied() ? "" : undefined}
      {...others}
      onClick={() => void copyValue()}
    >
      <Show when={copied()} fallback={<Copy aria-hidden="true" />}>
        <Check aria-hidden="true" />
      </Show>
      <span class={props.iconOnly ? "sr-only" : undefined} aria-live="polite">
        {copied() ? (props.copiedLabel ?? "Copied") : (props.label ?? "Copy")}
      </span>
    </Button>
  );
}

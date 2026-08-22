import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import * as SelectPrimitive from "@kobalte/core/select";
import type { ComponentProps, JSX, ValidComponent } from "@solidjs/web";
import Check from "lucide-solid/icons/check";
import ChevronsUpDown from "lucide-solid/icons/chevrons-up-down";
import { omit } from "solid-js";
import { cx } from "./utils";

export type SelectProps<Option, OptGroup = never, T extends ValidComponent = "div"> = PolymorphicProps<
  T,
  SelectPrimitive.SelectRootProps<Option, OptGroup, T>
> &
  Pick<ComponentProps<T>, "class" | "children">;

export function Select<Option, OptGroup = never, T extends ValidComponent = "div">(
  props: SelectProps<Option, OptGroup, T>,
): JSX.Element {
  const others = omit(props, "class");
  return (
    <SelectPrimitive.Root<Option, OptGroup, T>
      {...others}
      class={cx("ui-select", props.class)}
      gutter={props.gutter ?? 4}
      placement={props.placement ?? "bottom"}
      sameWidth={props.sameWidth ?? true}
    />
  );
}

export type SelectTriggerProps = PolymorphicProps<"button", SelectPrimitive.SelectTriggerProps<"button">> &
  Pick<ComponentProps<"button">, "class" | "children"> & {
    size?: "sm" | "md";
  };

export function SelectTrigger(rawProps: SelectTriggerProps): JSX.Element {
  const others = omit(rawProps, "class", "children", "size");
  return (
    <SelectPrimitive.Trigger
      class={cx("ui-select-trigger", rawProps.class)}
      data-size={rawProps.size ?? "md"}
      data-slot="select-trigger"
      {...others}
    >
      {rawProps.children}
      <SelectPrimitive.Icon class="ui-select-trigger-icon">
        <ChevronsUpDown aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export type SelectValueProps<Option> = PolymorphicProps<"span", SelectPrimitive.SelectValueProps<Option, "span">> &
  Pick<ComponentProps<"span">, "class">;

export function SelectValue<Option>(props: SelectValueProps<Option>): JSX.Element {
  const others = omit(props, "class");
  return (
    <SelectPrimitive.Value<Option, "span">
      class={cx("ui-select-value", props.class)}
      data-slot="select-value"
      {...others}
    />
  );
}

export type SelectContentProps = PolymorphicProps<"div", SelectPrimitive.SelectContentProps<"div">> &
  Pick<ComponentProps<"div">, "class">;

export function SelectContent(props: SelectContentProps): JSX.Element {
  const others = omit(props, "class");
  let contentElement: HTMLElement | undefined;
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={(element) => {
          contentElement = element;
        }}
        class={cx("ui-select-content", props.class)}
        data-slot="select-content"
        {...others}
      >
        <SelectPrimitive.Listbox class="ui-select-listbox" scrollRef={() => contentElement} />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export type SelectItemProps = PolymorphicProps<"li", SelectPrimitive.SelectItemProps<"li">> &
  Pick<ComponentProps<"li">, "class" | "children">;

export function SelectItem(props: SelectItemProps): JSX.Element {
  const others = omit(props, "class", "children");
  return (
    <SelectPrimitive.Item class={cx("ui-select-item", props.class)} data-slot="select-item" {...others}>
      <SelectPrimitive.ItemLabel class="ui-select-item-label">{props.children}</SelectPrimitive.ItemLabel>
      <SelectPrimitive.ItemIndicator class="ui-select-item-indicator">
        <Check aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export type SelectGroupProps = PolymorphicProps<"div", SelectPrimitive.SelectSectionProps<"div">> &
  Pick<ComponentProps<"div">, "class">;

export function SelectGroup(props: SelectGroupProps): JSX.Element {
  const others = omit(props, "class");
  return <SelectPrimitive.Section class={cx("ui-select-group", props.class)} data-slot="select-group" {...others} />;
}

export type SelectLabelProps = PolymorphicProps<"span", SelectPrimitive.SelectLabelProps<"span">> &
  Pick<ComponentProps<"span">, "class">;

export function SelectLabel(props: SelectLabelProps): JSX.Element {
  const others = omit(props, "class");
  return <SelectPrimitive.Label class={cx("ui-select-label", props.class)} data-slot="select-label" {...others} />;
}

export type SelectSeparatorProps = ComponentProps<"hr">;

export function SelectSeparator(props: SelectSeparatorProps): JSX.Element {
  const others = omit(props, "class");
  return <hr class={cx("ui-select-separator", props.class)} data-slot="select-separator" {...others} />;
}

export function SelectHiddenSelect(props: SelectPrimitive.SelectHiddenSelectProps): JSX.Element {
  return <SelectPrimitive.HiddenSelect {...props} />;
}

import { useTabsContext } from "@kobalte/core/tabs";
import type { ComponentProps, JSX } from "@solidjs/web";
import { omit, onCleanup } from "solid-js";
import { Tabs } from "./complex";
import { cx } from "./utils";

export type SlidingTabsRootProps = ComponentProps<typeof Tabs.Root>;
export type SlidingTabsListProps = ComponentProps<typeof Tabs.List>;
export type SlidingTabsTriggerProps = ComponentProps<typeof Tabs.Trigger>;
export type SlidingTabsContentProps = ComponentProps<typeof Tabs.Content>;
export type SlidingTabsContentSlotProps = JSX.HTMLAttributes<HTMLDivElement>;

function SlidingTabsRoot(props: SlidingTabsRootProps) {
  const others = omit(props, "activationMode", "orientation");
  return <Tabs.Root {...others} activationMode={props.activationMode ?? "automatic"} orientation="horizontal" />;
}

function SlidingTabsList(props: SlidingTabsListProps) {
  const others = omit(props, "class", "children");
  let indicator: HTMLDivElement | undefined;
  let readyFrame: number | undefined;
  let disposed = false;

  queueMicrotask(() => {
    if (disposed) return;
    readyFrame = window.requestAnimationFrame(() => {
      if (!indicator) return;
      void indicator.offsetWidth;
      indicator.removeAttribute("data-initializing");
    });
  });

  onCleanup(() => {
    disposed = true;
    if (readyFrame !== undefined) window.cancelAnimationFrame(readyFrame);
  });

  return (
    <Tabs.List {...others} class={cx("ui-sliding-tabs", props.class)}>
      <Tabs.Indicator ref={indicator} class="ui-sliding-tabs-pill" data-initializing="" />
      {props.children}
    </Tabs.List>
  );
}

function SlidingTabsTrigger(props: SlidingTabsTriggerProps) {
  return <Tabs.Trigger {...props} class={cx("ui-sliding-tabs-trigger", props.class)} />;
}

function SlidingTabsContentSlot(props: SlidingTabsContentSlotProps) {
  const others = omit(props, "class", "children");
  return (
    <div {...others} class={cx("ui-sliding-tabs-content-slot", props.class)}>
      {props.children}
    </div>
  );
}

function SlidingTabsContent(props: SlidingTabsContentProps) {
  const context = useTabsContext();
  const others = omit(props, "class", "forceMount", "aria-hidden", "inert");
  const isSelected = () => context.listState().selectedKey() === props.value;

  return (
    <Tabs.Content
      {...others}
      forceMount
      class={cx("ui-sliding-tabs-content", props.class)}
      aria-hidden={isSelected() ? undefined : "true"}
      inert={isSelected() ? undefined : true}
    />
  );
}

export const SlidingTabs = {
  Root: SlidingTabsRoot,
  List: SlidingTabsList,
  Trigger: SlidingTabsTrigger,
  ContentSlot: SlidingTabsContentSlot,
  Content: SlidingTabsContent,
};

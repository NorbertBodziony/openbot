import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import * as ProgressPrimitive from "@kobalte/core/progress";
import type { ComponentProps, JSX, ValidComponent } from "@solidjs/web";
import { omit } from "solid-js";
import { cx } from "./utils";

type OpenBotProgressProps = {
  class?: JSX.HTMLAttributes<HTMLElement>["class"];
};

export type ProgressProps<T extends ValidComponent = "div"> = PolymorphicProps<
  T,
  ProgressPrimitive.ProgressRootProps<T>
> &
  OpenBotProgressProps &
  Partial<Pick<ComponentProps<T>, "class">>;

export function Progress<T extends ValidComponent = "div">(props: ProgressProps<T>): JSX.Element {
  const others = omit(props, "class");
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: Solid 2's omit cannot preserve Kobalte's generic polymorphic props.
  const rootProps = others as PolymorphicProps<T, ProgressPrimitive.ProgressRootProps<T>>;

  return (
    <ProgressPrimitive.Root<T> data-slot="progress" class={cx("ui-progress", props.class)} {...rootProps}>
      <ProgressPrimitive.Track data-slot="progress-track" class="ui-progress-track">
        <ProgressPrimitive.Fill data-slot="progress-fill" class="ui-progress-fill" />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

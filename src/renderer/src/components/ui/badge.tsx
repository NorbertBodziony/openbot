import { type BadgeRootProps, Root } from "@kobalte/core/badge";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import type { ComponentProps, JSX, ValidComponent } from "@solidjs/web";
import { cva, type VariantProps } from "class-variance-authority";
import { omit, Show } from "solid-js";
import { cx } from "./utils";

export const badgeVariants = cva("z-badge", {
  variants: {
    variant: {
      default: "z-badge-variant-default",
      secondary: "z-badge-variant-secondary",
      destructive: "z-badge-variant-destructive",
      outline: "z-badge-variant-outline",
      ghost: "z-badge-variant-ghost",
      link: "z-badge-variant-link",
      "primary-light": "z-badge-variant-primary-light",
      "destructive-light": "z-badge-variant-destructive-light",
      "success-light": "z-badge-variant-success-light",
      "warning-light": "z-badge-variant-warning-light",
      "info-light": "z-badge-variant-info-light",
      "primary-outline": "z-badge-variant-primary-outline",
      "destructive-outline": "z-badge-variant-destructive-outline",
      "success-outline": "z-badge-variant-success-outline",
      "warning-outline": "z-badge-variant-warning-outline",
      "info-outline": "z-badge-variant-info-outline",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";
export type BadgeSize = "sm" | "md";
export type BadgeRadius = "rounded" | "pill";

type BadgeProps<T extends ValidComponent = "span"> = PolymorphicProps<T, BadgeRootProps<T>> &
  VariantProps<typeof badgeVariants> & {
    /** @deprecated Use a Zaidan `variant` instead. */
    tone?: BadgeTone;
    /** @deprecated Zaidan badges use one compact size. */
    size?: BadgeSize;
    /** @deprecated Zaidan badges use a pill shape. */
    shape?: BadgeRadius;
    /** @deprecated Put a Lucide icon inside the badge. */
    dot?: boolean;
    role?: JSX.HTMLAttributes<HTMLElement>["role"];
  } & Partial<Pick<ComponentProps<T>, "class" | "children">>;

export function Badge<T extends ValidComponent = "span">(props: BadgeProps<T>): JSX.Element {
  const others = omit(props, "class", "variant", "tone", "size", "shape", "dot", "children", "role");
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: Solid 2's omit cannot preserve Kobalte's generic polymorphic props.
  const rootProps = others as PolymorphicProps<T, BadgeRootProps<T>>;
  const variant = () => props.variant ?? legacyBadgeVariant(props.tone);

  return (
    <Root<T>
      class={cx(badgeVariants({ variant: variant() }), props.class)}
      data-slot="badge"
      data-variant={variant()}
      data-size={props.size}
      data-shape={props.shape}
      role={props.role ?? "presentation"}
      {...rootProps}
    >
      <Show when={props.dot}>
        <span class="z-badge-dot" aria-hidden="true" />
      </Show>
      {props.children}
    </Root>
  );
}

function legacyBadgeVariant(tone: BadgeTone | undefined): NonNullable<VariantProps<typeof badgeVariants>["variant"]> {
  if (tone === "accent") return "primary-light";
  if (tone === "success") return "success-light";
  if (tone === "warning") return "warning-light";
  if (tone === "danger") return "destructive-light";
  return "secondary";
}

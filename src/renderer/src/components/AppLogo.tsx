import type { AppVariant } from "@openbot/contracts/ipc";

export type AppLogoAnimation = "none" | "blink" | "look-around" | "surprised";

interface AppLogoProps {
  variant: AppVariant;
  animation?: AppLogoAnimation;
  class?: string;
}

export function AppLogo(props: AppLogoProps) {
  const className = () => ["app-logo", props.class].filter(Boolean).join(" ");
  const animation = () => props.animation ?? "none";

  return (
    <svg
      class={className()}
      data-animation={animation()}
      data-variant={props.variant}
      viewBox="0 0 240 240"
      aria-hidden="true"
    >
      <rect class="app-logo-background" width="240" height="240" rx="50" ry="50" />
      <polyline
        class="app-logo-eye app-logo-eye-left"
        points="43.55 93.61 64.69 81.41 36.48 108.04 79.67 83.11 35.93 122.88 91.58 90.74 38.9 132.69 97.66 98.76 42.44 138.88 100.43 105.4 46.9 143.83 101.97 112.04 55.08 149.51 101.83 122.52 73.01 152.43 94.14 140.23"
      />
      <polyline
        class="app-logo-eye app-logo-eye-right"
        points="145.65 93.61 166.79 81.41 140.83 101.52 175.58 81.46 138.3 109.53 183.18 83.63 137.55 117.43 189.67 87.33 139.67 129.39 197.88 95.78 142.92 136.32 201.52 102.48 149.03 143.86 204.07 112.08 159.14 150.37 203.51 124.75 169.28 152.61 199.82 134.98"
      />
    </svg>
  );
}

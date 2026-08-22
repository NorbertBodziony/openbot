declare module "@openbot/renderer-preview" {
  import type { JSX } from "@solidjs/web";

  export interface OpenBotPlaygroundProps {
    variant?: "default" | "landing";
  }

  export function OpenBotPlayground(props: OpenBotPlaygroundProps): JSX.Element;
}

declare module "@openbot/landing-preview" {
  import type { JSX } from "@solidjs/web";

  export function LandingPreviewApp(): JSX.Element;
}

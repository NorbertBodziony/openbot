declare module "@openbot/renderer-preview" {
  import type { JSX } from "@solidjs/web";

  export interface OpenBotPlaygroundProps {
    options?: {
      browserControlState?: {
        sessions: [];
      };
    };
  }

  export function OpenBotPlayground(props: OpenBotPlaygroundProps): JSX.Element;
}

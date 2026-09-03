import type { FirstBotDraft } from "./components/FirstBotSetup";

/** The first message a newly created agent receives, turning its purpose into a standing role. */
export function createBotInitialMessage(draft: Pick<FirstBotDraft, "purpose">): string {
  return `Your ongoing role is: ${draft.purpose.trim()}`;
}

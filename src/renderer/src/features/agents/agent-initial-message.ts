import type { FirstAgentDraft } from "./FirstAgentSetup";

/** The first message a newly created agent receives, turning its purpose into a standing role. */
export function createAgentInitialMessage(draft: Pick<FirstAgentDraft, "purpose">): string {
  return `Your ongoing role is: ${draft.purpose.trim()}`;
}

import { createSignal } from "solid-js";
import { createSimpleContext } from "./simple-context";

/**
 * Which prompts the user has already acted on, remembered per server for longer
 * than the server's scope lives.
 *
 * Answering a prompt is two events far apart: the answer goes to main
 * immediately, and the snapshot that proves it was recorded arrives whenever the
 * agent next reports. Between the two, `pendingPrompts` has to stay empty even
 * though every snapshot still describes the prompt as pending - and these two
 * maps are what says so. `submittedPromptRequests` marks an answer in flight,
 * `presentedPromptResolutions` a resolution shown from one main before the
 * conversation caught up; `reconcileAttentionPrompts` and the snapshot handler in
 * `conversation.tsx` read them to decide the prompt is finished rather than
 * unanswered.
 *
 * They sit here, above the keyed boundary, because that gap outlives the scope.
 * Answer a prompt on one server, switch away before the agent reports, and come
 * back: the scope is new, its maps would be empty, and the next snapshot would
 * offer the answered prompt again as if nothing had happened. That is the one
 * thing `DynamicIslandCoordinator` cannot cover for - `replaceServer` drops its
 * `resolvedPrompts` marker as soon as the scope stops reporting the prompt as
 * pending, which is exactly when the scope is being torn down.
 *
 * Keyed by server id, then by agent id, and never pruned: a marker is cleared by
 * the snapshot that resolves it, and a server the user leaves keeps at most the
 * handful of prompts that were still in flight when they left. Deliberately
 * dependency-free, like `server-switch.tsx`, so it can be mounted anywhere above
 * the scope.
 */
type PromptMarkers = Record<string, string | undefined>;

const NO_MARKERS: PromptMarkers = {};

/** The four accessors one server scope sees, with its own id already applied. */
export interface ServerPromptMarkers {
  presentedPromptResolutions: () => PromptMarkers;
  setPresentedPromptResolutions: (update: (current: PromptMarkers) => PromptMarkers) => void;
  submittedPromptRequests: () => PromptMarkers;
  setSubmittedPromptRequests: (update: (current: PromptMarkers) => PromptMarkers) => void;
}

const AnsweredPrompts = createSimpleContext({
  name: "Answered prompts",
  init: () => {
    const [presentedByServer, setPresentedByServer] = createSignal<Record<string, PromptMarkers | undefined>>({});
    const [submittedByServer, setSubmittedByServer] = createSignal<Record<string, PromptMarkers | undefined>>({});

    /**
     * The scope reads and writes under its own server id, so nothing it stores
     * can be seen by another server and nothing another server stored can be
     * read here. Agent ids are unique enough in practice, but this does not have
     * to rely on that.
     */
    function promptMarkersFor(serverId: string): ServerPromptMarkers {
      return {
        presentedPromptResolutions: () => presentedByServer()[serverId] ?? NO_MARKERS,
        setPresentedPromptResolutions: (update) =>
          setPresentedByServer((current) => ({ ...current, [serverId]: update(current[serverId] ?? NO_MARKERS) })),
        submittedPromptRequests: () => submittedByServer()[serverId] ?? NO_MARKERS,
        setSubmittedPromptRequests: (update) =>
          setSubmittedByServer((current) => ({ ...current, [serverId]: update(current[serverId] ?? NO_MARKERS) })),
      };
    }

    return { promptMarkersFor };
  },
});

export const AnsweredPromptsProvider = AnsweredPrompts.provider;
export const useAnsweredPrompts = AnsweredPrompts.use;

import type { AgentProviderId, AppSetupState } from "@openbot/contracts/ipc";
import { createSignal, flush, onSettled } from "solid-js";
import { desktopAnalytics } from "./analytics";
import { createSimpleContext } from "./simple-context";

/**
 * First run and the review of it: what the user chose during onboarding, the
 * invitation that may have brought them here, and the flow reopened later to
 * change either.
 *
 * Ungated - see `app-providers.tsx` for why no provider gates during the
 * migration. `setupLoaded()` is the gate this domain will eventually offer;
 * until then `AppAccessGate` reads it directly, which is where the null already
 * matters.
 *
 * Two neighbours worth explaining, because neither sits where a first reading
 * would put it:
 *
 * - **`permissionsOpen` lives here, not with the other dialogs.** It renders the
 *   onboarding flow again in review mode, and `saveSetup` closes it in the same
 *   `flush` that stores the new state. Settings is nested under this domain, so
 *   a `settings.tsx` owner would be a dependency pointing the wrong way.
 * - **`joinRemoteDuringSetup` is not here**, though it is a setup action. It
 *   joins a server first, and joining is the servers domain, which is nested
 *   under this one. It belongs to whichever context owns `joinServer` and can
 *   read `saveSetup` from here.
 */
const Setup = createSimpleContext({
  name: "Setup",
  init: () => {
    const [setupState, setSetupState] = createSignal<AppSetupState | null>(null);
    const [setupLoaded, setSetupLoaded] = createSignal(false);
    const [pendingInviteUrl, setPendingInviteUrl] = createSignal("");
    const [permissionsOpen, setPermissionsOpen] = createSignal(false);

    onSettled(() => {
      // `finally`, not `then`: a failed read still ends the loading screen, and
      // a null `setupState` is the same "not configured yet" the view handles.
      void window.openbot
        .getSetupState()
        .then(setSetupState)
        .finally(() => setSetupLoaded(true));
    });

    async function saveSetup(preferredProvider: AgentProviderId): Promise<void> {
      const wasCompleted = setupState()?.completed === true;
      const analytics = desktopAnalytics.scope();
      const state = await window.openbot.saveSetup({ preferredProvider });
      flush(() => {
        setSetupState(state);
        setPermissionsOpen(false);
      });
      // Only the first completion is onboarding; later saves are a review.
      if (!wasCompleted && state.completed) {
        analytics.track("onboarding_completed", { preferred_provider: preferredProvider });
      }
    }

    async function previewInvite(input: { inviteUrl: string }) {
      return window.openbot.servers.previewInvite(input);
    }

    return {
      setupState,
      setupLoaded,
      pendingInviteUrl,
      setPendingInviteUrl,
      permissionsOpen,
      setPermissionsOpen,
      saveSetup,
      previewInvite,
    };
  },
});

export const SetupProvider = Setup.provider;
export const useSetup = Setup.use;

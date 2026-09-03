import type { UpdateStatus } from "@openbot/contracts/ipc";
import { createSignal, flush, onSettled } from "solid-js";
import { desktopAnalytics } from "./analytics";
import { FALLBACK_UPDATE_STATUS } from "./app-defaults";
import { createSimpleContext } from "./simple-context";

/**
 * The updater, as the renderer sees it: one status main pushes, and one button
 * whose meaning depends on that status.
 *
 * Ungated - the app is fully usable while the updater is still checking, so
 * nothing waits on it, and consumers read `FALLBACK_UPDATE_STATUS` meanwhile.
 * It depends on no other domain, which is why it is the smallest one to move.
 */
const Updates = createSimpleContext({
  name: "Updates",
  init: () => {
    const [status, setStatus] = createSignal<UpdateStatus>(FALLBACK_UPDATE_STATUS);

    onSettled(() => {
      const unsubscribe = window.openbot.update.onEvent((next) => {
        flush(() => setStatus(next));
      });
      void window.openbot.update
        .getStatus()
        .then(setStatus)
        .catch(() => undefined);
      return unsubscribe;
    });

    /**
     * One button, four meanings. `ready` installs; `available` and a failed
     * download retry the download; everything else checks again. The status
     * main pushes back is applied here rather than waited for, so the button
     * settles even if the event is slower than the call.
     */
    async function runAction(): Promise<void> {
      const analytics = desktopAnalytics.scope();
      const current = status();
      const phase = current.phase;
      if (phase === "ready") {
        try {
          await window.openbot.update.install();
          analytics.track("update_action", { action: "install", result: "succeeded", phase: "installing" });
        } catch (error) {
          analytics.track("update_action", {
            action: "install",
            result: "failed",
            failure_code: "install_failed",
          });
          throw error;
        }
        return;
      }
      const action =
        phase === "available" || (phase === "error" && current.errorCode === "download_failed")
          ? ("download" as const)
          : ("check" as const);
      try {
        const next =
          action === "download" ? await window.openbot.update.download() : await window.openbot.update.check();
        setStatus(next);
        const succeeded =
          action === "download"
            ? next.phase === "downloading" || next.phase === "ready"
            : next.phase !== "error" && next.phase !== "unsupported";
        analytics.track("update_action", {
          action,
          result: succeeded ? "succeeded" : "failed",
          phase: next.phase,
          ...(succeeded ? {} : { failure_code: action === "download" ? "download_failed" : "check_failed" }),
        });
      } catch (error) {
        analytics.track("update_action", {
          action,
          result: "failed",
          failure_code: action === "download" ? "download_failed" : "check_failed",
        });
        throw error;
      }
    }

    return { status, runAction };
  },
});

export const UpdatesProvider = Updates.provider;
export const useUpdates = Updates.use;

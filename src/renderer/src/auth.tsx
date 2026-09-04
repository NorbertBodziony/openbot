import type { AccountUsage, AvatarImageInput, CentralAuthState } from "@openbot/contracts/ipc";
import { createMemo, createSignal, createStore, flush, onCleanup, onSettled } from "solid-js";
import { desktopAnalytics } from "./analytics";
import { createSimpleContext } from "./simple-context";

/** How long the sign-in success animation holds the account out of the view. */
const AUTH_SUCCESS_HOLD_MS = 600;

/**
 * Analytics only carries codes the account service is known to send, so an
 * unrecognised one becomes `unknown` rather than leaking a new string into the
 * property vocabulary.
 */
function authFailureCode(value: string | undefined): string {
  switch (value) {
    case "auth_api_error":
    case "code_recently_sent":
    case "email_delivery_failed":
    case "email_delivery_not_configured":
    case "email_sign_in_failed":
    case "email_sign_in_start_failed":
    case "invalid_email":
    case "invalid_sign_in_code":
    case "rate_limited":
    case "sign_in_code_expired":
    case "too_many_code_attempts":
    case "unauthorized":
      return value;
    default:
      return "unknown";
  }
}

/**
 * The cloud account: sign-in state, the signed-in user, plan usage, and the
 * commands that change any of them.
 *
 * Ungated, against the plan's `centralAuth().status !== "loading"`. Two reasons,
 * and the second is decisive:
 *
 * - `"loading"` is not only a startup state. `retryCentralAccount` sets it
 *   deliberately, so a gate here would unmount the whole app - including the
 *   sign-in form whose Retry button was just pressed - and remount it when the
 *   retry resolved.
 * - `AccountLogin` is handed `centralAuth()` and renders the loading state
 *   itself, behind `AppAccessGate`'s own `<Show>`. A provider gate would
 *   withhold that placeholder too, leaving a blank window instead, and would
 *   serialize every bootstrap load that runs in parallel with `auth.getState()`
 *   today.
 *
 * The account is still a gate for the *view*; `visibleSignedInAccount` is what
 * `AppAccessGate` waits on, and it stays here.
 */
const Auth = createSimpleContext({
  name: "Auth",
  init: () => {
    const [centralAuth, setCentralAuth] = createSignal<CentralAuthState>({ status: "loading" });
    const [authSuccessVisible, setAuthSuccessVisible] = createSignal(false);
    const [accountUsageState, setAccountUsageState] = createStore<{
      targetKey: string | null;
      data: AccountUsage | null;
      refreshRevision: number;
    }>({ targetKey: null, data: null, refreshRevision: 0 });
    let accountUsageRequestGeneration = 0;
    let authSuccessTimer: ReturnType<typeof setTimeout> | undefined;

    onCleanup(() => {
      if (authSuccessTimer !== undefined) clearTimeout(authSuccessTimer);
    });

    /**
     * Every state change the account service reports, plus the two side effects
     * that ride along: the analytics identity, and the hold that keeps the
     * workspace out of view while the sign-in success animation plays. The hold
     * only starts on a completed code challenge, so a restart into an already
     * signed-in account goes straight to the workspace.
     */
    function applyCentralAuthState(state: CentralAuthState): void {
      desktopAnalytics.setUser(state.status === "signed_in" ? state.user : null);
      const completedCodeChallenge = centralAuth().status === "code_sent" && state.status === "signed_in";
      if (state.status !== "signed_in") {
        if (authSuccessTimer !== undefined) clearTimeout(authSuccessTimer);
        authSuccessTimer = undefined;
        setAuthSuccessVisible(false);
      } else if (completedCodeChallenge) {
        if (authSuccessTimer !== undefined) clearTimeout(authSuccessTimer);
        setAuthSuccessVisible(true);
        authSuccessTimer = setTimeout(() => {
          authSuccessTimer = undefined;
          setAuthSuccessVisible(false);
        }, AUTH_SUCCESS_HOLD_MS);
      }
      setCentralAuth(state);
    }

    onSettled(() => {
      const unsubscribe = window.openbot.auth.onEvent((state) => {
        flush(() => applyCentralAuthState(state));
      });
      // The bootstrap read sets the signal directly, not through
      // `applyCentralAuthState`: there is no earlier state to have completed a
      // code challenge against, so a restart into a signed-in account must not
      // play the success hold.
      void window.openbot.auth
        .getState()
        .then(setCentralAuth)
        .catch(() =>
          setCentralAuth({
            status: "error",
            issue: {
              code: "auth_unavailable",
              message: "OpenBot could not load the account service.",
            },
          }),
        );
      return unsubscribe;
    });

    async function requestEmailCode(email: string): Promise<void> {
      const analytics = desktopAnalytics.anonymousScope();
      try {
        const state = await window.openbot.auth.requestEmailCode(email);
        analytics.track("account_sign_in_started", {
          result: state.status === "code_sent" ? "code_sent" : "failed",
          ...(state.status === "error" ? { failure_code: authFailureCode(state.issue.code) } : {}),
        });
        applyCentralAuthState(state);
      } catch (error) {
        analytics.track("account_sign_in_started", {
          result: "failed",
          failure_code: "request_failed",
        });
        throw error;
      }
    }

    async function retryCentralAccount(): Promise<void> {
      applyCentralAuthState({ status: "loading" });
      applyCentralAuthState(await window.openbot.auth.retry());
    }

    async function verifyEmailCode(challengeId: string, code: string): Promise<void> {
      const anonymousAnalytics = desktopAnalytics.anonymousScope();
      try {
        const state = await window.openbot.auth.verifyEmailCode(challengeId, code);
        applyCentralAuthState(state);
        desktopAnalytics.track("account_sign_in_completed", {
          result: state.status === "signed_in" ? "succeeded" : "failed",
          ...("issue" in state ? { failure_code: authFailureCode(state.issue?.code) } : {}),
        });
      } catch (error) {
        anonymousAnalytics.track("account_sign_in_completed", {
          result: "failed",
          failure_code: "verification_failed",
        });
        throw error;
      }
    }

    async function logoutCentralAccount(): Promise<void> {
      const analytics = desktopAnalytics.scope();
      try {
        const state = await window.openbot.auth.logout();
        analytics.track("account_sign_out", { result: "succeeded" });
        applyCentralAuthState(state);
      } catch (error) {
        analytics.track("account_sign_out", {
          result: "failed",
          failure_code: "sign_out_failed",
        });
        throw error;
      }
    }

    async function updateAccountAvatar(image: AvatarImageInput | null): Promise<void> {
      applyCentralAuthState(await window.openbot.auth.updateAvatar(image));
    }

    async function updateAccountName(name: string): Promise<void> {
      applyCentralAuthState(await window.openbot.auth.updateName(name));
    }

    const accountUsage = () => accountUsageState.data;
    const accountUsageRefreshRevision = () => accountUsageState.refreshRevision;

    function selectAccountUsageTarget(targetKey: string | null): void {
      if (accountUsageState.targetKey === targetKey) return;
      accountUsageRequestGeneration += 1;
      setAccountUsageState((state) => {
        state.targetKey = targetKey;
        state.data = null;
      });
    }

    function invalidateAccountUsage(): void {
      accountUsageRequestGeneration += 1;
      setAccountUsageState((state) => {
        state.data = null;
        state.refreshRevision += 1;
      });
    }

    async function refreshAccountUsage(agentId: string, targetKey: string): Promise<AccountUsage> {
      selectAccountUsageTarget(targetKey);
      const generation = ++accountUsageRequestGeneration;
      const usage = await window.openbot.agent.getUsage(agentId);
      if (generation === accountUsageRequestGeneration && accountUsageState.targetKey === targetKey) {
        setAccountUsageState((state) => {
          state.data = usage;
        });
      }
      return usage;
    }

    function createMobileConnect() {
      return window.openbot.auth.createMobileConnect();
    }

    function listMobileConnectedDevices() {
      return window.openbot.auth.listMobileConnectedDevices();
    }

    function revokeMobileConnectedDevice(sessionId: string) {
      return window.openbot.auth.revokeMobileConnectedDevice(sessionId);
    }

    const signedInAccount = createMemo(() => {
      const state = centralAuth();
      return state.status === "signed_in" ? state.user : null;
    });
    /** Null while the success animation holds, so the workspace mounts after it. */
    const visibleSignedInAccount = createMemo(() => (authSuccessVisible() ? null : signedInAccount()));

    return {
      centralAuth,
      signedInAccount,
      visibleSignedInAccount,
      accountUsage,
      accountUsageRefreshRevision,
      selectAccountUsageTarget,
      invalidateAccountUsage,
      refreshAccountUsage,
      requestEmailCode,
      retryCentralAccount,
      verifyEmailCode,
      logoutCentralAccount,
      updateAccountName,
      updateAccountAvatar,
      createMobileConnect,
      listMobileConnectedDevices,
      revokeMobileConnectedDevice,
      listAccountSessions: () => window.openbot.auth.listAccountSessions(),
      revokeAccountSession: (sessionId: string) => window.openbot.auth.revokeAccountSession(sessionId),
    };
  },
});

export const AuthProvider = Auth.provider;
export const useAuth = Auth.use;

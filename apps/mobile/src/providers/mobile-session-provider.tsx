import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";

import { logoutMobileSession, type MobileSession, readMobileSession, validateMobileSession } from "@/lib/mobile-auth";

const SESSION_CHECK_INTERVAL_MS = 2_000;

interface MobileSessionContextValue {
  loading: boolean;
  session: MobileSession | null;
  connect: (session: MobileSession) => void;
  signOut: () => Promise<void>;
}

const MobileSessionContext = createContext<MobileSessionContextValue | null>(null);

export function MobileSessionProvider({ children }: PropsWithChildren) {
  const [sessionState, setSessionState] = useState<MobileSession | null | undefined>(undefined);
  const sessionRef = useRef<MobileSession | null>(null);

  const setCurrentSession = useCallback((session: MobileSession | null) => {
    sessionRef.current = session;
    setSessionState(session);
  }, []);

  useEffect(() => {
    let active = true;
    void readMobileSession()
      .then(async (stored) => {
        if (!active) return;
        if (!stored) {
          setCurrentSession(null);
          return;
        }
        try {
          const validated = await validateMobileSession(stored);
          if (active) setCurrentSession(validated);
        } catch {
          if (active) setCurrentSession(stored);
        }
      })
      .catch(() => {
        if (active) setCurrentSession(null);
      });
    return () => {
      active = false;
    };
  }, [setCurrentSession]);

  useEffect(() => {
    if (!sessionState) return;
    let active = true;
    let checking = false;
    let foreground = AppState.currentState === "active";

    async function checkSession(): Promise<void> {
      const current = sessionRef.current;
      if (!active || checking || !current) return;
      checking = true;
      try {
        const validated = await validateMobileSession(current);
        if (active && sessionRef.current?.sessionToken === current.sessionToken) {
          setCurrentSession(validated);
        }
      } catch {
        // A temporary network failure must not sign the user out locally.
      } finally {
        checking = false;
      }
    }

    const timer = setInterval(() => {
      if (foreground) void checkSession();
    }, SESSION_CHECK_INTERVAL_MS);
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      foreground = state === "active";
      if (foreground) void checkSession();
    });

    return () => {
      active = false;
      clearInterval(timer);
      appStateSubscription.remove();
    };
  }, [sessionState, setCurrentSession]);

  const signOut = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    setCurrentSession(null);
    try {
      await logoutMobileSession(current);
    } catch {
      // Local sign-out remains authoritative when the account service is unavailable.
    }
  }, [setCurrentSession]);

  const value = useMemo<MobileSessionContextValue>(
    () => ({
      loading: sessionState === undefined,
      session: sessionState ?? null,
      connect: setCurrentSession,
      signOut,
    }),
    [sessionState, setCurrentSession, signOut],
  );

  return <MobileSessionContext.Provider value={value}>{children}</MobileSessionContext.Provider>;
}

export function useMobileSession(): MobileSessionContextValue {
  const value = useContext(MobileSessionContext);
  if (!value) throw new Error("useMobileSession must be used within MobileSessionProvider.");
  return value;
}

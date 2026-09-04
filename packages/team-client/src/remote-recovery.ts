import type { ConversationSnapshot } from "@openbot/contracts/ipc";

export const REMOTE_RETRY_INTERVAL_MS = 10_000;
export const REMOTE_RETRY_LIMIT = 5;
export const REMOTE_RETRY_COOLDOWN_MS = 120_000;

export interface RemoteRecoveryStatus {
  phase: "connecting" | "waiting" | "cooldown" | "online";
  attempt: number;
  remainingSeconds: number;
}

export function remoteRecoveryMessage(status: RemoteRecoveryStatus): string | null {
  if (status.phase === "online") return null;
  if (status.phase === "cooldown") {
    const minutes = Math.floor(status.remainingSeconds / 60);
    const seconds = String(status.remainingSeconds % 60).padStart(2, "0");
    return `Connection failed after ${REMOTE_RETRY_LIMIT} attempts. Retrying in ${minutes}:${seconds}.`;
  }
  if (status.phase === "waiting") {
    const reason = status.attempt === 0 ? "Connection lost." : "Connection attempt failed.";
    return `${reason} Retrying in ${status.remainingSeconds}s.`;
  }
  return `Reconnecting ${status.attempt}/${REMOTE_RETRY_LIMIT}`;
}

/** One recovery attempt at a time. Background time never starts network work. */
export function createRemoteConnectionRecovery(
  connect: () => Promise<void>,
  onError: (error: unknown) => void,
  onStatus: (status: RemoteRecoveryStatus) => void = () => {},
) {
  let active = false;
  let disposed = false;
  let running = false;
  let retryRequested = false;
  let refreshRequested = false;
  let attempt = 0;
  let retryAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancelTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function scheduleRetry() {
    if (disposed) return;
    retryAt ??= Date.now() + (attempt >= REMOTE_RETRY_LIMIT ? REMOTE_RETRY_COOLDOWN_MS : REMOTE_RETRY_INTERVAL_MS);
    if (!active) return;
    const remaining = Math.max(0, retryAt - Date.now());
    if (remaining === 0 && !running) {
      retryAt = null;
      if (attempt >= REMOTE_RETRY_LIMIT) attempt = 0;
      void run();
      return;
    }
    onStatus({
      phase: attempt >= REMOTE_RETRY_LIMIT ? "cooldown" : "waiting",
      attempt,
      remainingSeconds: Math.ceil(remaining / 1000),
    });
    // Offline can arrive before the bridge finishes its command. Show the failure
    // immediately, but let run's finally start an overdue retry after cleanup.
    if (timer !== null || remaining === 0) return;
    // The one-second tick only updates the UI; network work starts at the deadline.
    timer = setTimeout(
      () => {
        timer = null;
        scheduleRetry();
      },
      Math.min(1000, remaining),
    );
  }

  async function run() {
    if (!active || disposed || running) return;
    cancelTimer();
    running = true;
    retryRequested = false;
    refreshRequested = false;
    attempt += 1;
    onStatus({ phase: "connecting", attempt, remainingSeconds: 0 });
    try {
      await connect();
    } catch (error) {
      if (!disposed) onError(error);
      retryRequested = true;
    } finally {
      running = false;
      if (retryRequested) scheduleRetry();
      else {
        attempt = 0;
        retryAt = null;
        if (!disposed) onStatus({ phase: "online", attempt: 0, remainingSeconds: 0 });
        if (refreshRequested) void run();
      }
    }
  }

  return {
    setActive(value: boolean) {
      if (active === value || disposed) return;
      active = value;
      cancelTimer();
      if (active) {
        if (running) refreshRequested = true;
        else if (retryAt !== null) scheduleRetry();
        else void run();
      }
    },
    offline() {
      retryRequested = true;
      scheduleRetry();
    },
    refresh() {
      if (running) refreshRequested = true;
      else if (retryAt !== null) scheduleRetry();
      else void run();
    },
    dispose() {
      disposed = true;
      cancelTimer();
    },
  };
}

/** Merge one server/page's read state without clearing unrelated cached unread IDs. */
export function mergeRemoteUnreadIds(current: string[], reads: Record<string, { unreadCount: number }>): string[] {
  return [
    ...current.filter((id) => !(id in reads)),
    ...Object.entries(reads)
      .filter(([, state]) => state.unreadCount > 0)
      .map(([id]) => id),
  ];
}

/** Only conversations cached for agents in this server need recovery. */
export async function resyncRemoteConversations(input: {
  botIds: string[];
  cached: Record<string, ConversationSnapshot>;
  load: (botId: string) => Promise<ConversationSnapshot>;
  apply: (snapshot: ConversationSnapshot) => void;
  isCurrent: () => boolean;
}): Promise<void> {
  for (const botId of input.botIds) {
    if (!input.isCurrent()) return;
    if (!input.cached[botId]) continue;
    const snapshot = await input.load(botId);
    if (!input.isCurrent()) return;
    input.apply(snapshot);
  }
}

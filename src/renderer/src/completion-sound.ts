import type { AgentEvent, AgentSummary } from "@openbot/contracts/ipc";

const COMPLETION_SOUND_STORAGE_KEY = "openbot:completion-sound-enabled";
const COMPLETION_SOUND_DURATION_SECONDS = 0.22;

let completionAudioContext: AudioContext | undefined;

type NotificationAgent = Pick<AgentSummary, "id" | "notifications">;
type PreferenceStorage = Pick<Storage, "getItem">;

export function shouldPlayCompletionSound(
  event: AgentEvent,
  agents: NotificationAgent[],
  storage: PreferenceStorage = window.localStorage,
): boolean {
  if (event.type !== "turn-completed" || event.status !== "completed") return false;
  if (storage.getItem(COMPLETION_SOUND_STORAGE_KEY) === "false") return false;
  return agents.some((agent) => agent.id === event.agentId && agent.notifications);
}

export function playCompletionSoundForAgentEvent(
  event: AgentEvent,
  agents: NotificationAgent[],
  storage: PreferenceStorage = window.localStorage,
): void {
  if (!shouldPlayCompletionSound(event, agents, storage)) return;
  void playCompletionSound();
}

async function playCompletionSound(): Promise<void> {
  try {
    completionAudioContext ??= new AudioContext();
    const context = completionAudioContext;
    if (context.state === "suspended") await context.resume();

    const startedAt = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(420, startedAt);
    oscillator.frequency.exponentialRampToValueAtTime(160, startedAt + 0.18);
    gain.gain.setValueAtTime(0.0001, startedAt);
    gain.gain.exponentialRampToValueAtTime(0.16, startedAt + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, startedAt + COMPLETION_SOUND_DURATION_SECONDS);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.addEventListener(
      "ended",
      () => {
        oscillator.disconnect();
        gain.disconnect();
      },
      { once: true },
    );
    oscillator.start(startedAt);
    oscillator.stop(startedAt + COMPLETION_SOUND_DURATION_SECONDS);
  } catch {
    completionAudioContext = undefined;
  }
}

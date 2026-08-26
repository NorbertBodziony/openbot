import type {
  AgentProviderId,
  AgentProviderState,
  AgentStatus,
  AppSetupState,
  BotAvatarHue,
  DesktopPlatform,
  MacPermissionId,
  MacPermissionsState,
} from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, untrack } from "solid-js";
import { AgentAvatar } from "./AgentAvatar";
import { PlusIcon } from "./conversation/ConversationIcons";
import { ProviderPicker, type ProviderPickerOption } from "./ProviderPicker";
import { Button } from "./ui";

interface OnboardingFlowProps {
  state: AppSetupState;
  agentStatus: AgentStatus;
  platform: DesktopPlatform;
  onSave: (provider: AgentProviderId) => Promise<void>;
}

type OnboardingStep = "meet" | "computer" | "jobs";
type StepDirection = "forward" | "back";

const PROVIDERS: Array<{ id: AgentProviderId; name: string }> = [
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude" },
  { id: "grok", name: "Grok" },
];

const PERMISSIONS: Array<{
  id: MacPermissionId;
  title: string;
  description: string;
}> = [
  {
    id: "screen-recording",
    title: "Screen Recording",
    description: "Let OpenBot see what is on your screen.",
  },
  {
    id: "accessibility",
    title: "Accessibility",
    description: "Let OpenBot control apps on your Mac.",
  },
];

const EMPTY_PERMISSIONS: MacPermissionsState = {
  screenRecording: "unknown",
  accessibility: "unknown",
};

const ONBOARDING_AVATAR_HUES: readonly BotAvatarHue[] = [0, 30, 55, 100, 150, 185, 215, 245, 280, 320];

type OnboardingAvatarVariant = {
  seed: string;
  hue: BotAvatarHue;
  cycleOffset: number;
  animationOffset: number;
};

type OnboardingAvatarVariants = {
  meet: OnboardingAvatarVariant;
  computer: OnboardingAvatarVariant;
  inbox: OnboardingAvatarVariant;
  weekly: OnboardingAvatarVariant;
  research: OnboardingAvatarVariant;
};

export function OnboardingFlow(props: OnboardingFlowProps) {
  const [step, setStep] = createSignal<OnboardingStep>("meet");
  const [direction, setDirection] = createSignal<StepDirection>("forward");
  const [selectedProvider, setSelectedProvider] = createSignal<AgentProviderId | null>(
    untrack(() => props.state.preferredProvider),
  );
  const [permissions, setPermissions] = createSignal(EMPTY_PERMISSIONS);
  const [permissionBusy, setPermissionBusy] = createSignal<MacPermissionId | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const avatarVariants = createOnboardingAvatarVariants();
  let permissionRevision = 0;

  const providerOptions = createMemo<ProviderPickerOption[]>(() =>
    PROVIDERS.map((provider) => {
      const status = props.agentStatus.providers?.find((candidate) => candidate.id === provider.id);
      return {
        ...provider,
        state: status?.state ?? fallbackProviderState(props.agentStatus),
        message: status?.message,
        email: status?.email,
      };
    }),
  );

  createEffect(
    () => ({
      options: providerOptions(),
      selected: selectedProvider(),
      preferredProvider: props.state.preferredProvider,
    }),
    ({ options, selected, preferredProvider }) => {
      if (selected && options.some((provider) => provider.id === selected)) return;
      const preferred = options.find((provider) => provider.id === preferredProvider);
      const available = options.find((provider) => provider.state === "available");
      setSelectedProvider(preferred?.id ?? available?.id ?? options[0]?.id ?? null);
    },
  );

  createEffect(
    () => ({ currentStep: step(), platform: props.platform }),
    ({ currentStep, platform }) => {
      if (currentStep === "computer" && platform === "darwin") void loadPermissions();
    },
  );

  onCleanup(() => {
    permissionRevision += 1;
  });

  async function loadPermissions(): Promise<void> {
    const revision = ++permissionRevision;
    try {
      const next = await window.openbot.getMacPermissions();
      if (revision === permissionRevision) setPermissions(next);
    } catch (cause) {
      if (revision === permissionRevision) setError(errorMessage(cause, "OpenBot could not read Mac permissions."));
    }
  }

  async function requestPermission(permission: MacPermissionId): Promise<void> {
    if (permissionBusy()) return;
    const revision = ++permissionRevision;
    setPermissionBusy(permission);
    setError("");
    try {
      const next = await window.openbot.requestMacPermission(permission);
      if (revision === permissionRevision) setPermissions(next);
    } catch (cause) {
      if (revision === permissionRevision) setError(errorMessage(cause, "OpenBot could not open this Mac permission."));
    } finally {
      setPermissionBusy(null);
    }
  }

  function moveTo(nextStep: OnboardingStep, nextDirection: StepDirection): void {
    setError("");
    setDirection(nextDirection);
    setStep(nextStep);
  }

  function nextStep(): void {
    if (step() === "meet") {
      if (!selectedProvider()) {
        setError("Choose a provider to continue.");
        return;
      }
      moveTo("computer", "forward");
      return;
    }
    if (step() === "computer") {
      moveTo("jobs", "forward");
      return;
    }
    void finish();
  }

  function previousStep(): void {
    if (step() === "computer") moveTo("meet", "back");
    else if (step() === "jobs") moveTo("computer", "back");
  }

  async function finish(): Promise<void> {
    const provider = selectedProvider();
    if (!provider || saving()) return;
    setSaving(true);
    setError("");
    try {
      await props.onSave(provider);
    } catch (cause) {
      setError(errorMessage(cause, "OpenBot could not finish setup."));
      setSaving(false);
    }
  }

  const stepNumber = () => (step() === "meet" ? 1 : step() === "computer" ? 2 : 3);

  return (
    <main class="onboarding-screen" data-step={step()} data-direction={direction()}>
      <div class="onboarding-shell">
        <nav class="onboarding-progress" aria-label={`Onboarding step ${stepNumber()} of 3`}>
          <For each={[1, 2, 3]}>
            {(item) => <span class={item === stepNumber() ? "is-active" : item < stepNumber() ? "is-complete" : ""} />}
          </For>
        </nav>

        <div class="onboarding-step" data-step={step()} data-direction={direction()}>
          <Switch>
            <Match when={step() === "meet"}>
              <section class="onboarding-panel onboarding-panel-meet" aria-labelledby="onboarding-title">
                <div class="onboarding-hero-avatar">
                  <AgentAvatar
                    seed={avatarVariants.meet.seed}
                    hue={avatarVariants.meet.hue}
                    motion="always"
                    cycleOffset={avatarVariants.meet.cycleOffset}
                    animationOffset={avatarVariants.meet.animationOffset}
                    class="onboarding-avatar-hero"
                  />
                </div>
                <h1 id="onboarding-title">Meet OpenBot</h1>
                <p class="onboarding-description">A team of Bots that works with you.</p>

                <section class="composer onboarding-composer" data-compact aria-label="Example task handoff">
                  <div class="composer-input-label">
                    <div class="composer-editor-root">
                      <span class="composer-editor-placeholder">Hand off any task to your team of Bots</span>
                    </div>
                  </div>
                  <div class="composer-toolbar">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      class="composer-button"
                      aria-label="Add to prompt"
                      disabled
                    >
                      <PlusIcon />
                    </Button>
                    <div class="composer-primary-actions">
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        class="voice-button"
                        aria-label="Send message"
                        disabled
                      >
                        ↑
                      </Button>
                    </div>
                  </div>
                </section>

                <div class="onboarding-provider">
                  <ProviderPicker
                    value={selectedProvider()}
                    options={providerOptions()}
                    ariaLabel="Default provider"
                    label="Choose your AI provider"
                    hint="You can change this for each bot later."
                    allowUnavailableSelection
                    focusFirst
                    disabled={saving()}
                    onChange={setSelectedProvider}
                  />
                </div>
              </section>
            </Match>

            <Match when={step() === "computer"}>
              <section class="onboarding-panel onboarding-panel-computer" aria-labelledby="onboarding-title">
                <h1 id="onboarding-title">OpenBot might control your computer</h1>

                <div class="onboarding-computer-visual" aria-hidden="true">
                  <svg viewBox="0 0 400 240" role="presentation">
                    <defs>
                      <linearGradient id="onboarding-computer-desktop-gradient" x1="0" y1="0" x2="1" y2="1">
                        <stop class="onboarding-computer-stop-mist" offset="0" />
                        <stop class="onboarding-computer-stop-blue" offset="0.56" />
                        <stop class="onboarding-computer-stop-indigo" offset="1" />
                      </linearGradient>
                      <radialGradient id="onboarding-computer-desktop-highlight" cx="0.18" cy="0.12" r="0.9">
                        <stop class="onboarding-computer-highlight-start" offset="0" />
                        <stop class="onboarding-computer-highlight-end" offset="1" />
                      </radialGradient>
                    </defs>
                    <rect
                      class="onboarding-computer-desktop"
                      x="12"
                      y="12"
                      width="376"
                      height="216"
                      rx="24"
                      fill="url(#onboarding-computer-desktop-gradient)"
                    />
                    <rect
                      class="onboarding-computer-desktop-highlight"
                      x="12"
                      y="12"
                      width="376"
                      height="216"
                      rx="24"
                      fill="url(#onboarding-computer-desktop-highlight)"
                    />
                    <path class="onboarding-computer-desktop-beam" d="M214 12h92l-78 216H112z" />
                    <g class="onboarding-computer-window">
                      <rect class="onboarding-computer-window-shadow" x="80" y="59" width="256" height="146" rx="14" />
                      <rect class="onboarding-computer-window-body" x="72" y="48" width="256" height="146" rx="14" />
                      <rect class="onboarding-computer-window-bar" x="72" y="48" width="256" height="30" rx="14" />
                      <rect class="onboarding-computer-window-bar-fill" x="72" y="63" width="256" height="15" />
                      <circle class="onboarding-computer-dot onboarding-computer-dot-danger" cx="91" cy="63" r="4" />
                      <circle class="onboarding-computer-dot onboarding-computer-dot-warning" cx="104" cy="63" r="4" />
                      <circle class="onboarding-computer-dot onboarding-computer-dot-success" cx="117" cy="63" r="4" />
                      <rect class="onboarding-computer-window-pane" x="90" y="94" width="64" height="78" rx="8" />
                      <rect class="onboarding-computer-window-card" x="170" y="94" width="138" height="14" rx="7" />
                      <rect class="onboarding-computer-window-line" x="170" y="122" width="108" height="7" rx="3.5" />
                      <rect
                        class="onboarding-computer-window-line onboarding-computer-window-line-short"
                        x="170"
                        y="139"
                        width="78"
                        height="7"
                        rx="3.5"
                      />
                      <rect class="onboarding-computer-window-card" x="170" y="161" width="118" height="10" rx="5" />
                    </g>
                    <g class="onboarding-computer-cursor">
                      <path d="M1.5 1.5v24.8l6.7-6.1 5.5 12.6 5.7-2.5-5.5-12.4h9.6z" />
                    </g>
                  </svg>
                  <div class="onboarding-computer-avatar">
                    <AgentAvatar
                      seed={avatarVariants.computer.seed}
                      hue={avatarVariants.computer.hue}
                      motion="idle"
                      animationOffset={avatarVariants.computer.animationOffset}
                      class="onboarding-computer-avatar-bot"
                    />
                  </div>
                </div>

                <Show when={props.platform === "darwin"}>
                  <section class="onboarding-permissions" aria-label="Computer permissions">
                    <div class="onboarding-permission-list">
                      <For each={PERMISSIONS}>
                        {(permission) => {
                          const state = () => permissionState(permissions(), permission.id);
                          return (
                            <div class="onboarding-permission-row">
                              <span>
                                <strong>{permission.title}</strong>
                                <small>{permission.description}</small>
                              </span>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                class="onboarding-permission-action"
                                disabled={
                                  permissionBusy() !== null || state() === "granted" || state() === "restricted"
                                }
                                onClick={() => void requestPermission(permission.id)}
                              >
                                {permissionBusy() === permission.id ? "Checking…" : permissionLabel(state())}
                              </Button>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </section>
                </Show>
              </section>
            </Match>

            <Match when={step() === "jobs"}>
              <section class="onboarding-panel onboarding-panel-jobs" aria-labelledby="onboarding-title">
                <h1 id="onboarding-title">Give each bot a job</h1>
                <p class="onboarding-description">Start with focused Bots, then build the team around your work.</p>

                <section class="onboarding-job-orbit" aria-label="Example bot jobs">
                  <article class="onboarding-job-card onboarding-job-card-top">
                    <AgentAvatar
                      seed={avatarVariants.inbox.seed}
                      hue={avatarVariants.inbox.hue}
                      motion="always"
                      cycleOffset={avatarVariants.inbox.cycleOffset}
                      animationOffset={avatarVariants.inbox.animationOffset}
                      class="onboarding-job-avatar"
                    />
                    <span>Inbox Triage</span>
                  </article>
                  <article class="onboarding-job-card onboarding-job-card-left">
                    <AgentAvatar
                      seed={avatarVariants.weekly.seed}
                      hue={avatarVariants.weekly.hue}
                      motion="always"
                      cycleOffset={avatarVariants.weekly.cycleOffset}
                      animationOffset={avatarVariants.weekly.animationOffset}
                      class="onboarding-job-avatar"
                    />
                    <span>Weekly Planning</span>
                  </article>
                  <article class="onboarding-job-card onboarding-job-card-right">
                    <AgentAvatar
                      seed={avatarVariants.research.seed}
                      hue={avatarVariants.research.hue}
                      motion="always"
                      cycleOffset={avatarVariants.research.cycleOffset}
                      animationOffset={avatarVariants.research.animationOffset}
                      class="onboarding-job-avatar"
                    />
                    <span>Research Digest</span>
                  </article>
                </section>
              </section>
            </Match>
          </Switch>
        </div>

        <Show when={error()}>
          <p class="onboarding-error" role="alert">
            {error()}
          </p>
        </Show>

        <div class="onboarding-actions">
          <Show when={step() !== "meet"}>
            <Button type="button" variant="outline" class="onboarding-back" disabled={saving()} onClick={previousStep}>
              Back
            </Button>
          </Show>
          <Button
            type="button"
            variant="default"
            class="onboarding-next"
            disabled={saving()}
            loading={saving()}
            loadingLabel="Opening OpenBot…"
            onClick={nextStep}
          >
            {step() === "jobs" ? "Open OpenBot" : "Next"}
          </Button>
        </div>
      </div>
    </main>
  );
}

function permissionState(
  permissions: MacPermissionsState,
  permission: MacPermissionId,
): MacPermissionsState["screenRecording"] {
  return permission === "screen-recording" ? permissions.screenRecording : permissions.accessibility;
}

function permissionLabel(
  state: MacPermissionsState["screenRecording"],
): "Allowed" | "Open Settings" | "Restricted" | "Allow" {
  if (state === "granted") return "Allowed";
  if (state === "denied" || state === "unknown") return "Open Settings";
  if (state === "restricted") return "Restricted";
  return "Allow";
}

function fallbackProviderState(status: AgentStatus): AgentProviderState {
  return status.phase === "starting" || status.phase === "restarting" ? "checking" : "error";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function createOnboardingAvatarVariants(): OnboardingAvatarVariants {
  const sessionSeed = `onboarding-${randomUnit().toString(36)}-${Date.now().toString(36)}`;
  const createVariant = (slot: string): OnboardingAvatarVariant => ({
    seed: `${sessionSeed}:${slot}:${randomUnit().toString(36)}`,
    hue: randomItem(ONBOARDING_AVATAR_HUES),
    cycleOffset: randomInt(12),
    animationOffset: randomUnit() * 2.4,
  });

  return {
    meet: createVariant("meet"),
    computer: createVariant("computer"),
    inbox: createVariant("inbox"),
    weekly: createVariant("weekly"),
    research: createVariant("research"),
  };
}

function randomItem<T>(items: readonly T[]): T {
  const item = items[randomInt(items.length)];
  if (item === undefined) throw new Error("The onboarding avatar list is empty.");
  return item;
}

function randomInt(maxExclusive: number): number {
  return Math.floor(randomUnit() * maxExclusive);
}

function randomUnit(): number {
  try {
    const values = new Uint32Array(1);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(values);
      return (values[0] ?? 0) / 0x1_0000_0000;
    }
  } catch {
    // Fall back to the browser's pseudo-random source when secure random values are unavailable.
  }
  return Math.random();
}

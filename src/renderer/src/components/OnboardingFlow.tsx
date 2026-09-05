import type {
  AgentProviderId,
  AgentProviderState,
  AgentStatus,
  AppSetupState,
  AvatarHue,
  DesktopPlatform,
  ProviderRuntimeStatus,
} from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { AgentAvatar } from "./AgentAvatar";
import { ComputerUseMacSetup } from "./ComputerUseMacSetup";
import { PlusIcon } from "./conversation/ConversationIcons";
import { ProviderPicker, type ProviderPickerOption } from "./ProviderPicker";
import { Button } from "./ui";

export interface OnboardingFlowProps {
  state: AppSetupState;
  agentStatus: AgentStatus;
  platform: DesktopPlatform;
  refreshingProviders?: boolean;
  providerRuntimeStatuses?: Partial<Record<AgentProviderId, ProviderRuntimeStatus>>;
  onConnectProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onDownloadProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onCancelProviderDownload?: (provider: AgentProviderId) => void | Promise<void>;
  onInstallProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onSignInProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onRefreshProviders?: () => void | Promise<void>;
  onSave: (provider: AgentProviderId) => Promise<void>;
}

type OnboardingStep = "meet" | "computer" | "jobs";
type StepDirection = "forward" | "back";

const PROVIDERS: Array<{ id: AgentProviderId; name: string; description: string }> = [
  { id: "codex", name: "ChatGPT", description: "Included with OpenBot" },
  { id: "claude", name: "Claude", description: "Included with OpenBot" },
  { id: "grok", name: "Grok", description: "Included with OpenBot" },
];

const ONBOARDING_AVATAR_HUES: readonly AvatarHue[] = [0, 30, 55, 100, 150, 185, 215, 245, 280, 320];

type OnboardingAvatarVariant = {
  seed: string;
  hue: AvatarHue;
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
  const [selectedProvider, setSelectedProvider] = createSignal<AgentProviderId | null>(null);
  const [providerSelectedByUser, setProviderSelectedByUser] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [providerErrors, setProviderErrors] = createSignal<Partial<Record<AgentProviderId, string>>>({});
  const visibleError = createMemo(
    () => error() || PROVIDERS.map((provider) => providerErrors()[provider.id]).find(Boolean) || "",
  );
  const avatarVariants = createOnboardingAvatarVariants();
  const previousConnectionStates = new Map<AgentProviderId, boolean>();
  const connectionStartingMessages = new Map<AgentProviderId, string | null>();
  const refreshedConnectionStates = new Set<AgentProviderId>();
  const providersAwaitingFocusRefresh = new Set<AgentProviderId>();
  let blurredAfterProviderConnect = false;
  let focusRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  const providerOptions = createMemo<ProviderPickerOption[]>(() =>
    PROVIDERS.map((provider) => {
      const status = props.agentStatus.providers?.find((candidate) => candidate.id === provider.id);
      const runtime = props.providerRuntimeStatuses?.[provider.id];
      return {
        ...provider,
        state: status?.state ?? fallbackProviderState(props.agentStatus),
        message: status?.message,
        email: status?.email,
        connectionState: status?.connectionState,
        checkError: status?.checkError,
        runtimeStatus:
          runtime?.phase === "not-downloaded" && (status?.state === "available" || status?.state === "sign-in-required")
            ? { ...runtime, phase: "ready", version: status.version }
            : runtime,
      };
    }),
  );
  const showsProviderSetup = () =>
    Boolean(
      props.onConnectProvider ||
        props.onDownloadProvider ||
        props.onCancelProviderDownload ||
        props.onInstallProvider ||
        props.onSignInProvider ||
        props.onRefreshProviders,
    );
  const lazyProviderMode = () => Boolean(props.providerRuntimeStatuses || props.onDownloadProvider);
  const selectedProviderConnected = createMemo(() => {
    const selected = selectedProvider();
    return Boolean(
      selected && providerOptions().some((provider) => provider.id === selected && provider.state === "available"),
    );
  });

  createEffect(
    () => ({
      options: providerOptions(),
      selected: selectedProvider(),
      selectedByUser: providerSelectedByUser(),
    }),
    ({ options, selected, selectedByUser }) => {
      if (selectedByUser && selected && options.some((provider) => provider.id === selected)) return;
      if (selected && options.some((provider) => provider.id === selected && provider.state === "available")) return;
      const available = options.find((provider) => provider.state === "available");
      setSelectedProvider(available?.id ?? null);
    },
  );

  createEffect(
    () => props.agentStatus.providers,
    (providers) => {
      for (const provider of PROVIDERS) {
        const status = providers?.find((candidate) => candidate.id === provider.id);
        const connecting = status?.connectionState === "connecting";
        const wasConnecting = previousConnectionStates.get(provider.id) ?? false;
        if (wasConnecting && !connecting) {
          const startingMessage = connectionStartingMessages.get(provider.id) ?? null;
          if (refreshedConnectionStates.delete(provider.id)) {
            setProviderErrors((current) => ({ ...current, [provider.id]: undefined }));
          } else {
            setProviderErrors((current) => ({
              ...current,
              [provider.id]: status?.message && status.message !== startingMessage ? status.message : undefined,
            }));
          }
          connectionStartingMessages.delete(provider.id);
          if (status?.state === "available") providersAwaitingFocusRefresh.delete(provider.id);
        }
        previousConnectionStates.set(provider.id, connecting);
      }
    },
  );

  const handleWindowBlur = (): void => {
    if (providersAwaitingFocusRefresh.size > 0) blurredAfterProviderConnect = true;
  };
  const handleWindowFocus = (): void => {
    if (!blurredAfterProviderConnect || providersAwaitingFocusRefresh.size === 0 || focusRefreshTimer) return;
    const synchronize = (): void => {
      focusRefreshTimer = undefined;
      if (props.refreshingProviders) {
        focusRefreshTimer = setTimeout(synchronize, 250);
        return;
      }
      providersAwaitingFocusRefresh.clear();
      blurredAfterProviderConnect = false;
      void refreshProviders();
    };
    focusRefreshTimer = setTimeout(synchronize, 250);
  };
  window.addEventListener("blur", handleWindowBlur);
  window.addEventListener("focus", handleWindowFocus);

  onCleanup(() => {
    window.removeEventListener("blur", handleWindowBlur);
    window.removeEventListener("focus", handleWindowFocus);
    if (focusRefreshTimer) clearTimeout(focusRefreshTimer);
  });

  async function openProviderGuide(
    provider: AgentProviderId,
    action: ((provider: AgentProviderId) => void | Promise<void>) | undefined,
    kind: "install" | "sign-in",
  ): Promise<void> {
    if (!action) return;
    setError("");
    try {
      await action(provider);
    } catch {
      const providerName = PROVIDERS.find((candidate) => candidate.id === provider)?.name ?? "provider";
      setError(
        `OpenBot could not open the ${kind === "install" ? "installation" : "sign-in"} guide for ${providerName}.`,
      );
    }
  }

  async function connectProvider(provider: AgentProviderId): Promise<void> {
    if (!props.onConnectProvider || props.refreshingProviders) return;
    setError("");
    setProviderErrors((current) => ({ ...current, [provider]: undefined }));
    providersAwaitingFocusRefresh.add(provider);
    refreshedConnectionStates.delete(provider);
    connectionStartingMessages.set(
      provider,
      props.agentStatus.providers?.find((candidate) => candidate.id === provider)?.message ?? null,
    );
    try {
      await props.onConnectProvider(provider);
    } catch {
      providersAwaitingFocusRefresh.delete(provider);
      const providerName = PROVIDERS.find((candidate) => candidate.id === provider)?.name ?? "provider";
      setError(`OpenBot could not connect ${providerName}. Try again.`);
    }
  }

  async function downloadProvider(provider: AgentProviderId): Promise<void> {
    if (!props.onDownloadProvider) return;
    setError("");
    setProviderSelectedByUser(true);
    setSelectedProvider(provider);
    try {
      await props.onDownloadProvider(provider);
    } catch {
      const providerName = PROVIDERS.find((candidate) => candidate.id === provider)?.name ?? "provider";
      setError(`OpenBot could not download ${providerName}. Try again.`);
    }
  }

  async function cancelProviderDownload(provider: AgentProviderId): Promise<void> {
    if (!props.onCancelProviderDownload) return;
    setError("");
    try {
      await props.onCancelProviderDownload(provider);
    } catch {
      const providerName = PROVIDERS.find((candidate) => candidate.id === provider)?.name ?? "provider";
      setError(`OpenBot could not cancel the ${providerName} download. Try again.`);
    }
  }

  async function refreshProviders(): Promise<void> {
    if (!props.onRefreshProviders || props.refreshingProviders) return;
    setError("");
    setProviderErrors({});
    for (const provider of PROVIDERS) {
      if (previousConnectionStates.get(provider.id)) refreshedConnectionStates.add(provider.id);
      previousConnectionStates.set(provider.id, false);
      connectionStartingMessages.delete(provider.id);
    }
    try {
      await props.onRefreshProviders();
    } catch {
      setError("OpenBot could not refresh your local AI providers. Try again.");
    }
  }

  function moveTo(nextStep: OnboardingStep, nextDirection: StepDirection): void {
    setError("");
    setProviderErrors({});
    setDirection(nextDirection);
    setStep(nextStep);
  }

  function nextStep(): void {
    if (!selectedProviderConnected()) {
      setError("Connect and select a provider to continue.");
      return;
    }
    if (step() === "meet") {
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
    if (!provider || !selectedProviderConnected() || saving()) return;
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
                <p class="onboarding-description">A team that works with you.</p>

                <section class="composer onboarding-composer" data-compact aria-label="Example task handoff">
                  <div class="composer-input-label">
                    <div class="composer-editor-root">
                      <span class="composer-editor-placeholder">Hand off any task to your team</span>
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
                    hint={
                      lazyProviderMode()
                        ? "Download, connect, and select a provider to continue."
                        : showsProviderSetup()
                          ? "Connect and select a provider to continue. Use Refresh after external account changes."
                          : "You can change this for each agent later."
                    }
                    allowUnavailableSelection
                    focusFirst
                    disabled={saving()}
                    refreshingProviders={props.refreshingProviders}
                    onConnectProvider={props.onConnectProvider ? connectProvider : undefined}
                    onDownloadProvider={props.onDownloadProvider ? downloadProvider : undefined}
                    onCancelProviderDownload={props.onCancelProviderDownload ? cancelProviderDownload : undefined}
                    onInstallProvider={
                      props.onInstallProvider
                        ? (provider) => openProviderGuide(provider, props.onInstallProvider, "install")
                        : undefined
                    }
                    onSignInProvider={
                      props.onSignInProvider
                        ? (provider) => openProviderGuide(provider, props.onSignInProvider, "sign-in")
                        : undefined
                    }
                    onRefreshProviders={!lazyProviderMode() && props.onRefreshProviders ? refreshProviders : undefined}
                    onChange={(provider) => {
                      setProviderSelectedByUser(true);
                      setSelectedProvider(provider);
                    }}
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
                      class="onboarding-computer-avatar-agent"
                    />
                  </div>
                </div>

                <ComputerUseMacSetup platform={props.platform} variant="compact" />
              </section>
            </Match>

            <Match when={step() === "jobs"}>
              <section class="onboarding-panel onboarding-panel-jobs" aria-labelledby="onboarding-title">
                <h1 id="onboarding-title">Give each agent a job</h1>
                <p class="onboarding-description">Start with focused agents, then build the team around your work.</p>

                <section class="onboarding-job-orbit" aria-label="Example agent jobs">
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

        <Show when={visibleError()}>
          <p class="onboarding-error" role="alert">
            {visibleError()}
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
            disabled={saving() || !selectedProviderConnected()}
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

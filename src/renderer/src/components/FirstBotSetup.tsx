import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AgentProviderId, AgentStatus, BotAvatarHue, ProviderRuntimeStatus } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { AVATAR_HUE_OPTIONS, avatarCandidateSeeds, avatarHeadColor, avatarHueSwatch } from "../bloub-avatar";
import { AgentAvatar } from "./AgentAvatar";
import { ProviderPicker, type ProviderPickerOption } from "./ProviderPicker";
import { Button, Field, Input, Textarea } from "./ui";

export interface FirstBotDraft {
  name: string;
  purpose: string;
  avatarSeed: string;
  avatarHue: BotAvatarHue | null;
  suggestionId: string | null;
}

export interface FirstBotSuggestion {
  id: string;
  name: string;
  description: string;
  purpose: string;
  avatarSeed: string;
  avatarHue: BotAvatarHue;
  animationCycleOffset: number;
  animationOffset: number;
}

export interface FirstBotSetupProps {
  value: FirstBotDraft;
  suggestions: FirstBotSuggestion[];
  mode?: "first" | "additional";
  submitting?: boolean;
  error?: string | null;
  providerSetup?: {
    agentStatus: AgentStatus;
    runtimeStatuses: Partial<Record<AgentProviderId, ProviderRuntimeStatus>>;
    onDownload: (provider: AgentProviderId) => void | Promise<void>;
    onCancel: (provider: AgentProviderId) => void | Promise<void>;
    onConnect: (provider: AgentProviderId) => void | Promise<void>;
  };
  onChange: (value: FirstBotDraft) => void;
  onSubmit: (value: FirstBotDraft) => void | Promise<void>;
  onCancel?: () => void;
}

export const FIRST_BOT_AVATAR_SEEDS = avatarCandidateSeeds("first-bot", "first-bot", 0);
const FIRST_BOT_HUE_OPTIONS = AVATAR_HUE_OPTIONS.filter((option) => option.hue !== 100 && option.hue !== 280);

const SUGGESTION_MOMENTUM_FRICTION = 0.88;
const SUGGESTION_MOMENTUM_MINIMUM = 0.01;
const SUGGESTION_MOMENTUM_MAXIMUM = 1.75;
const SUGGESTION_DRAG_THRESHOLD = 8;
const MOTION_FRAME_DURATION = 1000 / 60;

export const DEFAULT_FIRST_BOT_DRAFT: FirstBotDraft = {
  name: "New Bot",
  purpose: "",
  avatarSeed: FIRST_BOT_AVATAR_SEEDS[0] ?? "first-bot",
  avatarHue: null,
  suggestionId: null,
};

export function createFirstBotDraft(random: () => number = Math.random): FirstBotDraft {
  const index = Math.min(FIRST_BOT_AVATAR_SEEDS.length - 1, Math.floor(random() * FIRST_BOT_AVATAR_SEEDS.length));
  return {
    ...DEFAULT_FIRST_BOT_DRAFT,
    avatarSeed: FIRST_BOT_AVATAR_SEEDS[index] ?? DEFAULT_FIRST_BOT_DRAFT.avatarSeed,
  };
}

export const FIRST_BOT_SUGGESTIONS: FirstBotSuggestion[] = [
  {
    id: "inbox-helper",
    name: "Inbox Helper",
    description: "Drafts replies and keeps follow-ups from slipping.",
    purpose: "Draft clear email replies in my voice, summarize long threads, and keep track of follow-ups.",
    avatarSeed: FIRST_BOT_AVATAR_SEEDS[1] ?? "first-bot:inbox",
    avatarHue: 320,
    animationCycleOffset: 0,
    animationOffset: 0.15,
  },
  {
    id: "trip-planner",
    name: "Trip Planner",
    description: "Compares options and builds practical itineraries.",
    purpose: "Compare travel options and turn my rough ideas into practical, day-by-day itineraries.",
    avatarSeed: FIRST_BOT_AVATAR_SEEDS[2] ?? "first-bot:travel",
    avatarHue: 215,
    animationCycleOffset: 2,
    animationOffset: 0.65,
  },
  {
    id: "personal-organizer",
    name: "Personal Organizer",
    description: "Turns notes, errands, and tasks into a simple plan.",
    purpose: "Organize my notes, errands, and loose tasks into clear priorities and simple next steps.",
    avatarSeed: FIRST_BOT_AVATAR_SEEDS[3] ?? "first-bot:organizer",
    avatarHue: 55,
    animationCycleOffset: 4,
    animationOffset: 1.2,
  },
  {
    id: "shopping-scout",
    name: "Shopping Scout",
    description: "Compares products, prices, and reviews before I buy.",
    purpose: "Compare products, prices, and reviews so I can make practical buying decisions with less research.",
    avatarSeed: FIRST_BOT_AVATAR_SEEDS[4] ?? "first-bot:shopping",
    avatarHue: 150,
    animationCycleOffset: 6,
    animationOffset: 1.8,
  },
  {
    id: "writing-partner",
    name: "Writing Partner",
    description: "Drafts messages and documents in a natural voice.",
    purpose: "Help me draft and improve messages and documents while keeping the writing clear and natural.",
    avatarSeed: FIRST_BOT_AVATAR_SEEDS[5] ?? "first-bot:writing",
    avatarHue: 30,
    animationCycleOffset: 8,
    animationOffset: 2.45,
  },
  {
    id: "learning-coach",
    name: "Learning Coach",
    description: "Explains difficult topics and builds study plans.",
    purpose: "Explain difficult topics clearly and build study plans that match my pace and goals.",
    avatarSeed: FIRST_BOT_AVATAR_SEEDS[6] ?? "first-bot:learning",
    avatarHue: 245,
    animationCycleOffset: 10,
    animationOffset: 3.15,
  },
];

function matchesSuggestion(draft: FirstBotDraft, suggestion: FirstBotSuggestion): boolean {
  return (
    draft.name === suggestion.name &&
    draft.purpose === suggestion.purpose &&
    draft.avatarSeed === suggestion.avatarSeed &&
    draft.avatarHue === suggestion.avatarHue
  );
}

export function FirstBotSetup(props: FirstBotSetupProps) {
  let suggestionList: HTMLUListElement | undefined;
  let activeSuggestionPointer: number | null = null;
  let suggestionDragStartX = 0;
  let suggestionDragStartScrollLeft = 0;
  let suggestionDragPreviousX = 0;
  let suggestionDragPreviousTime = 0;
  let suggestionDragVelocity = 0;
  let suggestionDragMoved = false;
  let suppressSuggestionClick = false;
  let suggestionMomentumFrame: number | null = null;
  const [canScrollSuggestionsBack, setCanScrollSuggestionsBack] = createSignal(false);
  const [canScrollSuggestionsForward, setCanScrollSuggestionsForward] = createSignal(false);
  const [draggingSuggestions, setDraggingSuggestions] = createSignal(false);
  const [selectedProvider, setSelectedProvider] = createSignal<AgentProviderId | null>(null);
  const providerOptions = createMemo<ProviderPickerOption[]>(() =>
    (["codex", "claude", "grok"] as const).map((provider) => {
      const agent = props.providerSetup?.agentStatus.providers?.find((candidate) => candidate.id === provider);
      const runtime = props.providerSetup?.runtimeStatuses[provider];
      return {
        id: provider,
        name: provider === "codex" ? "ChatGPT" : provider === "claude" ? "Claude" : "Grok",
        description: "Available on this computer",
        state: agent?.state ?? "not-installed",
        message: agent?.message,
        email: agent?.email,
        connectionState: agent?.connectionState,
        checkError: agent?.checkError,
        runtimeStatus:
          runtime?.phase === "not-downloaded" && (agent?.state === "available" || agent?.state === "sign-in-required")
            ? { ...runtime, phase: "ready", version: agent.version }
            : runtime,
      };
    }),
  );
  createEffect(
    () => providerOptions().find((provider) => provider.state === "available")?.id ?? null,
    (connectedProvider) => {
      if (!selectedProvider() && connectedProvider) setSelectedProvider(connectedProvider);
    },
  );
  const providerConnected = () =>
    !props.providerSetup ||
    providerOptions().some((provider) => provider.id === selectedProvider() && provider.state === "available");
  const canSubmit = () =>
    Boolean(props.value.name.trim() && props.value.purpose.trim()) && providerConnected() && !props.submitting;
  const displayName = () => props.value.name.trim() || "New Bot";

  function updateSuggestionFades(): void {
    if (!suggestionList) return;
    const maximumScroll = Math.max(0, suggestionList.scrollWidth - suggestionList.clientWidth);
    setCanScrollSuggestionsBack(suggestionList.scrollLeft > 1);
    setCanScrollSuggestionsForward(suggestionList.scrollLeft < maximumScroll - 1);
  }

  function stopSuggestionMomentum(): void {
    if (suggestionMomentumFrame === null) return;
    cancelAnimationFrame(suggestionMomentumFrame);
    suggestionMomentumFrame = null;
  }

  function startSuggestionMomentum(): void {
    if (
      !suggestionList ||
      Math.abs(suggestionDragVelocity) < SUGGESTION_MOMENTUM_MINIMUM ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    let previousFrameTime = performance.now();
    const move = (frameTime: number) => {
      if (!suggestionList) return;
      const elapsed = Math.min(frameTime - previousFrameTime, MOTION_FRAME_DURATION * 2);
      previousFrameTime = frameTime;
      const previousScrollLeft = suggestionList.scrollLeft;
      suggestionList.scrollLeft += suggestionDragVelocity * elapsed;
      suggestionDragVelocity *= SUGGESTION_MOMENTUM_FRICTION ** (elapsed / MOTION_FRAME_DURATION);
      updateSuggestionFades();

      const reachedEdge = Math.abs(suggestionList.scrollLeft - previousScrollLeft) < 0.1;
      if (!reachedEdge && Math.abs(suggestionDragVelocity) >= SUGGESTION_MOMENTUM_MINIMUM) {
        suggestionMomentumFrame = requestAnimationFrame(move);
      } else {
        suggestionMomentumFrame = null;
      }
    };

    suggestionMomentumFrame = requestAnimationFrame(move);
  }

  onSettled(() => {
    updateSuggestionFades();
    const observer = new ResizeObserver(updateSuggestionFades);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || props.mode !== "additional" || props.submitting || !props.onCancel) return;
      event.preventDefault();
      props.onCancel();
    };
    const list = suggestionList;
    if (list) observer.observe(list);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", closeOnEscape);
      stopSuggestionMomentum();
    };
  });

  function startSuggestionDrag(event: PointerEvent): void {
    if (props.submitting || event.button !== 0 || !suggestionList) return;
    stopSuggestionMomentum();
    activeSuggestionPointer = event.pointerId;
    suggestionDragStartX = event.clientX;
    suggestionDragStartScrollLeft = suggestionList.scrollLeft;
    suggestionDragPreviousX = event.clientX;
    suggestionDragPreviousTime = event.timeStamp;
    suggestionDragVelocity = 0;
    suggestionDragMoved = false;
  }

  function moveSuggestionDrag(event: PointerEvent): void {
    if (event.pointerId !== activeSuggestionPointer || !suggestionList) return;
    const distance = event.clientX - suggestionDragStartX;
    if (!suggestionDragMoved && Math.abs(distance) > SUGGESTION_DRAG_THRESHOLD) {
      suggestionDragMoved = true;
      setDraggingSuggestions(true);
      suggestionList.setPointerCapture(event.pointerId);
    }
    if (!suggestionDragMoved) return;
    event.preventDefault();
    const elapsed = Math.max(1, event.timeStamp - suggestionDragPreviousTime);
    const immediateVelocity = Math.max(
      -SUGGESTION_MOMENTUM_MAXIMUM,
      Math.min(SUGGESTION_MOMENTUM_MAXIMUM, (suggestionDragPreviousX - event.clientX) / elapsed),
    );
    suggestionDragVelocity = suggestionDragVelocity * 0.65 + immediateVelocity * 0.35;
    suggestionDragPreviousX = event.clientX;
    suggestionDragPreviousTime = event.timeStamp;
    suggestionList.scrollLeft = suggestionDragStartScrollLeft - distance;
    updateSuggestionFades();
  }

  function finishSuggestionDrag(event: PointerEvent): void {
    if (event.pointerId !== activeSuggestionPointer || !suggestionList) return;
    if (suggestionList.hasPointerCapture(event.pointerId)) suggestionList.releasePointerCapture(event.pointerId);
    suppressSuggestionClick = suggestionDragMoved;
    activeSuggestionPointer = null;
    suggestionDragMoved = false;
    setDraggingSuggestions(false);
    if (suppressSuggestionClick && event.type === "pointerup") startSuggestionMomentum();
    window.setTimeout(() => {
      suppressSuggestionClick = false;
    }, 0);
  }

  function updateDraft(updates: Partial<FirstBotDraft>): void {
    if (props.submitting) return;
    const next = { ...props.value, ...updates };
    const selected = props.suggestions.find((suggestion) => suggestion.id === next.suggestionId);
    props.onChange({
      ...next,
      suggestionId: selected && matchesSuggestion(next, selected) ? selected.id : null,
    });
  }

  function selectSuggestion(suggestion: FirstBotSuggestion): void {
    if (props.submitting) return;
    props.onChange({
      name: suggestion.name,
      purpose: suggestion.purpose,
      avatarSeed: suggestion.avatarSeed,
      avatarHue: suggestion.avatarHue,
      suggestionId: suggestion.id,
    });
  }

  return (
    <main class="conversation-panel first-bot-setup-panel" aria-labelledby="first-bot-setup-title">
      <header class="window-drag first-bot-setup-header">
        <div
          class="first-bot-header-identity"
          data-avatar-seed={props.value.avatarSeed}
          data-avatar-hue={props.value.avatarHue ?? "automatic"}
        >
          <AgentAvatar seed={props.value.avatarSeed} hue={props.value.avatarHue} motion="idle" />
          <h1 aria-live="polite">{displayName()}</h1>
        </div>
        <Show when={props.mode === "additional" && props.onCancel}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="first-bot-cancel no-drag"
            disabled={props.submitting}
            onClick={() => props.onCancel?.()}
          >
            Cancel
          </Button>
        </Show>
      </header>

      <div class="first-bot-setup-content">
        <form
          class="first-bot-editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit()) void props.onSubmit(props.value);
          }}
        >
          <h2 id="first-bot-setup-title" class="sr-only">
            {props.mode === "additional" ? "Create a new Bot" : "Create your first Bot"}
          </h2>

          <div
            class="first-bot-live-avatar"
            data-avatar-seed={props.value.avatarSeed}
            data-avatar-hue={props.value.avatarHue ?? "automatic"}
          >
            <AgentAvatar
              seed={props.value.avatarSeed}
              hue={props.value.avatarHue}
              motion="idle"
              animationOffset={0.4}
            />
          </div>

          <fieldset class="first-bot-avatar-fieldset first-bot-color-fieldset" disabled={props.submitting}>
            <legend class="sr-only">Bot color</legend>
            <div class="first-bot-color-options">
              <Button
                variant="ghost"
                type="button"
                size="sm"
                class="first-bot-color-choice"
                aria-label="Automatic Bot color"
                aria-pressed={props.value.avatarHue === null ? "true" : "false"}
                onClick={() => updateDraft({ avatarHue: null })}
              >
                <span
                  class="first-bot-color-swatch"
                  style={{ background: avatarHeadColor(props.value.avatarSeed, null) }}
                />
              </Button>
              <For each={FIRST_BOT_HUE_OPTIONS}>
                {(option) => (
                  <Button
                    variant="ghost"
                    type="button"
                    size="sm"
                    class="first-bot-color-choice"
                    aria-label={`${option.label} Bot color`}
                    aria-pressed={props.value.avatarHue === option.hue ? "true" : "false"}
                    onClick={() => updateDraft({ avatarHue: option.hue })}
                  >
                    <span class="first-bot-color-swatch" style={{ background: avatarHueSwatch(option.hue) }} />
                  </Button>
                )}
              </For>
            </div>
          </fieldset>

          <fieldset class="first-bot-avatar-fieldset first-bot-face-fieldset" disabled={props.submitting}>
            <legend class="sr-only">Bot face</legend>
            <div class="first-bot-face-options">
              <For each={FIRST_BOT_AVATAR_SEEDS}>
                {(seed, index) => (
                  <Button
                    variant="ghost"
                    type="button"
                    size="sm"
                    class="first-bot-face-choice"
                    aria-label={`Bot face ${index() + 1}`}
                    aria-pressed={props.value.avatarSeed === seed ? "true" : "false"}
                    onClick={() => updateDraft({ avatarSeed: seed })}
                  >
                    <AgentAvatar
                      seed={seed}
                      hue={props.value.avatarHue}
                      motion="idle"
                      animationOffset={index() * 0.16}
                    />
                  </Button>
                )}
              </For>
            </div>
          </fieldset>

          <div class="first-bot-fields">
            <Field label="Name" required>
              <Input
                value={props.value.name}
                maxlength={INPUT_LIMITS.agentName}
                autocomplete="off"
                disabled={props.submitting}
                onValueChange={(name) => updateDraft({ name })}
              />
            </Field>
            <Field label="What should this Bot help with?" required>
              <Textarea
                value={props.value.purpose}
                rows={2}
                maxlength={INPUT_LIMITS.agentDescription}
                placeholder="Plan trips, compare options, or help with everyday work."
                disabled={props.submitting}
                onValueChange={(purpose) => updateDraft({ purpose })}
              />
            </Field>
          </div>

          <Show when={props.providerSetup}>
            {(setup) => (
              <ProviderPicker
                value={selectedProvider()}
                options={providerOptions()}
                ariaLabel="AI provider for this Bot"
                label="AI provider"
                embedded
                allowUnavailableSelection
                onChange={setSelectedProvider}
                onDownloadProvider={(provider) => {
                  setSelectedProvider(provider);
                  return setup().onDownload(provider);
                }}
                onCancelProviderDownload={setup().onCancel}
                onConnectProvider={setup().onConnect}
              />
            )}
          </Show>

          <Show when={props.error}>
            {(error) => (
              <p class="first-bot-error" role="alert">
                {error()}
              </p>
            )}
          </Show>

          <div class="first-bot-submit-actions">
            <Button
              type="submit"
              variant="default"
              size="default"
              class="first-bot-submit"
              disabled={!canSubmit()}
              loading={props.submitting}
              loadingLabel="Creating Bot…"
            >
              Create Bot
            </Button>
          </div>
        </form>

        <section class="first-bot-suggestions" aria-labelledby="first-bot-suggestions-title">
          <h2 id="first-bot-suggestions-title">Suggestions</h2>
          <div
            class={`first-bot-suggestion-viewport${canScrollSuggestionsBack() ? " can-scroll-back" : ""}${canScrollSuggestionsForward() ? " can-scroll-forward" : ""}${draggingSuggestions() ? " is-dragging" : ""}`}
          >
            <ul
              ref={suggestionList}
              class="first-bot-suggestion-list"
              onScroll={updateSuggestionFades}
              onPointerDown={startSuggestionDrag}
              onPointerMove={moveSuggestionDrag}
              onPointerUp={finishSuggestionDrag}
              onPointerCancel={finishSuggestionDrag}
            >
              <For each={props.suggestions}>
                {(suggestion) => (
                  <li class="first-bot-suggestion-item">
                    <Button
                      variant="ghost"
                      type="button"
                      class="first-bot-suggestion-card"
                      data-animation-cycle-offset={suggestion.animationCycleOffset}
                      data-animation-offset={suggestion.animationOffset}
                      aria-label={`${suggestion.name}. ${suggestion.description}`}
                      aria-pressed={props.value.suggestionId === suggestion.id ? "true" : "false"}
                      disabled={props.submitting}
                      onClick={() => {
                        if (!suppressSuggestionClick) selectSuggestion(suggestion);
                      }}
                    >
                      <AgentAvatar
                        seed={suggestion.avatarSeed}
                        hue={suggestion.avatarHue}
                        motion="always"
                        cycleOffset={suggestion.animationCycleOffset}
                        animationOffset={suggestion.animationOffset}
                      />
                      <span>
                        <strong>{suggestion.name}</strong>
                        <small>{suggestion.description}</small>
                      </span>
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </section>
      </div>
    </main>
  );
}

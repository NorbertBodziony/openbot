import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type {
  AgentModelId,
  AgentModelOption,
  AgentProviderId,
  AgentProviderStatus,
  AgentStatus,
} from "../../../shared/ipc";
import { isClaudeModel } from "../../../shared/ipc";

interface ProviderModelPickerProps {
  value: AgentModelId;
  modelOptions: AgentModelOption[];
  agentStatus: AgentStatus;
  variant?: "pill" | "field";
  ariaLabel?: string;
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (model: AgentModelId) => void;
}

const PROVIDERS: AgentProviderId[] = ["claude", "codex"];
const DEFAULT_MODELS: Record<AgentProviderId, AgentModelId> = {
  claude: "claude-opus-5",
  codex: "gpt-5.6-luna",
};

export function ProviderModelPicker(props: ProviderModelPickerProps) {
  const [open, setOpen] = createSignal(false);
  const [railProvider, setRailProvider] = createSignal<AgentProviderId>(
    providerForModel(props.value),
  );
  const providerButtons = new Map<AgentProviderId, HTMLButtonElement>();
  const modelButtons = new Map<AgentModelId, HTMLButtonElement>();
  let root: HTMLDivElement | undefined;

  const selectedModel = createMemo(() =>
    props.modelOptions.find((option) => option.id === props.value),
  );
  const activeProvider = createMemo(() => providerForModel(props.value));
  const railModels = createMemo(() =>
    props.modelOptions.filter((option) => providerForModel(option.id) === railProvider()),
  );
  const railStatus = createMemo(() =>
    providerAvailability(props.agentStatus, props.modelOptions, railProvider()),
  );
  const railAvailable = createMemo(() => railStatus().state === "available");

  createEffect(() => {
    const provider = activeProvider();
    if (!open()) setRailProvider(provider);
  });

  createEffect(() => {
    if (props.disabled && open()) setOpen(false);
  });

  onMount(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!open() || root?.contains(event.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    onCleanup(() => window.removeEventListener("pointerdown", closeOnOutsidePointer));
  });

  function setPickerOpen(next: boolean): void {
    if (props.disabled) return;
    if (next) setRailProvider(activeProvider());
    setOpen(next);
  }

  function focusModel(model?: AgentModelId): void {
    requestAnimationFrame(() => {
      const preferred = model ? modelButtons.get(model) : undefined;
      (preferred ?? modelButtons.get(railModels()[0]?.id ?? props.value))?.focus();
    });
  }

  function moveProvider(delta: number): void {
    const current = PROVIDERS.indexOf(railProvider());
    const provider = PROVIDERS[(current + delta + PROVIDERS.length) % PROVIDERS.length];
    if (!provider) return;
    setRailProvider(provider);
    providerButtons.get(provider)?.focus();
  }

  function moveModel(model: AgentModelId, delta: number): void {
    if (!railAvailable()) return;
    const models = railModels();
    const current = models.findIndex((option) => option.id === model);
    const next = models[(current + delta + models.length) % models.length];
    if (next) modelButtons.get(next.id)?.focus();
  }

  function selectModel(model: AgentModelId): void {
    if (!railAvailable()) return;
    setOpen(false);
    props.onChange(model);
  }

  const triggerModelName = () => displayModelName(selectedModel()?.name, props.value);
  const field = () => props.variant === "field";

  return (
    <div
      ref={(element) => (root = element)}
      class="provider-model-picker"
      classList={{ "provider-model-picker-field": field() }}
    >
      <button
        type="button"
        class="provider-model-trigger"
        classList={{ "provider-model-trigger-field": field() }}
        aria-label={`${props.ariaLabel ?? "Agent model"}: ${triggerModelName()}`}
        aria-haspopup="dialog"
        aria-expanded={open()}
        disabled={props.disabled}
        title={
          props.disabled
            ? props.disabledReason
            : `${providerName(activeProvider())} · ${triggerModelName()}`
        }
        onClick={() => setPickerOpen(!open())}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open()) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            return;
          }
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setPickerOpen(true);
          focusModel(props.value);
        }}
      >
        <Show when={field()}>
          <span class="provider-model-field-label">{props.label ?? "Model"}</span>
        </Show>
        <span class="provider-model-trigger-value">
          <ProviderMark provider={activeProvider()} />
          <span class="provider-model-trigger-name">{triggerModelName()}</span>
        </span>
        <ChevronDownIcon />
      </button>

      <Show when={open()}>
        <div
          class="provider-model-popover"
          role="dialog"
          aria-label="Choose agent model"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }}
        >
          <div
            class="provider-model-rail"
            role="tablist"
            aria-label="Model providers"
            aria-orientation="vertical"
          >
            <For each={PROVIDERS}>
              {(provider) => {
                const status = () =>
                  providerAvailability(props.agentStatus, props.modelOptions, provider);
                const selected = () => railProvider() === provider;
                return (
                  <button
                    ref={(element) => providerButtons.set(provider, element)}
                    type="button"
                    role="tab"
                    class="provider-model-rail-button"
                    classList={{
                      "provider-model-rail-button-selected": selected(),
                      "provider-model-rail-button-unavailable": status().state !== "available",
                    }}
                    aria-selected={selected()}
                    aria-controls="provider-model-panel"
                    aria-label={`${providerName(provider)}: ${providerSummary(provider, status())}`}
                    tabIndex={selected() ? 0 : -1}
                    title={`${providerName(provider)} · ${providerSummary(provider, status())}`}
                    onClick={() => setRailProvider(provider)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                        event.preventDefault();
                        moveProvider(1);
                      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                        event.preventDefault();
                        moveProvider(-1);
                      }
                    }}
                  >
                    <ProviderMark provider={provider} large />
                  </button>
                );
              }}
            </For>
          </div>

          <div
            id="provider-model-panel"
            class="provider-model-panel"
            role="tabpanel"
            aria-label={`${providerName(railProvider())} models`}
          >
            <div class="provider-model-heading">
              <strong>{providerName(railProvider())}</strong>
              <span>{providerSummary(railProvider(), railStatus())}</span>
            </div>
            <div
              class="provider-model-list"
              role="listbox"
              aria-label={`${providerName(railProvider())} models`}
            >
              <For each={railModels()}>
                {(model, index) => {
                  const selected = () => props.value === model.id;
                  const firstFocusable = () =>
                    railAvailable() &&
                    (selected() ||
                      (!railModels().some((option) => option.id === props.value) && index() === 0));
                  return (
                    <button
                      ref={(element) => modelButtons.set(model.id, element)}
                      type="button"
                      role="option"
                      class="provider-model-option"
                      classList={{ "provider-model-option-selected": selected() }}
                      aria-label={`${displayModelName(model.name, model.id)}${
                        model.id === DEFAULT_MODELS[railProvider()] ? ", default" : ""
                      }`}
                      aria-selected={selected()}
                      disabled={!railAvailable()}
                      tabIndex={firstFocusable() ? 0 : -1}
                      onClick={() => selectModel(model.id)}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          moveModel(model.id, 1);
                        } else if (event.key === "ArrowUp") {
                          event.preventDefault();
                          moveModel(model.id, -1);
                        } else if (event.key === "Home") {
                          event.preventDefault();
                          modelButtons.get(railModels()[0]?.id ?? model.id)?.focus();
                        } else if (event.key === "End") {
                          event.preventDefault();
                          modelButtons.get(railModels().at(-1)?.id ?? model.id)?.focus();
                        }
                      }}
                    >
                      <span class="provider-model-option-name">
                        <span>{displayModelName(model.name, model.id)}</span>
                        <Show when={model.id === DEFAULT_MODELS[railProvider()]}>
                          <small>default</small>
                        </Show>
                      </span>
                      <Show when={selected()}>
                        <CheckIcon />
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}

function providerAvailability(
  status: AgentStatus,
  models: AgentModelOption[],
  provider: AgentProviderId,
): AgentProviderStatus {
  const explicit = status.providers?.find((item) => item.id === provider);
  if (explicit) return explicit;
  if (status.phase === "starting" || status.phase === "restarting") {
    return { id: provider, state: "checking", version: null, message: null };
  }
  const available = models.some((model) => providerForModel(model.id) === provider);
  return {
    id: provider,
    state: available ? "available" : "error",
    version: null,
    message: available ? null : `${providerName(provider)} is unavailable.`,
  };
}

function providerSummary(provider: AgentProviderId, status: AgentProviderStatus): string {
  if (status.state === "available") {
    return status.version
      ? `${status.version} (${provider === "claude" ? "Claude Code" : "Codex CLI"})`
      : `${provider === "claude" ? "Claude Code" : "Codex CLI"} ready`;
  }
  return status.message ?? providerStatusLabel(status.state);
}

function providerStatusLabel(state: AgentProviderStatus["state"]): string {
  if (state === "sign-in-required") return "Sign in required";
  if (state === "not-installed") return "Not installed";
  if (state === "outdated") return "Update required";
  if (state === "error") return "Unavailable";
  return "Checking";
}

function providerName(provider: AgentProviderId): string {
  return provider === "claude" ? "Claude" : "Codex";
}

function providerForModel(model: AgentModelId): AgentProviderId {
  return isClaudeModel(model) ? "claude" : "codex";
}

function displayModelName(name: string | undefined, fallback: string): string {
  return name?.replace(/^[\s:–—-]+/, "") || fallback;
}

function ProviderMark(props: { provider: AgentProviderId; large?: boolean }) {
  if (props.provider === "claude") {
    return (
      <svg
        class="provider-model-mark provider-model-mark-claude"
        classList={{ "provider-model-mark-large": props.large }}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M19.07 4.93 4.93 19.07M8.17 2.91l7.66 18.18M2.91 8.17l18.18 7.66M15.83 2.91 8.17 21.09M21.09 8.17 2.91 15.83" />
      </svg>
    );
  }
  return (
    <svg
      class="provider-model-mark provider-model-mark-codex"
      classList={{ "provider-model-mark-large": props.large }}
      viewBox="0 0 256 260"
      aria-hidden="true"
    >
      <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg class="provider-model-chevron" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg class="provider-model-check" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3 8.25 3.1 3.1L13 4.8" />
    </svg>
  );
}

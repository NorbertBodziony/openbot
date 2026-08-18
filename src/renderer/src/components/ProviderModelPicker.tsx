import type {
  AgentModelId,
  AgentModelOption,
  AgentProviderId,
  AgentProviderStatus,
  AgentStatus,
} from "@openbot/contracts/ipc";
import { isClaudeModel } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";

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
    untrack(() => providerForModel(props.value)),
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

  createEffect(
    () => ({ provider: activeProvider(), open: open() }),
    ({ provider, open }) => {
      if (!open) setRailProvider(provider);
    },
  );

  createEffect(
    () => Boolean(props.disabled && open()),
    (mustClose) => {
      if (mustClose) setOpen(false);
    },
  );

  onSettled(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!open() || root?.contains(event.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
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
      class={["provider-model-picker", { "provider-model-picker-field": field() }]}
    >
      <button
        type="button"
        class={["provider-model-trigger", { "provider-model-trigger-field": field() }]}
        aria-label={`${props.ariaLabel ?? "Agent model"}: ${triggerModelName()}`}
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
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
                    class={[
                      "provider-model-rail-button",
                      {
                        "provider-model-rail-button-selected": selected(),
                        "provider-model-rail-button-unavailable": status().state !== "available",
                      },
                    ]}
                    aria-selected={selected() ? "true" : "false"}
                    aria-controls="provider-model-panel"
                    aria-label={`${providerName(provider)}: ${providerSummary(provider, status())}`}
                    tabindex={selected() ? 0 : -1}
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
                      class={[
                        "provider-model-option",
                        { "provider-model-option-selected": selected() },
                      ]}
                      aria-label={`${displayModelName(model.name, model.id)}${
                        model.id === DEFAULT_MODELS[railProvider()] ? ", default" : ""
                      }`}
                      aria-selected={selected() ? "true" : "false"}
                      disabled={!railAvailable()}
                      tabindex={firstFocusable() ? 0 : -1}
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
  return (
    <Show
      when={props.provider === "claude"}
      fallback={
        <svg
          class={[
            "provider-model-mark provider-model-mark-codex",
            { "provider-model-mark-large": Boolean(props.large) },
          ]}
          viewBox="0 0 256 260"
          aria-hidden="true"
        >
          <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
        </svg>
      }
    >
      <svg
        class={[
          "provider-model-mark provider-model-mark-claude",
          { "provider-model-mark-large": Boolean(props.large) },
        ]}
        viewBox="0 0 248 248"
        aria-hidden="true"
      >
        <path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" />
      </svg>
    </Show>
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

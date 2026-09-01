import { ProviderLogo } from "@openbot/brand";
import type {
  AgentModelId,
  AgentModelOption,
  AgentProviderId,
  AgentProviderStatus,
  AgentReasoningEffort,
  AgentStatus,
  ProviderRuntimeStatus,
} from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";
import {
  Button,
  Listbox,
  Popover,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
} from "./ui";

interface ProviderModelPickerProps {
  provider: AgentProviderId;
  value: AgentModelId;
  modelOptions: AgentModelOption[];
  agentStatus: AgentStatus;
  variant?: "pill" | "field";
  ariaLabel?: string;
  label?: string;
  reasoningEffort?: AgentReasoningEffort;
  onReasoningEffortChange?: (effort: AgentReasoningEffort) => void;
  disabled?: boolean;
  disabledReason?: string;
  runtimeStatuses?: Partial<Record<AgentProviderId, ProviderRuntimeStatus>>;
  onDownloadProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onCancelProviderDownload?: (provider: AgentProviderId) => void | Promise<void>;
  onConnectProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onChange: (model: AgentModelId, provider: AgentProviderId) => void;
}

const PROVIDERS: AgentProviderId[] = ["claude", "codex", "grok"];
const DEFAULT_MODELS: Partial<Record<AgentProviderId, AgentModelId>> = {
  claude: "claude-opus-5",
  codex: "gpt-5.6-luna",
};

export function ProviderModelPicker(props: ProviderModelPickerProps) {
  const [open, setOpen] = createSignal(false);
  const [railProvider, setRailProvider] = createSignal<AgentProviderId>(untrack(() => props.provider));
  const providerButtons = new Map<AgentProviderId, HTMLButtonElement>();
  let root: HTMLDivElement | undefined;

  const selectedModel = createMemo(() =>
    props.modelOptions.find((option) => option.provider === props.provider && option.id === props.value),
  );
  const activeProvider = () => props.provider;

  createEffect(
    () => ({ provider: activeProvider(), open: open() }),
    ({ provider, open }) => {
      if (!open) setRailProvider(provider);
    },
  );

  onSettled(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (
        !open() ||
        (target instanceof Node && root?.contains(target)) ||
        (target instanceof Element && target.closest(".provider-model-effort-content"))
      ) {
        return;
      }
      setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  });

  createEffect(
    () => Boolean(props.disabled && open()),
    (mustClose) => {
      if (mustClose) setOpen(false);
    },
  );

  function setPickerOpen(next: boolean): void {
    if (props.disabled) return;
    if (next) setRailProvider(activeProvider());
    setOpen(next);
  }

  function selectModel(model: AgentModelId, provider: AgentProviderId): void {
    if (providerAvailability(props.agentStatus, props.modelOptions, provider).state !== "available") return;
    if (!showsReasoningEffort()) setOpen(false);
    props.onChange(model, provider);
  }

  function selectRailProvider(provider: AgentProviderId): void {
    setRailProvider(provider);
  }

  const triggerModelName = () => displayModelName(selectedModel()?.name, props.value);
  const field = () => props.variant === "field";
  const showsReasoningEffort = () => props.reasoningEffort !== undefined && props.onReasoningEffortChange !== undefined;

  return (
    <div
      ref={(element) => (root = element)}
      class={["provider-model-picker", { "provider-model-picker-field": field() }]}
    >
      <Popover.Root open={open()} onOpenChange={setPickerOpen} placement="bottom-end" gutter={8} sameWidth={field()}>
        <Popover.Trigger
          type="button"
          class={["provider-model-trigger", { "provider-model-trigger-field": field() }]}
          aria-label={`${props.ariaLabel ?? "Agent model"}: ${triggerModelName()}`}
          disabled={props.disabled}
          title={props.disabled ? props.disabledReason : `${providerName(activeProvider())} · ${triggerModelName()}`}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown") return;
            event.preventDefault();
            setPickerOpen(true);
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
        </Popover.Trigger>

        <Popover.Content
          class="provider-model-popover"
          aria-hidden={open() ? undefined : "true"}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <Popover.Title class="sr-only">Choose agent model</Popover.Title>
          <Tabs.Root
            value={railProvider()}
            onChange={(value) => {
              const provider = PROVIDERS.find((candidate) => candidate === value);
              if (provider) selectRailProvider(provider);
            }}
            orientation="vertical"
            activationMode="automatic"
            class="provider-model-layout"
          >
            <Tabs.List class="provider-model-rail" aria-label="Model providers">
              <For each={PROVIDERS}>
                {(provider) => {
                  const status = () => providerAvailability(props.agentStatus, props.modelOptions, provider);
                  return (
                    <Tabs.Trigger
                      ref={(element) => providerButtons.set(provider, element)}
                      value={provider}
                      class={[
                        "provider-model-rail-button",
                        {
                          "provider-model-rail-button-selected": railProvider() === provider,
                          "provider-model-rail-button-unavailable": status().state !== "available",
                        },
                      ]}
                      aria-label={`${providerName(provider)}: ${providerSummary(provider, status())}`}
                      title={`${providerName(provider)} · ${providerSummary(provider, status())}`}
                      onClick={(event) => {
                        const target = event.currentTarget;
                        selectRailProvider(provider);
                        queueMicrotask(() => target.focus({ preventScroll: true }));
                      }}
                      onKeyDown={(event) => {
                        const delta =
                          event.key === "ArrowDown" || event.key === "ArrowRight"
                            ? 1
                            : event.key === "ArrowUp" || event.key === "ArrowLeft"
                              ? -1
                              : 0;
                        if (!delta) return;
                        const current = PROVIDERS.indexOf(provider);
                        const next = PROVIDERS[(current + delta + PROVIDERS.length) % PROVIDERS.length];
                        if (next) providerButtons.get(next)?.focus();
                      }}
                    >
                      <ProviderMark provider={provider} large />
                    </Tabs.Trigger>
                  );
                }}
              </For>
            </Tabs.List>

            <For each={PROVIDERS}>
              {(provider) => {
                const status = () => providerAvailability(props.agentStatus, props.modelOptions, provider);
                const models = () => props.modelOptions.filter((option) => option.provider === provider);
                const available = () => status().state === "available";
                const runtime = () => {
                  const value = props.runtimeStatuses?.[provider];
                  if (
                    value?.phase === "not-downloaded" &&
                    (status().state === "available" || status().state === "sign-in-required")
                  ) {
                    return { ...value, phase: "ready" as const, version: status().version };
                  }
                  return value;
                };
                const runtimeAction = () => {
                  if (available() || status().connectionState === "connecting") return undefined;
                  if (runtime()?.phase === "downloading") return "Cancel" as const;
                  if (runtime()?.phase === "ready") return "Connect" as const;
                  if (runtime()?.phase === "download-error") return "Retry" as const;
                  if (runtime()?.phase === "not-downloaded") return "Download" as const;
                  return undefined;
                };
                const runtimeMessage = () => {
                  const runtimeStatus = runtime();
                  if (runtimeStatus?.phase === "downloading") {
                    return `Downloading ${Math.round(runtimeStatus.progress ?? 0)}%`;
                  }
                  if (runtimeStatus?.phase === "finishing") return "Setting up";
                  return runtimeStatus?.message ?? status().message ?? `${providerName(provider)} is unavailable.`;
                };
                return (
                  <Tabs.Content
                    value={provider}
                    class="provider-model-panel"
                    aria-label={`${providerName(provider)} models`}
                  >
                    <div class="provider-model-heading">
                      <strong>{providerName(provider)}</strong>
                      <span>{providerHeadingSummary(provider, status())}</span>
                    </div>
                    <Show when={!available()}>
                      <div class="provider-model-empty" role="status">
                        <span>{runtimeMessage()}</span>
                        <Show when={runtime()?.phase === "downloading"}>
                          <Progress
                            value={runtime()?.progress ?? 0}
                            aria-label={`${providerName(provider)} download`}
                          />
                        </Show>
                        <Show when={runtimeAction()}>
                          {(action) => (
                            <Button
                              type="button"
                              size="xs"
                              variant={action() === "Download" ? "default" : "outline"}
                              onClick={() => {
                                if (action() === "Cancel") void props.onCancelProviderDownload?.(provider);
                                else if (action() === "Connect") void props.onConnectProvider?.(provider);
                                else void props.onDownloadProvider?.(provider);
                              }}
                            >
                              {action()}
                            </Button>
                          )}
                        </Show>
                      </div>
                    </Show>
                    <Show
                      when={models().length > 0}
                      fallback={
                        <Show when={available()}>
                          <div class="provider-model-empty" role="status">
                            No models are available from {providerName(provider)}.
                          </div>
                        </Show>
                      }
                    >
                      <Listbox.Root
                        class="provider-model-list"
                        aria-label={`${providerName(provider)} models`}
                        options={models()}
                        optionValue="id"
                        optionTextValue={(model) => displayModelName(model.name, model.id)}
                        optionDisabled={() => !available()}
                        value={[props.value]}
                        selectionMode="single"
                        disallowEmptySelection
                        shouldFocusWrap
                        renderItem={(item) => {
                          const model = item.rawValue;
                          const selected = () => props.value === model.id;
                          return (
                            <Listbox.Item
                              as="button"
                              item={item}
                              type="button"
                              class={["provider-model-option", { "provider-model-option-selected": selected() }]}
                              aria-label={`${displayModelName(model.name, model.id)}${
                                model.id === DEFAULT_MODELS[provider] ? ", default" : ""
                              }`}
                              disabled={!available()}
                              onClick={() => selectModel(model.id, provider)}
                            >
                              <span class="provider-model-option-name">
                                <span>{displayModelName(model.name, model.id)}</span>
                                <Show when={model.id === DEFAULT_MODELS[provider]}>
                                  <small>default</small>
                                </Show>
                              </span>
                              <Show when={selected()}>
                                <CheckIcon />
                              </Show>
                            </Listbox.Item>
                          );
                        }}
                      />
                    </Show>
                    <Show when={showsReasoningEffort() && provider === props.provider ? selectedModel() : undefined}>
                      {(model) => (
                        <div class="provider-model-effort">
                          <span>Effort</span>
                          <Select<AgentReasoningEffort>
                            class="provider-model-effort-select"
                            options={model().supportedReasoningEfforts}
                            value={props.reasoningEffort}
                            onChange={(effort) => {
                              if (effort && effort !== props.reasoningEffort) {
                                props.onReasoningEffortChange?.(effort);
                              }
                            }}
                            itemComponent={(item) => (
                              <SelectItem item={item.item}>{reasoningLabel(item.item.rawValue)}</SelectItem>
                            )}
                          >
                            <SelectTrigger size="sm" aria-label="Agent reasoning effort">
                              <SelectValue<AgentReasoningEffort>>
                                {(state) => {
                                  const effort = state.selectedOption();
                                  return effort ? reasoningLabel(effort) : "Select effort";
                                }}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent class="provider-model-effort-content" />
                          </Select>
                        </div>
                      )}
                    </Show>
                  </Tabs.Content>
                );
              }}
            </For>
          </Tabs.Root>
        </Popover.Content>
      </Popover.Root>
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
  const available = models.some((model) => model.provider === provider);
  return {
    id: provider,
    state: available ? "available" : "error",
    version: null,
    message: available ? null : `${providerName(provider)} is unavailable.`,
  };
}

function providerSummary(provider: AgentProviderId, status: AgentProviderStatus): string {
  if (status.state === "available") {
    return status.version ? `${status.version} (${providerCliName(provider)})` : `${providerCliName(provider)} ready`;
  }
  return status.message ?? providerStatusLabel(status.state);
}

function providerHeadingSummary(provider: AgentProviderId, status: AgentProviderStatus): string {
  if (status.state === "available") return providerSummary(provider, status);
  return providerStatusLabel(status.state);
}

function providerStatusLabel(
  state: AgentProviderStatus["state"],
): "Sign in required" | "Not installed" | "Update required" | "Unavailable" | "Checking" {
  if (state === "sign-in-required") return "Sign in required";
  if (state === "not-installed") return "Not installed";
  if (state === "outdated") return "Update required";
  if (state === "error") return "Unavailable";
  return "Checking";
}

function providerName(provider: AgentProviderId): "Claude" | "ChatGPT" | "Grok" {
  if (provider === "claude") return "Claude";
  if (provider === "grok") return "Grok";
  return "ChatGPT";
}

function providerCliName(provider: AgentProviderId): "Claude Code" | "Codex CLI" | "Grok CLI" {
  if (provider === "claude") return "Claude Code";
  if (provider === "grok") return "Grok CLI";
  return "Codex CLI";
}

function displayModelName(name: string | undefined, fallback: string): string {
  return name?.replace(/^[\s:–—-]+/, "") || fallback;
}

function reasoningLabel(effort: AgentReasoningEffort): string {
  if (effort === "xhigh") return "Extra high";
  return `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`;
}

function ProviderMark(props: { provider: AgentProviderId; large?: boolean }) {
  return (
    <ProviderLogo
      provider={props.provider}
      class={[
        "provider-model-mark",
        {
          "provider-model-mark-codex": props.provider === "codex",
          "provider-model-mark-claude": props.provider === "claude",
          "provider-model-mark-grok": props.provider === "grok",
          "provider-model-mark-large": Boolean(props.large),
        },
      ]}
    />
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

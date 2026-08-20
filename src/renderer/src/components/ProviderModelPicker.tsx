import { ProviderLogo } from "@openbot/brand";
import type {
  AgentModelId,
  AgentModelOption,
  AgentProviderId,
  AgentProviderStatus,
  AgentStatus,
} from "@openbot/contracts/ipc";
import { isClaudeModel } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";
import { Listbox, Popover, Tabs } from "./ui";

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
  const [railProvider, setRailProvider] = createSignal<AgentProviderId>(untrack(() => providerForModel(props.value)));
  const providerButtons = new Map<AgentProviderId, HTMLButtonElement>();
  let root: HTMLDivElement | undefined;

  const selectedModel = createMemo(() => props.modelOptions.find((option) => option.id === props.value));
  const activeProvider = createMemo(() => providerForModel(props.value));

  createEffect(
    () => ({ provider: activeProvider(), open: open() }),
    ({ provider, open }) => {
      if (!open) setRailProvider(provider);
    },
  );

  onSettled(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!open() || (target instanceof Node && root?.contains(target))) return;
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
              if (provider) setRailProvider(provider);
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
                const models = () => props.modelOptions.filter((option) => providerForModel(option.id) === provider);
                const available = () => status().state === "available";
                return (
                  <Tabs.Content
                    value={provider}
                    class="provider-model-panel"
                    aria-label={`${providerName(provider)} models`}
                  >
                    <div class="provider-model-heading">
                      <strong>{providerName(provider)}</strong>
                      <span>{providerSummary(provider, status())}</span>
                    </div>
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

function providerStatusLabel(
  state: AgentProviderStatus["state"],
): "Sign in required" | "Not installed" | "Update required" | "Unavailable" | "Checking" {
  if (state === "sign-in-required") return "Sign in required";
  if (state === "not-installed") return "Not installed";
  if (state === "outdated") return "Update required";
  if (state === "error") return "Unavailable";
  return "Checking";
}

function providerName(provider: AgentProviderId): "Claude" | "Codex" {
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
    <ProviderLogo
      provider={props.provider}
      class={[
        "provider-model-mark",
        {
          "provider-model-mark-codex": props.provider === "codex",
          "provider-model-mark-claude": props.provider === "claude",
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

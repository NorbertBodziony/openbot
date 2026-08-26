import { ProviderLogo } from "@openbot/brand";
import type { AgentProviderId, AgentProviderState } from "@openbot/contracts/ipc";
import { createEffect, createUniqueId, For, Show } from "solid-js";
import { Badge, Input } from "./ui";

export interface ProviderPickerOption {
  id: AgentProviderId;
  name: string;
  state: AgentProviderState;
  message?: string | null;
  email?: string | null;
}

interface ProviderPickerProps {
  value: AgentProviderId | null;
  options: ProviderPickerOption[];
  ariaLabel: string;
  label?: string;
  hint?: string;
  embedded?: boolean;
  disabled?: boolean;
  allowUnavailableSelection?: boolean;
  focusFirst?: boolean;
  onChange: (provider: AgentProviderId) => void;
}

export function ProviderPicker(props: ProviderPickerProps) {
  const inputs = new Map<AgentProviderId, HTMLInputElement>();
  const pickerId = createUniqueId();
  let focused = false;

  createEffect(
    () => ({
      focusFirst: props.focusFirst,
      options: props.options,
      allowUnavailableSelection: props.allowUnavailableSelection,
    }),
    ({ focusFirst, options, allowUnavailableSelection }) => {
      if (!focusFirst || focused) return;
      const first =
        options.find((option) => option.state === "available") ?? (allowUnavailableSelection ? options[0] : undefined);
      const input = first ? inputs.get(first.id) : undefined;
      if (!input) return;
      focused = true;
      input.focus();
    },
  );

  return (
    <div
      class={[
        "provider-picker",
        {
          "provider-picker-standalone": !props.embedded,
          "provider-picker-embedded": Boolean(props.embedded),
        },
      ]}
      role="radiogroup"
      aria-label={props.ariaLabel}
    >
      <Show when={props.label}>{(label) => <div class="provider-picker-label">{label()}</div>}</Show>
      <div class="provider-picker-list">
        <For each={props.options} keyed={false}>
          {(option) => {
            const available = () => option().state === "available";
            const inputId = () => `${pickerId}-${option().id}`;
            return (
              <label
                for={inputId()}
                class={[
                  "provider-picker-option",
                  {
                    "provider-picker-option-selected": props.value === option().id,
                    "provider-picker-option-unavailable": !available(),
                    "provider-picker-option-selectable-unavailable":
                      !available() && Boolean(props.allowUnavailableSelection),
                  },
                ]}
                title={option().message ?? undefined}
              >
                <Input
                  id={inputId()}
                  ref={(element) => inputs.set(option().id, element)}
                  type="radio"
                  name={props.ariaLabel}
                  value={option().id}
                  checked={props.value === option().id}
                  disabled={props.disabled || (!props.allowUnavailableSelection && !available())}
                  onChange={() => props.onChange(option().id)}
                />
                <ProviderLogo provider={option().id} class="provider-picker-logo" />
                <span class="provider-picker-identity">
                  <span class="provider-picker-name">{option().name}</span>
                  <Show when={option().email}>{(email) => <small class="provider-picker-email">{email()}</small>}</Show>
                </span>
                <Badge
                  class={`provider-picker-status provider-picker-status-${option().state}`}
                  tone={providerStatusTone(option().state)}
                  shape="pill"
                  dot
                >
                  {providerStatusLabel(option().state)}
                </Badge>
              </label>
            );
          }}
        </For>
      </div>
      <Show when={props.hint}>{(hint) => <p class="provider-picker-hint">{hint()}</p>}</Show>
    </div>
  );
}

function providerStatusTone(state: AgentProviderState): "success" | "warning" | "danger" | "neutral" {
  if (state === "available") return "success";
  if (state === "error") return "danger";
  if (state === "sign-in-required" || state === "outdated") return "warning";
  return "neutral";
}

function providerStatusLabel(
  state: AgentProviderState,
): "Available" | "Sign in required" | "Not installed" | "Update required" | "Unavailable" | "Checking" {
  if (state === "available") return "Available";
  if (state === "sign-in-required") return "Sign in required";
  if (state === "not-installed") return "Not installed";
  if (state === "outdated") return "Update required";
  if (state === "error") return "Unavailable";
  return "Checking";
}

import { createEffect, For, Show } from "solid-js";
import type { AgentProviderId, AgentProviderState } from "../../../shared/ipc";

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
  let focused = false;

  createEffect(() => {
    if (!props.focusFirst || focused) return;
    const first =
      props.options.find((option) => option.state === "available") ??
      (props.allowUnavailableSelection ? props.options[0] : undefined);
    const input = first ? inputs.get(first.id) : undefined;
    if (!input) return;
    focused = true;
    input.focus();
  });

  return (
    <div
      class="provider-picker"
      classList={{
        "provider-picker-standalone": !props.embedded,
        "provider-picker-embedded": props.embedded,
      }}
      role="radiogroup"
      aria-label={props.ariaLabel}
    >
      <Show when={props.label}>
        {(label) => <div class="provider-picker-label">{label()}</div>}
      </Show>
      <div class="provider-picker-list">
        <For each={props.options}>
          {(option) => {
            const available = () => option.state === "available";
            return (
              <label
                class="provider-picker-option"
                classList={{
                  "provider-picker-option-selected": props.value === option.id,
                  "provider-picker-option-unavailable": !available(),
                  "provider-picker-option-selectable-unavailable":
                    !available() && Boolean(props.allowUnavailableSelection),
                }}
                title={option.message ?? undefined}
              >
                <input
                  ref={(element) => inputs.set(option.id, element)}
                  type="radio"
                  name={props.ariaLabel}
                  value={option.id}
                  checked={props.value === option.id}
                  disabled={props.disabled || (!props.allowUnavailableSelection && !available())}
                  onChange={() => props.onChange(option.id)}
                />
                <span class="provider-picker-identity">
                  <span class="provider-picker-name">{option.name}</span>
                  <Show when={option.email}>
                    {(email) => <small class="provider-picker-email">{email()}</small>}
                  </Show>
                </span>
                <span class={`provider-picker-status provider-picker-status-${option.state}`}>
                  <i aria-hidden="true" />
                  {providerStatusLabel(option.state)}
                </span>
              </label>
            );
          }}
        </For>
      </div>
      <Show when={props.hint}>{(hint) => <p class="provider-picker-hint">{hint()}</p>}</Show>
    </div>
  );
}

function providerStatusLabel(state: AgentProviderState): string {
  if (state === "available") return "Available";
  if (state === "sign-in-required") return "Sign in required";
  if (state === "not-installed") return "Not installed";
  if (state === "outdated") return "Update required";
  if (state === "error") return "Unavailable";
  return "Checking";
}

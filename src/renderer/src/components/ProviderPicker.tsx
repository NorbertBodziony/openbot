import { ProviderLogo } from "@openbot/brand";
import type { AgentProviderId, AgentProviderState } from "@openbot/contracts/ipc";
import { createEffect, createUniqueId, For, Show } from "solid-js";
import { Badge, Button, Input, RefreshCw, Spinner } from "./ui";

export interface ProviderPickerOption {
  id: AgentProviderId;
  name: string;
  state: AgentProviderState;
  description?: string | null;
  message?: string | null;
  email?: string | null;
  connectionState?: "connecting";
  checkError?: string | null;
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
  refreshingProviders?: boolean;
  onConnectProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onInstallProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onSignInProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onRefreshProviders?: () => void | Promise<void>;
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
    >
      <Show when={props.label || props.onRefreshProviders}>
        <div class="provider-picker-heading">
          <Show when={props.label}>{(label) => <div class="provider-picker-label">{label()}</div>}</Show>
          <Show when={props.onRefreshProviders}>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              class="provider-picker-refresh"
              aria-label={props.refreshingProviders ? "Checking providers" : "Refresh providers"}
              loading={props.refreshingProviders}
              loadingLabel="Checking…"
              disabled={props.disabled}
              onClick={() => void props.onRefreshProviders?.()}
            >
              <RefreshCw size={13} aria-hidden="true" />
              Refresh
            </Button>
          </Show>
        </div>
      </Show>
      <div class="provider-picker-list" role="radiogroup" aria-label={props.ariaLabel}>
        <For each={props.options}>
          {(option) => {
            const state = () => option.state;
            const connecting = () => option.connectionState === "connecting";
            const available = () => state() === "available";
            const visualState = () => (connecting() && !available() ? "checking" : state());
            const inputId = `${pickerId}-${option.id}`;
            return (
              <div
                class={[
                  "provider-picker-option",
                  {
                    "provider-picker-option-selected": props.value === option.id,
                    "provider-picker-option-unavailable": !available(),
                    "provider-picker-option-selectable-unavailable":
                      !available() && Boolean(props.allowUnavailableSelection),
                  },
                ]}
                title={option.message ?? undefined}
              >
                <label for={inputId} class="provider-picker-option-selection">
                  <Input
                    id={inputId}
                    ref={(element) => inputs.set(option.id, element)}
                    type="radio"
                    name={props.ariaLabel}
                    value={option.id}
                    checked={props.value === option.id}
                    disabled={props.disabled || (!props.allowUnavailableSelection && !available())}
                    onChange={() => props.onChange(option.id)}
                  />
                  <ProviderLogo provider={option.id} class="provider-picker-logo" />
                  <span class="provider-picker-identity">
                    <span class="provider-picker-name">{option.name}</span>
                    <Show when={option.email ?? option.description}>
                      {(detail) => <small class="provider-picker-email">{detail()}</small>}
                    </Show>
                    <Show when={option.checkError}>
                      {(checkError) => <small class="provider-picker-check-error">{checkError()}</small>}
                    </Show>
                  </span>
                  <Badge
                    class={`provider-picker-status provider-picker-status-${visualState()}`}
                    tone={providerStatusTone(visualState())}
                    shape="pill"
                    dot
                  >
                    {providerStatusLabel(state(), connecting())}
                  </Badge>
                </label>
                <Show
                  when={
                    option.id === "claude" &&
                    state() === "not-installed" &&
                    !props.onConnectProvider &&
                    props.onInstallProvider
                  }
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    class="provider-picker-install"
                    aria-label={`Install ${option.name}`}
                    disabled={props.disabled || props.refreshingProviders}
                    onClick={() => void props.onInstallProvider?.(option.id)}
                  >
                    Install
                  </Button>
                </Show>
                <Show when={props.onConnectProvider}>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    class="provider-picker-install"
                    aria-label={`${providerActionLabel(state(), connecting())} ${option.name}`}
                    aria-busy={connecting() ? "true" : undefined}
                    disabled={props.disabled || props.refreshingProviders}
                    onClick={() => void props.onConnectProvider?.(option.id)}
                  >
                    <Show when={connecting()}>
                      <Spinner size="sm" />
                    </Show>
                    {providerActionLabel(state(), connecting())}
                  </Button>
                </Show>
                <Show
                  when={
                    option.id === "claude" &&
                    state() === "sign-in-required" &&
                    !props.onConnectProvider &&
                    props.onSignInProvider
                  }
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    class="provider-picker-install"
                    aria-label={`Sign in to ${option.name}`}
                    disabled={props.disabled || props.refreshingProviders}
                    onClick={() => void props.onSignInProvider?.(option.id)}
                  >
                    Sign in
                  </Button>
                </Show>
              </div>
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
  connecting = false,
): "Connected" | "Not connected" | "Not installed" | "Update required" | "Unavailable" | "Checking" | "Connecting" {
  if (connecting && state !== "available") return "Connecting";
  if (state === "available") return "Connected";
  if (state === "sign-in-required") return "Not connected";
  if (state === "not-installed") return "Not installed";
  if (state === "outdated") return "Update required";
  if (state === "error") return "Unavailable";
  return "Checking";
}

function providerActionLabel(state: AgentProviderState, connecting: boolean): "Connect" | "Reconnect" | "Restart" {
  if (connecting) return "Restart";
  return state === "available" ? "Reconnect" : "Connect";
}

import { ONE_TIME_CODE_ALPHABET, ONE_TIME_CODE_LENGTH } from "@openbot/contracts/validation";
import { createEffect, createMemo, createSignal, createUniqueId, For, Show, untrack } from "solid-js";
import { Input } from "./ui";

export type OtpInputStatus = "idle" | "verifying" | "error" | "success";

interface OtpInputProps {
  value: string;
  status?: OtpInputStatus;
  hint?: string;
  errorMessage?: string | null;
  successMessage?: string;
  disabled?: boolean;
  autofocus?: boolean;
  onChange: (value: string) => void;
  onComplete: (value: string) => void;
}

export function OtpInput(props: OtpInputProps) {
  const inputId = `openbot-otp-${createUniqueId()}`;
  const messageId = `${inputId}-message`;
  const initialSlots = toSlots(untrack(() => props.value));
  const [slots, setSlots] = createSignal(initialSlots);
  const [active, setActive] = createSignal(firstEmptySlot(initialSlots));
  const [focused, setFocused] = createSignal(false);
  let inputElement: HTMLInputElement | undefined;
  let slotsElement: HTMLDivElement | undefined;

  const status = () => props.status ?? "idle";
  const disabled = () => Boolean(props.disabled || status() === "verifying" || status() === "success");
  const message = createMemo(() => {
    if (status() === "success") return props.successMessage ?? "Verified. Opening OpenBot…";
    if (status() === "error") return props.errorMessage ?? "That code is incorrect. Try again.";
    if (status() === "verifying") return "Verifying…";
    return props.hint;
  });

  createEffect(
    () => Boolean(props.autofocus && !disabled()),
    (shouldFocus) => {
      if (!shouldFocus) return;
      queueMicrotask(() => inputElement?.focus({ preventScroll: true }));
    },
  );

  createEffect(
    () => props.value,
    (value) => {
      const incoming = sanitize(value);
      if (incoming === untrack(() => slots().join(""))) return;
      const next = toSlots(incoming);
      setSlots(next);
      setActive(firstEmptySlot(next));
    },
  );

  createEffect(
    () => status(),
    (nextStatus, previousStatus) => {
      if (nextStatus !== "error" || previousStatus === "error" || shouldReduceMotion() || !slotsElement) return;
      slotsElement.animate?.(
        [
          { transform: "translateX(0)" },
          { transform: "translateX(-5px)" },
          { transform: "translateX(5px)" },
          { transform: "translateX(-3px)" },
          { transform: "translateX(3px)" },
          { transform: "translateX(-1px)" },
          { transform: "translateX(0)" },
        ],
        { duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
      );
    },
  );

  function commit(next: string[]): void {
    const previous = slots().join("");
    setSlots(next);
    const value = next.join("");
    props.onChange(value);
    if (value !== previous && next.every(Boolean)) {
      props.onComplete(value);
      inputElement?.focus({ preventScroll: true });
    }
  }

  function clearSlot(index: number): void {
    const next = [...slots()];
    next[index] = "";
    commit(next);
  }

  function insert(raw: string, from = active()): void {
    const characters = sanitize(raw);
    if (!characters) return;
    const next = [...slots()];
    let index = from;
    for (const character of characters) {
      if (index >= ONE_TIME_CODE_LENGTH) break;
      next[index] = character;
      index += 1;
    }
    commit(next);
    setActive(Math.min(index, ONE_TIME_CODE_LENGTH - 1));
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (disabled()) {
      event.preventDefault();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toUpperCase();
    if (key.length === 1 && ONE_TIME_CODE_ALPHABET.includes(key)) {
      event.preventDefault();
      insert(key);
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      if (slots()[active()]) {
        clearSlot(active());
      } else if (active() > 0) {
        const previous = active() - 1;
        clearSlot(previous);
        setActive(previous);
      }
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      clearSlot(active());
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, ONE_TIME_CODE_LENGTH - 1));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActive(ONE_TIME_CODE_LENGTH - 1);
    }
  }

  function handlePointerDown(event: PointerEvent): void {
    if (disabled()) return;
    event.preventDefault();
    const slot = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-otp-index]") : null;
    const requested = slot ? Number.parseInt(slot.dataset.otpIndex ?? "0", 10) : slotIndexAtX(event.clientX);
    setActive(Math.min(Math.max(Number.isFinite(requested) ? requested : 0, 0), ONE_TIME_CODE_LENGTH - 1));
    inputElement?.focus();
  }

  function slotIndexAtX(pointerX: number): number {
    const slotElements = slotsElement?.querySelectorAll<HTMLElement>(".otp-input-slot");
    if (!slotElements?.length) return 0;
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    slotElements.forEach((element, index) => {
      const bounds = element.getBoundingClientRect();
      const distance = Math.abs(pointerX - (bounds.left + bounds.width / 2));
      if (distance >= closestDistance) return;
      closestIndex = index;
      closestDistance = distance;
    });
    return closestIndex;
  }

  return (
    <div class="otp-input" data-status={status()}>
      <fieldset
        class="otp-input-fieldset"
        aria-disabled={disabled() ? "true" : undefined}
        onPointerDown={handlePointerDown}
      >
        <Input
          ref={(element) => (inputElement = element)}
          id={inputId}
          class="otp-input-native"
          type="text"
          inputmode="text"
          autocomplete="one-time-code"
          autocapitalize="characters"
          spellcheck={false}
          value=""
          readonly={Boolean(props.disabled || status() === "success")}
          maxlength={ONE_TIME_CODE_LENGTH}
          aria-label="One-time code"
          aria-invalid={status() === "error" ? "true" : undefined}
          aria-describedby={message() ? messageId : undefined}
          autofocus={props.autofocus}
          onBlur={() => setFocused(false)}
          onFocus={() => setFocused(true)}
          onInput={(event) => {
            if (disabled()) {
              event.currentTarget.value = "";
              return;
            }
            const value = sanitize(event.currentTarget.value);
            if (!value) return;
            insert(value, 0);
            event.currentTarget.value = "";
          }}
          onKeyDown={handleKeyDown}
          onPaste={(event) => {
            event.preventDefault();
            if (disabled()) return;
            insert(event.clipboardData?.getData("text") ?? "");
          }}
        />

        <div
          ref={(element) => (slotsElement = element)}
          class="otp-input-slots"
          style={{
            "--otp-active-index": String(active()),
            "--otp-group-offset": active() >= 4 ? "var(--otp-group-gap)" : "0px",
          }}
        >
          <span class="otp-input-focus-ring" data-visible={focused() && status() !== "success" ? "true" : undefined} />
          <For each={slots()} keyed={false}>
            {(character, index) => (
              <span
                class="otp-input-slot"
                data-active={focused() && index === active() ? "true" : undefined}
                data-filled={character() ? "true" : undefined}
                data-otp-index={index}
              >
                <Show when={focused() && index === active() && status() !== "success"}>
                  <span class="otp-input-caret" data-trailing={character() ? "true" : undefined} aria-hidden="true" />
                </Show>
                <Show when={character()} keyed>
                  {(value) => <span class="otp-input-character">{value}</span>}
                </Show>
              </span>
            )}
          </For>
        </div>
      </fieldset>

      <Show when={message()}>
        {(content) => (
          <p
            id={messageId}
            class="otp-input-message"
            role={status() === "error" ? "alert" : "status"}
            aria-live={status() === "error" ? "assertive" : "polite"}
          >
            <Show when={status() === "success"}>
              <svg class="otp-input-success" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 13l4 4L19 7" />
              </svg>
            </Show>
            {content()}
          </p>
        )}
      </Show>
    </div>
  );
}

function sanitize(value: string): string {
  return value
    .toUpperCase()
    .split("")
    .filter((character) => ONE_TIME_CODE_ALPHABET.includes(character))
    .join("")
    .slice(0, ONE_TIME_CODE_LENGTH);
}

function toSlots(value: string): string[] {
  const characters = sanitize(value);
  return Array.from({ length: ONE_TIME_CODE_LENGTH }, (_, index) => characters[index] ?? "");
}

function firstEmptySlot(slots: string[]): number {
  const index = slots.findIndex((character) => !character);
  return index === -1 ? ONE_TIME_CODE_LENGTH - 1 : index;
}

function shouldReduceMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

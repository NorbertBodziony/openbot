import type { DynamicIslandAction, DynamicIslandPreference, DynamicIslandPresentation } from "@openbot/contracts/ipc";
import { IDLE_DYNAMIC_ISLAND_PRESENTATION } from "@openbot/contracts/ipc";
import { createSignal, onSettled, Show } from "solid-js";
import { OpenBotDynamicIsland } from "./components/OpenBotDynamicIsland";
import type { DynamicIslandStateChangeReason, DynamicIslandViewState } from "./components/ui";

export function DynamicIslandSurface() {
  const displayMode = new URLSearchParams(window.location.search).get("display") === "island" ? "island" : "notch";
  const [presentation, setPresentation] = createSignal(IDLE_DYNAMIC_ISLAND_PRESENTATION);
  const [preference, setPreference] = createSignal<DynamicIslandPreference>({
    enabled: true,
    hapticsEnabled: true,
    idleVisible: true,
    additionalDisplaysEnabled: true,
  });
  const [viewState, setViewState] = createSignal<DynamicIslandViewState>("compact");
  let pointerInside = false;
  let focusInside = false;
  let queuedPresentation: DynamicIslandPresentation | undefined;

  function applyPresentation(next: DynamicIslandPresentation): void {
    if (
      interactionLocksPresentation(presentation(), next, pointerInside || focusInside || viewState() === "expanded")
    ) {
      queuedPresentation = next;
      return;
    }
    commitPresentation(next);
  }

  function commitPresentation(next: DynamicIslandPresentation): void {
    setPresentation(next);
    if (next.mode === "idle") {
      setViewState("compact");
      if (!preference().idleVisible) closeInteraction();
    }
  }

  function applyPreference(next: DynamicIslandPreference): void {
    setPreference(next);
    if (!next.idleVisible && presentation().mode === "idle") {
      setViewState("compact");
      closeInteraction();
    }
  }

  function changeViewState(next: DynamicIslandViewState, reason: DynamicIslandStateChangeReason): void {
    if (reason === "pointer" || reason === "keyboard" || reason === "escape") performHaptic();
    setViewState(next);
    if (next === "compact" && !pointerInside && !focusInside) applyQueuedPresentation();
  }

  function applyQueuedPresentation(): void {
    const next = queuedPresentation;
    queuedPresentation = undefined;
    if (next) commitPresentation(next);
  }

  function syncInteractive(): void {
    void window.openbot.dynamicIsland.setInteractive({ interactive: pointerInside || focusInside });
  }

  function beginPointerInteraction(): void {
    pointerInside = true;
    syncInteractive();
  }

  function endPointerInteraction(): void {
    pointerInside = false;
    if (viewState() === "compact" && !focusInside) applyQueuedPresentation();
    syncInteractive();
  }

  function beginFocusInteraction(): void {
    focusInside = true;
    syncInteractive();
  }

  function endFocusInteraction(): void {
    focusInside = false;
    if (viewState() === "compact" && !pointerInside) applyQueuedPresentation();
    syncInteractive();
  }

  function closeInteraction(): void {
    pointerInside = false;
    focusInside = false;
    if (viewState() === "compact") applyQueuedPresentation();
    syncInteractive();
  }

  function enterInteraction(event: MouseEvent & { currentTarget: HTMLFieldSetElement }): void {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    if (!pointerInside) performHaptic();
    beginPointerInteraction();
  }

  function leaveInteraction(event: MouseEvent & { currentTarget: HTMLFieldSetElement }): void {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    endPointerInteraction();
  }

  function leaveFocusInteraction(event: FocusEvent & { currentTarget: HTMLFieldSetElement }): void {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    endFocusInteraction();
  }

  async function perform(action: DynamicIslandAction): Promise<void> {
    performHaptic();
    try {
      await window.openbot.dynamicIsland.performAction(action);
    } catch {
      return;
    }
    pointerInside = false;
    focusInside = false;
    setViewState("compact");
    applyQueuedPresentation();
    await window.openbot.dynamicIsland.setInteractive({ interactive: false });
  }

  function performHaptic(): void {
    void window.openbot.dynamicIsland.performHaptic().catch(() => undefined);
  }

  onSettled(() => {
    void window.openbot.dynamicIsland
      .getPresentation()
      .then(applyPresentation)
      .catch(() => undefined);
    void window.openbot.dynamicIsland
      .getPreference()
      .then(applyPreference)
      .catch(() => undefined);
    const stopPreference = window.openbot.dynamicIsland.onPreference(applyPreference);
    const stopPresentation = window.openbot.dynamicIsland.onPresentation(applyPresentation);
    const close = () => {
      pointerInside = false;
      focusInside = false;
      setViewState("compact");
      applyQueuedPresentation();
      void window.openbot.dynamicIsland.setInteractive({ interactive: false });
    };
    window.addEventListener("blur", close);
    return () => {
      stopPreference();
      stopPresentation();
      window.removeEventListener("blur", close);
    };
  });
  return (
    <main class="dynamic-island-surface" aria-label="OpenBot MacBook notch">
      <Show when={presentation().mode !== "idle" || preference().idleVisible}>
        <fieldset
          class="dynamic-island-surface-anchor"
          aria-label="Dynamic Island interaction area"
          onMouseOver={enterInteraction}
          onMouseOut={leaveInteraction}
          onFocus={beginFocusInteraction}
          onFocusIn={beginFocusInteraction}
          onBlur={leaveFocusInteraction}
          onFocusOut={leaveFocusInteraction}
        >
          <OpenBotDynamicIsland
            presentation={presentation()}
            state={viewState()}
            displayMode={displayMode}
            extendedHoverArea
            onStateChange={changeViewState}
            onAction={perform}
            onHaptic={performHaptic}
          />
        </fieldset>
      </Show>
    </main>
  );
}

function interactionLocksPresentation(
  current: DynamicIslandPresentation,
  next: DynamicIslandPresentation,
  interacting: boolean,
): boolean {
  if (!interacting || !isCriticalPresentation(current)) return false;
  return presentationIdentity(current) !== presentationIdentity(next);
}

function isCriticalPresentation(presentation: DynamicIslandPresentation): boolean {
  return (
    presentation.mode === "approval" ||
    presentation.mode === "question" ||
    presentation.mode === "takeover" ||
    presentation.mode === "failed"
  );
}

function presentationIdentity(presentation: DynamicIslandPresentation): string {
  if (presentation.mode === "approval" || presentation.mode === "question" || presentation.mode === "takeover") {
    return `${presentation.serverId}:${presentation.mode}:${String(presentation.item.requestId)}`;
  }
  if (presentation.mode === "failed") {
    return `${presentation.serverId}:${presentation.mode}:${presentation.item.turnId}`;
  }
  if (presentation.mode === "message") {
    return `${presentation.serverId}:${presentation.mode}:${presentation.message.messageId}`;
  }
  return `${presentation.serverId}:${presentation.mode}`;
}

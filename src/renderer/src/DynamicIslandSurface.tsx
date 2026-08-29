import type { DynamicIslandAction, DynamicIslandPresentation } from "@openbot/contracts/ipc";
import { IDLE_DYNAMIC_ISLAND_PRESENTATION } from "@openbot/contracts/ipc";
import { createSignal, onSettled } from "solid-js";
import { OpenBotDynamicIsland } from "./components/OpenBotDynamicIsland";
import type { DynamicIslandViewState } from "./components/ui";

export function DynamicIslandSurface() {
  const displayMode = new URLSearchParams(window.location.search).get("display") === "island" ? "island" : "notch";
  const [presentation, setPresentation] = createSignal(IDLE_DYNAMIC_ISLAND_PRESENTATION);
  const [viewState, setViewState] = createSignal<DynamicIslandViewState>("compact");
  let pointerInside = false;
  let queuedPresentation: DynamicIslandPresentation | undefined;

  function applyPresentation(next: DynamicIslandPresentation): void {
    if (interactionLocksPresentation(presentation(), next, pointerInside || viewState() === "expanded")) {
      queuedPresentation = next;
      return;
    }
    setPresentation(next);
    if (next.mode === "idle") {
      setViewState("compact");
    }
  }

  function changeViewState(next: DynamicIslandViewState): void {
    setViewState(next);
    if (next === "compact" && !pointerInside) applyQueuedPresentation();
  }

  function applyQueuedPresentation(): void {
    const next = queuedPresentation;
    queuedPresentation = undefined;
    if (next) applyPresentation(next);
  }

  function beginInteraction(): void {
    pointerInside = true;
    void window.openbot.dynamicIsland.setInteractive({ interactive: true });
  }

  function endInteraction(): void {
    pointerInside = false;
    if (viewState() === "compact") applyQueuedPresentation();
    void window.openbot.dynamicIsland.setInteractive({ interactive: false });
  }

  function enterInteraction(event: MouseEvent & { currentTarget: HTMLFieldSetElement }): void {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    beginInteraction();
  }

  function leaveInteraction(event: MouseEvent & { currentTarget: HTMLFieldSetElement }): void {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    endInteraction();
  }

  function leaveFocusInteraction(event: FocusEvent & { currentTarget: HTMLFieldSetElement }): void {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    endInteraction();
  }

  async function perform(action: DynamicIslandAction): Promise<void> {
    try {
      await window.openbot.dynamicIsland.performAction(action);
    } catch {
      return;
    }
    pointerInside = false;
    setViewState("compact");
    applyQueuedPresentation();
    await window.openbot.dynamicIsland.setInteractive({ interactive: false });
  }

  onSettled(() => {
    void window.openbot.dynamicIsland
      .getPresentation()
      .then(applyPresentation)
      .catch(() => undefined);
    const stopPresentation = window.openbot.dynamicIsland.onPresentation(applyPresentation);
    const close = () => {
      pointerInside = false;
      setViewState("compact");
      applyQueuedPresentation();
      void window.openbot.dynamicIsland.setInteractive({ interactive: false });
    };
    window.addEventListener("blur", close);
    return () => {
      stopPresentation();
      window.removeEventListener("blur", close);
    };
  });
  return (
    <main class="dynamic-island-surface" aria-label="OpenBot MacBook notch">
      <fieldset
        class="dynamic-island-surface-anchor"
        aria-label="Dynamic Island interaction area"
        onMouseOver={enterInteraction}
        onMouseOut={leaveInteraction}
        onFocus={beginInteraction}
        onBlur={leaveFocusInteraction}
      >
        <OpenBotDynamicIsland
          presentation={presentation()}
          state={viewState()}
          displayMode={displayMode}
          extendedHoverArea
          onStateChange={changeViewState}
          onAction={perform}
        />
      </fieldset>
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

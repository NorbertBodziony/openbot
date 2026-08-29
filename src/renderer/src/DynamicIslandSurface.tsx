import type { DynamicIslandAction, DynamicIslandMode, DynamicIslandPresentation } from "@openbot/contracts/ipc";
import { createSignal, onCleanup, onSettled } from "solid-js";
import { OpenBotDynamicIsland } from "./components/OpenBotDynamicIsland";
import type { DynamicIslandStateChangeReason, DynamicIslandViewState } from "./components/ui";

const EMPTY_PRESENTATION: DynamicIslandPresentation = {
  serverId: "local",
  mode: "idle",
  activeCount: 0,
  unreadCount: 0,
  attentionCount: 0,
  working: [],
  message: null,
  attention: [],
};

const PEEK_DURATION: Record<Exclude<DynamicIslandMode, "idle">, number> = {
  working: 2_200,
  message: 4_000,
  question: 6_000,
  approval: 6_000,
};

export function DynamicIslandSurface() {
  const displayMode = new URLSearchParams(window.location.search).get("display") === "island" ? "island" : "notch";
  const [presentation, setPresentation] = createSignal(EMPTY_PRESENTATION);
  const [viewState, setViewState] = createSignal<DynamicIslandViewState>("compact");
  let peekTimer: ReturnType<typeof setTimeout> | undefined;

  function applyPresentation(next: DynamicIslandPresentation): void {
    const previous = presentation();
    setPresentation(next);
    if (next.mode === "idle") {
      if (peekTimer !== undefined) clearTimeout(peekTimer);
      peekTimer = undefined;
      setViewState("compact");
      return;
    }
    if (viewState() === "expanded") return;
    const shouldPeek =
      (next.mode === "working" && previous.activeCount === 0 && next.activeCount > 0) ||
      (next.mode === "message" && next.message?.messageId !== previous.message?.messageId) ||
      ((next.mode === "question" || next.mode === "approval") && next.attention[0]?.id !== previous.attention[0]?.id);
    if (!shouldPeek) return;
    showPeek(PEEK_DURATION[next.mode]);
  }

  function showPeek(duration: number): void {
    if (peekTimer !== undefined) clearTimeout(peekTimer);
    setViewState("peek");
    peekTimer = setTimeout(() => {
      peekTimer = undefined;
      setViewState((current) => (current === "peek" ? "compact" : current));
    }, duration);
  }

  function changeViewState(next: DynamicIslandViewState, reason: DynamicIslandStateChangeReason): void {
    if (reason === "hover" && next === "expanded" && peekTimer !== undefined) {
      clearTimeout(peekTimer);
      peekTimer = undefined;
    }
    if (reason === "hover-exit" && peekTimer !== undefined) return;
    if (reason !== "hover" && peekTimer !== undefined) clearTimeout(peekTimer);
    if (reason !== "hover") peekTimer = undefined;
    setViewState(next);
  }

  async function perform(action: DynamicIslandAction): Promise<void> {
    setViewState("compact");
    await window.openbot.dynamicIsland.performAction(action);
    await window.openbot.dynamicIsland.setInteractive({ interactive: false });
  }

  onSettled(() => {
    void window.openbot.dynamicIsland
      .getPresentation()
      .then(applyPresentation)
      .catch(() => undefined);
    const stopPresentation = window.openbot.dynamicIsland.onPresentation(applyPresentation);
    const close = () => {
      setViewState("compact");
      void window.openbot.dynamicIsland.setInteractive({ interactive: false });
    };
    window.addEventListener("blur", close);
    return () => {
      stopPresentation();
      window.removeEventListener("blur", close);
    };
  });

  onCleanup(() => {
    if (peekTimer !== undefined) clearTimeout(peekTimer);
  });

  return (
    <main class="dynamic-island-surface" aria-label="OpenBot MacBook notch">
      <div
        class="dynamic-island-surface-anchor"
        onPointerEnter={() => void window.openbot.dynamicIsland.setInteractive({ interactive: true })}
        onPointerLeave={() => void window.openbot.dynamicIsland.setInteractive({ interactive: false })}
      >
        <OpenBotDynamicIsland
          presentation={presentation()}
          state={viewState()}
          displayMode={displayMode}
          onStateChange={changeViewState}
          onAction={perform}
          onLater={() => undefined}
        />
      </div>
    </main>
  );
}

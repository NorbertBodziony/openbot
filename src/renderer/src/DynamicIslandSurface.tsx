import type { DynamicIslandAction, DynamicIslandPresentation } from "@openbot/contracts/ipc";
import { createSignal, onSettled } from "solid-js";
import { OpenBotDynamicIsland } from "./components/OpenBotDynamicIsland";
import type { DynamicIslandViewState } from "./components/ui";

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

export function DynamicIslandSurface() {
  const displayMode = new URLSearchParams(window.location.search).get("display") === "island" ? "island" : "notch";
  const [presentation, setPresentation] = createSignal(EMPTY_PRESENTATION);
  const [viewState, setViewState] = createSignal<DynamicIslandViewState>("compact");

  function applyPresentation(next: DynamicIslandPresentation): void {
    setPresentation(next);
    if (next.mode === "idle") {
      setViewState("compact");
    }
  }

  function changeViewState(next: DynamicIslandViewState): void {
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

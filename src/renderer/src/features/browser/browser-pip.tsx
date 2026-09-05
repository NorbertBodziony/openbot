import type { BrowserDisplayState } from "@openbot/contracts/ipc";
import { render } from "@solidjs/web";
import { createSignal, onCleanup, onSettled, Show } from "solid-js";
import "../../styles.css";

function BrowserPictureInPicture() {
  const [state, setState] = createSignal<BrowserDisplayState>({ tabs: [], activeTabId: null });
  let surface: HTMLDivElement | undefined;
  let stateRevision = 0;
  let boundsFrame: number | undefined;

  const applyState = (next: BrowserDisplayState) => {
    stateRevision += 1;
    setState(next);
  };

  const syncBounds = () => {
    if (!surface) return;
    const bounds = surface.getBoundingClientRect();
    void window.openbot.browser.setVisible({
      visible: true,
      target: "picture-in-picture",
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    });
  };

  const scheduleBoundsSync = () => {
    if (boundsFrame !== undefined) cancelAnimationFrame(boundsFrame);
    boundsFrame = requestAnimationFrame(() => {
      boundsFrame = undefined;
      syncBounds();
    });
  };

  const removeDisplayState = window.openbot.browser.onDisplayState(applyState);

  onSettled(() => {
    const requestedAtRevision = stateRevision;
    void window.openbot.browser.getDisplayState().then((next) => {
      if (stateRevision === requestedAtRevision) applyState(next);
    });
    const observer = new ResizeObserver(scheduleBoundsSync);
    if (surface) observer.observe(surface);
    window.addEventListener("resize", scheduleBoundsSync);
    scheduleBoundsSync();
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleBoundsSync);
    });
  });

  onCleanup(() => {
    if (boundsFrame !== undefined) cancelAnimationFrame(boundsFrame);
    removeDisplayState();
    void window.openbot.browser.setVisible({ visible: false, target: "picture-in-picture" });
  });

  return (
    <aside class="browser-pip-window" aria-label="Browser Picture in Picture">
      <div class="browser-surface browser-pip-surface" ref={surface}>
        <Show when={state().tabs.length === 0}>
          <div class="browser-empty-state">
            <strong>Open a page</strong>
            <span>The agent can browse here while it works.</span>
          </div>
        </Show>
      </div>
    </aside>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Browser Picture in Picture root element was not found.");
render(() => <BrowserPictureInPicture />, root);

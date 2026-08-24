import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { BrowserControlAction, BrowserControlSession, BrowserTab } from "@openbot/contracts/ipc";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { BotProfile } from "../../data";
import { PanelResizer, readPanelWidth, savePanelWidth } from "../PanelResizer";
import { Button, Input, PanelRight, PictureInPicture2, Tabs, X } from "../ui";
import {
  BrowserBackIcon,
  BrowserControlIcon,
  BrowserForwardIcon,
  BrowserReloadIcon,
  CloseIcon,
  PlusIcon,
} from "./ConversationIcons";

const BROWSER_PANEL_STORAGE_KEY = "openbot:browser-panel-width";
const BROWSER_PANEL_MIN = 220;
const BROWSER_PANEL_MAX = 1600;
const BROWSER_PIP_MIN_WIDTH = 300;
const BROWSER_PIP_MIN_HEIGHT = 220;

export interface BrowserPipBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type BrowserPipResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const BROWSER_PIP_RESIZE_CORNERS: readonly BrowserPipResizeCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

const BROWSER_ACTION_LABELS: Record<BrowserControlAction, string> = {
  open: "Opening a page…",
  "list-tabs": "Checking tabs…",
  snapshot: "Reading the page…",
  click: "Clicking…",
  type: "Typing…",
  key: "Using the keyboard…",
  scroll: "Scrolling…",
  back: "Going back…",
  forward: "Going forward…",
  reload: "Reloading…",
  screenshot: "Taking a screenshot…",
  "close-tab": "Closing a tab…",
};

interface BrowserPanelProps {
  mode: "sidebar" | "pip";
  tabs: BrowserTab[];
  activeTab: BrowserTab | undefined;
  activeControl: BrowserControlSession | undefined;
  address: string;
  defaultWidth: () => number;
  maxWidth: () => number;
  controlForTab: (tab: BrowserTab) => BrowserControlSession | undefined;
  controllerForTab: (tab: BrowserTab) => BotProfile | undefined;
  onAddressChange: (value: string) => void;
  onOpenAddress: (address?: string) => void;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onSurface: (element: HTMLDivElement) => void;
  onWidthChange: (width: number) => void;
  pipBounds: BrowserPipBounds;
  constrainPipBounds: (bounds: BrowserPipBounds) => BrowserPipBounds;
  onPipBoundsChange: (bounds: BrowserPipBounds, commit: boolean) => void;
  onEnterPip: () => void;
  onDockPip: () => void;
  onHidePip: () => void;
}

export default function BrowserPanel(props: BrowserPanelProps) {
  const defaultPanelWidth = () =>
    Math.round(Math.min(BROWSER_PANEL_MAX, Math.max(BROWSER_PANEL_MIN, props.defaultWidth())));
  const [panelWidth, setPanelWidth] = createSignal(
    readPanelWidth(BROWSER_PANEL_STORAGE_KEY, defaultPanelWidth(), BROWSER_PANEL_MIN, BROWSER_PANEL_MAX),
  );
  createEffect(
    () => panelWidth(),
    (width) => {
      props.onWidthChange(width);
    },
  );

  const resizePanel = (width: number) => {
    setPanelWidth(width);
  };

  let cleanupPipPointer: (() => void) | undefined;
  onCleanup(() => cleanupPipPointer?.());

  const beginPipPointer = (event: PointerEvent, corner?: BrowserPipResizeCorner) => {
    if (event.button !== 0) return;
    if (!corner && event.target instanceof Element && event.target.closest("button")) return;
    event.preventDefault();
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    target.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const start = props.pipBounds;

    const nextBounds = (clientX: number, clientY: number): BrowserPipBounds => {
      const deltaX = clientX - startX;
      const deltaY = clientY - startY;
      if (!corner) {
        return props.constrainPipBounds({ ...start, x: start.x + deltaX, y: start.y + deltaY });
      }

      let { x, y, width, height } = start;
      if (corner.includes("left")) {
        const right = start.x + start.width;
        x = Math.min(right - BROWSER_PIP_MIN_WIDTH, start.x + deltaX);
        width = right - x;
      } else {
        width = Math.max(BROWSER_PIP_MIN_WIDTH, start.width + deltaX);
      }
      if (corner.includes("top")) {
        const bottom = start.y + start.height;
        y = Math.min(bottom - BROWSER_PIP_MIN_HEIGHT, start.y + deltaY);
        height = bottom - y;
      } else {
        height = Math.max(BROWSER_PIP_MIN_HEIGHT, start.height + deltaY);
      }
      return props.constrainPipBounds({ x, y, width, height });
    };

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      props.onPipBoundsChange(nextBounds(moveEvent.clientX, moveEvent.clientY), false);
    };
    const finish = (finishEvent?: PointerEvent) => {
      if (finishEvent && finishEvent.pointerId !== event.pointerId) return;
      const bounds = finishEvent ? nextBounds(finishEvent.clientX, finishEvent.clientY) : props.pipBounds;
      props.onPipBoundsChange(bounds, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      cleanupPipPointer = undefined;
      if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
    };
    const cancel = () => finish();

    cleanupPipPointer?.();
    cleanupPipPointer = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  };

  const pageLabel = () => {
    const tab = props.activeTab;
    if (!tab) return "Browser";
    if (tab.title) return tab.title;
    try {
      return new URL(tab.url).hostname || tab.url;
    } catch {
      return tab.url;
    }
  };

  const surface = () => (
    <div class="browser-surface" ref={props.onSurface}>
      <Show when={props.tabs.length === 0}>
        <div class="browser-empty-state">
          <strong>Open a page</strong>
          <span>The agent can browse here while it works.</span>
        </div>
      </Show>
    </div>
  );

  const addressBar = () => (
    <form
      class="browser-address-bar"
      onSubmit={(event) => {
        event.preventDefault();
        props.onOpenAddress();
      }}
    >
      <Input
        value={props.address}
        aria-label="Browser address"
        maxlength={INPUT_LIMITS.browserUrl}
        onValueChange={props.onAddressChange}
      />
    </form>
  );

  return (
    <Show
      when={props.mode === "sidebar"}
      fallback={
        <aside
          id="browser-picture-in-picture"
          class={["browser-panel", "browser-panel-pip", { "browser-panel-controlled": Boolean(props.activeControl) }]}
          aria-label="Browser"
          style={{
            left: `${props.pipBounds.x}px`,
            top: `${props.pipBounds.y}px`,
            width: `${props.pipBounds.width}px`,
            height: `${props.pipBounds.height}px`,
          }}
        >
          <header class="browser-pip-header" onPointerDown={(event) => beginPipPointer(event)}>
            <span class="browser-pip-title" title={pageLabel()}>
              {pageLabel()}
            </span>
            <div class="browser-pip-actions">
              <Button
                type="button"
                class="browser-toolbar-button"
                aria-label="Dock browser to right sidebar"
                onClick={props.onDockPip}
              >
                <PanelRight class="browser-toolbar-icon" />
              </Button>
              <Button type="button" class="browser-toolbar-button" aria-label="Hide browser" onClick={props.onHidePip}>
                <X class="browser-toolbar-icon" />
              </Button>
            </div>
          </header>
          <div class="browser-toolbar browser-pip-toolbar">{addressBar()}</div>
          <div class="browser-pip-content">{surface()}</div>
          <For each={BROWSER_PIP_RESIZE_CORNERS}>
            {(corner) => (
              <div
                class={`browser-pip-resize browser-pip-resize-${corner}`}
                aria-hidden="true"
                onPointerDown={(event) => beginPipPointer(event, corner)}
              />
            )}
          </For>
        </aside>
      }
    >
      <Tabs.Root
        as="aside"
        id="browser-side-panel"
        class={["browser-panel", { "browser-panel-controlled": Boolean(props.activeControl) }]}
        aria-label="Browser"
        value={props.activeTab?.id ?? "__empty"}
        onChange={props.onActivateTab}
        activationMode="automatic"
      >
        <PanelResizer
          class="right-panel-resizer"
          label="Resize right panel"
          controls="browser-side-panel"
          direction="right"
          value={panelWidth()}
          defaultValue={defaultPanelWidth()}
          min={BROWSER_PANEL_MIN}
          max={props.maxWidth}
          onResize={resizePanel}
          onResizeEnd={(value) => savePanelWidth(BROWSER_PANEL_STORAGE_KEY, value)}
        />
        <header class="browser-panel-header">
          <div class="browser-tabs">
            <Tabs.List class="browser-tab-strip" aria-label="Browser tabs">
              <For each={props.tabs}>
                {(tab) => {
                  const control = () => props.controlForTab(tab);
                  const controller = () => props.controllerForTab(tab);
                  const title = () => (tab.loading ? "Loading…" : tab.title || tab.url);
                  return (
                    <div
                      role="presentation"
                      class={["browser-tab-wrap", { "browser-tab-controlled": Boolean(control()) }]}
                    >
                      <Tabs.Trigger
                        as={Button}
                        value={tab.id}
                        aria-label={control() ? `${title()}, controlled by ${controller()?.name ?? "agent"}` : title()}
                        aria-description="Press Delete or Control/Command W to close"
                        class="browser-tab"
                        onPointerDown={(event) => {
                          if (event.button !== 1) return;
                          event.preventDefault();
                          event.stopPropagation();
                          props.onCloseTab(tab.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Delete") return;
                          event.preventDefault();
                          props.onCloseTab(tab.id);
                        }}
                      >
                        <Show when={control()}>
                          {(session) => (
                            <span
                              class={[
                                "browser-tab-control",
                                { "browser-tab-control-acting": session().phase === "acting" },
                              ]}
                              title={`${controller()?.name ?? "Agent"}: ${BROWSER_ACTION_LABELS[session().action]}`}
                            >
                              <BrowserControlIcon />
                            </span>
                          )}
                        </Show>
                        <span class="browser-tab-title">{title()}</span>
                        <span
                          class="browser-tab-close"
                          aria-hidden="true"
                          title={`Close ${tab.title || "browser tab"}`}
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (event.button === 1) props.onCloseTab(tab.id);
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            props.onCloseTab(tab.id);
                          }}
                        >
                          <CloseIcon />
                        </span>
                      </Tabs.Trigger>
                    </div>
                  );
                }}
              </For>
            </Tabs.List>
            <Button
              type="button"
              class="browser-new-tab"
              aria-label="New browser tab"
              onClick={() => {
                props.onAddressChange("https://www.google.com");
                props.onOpenAddress("https://www.google.com");
              }}
            >
              <PlusIcon />
            </Button>
          </div>
        </header>
        <Tabs.Content forceMount value={props.activeTab?.id ?? "__empty"} class="browser-tab-panel">
          <div class="browser-toolbar">
            <Button type="button" aria-label="Go back" class="browser-toolbar-button" disabled>
              <BrowserBackIcon />
            </Button>
            <Button type="button" aria-label="Go forward" class="browser-toolbar-button" disabled>
              <BrowserForwardIcon />
            </Button>
            <Button
              type="button"
              aria-label="Reload page"
              class="browser-toolbar-button"
              onClick={() => props.onOpenAddress()}
            >
              <BrowserReloadIcon />
            </Button>
            {addressBar()}
            <Button
              type="button"
              class="browser-toolbar-button"
              aria-label="Open browser Picture in Picture"
              onClick={props.onEnterPip}
            >
              <PictureInPicture2 class="browser-toolbar-icon" />
            </Button>
          </div>
          {surface()}
        </Tabs.Content>
      </Tabs.Root>
    </Show>
  );
}

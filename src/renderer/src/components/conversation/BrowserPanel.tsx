import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  BrowserControlAction,
  BrowserControlDetailAction,
  BrowserControlSession,
  BrowserTab,
} from "@openbot/contracts/ipc";
import { createEffect, createSignal, For, Show } from "solid-js";
import type { BotProfile } from "../../data";
import { PanelResizer, readPanelWidth, savePanelWidth } from "../PanelResizer";
import {
  Button,
  buttonVariants,
  CircleDot,
  Input,
  MonitorSmartphone,
  PictureInPicture2,
  Tabs,
  TriangleAlert,
} from "../ui";
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
const BROWSER_ACTION_LABELS: Record<BrowserControlAction | BrowserControlDetailAction, string> = {
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
  status: "Checking browser status…",
  navigate: "Navigating…",
  press: "Using the keyboard…",
  hover: "Hovering…",
  "select-option": "Selecting an option…",
  "set-checked": "Changing a control…",
  drag: "Dragging…",
  "upload-files": "Uploading files…",
  "wait-for": "Waiting for the page…",
  evaluate: "Evaluating page code…",
  "set-environment": "Changing the viewport…",
  "recording-start": "Starting recording…",
  "recording-stop": "Saving recording…",
  "close-tab": "Closing a tab…",
};

interface BrowserPanelProps {
  tabs: BrowserTab[];
  activeTab: BrowserTab | undefined;
  activeControl: BrowserControlSession | undefined;
  address: string;
  defaultWidth: () => number;
  maxWidth: () => number;
  controlForTab: (tab: BrowserTab) => BrowserControlSession | undefined;
  controllerForTab: (tab: BrowserTab) => BotProfile | undefined;
  onAddressChange: (value: string) => void;
  onAddressEditingChange: (editing: boolean) => void;
  onOpenAddress: (address?: string) => void;
  onNavigate: (tabId: string, direction: "back" | "forward") => void;
  onReload: (tabId: string) => void;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onSurface: (element: HTMLDivElement) => void;
  onWidthChange: (width: number) => void;
  onEnterPip: () => void;
}

export default function BrowserPanel(props: BrowserPanelProps) {
  const actingControl = () => (props.activeControl?.phase === "acting" ? props.activeControl : undefined);
  const defaultPanelWidth = () =>
    Math.round(Math.min(BROWSER_PANEL_MAX, Math.max(BROWSER_PANEL_MIN, props.defaultWidth())));
  const storedPanelWidth = Number.parseFloat(window.localStorage.getItem(BROWSER_PANEL_STORAGE_KEY) ?? "");
  let customPanelWidth = Number.isFinite(storedPanelWidth);
  let savedCustomPanelWidth = customPanelWidth ? storedPanelWidth : null;
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

  const saveCustomPanelWidth = (width: number) => {
    customPanelWidth = true;
    savedCustomPanelWidth = width;
    savePanelWidth(BROWSER_PANEL_STORAGE_KEY, width);
  };

  const resizeDefaultPanel = () => {
    const preferredWidth =
      customPanelWidth && savedCustomPanelWidth !== null ? savedCustomPanelWidth : defaultPanelWidth();
    setPanelWidth(Math.round(Math.min(props.maxWidth(), Math.max(BROWSER_PANEL_MIN, preferredWidth))));
  };

  const resetPanelWidth = () => {
    window.localStorage.removeItem(BROWSER_PANEL_STORAGE_KEY);
    customPanelWidth = false;
    savedCustomPanelWidth = null;
    setPanelWidth(defaultPanelWidth());
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
        onFocus={() => props.onAddressEditingChange(true)}
        onBlur={() => props.onAddressEditingChange(false)}
      />
    </form>
  );

  return (
    <Tabs.Root
      as="aside"
      id="browser-side-panel"
      class={["browser-panel", { "browser-panel-controlled": Boolean(actingControl()) }]}
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
        onResizeEnd={saveCustomPanelWidth}
        onParentResize={resizeDefaultPanel}
        onReset={resetPanelWidth}
      />
      <header class="browser-panel-header">
        <div class="browser-tabs">
          <Tabs.List class="browser-tab-strip" aria-label="Browser tabs">
            <For each={props.tabs}>
              {(tab) => {
                const control = () => {
                  const session = props.controlForTab(tab);
                  return session?.phase === "acting" ? session : undefined;
                };
                const controller = () => props.controllerForTab(tab);
                const title = () => (tab.loading ? "Loading…" : tab.title || tab.url);
                return (
                  <div
                    role="presentation"
                    class={["browser-tab-wrap", { "browser-tab-controlled": Boolean(control()) }]}
                  >
                    <Tabs.Trigger
                      as="button"
                      value={tab.id}
                      aria-label={control() ? `${title()}, controlled by ${controller()?.name ?? "agent"}` : title()}
                      aria-description="Press Delete or Control/Command W to close"
                      class={buttonVariants({ variant: "ghost", class: "browser-tab" })}
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
                            class="browser-tab-control browser-tab-control-acting"
                            title={`${controller()?.name ?? "Agent"}: ${BROWSER_ACTION_LABELS[session().detailAction ?? session().action]}`}
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
            variant="ghost"
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
          <Button
            variant="ghost"
            type="button"
            aria-label="Go back"
            class="browser-toolbar-button"
            disabled={!props.activeTab}
            onClick={() => props.activeTab && props.onNavigate(props.activeTab.id, "back")}
          >
            <BrowserBackIcon />
          </Button>
          <Button
            variant="ghost"
            type="button"
            aria-label="Go forward"
            class="browser-toolbar-button"
            disabled={!props.activeTab}
            onClick={() => props.activeTab && props.onNavigate(props.activeTab.id, "forward")}
          >
            <BrowserForwardIcon />
          </Button>
          <Button
            variant="ghost"
            type="button"
            aria-label="Reload page"
            class="browser-toolbar-button"
            disabled={!props.activeTab}
            onClick={() => props.activeTab && props.onReload(props.activeTab.id)}
          >
            <BrowserReloadIcon />
          </Button>
          {addressBar()}
          <Show when={props.activeTab?.environment}>
            {(environment) => (
              <span
                class="browser-environment-status"
                title={`Viewport ${environment().viewport.width}×${environment().viewport.height}, ${environment().colorScheme} color scheme`}
              >
                <MonitorSmartphone />
                <span>
                  {environment().viewport.width}×{environment().viewport.height}
                </span>
              </span>
            )}
          </Show>
          <Show when={props.activeTab?.recording}>
            <span class="browser-recording-status" role="status" aria-label="Browser recording active">
              <CircleDot /> REC
            </span>
          </Show>
          <Show when={(props.activeTab?.diagnosticErrorCount ?? 0) > 0}>
            <span
              class="browser-diagnostic-status"
              role="status"
              title={`${props.activeTab?.diagnosticErrorCount} browser diagnostic errors`}
              aria-label={`${props.activeTab?.diagnosticErrorCount} browser diagnostic errors`}
            >
              <TriangleAlert /> {props.activeTab?.diagnosticErrorCount}
            </span>
          </Show>
          <Button
            variant="ghost"
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
  );
}

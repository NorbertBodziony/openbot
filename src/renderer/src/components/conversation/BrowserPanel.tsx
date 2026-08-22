import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { BrowserControlAction, BrowserControlSession, BrowserTab } from "@openbot/contracts/ipc";
import { createEffect, createSignal, For, Show } from "solid-js";
import type { BotProfile } from "../../data";
import { PanelResizer, readPanelWidth, savePanelWidth } from "../PanelResizer";
import { Button, Input, Tabs } from "../ui";
import {
  BrowserBackIcon,
  BrowserControlIcon,
  BrowserForwardIcon,
  BrowserReloadIcon,
  CloseIcon,
  PlusIcon,
} from "./ConversationIcons";

const BROWSER_PANEL_STORAGE_KEY = "openbot:browser-panel-width";
const BROWSER_PANEL_DEFAULT = 380;
const BROWSER_PANEL_MIN = 220;
const BROWSER_PANEL_MAX = 1600;

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
  tabs: BrowserTab[];
  activeTab: BrowserTab | undefined;
  activeControl: BrowserControlSession | undefined;
  address: string;
  maxWidth: () => number;
  controlForTab: (tab: BrowserTab) => BrowserControlSession | undefined;
  controllerForTab: (tab: BrowserTab) => BotProfile | undefined;
  onAddressChange: (value: string) => void;
  onOpenAddress: (address?: string) => void;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onSurface: (element: HTMLDivElement) => void;
  onWidthChange: (width: number) => void;
}

export default function BrowserPanel(props: BrowserPanelProps) {
  const [panelWidth, setPanelWidth] = createSignal(
    readPanelWidth(BROWSER_PANEL_STORAGE_KEY, BROWSER_PANEL_DEFAULT, BROWSER_PANEL_MIN, BROWSER_PANEL_MAX),
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

  return (
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
        defaultValue={BROWSER_PANEL_DEFAULT}
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
          <Button type="button" class="browser-toolbar-button" aria-label="Browser menu">
            <span class="browser-menu-dots">•••</span>
          </Button>
        </div>
        <div class="browser-surface" ref={props.onSurface}>
          <Show when={props.tabs.length === 0}>
            <div class="browser-empty-state">
              <strong>Open a page</strong>
              <span>The agent can browse here while it works.</span>
            </div>
          </Show>
        </div>
      </Tabs.Content>
    </Tabs.Root>
  );
}

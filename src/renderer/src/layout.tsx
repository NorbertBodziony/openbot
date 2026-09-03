import type { AppInfo } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, onSettled } from "solid-js";
import { readPanelWidth } from "./components/PanelResizer";
import {
  CONVERSATION_MIN_WIDTH,
  LEFT_PANEL_COLLAPSED_STORAGE_KEY,
  LEFT_PANEL_DEFAULT,
  LEFT_PANEL_MAX,
  LEFT_PANEL_MIN,
  LEFT_PANEL_STORAGE_KEY,
  MAC_SERVER_RAIL_WIDTH,
  NARROW_SERVER_RAIL_WIDTH,
  SERVER_RAIL_WIDTH,
} from "./layout-constants";
import { usePlatform } from "./platform";
import { createSimpleContext } from "./simple-context";

/**
 * Whether the conversation still has room beside a sidebar of this width. The
 * server rail only exists on macOS and Windows, and narrows on a small Windows
 * window, so the platform is part of the arithmetic rather than a style detail.
 */
function shouldAutoCompactSidebar(platform: AppInfo["platform"] | undefined, panelWidth: number): boolean {
  const serverRailWidth =
    platform === "darwin"
      ? MAC_SERVER_RAIL_WIDTH
      : platform === "win32"
        ? window.innerWidth <= 800
          ? NARROW_SERVER_RAIL_WIDTH
          : SERVER_RAIL_WIDTH
        : 0;
  return window.innerWidth - serverRailWidth - panelWidth < CONVERSATION_MIN_WIDTH;
}

/**
 * The width of the workspace sidebar, and the two independent reasons it can be
 * narrow: the user collapsed it, or the window is too small to keep it open.
 *
 * Only the first is persisted. The second is recomputed from the window on every
 * resize and on every platform change, so restoring a wide sidebar into a narrow
 * window compacts it again rather than restoring an unusable layout - and
 * `expandSidebar` clears both, because a user asking for the sidebar back means
 * both reasons at once.
 *
 * The geometry itself is in `layout-constants.ts`; the view imports it directly
 * rather than reading constants through a context.
 */
const Layout = createSimpleContext({
  name: "Layout",
  init: () => {
    const platform = usePlatform();
    const [leftPanelWidth, setLeftPanelWidth] = createSignal(
      readPanelWidth(LEFT_PANEL_STORAGE_KEY, LEFT_PANEL_DEFAULT, LEFT_PANEL_MIN, LEFT_PANEL_MAX),
    );
    const [leftPanelCollapsed, setLeftPanelCollapsed] = createSignal(
      window.localStorage.getItem(LEFT_PANEL_COLLAPSED_STORAGE_KEY) === "true",
    );
    const [leftPanelAutoCompact, setLeftPanelAutoCompact] = createSignal(false);
    const leftPanelCompact = createMemo(() => leftPanelCollapsed() || leftPanelAutoCompact());

    function updateResponsiveSidebar(): void {
      setLeftPanelAutoCompact(shouldAutoCompactSidebar(platform.appInfo()?.platform, leftPanelWidth()));
    }

    createEffect(
      () => ({ osPlatform: platform.appInfo()?.platform, panelWidth: leftPanelWidth() }),
      ({ osPlatform, panelWidth }) => {
        setLeftPanelAutoCompact(shouldAutoCompactSidebar(osPlatform, panelWidth));
      },
    );

    onSettled(() => {
      window.addEventListener("resize", updateResponsiveSidebar);
      return () => window.removeEventListener("resize", updateResponsiveSidebar);
    });

    function setSidebarCollapsed(collapsed: boolean): void {
      setLeftPanelCollapsed(collapsed);
      window.localStorage.setItem(LEFT_PANEL_COLLAPSED_STORAGE_KEY, String(collapsed));
    }

    function expandSidebar(): void {
      setSidebarCollapsed(false);
      setLeftPanelAutoCompact(false);
    }

    return {
      leftPanelWidth,
      setLeftPanelWidth,
      leftPanelCompact,
      setSidebarCollapsed,
      expandSidebar,
    };
  },
});

export const LayoutProvider = Layout.provider;
export const useLayout = Layout.use;

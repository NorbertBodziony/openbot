/**
 * Geometry for the workspace shell. These are module constants, not state: the
 * controller only used to hand them through its context because the view could
 * not import `App.tsx` without closing an import cycle.
 */

export const LEFT_PANEL_STORAGE_KEY = "openbot:left-panel-width";
export const LEFT_PANEL_COLLAPSED_STORAGE_KEY = "openbot:left-panel-collapsed";
export const LEFT_PANEL_DEFAULT = 280;
export const LEFT_PANEL_MIN = 240;
export const LEFT_PANEL_MAX = 400;
export const LEFT_PANEL_COMPACT = 88;
export const LEFT_PANEL_COLLAPSE_THRESHOLD = 210;
export const LEFT_PANEL_EXPAND_THRESHOLD = 220;
export const CONVERSATION_MIN_WIDTH = 424;
export const MAC_SERVER_RAIL_WIDTH = 72;
export const SERVER_RAIL_WIDTH = 64;
export const NARROW_SERVER_RAIL_WIDTH = 56;

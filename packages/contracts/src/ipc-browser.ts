export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  ownerThreadId: string | null;
  ownerBotId: string | null;
}

export interface BrowserPreview {
  dataUrl: string;
  width: number;
  height: number;
}

export type BrowserControlPhase = "acting" | "waiting";

export type BrowserControlAction =
  | "open"
  | "list-tabs"
  | "snapshot"
  | "click"
  | "type"
  | "key"
  | "scroll"
  | "back"
  | "forward"
  | "reload"
  | "screenshot"
  | "close-tab";

export interface BrowserControlSession {
  id: string;
  threadId: string;
  turnId: string;
  callId: string;
  tabId: string | null;
  action: BrowserControlAction;
  phase: BrowserControlPhase;
  startedAt: string;
}

export interface BrowserControlState {
  sessions: BrowserControlSession[];
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserViewTarget = "main" | "picture-in-picture";

export interface BrowserDisplayState {
  tabs: BrowserTab[];
  activeTabId: string | null;
}

export type BrowserPictureInPictureEvent =
  | { type: "bounds-changed"; bounds: BrowserBounds }
  | { type: "dock" }
  | { type: "hide" };

export interface BrowserOpenInput {
  url: string;
  ownerThreadId?: string | null;
  ownerBotId?: string | null;
  focus?: boolean;
}

export type BrowserNavigationDirection = "back" | "forward";

export interface BrowserNavigateInput {
  tabId: string;
  direction: BrowserNavigationDirection;
}

export interface BrowserVisibilityInput {
  visible: boolean;
  bounds?: BrowserBounds;
  target?: BrowserViewTarget;
}

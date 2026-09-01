export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  ownerThreadId: string | null;
  ownerBotId: string | null;
  /** Browser Automation V2 metadata. Optional to keep Team API protocol v1 wire-compatible. */
  environment?: BrowserEnvironment;
  recording?: boolean;
  diagnosticErrorCount?: number;
}

export type BrowserImageMode = "auto" | "always" | "never";

export type BrowserTarget =
  | { kind: "ref"; ref: string; revision: number }
  | { kind: "role"; role: string; name?: string; exact?: boolean }
  | { kind: "text"; text: string; exact?: boolean }
  | { kind: "css"; selector: string }
  | { kind: "point"; x: number; y: number };

export interface BrowserViewport {
  mode: "fill" | "custom";
  width: number;
  height: number;
  deviceScaleFactor: number;
  preset: "desktop" | "tablet" | "mobile" | null;
}

export interface BrowserEnvironment {
  viewport: BrowserViewport;
  colorScheme: "light" | "dark" | "system";
  reducedMotion: boolean;
}

export interface BrowserElement {
  ref: string;
  role: string | null;
  name: string;
  description: string;
  tag: string;
  value: string | null;
  states: string[];
  /** Legacy convenience field; the canonical state is also present in states. */
  disabled: boolean;
  bounds: BrowserBounds | null;
  frame: { id: string; url: string } | null;
}

export interface BrowserDiagnosticEntry {
  timestamp: string;
  kind: "console" | "network" | "load";
  level: "debug" | "info" | "warning" | "error";
  message: string;
  url?: string;
  method?: string;
  status?: number;
}

export interface BrowserActionHistoryEntry {
  timestamp: string;
  action: string;
  target?: string;
  outcome: "success" | "error";
  detail?: string;
}

export interface BrowserSnapshot {
  tabId: string;
  revision: number;
  title: string;
  url: string;
  loading: boolean;
  viewport: BrowserViewport;
  text: string;
  elements: BrowserElement[];
  diagnostics: BrowserDiagnosticEntry[];
  actions: BrowserActionHistoryEntry[];
  image?: { included: boolean; reason: string; width: number; height: number };
}

export interface BrowserRecordingArtifact {
  path: string;
  mimeType: "video/webm";
  bytes: number;
  durationMs: number;
  stoppedReason: "requested" | "duration-limit" | "size-limit" | "tab-closed" | "error";
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

export type BrowserControlDetailAction =
  | "status"
  | "navigate"
  | "press"
  | "hover"
  | "select-option"
  | "set-checked"
  | "drag"
  | "upload-files"
  | "wait-for"
  | "set-environment"
  | "recording-start"
  | "recording-stop";

export interface BrowserControlSession {
  id: string;
  threadId: string;
  turnId: string;
  callId: string;
  tabId: string | null;
  action: BrowserControlAction;
  /** Local V2 UI detail. Team API v1 projection intentionally strips this optional field. */
  detailAction?: BrowserControlDetailAction;
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

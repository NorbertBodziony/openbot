import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { parseInviteUrl } from "@openbot/contracts/invite-links";
import {
  type AgentEvent,
  type BrowserDisplayState,
  type CentralAuthState,
  IPC_CHANNELS,
  LOCAL_SERVER_ID,
  type MacPermissionId,
  type VoiceModelStatus,
} from "@openbot/contracts/ipc";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import {
  app,
  BrowserWindow,
  type Display,
  dialog,
  Menu,
  Notification,
  powerMonitor,
  protocol,
  type Rectangle,
  safeStorage,
  screen,
  session,
  shell,
} from "electron";
import electronUpdater from "electron-updater";
import { z } from "zod";
import { AgentService } from "../backend/agent-service";
import { AgentStore } from "../backend/agent-store";
import { BrowserHost } from "../backend/browser-host";
import { isCloseBrowserTabShortcut, isSelectAllShortcut, isToggleDevToolsShortcut } from "../backend/browser-shortcuts";
import { MailboxStore } from "../backend/mailbox-store";
import { SidebarLayoutStore } from "../backend/sidebar-layout-store";
import { TeamChatStore } from "../backend/team-chat-store";
import { AgentInitializationGate } from "./agent-initialization";
import { AgentMarketplaceService } from "./agent-marketplace-service";
import { notificationForAgentEvent } from "./agent-notifications";
import { HostAnalytics } from "./analytics";
import { readAnalyticsPreference } from "./analytics-preference-store";
import { readAppVariant, resolveAppIconPath } from "./app-icon";
import { BrowserPictureInPicture } from "./browser-picture-in-picture";
import { CentralAuthManager, readCentralAuthApiUrl, readMobileConnectApiUrl } from "./central-auth-manager";
import { ComputerUseMacSetupService } from "./computer-use-mac-setup";
import { ComputerUseMacSetupWindowController } from "./computer-use-mac-setup-window";
import { buildContentSecurityPolicy } from "./content-security-policy";
import { guardDevelopmentOutput } from "./development-output";
import {
  developmentUserDataName,
  readDevelopmentInstanceId,
  readDevelopmentProfile,
  readDevelopmentRemoteDebuggingPort,
  shouldAutoStartHost,
  shouldShowDevelopmentWindow,
} from "./development-profile";
import { performDynamicIslandCriticalAction } from "./dynamic-island-actions";
import { DynamicIslandWindowController, dynamicIslandNotchSizeForDisplay } from "./dynamic-island-window";
import { DEVELOPMENT_REMOTE_CLIENT_USERNAME, HostService } from "./host-service";
import { HostedSiteDesktopService } from "./hosted-site-service";
import { registerAccountIpcHandlers } from "./ipc/register-account-handlers";
import { registerAgentIpcHandlers } from "./ipc/register-agent-handlers";
import { registerAppIpcHandlers } from "./ipc/register-app-handlers";
import { registerAttachmentIpcHandlers } from "./ipc/register-attachment-handlers";
import { registerBrowserIpcHandlers } from "./ipc/register-browser-handlers";
import { registerComputerUseIpcHandlers } from "./ipc/register-computer-use-handlers";
import { registerDynamicIslandIpcHandlers } from "./ipc/register-dynamic-island-handlers";
import { registerHostedSiteIpcHandlers } from "./ipc/register-hosted-site-handlers";
import { registerMarketplaceAgentIpcHandlers } from "./ipc/register-marketplace-agent-handlers";
import { registerMemoryIpcHandlers } from "./ipc/register-memory-handlers";
import { registerProviderIpcHandlers } from "./ipc/register-provider-handlers";
import { registerRoutineIpcHandlers } from "./ipc/register-routine-handlers";
import { registerSkillIpcHandlers } from "./ipc/register-skill-handlers";
import { registerTeamIpcHandlers, withLocalHostSummary } from "./ipc/register-team-handlers";
import { registerUpdateIpcHandlers } from "./ipc/register-update-handlers";
import { registerVoiceIpcHandlers } from "./ipc/register-voice-handlers";
import { MacHapticFeedback } from "./mac-haptic-feedback";
import {
  ensureMacApplicationPresence,
  presentMainWindow,
  readMainWindowBounds,
  resolveMainWindowBounds,
  writeMainWindowBounds,
} from "./main-window-state";
import { ManagedSkillService } from "./managed-skill-service";
import { ProviderRuntimeManager } from "./provider-runtime-manager";
import { RemoteDesktopManager } from "./remote-desktop-manager";
import { resolveRemoteDesktopRuntime } from "./remote-desktop-runtime-artifact";
import { loadOrCreateRemoteDesktopCredentials } from "./remote-desktop-secret-store";
import { decodeVoid } from "./remote-host-decoding";
import { type DevelopmentRemoteServerConnection, RemoteServerManager } from "./remote-server-manager";
import { sendToRenderer } from "./renderer-ipc";
import { canCheckRendererPermission, canRequestRendererPermission } from "./renderer-permissions";
import { readSetupState, writeSetupState } from "./setup-store";
import { SkillMarketplaceService } from "./skill-marketplace-service";
import { TeamStore } from "./team-store";
import { TeamWebRtcBridge } from "./team-webrtc-bridge";
import { TeamWebRtcClientTransport } from "./team-webrtc-client-transport";
import { isTrustedRendererUrl } from "./trusted-renderer";
import { readUpdatePreference } from "./update-preference-store";
import { supportsInstalledUpdates, UpdateService } from "./update-service";
import { WHISPER_MODEL_NAME, WHISPER_MODEL_URL } from "./voice-model-service";
import { VoiceTranscriptionService } from "./voice-transcription-service";

const logger = createOpenBotLogger("main");

const commandLineUserDataDirectory = app.commandLine.getSwitchValue("user-data-dir").trim();
const developmentProfile = !app.isPackaged ? readDevelopmentProfile(process.env.OPENBOT_DEV_PROFILE) : null;
const developmentRemoteRole =
  !app.isPackaged &&
  (process.env.OPENBOT_DEV_REMOTE_ROLE === "host" || process.env.OPENBOT_DEV_REMOTE_ROLE === "client")
    ? process.env.OPENBOT_DEV_REMOTE_ROLE
    : null;
const developmentTestClientEnabled = !app.isPackaged && process.env.OPENBOT_DEV_TEST_CLIENT_ENABLED === "1";
const developmentInviteLinkOptions = {
  allowLocalDevelopmentApiUrl: developmentRemoteRole !== null,
};
const developmentRemoteDebuggingPort = !app.isPackaged
  ? readDevelopmentRemoteDebuggingPort(process.env.OPENBOT_DEV_REMOTE_DEBUGGING_PORT)
  : null;
if (developmentRemoteDebuggingPort) {
  app.commandLine.appendSwitch("remote-debugging-port", developmentRemoteDebuggingPort);
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}
if (commandLineUserDataDirectory) {
  app.setPath("userData", resolve(commandLineUserDataDirectory));
} else if (!app.isPackaged) {
  app.setPath(
    "userData",
    join(
      app.getPath("appData"),
      developmentUserDataName(
        developmentProfile ?? "app",
        readDevelopmentInstanceId(process.env.OPENBOT_DEV_INSTANCE_ID),
      ),
    ),
  );
}
app.setName("OpenBot");
app.enableSandbox();
if (process.platform === "win32") app.setAppUserModelId("app.openbot.desktop");
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const appVariant = readAppVariant(process.env.OPENBOT_APP_VARIANT, app.isPackaged);
if (!app.isPackaged) guardDevelopmentOutput([process.stdout, process.stderr], () => app.quit());
const appIconPath = resolveAppIconPath({
  variant: appVariant,
  platform: process.platform,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  sourceRoot: resolve(__dirname, "../.."),
});
protocol.registerSchemesAsPrivileged([
  {
    scheme: "openbot-app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "openbot-attachment",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: "openbot-remote-attachment",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: "openbot-avatar",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "openbot-remote-avatar",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "openbot-server-logo",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "openbot-remote-server-logo",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
let mainWindowLoad: Promise<BrowserWindow> | null = null;
let browserHost: BrowserHost | null = null;
let browserPictureInPicture: BrowserPictureInPicture | null = null;
let agentService: AgentService | null = null;
let mailboxStore: MailboxStore | null = null;
let updateService: UpdateService | null = null;
let providerRuntimeManager: ProviderRuntimeManager | null = null;
let hostService: HostService | null = null;
let remoteDesktopManager: RemoteDesktopManager | null = null;
let remoteServerManager: RemoteServerManager | null = null;
let centralAuthManager: CentralAuthManager | null = null;
let activeRemotePrincipalId: string | null = null;
/** Counts account transitions, so queued work for a superseded one is dropped rather than applied. */
let centralAuthGeneration = 0;
let activeAnalyticsPrincipalId: string | null = null;
let remoteAccountSync = Promise.resolve();
let hostAnalytics: HostAnalytics | null = null;
let teamWebRtcBridge: TeamWebRtcBridge | null = null;
let voiceTranscriptionService: VoiceTranscriptionService | null = null;
let dynamicIslandController: DynamicIslandWindowController | null = null;
let computerUseMacSetupController: ComputerUseMacSetupWindowController | null = null;
const macHapticFeedback = new MacHapticFeedback();
let isQuitting = false;
let shutdownStarted = false;
let systemSessionEnding = false;
let systemSessionEndFlushStarted = false;
let mainWindowBounds: Rectangle | null = null;
let mainWindowBoundsWriteTimer: ReturnType<typeof setTimeout> | null = null;
let mainWindowBoundsWrite = Promise.resolve();
let pendingInviteUrl: string | null = findInviteUrl(process.argv);
let inviteReceiverReady = false;

const SETUP_FILE = "openbot-setup-v2.json";
const ANALYTICS_PREFERENCE_FILE = "openbot-analytics-preference-v1.json";
const UPDATE_PREFERENCE_FILE = "openbot-update-preference-v1.json";
const DYNAMIC_ISLAND_PREFERENCE_FILE = "openbot-dynamic-island-preference-v1.json";
const MAIN_WINDOW_STATE_FILE = "openbot-main-window-state-v1.json";

if (!app.isPackaged) {
  const quitAfterDevelopmentSignal = () => app.quit();
  process.once("SIGINT", quitAfterDevelopmentSignal);
  process.once("SIGTERM", quitAfterDevelopmentSignal);
  process.once("SIGHUP", quitAfterDevelopmentSignal);
}
const BROWSER_STATE_FILE = "openbot-browser-state-v1.json";
const SIDEBAR_LAYOUT_FILE = "openbot-sidebar-layout-v1.json";
const TEAM_FILE = "openbot-team-server-v1.json";
/** One host per account. The v1 file above stays as the last build without accounts left it. */
const TEAM_FILE_V2 = "openbot-team-server-v2.json";
const REMOTE_SERVERS_FILE = "openbot-remote-servers-v1.json";
const CENTRAL_AUTH_FILE = "openbot-central-auth-v1.bin";
const LEGACY_REMOTE_DESKTOP_CREDENTIAL_FILE = "openbot-remote-desktop-credential-v1.json";
const REMOTE_DESKTOP_RUNTIME_SECRET_FILE = "openbot-remote-desktop-runtime-v1.json";

function configureContentSecurityPolicy(): void {
  const policy = buildContentSecurityPolicy(app.isPackaged, process.env.REMOTE_SIGNAL_URL);

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== "mainFrame" || !isTrustedRendererUrl(details.url)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

interface IpcHandlerDependencies {
  service: AgentService;
  providerRuntimes: ProviderRuntimeManager;
  mailbox: MailboxStore;
  browser: BrowserHost;
  browserPictureInPicture: BrowserPictureInPicture;
  updater: UpdateService;
  setupFile: string;
  analyticsPreferenceFile: string;
  updatePreferenceFile: string;
  initializeAgent: () => Promise<void>;
  sidebarLayout: SidebarLayoutStore;
  host: HostService;
  remoteDesktop: RemoteDesktopManager;
  remoteServers: RemoteServerManager;
  centralAuth: CentralAuthManager;
  skills: SkillMarketplaceService;
  hostedSites: HostedSiteDesktopService;
  marketplaceAgents: AgentMarketplaceService;
  voice: VoiceTranscriptionService;
  dynamicIsland: DynamicIslandWindowController;
  computerUseMacSetup: ComputerUseMacSetupWindowController;
}

function registerIpcHandlers({
  service,
  providerRuntimes,
  mailbox,
  browser,
  browserPictureInPicture,
  updater,
  setupFile,
  analyticsPreferenceFile,
  updatePreferenceFile,
  initializeAgent,
  sidebarLayout,
  host,
  remoteDesktop,
  remoteServers,
  centralAuth,
  skills,
  hostedSites,
  marketplaceAgents,
  voice,
  dynamicIsland,
  computerUseMacSetup,
}: IpcHandlerDependencies): void {
  // Every renderer-to-main endpoint is registered by one of these, one file per
  // domain under ./ipc. Nothing is registered inline here: this is the trust
  // boundary, and a reviewer should be able to read a domain's whole surface in
  // one file rather than find it interleaved with window and lifecycle code.
  const getMainWindow = () => mainWindow;

  registerAppIpcHandlers({
    service,
    mailbox,
    browser,
    updater,
    setupFile,
    analyticsPreferenceFile,
    initializeAgent,
    appVariant,
    getMainWindow,
    setAnalyticsTrackingEnabled: (enabled) => hostAnalytics?.setTrackingEnabled(enabled),
  });
  registerDynamicIslandIpcHandlers({ dynamicIsland });
  registerComputerUseIpcHandlers({ computerUseMacSetup });
  registerProviderIpcHandlers({ service, providerRuntimes });
  registerVoiceIpcHandlers({ voice });
  registerAccountIpcHandlers({ centralAuth, host });
  registerSkillIpcHandlers({ skills, getMainWindow });
  registerHostedSiteIpcHandlers({ hostedSites, getMainWindow });
  registerMarketplaceAgentIpcHandlers({ marketplaceAgents });
  registerUpdateIpcHandlers({ updater, updatePreferenceFile });
  registerTeamIpcHandlers({
    host,
    remoteDesktop,
    remoteServers,
    takePendingInvite: () => {
      inviteReceiverReady = true;
      const inviteUrl = pendingInviteUrl;
      pendingInviteUrl = null;
      return inviteUrl;
    },
  });
  registerMemoryIpcHandlers({ service, remoteServers });
  registerRoutineIpcHandlers({ service, remoteServers });
  registerAttachmentIpcHandlers({ service, mailbox, remoteServers, getMainWindow });
  registerAgentIpcHandlers({ service, sidebarLayout, host, remoteServers, skills });
  registerBrowserIpcHandlers({ browserPictureInPicture, browser, remoteServers });
}

function createWindow(): BrowserWindow {
  let inspectElementModifierPressed = false;
  const cursor = screen.getCursorScreenPoint();
  const bounds = resolveMainWindowBounds(
    mainWindowBounds,
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getDisplayNearestPoint(cursor).workArea,
    { width: 1200, height: 820 },
    { width: 960, height: 640 },
  );
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#0b0d0e",
    title: developmentProfile === "test-client" ? "OpenBot Local Client" : "OpenBot Local Host",
    icon: appIconPath,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 8, y: 14 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      devTools: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  window.once("ready-to-show", () => {
    if (
      shouldShowDevelopmentWindow({
        remoteRole: developmentRemoteRole,
        testClientEnabled: developmentTestClientEnabled,
      })
    ) {
      window.show();
    }
  });
  window.on("close", (event) => {
    rememberMainWindowBounds(window.getNormalBounds());
    if (process.platform === "darwin" && !isQuitting) {
      // The hidden renderer owns the cross-host Dynamic Island coordinator and must outlive its visible window.
      event.preventDefault();
      window.hide();
    }
  });
  if (process.platform === "win32") {
    window.on("query-session-end", () => {
      systemSessionEnding = true;
      isQuitting = true;
      if (systemSessionEndFlushStarted) return;
      systemSessionEndFlushStarted = true;
      updateService?.stop();
      void flushMainWindowBounds().catch((error) =>
        logger.error("Unable to save the main window position before Windows session end:", toLogValue(error)),
      );
      void browserHost
        ?.flushPersistentStorage()
        .catch((error) =>
          logger.error("Unable to flush browser storage before Windows session end:", toLogValue(error)),
        );
      void providerRuntimeManager?.stop();
    });
    window.on("session-end", () => {
      systemSessionEnding = true;
      isQuitting = true;
      void flushMainWindowBounds().catch((error) =>
        logger.error("Unable to save the main window position during Windows session end:", toLogValue(error)),
      );
      void browserHost
        ?.flushPersistentStorage()
        .catch((error) =>
          logger.error("Unable to flush browser storage during Windows session end:", toLogValue(error)),
        );
      void providerRuntimeManager?.stop();
    });
  }
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.on("move", () => rememberMainWindowBounds(window.getNormalBounds()));
  window.on("resize", () => rememberMainWindowBounds(window.getNormalBounds()));
  window.on("hide", () => computerUseMacSetupController?.close());

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("before-input-event", (event, input) => {
    if (input.key.toLowerCase() === "shift") {
      inspectElementModifierPressed = input.type === "keyDown";
    }
    if (isToggleDevToolsShortcut(input)) {
      event.preventDefault();
      window.webContents.toggleDevTools();
      return;
    }
    if (isSelectAllShortcut(input)) {
      event.preventDefault();
      void window.webContents.executeJavaScript(
        `(() => {
          const active = document.activeElement;
          if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
            active.select();
            return;
          }
          if (!(active instanceof HTMLElement) || !active.isContentEditable) return;
          const range = document.createRange();
          range.selectNodeContents(active);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        })()`,
        true,
      );
      return;
    }
    const tabId = browserHost?.activeTabId;
    if (
      remoteServerManager?.activeServerId !== LOCAL_SERVER_ID ||
      !browserHost?.visible ||
      !tabId ||
      !isCloseBrowserTabShortcut(input)
    ) {
      return;
    }
    event.preventDefault();
    setImmediate(() => void browserHost?.close(tabId).catch(() => undefined));
  });
  window.webContents.on("context-menu", (event, params) => {
    if (!inspectElementModifierPressed) return;
    event.preventDefault();
    window.webContents.inspectElement(params.x, params.y);
  });
  window.on("blur", () => {
    inspectElementModifierPressed = false;
  });
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl)) event.preventDefault();
  });
  window.webContents.on("did-finish-load", () => {
    const service = agentService;
    if (service) forwardAgentEvent("local", { type: "runtime-snapshot", snapshot: service.getRuntimeSnapshot() });
    remoteServerManager?.refreshRuntimeSnapshots();
  });

  return window;
}

function rememberMainWindowBounds(bounds: Rectangle): void {
  mainWindowBounds = { ...bounds };
  if (mainWindowBoundsWriteTimer) clearTimeout(mainWindowBoundsWriteTimer);
  mainWindowBoundsWriteTimer = setTimeout(() => {
    mainWindowBoundsWriteTimer = null;
    void queueMainWindowBoundsWrite().catch((error) =>
      logger.error("Unable to save the main window position:", toLogValue(error)),
    );
  }, 250);
}

function queueMainWindowBoundsWrite(): Promise<void> {
  if (!mainWindowBounds) return mainWindowBoundsWrite;
  const bounds = { ...mainWindowBounds };
  mainWindowBoundsWrite = mainWindowBoundsWrite
    .catch((error) => logger.error("Unable to save the previous main window position:", toLogValue(error)))
    .then(() => writeMainWindowBounds(join(app.getPath("userData"), MAIN_WINDOW_STATE_FILE), bounds));
  return mainWindowBoundsWrite;
}

async function flushMainWindowBounds(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindowBounds = mainWindow.getNormalBounds();
  if (mainWindowBoundsWriteTimer) {
    clearTimeout(mainWindowBoundsWriteTimer);
    mainWindowBoundsWriteTimer = null;
  }
  await queueMainWindowBoundsWrite();
}

function createDynamicIslandWindow(bounds: Rectangle, _display: Display): BrowserWindow {
  const window = new BrowserWindow({
    ...bounds,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    hiddenInMissionControl: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    hasShadow: false,
    skipTaskbar: true,
    type: "panel",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      devTools: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl)) event.preventDefault();
  });
  return window;
}

function createComputerUseMacSetupWindow(): BrowserWindow {
  const workArea =
    mainWindow && !mainWindow.isDestroyed()
      ? screen.getDisplayMatching(mainWindow.getBounds()).workArea
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = 360;
  const height = 300;
  const window = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 16,
    y: workArea.y + 52,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#0b0d0e",
    title: "Set up Computer Use",
    icon: appIconPath,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 12, y: 13 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      devTools: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.setAlwaysOnTop(true, "floating");
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl)) event.preventDefault();
  });
  return window;
}

function loadRenderer(window: BrowserWindow): Promise<void> {
  inviteReceiverReady = false;
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  return developmentUrl ? window.loadURL(developmentUrl) : window.loadURL("openbot-app://app/index.html");
}

async function ensureMainWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  if (mainWindowLoad) return mainWindowLoad;
  const window = createWindow();
  mainWindow = window;
  mainWindowLoad = loadRenderer(window)
    .then(() => window)
    .catch((error) => {
      if (!window.isDestroyed()) window.destroy();
      if (mainWindow === window) mainWindow = null;
      throw error;
    })
    .finally(() => {
      mainWindowLoad = null;
    });
  return mainWindowLoad;
}

function showMainWindow(window: BrowserWindow): void {
  presentMainWindow(window, process.platform, () => app.show());
}

function loadDynamicIslandRenderer(window: BrowserWindow, display: Display): Promise<void> {
  const displayMode = display.internal ? "notch" : "island";
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  const url = new URL(developmentUrl ?? "openbot-app://app/index.html");
  url.searchParams.set("surface", "dynamic-island");
  url.searchParams.set("display", displayMode);
  const notch = dynamicIslandNotchSizeForDisplay(display);
  if (notch) {
    url.searchParams.set("notch-width", String(notch.width));
    url.searchParams.set("notch-height", String(notch.height));
  }
  return window.loadURL(url.toString());
}

function loadComputerUseMacSetupRenderer(window: BrowserWindow, permission: MacPermissionId): Promise<void> {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  const url = new URL(developmentUrl ?? "openbot-app://app/index.html");
  url.searchParams.set("surface", "computer-use-setup");
  url.searchParams.set("permission", permission);
  return window.loadURL(url.toString());
}

function configureApplicationMenu(service: AgentService, updater: UpdateService): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        role: "appMenu",
        submenu: [
          {
            label: "Stop all agents",
            accelerator: "CommandOrControl+.",
            click: () => void service.interruptAll(),
          },
          { type: "separator" },
          {
            label: "Check for Updates…",
            click: () => void updater.checkForUpdates(),
          },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

function forwardAgentEvent(serverId: string, event: AgentEvent, bufferedLive = false): void {
  if (serverId === LOCAL_SERVER_ID) hostAnalytics?.handleAgentEvent(event);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sendToRenderer(
    mainWindow,
    IPC_CHANNELS.agentEvent,
    bufferedLive ? { serverId, event, bufferedLive } : { serverId, event },
  );
  if (mainWindow.isFocused() || !Notification.isSupported()) return;

  const content = notificationForAgentEvent(event, agentService?.listAgents() ?? []);
  if (!content) return;
  const notification = new Notification(content);
  notification.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    showMainWindow(mainWindow);
  });
  notification.show();
}

function forwardBrowserDisplayState(state: BrowserDisplayState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    sendToRenderer(window, IPC_CHANNELS.browserDisplayStateEvent, state);
  }
}

function forwardUpdateStatus(status: import("@openbot/contracts/ipc").UpdateStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sendToRenderer(mainWindow, IPC_CHANNELS.updateEvent, status);
}

function forwardVoiceModelStatus(status: VoiceModelStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sendToRenderer(mainWindow, IPC_CHANNELS.voiceModelStatus, status);
}

function forwardProviderRuntimeStatus(snapshot: import("@openbot/contracts/ipc").ProviderRuntimeSnapshot): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sendToRenderer(mainWindow, IPC_CHANNELS.providerRuntimesEvent, snapshot);
}

function forwardHostStatus(status: import("@openbot/contracts/ipc").HostStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sendToRenderer(mainWindow, IPC_CHANNELS.hostEvent, status);
  if (remoteServerManager) {
    sendToRenderer(mainWindow, IPC_CHANNELS.serversEvent, withLocalHostSummary(remoteServerManager.list(), status));
  }
}

function forwardRemoteDesktopSessions(sessions: import("@openbot/contracts/ipc").RemoteDesktopSession[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sendToRenderer(mainWindow, IPC_CHANNELS.remoteDesktopEvent, sessions);
}

function forwardServers(servers: import("@openbot/contracts/ipc").ServerSummary[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sendToRenderer(
    mainWindow,
    IPC_CHANNELS.serversEvent,
    hostService ? withLocalHostSummary(servers, hostService.getStatus()) : servers,
  );
}

function forwardTeamPresence(serverId: string, snapshot: import("@openbot/contracts/ipc").TeamPresenceSnapshot): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sendToRenderer(mainWindow, IPC_CHANNELS.serversPresence, { serverId, snapshot });
}

function forwardDirectMessage(
  serverId: string,
  event: import("@openbot/contracts/ipc").DirectMessageRealtimeEvent,
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sendToRenderer(mainWindow, IPC_CHANNELS.serversDirectMessage, { serverId, event });
}

function forwardDirectTyping(
  serverId: string,
  event: import("@openbot/contracts/ipc").DirectTypingRealtimeEvent,
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sendToRenderer(mainWindow, IPC_CHANNELS.serversDirectTyping, { serverId, event });
}

function forwardCentralAuth(state: CentralAuthState): void {
  if (state.status === "signed_in") {
    if (activeAnalyticsPrincipalId && activeAnalyticsPrincipalId !== state.user.id) hostAnalytics?.clear();
    activeAnalyticsPrincipalId = state.user.id;
  } else if (state.status === "signed_out") {
    if (activeAnalyticsPrincipalId) hostAnalytics?.clear();
    activeAnalyticsPrincipalId = null;
  }
  // The renderer is told about the new account at the end of this function, before the
  // queued work below can finish, so the host stops answering for the previous account now.
  // The file is left alone until `applySignedInAccount` records the switch.
  hostService?.unbindChangedAccount(state.status === "signed_in" ? state.user : null);
  const generation = ++centralAuthGeneration;
  remoteAccountSync = remoteAccountSync
    .then(async () => {
      // Sign-outs and sign-ins can queue up behind one slow teardown. Only the account the
      // renderer was last told about may be activated; an earlier one would put a host the
      // user has already left back within reach.
      if (generation !== centralAuthGeneration) return;
      const nextPrincipalId = state.status === "signed_in" ? state.user.id : null;
      if (activeRemotePrincipalId && activeRemotePrincipalId !== nextPrincipalId) {
        // Best-effort, like every other network step here: a bridge disconnect that
        // rejects must not stop the local host from leaving the previous account.
        try {
          await remoteServerManager?.disconnectRemoteSessions();
        } catch (error) {
          logger.error("Unable to disconnect the previous account's remote sessions:", toLogValue(error));
        }
      }
      // Rechecked after the disconnect: another account can be announced while it awaits,
      // and activating this one now would put its host back within the newer account's reach.
      if (generation !== centralAuthGeneration) return;
      activeRemotePrincipalId = nextPrincipalId;
      if (state.status !== "signed_in") {
        if (state.status === "signed_out") {
          // Stopping is best-effort; unbinding the host is not, so a failed teardown
          // must not leave the signed-out account's host bound.
          try {
            await hostService?.stop(false);
          } catch (error) {
            logger.error("Unable to stop the host while signing out:", toLogValue(error));
          }
          await hostService?.applySignedInAccount(null);
        }
        return;
      }
      const host = hostService;
      // The local host is rebound before the joined-server list is synchronized, and the
      // network failure is contained: this account must not end up signed in while the
      // previous account's host is still selected and possibly online.
      if (host) {
        await host.applySignedInAccount(state.user);
        if (generation !== centralAuthGeneration) {
          // Another account was announced while this one was being activated. Its own queued
          // callback binds it; until then no host answers for either.
          host.unbindChangedAccount(null);
          return;
        }
        hostAnalytics?.flushPending();
      }
      try {
        await remoteServerManager?.syncRemoteHosts();
      } catch (error) {
        logger.error("Unable to synchronize the joined servers:", toLogValue(error));
      }
      if (host && shouldAutoStartHost({ ...host.getStatus(), remoteRole: developmentRemoteRole })) await host.start();
    })
    .catch((error) => {
      logger.error("Unable to synchronize the signed-in account:", toLogValue(error));
    });
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sendToRenderer(mainWindow, IPC_CHANNELS.authEvent, state);
}

function acceptInviteUrl(value: string): void {
  try {
    parseInviteUrl(value, developmentInviteLinkOptions);
  } catch {
    return;
  }
  pendingInviteUrl = value;
  if (mainWindow && !mainWindow.isDestroyed() && inviteReceiverReady) {
    showMainWindow(mainWindow);
    if (sendToRenderer(mainWindow, IPC_CHANNELS.serversInvite, value)) pendingInviteUrl = null;
  }
}

function acceptOpenbotUrl(value: string): void {
  acceptInviteUrl(value);
}

function findInviteUrl(values: string[]): string | null {
  for (const value of values) {
    try {
      parseInviteUrl(value, developmentInviteLinkOptions);
      return value;
    } catch {
      // Most command-line arguments are not invitations.
    }
  }
  return null;
}

app.on("open-url", (event, url) => {
  try {
    parseInviteUrl(url, developmentInviteLinkOptions);
  } catch {
    return;
  }
  event.preventDefault();
  acceptOpenbotUrl(url);
});

app.on("continue-activity", (event, type, _userInfo, details) => {
  if (type !== "NSUserActivityTypeBrowsingWeb" || !details.webpageURL) return;
  try {
    parseInviteUrl(details.webpageURL, developmentInviteLinkOptions);
  } catch {
    return;
  }
  event.preventDefault();
  acceptInviteUrl(details.webpageURL);
});

if (!hasSingleInstanceLock) {
  // No application services exist yet, so the secondary process can exit without shutdown work.
  process.exit(0);
} else {
  app.on("second-instance", (_event, argv) => {
    const deepLink = findInviteUrl(argv);
    if (deepLink) acceptOpenbotUrl(deepLink);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    showMainWindow(mainWindow);
  });

  void app
    .whenReady()
    .then(async () => {
      await ensureMacApplicationPresence(
        process.platform,
        (policy) => app.setActivationPolicy(policy),
        () => app.dock?.show() ?? Promise.resolve(),
      );
      if (process.platform === "darwin") app.setAsDefaultProtocolClient("openbot");
      if (process.platform === "darwin") app.dock?.setIcon(appIconPath);
      configureContentSecurityPolicy();
      configureRendererPermissions();
      mainWindowBounds = await readMainWindowBounds(join(app.getPath("userData"), MAIN_WINDOW_STATE_FILE)).catch(
        (error) => {
          logger.error("Unable to restore the main window position:", toLogValue(error));
          return null;
        },
      );
      mainWindow = createWindow();
      const computerUseMacSetupService = new ComputerUseMacSetupService({
        getIconDataUrl: async (path) => (await app.getFileIcon(path, { size: "normal" })).toDataURL(),
      });
      computerUseMacSetupController = new ComputerUseMacSetupWindowController({
        service: computerUseMacSetupService,
        createWindow: createComputerUseMacSetupWindow,
        loadWindow: loadComputerUseMacSetupRenderer,
        openExternal: (url) => shell.openExternal(url),
        revealPath: (path) => shell.showItemInFolder(path),
        loadDragIcon: (path) => app.getFileIcon(path, { size: "normal" }),
      });
      dynamicIslandController = new DynamicIslandWindowController({
        platform: process.platform,
        preferencePath: join(app.getPath("userData"), DYNAMIC_ISLAND_PREFERENCE_FILE),
        createWindow: createDynamicIslandWindow,
        loadWindow: loadDynamicIslandRenderer,
        getDisplays: () => screen.getAllDisplays(),
        getMainWindow: () => mainWindow,
        ensureMainWindow,
        presentMainWindow: showMainWindow,
        performHaptic: () => macHapticFeedback.performAlignment(),
        performCriticalAction: async (action) => {
          if (!agentService || !remoteServerManager) throw new Error("OpenBot is not ready.");
          await performDynamicIslandCriticalAction(action, agentService, remoteServerManager, decodeVoid);
        },
      });
      const centralAuthApiUrl = readCentralAuthApiUrl(
        process.env.OPENBOT_AUTH_API_URL,
        app.isPackaged ? "https://api.openbot.run" : "http://127.0.0.1:3100",
      );
      centralAuthManager = new CentralAuthManager({
        apiUrl: centralAuthApiUrl,
        mobileConnectApiUrl: readMobileConnectApiUrl(process.env.OPENBOT_MOBILE_AUTH_API_URL, centralAuthApiUrl),
        storagePath: join(app.getPath("userData"), CENTRAL_AUTH_FILE),
        canPersist: () => safeStorage.isEncryptionAvailable(),
        encrypt: (value) => {
          if (!safeStorage.isEncryptionAvailable()) {
            throw new Error("macOS secure storage is unavailable.");
          }
          return safeStorage.encryptString(value);
        },
        decrypt: (value) => safeStorage.decryptString(value),
      });
      centralAuthManager.on("changed", forwardCentralAuth);
      const centralAuth = centralAuthManager;
      const centralAuthInitialization = centralAuthManager.initialize();
      const store = new AgentStore(app.getPath("userData"), homedir());
      await store.initialize();
      const managedSkills = new ManagedSkillService(
        app.isPackaged
          ? join(process.resourcesPath, "managed-skills", "openbot-site-hosting", "SKILL.md")
          : resolve(__dirname, "../../resources/managed-skills/openbot-site-hosting/SKILL.md"),
      );
      await managedSkills.syncAll(store.list());
      const hostedSites = new HostedSiteDesktopService(centralAuthManager);
      const sidebarLayoutStore = new SidebarLayoutStore(join(app.getPath("userData"), SIDEBAR_LAYOUT_FILE));
      await sidebarLayoutStore.initialize();
      await sidebarLayoutStore.reconcileAgents(new Set(store.list().map((agent) => agent.id)));
      mailboxStore = new MailboxStore(app.getPath("userData"), store.sharedRoot, store.database);
      await mailboxStore.initialize();
      configureApplicationProtocol();
      const developmentUrl = process.env.ELECTRON_RENDERER_URL;
      teamWebRtcBridge = new TeamWebRtcBridge({
        developmentUrl,
        iceTransportPolicy:
          developmentUrl && process.env.OPENBOT_DEV_ICE_TRANSPORT_POLICY === "relay" ? "relay" : "all",
      });
      browserHost = new BrowserHost(mainWindow, store.downloadsRoot, join(app.getPath("userData"), BROWSER_STATE_FILE));
      await browserHost.restore();
      browserPictureInPicture = new BrowserPictureInPicture({
        mainWindow,
        browser: browserHost,
        preloadPath: join(__dirname, "../preload/index.cjs"),
        iconPath: appIconPath,
        developmentUrl: process.env.ELECTRON_RENDERER_URL,
        onEvent: (event) => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          sendToRenderer(mainWindow, IPC_CHANNELS.browserPictureInPictureEvent, event);
        },
      });
      browserHost.onChanged((tabs, activeTabId) => forwardBrowserDisplayState({ tabs, activeTabId }));
      const setupFile = join(app.getPath("userData"), SETUP_FILE);
      const analyticsPreferenceFile = join(app.getPath("userData"), ANALYTICS_PREFERENCE_FILE);
      const updatePreferenceFile = join(app.getPath("userData"), UPDATE_PREFERENCE_FILE);
      const setupState = await readSetupState(setupFile);
      const analyticsPreference = await readAnalyticsPreference(analyticsPreferenceFile);
      const updatePreference = await readUpdatePreference(updatePreferenceFile);
      providerRuntimeManager = new ProviderRuntimeManager({
        root: join(app.getPath("userData"), "provider-runtimes"),
      });
      await providerRuntimeManager.initialize();
      agentService = new AgentService(
        store,
        mailboxStore,
        browserHost,
        30_000,
        setupState.preferredProvider ?? "codex",
        null,
        providerRuntimeManager.executablePath("codex"),
        providerRuntimeManager.executablePath("claude"),
        providerRuntimeManager.executablePath("grok"),
        (agent) => managedSkills.syncAgent(agent),
        hostedSites,
      );
      const service = agentService;
      providerRuntimeManager.on("status", forwardProviderRuntimeStatus);
      providerRuntimeManager.on("ready", (provider) => {
        void service.refreshProvider(provider).catch((error) => {
          logger.error(`Unable to refresh ${provider} after runtime installation:`, toLogValue(error));
        });
      });
      const skillMarketplace = new SkillMarketplaceService(
        centralAuthManager,
        () => service.listAgents(),
        async (agentId) => service.refreshAgentRuntime(agentId),
      );
      const agentMarketplace = new AgentMarketplaceService(centralAuthManager, service, skillMarketplace);
      configureAttachmentProtocol(mailboxStore, service);
      const teamStore = new TeamStore(
        join(app.getPath("userData"), TEAM_FILE_V2),
        join(app.getPath("userData"), TEAM_FILE),
      );
      await teamStore.initialize();
      if (developmentRemoteRole) {
        const email =
          developmentRemoteRole === "host"
            ? (teamStore.getOwnerEmail() ?? "openbot-dev-host@example.com")
            : "openbot-dev-client@example.com";
        const user = await ensureDevelopmentAccount(centralAuthManager, email);
        await teamStore.activateAccount(user);
        if (developmentRemoteRole === "host" && !teamStore.configured) {
          await teamStore.configureWithAccount("OpenBot Local Dev Host", user);
        }
        if (developmentRemoteRole === "client" && !setupState.completed) {
          await writeSetupState(setupFile, "codex");
        }
      }
      if (developmentRemoteRole === "host" && !developmentTestClientEnabled) {
        const technicalMember = teamStore
          .listMembers()
          .find((member) => member.username === DEVELOPMENT_REMOTE_CLIENT_USERNAME);
        if (technicalMember && technicalMember.role !== "owner") {
          await teamStore.removeMember(technicalMember.id);
        }
      }
      const teamChatStore = new TeamChatStore(store.database);
      const remoteDesktopRuntime = await resolveRemoteDesktopRuntime({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        sourceRoot: resolve(__dirname, "../.."),
        platform: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
        architecture: process.arch,
        overrideRoot: process.env.OPENBOT_REMOTE_DESKTOP_RUNTIME_PATH,
      });
      hostService = new HostService({
        appVersion: app.getVersion(),
        store: teamStore,
        agents: service,
        skills: skillMarketplace,
        sidebarLayout: sidebarLayoutStore,
        mailbox: mailboxStore,
        browser: browserHost,
        chat: teamChatStore,
        teamWebRtcBridge,
        registerRemoteHost: (input) => {
          if (!centralAuthManager) throw new Error("The account service is not ready.");
          return centralAuthManager.registerRemoteHost(input);
        },
        issueRemoteHostTicket: (hostId) => {
          if (!centralAuthManager) throw new Error("The account service is not ready.");
          return centralAuthManager.issueRemoteHostTicket(hostId);
        },
        verifyRemoteSessionTicket: (ticket) => {
          if (!centralAuthManager) throw new Error("The account service is not ready.");
          return centralAuthManager.verifyRemoteSessionTicket(ticket);
        },
        endRemoteSession: (sessionId) => {
          if (!centralAuthManager) throw new Error("The account service is not ready.");
          return centralAuthManager.endRemoteSession(sessionId);
        },
        remoteControlPlaneUrl: centralAuth.resolveApiUrl("/"),
        createRemoteInvite: (hostId, input) => centralAuth.createRemoteInvite(hostId, input),
        listRemoteInvites: (hostId) => centralAuth.listRemoteInvites(hostId),
        revokeRemoteInvite: (inviteId) => centralAuth.revokeRemoteInvite(inviteId),
        listRemoteMembers: (hostId) => centralAuth.listRemoteMembers(hostId),
        updateRemoteMember: (hostId, membershipId, role, reactivate) =>
          centralAuth.updateRemoteMember(hostId, membershipId, role, reactivate),
        removeRemoteMember: (hostId, membershipId) => centralAuth.removeRemoteMember(hostId, membershipId),
        updateRemoteHostLogo: (hostId, image, version) => centralAuth.updateRemoteHostLogo(hostId, image, version),
        allowLocalDevelopmentInvites: developmentRemoteRole === "host",
        logDirectory: join(app.getPath("userData"), "logs", "remote"),
        removeLegacyRemoteDesktopCredential: async () => {
          const credentialPath = join(app.getPath("userData"), LEGACY_REMOTE_DESKTOP_CREDENTIAL_FILE);
          await Promise.all([rm(credentialPath, { force: true }), rm(`${credentialPath}.tmp`, { force: true })]);
        },
        getSignedInUser: () => {
          if (!centralAuthManager) throw new Error("The account service is not ready.");
          return centralAuthManager.getSignedInUser();
        },
        redeemCentralTicket: (ticket, serverId) => {
          if (!centralAuthManager) return Promise.resolve(null);
          return centralAuthManager.redeemTeamAuthTicket(ticket, serverId);
        },
        sendTeamInviteEmail: (input) => {
          if (!centralAuthManager) throw new Error("The account service is not ready.");
          return centralAuthManager.sendTeamInviteEmail(input);
        },
        platform: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
        unattended: false,
        remoteDesktopRuntimePaths: remoteDesktopRuntime,
        remoteDesktopStateDirectory: join(app.getPath("userData"), "remote-desktop-runtime"),
        getRemoteDesktopRuntimeCredentials: () => {
          if (!safeStorage.isEncryptionAvailable()) throw new Error("System secret storage is unavailable.");
          return loadOrCreateRemoteDesktopCredentials(
            join(app.getPath("userData"), REMOTE_DESKTOP_RUNTIME_SECRET_FILE),
            {
              encrypt: (value) => safeStorage.encryptString(value),
              decrypt: (value) => safeStorage.decryptString(value),
            },
          );
        },
        getRemoteDesktopDisplays: () => {
          const primaryId = screen.getPrimaryDisplay().id;
          return screen.getAllDisplays().map((display, index) => ({
            id: String(display.id),
            label: display.label || `Display ${index + 1}`,
            width: display.size.width,
            height: display.size.height,
            primary: display.id === primaryId,
          }));
        },
        getRemoteDesktopIceServers: () => {
          if (developmentRemoteRole === "host") return Promise.resolve([]);
          const identity = teamStore.getIdentity();
          if (!identity) throw new Error("The remote host identity is unavailable.");
          const iceServers = teamWebRtcBridge?.getIceServers(identity.serverId) ?? [];
          if (iceServers.length === 0) throw new Error("Remote Signal has not supplied ICE servers yet.");
          return Promise.resolve(iceServers);
        },
      });
      const signedInState = centralAuthManager.getState();
      if (signedInState.status === "signed_in") {
        await hostService.applySignedInAccount(signedInState.user);
      } else if (signedInState.status === "signed_out") {
        // Sign-out can settle before this service exists, leaving `forwardCentralAuth`
        // nothing to deactivate. Unbinding here is what stops a persisted
        // `activeAccountId` from keeping the last account's host configured - and
        // unconfigurable - while nobody is signed in. A still-loading or failed account
        // service keeps its host, and the event listener settles it.
        await hostService.applySignedInAccount(null);
      }
      const analyticsPlatform = process.platform;
      if (analyticsPlatform !== "darwin" && analyticsPlatform !== "win32" && analyticsPlatform !== "linux") {
        throw new Error(`Unsupported analytics platform: ${analyticsPlatform}`);
      }
      hostAnalytics = new HostAnalytics({
        enabled: app.isPackaged && appVariant === "production",
        trackingEnabled: analyticsPreference.enabled,
        appVersion: app.getVersion(),
        platform: analyticsPlatform,
        resolveOwner: () => {
          const state = centralAuthManager?.getState();
          if (state?.status !== "signed_in") return null;
          const storedOwner = teamStore.getOwnerAnalyticsIdentity();
          if (storedOwner) return storedOwner.id === state.user.id ? storedOwner : null;
          const ownerEmail = teamStore.getOwnerEmail();
          return !teamStore.configured || ownerEmail?.trim().toLowerCase() === state.user.email.trim().toLowerCase()
            ? state.user
            : null;
        },
        resolveAgent: (agentId) => service.listAgents().find((agent) => agent.id === agentId) ?? null,
      });
      hostAnalytics.flushPending();
      remoteServerManager = new RemoteServerManager(
        join(app.getPath("userData"), REMOTE_SERVERS_FILE),
        {
          encrypt: (value) => {
            if (!safeStorage.isEncryptionAvailable()) {
              throw new Error("macOS secure storage is unavailable.");
            }
            return safeStorage.encryptString(value);
          },
          decrypt: (value) => safeStorage.decryptString(value),
        },
        {
          createTeamAuthTicket: (serverId) => {
            if (!centralAuthManager) throw new Error("The account service is not ready.");
            return centralAuthManager.createTeamAuthTicket(serverId);
          },
          getEmail: () => {
            if (!centralAuthManager) throw new Error("The account service is not ready.");
            return centralAuthManager.getSignedInUser().email;
          },
          sendTeamInviteEmail: (input) => {
            if (!centralAuthManager) throw new Error("The account service is not ready.");
            return centralAuthManager.sendTeamInviteEmail(input);
          },
        },
        {
          allowLocalDevelopmentInvites: developmentRemoteRole !== null,
          appVersion: app.getVersion(),
          getLocalHostId: () => teamStore.getIdentity()?.serverId ?? null,
          webrtcTransport: new TeamWebRtcClientTransport({
            bridge: teamWebRtcBridge,
            listHosts: () => {
              if (!centralAuthManager) throw new Error("The account service is not ready.");
              return centralAuthManager.listRemoteHosts();
            },
            startSession: (hostId) => {
              if (!centralAuthManager) throw new Error("The account service is not ready.");
              return centralAuthManager.startRemoteSession(hostId);
            },
            issueTicket: (sessionId, clientPublicKey) => {
              if (!centralAuthManager) throw new Error("The account service is not ready.");
              return centralAuthManager.issueRemoteSessionTicket(sessionId, clientPublicKey);
            },
            endSession: (sessionId) => {
              if (!centralAuthManager) return Promise.resolve();
              return centralAuthManager.endRemoteSession(sessionId);
            },
            createInvite: (hostId, input) => {
              if (!centralAuthManager) throw new Error("The account service is not ready.");
              return centralAuthManager.createRemoteInvite(hostId, input);
            },
            listInvites: (hostId) => {
              if (!centralAuthManager) throw new Error("The account service is not ready.");
              return centralAuthManager.listRemoteInvites(hostId);
            },
            previewInvite: (token) => {
              if (!centralAuthManager) throw new Error("The account service is not ready.");
              return centralAuthManager.previewRemoteInvite(token);
            },
            acceptInvite: (token) => {
              if (!centralAuthManager) throw new Error("The account service is not ready.");
              return centralAuthManager.acceptRemoteInvite(token);
            },
            revokeInvite: (inviteId) => {
              if (!centralAuthManager) throw new Error("The account service is not ready.");
              return centralAuthManager.revokeRemoteInvite(inviteId);
            },
            listMembers: (hostId) => {
              if (!centralAuthManager) throw new Error("The account service is not ready.");
              return centralAuthManager.listRemoteMembers(hostId);
            },
            updateMember: (hostId, membershipId, role, reactivate) => {
              if (!centralAuthManager) throw new Error("The account service is not ready.");
              return centralAuthManager.updateRemoteMember(hostId, membershipId, role, reactivate);
            },
            removeMember: (hostId, membershipId) => {
              if (!centralAuthManager) throw new Error("The account service is not ready.");
              return centralAuthManager.removeRemoteMember(hostId, membershipId);
            },
            getPrincipalId: () => {
              if (!centralAuthManager) throw new Error("The account service is not ready.");
              return centralAuthManager.getSignedInUser().id;
            },
            controlPlaneUrl: centralAuth.resolveApiUrl("/"),
            downloadHostLogo: (hostId, version) => centralAuth.downloadRemoteHostLogo(hostId, version),
            transferDirectory: join(app.getPath("userData"), "remote-transfers"),
          }),
        },
      );
      await remoteServerManager.initialize();
      if (developmentRemoteRole === "host") {
        await rm(developmentRemoteConnectionPath(), { force: true });
        await hostService.startDevelopmentLocal();
        if (developmentTestClientEnabled) {
          await writeDevelopmentRemoteConnection(await hostService.createDevelopmentConnection());
        }
      } else if (developmentRemoteRole === "client") {
        await connectDevelopmentRemoteServer(remoteServerManager);
      }
      configureServerLogoProtocols(teamStore);
      remoteDesktopManager = new RemoteDesktopManager(remoteServerManager);
      const host = hostService;
      const remoteDesktop = remoteDesktopManager;
      const remoteServers = remoteServerManager;
      voiceTranscriptionService = new VoiceTranscriptionService({
        resourcesRoot: app.isPackaged ? join(process.resourcesPath, "whisper") : resolve(".openbot-build/whisper"),
        modelPath: app.isPackaged
          ? join(app.getPath("userData"), "runtimes", "whisper", WHISPER_MODEL_NAME)
          : resolve(".openbot-build/whisper/model", WHISPER_MODEL_NAME),
        modelDownloadUrl: WHISPER_MODEL_URL,
      });
      voiceTranscriptionService.on("modelStatus", forwardVoiceModelStatus);
      const { autoUpdater } = electronUpdater;
      updateService = new UpdateService(autoUpdater, {
        currentVersion: app.getVersion(),
        enabled:
          app.isPackaged &&
          supportsInstalledUpdates(process.platform) &&
          existsSync(join(process.resourcesPath, "app-update.yml")),
        autoDownload: updatePreference.autoDownload,
        beforeInstall: prepareForUpdateInstall,
        platform: process.platform,
        logDirectory: join(app.getPath("userData"), "logs", "update"),
        shipItDirectory: join(homedir(), "Library", "Caches", "app.openbot.desktop.ShipIt"),
      });
      service.on("event", (event) => forwardAgentEvent("local", event));
      sidebarLayoutStore.on("changed", (layout) =>
        forwardAgentEvent("local", { type: "sidebar-layout-changed", layout }),
      );
      host.on("changed", forwardHostStatus);
      host.on("presence", (snapshot) => forwardTeamPresence("local", snapshot));
      host.on("directMessage", (event) => forwardDirectMessage("local", event));
      host.on("directTyping", (event) => forwardDirectTyping("local", event));
      remoteDesktop.on("changed", forwardRemoteDesktopSessions);
      remoteServers.on("changed", forwardServers);
      remoteServers.on("agent", (serverId, event, bufferedLive) => {
        forwardAgentEvent(serverId, event, bufferedLive);
      });
      remoteServers.on("presence", forwardTeamPresence);
      remoteServers.on("directMessage", forwardDirectMessage);
      remoteServers.on("directTyping", forwardDirectTyping);
      updateService.on("status", forwardUpdateStatus);
      updateService.start();
      const agentInitialization = new AgentInitializationGate(() => service.initialize());
      registerIpcHandlers({
        service,
        providerRuntimes: providerRuntimeManager,
        mailbox: mailboxStore,
        browser: browserHost,
        browserPictureInPicture,
        updater: updateService,
        setupFile,
        analyticsPreferenceFile,
        updatePreferenceFile,
        initializeAgent: () => agentInitialization.start(),
        sidebarLayout: sidebarLayoutStore,
        host,
        remoteDesktop,
        remoteServers,
        centralAuth: centralAuthManager,
        skills: skillMarketplace,
        hostedSites,
        marketplaceAgents: agentMarketplace,
        voice: voiceTranscriptionService,
        dynamicIsland: dynamicIslandController,
        computerUseMacSetup: computerUseMacSetupController,
      });
      configureApplicationMenu(service, updateService);
      await dynamicIslandController
        .initialize()
        .catch((error) => logger.error("Unable to initialize Dynamic Island:", toLogValue(error)));
      await loadRenderer(mainWindow);
      remoteServers.startEventConnections();
      const reconcileDynamicIsland = () =>
        void dynamicIslandController
          ?.reconcileWindow()
          .catch((error) => logger.error("Unable to reconcile Dynamic Island displays:", toLogValue(error)));
      screen.on("display-added", reconcileDynamicIsland);
      screen.on("display-removed", reconcileDynamicIsland);
      screen.on("display-metrics-changed", reconcileDynamicIsland);
      powerMonitor.on("resume", reconcileDynamicIsland);
      const teamIdentity = teamStore.getIdentity();
      if (
        shouldAutoStartHost({
          configured: Boolean(teamIdentity),
          enabledOnLaunch: teamIdentity?.enabledOnLaunch ?? false,
          remoteRole: developmentRemoteRole,
        })
      ) {
        void centralAuthInitialization
          .then(() => host.start())
          .catch((error) => logger.error("Unable to republish this OpenBot:", toLogValue(error)));
      }
      void agentInitialization.start().catch((error) => {
        logger.error("Unable to initialize the local agent backend:", toLogValue(error));
      });

      app.on("activate", () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          showMainWindow(mainWindow);
          return;
        }
        void ensureMainWindow()
          .then(showMainWindow)
          .catch((error) => logger.error("Unable to open the main window:", toLogValue(error)));
      });
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("OpenBot failed to start:", toLogValue(error));
      dialog.showErrorBox(
        "OpenBot couldn’t start",
        `${message}\n\nYour local data was not reset or overwritten. See the troubleshooting guide for recovery steps.`,
      );
      app.quit();
    });
}

const DEVELOPMENT_REMOTE_CONNECTION_FILE = "openbot-dev-remote-connection-v1.json";
const developmentRemoteServerConnectionSchema: z.ZodType<DevelopmentRemoteServerConnection> = z.object({
  serverId: z.string().min(1),
  serverName: z.string().min(1),
  apiUrl: z.string().min(1),
  fingerprint: z.string().min(1),
  publicKey: z.string().min(1),
  username: z.string().min(1),
  sessionToken: z.string().min(1),
});

function developmentRemoteConnectionPath(): string {
  return join(tmpdir(), DEVELOPMENT_REMOTE_CONNECTION_FILE);
}

async function ensureDevelopmentAccount(manager: CentralAuthManager, email: string) {
  const initialized = await manager.initialize();
  if (initialized.status === "signed_in" && initialized.user.email === email) return initialized.user;
  if (initialized.status === "signed_in") await manager.logout();
  const challenge = await manager.requestEmailCode(email);
  if (challenge.status !== "code_sent" || !challenge.developmentCode) {
    throw new Error("The local account API did not return a development sign-in code.");
  }
  const verified = await manager.verifyEmailCode(challenge.challengeId, challenge.developmentCode);
  if (verified.status !== "signed_in") throw new Error("The local development account could not sign in.");
  return verified.user;
}

async function writeDevelopmentRemoteConnection(connection: DevelopmentRemoteServerConnection): Promise<void> {
  await writeFile(developmentRemoteConnectionPath(), `${JSON.stringify(connection)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function connectDevelopmentRemoteServer(manager: RemoteServerManager): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown = new Error("The local development host did not start.");
  while (Date.now() < deadline) {
    try {
      const connection = developmentRemoteServerConnectionSchema.parse(
        JSON.parse(await readFile(developmentRemoteConnectionPath(), "utf8")),
      );
      await manager.connectDevelopmentServer(connection);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  throw lastError;
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  isQuitting = true;
  if (systemSessionEnding) {
    updateService?.stop();
    void providerRuntimeManager?.stop();
    return;
  }
  if (shutdownStarted) return;
  event.preventDefault();
  void prepareForShutdown().finally(() => app.quit());
});

async function prepareForUpdateInstall(): Promise<void> {
  await (browserHost?.flushPersistentStorage() ?? Promise.resolve());
  await destroyBrowserForShutdown();
  await prepareForShutdown(true);
}

async function prepareForShutdown(browserAlreadyDestroyed = false): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  isQuitting = true;
  updateService?.stop();
  await flushMainWindowBounds().catch((error) =>
    logger.error("Unable to save the main window position:", toLogValue(error)),
  );
  dynamicIslandController?.destroy();
  dynamicIslandController = null;
  macHapticFeedback.destroy();
  if (!browserAlreadyDestroyed) await destroyBrowserForShutdown();
  browserPictureInPicture?.destroy();
  await (providerRuntimeManager?.stop() ?? Promise.resolve());
  await (remoteServerManager?.stop() ?? Promise.resolve());
  voiceTranscriptionService?.shutdown();
  await (remoteDesktopManager?.stop() ?? Promise.resolve());
  await (hostService?.shutdown() ?? Promise.resolve());
  await (teamWebRtcBridge?.stop() ?? Promise.resolve());
  await (agentService?.stop() ?? Promise.resolve());
}

async function destroyBrowserForShutdown(): Promise<void> {
  await (browserHost?.destroy() ?? Promise.resolve());
}

function configureRendererPermissions(): void {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) =>
    canCheckRendererPermission(permission, requestingOrigin, details),
  );
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = ("mediaTypes" in details ? details.mediaTypes : undefined) ?? [];
    callback(canRequestRendererPermission(permission, webContents.getURL(), { mediaTypes }));
  });
}

function configureAttachmentProtocol(mailbox: MailboxStore, agents: AgentService): void {
  session.defaultSession.protocol.handle("openbot-attachment", async (request) => {
    try {
      const url = new URL(request.url);
      const id = url.pathname.split("/").filter(Boolean).at(-1);
      const attachment = id ? await mailbox.resolveAttachment(id) : null;
      if (!attachment) return new Response("Not found", { status: 404 });
      return new Response(await readFile(attachment.path), {
        headers: {
          "Content-Type": attachment.mimeType,
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": request.headers.get("Origin") ?? "*",
          Vary: "Origin",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": "inline",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.protocol.handle("openbot-remote-attachment", async (request) => {
    try {
      const url = new URL(request.url);
      const serverId = decodeURIComponent(url.hostname);
      const attachmentId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "");
      if (!remoteServerManager || !serverId || !attachmentId) {
        return new Response("Not found", { status: 404 });
      }
      const attachment = await remoteServerManager.downloadAttachment(attachmentId, serverId);
      return new Response(Buffer.from(attachment.bytes), {
        headers: {
          "Content-Type": attachment.mimeType,
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": request.headers.get("Origin") ?? "*",
          Vary: "Origin",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": "inline",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.protocol.handle("openbot-avatar", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "agent") return new Response("Not found", { status: 404 });
      const agentId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "");
      const avatar = agentId ? agents.resolveAvatar(agentId) : null;
      if (!avatar || avatar.version !== url.searchParams.get("v")) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(await readFile(avatar.path), {
        headers: {
          "Content-Type": avatar.mimeType,
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.protocol.handle("openbot-remote-avatar", async (request) => {
    try {
      const url = new URL(request.url);
      const serverId = decodeURIComponent(url.hostname);
      const agentId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "");
      if (!remoteServerManager || !serverId || !agentId) {
        return new Response("Not found", { status: 404 });
      }
      const version = url.searchParams.get("v");
      if (!version) return new Response("Not found", { status: 404 });
      const avatar = await remoteServerManager.downloadAgentAvatar(agentId, serverId, version);
      return new Response(Buffer.from(avatar.bytes), {
        headers: {
          "Content-Type": avatar.mimeType,
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function configureServerLogoProtocols(teamStore: TeamStore): void {
  session.defaultSession.protocol.handle("openbot-server-logo", async (request) => {
    try {
      const url = new URL(request.url);
      const logo = teamStore.resolveLogo();
      if (url.hostname !== LOCAL_SERVER_ID || !logo || logo.version !== url.searchParams.get("v")) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(await readFile(logo.path), {
        headers: {
          "Content-Type": logo.mimeType,
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.protocol.handle("openbot-remote-server-logo", async (request) => {
    try {
      const url = new URL(request.url);
      const serverId = decodeURIComponent(url.hostname);
      const version = url.searchParams.get("v");
      if (!remoteServerManager || !serverId || !version) return new Response("Not found", { status: 404 });
      const logo = await remoteServerManager.downloadServerLogo(serverId, version);
      return new Response(Buffer.from(logo.bytes), {
        headers: {
          "Content-Type": logo.mimeType,
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function configureApplicationProtocol(): void {
  const rendererRoot = resolve(__dirname, "../renderer");
  session.defaultSession.protocol.handle("openbot-app", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== "app") return new Response("Not found", { status: 404 });
      const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const filePath = resolve(rendererRoot, `.${pathname}`);
      const candidate = relative(rendererRoot, filePath);
      if (candidate.startsWith("..") || isAbsolute(candidate)) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(await readFile(filePath), {
        headers: {
          "Content-Type": applicationContentType(filePath),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function applicationContentType(
  path: string,
):
  | "text/html; charset=utf-8"
  | "text/javascript; charset=utf-8"
  | "text/css; charset=utf-8"
  | "image/svg+xml"
  | "image/png"
  | "font/woff2"
  | "application/octet-stream" {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

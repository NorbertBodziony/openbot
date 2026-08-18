import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  Menu,
  Notification,
  type OpenDialogOptions,
  protocol,
  session,
  shell,
  systemPreferences,
} from "electron";
import electronUpdater from "electron-updater";
import { AgentService } from "../backend/agent-service";
import { BotStore } from "../backend/bot-store";
import { BrowserHost } from "../backend/browser-host";
import { MailboxStore } from "../backend/mailbox-store";
import {
  type AgentEvent,
  type AgentProviderId,
  type AppInfo,
  type AppSetupState,
  type BrowserBounds,
  type BrowserOpenInput,
  type BrowserVisibilityInput,
  type CancelQueuedMessageInput,
  type ExternalDestination,
  type ImportAttachmentsInput,
  type InterruptTurnInput,
  IPC_CHANNELS,
  isAgentModel,
  isAvatarHue,
  isAvatarSeed,
  isMessageReaction,
  isReasoningEffort,
  type MacPermissionId,
  type MacPermissionsState,
  type OpenAttachmentInput,
  type RespondToPromptInput,
  type SendMessageInput,
  type SetQueuePausedInput,
  type UpdateBotInput,
} from "../shared/ipc";
import { AgentInitializationGate } from "./agent-initialization";
import { notificationForAgentEvent } from "./agent-notifications";
import { exportDiagnostics, exportOpenBotData } from "./maintenance-service";
import { readSetupState, writeSetupState } from "./setup-store";
import { handleTrusted } from "./trusted-ipc";
import { isTrustedRendererUrl } from "./trusted-renderer";
import { supportsInstalledUpdates, UpdateService } from "./update-service";

if (!app.isPackaged) {
  app.setPath("userData", join(app.getPath("appData"), "OpenBot Dev"));
}
app.enableSandbox();
if (process.platform === "win32") app.setAppUserModelId("app.openbot.desktop");
const hasSingleInstanceLock = app.requestSingleInstanceLock();
protocol.registerSchemesAsPrivileged([
  {
    scheme: "openbot-app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "openbot-attachment",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
let browserHost: BrowserHost | null = null;
let agentService: AgentService | null = null;
let mailboxStore: MailboxStore | null = null;
let updateService: UpdateService | null = null;
let isQuitting = false;
let shutdownStarted = false;

const SETUP_FILE = "openbot-setup-v2.json";
const BROWSER_STATE_FILE = "openbot-browser-state-v1.json";

const EXTERNAL_DESTINATIONS: Record<ExternalDestination, string> = {
  "agent-setup": "https://github.com/NorbertBodziony/openbot/blob/main/docs/TROUBLESHOOTING.md",
  feedback: "https://x.com/intent/post?text=Feedback%20for%20OpenBot%20%40norbertbodziony%3A%20",
  message: "https://x.com/norbertbodziony",
};

function configureContentSecurityPolicy(): void {
  const developmentSources = app.isPackaged ? "" : " http://localhost:* ws://localhost:*";
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: openbot-attachment: https:",
    "font-src 'self' data:",
    `connect-src 'self'${developmentSources}`,
    "object-src 'none'",
    "frame-src 'self' openbot-attachment:",
    "base-uri 'none'",
  ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

function registerIpcHandlers(
  service: AgentService,
  mailbox: MailboxStore,
  browser: BrowserHost,
  updater: UpdateService,
  setupFile: string,
  initializeAgent: () => Promise<void>,
): void {
  handleTrusted(IPC_CHANNELS.getAppInfo, (): AppInfo => {
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
      throw new Error(`Unsupported desktop platform: ${platform}`);
    }
    return { name: app.getName(), version: app.getVersion(), platform };
  });
  handleTrusted(IPC_CHANNELS.getSetupState, () => readSetupState(setupFile));
  handleTrusted(IPC_CHANNELS.saveSetup, async (input: unknown): Promise<AppSetupState> => {
    const preferredProvider = parseProvider(input);
    const state = await writeSetupState(setupFile, preferredProvider);
    await service.setPreferredProvider(preferredProvider);
    await initializeAgent();
    return state;
  });
  handleTrusted(IPC_CHANNELS.getMacPermissions, readMacPermissions);
  handleTrusted(IPC_CHANNELS.requestMacPermission, (permission: unknown) =>
    requestMacPermission(parseMacPermission(permission)),
  );
  handleTrusted(IPC_CHANNELS.openExternal, (destination: unknown) => {
    if (destination !== "agent-setup" && destination !== "feedback" && destination !== "message") {
      throw new Error("Unknown external destination.");
    }
    return shell.openExternal(EXTERNAL_DESTINATIONS[destination]);
  });
  handleTrusted(IPC_CHANNELS.openUrl, (value: unknown) => {
    const url = new URL(requireString(value, "URL"));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only HTTP(S) links can open in the external browser.");
    }
    return shell.openExternal(url.toString());
  });
  handleTrusted(IPC_CHANNELS.updateGetStatus, () => updater.getStatus());
  handleTrusted(IPC_CHANNELS.updateCheck, () => updater.checkForUpdates());
  handleTrusted(IPC_CHANNELS.updateDownload, () => updater.downloadUpdate());
  handleTrusted(IPC_CHANNELS.updateInstall, () => updater.installUpdate());
  handleTrusted(IPC_CHANNELS.maintenanceExportData, () =>
    exportOpenBotData({ service, mailbox, parentWindow: mainWindow }),
  );
  handleTrusted(IPC_CHANNELS.maintenanceExportDiagnostics, () =>
    exportDiagnostics({ service, browser, updater, parentWindow: mainWindow }),
  );

  handleTrusted(IPC_CHANNELS.agentGetStatus, () => service.getStatus());
  handleTrusted(IPC_CHANNELS.agentGetUsage, () => service.getUsage());
  handleTrusted(IPC_CHANNELS.agentListModels, () => service.listModels());
  handleTrusted(IPC_CHANNELS.agentListBots, () => service.listBots());
  handleTrusted(IPC_CHANNELS.agentCreateBot, () => service.createBot());
  handleTrusted(IPC_CHANNELS.agentUpdateBot, (input: unknown) =>
    service.updateBot(parseUpdateBot(input)),
  );
  handleTrusted(IPC_CHANNELS.agentDeleteBot, (botId: unknown) =>
    service.deleteBot(requireString(botId, "botId")),
  );
  handleTrusted(IPC_CHANNELS.agentReadConversation, (botId: unknown) =>
    service.readConversation(requireString(botId, "botId")),
  );
  handleTrusted(IPC_CHANNELS.agentSendMessage, (input: unknown) =>
    service.sendMessage(parseSendMessage(input)),
  );
  handleTrusted(IPC_CHANNELS.agentSetMessageReaction, (input: unknown) => {
    const parsed = parseMessageReaction(input);
    return service.setMessageReaction(parsed);
  });
  handleTrusted(IPC_CHANNELS.agentChooseAttachments, async () => {
    const options: OpenDialogOptions = { properties: ["openFile", "multiSelections"] };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : service.prepareAttachments(result.filePaths);
  });
  handleTrusted(IPC_CHANNELS.agentImportAttachments, (input: unknown) => {
    const parsed = parseImportAttachments(input);
    return service.prepareImportedAttachments(parsed.paths, parsed.data);
  });
  handleTrusted(IPC_CHANNELS.agentDiscardDraftAttachment, (attachmentId: unknown) =>
    service.discardDraftAttachment(requireString(attachmentId, "attachmentId")),
  );
  handleTrusted(IPC_CHANNELS.agentOpenAttachment, async (input: unknown) => {
    const parsed = parseOpenAttachment(input);
    const attachment = await mailbox.resolveAttachment(parsed.attachmentId);
    if (!attachment) throw new Error("Attachment was not found.");
    if (parsed.action === "reveal") {
      shell.showItemInFolder(attachment.path);
      return;
    }
    const error = await shell.openPath(attachment.path);
    if (error) throw new Error(error);
  });
  handleTrusted(IPC_CHANNELS.agentListQueue, (botId: unknown) =>
    service.listQueue(requireString(botId, "botId")),
  );
  handleTrusted(IPC_CHANNELS.agentCancelQueuedMessage, (input: unknown) => {
    const parsed = parseCancelQueuedMessage(input);
    return service.cancelQueuedMessage(parsed.botId, parsed.deliveryId);
  });
  handleTrusted(IPC_CHANNELS.agentSetQueuePaused, (input: unknown) => {
    const parsed = parseSetQueuePaused(input);
    return service.setQueuePaused(parsed.botId, parsed.paused);
  });
  handleTrusted(IPC_CHANNELS.agentInterrupt, (input: unknown) => {
    const parsed = parseInterrupt(input);
    return service.interrupt(parsed.botId, parsed.turnId);
  });
  handleTrusted(IPC_CHANNELS.agentRespondToPrompt, (input: unknown) =>
    service.respondToPrompt(parsePromptResponse(input)),
  );

  handleTrusted(IPC_CHANNELS.browserOpen, (input: unknown) => {
    const parsed = parseBrowserOpen(input);
    return browser.open(parsed.url, parsed.ownerThreadId ?? null, parsed.ownerBotId ?? null);
  });
  handleTrusted(IPC_CHANNELS.browserActivate, (tabId: unknown) =>
    browser.activate(requireString(tabId, "tabId")),
  );
  handleTrusted(IPC_CHANNELS.browserClose, (tabId: unknown) =>
    browser.close(requireString(tabId, "tabId")),
  );
  handleTrusted(IPC_CHANNELS.browserListTabs, () => browser.listTabs());
  handleTrusted(IPC_CHANNELS.browserGetControlState, () => browser.getControlState());
  handleTrusted(IPC_CHANNELS.browserSetVisible, async (input: unknown) => {
    const parsed = parseVisibility(input);
    await browser.setVisible(parsed);
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#0b0d0e",
    title: "OpenBot",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 13, y: 14 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (process.platform === "darwin" && !isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl)) event.preventDefault();
  });

  return window;
}

function loadRenderer(window: BrowserWindow): Promise<void> {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  return developmentUrl
    ? window.loadURL(developmentUrl)
    : window.loadURL("openbot-app://app/index.html");
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

function forwardAgentEvent(event: AgentEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.agentEvent, event);
  if (mainWindow.isFocused() || !Notification.isSupported()) return;

  const content = notificationForAgentEvent(event, agentService?.listBots() ?? []);
  if (!content) return;
  const notification = new Notification(content);
  notification.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  notification.show();
}

function forwardUpdateStatus(status: import("../shared/ipc").UpdateStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.updateEvent, status);
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  void app
    .whenReady()
    .then(async () => {
      configureContentSecurityPolicy();
      mainWindow = createWindow();
      const store = new BotStore(app.getPath("userData"), homedir());
      await store.initialize();
      mailboxStore = new MailboxStore(app.getPath("userData"), store.sharedRoot);
      await mailboxStore.initialize();
      configureApplicationProtocol();
      configureAttachmentProtocol(mailboxStore);
      browserHost = new BrowserHost(
        mainWindow,
        store.downloadsRoot,
        join(app.getPath("userData"), BROWSER_STATE_FILE),
      );
      await browserHost.restore();
      const setupFile = join(app.getPath("userData"), SETUP_FILE);
      const setupState = await readSetupState(setupFile);
      agentService = new AgentService(
        store,
        mailboxStore,
        browserHost,
        readComputerUsePrerequisites,
        30_000,
        setupState.preferredProvider ?? "codex",
      );
      const service = agentService;
      const { autoUpdater } = electronUpdater;
      updateService = new UpdateService(autoUpdater, {
        currentVersion: app.getVersion(),
        enabled:
          app.isPackaged &&
          supportsInstalledUpdates(process.platform) &&
          existsSync(join(process.resourcesPath, "app-update.yml")),
        beforeInstall: prepareForShutdown,
      });
      service.on("event", forwardAgentEvent);
      updateService.on("status", forwardUpdateStatus);
      updateService.start();
      const agentInitialization = new AgentInitializationGate(() => service.initialize());
      registerIpcHandlers(service, mailboxStore, browserHost, updateService, setupFile, () =>
        agentInitialization.start(),
      );
      configureApplicationMenu(service, updateService);
      await loadRenderer(mainWindow);
      void agentInitialization.start().catch((error) => {
        console.error("Unable to initialize the local agent backend:", error);
      });

      app.on("activate", () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          return;
        }
        mainWindow = createWindow();
        void loadRenderer(mainWindow);
      });
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("OpenBot failed to start:", error);
      dialog.showErrorBox(
        "OpenBot couldn’t start",
        `${message}\n\nYour local data was not reset or overwritten. See the troubleshooting guide for recovery steps.`,
      );
      app.quit();
    });
}

function readComputerUsePrerequisites(): {
  screenRecording: boolean;
  accessibility: boolean;
} {
  if (process.platform !== "darwin") {
    return { screenRecording: false, accessibility: false };
  }
  return {
    screenRecording: systemPreferences.getMediaAccessStatus("screen") === "granted",
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  };
}

function readMacPermissions(): MacPermissionsState {
  if (process.platform !== "darwin") {
    return { screenRecording: "unknown", accessibility: "unknown" };
  }
  return {
    screenRecording: systemPreferences.getMediaAccessStatus("screen"),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false)
      ? "granted"
      : "not-determined",
  };
}

async function requestMacPermission(permission: MacPermissionId): Promise<MacPermissionsState> {
  if (process.platform !== "darwin") return readMacPermissions();
  if (permission === "accessibility") {
    systemPreferences.isTrustedAccessibilityClient(true);
    return readMacPermissions();
  }

  const state = systemPreferences.getMediaAccessStatus("screen");
  if (state === "not-determined") {
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
  } else if (state === "denied" || state === "unknown") {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
  }
  return readMacPermissions();
}

function parseProvider(input: unknown): AgentProviderId {
  if (!input || typeof input !== "object") throw new Error("Setup input is required.");
  const provider = Reflect.get(input, "preferredProvider");
  if (provider !== "codex" && provider !== "claude") throw new Error("Unknown provider.");
  return provider;
}

function parseMacPermission(input: unknown): MacPermissionId {
  if (input !== "screen-recording" && input !== "accessibility") {
    throw new Error("Unknown macOS permission.");
  }
  return input;
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  isQuitting = true;
  if (shutdownStarted) return;
  event.preventDefault();
  void prepareForShutdown().finally(() => app.quit());
});

async function prepareForShutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  isQuitting = true;
  updateService?.stop();
  await (browserHost?.destroy() ?? Promise.resolve());
  await (agentService?.stop() ?? Promise.resolve());
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value;
}

function parseSendMessage(value: unknown): SendMessageInput {
  if (!isObject(value)) throw new Error("Invalid send message request.");
  const attachmentDraftIds = value.attachmentDraftIds ?? [];
  if (
    !Array.isArray(attachmentDraftIds) ||
    !attachmentDraftIds.every((item) => typeof item === "string")
  ) {
    throw new Error("Invalid attachment drafts.");
  }
  if (typeof value.text !== "string") throw new Error("text is required.");
  if (!value.text.trim() && attachmentDraftIds.length === 0) {
    throw new Error("A message or attachment is required.");
  }
  const replyToMessageId = value.replyToMessageId ?? null;
  if (replyToMessageId !== null && typeof replyToMessageId !== "string") {
    throw new Error("Invalid reply target.");
  }
  return {
    botId: requireString(value.botId, "botId"),
    text: value.text,
    attachmentDraftIds,
    replyToMessageId: replyToMessageId?.trim() || null,
  };
}

function parseMessageReaction(value: unknown) {
  if (!isObject(value)) throw new Error("Invalid message reaction request.");
  const emoji = value.emoji;
  if (emoji !== null && !isMessageReaction(emoji)) {
    throw new Error("Invalid message reaction.");
  }
  return {
    botId: requireString(value.botId, "botId"),
    messageId: requireString(value.messageId, "messageId"),
    emoji,
  };
}

function parseUpdateBot(value: unknown): UpdateBotInput {
  if (!isObject(value)) throw new Error("Invalid bot update request.");
  const result: UpdateBotInput = { botId: requireString(value.botId, "botId") };
  for (const field of ["name", "role", "description"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`Invalid ${field}.`);
    }
    if (typeof value[field] === "string") result[field] = value[field];
  }
  if (value.notifications !== undefined) {
    if (typeof value.notifications !== "boolean") throw new Error("Invalid notifications value.");
    result.notifications = value.notifications;
  }
  if (value.model !== undefined) {
    if (!isAgentModel(value.model)) throw new Error("Invalid agent model.");
    result.model = value.model;
  }
  if (value.reasoningEffort !== undefined) {
    if (!isReasoningEffort(value.reasoningEffort)) throw new Error("Invalid reasoning effort.");
    result.reasoningEffort = value.reasoningEffort;
  }
  if (value.avatarSeed !== undefined) {
    if (!isAvatarSeed(value.avatarSeed)) throw new Error("Invalid avatar seed.");
    result.avatarSeed = value.avatarSeed;
  }
  if (value.avatarHue !== undefined) {
    if (value.avatarHue !== null && !isAvatarHue(value.avatarHue)) {
      throw new Error("Invalid avatar hue.");
    }
    result.avatarHue = value.avatarHue;
  }
  return result;
}

function parseImportAttachments(value: unknown): ImportAttachmentsInput {
  if (!isObject(value) || !Array.isArray(value.paths) || !Array.isArray(value.data)) {
    throw new Error("Invalid attachment import.");
  }
  if (!value.paths.every((path) => typeof path === "string" && path.length > 0)) {
    throw new Error("Invalid attachment path.");
  }
  const data = value.data.map((item) => {
    if (
      !isObject(item) ||
      typeof item.name !== "string" ||
      typeof item.mimeType !== "string" ||
      !(item.bytes instanceof Uint8Array)
    ) {
      throw new Error("Invalid attachment data.");
    }
    return { name: item.name, mimeType: item.mimeType, bytes: item.bytes };
  });
  return { paths: value.paths, data };
}

function parseOpenAttachment(value: unknown): OpenAttachmentInput {
  if (!isObject(value) || (value.action !== "open" && value.action !== "reveal")) {
    throw new Error("Invalid attachment action.");
  }
  return {
    attachmentId: requireString(value.attachmentId, "attachmentId"),
    action: value.action,
  };
}

function parseCancelQueuedMessage(value: unknown): CancelQueuedMessageInput {
  if (!isObject(value)) throw new Error("Invalid queue cancellation request.");
  return {
    botId: requireString(value.botId, "botId"),
    deliveryId: requireString(value.deliveryId, "deliveryId"),
  };
}

function parseSetQueuePaused(value: unknown): SetQueuePausedInput {
  if (!isObject(value) || typeof value.paused !== "boolean") {
    throw new Error("Invalid queue pause request.");
  }
  return { botId: requireString(value.botId, "botId"), paused: value.paused };
}

function configureAttachmentProtocol(mailbox: MailboxStore): void {
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
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": "inline",
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

function applicationContentType(path: string): string {
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

function parseInterrupt(value: unknown): InterruptTurnInput {
  if (!isObject(value)) throw new Error("Invalid interrupt request.");
  return {
    botId: requireString(value.botId, "botId"),
    turnId: requireString(value.turnId, "turnId"),
  };
}

function parsePromptResponse(value: unknown): RespondToPromptInput {
  if (
    !isObject(value) ||
    (typeof value.requestId !== "string" && typeof value.requestId !== "number")
  ) {
    throw new Error("Invalid prompt response.");
  }
  if (!isObject(value.answers)) throw new Error("Prompt answers are required.");
  const answers: Record<string, string[]> = {};
  for (const [key, answer] of Object.entries(value.answers)) {
    if (!Array.isArray(answer) || !answer.every((item) => typeof item === "string")) {
      throw new Error("Invalid prompt answer.");
    }
    answers[key] = answer;
  }
  return { requestId: value.requestId, answers };
}

function parseBrowserOpen(value: unknown): BrowserOpenInput {
  if (!isObject(value)) throw new Error("Invalid browser open request.");
  return {
    url: requireString(value.url, "url"),
    ownerThreadId:
      value.ownerThreadId === null || value.ownerThreadId === undefined
        ? null
        : requireString(value.ownerThreadId, "ownerThreadId"),
    ownerBotId:
      value.ownerBotId === null || value.ownerBotId === undefined
        ? null
        : requireString(value.ownerBotId, "ownerBotId"),
  };
}

function parseVisibility(value: unknown): BrowserVisibilityInput {
  if (!isObject(value) || typeof value.visible !== "boolean") {
    throw new Error("Invalid browser visibility request.");
  }
  return {
    visible: value.visible,
    bounds: value.bounds === undefined ? undefined : parseBounds(value.bounds),
  };
}

function parseBounds(value: unknown): BrowserBounds {
  if (!isObject(value)) throw new Error("Invalid browser bounds.");
  const fields = ["x", "y", "width", "height"] as const;
  for (const field of fields) {
    if (typeof value[field] !== "number" || !Number.isFinite(value[field])) {
      throw new Error(`Invalid browser bound: ${field}.`);
    }
  }
  return {
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type OpenDialogOptions,
  protocol,
  session,
  shell,
  systemPreferences,
  type WebFrameMain,
} from "electron";
import { AgentService } from "../backend/agent-service";
import { BotStore } from "../backend/bot-store";
import { BrowserHost } from "../backend/browser-host";
import { MailboxStore } from "../backend/mailbox-store";
import {
  type AgentEvent,
  type AppInfo,
  type BrowserBounds,
  type BrowserOpenInput,
  type BrowserVisibilityInput,
  type CancelQueuedMessageInput,
  type ImportAttachmentsInput,
  type InterruptTurnInput,
  IPC_CHANNELS,
  isAgentModel,
  isAvatarColor,
  isAvatarShape,
  isMessageReaction,
  isReasoningEffort,
  type OpenAttachmentInput,
  type RespondToPromptInput,
  type SendMessageInput,
  type SetQueuePausedInput,
  type UpdateBotInput,
} from "../shared/ipc";

app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: "infeld-attachment",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
let browserHost: BrowserHost | null = null;
let agentService: AgentService | null = null;
let mailboxStore: MailboxStore | null = null;
let isQuitting = false;
let shutdownStarted = false;

function isTrustedRenderer(frameUrl: string): boolean {
  try {
    const senderUrl = new URL(frameUrl);
    const developmentUrl = process.env.ELECTRON_RENDERER_URL;

    if (developmentUrl) {
      return senderUrl.origin === new URL(developmentUrl).origin;
    }

    return (
      senderUrl.protocol === "file:" && senderUrl.pathname.endsWith("/out/renderer/index.html")
    );
  } catch {
    return false;
  }
}

function assertTrustedSender(frame: WebFrameMain | null): void {
  if (!frame || !isTrustedRenderer(frame.url)) {
    throw new Error("Rejected IPC request from an untrusted renderer.");
  }
}

function configureContentSecurityPolicy(): void {
  const developmentSources = app.isPackaged ? "" : " http://localhost:* ws://localhost:*";
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: infeld-attachment:",
    "font-src 'self' data:",
    `connect-src 'self'${developmentSources}`,
    "object-src 'none'",
    "frame-src 'self' infeld-attachment:",
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
): void {
  ipcMain.handle(IPC_CHANNELS.getAppInfo, (event): AppInfo => {
    assertTrustedSender(event.senderFrame);
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
      throw new Error(`Unsupported desktop platform: ${platform}`);
    }
    return { name: app.getName(), version: app.getVersion(), platform };
  });

  ipcMain.handle(IPC_CHANNELS.agentGetStatus, (event) => {
    assertTrustedSender(event.senderFrame);
    return service.getStatus();
  });
  ipcMain.handle(IPC_CHANNELS.agentListModels, (event) => {
    assertTrustedSender(event.senderFrame);
    return service.listModels();
  });
  ipcMain.handle(IPC_CHANNELS.agentListBots, (event) => {
    assertTrustedSender(event.senderFrame);
    return service.listBots();
  });
  ipcMain.handle(IPC_CHANNELS.agentCreateBot, (event) => {
    assertTrustedSender(event.senderFrame);
    return service.createBot();
  });
  ipcMain.handle(IPC_CHANNELS.agentUpdateBot, (event, input: unknown) => {
    assertTrustedSender(event.senderFrame);
    return service.updateBot(parseUpdateBot(input));
  });
  ipcMain.handle(IPC_CHANNELS.agentDeleteBot, (event, botId: unknown) => {
    assertTrustedSender(event.senderFrame);
    return service.deleteBot(requireString(botId, "botId"));
  });
  ipcMain.handle(IPC_CHANNELS.agentReadConversation, (event, botId: unknown) => {
    assertTrustedSender(event.senderFrame);
    return service.readConversation(requireString(botId, "botId"));
  });
  ipcMain.handle(IPC_CHANNELS.agentSendMessage, (event, input: unknown) => {
    assertTrustedSender(event.senderFrame);
    return service.sendMessage(parseSendMessage(input));
  });
  ipcMain.handle(IPC_CHANNELS.agentSetMessageReaction, (event, input: unknown) => {
    assertTrustedSender(event.senderFrame);
    const parsed = parseMessageReaction(input);
    return service.setMessageReaction(parsed);
  });
  ipcMain.handle(IPC_CHANNELS.agentChooseAttachments, async (event) => {
    assertTrustedSender(event.senderFrame);
    const options: OpenDialogOptions = { properties: ["openFile", "multiSelections"] };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : service.prepareAttachments(result.filePaths);
  });
  ipcMain.handle(IPC_CHANNELS.agentImportAttachments, (event, input: unknown) => {
    assertTrustedSender(event.senderFrame);
    const parsed = parseImportAttachments(input);
    return service.prepareImportedAttachments(parsed.paths, parsed.data);
  });
  ipcMain.handle(IPC_CHANNELS.agentDiscardDraftAttachment, (event, attachmentId: unknown) => {
    assertTrustedSender(event.senderFrame);
    return service.discardDraftAttachment(requireString(attachmentId, "attachmentId"));
  });
  ipcMain.handle(IPC_CHANNELS.agentOpenAttachment, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame);
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
  ipcMain.handle(IPC_CHANNELS.agentListQueue, (event, botId: unknown) => {
    assertTrustedSender(event.senderFrame);
    return service.listQueue(requireString(botId, "botId"));
  });
  ipcMain.handle(IPC_CHANNELS.agentCancelQueuedMessage, (event, input: unknown) => {
    assertTrustedSender(event.senderFrame);
    const parsed = parseCancelQueuedMessage(input);
    return service.cancelQueuedMessage(parsed.botId, parsed.deliveryId);
  });
  ipcMain.handle(IPC_CHANNELS.agentSetQueuePaused, (event, input: unknown) => {
    assertTrustedSender(event.senderFrame);
    const parsed = parseSetQueuePaused(input);
    return service.setQueuePaused(parsed.botId, parsed.paused);
  });
  ipcMain.handle(IPC_CHANNELS.agentInterrupt, (event, input: unknown) => {
    assertTrustedSender(event.senderFrame);
    const parsed = parseInterrupt(input);
    return service.interrupt(parsed.botId, parsed.turnId);
  });
  ipcMain.handle(IPC_CHANNELS.agentRespondToPrompt, (event, input: unknown) => {
    assertTrustedSender(event.senderFrame);
    return service.respondToPrompt(parsePromptResponse(input));
  });

  ipcMain.handle(IPC_CHANNELS.browserOpen, (event, input: unknown) => {
    assertTrustedSender(event.senderFrame);
    const parsed = parseBrowserOpen(input);
    return browser.open(parsed.url, parsed.ownerThreadId ?? null, parsed.ownerBotId ?? null);
  });
  ipcMain.handle(IPC_CHANNELS.browserActivate, (event, tabId: unknown) => {
    assertTrustedSender(event.senderFrame);
    return browser.activate(requireString(tabId, "tabId"));
  });
  ipcMain.handle(IPC_CHANNELS.browserClose, (event, tabId: unknown) => {
    assertTrustedSender(event.senderFrame);
    return browser.close(requireString(tabId, "tabId"));
  });
  ipcMain.handle(IPC_CHANNELS.browserListTabs, (event) => {
    assertTrustedSender(event.senderFrame);
    return browser.listTabs();
  });
  ipcMain.handle(IPC_CHANNELS.browserGetControlState, (event) => {
    assertTrustedSender(event.senderFrame);
    return browser.getControlState();
  });
  ipcMain.handle(IPC_CHANNELS.browserSetVisible, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame);
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
    title: "Infeld Bot",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 13, y: 14 },
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
    if (!isTrustedRenderer(targetUrl)) event.preventDefault();
  });

  return window;
}

function loadRenderer(window: BrowserWindow): Promise<void> {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  return developmentUrl
    ? window.loadURL(developmentUrl)
    : window.loadFile(join(__dirname, "../renderer/index.html"));
}

function configureApplicationMenu(service: AgentService): void {
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
}

app.whenReady().then(async () => {
  configureContentSecurityPolicy();
  mainWindow = createWindow();
  const store = new BotStore(app.getPath("userData"), homedir());
  await store.initialize();
  mailboxStore = new MailboxStore(app.getPath("userData"), store.sharedRoot);
  await mailboxStore.initialize();
  configureAttachmentProtocol(mailboxStore);
  browserHost = new BrowserHost(mainWindow, store.downloadsRoot);
  agentService = new AgentService(store, mailboxStore, browserHost, readComputerUsePrerequisites);
  agentService.on("event", forwardAgentEvent);
  registerIpcHandlers(agentService, mailboxStore, browserHost);
  configureApplicationMenu(agentService);
  await loadRenderer(mainWindow);
  void agentService.initialize().catch((error) => {
    console.error("Unable to initialize the local Codex backend:", error);
  });

  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      return;
    }
    mainWindow = createWindow();
    void loadRenderer(mainWindow);
  });
});

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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  isQuitting = true;
  if (shutdownStarted) return;
  shutdownStarted = true;
  event.preventDefault();

  browserHost?.destroy();
  void (agentService?.stop() ?? Promise.resolve()).finally(() => {
    removeIpcHandlers();
    app.quit();
  });
});

function removeIpcHandlers(): void {
  for (const channel of Object.values(IPC_CHANNELS)) {
    if (channel !== IPC_CHANNELS.agentEvent) ipcMain.removeHandler(channel);
  }
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
  if (value.avatarShape !== undefined) {
    if (!isAvatarShape(value.avatarShape)) throw new Error("Invalid avatar shape.");
    result.avatarShape = value.avatarShape;
  }
  if (value.avatarColor !== undefined) {
    if (!isAvatarColor(value.avatarColor)) throw new Error("Invalid avatar color.");
    result.avatarColor = value.avatarColor;
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
  session.defaultSession.protocol.handle("infeld-attachment", async (request) => {
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

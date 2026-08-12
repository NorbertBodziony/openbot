import { homedir } from "node:os";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  session,
  systemPreferences,
  type WebFrameMain,
} from "electron";
import { AgentService } from "../backend/agent-service";
import { BotStore } from "../backend/bot-store";
import { BrowserHost } from "../backend/browser-host";
import {
  type AgentEvent,
  type AppInfo,
  type BrowserBounds,
  type BrowserOpenInput,
  type BrowserVisibilityInput,
  type InterruptTurnInput,
  IPC_CHANNELS,
  type RespondToPromptInput,
  type SendMessageInput,
} from "../shared/ipc";

app.enableSandbox();

let mainWindow: BrowserWindow | null = null;
let browserHost: BrowserHost | null = null;
let agentService: AgentService | null = null;
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
    "img-src 'self' data: https://media.x.ai",
    "font-src 'self' data:",
    `connect-src 'self'${developmentSources}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
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

function registerIpcHandlers(service: AgentService, browser: BrowserHost): void {
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
  ipcMain.handle(IPC_CHANNELS.agentListBots, (event) => {
    assertTrustedSender(event.senderFrame);
    return service.listBots();
  });
  ipcMain.handle(IPC_CHANNELS.agentCreateBot, (event) => {
    assertTrustedSender(event.senderFrame);
    return service.createBot();
  });
  ipcMain.handle(IPC_CHANNELS.agentReadConversation, (event, botId: unknown) => {
    assertTrustedSender(event.senderFrame);
    return service.readConversation(requireString(botId, "botId"));
  });
  ipcMain.handle(IPC_CHANNELS.agentSendMessage, (event, input: unknown) => {
    assertTrustedSender(event.senderFrame);
    return service.sendMessage(parseSendMessage(input));
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
    return browser.open(parsed.url, parsed.ownerThreadId ?? null);
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
  ipcMain.handle(IPC_CHANNELS.browserSetVisible, async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame);
    const parsed = parseVisibility(input);
    if (parsed.visible && browser.listTabs().length === 0) {
      await browser.open("https://www.google.com");
    }
    return browser.setVisible(parsed);
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
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  if (process.platform === "darwin") {
    window.setWindowButtonVisibility(false);
  }

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

  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl) void window.loadURL(developmentUrl);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));

  return window;
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
  browserHost = new BrowserHost(mainWindow, store.downloadsRoot);
  agentService = new AgentService(store, browserHost, readComputerUsePrerequisites);
  agentService.on("event", forwardAgentEvent);
  registerIpcHandlers(agentService, browserHost);
  configureApplicationMenu(agentService);
  void agentService.initialize().catch((error) => {
    console.error("Unable to initialize the local Codex backend:", error);
  });

  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      return;
    }
    mainWindow = createWindow();
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
  return { botId: requireString(value.botId, "botId"), text: requireString(value.text, "text") };
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

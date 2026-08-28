import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { app, BrowserWindow, webContents } from "electron";
import { BrowserHost } from "../src/backend/browser-host";
import { getString } from "../src/backend/protocol";

let cachedPageVersion = 1;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/cached") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
    });
    response.end(`<main>version:${cachedPageVersion}</main>`);
    return;
  }
  if (url.pathname === "/download") {
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-disposition": 'attachment; filename="openbot-smoke.txt"',
    });
    response.end("local download");
    return;
  }
  if (url.pathname === "/cookie") {
    if (url.searchParams.has("set")) response.setHeader("set-cookie", "openbot=shared; Path=/");
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<main>cookie:${request.headers.cookie ?? "none"}</main>`);
    return;
  }
  if (url.pathname === "/headers") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    const requestHeaders = JSON.stringify(request.headers).replaceAll("<", "\\u003c");
    response.end(`<main></main><script>
      document.querySelector("main").textContent = JSON.stringify({
        requestHeaders: ${requestHeaders},
        navigatorUserAgent: navigator.userAgent,
        navigatorBrands: navigator.userAgentData?.brands ?? [],
      });
    </script>`);
    return;
  }
  if (url.pathname === "/abort") {
    response.destroy();
    return;
  }

  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
    <input aria-label="Task" oninput="this.dataset.trusted = String(event.isTrusted)" />
    <button aria-label="Save" onclick="document.querySelector('output').textContent = document.querySelector('input').value + '|input:' + document.querySelector('input').dataset.trusted + '|click:' + event.isTrusted">Save</button>
    <a href="/child" target="_blank">Child</a>
    <a href="/download" download>Download</a>
    <output>empty</output>`);
});

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "openbot-browser-smoke-"));
  app.setPath("userData", join(temporaryRoot, "user-data"));
  const hardTimeout = setTimeout(() => {
    process.stderr.write("BrowserHost smoke test timed out.\n");
    app.exit(1);
  }, 20_000);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || isString(address)) throw new Error("Local server did not start.");
    const origin = `http://127.0.0.1:${address.port}`;

    await app.whenReady();
    process.stdout.write("BrowserHost: Electron ready.\n");
    const window = new BrowserWindow({ show: false, opacity: 0 });
    window.show();
    app.focus({ steal: true });
    window.focus();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const downloadsRoot = join(temporaryRoot, "downloads");
    const statePath = join(temporaryRoot, "browser-tabs.json");
    const browser = new BrowserHost(window, downloadsRoot, statePath);
    await browser.setVisible({ visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });

    const controlPhases: string[] = [];
    const controlledTabIds: Array<string | null> = [];
    browser.onControlChanged((state) => {
      const session = state.sessions.find((item) => item.turnId === "browser-smoke-turn");
      if (session) {
        controlPhases.push(`${session.action}:${session.phase}`);
        controlledTabIds.push(session.tabId);
      } else if (controlPhases.length > 0) controlPhases.push("ended");
    });

    const openingTab = browser.open(origin, "smoke-thread", "smoke-bot", true);
    window.webContents.focus();
    const tab = await openingTab;
    if (webContents.getFocusedWebContents()?.getURL() !== `${origin}/`) {
      throw new Error("A user-opened browser tab did not regain keyboard focus after loading.");
    }
    process.stdout.write("BrowserHost: local tab opened.\n");
    const first = await browser.snapshot(tab.id);
    const input = first.elements.find((element) => element.name === "Task");
    const save = first.elements.find((element) => element.name === "Save");
    if (!input || !save) throw new Error("Snapshot did not expose local controls.");

    const typed = await browser.act(tab.id, first.revision, {
      type: "type",
      ref: input.ref,
      text: "runs locally",
    });
    const currentSave = typed.elements.find((element) => element.name === "Save");
    if (!currentSave) throw new Error("Save control disappeared after typing.");
    await browser.act(tab.id, typed.revision, { type: "click", ref: currentSave.ref });
    const result = await browser.snapshot(tab.id);
    if (!result.text.includes("runs locally|input:true|click:true")) {
      throw new Error(`Browser input was not native: ${result.text}`);
    }
    process.stdout.write("BrowserHost: snapshot and actions passed.\n");

    const headerTab = await browser.open(`${origin}/headers`, "smoke-thread");
    const headerSnapshot = await browser.snapshot(headerTab.id);
    const identity = JSON.parse(headerSnapshot.text);
    if (!isDynamicRecord(identity) || !isDynamicRecord(identity.requestHeaders)) {
      throw new Error("Browser identity payload is invalid.");
    }
    const navigatorUserAgent = getString(identity, "navigatorUserAgent");
    const navigatorBrands = Array.isArray(identity.navigatorBrands)
      ? identity.navigatorBrands.filter(isDynamicRecord)
      : [];
    const clientHintBrands = getString(identity.requestHeaders, "sec-ch-ua") ?? "";
    if (
      headerSnapshot.text.includes("Electron/") ||
      headerSnapshot.text.includes("OpenBot/") ||
      getString(identity.requestHeaders, "user-agent") !== navigatorUserAgent ||
      (clientHintBrands.length > 0 &&
        navigatorBrands.some(
          (brand) => !clientHintBrands.includes(`"${getString(brand, "brand")}";v="${getString(brand, "version")}"`),
        ))
    ) {
      throw new Error(`Browser identity headers are invalid: ${headerSnapshot.text}`);
    }
    process.stdout.write("BrowserHost: matching Chromium page and request identity passed.\n");
    await expectFailure(() => browser.act(tab.id, first.revision, { type: "click", ref: save.ref }));

    const child = result.elements.find((element) => element.name === "Child");
    if (!child) throw new Error("Child-tab control is missing.");
    await browser.act(tab.id, result.revision, { type: "click", ref: child.ref });
    await waitForValue(() =>
      browser.listTabs().find((candidate) => candidate.id !== tab.id && candidate.url.includes("/child")),
    );
    const childTab = browser
      .listTabs()
      .find((candidate) => candidate.id !== tab.id && candidate.url.includes("/child"));
    if (childTab?.ownerThreadId !== "smoke-thread" || childTab.ownerBotId !== "smoke-bot") {
      throw new Error("A target=_blank tab did not preserve agent ownership.");
    }
    process.stdout.write("BrowserHost: child-tab ownership passed.\n");

    const screenshot = await browser.screenshot(tab.id);
    if (!screenshot.startsWith("data:image/png;base64,")) throw new Error("Screenshot failed.");
    process.stdout.write("BrowserHost: screenshot passed.\n");

    await browser.open(`${origin}/cookie?set=1`, "smoke-thread");
    const cookieTab = await browser.open(`${origin}/cookie`, "other-thread");
    const cookieSnapshot = await browser.snapshot(cookieTab.id);
    if (!cookieSnapshot.text.includes("openbot=shared")) throw new Error("Cookies were not shared.");
    process.stdout.write("BrowserHost: shared cookies passed.\n");

    const firstCachedTab = await browser.open(`${origin}/cached`, "smoke-thread");
    const firstCachedSnapshot = await browser.snapshot(firstCachedTab.id);
    if (!firstCachedSnapshot.text.includes("version:1")) {
      throw new Error("Initial cached page did not load.");
    }
    cachedPageVersion = 2;
    const revalidatedTab = await browser.open(`${origin}/cached`, "smoke-thread");
    const revalidatedSnapshot = await browser.snapshot(revalidatedTab.id);
    if (!revalidatedSnapshot.text.includes("version:2")) {
      throw new Error("A new top-level navigation reused stale cached content.");
    }
    process.stdout.write("BrowserHost: top-level cache revalidation passed.\n");

    await expectFailure(() => browser.open("file:///etc/passwd"));
    const tabCountBeforeAbort = browser.listTabs().length;
    await expectFailure(() => browser.open(`${origin}/abort`));
    if (browser.listTabs().length !== tabCountBeforeAbort) {
      throw new Error("A failed navigation leaked a browser tab.");
    }

    const downloadPage = await browser.open(origin, "smoke-thread");
    const downloadSnapshot = await browser.snapshot(downloadPage.id);
    const download = downloadSnapshot.elements.find((element) => element.name === "Download");
    if (!download) throw new Error("Download link is missing.");
    await browser.act(downloadPage.id, downloadSnapshot.revision, {
      type: "click",
      ref: download.ref,
    });
    const downloadPath = join(downloadsRoot, "openbot-smoke.txt");
    await waitFor(async () => (await readFile(downloadPath, "utf8")) === "local download");
    const nextDownloadSnapshot = await browser.snapshot(downloadPage.id);
    const nextDownload = nextDownloadSnapshot.elements.find((element) => element.name === "Download");
    if (!nextDownload) throw new Error("Download link disappeared.");
    await browser.act(downloadPage.id, nextDownloadSnapshot.revision, {
      type: "click",
      ref: nextDownload.ref,
    });
    await waitFor(
      async () => (await readFile(join(downloadsRoot, "openbot-smoke (2).txt"), "utf8")) === "local download",
    );
    process.stdout.write("BrowserHost: download passed.\n");

    const toolResult = await browser.handleDynamicTool({
      threadId: "smoke-thread",
      turnId: "browser-smoke-turn",
      callId: "browser-smoke-call",
      ownerBotId: "smoke-bot",
      namespace: "openbot_browser",
      tool: "open",
      arguments: { url: `${origin}/cookie` },
    });
    if (!toolResult.success) throw new Error("Dynamic browser tool failed.");
    const otherBotTab = await browser.open(`${origin}/cookie`, "smoke-thread", "other-bot");
    const scopedTabsResult = await browser.handleDynamicTool({
      threadId: "smoke-thread",
      turnId: "browser-smoke-scope-turn",
      callId: "browser-smoke-scope-call",
      ownerBotId: "smoke-bot",
      namespace: "openbot_browser",
      tool: "list_tabs",
      arguments: {},
    });
    const scopedTabsContent = scopedTabsResult.contentItems[0];
    const scopedTabsPayload = scopedTabsContent?.type === "inputText" ? JSON.parse(scopedTabsContent.text) : undefined;
    if (
      !scopedTabsResult.success ||
      !isDynamicRecord(scopedTabsPayload) ||
      !Array.isArray(scopedTabsPayload.tabs) ||
      scopedTabsPayload.tabs.some((candidate) => isDynamicRecord(candidate) && candidate.id === otherBotTab.id)
    ) {
      throw new Error("Dynamic browser tools exposed another agent's tab.");
    }
    const crossAgentSnapshot = await browser.handleDynamicTool({
      threadId: "smoke-thread",
      turnId: "browser-smoke-scope-turn",
      callId: "browser-smoke-cross-agent-call",
      ownerBotId: "smoke-bot",
      namespace: "openbot_browser",
      tool: "snapshot",
      arguments: { tabId: otherBotTab.id },
    });
    if (crossAgentSnapshot.success) throw new Error("Dynamic browser tools accessed another agent's tab.");
    process.stdout.write("BrowserHost: agent tab isolation passed.\n");
    if (!controlPhases.includes("open:acting") || !controlPhases.includes("open:waiting")) {
      throw new Error(`Browser control lifecycle was not reported: ${controlPhases.join(", ")}`);
    }
    if (!controlledTabIds.some(Boolean)) {
      throw new Error("Opening a page did not bind browser control to the new tab.");
    }
    await new Promise((resolve) => setTimeout(resolve, BrowserHost.CONTROL_IDLE_GRACE_MS + 100));
    if (browser.getControlState().sessions.length !== 0 || !controlPhases.includes("ended")) {
      throw new Error("Browser control indicator did not clear after the idle grace period.");
    }
    process.stdout.write("BrowserHost: agent control lifecycle passed.\n");

    const persistedTab = await browser.open(`${origin}/cookie`, "persisted-thread", "persisted-bot");
    await browser.activate(persistedTab.id);
    await browser.destroy();
    const restoredWindow = new BrowserWindow({ show: false });
    window.destroy();
    const restoredBrowser = new BrowserHost(restoredWindow, downloadsRoot, statePath);
    await restoredBrowser.restore();
    const restoredTabs = restoredBrowser.listTabs();
    const restoredTab = restoredTabs.find((candidate) => candidate.id === persistedTab.id);
    if (
      restoredTab?.ownerThreadId !== "persisted-thread" ||
      restoredTab?.ownerBotId !== "persisted-bot" ||
      restoredBrowser.activeTabId !== persistedTab.id
    ) {
      throw new Error("Browser tabs did not survive a BrowserHost restart.");
    }
    process.stdout.write("BrowserHost: persisted tabs passed.\n");
    await restoredBrowser.destroy();
    const persistedState = JSON.parse(await readFile(statePath, "utf8"));
    if (!isDynamicRecord(persistedState)) throw new Error("Persisted browser state is invalid.");
    const persistedTabs = Array.isArray(persistedState.tabs) ? persistedState.tabs.filter(isDynamicRecord) : [];
    if (
      getString(
        persistedTabs.find((candidate) => getString(candidate, "id") === persistedTab.id),
        "url",
      ) !== `${origin}/cookie`
    ) {
      throw new Error("An immediate shutdown lost a restored tab URL.");
    }
    restoredWindow.destroy();
    process.stdout.write("BrowserHost smoke test passed.\n");
  } finally {
    clearTimeout(hardTimeout);
    server.close();
    await rm(temporaryRoot, { recursive: true, force: true });
    app.quit();
  }
}

async function expectFailure(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("Expected operation to fail.");
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // The download may not exist yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for a browser download.");
}

async function waitForValue<T>(check: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for a browser state change.");
}

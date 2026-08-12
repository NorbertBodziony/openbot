import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { BrowserHost } from "../src/backend/browser-host";

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
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
  if (url.pathname === "/abort") {
    response.destroy();
    return;
  }

  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
    <input aria-label="Task" />
    <button aria-label="Save" onclick="document.querySelector('output').textContent = document.querySelector('input').value">Save</button>
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
    if (!address || typeof address === "string") throw new Error("Local server did not start.");
    const origin = `http://127.0.0.1:${address.port}`;

    await app.whenReady();
    process.stdout.write("BrowserHost: Electron ready.\n");
    const window = new BrowserWindow({ show: false });
    const downloadsRoot = join(temporaryRoot, "downloads");
    const browser = new BrowserHost(window, downloadsRoot);

    const controlPhases: string[] = [];
    const controlledTabIds: Array<string | null> = [];
    browser.onControlChanged((state) => {
      const session = state.sessions.find((item) => item.turnId === "browser-smoke-turn");
      if (session) {
        controlPhases.push(`${session.action}:${session.phase}`);
        controlledTabIds.push(session.tabId);
      } else if (controlPhases.length > 0) controlPhases.push("ended");
    });

    const tab = await browser.open(origin, "smoke-thread", "smoke-bot");
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
    if (!result.text.includes("runs locally")) throw new Error("Browser click/type failed.");
    process.stdout.write("BrowserHost: snapshot and actions passed.\n");
    await expectFailure(() =>
      browser.act(tab.id, first.revision, { type: "click", ref: save.ref }),
    );

    const child = result.elements.find((element) => element.name === "Child");
    if (!child) throw new Error("Child-tab control is missing.");
    await browser.act(tab.id, result.revision, { type: "click", ref: child.ref });
    await waitForValue(() =>
      browser
        .listTabs()
        .find((candidate) => candidate.id !== tab.id && candidate.url.includes("/child")),
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
    if (!cookieSnapshot.text.includes("openbot=shared"))
      throw new Error("Cookies were not shared.");
    process.stdout.write("BrowserHost: shared cookies passed.\n");

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
    process.stdout.write("BrowserHost: download passed.\n");

    const toolResult = await browser.handleDynamicTool({
      threadId: "smoke-thread",
      turnId: "browser-smoke-turn",
      callId: "browser-smoke-call",
      namespace: "openbot_browser",
      tool: "open",
      arguments: { url: `${origin}/cookie` },
    });
    if (!toolResult.success) throw new Error("Dynamic browser tool failed.");
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

    browser.destroy();
    window.destroy();
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

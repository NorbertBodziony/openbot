import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { app, BrowserWindow, webContents } from "electron";
import { BrowserHost } from "../src/backend/browser-host";
import { type DynamicToolResult, getString } from "../src/backend/protocol";

let cachedPageVersion = 1;
let slowDocumentVersion = 0;
let browserToolCall = 0;

interface PersistenceSnapshot {
  ready: true;
  cookie: string;
  localStorage: string | null;
  indexedDb: string | null;
}

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
    response.end(`<main>cookie:${request.headers.cookie ?? "none"}</main><span data-load-environment></span><script>
      document.querySelector('[data-load-environment]').textContent = 'load-environment:' + innerWidth + ':' + (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') + ':' + (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'motion');
    </script>`);
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
        navigatorWebdriver: navigator.webdriver,
      });
    </script>`);
    return;
  }
  if (url.pathname === "/abort") {
    response.destroy();
    return;
  }
  if (url.pathname === "/frame") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      `<button aria-label="Frame action" onclick="this.textContent='Frame clicked:' + event.isTrusted">Frame action</button>
       <button aria-label="Schedule frame navigation" onclick="setTimeout(() => location.href='/frame-next', 1000)">Schedule frame navigation</button>`,
    );
    return;
  }
  if (url.pathname === "/frame-next") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<button aria-label="Replacement frame action">Replacement frame action</button>`);
    return;
  }
  if (url.pathname === "/diagnostic-error") {
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("expected diagnostic failure");
    return;
  }
  if (url.pathname === "/slow-document") {
    slowDocumentVersion += 1;
    const version = slowDocumentVersion;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.write("<!doctype html><main>loading</main>");
    setTimeout(
      () => response.end(`<script>document.querySelector('main').textContent='ready:${version}'</script>`),
      250,
    );
    return;
  }
  if (url.pathname === "/v2") {
    const port = request.socket.localPort;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
      <label>Mode <select aria-label="Mode"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
      <label><input type="checkbox" aria-label="Agree" />Agree</label>
      <label><input type="radio" name="choice" aria-label="Primary choice" checked />Primary</label>
      <label><input type="radio" name="choice" aria-label="Secondary choice" />Secondary</label>
      <div contenteditable="true" role="textbox" aria-label="Notes"></div>
      <button aria-label="Duplicate">One</button><button aria-label="Duplicate">Two</button>
      <span style="position:relative;display:inline-block"><button aria-label="Covered">Covered</button><span style="position:absolute;inset:0;z-index:2" aria-hidden="true"></span></span>
      <span style="position:relative;display:inline-block"><button style="width:200px" aria-label="Partially covered" onclick="document.querySelector('output').textContent='partial:' + event.isTrusted">Partially covered</button><span style="position:absolute;left:70px;right:70px;top:0;bottom:0;z-index:2" aria-hidden="true"></span></span>
      <span hidden data-hidden-wait>hidden wait sentinel</span>
      <button aria-label="SPA" onclick="setTimeout(() => { history.pushState({}, '', '/v2#done'); document.querySelector('output').textContent='SPA done'; }, 20)">SPA</button>
      <button draggable="true" aria-label="Drag source">Drag source</button><button aria-label="Drop target" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.querySelector('output').textContent='drag:' + event.isTrusted">Drop target</button>
      <input type="file" aria-label="Files" onchange="document.querySelector('output').textContent=this.files[0]?.name || ''" />
      <canvas width="40" height="20" style="display:block;width:80px;height:40px" onclick="document.querySelector('output').textContent='canvas:' + event.isTrusted"></canvas>
      <iframe title="Cross origin frame" src="http://localhost:${port}/frame"></iframe>
      <div id="shadow"></div><output>ready</output>
      <script>
        const root = document.querySelector('#shadow').attachShadow({ mode: 'open' });
        root.innerHTML = '<button aria-label="Shadow action">Shadow action</button>';
        document.addEventListener('keydown', event => { if (event.ctrlKey && event.key.toLowerCase() === 'k') document.querySelector('output').textContent = 'shortcut:' + event.isTrusted; });
        console.error('v2 diagnostic marker'); fetch('/diagnostic-error').catch(() => {});
      </script>`);
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
  const googleLive = process.argv.includes("--google-live");
  const xLive = process.argv.includes("--x-live");
  const configuredRoot = argumentValue("--smoke-root=");
  const persistencePhase = argumentValue("--persistence-phase=");
  const persistenceOrigin = argumentValue("--persistence-origin=");
  const temporaryRoot = configuredRoot ?? (await mkdtemp(join(tmpdir(), "openbot-browser-smoke-")));
  const userDataPath = join(temporaryRoot, "user-data");
  await mkdir(userDataPath, { recursive: true });
  app.setName("OpenBot");
  app.setPath("userData", userDataPath);
  app.setPath("sessionData", userDataPath);
  const hardTimeout = setTimeout(() => {
    process.stderr.write("BrowserHost smoke test timed out.\n");
    app.exit(1);
  }, 60_000);

  try {
    if (persistencePhase) {
      if (!persistenceOrigin) throw new Error("A persistence origin is required.");
      await runPersistencePhase(temporaryRoot, persistenceOrigin, persistencePhase);
      return;
    }
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
    const browser = new BrowserHost(window, downloadsRoot, statePath, { recordingDurationMs: 500 });
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
    await waitFor(async () => webContents.getFocusedWebContents()?.getURL() === `${origin}/`);
    process.stdout.write("BrowserHost: local tab opened.\n");
    const first = await browser.snapshot(tab.id);
    const input = first.elements.find((element) => element.name === "Task");
    const save = first.elements.find((element) => element.name === "Save");
    if (!input || !save) throw new Error(`Snapshot did not expose local controls: ${JSON.stringify(first)}`);

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

    const v2Tab = await browser.open(`${origin}/v2`, "smoke-thread", "smoke-bot");
    const v2Contents = webContents
      .getAllWebContents()
      .find((contents) => !contents.isDestroyed() && contents.getURL().startsWith(`${origin}/v2`));
    if (!v2Contents) throw new Error("V2 web contents were not available.");
    const v2SnapshotResult = await callBrowserTool(browser, "snapshot", { tabId: v2Tab.id, image: "auto" });
    const v2Snapshot = toolTextPayload(v2SnapshotResult);
    if (!v2SnapshotResult.success || !isDynamicRecord(v2Snapshot) || !Array.isArray(v2Snapshot.elements)) {
      throw new Error("V2 snapshot failed.");
    }
    if (String(v2Snapshot.text).includes("hidden wait sentinel")) {
      throw new Error("V2 snapshot included hidden DOM text.");
    }
    const hiddenTextWait = await callBrowserTool(browser, "wait_for", {
      tabId: v2Tab.id,
      text: "hidden wait sentinel",
      timeoutMs: 200,
    });
    if (hiddenTextWait.success || !toolError(hiddenTextWait).includes("timed out")) {
      throw new Error("V2 text wait matched hidden DOM text.");
    }
    if (!v2SnapshotResult.contentItems.some((item) => item.type === "inputImage")) {
      throw new Error("Adaptive snapshot did not include an image for canvas/iframe content.");
    }
    const v2Elements = v2Snapshot.elements.filter(isDynamicRecord);
    if (!v2Elements.some((element) => element.name === "Shadow action")) {
      throw new Error("V2 snapshot did not pierce shadow DOM.");
    }
    if (!v2Elements.some((element) => element.name === "Frame action")) {
      throw new Error("V2 snapshot did not include a cross-origin iframe control.");
    }
    const frameClick = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Frame action", exact: true },
      timeoutMs: 30_000,
    });
    const frameClickSnapshot = toolTextPayload(frameClick);
    if (!frameClick.success || !String(frameClickSnapshot?.text).includes("Frame clicked:true")) {
      throw new Error(`V2 cross-origin iframe click failed: ${toolError(frameClick)}`);
    }
    const frameTextWait = await callBrowserTool(browser, "wait_for", {
      tabId: v2Tab.id,
      text: "Frame clicked:true",
      timeoutMs: 2_000,
    });
    if (!frameTextWait.success) throw new Error(`V2 iframe text wait failed: ${toolError(frameTextWait)}`);
    const scheduledFrameNavigation = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Schedule frame navigation", exact: true },
    });
    const scheduledFrameSnapshot = toolTextPayload(scheduledFrameNavigation);
    const scheduledFrameElements = Array.isArray(scheduledFrameSnapshot?.elements)
      ? scheduledFrameSnapshot.elements.filter(isDynamicRecord)
      : [];
    const staleFrameTarget = scheduledFrameElements.find((element) => element.name === "Frame action");
    const staleFrameRevision = scheduledFrameSnapshot?.revision;
    if (!scheduledFrameNavigation.success || !staleFrameTarget || !isNumber(staleFrameRevision)) {
      throw new Error(`V2 iframe navigation setup failed: ${toolError(scheduledFrameNavigation)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const staleFrameClick = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "ref", ref: String(staleFrameTarget.ref), revision: staleFrameRevision },
    });
    if (staleFrameClick.success || !toolError(staleFrameClick).includes("Stale browser reference")) {
      throw new Error("V2 iframe navigation did not invalidate revision-bound references.");
    }
    await browser.snapshot(v2Tab.id);
    const noDomRefs = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression: "document.querySelector('[data-openbot-ref]') === null",
    });
    if (toolTextPayload(noDomRefs)?.result !== true) throw new Error("V2 snapshot mutated the page DOM.");
    const selected = await callBrowserTool(browser, "select_option", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "combobox", name: "Mode", exact: true },
      values: ["b"],
    });
    if (!selected.success) throw new Error(`V2 select failed: ${toolError(selected)}`);
    const selectionValue = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression: "document.querySelector('select').value",
    });
    if (toolTextPayload(selectionValue)?.result !== "b")
      throw new Error("V2 select did not change the native control.");
    const partialSelection = await callBrowserTool(browser, "select_option", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "combobox", name: "Mode", exact: true },
      values: ["b", "missing"],
    });
    if (partialSelection.success || !toolError(partialSelection).includes("single-select")) {
      throw new Error("V2 single-select accepted multiple requested values.");
    }
    const missingSelection = await callBrowserTool(browser, "select_option", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "combobox", name: "Mode", exact: true },
      values: ["missing"],
    });
    if (missingSelection.success || !toolError(missingSelection).includes("do not exist")) {
      throw new Error("V2 select silently accepted a missing requested value.");
    }
    const checked = await callBrowserTool(browser, "set_checked", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "checkbox", name: "Agree", exact: true },
      checked: true,
    });
    if (!checked.success) throw new Error(`V2 checkbox failed: ${toolError(checked)}`);
    const clearedRadio = await callBrowserTool(browser, "set_checked", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "radio", name: "Primary choice", exact: true },
      checked: false,
    });
    if (clearedRadio.success || !toolError(clearedRadio).includes("cannot be cleared directly")) {
      throw new Error("V2 selected radio clearing did not return a truthful error.");
    }
    const contentEditable = await callBrowserTool(browser, "type", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "textbox", name: "Notes", exact: true },
      text: "editable text",
      mode: "replace",
    });
    if (!contentEditable.success) throw new Error(`V2 contenteditable typing failed: ${toolError(contentEditable)}`);
    const editableValue = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression: "document.querySelector('[contenteditable]').textContent",
    });
    if (toolTextPayload(editableValue)?.result !== "editable text") {
      throw new Error("V2 contenteditable target did not receive text.");
    }
    const shortcut = await callBrowserTool(browser, "press", { tabId: v2Tab.id, key: "Control+k" });
    if (!shortcut.success) throw new Error(`V2 keyboard shortcut failed: ${toolError(shortcut)}`);
    const shortcutValue = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression: "document.querySelector('output').textContent",
    });
    if (toolTextPayload(shortcutValue)?.result !== "shortcut:true") {
      throw new Error("V2 keyboard shortcut was not a trusted page event.");
    }
    const ambiguous = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Duplicate", exact: true },
    });
    if (ambiguous.success || !toolError(ambiguous).includes("Candidates:")) {
      throw new Error("V2 semantic locator did not reject an ambiguous target.");
    }
    const ambiguousCss = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "css", selector: 'button[aria-label="Duplicate"]' },
    });
    if (ambiguousCss.success || !toolError(ambiguousCss).includes("CSS selector is ambiguous")) {
      throw new Error("V2 CSS locator did not reject an ambiguous target.");
    }
    const covered = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Covered", exact: true },
    });
    if (covered.success || !toolError(covered).includes("covered by")) {
      throw new Error("V2 hit testing did not identify a covering page layer.");
    }
    const partiallyCovered = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Partially covered", exact: true },
    });
    if (!partiallyCovered.success || !String(toolTextPayload(partiallyCovered)?.text).includes("partial:true")) {
      throw new Error(`V2 hit testing did not use a visible target point: ${toolError(partiallyCovered)}`);
    }
    const freshTargetSetup = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression:
        "document.body.appendChild(Object.assign(document.createElement('button'), { ariaLabel: 'Fresh target', textContent: 'Fresh target', onclick: event => { document.querySelector('output').textContent = 'fresh:' + event.isTrusted; } })); true",
    });
    if (!freshTargetSetup.success) throw new Error(`V2 fresh target setup failed: ${toolError(freshTargetSetup)}`);
    const freshTarget = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Fresh target", exact: true },
    });
    if (!freshTarget.success || !String(toolTextPayload(freshTarget)?.text).includes("fresh:true")) {
      throw new Error(`V2 semantic target did not refresh before the action: ${toolError(freshTarget)}`);
    }
    const canvasPoint = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression:
        "(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
    });
    const point = toolTextPayload(canvasPoint)?.result;
    if (!isDynamicRecord(point)) throw new Error("V2 canvas coordinates were not serializable.");
    const canvasClick = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "point", x: point.x, y: point.y },
    });
    if (!canvasClick.success) throw new Error(`V2 coordinate click failed: ${toolError(canvasClick)}`);
    const canvasValue = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression: "document.querySelector('output').textContent",
    });
    if (toolTextPayload(canvasValue)?.result !== "canvas:true") {
      throw new Error("V2 canvas coordinate click was not trusted.");
    }
    const dragged = await callBrowserTool(browser, "drag", {
      tabId: v2Tab.id,
      source: { kind: "role", role: "button", name: "Drag source", exact: true },
      target: { kind: "role", role: "button", name: "Drop target", exact: true },
    });
    if (!dragged.success) throw new Error(`V2 drag failed: ${toolError(dragged)}`);
    const dragValue = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression: "document.querySelector('output').textContent",
    });
    if (toolTextPayload(dragValue)?.result !== "drag:true") {
      throw new Error("V2 drag did not produce a trusted drop event.");
    }
    const spaClick = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "SPA", exact: true },
    });
    if (!spaClick.success) throw new Error(`V2 SPA click failed: ${toolError(spaClick)}`);
    const spaWait = await callBrowserTool(browser, "wait_for", { tabId: v2Tab.id, text: "SPA done", timeoutMs: 2_000 });
    if (!spaWait.success) throw new Error(`V2 event wait failed: ${toolError(spaWait)}`);
    const scheduledTarget = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression:
        "setTimeout(() => { const button = document.createElement('button'); button.setAttribute('aria-label', 'Late action'); document.body.append(button); }, 100); true",
    });
    if (!scheduledTarget.success) throw new Error(`V2 late target setup failed: ${toolError(scheduledTarget)}`);
    const semanticWait = await callBrowserTool(browser, "wait_for", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Late action", exact: true },
      timeoutMs: 2_000,
    });
    if (!semanticWait.success) throw new Error(`V2 semantic wait failed: ${toolError(semanticWait)}`);
    const refWaitSnapshot = await browser.snapshot(v2Tab.id);
    const removedRefTarget = refWaitSnapshot.elements.find((element) => element.name === "Late action");
    if (!removedRefTarget) throw new Error("V2 removed-ref wait fixture was not available.");
    await v2Contents.executeJavaScript(`document.querySelector('[aria-label="Late action"]').remove()`, true);
    const removedRefWait = await callBrowserTool(browser, "wait_for", {
      tabId: v2Tab.id,
      target: { kind: "ref", ref: removedRefTarget.ref, revision: refWaitSnapshot.revision },
      timeoutMs: 100,
    });
    if (removedRefWait.success || !toolError(removedRefWait).includes("timed out")) {
      throw new Error("V2 ref wait matched an element after it was removed.");
    }
    const largeTargetSet = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression:
        "(() => { const container = Object.assign(document.createElement('div'), { innerHTML: Array.from({ length: 200 }, (_, index) => '<button aria-label=\"Bulk ' + index + '\">Bulk ' + index + '</button>').join('') }); container.dataset.bulkTargets = ''; document.body.appendChild(container); return true; })()",
    });
    if (!largeTargetSet.success) throw new Error(`V2 large target setup failed: ${toolError(largeTargetSet)}`);
    const semanticWaitStarted = Date.now();
    const boundedSemanticWait = await callBrowserTool(browser, "wait_for", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Missing bulk target", exact: true },
      timeoutMs: 5,
    });
    if (
      boundedSemanticWait.success ||
      !toolError(boundedSemanticWait).includes("timed out") ||
      Date.now() - semanticWaitStarted > 1_000
    ) {
      throw new Error("V2 semantic wait did not enforce its collection deadline.");
    }
    const boundedWaitSnapshot = await callBrowserTool(browser, "wait_for", {
      tabId: v2Tab.id,
      url: "/v2",
      timeoutMs: 5,
    });
    if (boundedWaitSnapshot.success || !toolError(boundedWaitSnapshot).includes("timed out")) {
      throw new Error("V2 wait snapshot did not share the condition deadline.");
    }
    const largeTargetCleanup = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression: "document.querySelector('[data-bulk-targets]').remove(); true",
    });
    if (!largeTargetCleanup.success) {
      throw new Error(`V2 large target cleanup failed: ${toolError(largeTargetCleanup)}`);
    }
    await v2Contents.executeJavaScript(
      `(() => {
        const container = document.createElement('div');
        container.dataset.bulkText = '';
        container.innerHTML = Array.from({ length: 6000 }, (_, index) => '<span>Bounded text ' + index + '</span>').join('');
        document.body.appendChild(container);
      })()`,
      true,
    );
    const textWaitStarted = Date.now();
    const boundedTextWait = await callBrowserTool(browser, "wait_for", {
      tabId: v2Tab.id,
      text: "Missing bounded text target",
      timeoutMs: 5,
    });
    if (
      boundedTextWait.success ||
      !toolError(boundedTextWait).includes("timed out") ||
      Date.now() - textWaitStarted > 1_000
    ) {
      throw new Error("V2 text wait did not enforce its scan deadline.");
    }
    await v2Contents.executeJavaScript(`document.querySelector('[data-bulk-text]').remove()`, true);
    const noisyPage = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression:
        "globalThis.__openbotNoise = setInterval(() => document.querySelector('output').toggleAttribute('data-noise'), 10); true",
    });
    if (!noisyPage.success) throw new Error(`V2 DOM noise setup failed: ${toolError(noisyPage)}`);
    const sharedEvaluationWorld = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression: "typeof globalThis.__openbotNoise === 'number'",
    });
    if (toolTextPayload(sharedEvaluationWorld)?.result !== true) {
      throw new Error("V2 evaluation did not reuse its isolated world.");
    }
    const actionTimeoutStarted = Date.now();
    const boundedAction = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "SPA", exact: true },
      timeoutMs: 50,
    });
    if (
      boundedAction.success ||
      !toolError(boundedAction).includes("timed out") ||
      Date.now() - actionTimeoutStarted > 1_000
    ) {
      throw new Error("V2 action did not include settling and snapshot work in its deadline.");
    }
    await v2Contents.executeJavaScript(
      `(() => {
      globalThis.__openbotOriginalMutationObserver = MutationObserver;
      globalThis.__openbotOriginalSetTimeout = setTimeout;
      globalThis.__openbotActiveObservers = 0;
      globalThis.setTimeout = () => 0;
      globalThis.MutationObserver = class extends MutationObserver {
        #observing = false;
        observe(...args) {
          if (!this.#observing) { this.#observing = true; globalThis.__openbotActiveObservers += 1; }
          return super.observe(...args);
        }
        disconnect() {
          if (this.#observing) { this.#observing = false; globalThis.__openbotActiveObservers -= 1; }
          return super.disconnect();
        }
      };
    })()`,
      true,
    );
    const quietWait = await callBrowserTool(browser, "wait_for", {
      tabId: v2Tab.id,
      state: "dom-quiet",
      timeoutMs: 200,
    });
    if (quietWait.success || !toolError(quietWait).includes("DOM did not become quiet")) {
      throw new Error("V2 DOM-quiet wait suppressed its timeout.");
    }
    const activeObservers = await v2Contents.executeJavaScript("globalThis.__openbotActiveObservers", true);
    if (activeObservers !== 0) throw new Error("V2 DOM-quiet timeout left a MutationObserver active.");
    await v2Contents.executeJavaScript(
      "globalThis.MutationObserver = globalThis.__openbotOriginalMutationObserver; globalThis.setTimeout = globalThis.__openbotOriginalSetTimeout; delete globalThis.__openbotOriginalMutationObserver; delete globalThis.__openbotOriginalSetTimeout; delete globalThis.__openbotActiveObservers;",
      true,
    );
    const stoppedNoise = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression: "clearInterval(globalThis.__openbotNoise); delete globalThis.__openbotNoise; true",
    });
    if (!stoppedNoise.success) throw new Error(`V2 DOM noise cleanup failed: ${toolError(stoppedNoise)}`);
    const slowNoise = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression:
        "globalThis.__openbotSlowNoise = setInterval(() => document.body.toggleAttribute('data-slow-noise'), 10); setTimeout(() => { clearInterval(globalThis.__openbotSlowNoise); delete globalThis.__openbotSlowNoise; }, 1200); true",
    });
    if (!slowNoise.success) throw new Error(`V2 slow DOM noise setup failed: ${toolError(slowNoise)}`);
    const patientQuietWait = await callBrowserTool(browser, "wait_for", {
      tabId: v2Tab.id,
      state: "dom-quiet",
      timeoutMs: 2_500,
    });
    if (!patientQuietWait.success) {
      throw new Error(`V2 DOM-quiet wait ignored the requested timeout: ${toolError(patientQuietWait)}`);
    }
    const transientCondition = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression:
        "globalThis.__openbotTransient = document.body.appendChild(Object.assign(document.createElement('span'), { textContent: 'transient quiet condition' })); globalThis.__openbotTransientNoise = setInterval(() => document.body.toggleAttribute('data-transient-noise'), 20); setTimeout(() => { clearInterval(globalThis.__openbotTransientNoise); globalThis.__openbotTransient.remove(); delete globalThis.__openbotTransient; delete globalThis.__openbotTransientNoise; }, 300); true",
    });
    if (!transientCondition.success) {
      throw new Error(`V2 transient wait setup failed: ${toolError(transientCondition)}`);
    }
    const invalidatedQuietWait = await callBrowserTool(browser, "wait_for", {
      tabId: v2Tab.id,
      text: "transient quiet condition",
      state: "dom-quiet",
      timeoutMs: 700,
    });
    if (invalidatedQuietWait.success || !toolError(invalidatedQuietWait).includes("timed out")) {
      throw new Error("V2 DOM-quiet wait did not recheck its matched text condition.");
    }
    const clearedEvaluationWorld = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression: "globalThis.__openbotNoise === undefined",
    });
    if (toolTextPayload(clearedEvaluationWorld)?.result !== true) {
      throw new Error("V2 evaluation world did not preserve cross-call cleanup.");
    }
    const evaluationTimeout = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression: "new Promise(() => {})",
      timeoutMs: 50,
    });
    if (evaluationTimeout.success || !toolError(evaluationTimeout).includes("timed out")) {
      throw new Error("V2 evaluation did not return its bounded timeout.");
    }
    const evaluationRecovered = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression: "21 * 2",
    });
    if (toolTextPayload(evaluationRecovered)?.result !== 42) {
      throw new Error(`V2 evaluation did not recover after timeout: ${toolError(evaluationRecovered)}`);
    }
    const timedOut = await callBrowserTool(browser, "wait_for", {
      tabId: v2Tab.id,
      text: "never appears",
      timeoutMs: 10,
    });
    if (timedOut.success || !toolError(timedOut).includes("timed out")) {
      throw new Error("V2 wait_for did not return a bounded timeout error.");
    }
    const uploadPath = join(temporaryRoot, "v2-upload.txt");
    await writeFile(uploadPath, "upload fixture");
    const uploaded = await callBrowserTool(browser, "upload_files", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Files" },
      paths: [uploadPath],
    });
    if (!uploaded.success) throw new Error(`V2 upload failed: ${toolError(uploaded)}`);
    const environment = await callBrowserTool(browser, "set_environment", {
      tabId: v2Tab.id,
      preset: "mobile",
      colorScheme: "dark",
      reducedMotion: true,
    });
    const environmentSnapshot = toolTextPayload(environment);
    if (
      !environment.success ||
      !isDynamicRecord(environmentSnapshot?.viewport) ||
      environmentSnapshot.viewport.width !== 390
    ) {
      throw new Error(`V2 environment emulation failed: ${toolError(environment)}`);
    }
    const persistentEnvironment = await v2Contents?.executeJavaScript(
      "({ width: innerWidth, dark: matchMedia('(prefers-color-scheme: dark)').matches, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches })",
      true,
    );
    if (
      !isDynamicRecord(persistentEnvironment) ||
      persistentEnvironment.width !== 390 ||
      persistentEnvironment.dark !== true ||
      persistentEnvironment.reduced !== true
    ) {
      throw new Error("V2 environment emulation did not persist between CDP operations.");
    }
    if (!Array.isArray(environmentSnapshot.diagnostics) || environmentSnapshot.diagnostics.length === 0) {
      throw new Error("V2 snapshot omitted diagnostics.");
    }
    const oversizedEnvironment = await callBrowserTool(browser, "set_environment", {
      tabId: v2Tab.id,
      preset: "custom",
      width: 16_384,
      height: 16_384,
      deviceScaleFactor: 4,
    });
    if (oversizedEnvironment.success || !toolError(oversizedEnvironment).includes("physical viewport")) {
      throw new Error("V2 environment accepted an unsafe physical pixel area.");
    }
    const recordingStarted = await callBrowserTool(browser, "recording_start", { tabId: v2Tab.id });
    if (
      !recordingStarted.success ||
      browser.listTabs().find((candidate) => candidate.id === v2Tab.id)?.recording !== true
    ) {
      throw new Error(`V2 recording did not start: ${toolError(recordingStarted)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const prematureRecordingRestart = await callBrowserTool(browser, "recording_start", { tabId: v2Tab.id });
    if (prematureRecordingRestart.success || !toolError(prematureRecordingRestart).includes("recording_stop")) {
      throw new Error("V2 recording restart replaced an unclaimed completed artifact.");
    }
    const recordingStopped = await callBrowserTool(browser, "recording_stop", { tabId: v2Tab.id });
    const recordingPayload = toolTextPayload(recordingStopped);
    const artifact = isDynamicRecord(recordingPayload?.artifact) ? recordingPayload.artifact : undefined;
    const recordingPath = artifact ? getString(artifact, "path") : undefined;
    if (!recordingStopped.success || !recordingPath) {
      throw new Error(`V2 recording did not stop: ${toolError(recordingStopped)}`);
    }
    const recordingBytes = await readFile(recordingPath);
    if (recordingBytes.length === 0 || recordingBytes.subarray(0, 4).toString("hex") !== "1a45dfa3") {
      throw new Error("V2 recorder did not produce a valid WebM EBML header.");
    }
    if (browser.listTabs().find((candidate) => candidate.id === v2Tab.id)?.recording !== false) {
      throw new Error("V2 recording state was not cleaned up.");
    }
    const recordingRestarted = await callBrowserTool(browser, "recording_start", { tabId: v2Tab.id });
    if (!recordingRestarted.success) {
      throw new Error(`V2 recording did not restart after an automatic stop: ${toolError(recordingRestarted)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const restartedRecordingStopped = await callBrowserTool(browser, "recording_stop", { tabId: v2Tab.id });
    if (!restartedRecordingStopped.success) {
      throw new Error(`V2 restarted recording did not stop: ${toolError(restartedRecordingStopped)}`);
    }
    const filesBeforeAbandonedRecording = new Set(await readdir(downloadsRoot));
    const abandonedRecordingTab = await browser.open(`${origin}/v2`, "smoke-thread", "smoke-bot");
    const abandonedRecordingStarted = await callBrowserTool(browser, "recording_start", {
      tabId: abandonedRecordingTab.id,
    });
    if (!abandonedRecordingStarted.success) {
      throw new Error(`V2 abandoned recording did not start: ${toolError(abandonedRecordingStarted)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const abandonedRecordingName = (await readdir(downloadsRoot)).find(
      (name) => !filesBeforeAbandonedRecording.has(name) && name.endsWith(".webm"),
    );
    if (!abandonedRecordingName) throw new Error("V2 automatic recording did not create an artifact.");
    const abandonedRecordingPath = join(downloadsRoot, abandonedRecordingName);
    await browser.close(abandonedRecordingTab.id);
    await waitFor(async () =>
      readFile(abandonedRecordingPath).then(
        () => false,
        () => true,
      ),
    );
    const waitTab = await browser.open(origin, "smoke-thread", "smoke-bot");
    const beforeNavigation = await browser.snapshot(waitTab.id);
    const staleNavigationTarget = beforeNavigation.elements.find((element) => element.name === "Save");
    if (!staleNavigationTarget) throw new Error("V2 stale-reference test did not find its source target.");
    const navigationStarted = await callBrowserTool(browser, "evaluate", {
      tabId: waitTab.id,
      expression: `location.href = ${JSON.stringify(`${origin}/slow-document?domcontentloaded`)}; true`,
    });
    if (!navigationStarted.success) throw new Error(`V2 readiness navigation failed: ${toolError(navigationStarted)}`);
    const readinessStartedAt = Date.now();
    const domContentLoaded = await callBrowserTool(browser, "wait_for", {
      tabId: waitTab.id,
      state: "domcontentloaded",
      timeoutMs: 2_000,
    });
    if (!domContentLoaded.success || Date.now() - readinessStartedAt < 150) {
      throw new Error(
        `V2 DOMContentLoaded wait returned before the document was ready: ${toolError(domContentLoaded)}`,
      );
    }
    const evaluationAfterNavigation = await callBrowserTool(browser, "evaluate", {
      tabId: waitTab.id,
      expression: "document.readyState",
    });
    if (!["interactive", "complete"].includes(String(toolTextPayload(evaluationAfterNavigation)?.result))) {
      throw new Error(`V2 evaluation world was not restored after navigation: ${toolError(evaluationAfterNavigation)}`);
    }
    const staleNavigationClick = await callBrowserTool(browser, "click", {
      tabId: waitTab.id,
      target: { kind: "ref", ref: staleNavigationTarget.ref, revision: beforeNavigation.revision },
    });
    if (staleNavigationClick.success || !toolError(staleNavigationClick).includes("Stale browser reference")) {
      throw new Error("V2 navigation did not invalidate revision-bound references.");
    }
    const timedNavigation = await callBrowserTool(browser, "navigate", {
      tabId: waitTab.id,
      url: `${origin}/slow-document?serialized`,
      timeoutMs: 10,
    });
    if (timedNavigation.success || !toolError(timedNavigation).includes("timed out")) {
      throw new Error("V2 slow navigation did not return its bounded timeout error.");
    }
    const queuedSnapshotStartedAt = Date.now();
    const queuedSnapshot = await callBrowserTool(browser, "snapshot", { tabId: waitTab.id });
    if (
      !queuedSnapshot.success ||
      Date.now() - queuedSnapshotStartedAt > 1_000 ||
      browser.listTabs().find((candidate) => candidate.id === waitTab.id)?.loading === true
    ) {
      throw new Error("V2 timed-out navigation did not stop before the tab queue resumed.");
    }
    const beforeReloadText = String(toolTextPayload(queuedSnapshot)?.text);
    const reloadStartedAt = Date.now();
    const reloaded = await callBrowserTool(browser, "navigate", {
      tabId: waitTab.id,
      direction: "reload",
      timeoutMs: 2_000,
    });
    const reloadedText = String(toolTextPayload(reloaded)?.text);
    if (!reloaded.success || reloadedText === beforeReloadText || Date.now() - reloadStartedAt < 150) {
      throw new Error(`V2 reload snapshot did not wait for the new document: ${toolError(reloaded)}`);
    }
    const boundedTab = await browser.open(origin, "smoke-thread", "smoke-bot");
    const largeDom = await callBrowserTool(browser, "evaluate", {
      tabId: boundedTab.id,
      expression:
        "document.body.replaceChildren(...Array.from({ length: 200 }, (_, index) => Object.assign(document.createElement('div'), { role: 'presentation', tabIndex: 0, textContent: 'Decoration ' + index })), ...Array.from({ length: 200 }, (_, index) => Object.assign(document.createElement('button'), { hidden: true, textContent: 'Hidden ' + index })), Object.assign(document.createElement('div'), { role: 'switch', ariaLabel: 'Bounded switch', textContent: 'Switch' }), ...Array.from({ length: 250 }, (_, index) => Object.assign(document.createElement('button'), { textContent: 'Bounded ' + index }))); true",
    });
    if (!largeDom.success) throw new Error(`V2 bounded DOM setup failed: ${toolError(largeDom)}`);
    const boundedSnapshot = await browser.snapshot(boundedTab.id);
    if (boundedSnapshot.elements.length !== 200) {
      throw new Error(`V2 snapshot did not enforce its global element cap: ${boundedSnapshot.elements.length}`);
    }
    if (!boundedSnapshot.elements.some((element) => element.role === "switch" && element.name === "Bounded switch")) {
      throw new Error("V2 snapshot candidate cap hid an actionable ARIA role.");
    }
    await browser.close(boundedTab.id);
    process.stdout.write("BrowserHost: V2 semantics, adaptive image, iframe, upload, waits, and emulation passed.\n");

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
    const chromiumMajorVersion = process.versions.chrome.split(".")[0];
    if (
      headerSnapshot.text.includes("Electron/") ||
      !headerSnapshot.text.includes("OpenBot/") ||
      !navigatorUserAgent?.includes(`Chrome/${chromiumMajorVersion}`) ||
      getString(identity.requestHeaders, "user-agent") !== navigatorUserAgent ||
      identity.navigatorWebdriver !== false ||
      headerSnapshot.text.includes("Google Chrome") ||
      (clientHintBrands.length > 0 &&
        navigatorBrands.some(
          (brand) => !clientHintBrands.includes(`"${getString(brand, "brand")}";v="${getString(brand, "version")}"`),
        ))
    ) {
      throw new Error(`Browser identity headers are invalid: ${headerSnapshot.text}`);
    }
    process.stdout.write("BrowserHost: matching Chromium page and request identity passed.\n");
    if (googleLive) await runGoogleLiveProbe(browser);
    if (xLive) await runXLiveProbe(browser);
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

    const persistedTab = await browser.open(`${origin}/cookie`, "smoke-thread", "smoke-bot");
    const persistedEnvironment = await callBrowserTool(browser, "set_environment", {
      tabId: persistedTab.id,
      preset: "mobile",
      colorScheme: "dark",
      reducedMotion: true,
    });
    if (!persistedEnvironment.success) {
      throw new Error(`Persisted environment setup failed: ${toolError(persistedEnvironment)}`);
    }
    await browser.activate(persistedTab.id);
    const browserDestruction = browser.destroy();
    if (browser.listTabs().length !== 0) {
      throw new Error("BrowserHost kept views active while shutdown persistence was pending.");
    }
    await browserDestruction;
    await browser
      .open(`${origin}/cookie`, "late-thread")
      .then(() => {
        throw new Error("BrowserHost accepted a new tab after shutdown started.");
      })
      .catch((error) => {
        if (!String(error).includes("shutting down")) throw error;
      });
    const restoredWindow = new BrowserWindow({ show: false });
    window.destroy();
    const restoredBrowser = new BrowserHost(restoredWindow, downloadsRoot, statePath);
    await restoredBrowser.restore();
    const restoredTabs = restoredBrowser.listTabs();
    const restoredTab = restoredTabs.find((candidate) => candidate.id === persistedTab.id);
    if (
      restoredTab?.ownerThreadId !== "smoke-thread" ||
      restoredTab?.ownerBotId !== "smoke-bot" ||
      restoredBrowser.activeTabId !== persistedTab.id
    ) {
      throw new Error("Browser tabs did not survive a BrowserHost restart.");
    }
    const restoredEnvironmentSnapshot = await restoredBrowser.snapshot(persistedTab.id);
    if (!restoredEnvironmentSnapshot.text.includes("load-environment:390:dark:reduce")) {
      throw new Error("Restored browser environment was not applied before navigation.");
    }
    process.stdout.write("BrowserHost: persisted tabs passed.\n");
    await restoredBrowser.destroy();
    const persistedState = JSON.parse(await readFile(statePath, "utf8"));
    if (!isDynamicRecord(persistedState)) throw new Error("Persisted browser state is invalid.");
    if (persistedState.version !== 2) throw new Error("Browser state was not persisted as version 2.");
    const persistedTabs = Array.isArray(persistedState.tabs) ? persistedState.tabs.filter(isDynamicRecord) : [];
    if (
      getString(
        persistedTabs.find((candidate) => getString(candidate, "id") === persistedTab.id),
        "url",
      ) !== `${origin}/cookie`
    ) {
      throw new Error("An immediate shutdown lost a restored tab URL.");
    }
    const legacyTabId = "legacy-v1-tab";
    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        activeTabId: legacyTabId,
        tabs: [
          {
            id: legacyTabId,
            url: `${origin}/cookie`,
            ownerThreadId: "legacy-thread",
            ownerBotId: "legacy-bot",
          },
        ],
      })}\n`,
    );
    const legacyWindow = new BrowserWindow({ show: false });
    const legacyBrowser = new BrowserHost(legacyWindow, downloadsRoot, statePath);
    await legacyBrowser.restore();
    const legacyTab = legacyBrowser.listTabs().find((candidate) => candidate.id === legacyTabId);
    if (legacyTab?.environment?.viewport.mode !== "fill" || legacyTab.environment.colorScheme !== "system") {
      throw new Error("Browser state v1 did not migrate to the default V2 environment.");
    }
    await legacyBrowser.destroy();
    legacyWindow.destroy();
    restoredWindow.destroy();
    process.stdout.write("BrowserHost smoke test passed.\n");
  } finally {
    clearTimeout(hardTimeout);
    if (server.listening) server.close();
    if (!configuredRoot) await rm(temporaryRoot, { recursive: true, force: true });
    app.quit();
  }
}

async function runPersistencePhase(root: string, origin: string, phase: string): Promise<void> {
  if (!new Set(["write", "read", "clear", "verify-cleared"]).has(phase)) {
    throw new Error(`Unknown persistence phase: ${phase}`);
  }
  await app.whenReady();
  const window = new BrowserWindow({ show: false });
  const browser = new BrowserHost(window, join(root, "downloads"), join(root, "browser-tabs.json"));
  await browser.setVisible({ visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });
  try {
    const tab = await browser.open(`${origin}/persistence?phase=${encodeURIComponent(phase)}`, "persistence-thread");
    const snapshot = await waitForPersistenceSnapshot(browser, tab.id);
    const expectedStored = phase === "write" || phase === "read";
    const cookie = getString(snapshot, "cookie") ?? "";
    const localStorageValue = getString(snapshot, "localStorage");
    const indexedDbValue = getString(snapshot, "indexedDb");
    // The npm macOS Electron binary does not have OpenBot's production signature or cookie-encryption fuse.
    // Verify encrypted cookie persistence with the signed app; other platforms cover it in this process test.
    const requireCrossProcessCookie = phase !== "read" || process.platform !== "darwin";
    if (
      (expectedStored &&
        (localStorageValue !== "kept" ||
          indexedDbValue !== "kept" ||
          (requireCrossProcessCookie && !cookie.includes("openbot_persistence=kept")))) ||
      (!expectedStored &&
        (cookie.includes("openbot_persistence=kept") || localStorageValue !== null || indexedDbValue !== null))
    ) {
      throw new Error(`Browser persistence phase ${phase} returned invalid state: ${JSON.stringify(snapshot)}`);
    }
    if (expectedStored && !requireCrossProcessCookie && !cookie.includes("openbot_persistence=kept")) {
      process.stdout.write("BrowserHost: signed macOS app must verify encrypted cookie persistence.\n");
    }
    await browser.flushPersistentStorage();
  } finally {
    try {
      await browser.destroy();
    } finally {
      window.destroy();
    }
  }
  process.stdout.write(`BrowserHost: persistence ${phase} phase passed.\n`);
}

async function waitForPersistenceSnapshot(browser: BrowserHost, tabId: string): Promise<PersistenceSnapshot> {
  let latest = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await browser.snapshot(tabId);
    latest = snapshot.text;
    try {
      const parsed = JSON.parse(snapshot.text);
      if (isDynamicRecord(parsed) && parsed.ready === true) {
        return {
          ready: true,
          cookie: getString(parsed, "cookie") ?? "",
          localStorage: getString(parsed, "localStorage"),
          indexedDb: getString(parsed, "indexedDb"),
        };
      }
    } catch {
      // The page can still be initializing IndexedDB.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Persistence page did not become ready: ${latest}`);
}

function argumentValue(prefix: string): string | null {
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || null;
}

function callBrowserTool(browser: BrowserHost, tool: string, argumentsValue: unknown): Promise<DynamicToolResult> {
  browserToolCall += 1;
  return browser.handleDynamicTool({
    threadId: "smoke-thread",
    turnId: `browser-v2-${browserToolCall}`,
    callId: `browser-v2-call-${browserToolCall}`,
    ownerBotId: "smoke-bot",
    namespace: "openbot_browser",
    tool,
    arguments: argumentsValue,
  });
}

function toolTextPayload(result: DynamicToolResult): DynamicRecord | undefined {
  const item = result.contentItems.find((candidate) => candidate.type === "inputText");
  if (item?.type !== "inputText") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(item.text);
  } catch {
    return undefined;
  }
  return isDynamicRecord(value) ? value : undefined;
}

function toolError(result: DynamicToolResult): string {
  const item = result.contentItems.find((candidate) => candidate.type === "inputText");
  return item?.type === "inputText" ? item.text : "unknown browser tool error";
}

async function runGoogleLiveProbe(browser: BrowserHost): Promise<void> {
  const googleTab = await browser.open(
    "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.google.com%2F&hl=en",
    "google-live-smoke",
    "google-live-smoke",
    true,
  );
  const identifierPage = await waitForGoogleSnapshot(browser, googleTab.id, (snapshot) =>
    snapshot.elements.some((element) => element.tag === "input" && !element.disabled),
  );
  const identifier = identifierPage.elements.find((element) => element.tag === "input" && !element.disabled);
  if (!identifier) throw new Error("Google did not show an account identifier field.");
  await browser.act(googleTab.id, identifierPage.revision, {
    type: "type",
    ref: identifier.ref,
    text: "openbot-google-probe@example.com",
    submit: true,
  });
  const outcome = await waitForGoogleSnapshot(browser, googleTab.id, (snapshot) => {
    const normalized = snapshot.text.toLowerCase();
    return (
      snapshot.url.includes("/signin/rejected") ||
      normalized.includes("browser or app may not be secure") ||
      normalized.includes("couldn’t find your google account") ||
      normalized.includes("couldn't find your google account") ||
      normalized.includes("couldn’t find this account") ||
      normalized.includes("couldn't find this account")
    );
  });
  const normalized = outcome.text.toLowerCase();
  if (outcome.url.includes("/signin/rejected") || normalized.includes("browser or app may not be secure")) {
    throw new Error(`Google rejected the embedded browser: ${outcome.url}`);
  }
  if (
    !normalized.includes("couldn’t find your google account") &&
    !normalized.includes("couldn't find your google account") &&
    !normalized.includes("couldn’t find this account") &&
    !normalized.includes("couldn't find this account")
  ) {
    throw new Error(`Google returned an unexpected identifier result: ${outcome.text.slice(0, 500)}`);
  }
  process.stdout.write("BrowserHost: Google identifier step passed without signin/rejected.\n");
}

async function runXLiveProbe(browser: BrowserHost): Promise<void> {
  const xTab = await browser.open("https://x.com/", "x-live-smoke", "x-live-smoke", true);
  let loginPage = await waitForXSnapshot(browser, xTab.id, (snapshot) => {
    const normalized = snapshot.text.toLowerCase();
    return (
      normalized.includes("refuse non-essential cookies") ||
      snapshot.elements.some((element) => element.name.toLowerCase() === "sign in") ||
      normalized.includes("something went wrong") ||
      normalized.includes("this browser is no longer supported")
    );
  });
  let normalized = loginPage.text.toLowerCase();
  if (normalized.includes("something went wrong") || normalized.includes("this browser is no longer supported")) {
    throw new Error(`X rejected the embedded browser: ${loginPage.url} ${loginPage.text.slice(0, 500)}`);
  }
  let refuseCookies = loginPage.elements.find((element) =>
    element.name.toLowerCase().includes("refuse non-essential cookies"),
  );
  if (!refuseCookies && normalized.includes("refuse non-essential cookies")) {
    loginPage = await waitForXSnapshot(browser, xTab.id, (snapshot) =>
      snapshot.elements.some((element) => element.name.toLowerCase().includes("refuse non-essential cookies")),
    );
    refuseCookies = loginPage.elements.find((element) =>
      element.name.toLowerCase().includes("refuse non-essential cookies"),
    );
  }
  if (refuseCookies) {
    process.stdout.write(`BrowserHost: X cookie control ${JSON.stringify(refuseCookies)}.\n`);
    loginPage = await browser.act(xTab.id, loginPage.revision, { type: "click", ref: refuseCookies.ref });
    loginPage = await waitForXSnapshot(
      browser,
      xTab.id,
      (snapshot) =>
        !snapshot.text.toLowerCase().includes("refuse non-essential cookies") &&
        snapshot.elements.some(
          (element) => element.name.toLowerCase() === "sign in" || (element.tag === "input" && !element.disabled),
        ),
    );
    normalized = loginPage.text.toLowerCase();
  }
  if (normalized.includes("something went wrong") || normalized.includes("this browser is no longer supported")) {
    throw new Error(
      `X rejected the embedded browser after cookie consent: ${loginPage.url} ${loginPage.text.slice(0, 500)}`,
    );
  }
  if (!loginPage.elements.some((element) => element.tag === "input" && !element.disabled)) {
    const signIn = loginPage.elements.find((element) => element.name.toLowerCase() === "sign in");
    if (!signIn) throw new Error(`X did not show a sign-in control: ${loginPage.text.slice(0, 500)}`);
    loginPage = await browser.act(xTab.id, loginPage.revision, { type: "click", ref: signIn.ref });
    loginPage = await waitForXSnapshot(browser, xTab.id, (snapshot) =>
      snapshot.elements.some((element) => element.tag === "input" && !element.disabled),
    );
  }
  const identifier = loginPage.elements.find((element) => element.tag === "input" && !element.disabled);
  if (!identifier) throw new Error("X did not show an account identifier field.");
  process.stdout.write("BrowserHost: X login identifier step loaded.\n");
}

async function waitForXSnapshot(
  browser: BrowserHost,
  tabId: string,
  predicate: (snapshot: Awaited<ReturnType<BrowserHost["snapshot"]>>) => boolean,
): Promise<Awaited<ReturnType<BrowserHost["snapshot"]>>> {
  const deadline = Date.now() + 20_000;
  let snapshot = await browser.snapshot(tabId);
  while (Date.now() < deadline) {
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 250));
    snapshot = await browser.snapshot(tabId);
  }
  throw new Error(`Timed out waiting for X: ${snapshot.url} ${snapshot.text.slice(0, 500)}`);
}

async function waitForGoogleSnapshot(
  browser: BrowserHost,
  tabId: string,
  predicate: (snapshot: Awaited<ReturnType<BrowserHost["snapshot"]>>) => boolean,
): Promise<Awaited<ReturnType<BrowserHost["snapshot"]>>> {
  const deadline = Date.now() + 20_000;
  let snapshot = await browser.snapshot(tabId);
  while (Date.now() < deadline) {
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 250));
    snapshot = await browser.snapshot(tabId);
  }
  throw new Error(`Timed out waiting for Google: ${snapshot.url} ${snapshot.text.slice(0, 500)}`);
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

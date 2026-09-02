import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { app, BrowserWindow, type WebContents, webContents } from "electron";
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
  if (url.pathname === "/settle") {
    response.setHeader("content-type", "text/plain; charset=utf-8");
    setTimeout(() => response.end("settled"), 100);
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
    const frameActionLabel = url.searchParams.get("action_label") ?? "Frame action";
    const frameFileLabel = url.searchParams.get("file_label") ?? "Frame files";
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      `<button aria-label="${frameActionLabel}" onclick="const trusted=event.isTrusted;fetch('/settle').then(()=>{this.textContent='Frame settled:5:'+trusted})">${frameActionLabel}</button>
       <button aria-label="Schedule frame navigation" onclick="setTimeout(() => location.href='/frame-next', 1000)">Schedule frame navigation</button>
       <input aria-label="Frame field" oninput="document.querySelector('output').textContent='Frame input:' + this.value + ':' + event.isTrusted" onkeydown="if (event.key === 'Enter') document.querySelector('output').textContent += '|Frame key:' + event.isTrusted" />
       <input type="file" aria-label="${frameFileLabel}" />
       <output>Frame ready</output>`,
    );
    return;
  }
  if (url.pathname === "/frame-next") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      `<button aria-label="Replacement frame action">Replacement frame action</button><input type="file" aria-label="Frame files" />`,
    );
    return;
  }
  if (url.pathname === "/same-frame") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      `<button aria-label="Same-origin action" onclick="document.querySelector('output').textContent='Same-origin:' + event.isTrusted">Same-origin action</button>
       <label>Mode <select aria-label="Same-origin mode" oninput="this.dataset.inputTrusted=String(event.isTrusted)" onchange="this.dataset.changeTrusted=String(event.isTrusted)"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
       <label>Collision <select aria-label="Same-origin collision"><option value="first">target</option><option value="target">Second</option><option value="third">Second</option></select></label>
       <label>Tags <select multiple size="3" aria-label="Same-origin tags" oninput="this.dataset.inputTrusted=String(event.isTrusted)" onchange="this.dataset.changeTrusted=String(event.isTrusted)"><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option></select></label>
       <label><input type="radio" name="same-choice" aria-label="Same-origin primary choice" checked />Primary</label>
       <input aria-label="Same-origin field" value="a" />
       <output>Same-origin ready</output>`,
    );
    return;
  }
  if (url.pathname === "/diagnostic-error") {
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("expected diagnostic failure");
    return;
  }
  if (url.pathname === "/console-script") {
    response.setHeader("content-type", "text/javascript; charset=utf-8");
    response.end("console.error('external diagnostic marker');");
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
      <label>Mode <select aria-label="Mode" oninput="this.dataset.inputTrusted=String(event.isTrusted)" onchange="this.dataset.changeTrusted=String(event.isTrusted)"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
      <label><input type="checkbox" aria-label="Agree" />Agree</label>
      <label><input type="radio" name="choice" aria-label="Primary choice" checked />Primary</label>
      <label><input type="radio" name="choice" aria-label="Secondary choice" />Secondary</label>
      <div contenteditable="true" role="textbox" aria-label="Notes"></div>
      <input type="number" aria-label="Quantity" value="12" />
      <button aria-label="Duplicate">One</button><button aria-label="Duplicate">Two</button>
      <button aria-label="Accessible override" onclick="document.querySelector('output').textContent='visible-text:' + event.isTrusted">Unique action text</button>
      <span style="position:relative;display:inline-block"><button aria-label="Covered">Covered</button><span style="position:absolute;inset:0;z-index:2" aria-hidden="true"></span></span>
      <span style="position:relative;display:inline-block"><button style="width:200px" aria-label="Partially covered" onclick="document.querySelector('output').textContent='partial:' + event.isTrusted">Partially covered</button><span style="position:absolute;left:70px;right:70px;top:0;bottom:0;z-index:2" aria-hidden="true"></span></span>
      <span hidden data-hidden-wait>hidden wait sentinel</span>
      <button aria-label="SPA" onclick="setTimeout(() => { history.pushState({}, '', '/v2#done'); document.querySelector('output').textContent='SPA done'; }, 20)">SPA</button>
      <button draggable="true" aria-label="Drag source">Drag source</button><button aria-label="Drop target" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.querySelector('output').textContent='drag:' + event.isTrusted">Drop target</button>
      <input type="file" aria-label="Files" onchange="document.querySelector('output').textContent=this.files[0]?.name || ''" />
      <canvas width="40" height="20" style="display:block;width:80px;height:40px" onclick="document.querySelector('output').textContent='canvas:' + event.isTrusted"></canvas>
      <iframe title="Same origin frame" src="/same-frame"></iframe>
      <iframe title="Cross origin frame" src="http://localhost:${port}/frame?frame_token=frame-secret"></iframe>
      <div id="shadow"></div><output>ready</output>
      <script src="/console-script?console_token=console-secret"></script>
      <script>
        const root = document.querySelector('#shadow').attachShadow({ mode: 'open' });
        root.innerHTML = '<button aria-label="Shadow action">Shadow action</button>';
        root.querySelector('button').onclick = event => { const trusted = event.isTrusted; fetch('/settle').then(() => { root.querySelector('button').textContent = 'Shadow settled:5:' + trusted; }); };
        document.addEventListener('keydown', event => { if (event.ctrlKey && event.key.toLowerCase() === 'k') document.querySelector('output').textContent = 'shortcut:' + event.isTrusted; });
        console.error('v2 diagnostic marker'); fetch('/diagnostic-error?access_token=diagnostic-secret').catch(() => {});
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
    const browser = new BrowserHost(window, downloadsRoot, statePath, {
      recordingDurationMs: 500,
      recordingMaxConcurrent: 1,
      recordingMaxAggregateBytes: 100 * 1024 * 1024,
    });
    await browser.setVisible({ visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });
    const documentChangedTabs: string[] = [];
    const retainedDocumentChanges: Array<{ tabId: string; documentIds: ReadonlySet<string> }> = [];
    browser.onDocumentChanged((tabId, documentIds) => {
      documentChangedTabs.push(tabId);
      retainedDocumentChanges.push({ tabId, documentIds });
    });
    let changedEventCount = 0;
    browser.onChanged(() => {
      changedEventCount += 1;
    });

    const controlPhases: string[] = [];
    const controlledTabIds: Array<string | null> = [];
    const observedControlActions: string[] = [];
    browser.onControlChanged((state) => {
      observedControlActions.push(...state.sessions.map((session) => session.action));
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
    await browser.setVisible({ visible: true, bounds: { x: 0, y: 0, width: 760, height: 560 } });
    const resizedFillViewport = browser.listTabs().find((candidate) => candidate.id === tab.id)?.environment?.viewport;
    if (resizedFillViewport?.width !== 760 || resizedFillViewport?.height !== 560) {
      throw new Error("Browser fill-mode status did not use the current panel bounds.");
    }
    await browser.setVisible({ visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });
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
    if (!v2Elements.some((element) => element.name === "Same-origin action")) {
      throw new Error("V2 snapshot did not include a same-origin iframe control.");
    }
    const sameOriginClick = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Same-origin action", exact: true },
    });
    if (!sameOriginClick.success || !String(toolTextPayload(sameOriginClick)?.text).includes("Same-origin:true")) {
      throw new Error(`V2 same-origin iframe click failed: ${toolError(sameOriginClick)}`);
    }
    const sameOriginSelect = await callBrowserTool(browser, "select_option", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "combobox", name: "Same-origin mode", exact: true },
      values: ["b"],
    });
    const sameOriginSelection = await v2Contents.executeJavaScript(
      `(() => { const select = document.querySelector('iframe[title="Same origin frame"]').contentDocument.querySelector('[aria-label="Same-origin mode"]'); return { value: select.value, inputTrusted: select.dataset.inputTrusted, changeTrusted: select.dataset.changeTrusted }; })()`,
      true,
    );
    if (
      !sameOriginSelect.success ||
      !isDynamicRecord(sameOriginSelection) ||
      sameOriginSelection.value !== "b" ||
      sameOriginSelection.inputTrusted !== "true" ||
      sameOriginSelection.changeTrusted !== "true"
    ) {
      throw new Error(`V2 same-origin iframe select failed: ${toolError(sameOriginSelect)}`);
    }
    const sameOriginCollisionSelect = await callBrowserTool(browser, "select_option", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "combobox", name: "Same-origin collision", exact: true },
      values: ["target"],
    });
    const sameOriginCollisionSelection = await v2Contents.executeJavaScript(
      `document.querySelector('iframe[title="Same origin frame"]').contentDocument.querySelector('[aria-label="Same-origin collision"]').value`,
      true,
    );
    if (!sameOriginCollisionSelect.success || sameOriginCollisionSelection !== "target") {
      throw new Error(`V2 select did not prefer an exact value match: ${toolError(sameOriginCollisionSelect)}`);
    }
    const ambiguousOption = await callBrowserTool(browser, "select_option", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "combobox", name: "Same-origin collision", exact: true },
      values: ["Second"],
    });
    if (ambiguousOption.success || !toolError(ambiguousOption).includes("ambiguous")) {
      throw new Error("V2 select accepted an ambiguous option label.");
    }
    const laterDuplicateLabel = await callBrowserTool(browser, "select_option", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "combobox", name: "Same-origin collision", exact: true },
      values: ["third"],
    });
    const laterDuplicateSelection = await v2Contents.executeJavaScript(
      `(() => { const select = document.querySelector('iframe[title="Same origin frame"]').contentDocument.querySelector('[aria-label="Same-origin collision"]'); return { value: select.value, labels: Array.from(select.options, option => option.label), text: Array.from(select.options, option => option.text) }; })()`,
      true,
    );
    if (
      !laterDuplicateLabel.success ||
      !isDynamicRecord(laterDuplicateSelection) ||
      laterDuplicateSelection.value !== "third" ||
      !Array.isArray(laterDuplicateSelection.labels) ||
      laterDuplicateSelection.labels.join(",") !== "target,Second,Second" ||
      !Array.isArray(laterDuplicateSelection.text) ||
      laterDuplicateSelection.text.join(",") !== "target,Second,Second"
    ) {
      throw new Error(`V2 select could not choose a later duplicate label: ${toolError(laterDuplicateLabel)}`);
    }
    const sameOriginMultiSelect = await callBrowserTool(browser, "select_option", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "listbox", name: "Same-origin tags", exact: true },
      values: ["b", "c"],
    });
    const sameOriginMultiSelection = await v2Contents.executeJavaScript(
      `(() => { const select = document.querySelector('iframe[title="Same origin frame"]').contentDocument.querySelector('[aria-label="Same-origin tags"]'); return { values: Array.from(select.selectedOptions, option => option.value), inputTrusted: select.dataset.inputTrusted, changeTrusted: select.dataset.changeTrusted }; })()`,
      true,
    );
    if (
      !sameOriginMultiSelect.success ||
      !isDynamicRecord(sameOriginMultiSelection) ||
      !Array.isArray(sameOriginMultiSelection.values) ||
      sameOriginMultiSelection.values.join(",") !== "b,c" ||
      sameOriginMultiSelection.inputTrusted !== "true" ||
      sameOriginMultiSelection.changeTrusted !== "true"
    ) {
      throw new Error(`V2 same-origin iframe multi-select failed: ${toolError(sameOriginMultiSelect)}`);
    }
    const outOfOrderMultiSelect = await callBrowserTool(browser, "select_option", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "listbox", name: "Same-origin tags", exact: true },
      values: ["c", "a"],
    });
    const outOfOrderMultiSelection = await v2Contents.executeJavaScript(
      `Array.from(document.querySelector('iframe[title="Same origin frame"]').contentDocument.querySelector('[aria-label="Same-origin tags"]').selectedOptions, option => option.value)`,
      true,
    );
    if (
      !outOfOrderMultiSelect.success ||
      !Array.isArray(outOfOrderMultiSelection) ||
      outOfOrderMultiSelection.join(",") !== "a,c"
    ) {
      throw new Error(`V2 multi-select depended on request order: ${toolError(outOfOrderMultiSelect)}`);
    }
    const sameOriginRadio = await callBrowserTool(browser, "set_checked", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "radio", name: "Same-origin primary choice", exact: true },
      checked: false,
    });
    if (sameOriginRadio.success || !toolError(sameOriginRadio).includes("cannot be cleared directly")) {
      throw new Error("V2 same-origin iframe radio used the wrong DOM realm.");
    }
    const sameOriginTyped = await callBrowserTool(browser, "type", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "textbox", name: "Same-origin field", exact: true },
      text: "b",
      mode: "append",
    });
    const sameOriginValue = await v2Contents.executeJavaScript(
      `document.querySelector('iframe[title="Same origin frame"]').contentDocument.querySelector('input[aria-label="Same-origin field"]').value`,
      true,
    );
    if (!sameOriginTyped.success || sameOriginValue !== "ab") {
      throw new Error(`V2 same-origin iframe typing failed: ${toolError(sameOriginTyped)}`);
    }
    await v2Contents.executeJavaScript(`document.querySelector('iframe[title="Same origin frame"]').remove()`, true);
    await v2Contents.executeJavaScript(
      `(() => {
        const container = document.createElement('div');
        container.dataset.rejectedCandidateNoise = '';
        container.innerHTML = Array.from({ length: 250 }, () => '<input type="color" aria-label="Unsupported color input" />').join('') +
          '<button aria-label="Action after rejected candidates">Action after rejected candidates</button>';
        document.body.appendChild(container);
      })()`,
      true,
    );
    const rejectedCandidateSnapshot = await browser.snapshot(v2Tab.id);
    if (!rejectedCandidateSnapshot.elements.some((element) => element.name === "Action after rejected candidates")) {
      throw new Error("V2 rejected candidates consumed the actionable-element limit.");
    }
    await v2Contents.executeJavaScript(`document.querySelector('[data-rejected-candidate-noise]').remove()`, true);
    const shadowClick = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Shadow action", exact: true },
      timeoutMs: 30_000,
    });
    if (!shadowClick.success || !String(toolTextPayload(shadowClick)?.text).includes("Shadow settled:5:true")) {
      throw new Error(`V2 shadow DOM settling failed: ${toolError(shadowClick)}`);
    }
    const frameClick = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Frame action", exact: true },
      timeoutMs: 30_000,
    });
    const frameClickSnapshot = toolTextPayload(frameClick);
    if (!frameClick.success || !String(frameClickSnapshot?.text).includes("Frame settled:5:true")) {
      throw new Error(`V2 cross-origin iframe click failed: ${toolError(frameClick)}`);
    }
    await v2Contents.executeJavaScript(
      `(async () => {
        const container = document.createElement('div');
        container.dataset.manyOopifs = '';
        document.body.append(container);
        for (let index = 0; index < 12; index++) {
          const frame = document.createElement('iframe');
          const label = index === 11 ? 'Frame action' : 'OOPIF noise ' + index;
          const fileLabel = index === 11 ? 'Late OOPIF files' : 'OOPIF files ' + index;
          frame.src = 'http://localhost:${address.port}/frame?action_label=' + encodeURIComponent(label) + '&file_label=' + encodeURIComponent(fileLabel);
          container.append(frame);
          await new Promise(loaded => { frame.onload = loaded; });
        }
        return true;
      })()`,
      true,
    );
    const manyFrameAmbiguity = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Frame action", exact: true },
      timeoutMs: 30_000,
    });
    if (manyFrameAmbiguity.success || !toolError(manyFrameAmbiguity).includes("Candidates:")) {
      throw new Error("V2 semantic locator inferred uniqueness after truncating attached OOPIF targets.");
    }
    const manyFrameCssAmbiguity = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "css", selector: '[aria-label="Frame action"]' },
      timeoutMs: 30_000,
    });
    if (manyFrameCssAmbiguity.success || !toolError(manyFrameCssAmbiguity).includes("CSS selector is ambiguous")) {
      throw new Error("V2 CSS locator inferred uniqueness after truncating attached OOPIF targets.");
    }
    const lateFrameUploadPath = join(temporaryRoot, "late-oopif-upload.txt");
    await writeFile(lateFrameUploadPath, "late OOPIF upload fixture");
    let lateFrameDocumentId = "";
    const lateFrameUpload = await callBrowserTool(
      browser,
      "upload_files",
      {
        tabId: v2Tab.id,
        target: { kind: "role", role: "button", name: "Late OOPIF files", exact: true },
        paths: [lateFrameUploadPath],
      },
      { onUploadAssigned: (_inputId, documentId) => (lateFrameDocumentId = documentId) },
    );
    if (!lateFrameUpload.success || !lateFrameDocumentId) {
      throw new Error(`V2 late OOPIF upload failed: ${toolError(lateFrameUpload)}`);
    }
    const retainedChangesBeforeNavigation = retainedDocumentChanges.length;
    await v2Contents.executeJavaScript(
      `(() => {
        const frame = document.querySelector('[data-many-oopifs] iframe');
        frame.src = 'http://localhost:${address.port}/frame?action_label=Navigated+OOPIF';
        return true;
      })()`,
      true,
    );
    await waitFor(async () =>
      retainedDocumentChanges
        .slice(retainedChangesBeforeNavigation)
        .some((change) => change.tabId === v2Tab.id && change.documentIds.has(lateFrameDocumentId)),
    );
    await v2Contents.executeJavaScript("document.querySelector('[data-many-oopifs]').remove(); true", true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const frameTextWait = await callBrowserTool(browser, "wait_for", {
      tabId: v2Tab.id,
      text: "Frame settled:5:true",
      timeoutMs: 2_000,
    });
    if (!frameTextWait.success) throw new Error(`V2 iframe text wait failed: ${toolError(frameTextWait)}`);
    const legacyFrameSnapshot = await browser.snapshot(v2Tab.id);
    const legacyFrameField = legacyFrameSnapshot.elements.find((element) => element.name === "Frame field");
    if (!legacyFrameField) throw new Error("V2 legacy iframe submit target was not available.");
    const legacyFrameSubmitted = await browser.act(v2Tab.id, legacyFrameSnapshot.revision, {
      type: "type",
      ref: legacyFrameField.ref,
      text: "legacy iframe input",
      submit: true,
    });
    if (!legacyFrameSubmitted.text.includes("Frame key:true")) {
      throw new Error("V2 legacy iframe submit used the wrong CDP session.");
    }
    const frameTyped = await callBrowserTool(browser, "type", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "textbox", name: "Frame field", exact: true },
      text: "iframe input",
      submit: true,
    });
    if (
      !frameTyped.success ||
      !String(toolTextPayload(frameTyped)?.text).includes("Frame input:iframe input:true|Frame key:true")
    ) {
      throw new Error(`V2 iframe text input used the wrong CDP session: ${toolError(frameTyped)}`);
    }
    const frameTypedActions = toolTextPayload(frameTyped)?.actions;
    if (
      !Array.isArray(frameTypedActions) ||
      !frameTypedActions.some(
        (entry) => isDynamicRecord(entry) && entry.action === "type" && entry.outcome === "success",
      )
    ) {
      throw new Error("V2 action snapshot omitted the action that produced it.");
    }
    const framePressed = await callBrowserTool(browser, "press", {
      tabId: v2Tab.id,
      target: { kind: "css", selector: 'input[aria-label="Frame field"]' },
      key: "Enter",
    });
    if (!framePressed.success || !String(toolTextPayload(framePressed)?.text).includes("Frame key:true")) {
      throw new Error(`V2 iframe key input used the wrong CDP session: ${toolError(framePressed)}`);
    }
    const documentChangesBeforeFrameNavigation = documentChangedTabs.length;
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
    await waitFor(async () => documentChangedTabs.slice(documentChangesBeforeFrameNavigation).includes(v2Tab.id));
    const staleFrameClick = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "ref", ref: String(staleFrameTarget.ref), revision: staleFrameRevision },
    });
    if (staleFrameClick.success || !toolError(staleFrameClick).includes("Stale browser reference")) {
      throw new Error("V2 iframe navigation did not invalidate revision-bound references.");
    }
    const semanticChangeSnapshot = await browser.snapshot(v2Tab.id);
    const semanticChangeTarget = semanticChangeSnapshot.elements.find((element) => element.name === "SPA");
    if (!semanticChangeTarget) throw new Error("V2 semantic-change stale-reference fixture was not available.");
    await v2Contents.executeJavaScript(
      `document.querySelector('[aria-label="SPA"]').setAttribute('aria-label', 'Delete'); true`,
      true,
    );
    const semanticChangeClick = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "ref", ref: semanticChangeTarget.ref, revision: semanticChangeSnapshot.revision },
    });
    if (semanticChangeClick.success || !toolError(semanticChangeClick).includes("target changed")) {
      throw new Error("V2 revision-bound ref accepted a target whose semantics changed after the snapshot.");
    }
    await v2Contents.executeJavaScript(
      `document.querySelector('[aria-label="Delete"]').setAttribute('aria-label', 'SPA'); true`,
      true,
    );
    await browser.snapshot(v2Tab.id);
    const noDomRefs = await v2Contents.executeJavaScript("document.querySelector('[data-openbot-ref]') === null", true);
    if (noDomRefs !== true) throw new Error("V2 snapshot mutated the page DOM.");
    const selected = await callBrowserTool(browser, "select_option", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "combobox", name: "Mode", exact: true },
      values: ["b"],
    });
    if (!selected.success) throw new Error(`V2 select failed: ${toolError(selected)}`);
    const selectionValue = await v2Contents.executeJavaScript(
      `(() => { const select = document.querySelector('[aria-label="Mode"]'); return { value: select.value, inputTrusted: select.dataset.inputTrusted, changeTrusted: select.dataset.changeTrusted }; })()`,
      true,
    );
    if (
      !isDynamicRecord(selectionValue) ||
      selectionValue.value !== "b" ||
      selectionValue.inputTrusted !== "true" ||
      selectionValue.changeTrusted !== "true"
    ) {
      throw new Error("V2 select did not use trusted native input.");
    }
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
    const nonCheckable = await callBrowserTool(browser, "set_checked", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "spinbutton", name: "Quantity", exact: true },
      checked: false,
    });
    if (nonCheckable.success || !toolError(nonCheckable).includes("not checkable")) {
      throw new Error("V2 set_checked accepted a non-checkable input.");
    }
    const contentEditable = await callBrowserTool(browser, "type", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "textbox", name: "Notes", exact: true },
      text: "editable text",
      mode: "replace",
    });
    if (!contentEditable.success) throw new Error(`V2 contenteditable typing failed: ${toolError(contentEditable)}`);
    const appendedContentEditable = await callBrowserTool(browser, "type", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "textbox", name: "Notes", exact: true },
      text: " appended",
      mode: "append",
    });
    if (!appendedContentEditable.success) {
      throw new Error(`V2 contenteditable append failed: ${toolError(appendedContentEditable)}`);
    }
    const editableValue = await v2Contents.executeJavaScript(
      "document.querySelector('[contenteditable]').textContent",
      true,
    );
    if (editableValue !== "editable text appended") {
      throw new Error("V2 contenteditable target did not receive text.");
    }
    const appendedNumber = await callBrowserTool(browser, "type", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "spinbutton", name: "Quantity", exact: true },
      text: "3",
      mode: "append",
    });
    const numberValue = await v2Contents.executeJavaScript(
      "document.querySelector('[aria-label=\"Quantity\"]').value",
      true,
    );
    if (!appendedNumber.success || numberValue !== "123") {
      throw new Error(`V2 number append did not use a trusted end-key fallback: ${toolError(appendedNumber)}`);
    }
    const shortcut = await callBrowserTool(browser, "press", { tabId: v2Tab.id, key: "Control+k" });
    if (!shortcut.success) throw new Error(`V2 keyboard shortcut failed: ${toolError(shortcut)}`);
    const shortcutValue = await v2Contents.executeJavaScript("document.querySelector('output').textContent", true);
    if (shortcutValue !== "shortcut:true") {
      throw new Error("V2 keyboard shortcut was not a trusted page event.");
    }
    const pointPress = await callBrowserTool(browser, "press", {
      tabId: v2Tab.id,
      target: { kind: "point", x: 1, y: 1 },
      key: "Enter",
    });
    if (pointPress.success || !toolError(pointPress).includes("element target")) {
      throw new Error("V2 press silently accepted a point target.");
    }
    await v2Contents.executeJavaScript("document.querySelector('output').textContent = ''", true);
    const invalidShortcut = await callBrowserTool(browser, "press", { tabId: v2Tab.id, key: "Control+💥" });
    if (invalidShortcut.success || !toolError(invalidShortcut).includes("Unsupported browser key")) {
      throw new Error("V2 invalid shortcut did not return a validation error.");
    }
    const plainKey = await callBrowserTool(browser, "press", { tabId: v2Tab.id, key: "k" });
    if (!plainKey.success) throw new Error(`V2 plain key failed after an invalid shortcut: ${toolError(plainKey)}`);
    const outputAfterInvalidShortcut = await v2Contents.executeJavaScript(
      "document.querySelector('output').textContent",
      true,
    );
    if (outputAfterInvalidShortcut === "shortcut:true") {
      throw new Error("V2 invalid shortcut left Control pressed.");
    }
    await v2Contents.executeJavaScript(
      "document.body.appendChild(Object.assign(document.createElement('button'), { ariaLabel: 'Expired click', onclick: () => { document.querySelector('output').textContent = 'expired-click-ran'; } })); document.querySelector('output').textContent = 'expired-click-idle'; true",
      true,
    );
    const expiredClick = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Expired click", exact: true },
      timeoutMs: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const expiredClickOutput = await v2Contents.executeJavaScript("document.querySelector('output').textContent", true);
    if (
      expiredClick.success ||
      !toolError(expiredClick).includes("timed out") ||
      expiredClickOutput !== "expired-click-idle"
    ) {
      throw new Error("V2 timed-out click continued and dispatched input after reporting failure.");
    }
    const ambiguous = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Duplicate", exact: true },
    });
    if (ambiguous.success || !toolError(ambiguous).includes("Candidates:")) {
      throw new Error("V2 semantic locator did not reject an ambiguous target.");
    }
    await v2Contents.executeJavaScript(
      `(() => {
        const container = document.createElement('div');
        container.dataset.semanticScanLimit = '';
        const first = document.createElement('button');
        first.setAttribute('aria-label', 'Bounded semantic duplicate');
        container.append(first);
        container.append(...Array.from({ length: 450 }, (_, index) => {
          const button = document.createElement('button');
          button.setAttribute('aria-label', 'Unrelated semantic control ' + index);
          return button;
        }));
        const second = document.createElement('button');
        second.setAttribute('aria-label', 'Bounded semantic duplicate');
        container.append(second);
        document.body.append(container);
      })()`,
      true,
    );
    const boundedSemantic = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Bounded semantic duplicate", exact: true },
    });
    if (boundedSemantic.success || !toolError(boundedSemantic).includes("Candidates:")) {
      throw new Error("V2 semantic locator inferred uniqueness from a truncated snapshot candidate set.");
    }
    await v2Contents.executeJavaScript("document.querySelector('[data-semantic-scan-limit]').remove(); true", true);
    const visibleTextTarget = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "text", text: "Unique action text", exact: true },
    });
    if (!visibleTextTarget.success || !String(toolTextPayload(visibleTextTarget)?.text).includes("visible-text:true")) {
      throw new Error(
        `V2 visible-text locator ignored text overridden by an accessible name: ${toolError(visibleTextTarget)}`,
      );
    }
    const ambiguousCss = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "css", selector: 'button[aria-label="Duplicate"]' },
    });
    if (ambiguousCss.success || !toolError(ambiguousCss).includes("CSS selector is ambiguous")) {
      throw new Error("V2 CSS locator did not reject an ambiguous target.");
    }
    await v2Contents.executeJavaScript(
      `(() => {
        const container = document.createElement('div');
        container.dataset.cssScanLimit = '';
        const first = document.createElement('button');
        first.dataset.boundedCssCollision = '';
        container.append(first);
        container.append(...Array.from({ length: 10_050 }, () => document.createElement('span')));
        const second = document.createElement('button');
        second.dataset.boundedCssCollision = '';
        container.append(second);
        document.body.append(container);
      })()`,
      true,
    );
    const boundedCss = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "css", selector: "[data-bounded-css-collision]" },
    });
    if (boundedCss.success || !toolError(boundedCss).includes("uniqueness scan exceeded")) {
      throw new Error("V2 CSS locator treated a truncated uniqueness scan as a unique match.");
    }
    await v2Contents.executeJavaScript("document.querySelector('[data-css-scan-limit]').remove(); true", true);
    const covered = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Covered", exact: true },
    });
    if (covered.success || !toolError(covered).includes("covered by")) {
      throw new Error("V2 hit testing did not identify a covering page layer.");
    }
    const coveredHover = await callBrowserTool(browser, "hover", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Covered", exact: true },
    });
    if (coveredHover.success || !toolError(coveredHover).includes("covered by")) {
      throw new Error("V2 hover reported success for a covered target.");
    }
    const coveredDrag = await callBrowserTool(browser, "drag", {
      tabId: v2Tab.id,
      source: { kind: "role", role: "button", name: "Drag source", exact: true },
      target: { kind: "role", role: "button", name: "Covered", exact: true },
    });
    if (coveredDrag.success || !toolError(coveredDrag).includes("covered by")) {
      throw new Error("V2 drag reported success for a covered destination.");
    }
    const partiallyCovered = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Partially covered", exact: true },
    });
    if (!partiallyCovered.success || !String(toolTextPayload(partiallyCovered)?.text).includes("partial:true")) {
      throw new Error(`V2 hit testing did not use a visible target point: ${toolError(partiallyCovered)}`);
    }
    await v2Contents.executeJavaScript(
      "document.body.appendChild(Object.assign(document.createElement('button'), { ariaLabel: 'Fresh target', textContent: 'Fresh target', onclick: event => { document.querySelector('output').textContent = 'fresh:' + event.isTrusted; } })); true",
      true,
    );
    const freshTarget = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Fresh target", exact: true },
    });
    if (!freshTarget.success || !String(toolTextPayload(freshTarget)?.text).includes("fresh:true")) {
      throw new Error(`V2 semantic target did not refresh before the action: ${toolError(freshTarget)}`);
    }
    const point = await v2Contents.executeJavaScript(
      "(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
      true,
    );
    if (!isDynamicRecord(point)) throw new Error("V2 canvas coordinates were not serializable.");
    const canvasClick = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "point", x: point.x, y: point.y },
    });
    if (!canvasClick.success) throw new Error(`V2 coordinate click failed: ${toolError(canvasClick)}`);
    const canvasValue = await v2Contents.executeJavaScript("document.querySelector('output').textContent", true);
    if (canvasValue !== "canvas:true") {
      throw new Error("V2 canvas coordinate click was not trusted.");
    }
    const offViewportClick = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "point", x: 10_000, y: 10_000 },
    });
    if (offViewportClick.success || !toolError(offViewportClick).includes("outside the current viewport")) {
      throw new Error("V2 click accepted an off-viewport point target.");
    }
    const dragged = await callBrowserTool(browser, "drag", {
      tabId: v2Tab.id,
      source: { kind: "role", role: "button", name: "Drag source", exact: true },
      target: { kind: "role", role: "button", name: "Drop target", exact: true },
    });
    if (!dragged.success) throw new Error(`V2 drag failed: ${toolError(dragged)}`);
    const dragValue = await v2Contents.executeJavaScript("document.querySelector('output').textContent", true);
    if (dragValue !== "drag:true") {
      const dragDiagnostics = await v2Contents.executeJavaScript(
        `(() => ({
          output: document.querySelector('output').textContent,
          source: document.querySelector('[aria-label="Drag source"]').getBoundingClientRect().toJSON(),
          target: document.querySelector('[aria-label="Drop target"]').getBoundingClientRect().toJSON(),
          scrollY,
          viewport: { width: innerWidth, height: innerHeight },
        }))()`,
        true,
      );
      throw new Error(`V2 drag did not produce a trusted drop event: ${JSON.stringify(dragDiagnostics)}`);
    }
    const spaClick = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "SPA", exact: true },
    });
    if (!spaClick.success) throw new Error(`V2 SPA click failed: ${toolError(spaClick)}`);
    const spaWait = await callBrowserTool(browser, "wait_for", { tabId: v2Tab.id, text: "SPA done", timeoutMs: 2_000 });
    if (!spaWait.success) throw new Error(`V2 event wait failed: ${toolError(spaWait)}`);
    await v2Contents.executeJavaScript(
      "setTimeout(() => { const button = document.createElement('button'); button.setAttribute('aria-label', 'Late action'); document.body.append(button); }, 100); true",
      true,
    );
    const semanticWait = await callBrowserTool(browser, "wait_for", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "button", name: "Late action", exact: true },
      timeoutMs: 2_000,
    });
    if (!semanticWait.success) throw new Error(`V2 semantic wait failed: ${toolError(semanticWait)}`);
    await v2Contents.executeJavaScript(
      "document.body.appendChild(Object.assign(document.createElement('h2'), { ariaLabel: 'Ready heading' })); true",
      true,
    );
    const nonActionableRoleWait = await callBrowserTool(browser, "wait_for", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "heading", name: "Ready heading", exact: true },
      timeoutMs: 2_000,
    });
    if (!nonActionableRoleWait.success) {
      throw new Error(`V2 non-actionable ARIA role wait failed: ${toolError(nonActionableRoleWait)}`);
    }
    const nonActionableRoleClick = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "role", role: "heading", name: "Ready heading", exact: true },
    });
    if (nonActionableRoleClick.success || !toolError(nonActionableRoleClick).includes("No element matches")) {
      throw new Error("V2 action targeting accepted a non-actionable ARIA role.");
    }
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
    await v2Contents.executeJavaScript(
      "(() => { const container = Object.assign(document.createElement('div'), { innerHTML: Array.from({ length: 200 }, (_, index) => '<button aria-label=\"Bulk ' + index + '\">Bulk ' + index + '</button>').join('') }); container.dataset.bulkTargets = ''; document.body.appendChild(container); return true; })()",
      true,
    );
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
    await v2Contents.executeJavaScript("document.querySelector('[data-bulk-targets]').remove(); true", true);
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
    const boundedActionPoint = await v2Contents.executeJavaScript(
      `(() => {
        const bounds = document.querySelector('[aria-label="SPA"]').getBoundingClientRect();
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      })()`,
      true,
    );
    if (!isDynamicRecord(boundedActionPoint) || !isNumber(boundedActionPoint.x) || !isNumber(boundedActionPoint.y)) {
      throw new Error("V2 bounded action point fixture was not available.");
    }
    await v2Contents.executeJavaScript(
      "globalThis.__openbotNoise = setInterval(() => document.querySelector('output').toggleAttribute('data-noise'), 10); true",
      true,
    );
    const actionTimeoutStarted = Date.now();
    const boundedAction = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "point", x: boundedActionPoint.x, y: boundedActionPoint.y },
      timeoutMs: 250,
    });
    const boundedActionPayload = toolTextPayload(boundedAction);
    if (
      !boundedAction.success ||
      !Array.isArray(boundedActionPayload?.actions) ||
      !boundedActionPayload.actions.some(
        (entry) => isDynamicRecord(entry) && String(entry.detail).includes("Action completed"),
      ) ||
      Date.now() - actionTimeoutStarted > 1_000
    ) {
      throw new Error("V2 dispatched action did not report success when settling exceeded its deadline.");
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
    if (quietWait.success || !toolError(quietWait).includes("timed out")) {
      throw new Error("V2 DOM-quiet wait suppressed its timeout.");
    }
    const activeObservers = await v2Contents.executeJavaScript("globalThis.__openbotActiveObservers", true);
    if (activeObservers !== 0) throw new Error("V2 DOM-quiet timeout left a MutationObserver active.");
    await v2Contents.executeJavaScript(
      "globalThis.MutationObserver = globalThis.__openbotOriginalMutationObserver; globalThis.setTimeout = globalThis.__openbotOriginalSetTimeout; delete globalThis.__openbotOriginalMutationObserver; delete globalThis.__openbotOriginalSetTimeout; delete globalThis.__openbotActiveObservers;",
      true,
    );
    await v2Contents.executeJavaScript(
      "clearInterval(globalThis.__openbotNoise); delete globalThis.__openbotNoise; true",
      true,
    );
    await v2Contents.executeJavaScript(
      "globalThis.__openbotSlowNoise = setInterval(() => document.body.toggleAttribute('data-slow-noise'), 10); setTimeout(() => { clearInterval(globalThis.__openbotSlowNoise); delete globalThis.__openbotSlowNoise; }, 1200); true",
      true,
    );
    const patientQuietWait = await callBrowserTool(browser, "wait_for", {
      tabId: v2Tab.id,
      state: "dom-quiet",
      timeoutMs: 2_500,
    });
    if (!patientQuietWait.success) {
      throw new Error(`V2 DOM-quiet wait ignored the requested timeout: ${toolError(patientQuietWait)}`);
    }
    await v2Contents.executeJavaScript(
      "globalThis.__openbotTransient = document.body.appendChild(Object.assign(document.createElement('span'), { textContent: 'transient quiet condition' })); setTimeout(() => { globalThis.__openbotTransient.remove(); delete globalThis.__openbotTransient; }, 100); true",
      true,
    );
    const invalidatedQuietWait = await callBrowserTool(browser, "wait_for", {
      tabId: v2Tab.id,
      text: "transient quiet condition",
      state: "dom-quiet",
      timeoutMs: 800,
    });
    if (invalidatedQuietWait.success || !toolError(invalidatedQuietWait).includes("timed out")) {
      throw new Error(
        `V2 DOM-quiet wait did not recheck its matched text condition: ${toolError(invalidatedQuietWait)}`,
      );
    }
    const evaluated = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression:
        "new Promise(resolve => setTimeout(() => { document.body.dataset.evaluated = 'true'; resolve({ title: document.title, async: true, sandboxed: typeof process === 'undefined' && typeof require === 'undefined' }); }, 25))",
    });
    const evaluatedValue = toolTextPayload(evaluated);
    if (!evaluated.success || evaluatedValue?.async !== true || evaluatedValue.sandboxed !== true) {
      throw new Error(`V2 page evaluation did not return its sandboxed async value: ${toolError(evaluated)}`);
    }
    const evaluatedMutation = await v2Contents.executeJavaScript("document.body.dataset.evaluated", true);
    if (evaluatedMutation !== "true") throw new Error("V2 page evaluation did not run in the main-frame page context.");
    const evaluationSnapshot = await browser.snapshot(v2Tab.id);
    if (!evaluationSnapshot.actions.some((action) => action.action === "evaluate" && action.outcome === "success")) {
      throw new Error("V2 page evaluation was not recorded in browser action history.");
    }
    const thrownEvaluation = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression: "(() => { throw new Error('evaluation-smoke-error'); })()",
    });
    if (thrownEvaluation.success || !toolError(thrownEvaluation).includes("evaluation-smoke-error")) {
      throw new Error("V2 page evaluation did not return a page exception.");
    }
    const unserializableEvaluation = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression: "undefined",
    });
    if (unserializableEvaluation.success || !toolError(unserializableEvaluation).includes("not JSON-serializable")) {
      throw new Error("V2 page evaluation accepted an unserializable result.");
    }
    const oversizedEvaluation = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression: "'x'.repeat(70_000)",
    });
    if (oversizedEvaluation.success || !toolError(oversizedEvaluation).includes("exceeds 64 KB")) {
      throw new Error("V2 page evaluation accepted an oversized result.");
    }
    const evaluationAfterFailure = await callBrowserTool(browser, "evaluate", {
      tabId: v2Tab.id,
      expression: "({ queueRecovered: true })",
    });
    if (!evaluationAfterFailure.success || toolTextPayload(evaluationAfterFailure)?.queueRecovered !== true) {
      throw new Error(`V2 page evaluation left the action queue unusable: ${toolError(evaluationAfterFailure)}`);
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
      target: { kind: "role", role: "button", name: "Files", exact: true },
      paths: [uploadPath],
    });
    if (!uploaded.success) throw new Error(`V2 upload failed: ${toolError(uploaded)}`);
    const frameUploadInputIds: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const frameUpload = await callBrowserTool(
        browser,
        "upload_files",
        {
          tabId: v2Tab.id,
          target: { kind: "css", selector: 'input[aria-label="Frame files"]' },
          paths: [uploadPath],
        },
        { onUploadAssigned: (inputId) => frameUploadInputIds.push(inputId) },
      );
      if (!frameUpload.success) throw new Error(`V2 frame upload failed: ${toolError(frameUpload)}`);
    }
    if (frameUploadInputIds.length !== 2 || frameUploadInputIds[0] !== frameUploadInputIds[1]) {
      throw new Error("V2 frame upload input identity changed between CDP sessions.");
    }
    await browser.setVisible({ visible: true, bounds: { x: 0, y: 0, width: 220, height: 560 } });
    const narrowFillEnvironment = await callBrowserTool(browser, "set_environment", {
      tabId: v2Tab.id,
      preset: "fill",
    });
    const narrowFillSnapshot = toolTextPayload(narrowFillEnvironment);
    if (
      !narrowFillEnvironment.success ||
      !isDynamicRecord(narrowFillSnapshot?.viewport) ||
      narrowFillSnapshot.viewport.mode !== "fill" ||
      narrowFillSnapshot.viewport.width !== 220
    ) {
      throw new Error("V2 fill environment rejected a supported narrow panel.");
    }
    await browser.setVisible({ visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });
    const scaledFillEnvironment = await callBrowserTool(browser, "set_environment", {
      tabId: v2Tab.id,
      preset: "fill",
      deviceScaleFactor: 2,
    });
    const scaledFillSnapshot = toolTextPayload(scaledFillEnvironment);
    if (
      !scaledFillEnvironment.success ||
      !isDynamicRecord(scaledFillSnapshot?.viewport) ||
      scaledFillSnapshot.viewport.mode !== "custom" ||
      scaledFillSnapshot.viewport.deviceScaleFactor !== 2
    ) {
      throw new Error("V2 fill environment reported a device scale factor without applying it.");
    }
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
    const serializedEnvironmentSnapshot = JSON.stringify(environmentSnapshot);
    if (
      serializedEnvironmentSnapshot.includes("diagnostic-secret") ||
      serializedEnvironmentSnapshot.includes("console-secret") ||
      serializedEnvironmentSnapshot.includes("frame-secret")
    ) {
      throw new Error("V2 snapshot metadata exposed URL credentials.");
    }
    const changesBeforeDiagnosticError = changedEventCount;
    const errorsBeforeDiagnosticError =
      browser.listTabs().find((candidate) => candidate.id === v2Tab.id)?.diagnosticErrorCount ?? 0;
    await v2Contents.executeJavaScript("fetch('/diagnostic-error?ui_token=ui-secret'); true", true);
    await waitFor(async () => {
      const currentErrors =
        browser.listTabs().find((candidate) => candidate.id === v2Tab.id)?.diagnosticErrorCount ?? 0;
      return changedEventCount > changesBeforeDiagnosticError && currentErrors > errorsBeforeDiagnosticError;
    });
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
    const preTakeoverSnapshot = await browser.snapshot(v2Tab.id);
    const preTakeoverTarget = preTakeoverSnapshot.elements.find((element) => element.name === "SPA");
    if (!preTakeoverTarget) throw new Error("V2 takeover stale-reference fixture was not available.");
    await browser.beginTakeover(v2Tab.id);
    await v2Contents.executeJavaScript("console.error('takeover-console-secret'); true", true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    browser.endTakeover(v2Tab.id);
    const postTakeoverOldRef = await callBrowserTool(browser, "click", {
      tabId: v2Tab.id,
      target: { kind: "ref", ref: preTakeoverTarget.ref, revision: preTakeoverSnapshot.revision },
    });
    if (postTakeoverOldRef.success || !toolError(postTakeoverOldRef).includes("Stale browser reference")) {
      throw new Error("V2 takeover left a pre-takeover browser reference valid.");
    }
    const postTakeoverSnapshot = await browser.snapshot(v2Tab.id);
    if (JSON.stringify(postTakeoverSnapshot.diagnostics).includes("takeover-console-secret")) {
      throw new Error("V2 takeover exposed console messages captured while the user had control.");
    }
    const racingRecordingStart = callBrowserTool(browser, "recording_start", { tabId: v2Tab.id });
    const racingRecordingStop = callBrowserTool(browser, "recording_stop", { tabId: v2Tab.id });
    const [racingStarted, racingStopped] = await Promise.all([racingRecordingStart, racingRecordingStop]);
    if (
      !racingStarted.success ||
      toolError(racingStopped).includes("not being recorded") ||
      browser.listTabs().find((candidate) => candidate.id === v2Tab.id)?.recording !== false
    ) {
      throw new Error(
        `V2 parallel recording stop did not wait for recording start: start=${toolError(racingStarted)} stop=${toolError(racingStopped)} recording=${browser.listTabs().find((candidate) => candidate.id === v2Tab.id)?.recording}`,
      );
    }
    const recordingStarted = await callBrowserTool(browser, "recording_start", { tabId: v2Tab.id });
    if (
      !recordingStarted.success ||
      browser.listTabs().find((candidate) => candidate.id === v2Tab.id)?.recording !== true
    ) {
      throw new Error(`V2 recording did not start: ${toolError(recordingStarted)}`);
    }
    const concurrentRecording = await callBrowserTool(browser, "recording_start", { tabId: tab.id });
    if (concurrentRecording.success || !toolError(concurrentRecording).includes("At most 1")) {
      throw new Error("V2 recorder did not enforce its concurrent recording limit.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const prematureRecordingRestart = await callBrowserTool(browser, "recording_start", { tabId: v2Tab.id });
    if (prematureRecordingRestart.success || !toolError(prematureRecordingRestart).includes("recording_stop")) {
      throw new Error("V2 recording restart replaced an unclaimed completed artifact.");
    }
    const aggregateRecording = await callBrowserTool(browser, "recording_start", { tabId: tab.id });
    if (aggregateRecording.success || !toolError(aggregateRecording).includes("in total")) {
      throw new Error("V2 recorder did not reserve its aggregate byte budget.");
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
    const { tab: actionNavigationTab, contents: actionNavigationContents } = await openTabWithContents(
      browser,
      origin,
      "smoke-thread",
      "smoke-bot",
    );
    await actionNavigationContents.executeJavaScript(
      `(() => { const button = document.createElement('button'); button.setAttribute('aria-label', 'Slow action navigation'); button.onclick = () => { location.href = ${JSON.stringify(`${origin}/slow-document?action`)}; }; document.body.append(button); return true; })()`,
      true,
    );
    const timedActionNavigation = await callBrowserTool(browser, "click", {
      tabId: actionNavigationTab.id,
      target: { kind: "role", role: "button", name: "Slow action navigation", exact: true },
      timeoutMs: 100,
    });
    const timedActionPayload = toolTextPayload(timedActionNavigation);
    if (
      !timedActionNavigation.success ||
      !Array.isArray(timedActionPayload?.actions) ||
      !timedActionPayload.actions.some(
        (entry) => isDynamicRecord(entry) && String(entry.detail).includes("Action completed"),
      )
    ) {
      throw new Error("V2 action-triggered navigation did not accurately report a dispatched timed action.");
    }
    const snapshotAfterTimedAction = await callBrowserTool(browser, "snapshot", { tabId: actionNavigationTab.id });
    if (
      !snapshotAfterTimedAction.success ||
      browser.listTabs().find((candidate) => candidate.id === actionNavigationTab.id)?.loading === true
    ) {
      throw new Error("V2 action-triggered navigation escaped tab serialization.");
    }
    await browser.close(actionNavigationTab.id);
    const { tab: waitTab, contents: waitContents } = await openTabWithContents(
      browser,
      origin,
      "smoke-thread",
      "smoke-bot",
    );
    const beforeNavigation = await browser.snapshot(waitTab.id);
    const staleNavigationTarget = beforeNavigation.elements.find((element) => element.name === "Save");
    if (!staleNavigationTarget) throw new Error("V2 stale-reference test did not find its source target.");
    await waitContents.executeJavaScript(
      `location.href = ${JSON.stringify(`${origin}/slow-document?domcontentloaded`)}; true`,
      true,
    );
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
    const readyState = await waitContents.executeJavaScript("document.readyState", true);
    if (!["interactive", "complete"].includes(String(readyState))) {
      throw new Error("V2 page did not reach a ready state after navigation.");
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
    const { tab: boundedTab, contents: boundedContents } = await openTabWithContents(
      browser,
      origin,
      "smoke-thread",
      "smoke-bot",
    );
    await boundedContents.executeJavaScript(
      "document.body.replaceChildren(Object.assign(document.createElement('textarea'), { ariaLabel: 'Large value', value: 'x'.repeat(5_000) }), ...Array.from({ length: 200 }, (_, index) => Object.assign(document.createElement('div'), { role: 'presentation', tabIndex: 0, textContent: 'Decoration ' + index })), ...Array.from({ length: 200 }, (_, index) => Object.assign(document.createElement('button'), { hidden: true, textContent: 'Hidden ' + index })), Object.assign(document.createElement('div'), { role: 'switch', ariaLabel: 'Bounded switch', textContent: 'Switch' }), ...Array.from({ length: 250 }, (_, index) => Object.assign(document.createElement('button'), { textContent: 'Bounded ' + index }))); true",
      true,
    );
    const boundedSnapshot = await browser.snapshot(boundedTab.id);
    if (boundedSnapshot.elements.length !== 200) {
      throw new Error(`V2 snapshot did not enforce its global element cap: ${boundedSnapshot.elements.length}`);
    }
    if (!boundedSnapshot.elements.some((element) => element.role === "switch" && element.name === "Bounded switch")) {
      throw new Error("V2 snapshot candidate cap hid an actionable ARIA role.");
    }
    const largeValue = boundedSnapshot.elements.find((element) => element.name === "Large value")?.value;
    if (!largeValue || largeValue.length > 2_000 || Buffer.byteLength(JSON.stringify(boundedSnapshot)) > 1024 * 1024) {
      throw new Error("V2 snapshot did not enforce its value and aggregate serialization limits.");
    }
    await browser.close(boundedTab.id);
    const focusSentinel = new BrowserWindow({
      show: false,
      opacity: 0,
      width: 64,
      height: 64,
    });
    await focusSentinel.loadURL("data:text/html,<input autofocus>");
    focusSentinel.show();
    focusSentinel.focus();
    focusSentinel.webContents.focus();
    await waitFor(async () => webContents.getFocusedWebContents() === focusSentinel.webContents);
    const backgroundTab = await browser.open(origin, "smoke-thread", "smoke-bot");
    if (webContents.getFocusedWebContents() !== focusSentinel.webContents) {
      throw new Error("A background browser open stole focus from an unrelated application renderer.");
    }
    const backgroundSnapshot = await browser.snapshot(backgroundTab.id);
    if (webContents.getFocusedWebContents() !== focusSentinel.webContents) {
      throw new Error("A background CDP operation stole focus from an unrelated application renderer.");
    }
    const backgroundSave = backgroundSnapshot.elements.find((element) => element.name === "Save");
    if (!backgroundSave) throw new Error("The background focus fixture did not expose its action.");
    const backgroundAction = await callBrowserTool(browser, "click", {
      tabId: backgroundTab.id,
      target: {
        kind: "ref",
        ref: backgroundSave.ref,
        revision: backgroundSnapshot.revision,
      },
    });
    if (!backgroundAction.success || webContents.getFocusedWebContents() !== focusSentinel.webContents) {
      throw new Error("A background browser action did not restore focus to the unrelated application renderer.");
    }
    await browser.close(backgroundTab.id);
    focusSentinel.destroy();
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
    const invalidToolArguments = [
      ["click", { tabId: tab.id, target: { kind: "point", x: 10, y: 10 }, clickCount: 1.5 }],
      ["click", { tabId: tab.id, target: { kind: "point", x: 10, y: 10 }, modifiers: ["Bogus"] }],
      ["scroll", { tabId: tab.id, deltaY: 100_001 }],
      ["evaluate", { tabId: tab.id, expression: "1", returnByValue: false }],
      ["set_environment", { tabId: tab.id, width: 390.5 }],
    ] as const;
    for (const [tool, argumentsValue] of invalidToolArguments) {
      const invalidResult = await callBrowserTool(browser, tool, argumentsValue);
      if (invalidResult.success || !toolError(invalidResult).includes("Invalid browser tool arguments")) {
        throw new Error(`Dynamic browser tool accepted invalid ${tool} arguments: ${toolError(invalidResult)}`);
      }
    }
    process.stdout.write("BrowserHost: runtime tool argument schemas passed.\n");
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
    const crossAgentClose = await browser.handleDynamicTool({
      threadId: "smoke-thread",
      turnId: "browser-smoke-cross-agent-close-turn",
      callId: "browser-smoke-cross-agent-close-call",
      ownerBotId: "smoke-bot",
      namespace: "openbot_browser",
      tool: "close_tab",
      arguments: { tabId: otherBotTab.id },
    });
    if (crossAgentClose.success || !browser.listTabs().some((candidate) => candidate.id === otherBotTab.id)) {
      throw new Error("Dynamic browser tools closed another agent's tab.");
    }
    const closableToolTab = await browser.open(`${origin}/cookie`, "smoke-thread", "smoke-bot");
    const firstClose = browser.handleDynamicTool({
      threadId: "smoke-thread",
      turnId: "browser-smoke-close-turn-1",
      callId: "browser-smoke-close-call-1",
      ownerBotId: "smoke-bot",
      namespace: "openbot_browser",
      tool: "close_tab",
      arguments: { tabId: closableToolTab.id },
    });
    const repeatedClose = browser.handleDynamicTool({
      threadId: "smoke-thread",
      turnId: "browser-smoke-close-turn-2",
      callId: "browser-smoke-close-call-2",
      ownerBotId: "smoke-bot",
      namespace: "openbot_browser",
      tool: "close_tab",
      arguments: { tabId: closableToolTab.id },
    });
    const closeResults = await Promise.all([firstClose, repeatedClose]);
    if (closeResults.some((result) => !result.success)) {
      throw new Error("Repeated agent tab close was not idempotent.");
    }
    process.stdout.write("BrowserHost: agent tab isolation passed.\n");
    if (!controlPhases.includes("open:acting") || !controlPhases.includes("open:waiting")) {
      throw new Error(`Browser control lifecycle was not reported: ${controlPhases.join(", ")}`);
    }
    if (!observedControlActions.includes("reload")) {
      throw new Error("Browser control reported reload navigation as the wrong legacy action.");
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

async function openTabWithContents(
  browser: BrowserHost,
  url: string,
  ownerThreadId: string,
  ownerBotId?: string,
): Promise<{ tab: Awaited<ReturnType<BrowserHost["open"]>>; contents: WebContents }> {
  const existingIds = new Set(webContents.getAllWebContents().map((contents) => contents.id));
  const tab = await browser.open(url, ownerThreadId, ownerBotId);
  const contents = webContents
    .getAllWebContents()
    .find((candidate) => !existingIds.has(candidate.id) && !candidate.isDestroyed());
  if (!contents) throw new Error(`Browser contents were not created for ${url}.`);
  return { tab, contents };
}

function callBrowserTool(
  browser: BrowserHost,
  tool: string,
  argumentsValue: unknown,
  hooks?: Parameters<BrowserHost["handleDynamicTool"]>[1],
): Promise<DynamicToolResult> {
  browserToolCall += 1;
  return browser.handleDynamicTool(
    {
      threadId: "smoke-thread",
      turnId: `browser-v2-${browserToolCall}`,
      callId: `browser-v2-call-${browserToolCall}`,
      ownerBotId: "smoke-bot",
      namespace: "openbot_browser",
      tool,
      arguments: argumentsValue,
    },
    hooks,
  );
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

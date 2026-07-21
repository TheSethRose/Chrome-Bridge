const HOST_NAME = "dev.sethrose.chrome_bridge";
const PROTOCOL_VERSION = "1.3";

let nativePort;
let hostOnline = false;
let statusBroadcastTimer;
const attachedOwners = new Map();
const networkCaptures = new Map();
const networkCaptureByTab = new Map();
const consoleCaptures = new Map();
const scriptCollectors = new Map();
const eventCollectors = new Map();
const traceCollectors = new Map();
const manualCdpSessions = new Map();
const requestChunks = new Map();
const logViewerPorts = new Set();

chrome.runtime.onInstalled.addListener(connectHost);
chrome.runtime.onStartup.addListener(connectHost);
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
connectHost();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function resolveTab(tabId) {
  if (tabId !== undefined && tabId !== null && tabId !== "") return chrome.tabs.get(Number(tabId));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found");
  return tab;
}

async function attach(tabId, owner) {
  const state = attachedOwners.get(tabId);
  if (state) {
    state.add(owner);
    return;
  }

  const target = (await chrome.debugger.getTargets()).find((candidate) => candidate.tabId === tabId && candidate.attached);
  if (target) throw new Error(`Tab ${tabId} is already attached to DevTools or another debugger client`);
  await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  attachedOwners.set(tabId, new Set([owner]));
}

async function detach(tabId, owner) {
  const owners = attachedOwners.get(tabId);
  if (!owners) return;
  owners.delete(owner);
  if (owners.size) return;
  attachedOwners.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function detachAll(tabId) {
  attachedOwners.delete(tabId);
  const captureId = networkCaptureByTab.get(tabId);
  if (captureId) {
    const capture = networkCaptures.get(captureId);
    if (capture?.timer) clearTimeout(capture.timer);
    networkCaptures.delete(captureId);
    networkCaptureByTab.delete(tabId);
  }
  consoleCaptures.delete(tabId);
  scriptCollectors.delete(tabId);
  eventCollectors.delete(tabId);
  for (const [id, session] of manualCdpSessions) {
    if (session.target.tabId === tabId) manualCdpSessions.delete(id);
  }
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function withDebugger(tabId, owner, callback) {
  await attach(tabId, owner);
  try {
    return await callback({ tabId });
  } finally {
    await detach(tabId, owner);
  }
}

function cdp(target, method, params) {
  return chrome.debugger.sendCommand(target, method, params);
}

function debuggeeKey(target) {
  if (target.tabId !== undefined) return `tab:${target.tabId}`;
  if (target.targetId) return `target:${target.targetId}`;
  if (target.extensionId) return `extension:${target.extensionId}`;
  throw new Error("A tab or debugger target is required");
}

async function withRawDebugger(target, owner, callback) {
  if (target.tabId !== undefined) return withDebugger(target.tabId, owner, callback);
  const existing = (await chrome.debugger.getTargets()).find((candidate) => candidate.id === target.targetId && candidate.attached);
  if (existing) throw new Error(`Target ${target.targetId} is already attached to another debugger client`);
  await chrome.debugger.attach(target, PROTOCOL_VERSION);
  try {
    return await callback(target);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

function connectHost() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    nativePort = undefined;
    return;
  }

  nativePort.onMessage.addListener(handleNativeMessage);
  nativePort.onDisconnect.addListener(() => {
    nativePort = undefined;
    hostOnline = false;
    scheduleStatusBroadcast();
  });
  nativePort.postMessage({ type: "hello" });
}

async function handleNativeMessage(message) {
  if (message?.type === "helloResult") {
    hostOnline = Boolean(message.ok);
    scheduleStatusBroadcast();
    return;
  }
  if (message?.type?.startsWith("log") || message?.type === "logsCleared") {
    for (const port of logViewerPorts) port.postMessage(message);
    return;
  }
  if (message?.type === "requestChunk" && typeof message.id === "string") {
    const chunks = requestChunks.get(message.id) || [];
    chunks[message.index] = message.data;
    requestChunks.set(message.id, chunks);
    return;
  }
  if (message?.type === "requestEnd" && typeof message.id === "string") {
    const chunks = requestChunks.get(message.id) || [];
    requestChunks.delete(message.id);
    const request = JSON.parse(chunks.join(""));
    executeAndRespond(message.id, request.command, request.params || {});
    return;
  }
  if (message?.type !== "request" || typeof message.id !== "string") return;

  executeAndRespond(message.id, message.command, message.params || {});
}

async function executeAndRespond(id, command, params) {
  try {
    const result = await executeCommand(command, params, id);
    sendChunkedResponse(id, { ok: true, result, completedAt: Date.now() });
  } catch (error) {
    sendChunkedResponse(id, { ok: false, error: errorMessage(error), completedAt: Date.now() });
  }
}

function sendChunkedResponse(id, response) {
  const serialized = JSON.stringify(response);
  const chunkSize = 4_000_000;
  nativePort?.postMessage({ type: "responseStart", id });
  for (let index = 0, offset = 0; offset < serialized.length; index += 1, offset += chunkSize) {
    nativePort?.postMessage({ type: "responseChunk", id, index, data: serialized.slice(offset, offset + chunkSize) });
  }
  nativePort?.postMessage({ type: "responseEnd", id });
}

async function statusSnapshot() {
  const { auditLog = [] } = await chrome.storage.local.get("auditLog");
  return {
    bridgeOnline: hostOnline,
    nativeConnected: Boolean(nativePort),
    attachedTabs: [...attachedOwners.keys()],
    activeCaptures: [...networkCaptures.values()].map((capture) => ({
      session: capture.id,
      tabId: capture.tabId,
      tabTitle: capture.tabTitle,
      startedAt: new Date(capture.startedAt).toISOString(),
      requests: capture.requests.size,
      webSocketFrames: capture.webSockets.length,
    })),
    cdpSessions: [...manualCdpSessions.values()].map((session) => ({
      session: session.id,
      target: session.target,
      startedAt: new Date(session.startedAt).toISOString(),
    })),
    recentCommands: auditLog.slice(-25).reverse(),
  };
}

function scheduleStatusBroadcast() {
  clearTimeout(statusBroadcastTimer);
  statusBroadcastTimer = setTimeout(async () => {
    const status = await statusSnapshot().catch(() => null);
    if (status) chrome.runtime.sendMessage({ type: "bridge-status-update", status }).catch(() => {});
  }, 50);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const action = message?.type === "bridge-clear-logs"
    ? chrome.storage.local.remove("auditLog").then(() => {
        nativePort?.postMessage({ type: "clearLogs", id: crypto.randomUUID() });
        return statusSnapshot();
      })
    : message?.type === "bridge-status"
      ? statusSnapshot()
      : null;
  if (!action) return false;
  action.then(
    (status) => {
      sendResponse({ ok: true, status });
      scheduleStatusBroadcast();
    },
    (error) => sendResponse({ ok: false, error: errorMessage(error) }),
  );
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "bridge-log-viewer") return;
  logViewerPorts.add(port);
  port.onMessage.addListener((message) => {
    if (message?.type === "readLog" && typeof message.id === "string") nativePort?.postMessage(message);
  });
  port.onDisconnect.addListener(() => logViewerPorts.delete(port));
});

async function audit(id, command, params, tab, status, error) {
  const { auditLog = [] } = await chrome.storage.local.get("auditLog");
  auditLog.push({
    id,
    at: new Date().toISOString(),
    command,
    tabId: tab?.id,
    tabTitle: tab?.title || undefined,
    origin: tab?.url && /^https?:/.test(tab.url) ? new URL(tab.url).origin : undefined,
    options: Object.keys(params).filter((key) => !["text", "expression", "params", "secret"].includes(key)),
    status,
    error: error || undefined,
  });
  await chrome.storage.local.set({ auditLog: auditLog.slice(-25) });
  scheduleStatusBroadcast();
}

async function executeCommand(command, params, requestId) {
  let tab;
  try {
    if (command === "status") return statusSnapshot();
    if (command === "list-tabs") return listTabs();
    if (command === "targets" && params.tab === undefined) return { debuggerTargets: await chrome.debugger.getTargets() };
    if (command === "audit") {
      const { auditLog = [] } = await chrome.storage.local.get("auditLog");
      return auditLog.slice().reverse();
    }

    const targetOnlyCommand = ["cdp-session-start", "cdp-session-stop", "cdp-send", "cdp-events"].includes(command) && params.target;
    tab = targetOnlyCommand ? undefined : await resolveTab(params.tab);
    const owner = `command:${requestId}`;
    let result;

    switch (command) {
      case "activate-tab":
        result = await chrome.tabs.update(tab.id, { active: true });
        break;
      case "new-tab":
        result = await chrome.tabs.create({ url: navigableUrl(params.url || "about:blank"), active: params.active !== false });
        break;
      case "close-tab":
        await chrome.tabs.remove(tab.id);
        result = { closed: true, tabId: tab.id };
        break;
      case "navigate":
        result = await chrome.tabs.update(tab.id, { url: validateUrl(params.url) });
        break;
      case "reload":
        await chrome.tabs.reload(tab.id);
        result = { reloaded: true, tabId: tab.id };
        break;
      case "go-back":
        await chrome.tabs.goBack(tab.id);
        result = { navigated: "back", tabId: tab.id };
        break;
      case "go-forward":
        await chrome.tabs.goForward(tab.id);
        result = { navigated: "forward", tabId: tab.id };
        break;
      case "snapshot":
        result = await accessibilitySnapshot(tab.id, owner, params);
        break;
      case "dom":
        result = await pageDom(tab.id, owner, params);
        break;
      case "visible-text":
        result = await visibleText(tab.id, owner, params);
        break;
      case "screenshot":
        result = await screenshot(tab.id, owner, params);
        break;
      case "eval":
        result = await evaluate(tab, owner, params);
        break;
      case "click":
        result = await click(tab.id, owner, params);
        break;
      case "type":
        result = await typeText(tab.id, owner, params.selector, params.text);
        break;
      case "type-text":
        result = await typeFocused(tab.id, owner, params);
        break;
      case "hover":
        result = await hover(tab.id, owner, params);
        break;
      case "drag":
        result = await drag(tab.id, owner, params);
        break;
      case "press-key":
        result = await pressKey(tab.id, owner, params);
        break;
      case "fill-form":
        result = await fillForm(tab.id, owner, params);
        break;
      case "upload-file":
        result = await uploadFile(tab.id, owner, params);
        break;
      case "wait-for":
        result = await waitForPage(tab.id, owner, params);
        break;
      case "handle-dialog":
        result = await handleDialog(tab.id, owner, params);
        break;
      case "resize":
        result = await resizePage(tab.id, owner, params);
        break;
      case "emulate":
        result = await emulatePage(tab.id, owner, params);
        break;
      case "network-capture":
        result = await captureNetwork(tab.id, params);
        break;
      case "network-start":
        result = await startNetwork(tab.id, params);
        break;
      case "network-tail":
        result = networkSnapshot(findCapture(params.session, tab.id));
        break;
      case "network-stop":
        result = await stopNetwork(findCapture(params.session, tab.id), Boolean(params.har));
        break;
      case "network-get-body":
        result = await networkGetBody(findCapture(params.session, tab.id), params.request, params);
        break;
      case "network-export-har":
        result = await captureNetwork(tab.id, { ...params, har: true });
        break;
      case "console-capture":
        result = await captureConsole(tab.id, owner, params);
        break;
      case "scripts-list":
        result = await listScripts(tab.id, owner, params);
        break;
      case "scripts-get":
        result = await getScript(tab.id, owner, params);
        break;
      case "cookies":
        result = await getCookies(tab, owner, params);
        break;
      case "storage":
        result = await inspectStorage(tab, owner, params);
        break;
      case "resources-tree":
        result = await resourceTree(tab.id, owner);
        break;
      case "resources-get":
        result = await resourceContent(tab.id, owner, params);
        break;
      case "page-mhtml":
        result = await captureMhtml(tab.id, owner, params);
        break;
      case "dom-snapshot":
        result = await domSnapshot(tab.id, owner, params);
        break;
      case "styles":
        result = await inspectStyles(tab.id, owner, params);
        break;
      case "targets":
        result = await inspectTargets(tab.id, owner);
        break;
      case "performance-metrics":
        result = await performanceMetrics(tab.id, owner);
        break;
      case "performance-profile":
        result = await cpuProfile(tab.id, owner, params);
        break;
      case "performance-trace":
        result = await performanceTrace(tab.id, owner, params);
        break;
      case "history-search":
        result = await chrome.history.search({
          text: String(params.query || ""),
          startTime: params.startTime ? Number(params.startTime) : 0,
          maxResults: params.limit === undefined ? 2_147_483_647 : Math.max(1, Number(params.limit)),
        });
        break;
      case "bookmarks-tree":
        result = await chrome.bookmarks.getTree();
        break;
      case "bookmarks-search":
        result = await chrome.bookmarks.search(String(params.query || ""));
        break;
      case "downloads-search":
        result = await chrome.downloads.search({
          query: params.query ? [String(params.query)] : undefined,
          limit: params.limit === undefined ? undefined : Math.max(1, Number(params.limit)),
          orderBy: ["-startTime"],
        });
        break;
      case "cdp-send":
        result = await rawCdp(tab, owner, params);
        break;
      case "cdp-events":
        result = await captureCdpEvents(tab, owner, params);
        break;
      case "cdp-session-start":
        result = await startCdpSession(tab, params);
        break;
      case "cdp-session-stop":
        result = await stopCdpSession(params.bridgeSession);
        break;
      case "detach":
        await detachAll(tab.id);
        result = { detached: true, tabId: tab.id };
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }

    await audit(requestId, command, params, tab, "ok");
    return result;
  } catch (error) {
    await audit(requestId, command, params, tab, "error", errorMessage(error)).catch(() => {});
    throw error;
  }
}

async function listTabs() {
  return (await chrome.tabs.query({})).map((tab) => ({
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    title: tab.title,
    url: tab.url || "",
    attached: Boolean(tab.id && attachedOwners.has(tab.id)),
  }));
}

function navigableUrl(value) {
  const url = String(value || "");
  if (!url) throw new Error("A URL is required");
  return url;
}

async function accessibilitySnapshot(tabId, owner, params) {
  return withDebugger(tabId, owner, async (target) => {
    await cdp(target, "Accessibility.enable");
    const result = await cdp(target, "Accessibility.getFullAXTree", params.depth ? { depth: Number(params.depth) } : undefined);
    return result;
  });
}

async function pageDom(tabId, owner, params) {
  return withDebugger(tabId, owner, async (target) => {
    const expression = "'<!doctype html>\\n' + document.documentElement.outerHTML";
    const result = await cdp(target, "Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "DOM evaluation failed");
    return { html: result.result?.value || "", url: (await chrome.tabs.get(tabId)).url };
  });
}

async function visibleText(tabId, owner, params) {
  return withDebugger(tabId, owner, async (target) => {
    const result = await cdp(target, "Runtime.evaluate", {
      expression: "document.body?.innerText || ''",
      returnByValue: true,
    });
    return { text: result.result?.value || "" };
  });
}

async function screenshot(tabId, owner, params) {
  return withDebugger(tabId, owner, async (target) => {
    await cdp(target, "Page.enable");
    const format = params.format === "jpeg" ? "jpeg" : "png";
    const result = await cdp(target, "Page.captureScreenshot", {
      format,
      quality: format === "jpeg" ? Math.max(1, Math.min(100, Number(params.quality) || 85)) : undefined,
      captureBeyondViewport: params.fullPage !== false,
    });
    return { data: result.data, format, tabId };
  });
}

async function evaluate(tab, owner, params) {
  const expression = String(params.expression || "");
  if (!expression) throw new Error("eval requires an expression");
  return withDebugger(tab.id, owner, async (target) => {
    const options = {
      expression,
      awaitPromise: true,
      returnByValue: true,
    };
    if (params.evalTimeout !== undefined) options.timeout = Math.max(0, Number(params.evalTimeout));
    const result = await cdp(target, "Runtime.evaluate", options);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Evaluation failed");
    return result.result;
  });
}

function checkedSelector(value) {
  const selector = String(value || "");
  if (!selector) throw new Error("A selector is required");
  return selector;
}

async function click(tabId, owner, selectorValue) {
  const selector = checkedSelector(selectorValue);
  return withDebugger(tabId, owner, async (target) => {
    const expression = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Element not found'); el.click(); return {tag: el.tagName, text: el.innerText || el.value || ''}; })()`;
    const result = await cdp(target, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Click failed");
    return result.result?.value;
  });
}

async function typeText(tabId, owner, selectorValue, textValue) {
  const selector = checkedSelector(selectorValue);
  const text = String(textValue ?? "");
  return withDebugger(tabId, owner, async (target) => {
    const expression = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Element not found'); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)}})); el.dispatchEvent(new Event('change', {bubbles: true})); return {tag: el.tagName, length: el.value.length}; })()`;
    const result = await cdp(target, "Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Type failed");
    return result.result?.value;
  });
}

function durationMs(value, fallback = 10_000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function findCapture(sessionId, tabId) {
  const id = sessionId || networkCaptureByTab.get(tabId);
  const capture = networkCaptures.get(id);
  if (!capture || capture.tabId !== tabId) throw new Error("No matching network capture session is active");
  return capture;
}

async function startNetwork(tabId, params = {}) {
  if (networkCaptureByTab.has(tabId)) throw new Error(`Tab ${tabId} already has an active network capture`);
  const id = crypto.randomUUID();
  const tab = await chrome.tabs.get(tabId);
  const capture = {
    id,
    tabId,
    tabTitle: tab.title || tab.url || "Untitled tab",
    owner: `network:${id}`,
    startedAt: Date.now(),
    stoppedAt: null,
    requests: new Map(),
    webSockets: [],
    pending: [],
    includeBodies: Boolean(params.bodies),
    urlFilter: String(params.urlFilter || "").toLowerCase(),
    sessions: new Set(),
  };
  await attach(tabId, capture.owner);
  try {
    await cdp({ tabId }, "Network.enable");
    await cdp({ tabId }, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  } catch (error) {
    await detach(tabId, capture.owner);
    throw error;
  }
  if (params.maxDuration !== undefined) capture.timer = setTimeout(() => finishNetwork(capture).catch(() => {}), durationMs(params.maxDuration));
  networkCaptures.set(id, capture);
  networkCaptureByTab.set(tabId, id);
  scheduleStatusBroadcast();
  return { session: id, tabId, startedAt: new Date(capture.startedAt).toISOString(), maxDurationMs: params.maxDuration === undefined ? null : durationMs(params.maxDuration) };
}

async function captureNetwork(tabId, params = {}) {
  const started = await startNetwork(tabId, { ...params, maxDuration: durationMs(params.duration) });
  const capture = networkCaptures.get(started.session);
  await sleep(durationMs(params.duration));
  return stopNetwork(capture, Boolean(params.har));
}

async function finishNetwork(capture) {
  if (capture.stoppedAt) return;
  capture.stoppedAt = Date.now();
  if (capture.timer) clearTimeout(capture.timer);
  await Promise.allSettled(capture.pending);
  await cdp({ tabId: capture.tabId }, "Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
  await detach(capture.tabId, capture.owner);
}

async function stopNetwork(capture, asHar = false) {
  await finishNetwork(capture);
  networkCaptures.delete(capture.id);
  networkCaptureByTab.delete(capture.tabId);
  scheduleStatusBroadcast();
  const snapshot = networkSnapshot(capture);
  return asHar ? toHar(snapshot) : snapshot;
}

function networkSnapshot(capture) {
  return {
    session: capture.id,
    tabId: capture.tabId,
    startedAt: new Date(capture.startedAt).toISOString(),
    stoppedAt: capture.stoppedAt ? new Date(capture.stoppedAt).toISOString() : null,
    active: !capture.stoppedAt,
    requests: [...capture.requests.values()],
    webSockets: capture.webSockets,
  };
}

async function networkGetBody(capture, requestId, params) {
  if (capture.stoppedAt) throw new Error("Response bodies are only available while the capture is attached");
  const record = capture.requests.get(String(requestId)) || [...capture.requests.values()].find((item) => item.requestId === String(requestId));
  if (!record) throw new Error("Unknown request id for this capture");
  return getResponseBody(capture, record, params);
}

async function getResponseBody(capture, record, params = {}) {
  const target = record.sessionId ? { tabId: capture.tabId, sessionId: record.sessionId } : { tabId: capture.tabId };
  const result = await cdp(target, "Network.getResponseBody", { requestId: record.requestId });
  return { base64Encoded: result.base64Encoded, body: result.body };
}

function toHar(snapshot) {
  return {
    log: {
      version: "1.2",
      creator: { name: "Chrome Bridge", version: "0.1.0" },
      pages: [{ id: `tab-${snapshot.tabId}`, startedDateTime: snapshot.startedAt, title: `Tab ${snapshot.tabId}`, pageTimings: {} }],
      entries: snapshot.requests.map((record) => ({
        pageref: `tab-${snapshot.tabId}`,
        startedDateTime: record.wallTime ? new Date(record.wallTime * 1000).toISOString() : snapshot.startedAt,
        time: record.durationMs || 0,
        request: {
          method: record.method || "GET",
          url: record.url,
          httpVersion: "HTTP/1.1",
          headers: Object.entries(record.requestHeaders || {}).map(([name, value]) => ({ name, value: String(value) })),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: record.postData ? record.postData.length : 0,
          postData: record.postData ? { mimeType: record.requestHeaders?.["content-type"] || "", text: record.postData } : undefined,
        },
        response: {
          status: record.status || 0,
          statusText: record.statusText || "",
          httpVersion: record.protocol || "HTTP/1.1",
          headers: Object.entries(record.responseHeaders || {}).map(([name, value]) => ({ name, value: String(value) })),
          cookies: [],
          content: { size: record.encodedDataLength || 0, mimeType: record.mimeType || "", text: record.body?.body },
          redirectURL: "",
          headersSize: -1,
          bodySize: record.encodedDataLength || -1,
        },
        cache: {},
        timings: { send: 0, wait: record.durationMs || 0, receive: 0 },
      })),
    },
  };
}

async function captureConsole(tabId, owner, params) {
  if (consoleCaptures.has(tabId)) throw new Error(`Tab ${tabId} already has a console capture`);
  const capture = { events: [], startedAt: Date.now() };
  consoleCaptures.set(tabId, capture);
  try {
    return await withDebugger(tabId, owner, async (target) => {
      await Promise.all([cdp(target, "Runtime.enable"), cdp(target, "Log.enable")]);
      await sleep(durationMs(params.duration, 5_000));
      return { tabId, startedAt: new Date(capture.startedAt).toISOString(), events: capture.events };
    });
  } finally {
    consoleCaptures.delete(tabId);
  }
}

async function collectScripts(tabId, owner, waitMs = 300) {
  if (scriptCollectors.has(tabId)) throw new Error(`Tab ${tabId} already has a script query`);
  const scripts = [];
  scriptCollectors.set(tabId, scripts);
  try {
    return await withDebugger(tabId, owner, async (target) => {
      await cdp(target, "Debugger.enable");
      await sleep(Math.max(0, Number(waitMs) || 300));
      return { target, scripts };
    });
  } finally {
    scriptCollectors.delete(tabId);
  }
}

async function listScripts(tabId, owner, params) {
  const { scripts } = await collectScripts(tabId, owner, params.wait);
  return scripts.map(({ scriptId, url, startLine, startColumn, endLine, endColumn, hash, isModule }) => ({
    scriptId, url, startLine, startColumn, endLine, endColumn, hash, isModule,
  }));
}

async function getScript(tabId, owner, params) {
  const query = String(params.url || "");
  if (!query) throw new Error("scripts get requires --url");
  let selected;
  let source;
  const scripts = [];
  scriptCollectors.set(tabId, scripts);
  try {
    await withDebugger(tabId, owner, async (target) => {
      await cdp(target, "Debugger.enable");
      await sleep(Math.max(0, Number(params.wait) || 300));
      selected = scripts.find((script) => script.url === query) || scripts.find((script) => script.url.includes(query));
      if (!selected) throw new Error(`No loaded script matched ${query}`);
      source = await cdp(target, "Debugger.getScriptSource", { scriptId: selected.scriptId });
    });
  } finally {
    scriptCollectors.delete(tabId);
  }
  return { url: selected.url, scriptId: selected.scriptId, source: source.scriptSource || "" };
}

async function getCookies(tab, owner, params) {
  return withDebugger(tab.id, owner, async (target) => {
    await cdp(target, "Network.enable");
    const result = await cdp(target, "Network.getCookies", { urls: [tab.url] });
    return result.cookies;
  });
}

async function inspectStorage(tab, owner, params) {
  const maxRecords = params.limit === undefined ? "Infinity" : Math.max(1, Number(params.limit));
  const includeCacheBodies = Boolean(params.bodies);
  const expression = `(async () => {
    const limit = ${maxRecords};
    const result = {
      localStorage: Object.fromEntries(Object.entries(localStorage)),
      sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
      indexedDB: [],
      caches: []
    };
    if (indexedDB.databases) {
      for (const info of await indexedDB.databases()) {
        if (!info.name) continue;
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(info.name);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const database = {name: info.name, version: info.version, stores: []};
        for (const storeName of db.objectStoreNames) {
          const transaction = db.transaction(storeName, 'readonly');
          const store = transaction.objectStore(storeName);
          const records = await new Promise((resolve, reject) => {
            const rows = [];
            const request = store.openCursor();
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor || rows.length >= limit) return resolve(rows);
              rows.push({key: cursor.key, value: cursor.value});
              cursor.continue();
            };
            request.onerror = () => reject(request.error);
          });
          database.stores.push({name: storeName, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: [...store.indexNames], records});
        }
        db.close();
        result.indexedDB.push(database);
      }
    }
    if ('caches' in globalThis) {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        const requests = await cache.keys();
        const entries = [];
        for (const request of requests.slice(0, limit)) {
          const response = await cache.match(request);
          let body;
          if (${includeCacheBodies ? "true" : "false"} && response) {
            try { body = await response.clone().text(); } catch {}
          }
          entries.push({request: {url: request.url, method: request.method, headers: Object.fromEntries(request.headers)}, response: response && {status: response.status, statusText: response.statusText, type: response.type, headers: Object.fromEntries(response.headers), body}});
        }
        result.caches.push({name, entries});
      }
    }
    return result;
  })()`;
  return withDebugger(tab.id, owner, async (target) => {
    const result = await cdp(target, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Storage inspection failed");
    return result.result?.value;
  });
}

async function resourceTree(tabId, owner) {
  return withDebugger(tabId, owner, async (target) => {
    await cdp(target, "Page.enable");
    return cdp(target, "Page.getResourceTree");
  });
}

async function resourceContent(tabId, owner, params) {
  if (!params.frame || !params.url) throw new Error("resources get requires --frame and --url from resources tree");
  return withDebugger(tabId, owner, async (target) => {
    await cdp(target, "Page.enable");
    const result = await cdp(target, "Page.getResourceContent", { frameId: String(params.frame), url: String(params.url) });
    return { url: params.url, base64Encoded: result.base64Encoded, content: result.content || "" };
  });
}

async function captureMhtml(tabId, owner, params) {
  return withDebugger(tabId, owner, async (target) => {
    await cdp(target, "Page.enable");
    const result = await cdp(target, "Page.captureSnapshot", { format: "mhtml" });
    return { format: "mhtml", data: result.data };
  });
}

async function domSnapshot(tabId, owner, params) {
  const styles = String(params.styles || "display,visibility,color,background-color,font-family,font-size,position,z-index")
    .split(",").map((value) => value.trim()).filter(Boolean);
  return withDebugger(tabId, owner, async (target) => {
    const result = await cdp(target, "DOMSnapshot.captureSnapshot", {
      computedStyles: styles,
      includePaintOrder: params.paintOrder !== false,
      includeDOMRects: params.domRects !== false,
      includeBlendedBackgroundColors: Boolean(params.blendedColors),
      includeTextColorOpacities: Boolean(params.textOpacities),
    });
    return result;
  });
}

async function inspectStyles(tabId, owner, params) {
  const selector = checkedSelector(params.selector);
  return withDebugger(tabId, owner, async (target) => {
    await Promise.all([cdp(target, "DOM.enable"), cdp(target, "CSS.enable")]);
    const { root } = await cdp(target, "DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await cdp(target, "DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error("Element not found");
    const [attributes, computed, matched] = await Promise.all([
      cdp(target, "DOM.getAttributes", { nodeId }),
      cdp(target, "CSS.getComputedStyleForNode", { nodeId }),
      cdp(target, "CSS.getMatchedStylesForNode", { nodeId }),
    ]);
    return { nodeId, attributes: attributes.attributes, computed: computed.computedStyle, matched };
  });
}

async function inspectTargets(tabId, owner) {
  const debuggerTargets = await chrome.debugger.getTargets();
  return withDebugger(tabId, owner, async (target) => {
    await cdp(target, "Page.enable");
    const frames = await cdp(target, "Page.getFrameTree");
    return { debuggerTargets, frames: frames.frameTree };
  });
}

async function performanceMetrics(tabId, owner) {
  return withDebugger(tabId, owner, async (target) => {
    await cdp(target, "Performance.enable", { timeDomain: "timeTicks" });
    const [metrics, heap] = await Promise.all([
      cdp(target, "Performance.getMetrics"),
      cdp(target, "Runtime.getHeapUsage"),
    ]);
    return { metrics: metrics.metrics, heap };
  });
}

async function cpuProfile(tabId, owner, params) {
  return withDebugger(tabId, owner, async (target) => {
    await cdp(target, "Profiler.enable");
    if (params.interval) await cdp(target, "Profiler.setSamplingInterval", { interval: Math.max(100, Number(params.interval)) });
    await cdp(target, "Profiler.start");
    await sleep(durationMs(params.duration, 5_000));
    return cdp(target, "Profiler.stop");
  });
}

async function performanceTrace(tabId, owner, params) {
  if (traceCollectors.has(tabId)) throw new Error(`Tab ${tabId} already has a trace running`);
  return withDebugger(tabId, owner, async (target) => {
    let resolveStream;
    let rejectStream;
    const streamPromise = new Promise((resolve, reject) => { resolveStream = resolve; rejectStream = reject; });
    const timer = setTimeout(() => rejectStream(new Error("Tracing stream timed out")), durationMs(params.duration, 5_000) + 60_000);
    traceCollectors.set(tabId, { resolve: resolveStream });
    let handle;
    try {
      const startOptions = {
        categories: String(params.categories || "devtools.timeline,v8.execute,blink.user_timing,loading,disabled-by-default-devtools.timeline"),
        transferMode: "ReturnAsStream",
      };
      if (params.traceConfig) {
        delete startOptions.categories;
        startOptions.traceConfig = typeof params.traceConfig === "string" ? JSON.parse(params.traceConfig) : params.traceConfig;
      }
      await cdp(target, "Tracing.start", startOptions);
      await sleep(durationMs(params.duration, 5_000));
      await cdp(target, "Tracing.end");
      handle = await streamPromise;
      let data = "";
      let eof = false;
      while (!eof) {
        const chunk = await cdp(target, "IO.read", { handle, size: 1_000_000 });
        data += chunk.data || "";
        eof = Boolean(chunk.eof);
      }
      return { format: "json", data };
    } finally {
      clearTimeout(timer);
      traceCollectors.delete(tabId);
      if (handle) await cdp(target, "IO.close", { handle }).catch(() => {});
    }
  });
}

function cdpMethod(params) {
  const method = String(params.method || (params.domain && params.command ? `${params.domain}.${params.command}` : ""));
  const [domain] = method.split(".");
  if (!method.includes(".") || !ALLOWED_CDP_DOMAINS.has(domain)) throw new Error("Raw CDP method is missing or unavailable to chrome.debugger");
  return method;
}

async function rawCdp(tab, owner, params) {
  const method = cdpMethod(params);
  const commandParams = typeof params.params === "string" ? JSON.parse(params.params) : (params.params || {});
  const target = params.sessionId ? { tabId: tab.id, sessionId: String(params.sessionId) } : { tabId: tab.id };
  return withDebugger(tab.id, owner, async () => cdp(target, method, commandParams));
}

async function captureCdpEvents(tabId, owner, params) {
  const domain = String(params.domain || "");
  if (!ALLOWED_CDP_DOMAINS.has(domain)) throw new Error("A supported CDP --domain is required");
  if (eventCollectors.has(tabId)) throw new Error(`Tab ${tabId} already has a raw event capture`);
  const collector = { domain, events: [] };
  eventCollectors.set(tabId, collector);
  try {
    return await withDebugger(tabId, owner, async (target) => {
      await cdp(target, `${domain}.enable`, {}).catch(() => {});
      await sleep(durationMs(params.duration, 5_000));
      return collector.events;
    });
  } finally {
    eventCollectors.delete(tabId);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;

  const captureId = networkCaptureByTab.get(tabId);
  const capture = captureId && networkCaptures.get(captureId);
  if (capture && method === "Target.attachedToTarget") handleAttachedTarget(capture, params);
  if (capture && method.startsWith("Network.")) handleNetworkEvent(capture, source, method, params);

  const consoleCapture = consoleCaptures.get(tabId);
  if (consoleCapture) handleConsoleEvent(consoleCapture, method, params);

  const scripts = scriptCollectors.get(tabId);
  if (scripts && method === "Debugger.scriptParsed") scripts.push(params);

  const collector = eventCollectors.get(tabId);
  if (collector && method.startsWith(`${collector.domain}.`)) {
    collector.events.push({ method, params, at: new Date().toISOString() });
  }

  const trace = traceCollectors.get(tabId);
  if (trace && method === "Tracing.tracingComplete") trace.resolve(params.stream);
});

async function handleAttachedTarget(capture, params) {
  capture.sessions.add(params.sessionId);
  const target = { tabId: capture.tabId, sessionId: params.sessionId };
  await Promise.all([
    cdp(target, "Network.enable"),
    cdp(target, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }),
  ]).catch(() => {});
}

function handleNetworkEvent(capture, source, method, params) {
  scheduleStatusBroadcast();
  const requestKey = `${source.sessionId || "root"}:${params.requestId || ""}`;
  if (method === "Network.requestWillBeSent") {
    const url = String(params.request?.url || "");
    if (capture.urlFilter && !url.toLowerCase().includes(capture.urlFilter)) return;
    capture.requests.set(requestKey, {
      requestKey,
      requestId: params.requestId,
      sessionId: source.sessionId,
      loaderId: params.loaderId,
      documentURL: params.documentURL || "",
      url,
      method: params.request?.method,
      requestHeaders: params.request?.headers,
      postData: params.request?.postData,
      hasPostData: params.request?.hasPostData,
      initiator: params.initiator,
      type: params.type,
      timestamp: params.timestamp,
      wallTime: params.wallTime,
      redirectResponse: params.redirectResponse ? {
        url: params.redirectResponse.url,
        status: params.redirectResponse.status,
        headers: params.redirectResponse.headers,
      } : undefined,
    });
    return;
  }

  const record = capture.requests.get(requestKey);
  if (method === "Network.responseReceived" && record) {
    Object.assign(record, {
      status: params.response.status,
      statusText: params.response.statusText,
      responseHeaders: params.response.headers,
      mimeType: params.response.mimeType,
      protocol: params.response.protocol,
      remoteIPAddress: params.response.remoteIPAddress,
      remotePort: params.response.remotePort,
      fromDiskCache: params.response.fromDiskCache,
      fromServiceWorker: params.response.fromServiceWorker,
      timing: params.response.timing,
      responseTimestamp: params.timestamp,
    });
    return;
  }

  if (method === "Network.loadingFinished" && record) {
    record.encodedDataLength = params.encodedDataLength;
    record.finishedTimestamp = params.timestamp;
    record.durationMs = record.timestamp ? Math.max(0, (params.timestamp - record.timestamp) * 1000) : undefined;
    if (capture.includeBodies) {
      const pending = getResponseBody(capture, record).then((body) => {
        record.body = body;
      }, (error) => {
        record.bodyError = errorMessage(error);
      });
      capture.pending.push(pending);
    }
    return;
  }

  if (method === "Network.loadingFailed" && record) {
    record.failed = true;
    record.errorText = params.errorText;
    record.canceled = params.canceled;
    return;
  }

  if (method === "Network.webSocketFrameSent" || method === "Network.webSocketFrameReceived") {
    capture.webSockets.push({
      requestId: params.requestId,
      sessionId: source.sessionId,
      direction: method.endsWith("Sent") ? "sent" : "received",
      timestamp: params.timestamp,
      opcode: params.response?.opcode,
      mask: params.response?.mask,
      payload: params.response?.payloadData || "",
    });
  }
}

function handleConsoleEvent(capture, method, params) {
  if (method === "Runtime.consoleAPICalled") {
    capture.events.push({
      source: "console",
      level: params.type,
      timestamp: params.timestamp,
      args: params.args?.map((arg) => arg.value ?? arg.unserializableValue ?? arg.description ?? arg.type),
      stackTrace: params.stackTrace,
    });
  } else if (method === "Runtime.exceptionThrown") {
    capture.events.push({ source: "exception", timestamp: params.timestamp, details: params.exceptionDetails });
  } else if (method === "Log.entryAdded") {
    capture.events.push({ source: "log", ...params.entry });
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (!source.tabId) return;
  attachedOwners.delete(source.tabId);
  const captureId = networkCaptureByTab.get(source.tabId);
  if (captureId) {
    const capture = networkCaptures.get(captureId);
    if (capture) capture.stoppedAt = Date.now();
    networkCaptureByTab.delete(source.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  detachAll(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  if (!networkCaptureByTab.has(tabId)) detachAll(tabId).catch(() => {});
});

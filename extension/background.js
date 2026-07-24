import { normalizeSemanticValue, selectSemanticMatch, semanticNodeMatches } from "./semantic.js";

const HOST_NAME = "dev.sethrose.chrome_bridge";
const PROTOCOL_VERSION = "1.3";
const REQUIRED_PERMISSIONS = ["bookmarks", "cookies", "debugger", "downloads", "history", "management", "nativeMessaging", "sessions", "sidePanel", "storage", "tabGroups", "tabs", "topSites", "webNavigation"];
const REQUIRED_ORIGINS = ["<all_urls>"];

let nativePort;
let hostOnline = false;
let hostVersion;
let hasConnected = false;
let reconnectTimer;
let reconnectDelay = 1_000;
let statusBroadcastTimer;
let statusBroadcastQueued = false;
const attachedOwners = new Map();
const activeCommands = new Map();
const activity = {
  commandsStarted: 0,
  commandsCompleted: 0,
  commandsFailed: 0,
  debuggerAttaches: 0,
  networkRequests: 0,
  networkBytes: 0,
  webSocketFrames: 0,
  lastCommandAt: null,
  lastNetworkAt: null,
};
const networkCaptures = new Map();
const networkCaptureByTab = new Map();
const consoleCaptures = new Map();
const scriptCollectors = new Map();
const eventCollectors = new Map();
const traceCollectors = new Map();
const screencastCollectors = new Map();
const emulationOwners = new Map();
const emulationTimers = new Map();
const dragResolvers = new Map();
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

function commandError(message, details) {
  const error = new Error(message);
  error.details = details;
  return error;
}

function debuggerOwnership(tabId) {
  const owners = [...(attachedOwners.get(tabId) || [])];
  const networkOwner = owners.find((owner) => owner.startsWith("network:"));
  const sessionOwner = owners.find((owner) => owner.startsWith("cdp-session:"));
  if (networkOwner) {
    const sessionId = networkOwner.slice("network:".length);
    return { blockedBy: "network-capture", sessionId, recovery: `chrome-bridge network stop --tab=${tabId} --session=${sessionId}` };
  }
  if (sessionOwner) {
    const sessionId = sessionOwner.slice("cdp-session:".length);
    return { blockedBy: "cdp-session", sessionId, recovery: `chrome-bridge cdp session-stop --bridge-session=${sessionId}` };
  }
  if (owners.some((owner) => owner.startsWith("emulation:"))) return { blockedBy: "emulation", recovery: `chrome-bridge emulate --tab=${tabId} --clear` };
  return owners.length ? { blockedBy: "chrome-bridge-command", owners } : null;
}

async function resolveTab(tabId) {
  if (tabId !== undefined && tabId !== null && tabId !== "") {
    if (/^\d+$/.test(String(tabId))) return chrome.tabs.get(Number(tabId));
    const { tabNames = {} } = await chrome.storage.local.get("tabNames");
    const saved = tabNames[String(tabId)];
    if (!saved) throw new Error(`Unknown tab name: ${tabId}`);
    const current = await chrome.tabs.get(saved.tabId).catch(() => null);
    if (current) return current;
    const matches = (await chrome.tabs.query({})).filter((tab) => tab.url === saved.url);
    if (matches.length !== 1) throw new Error(`Named tab ${tabId} is no longer available; assign the name again`);
    tabNames[String(tabId)] = { ...saved, tabId: matches[0].id };
    await chrome.storage.local.set({ tabNames });
    return matches[0];
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found");
  return tab;
}

async function attach(tabId, owner) {
  const access = tabAccess(await chrome.tabs.get(tabId));
  if (!access.inspectable) throw commandError(access.reason, {
    scheme: access.scheme,
    owningExtensionId: access.owningExtensionId,
    recovery: access.httpPageWouldBeInspectable ? `Return to an http(s) page, for example with: chrome-bridge go-back --tab=${tabId} --wait=load` : null,
  });
  const state = attachedOwners.get(tabId);
  if (state) {
    state.add(owner);
    return;
  }

  const target = (await chrome.debugger.getTargets()).find((candidate) => candidate.tabId === tabId && candidate.attached);
  if (target) throw commandError(`Tab ${tabId} is already attached to DevTools or another debugger client`, {
    blockedBy: "external-debugger",
    recovery: "Close DevTools or stop the other debugger client for this tab, then retry.",
  });
  await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  attachedOwners.set(tabId, new Set([owner]));
  activity.debuggerAttaches += 1;
  scheduleStatusBroadcast();
}

async function detach(tabId, owner) {
  const owners = attachedOwners.get(tabId);
  if (!owners) return;
  owners.delete(owner);
  if (owners.size) return;
  attachedOwners.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  scheduleStatusBroadcast();
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
  eventCollectors.delete(`tab:${tabId}`);
  emulationOwners.delete(tabId);
  clearTimeout(emulationTimers.get(tabId));
  emulationTimers.delete(tabId);
  for (const [id, session] of manualCdpSessions) {
    if (session.target.tabId === tabId) {
      clearTimeout(session.timer);
      manualCdpSessions.delete(id);
    }
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
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  let port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
    nativePort = port;
  } catch {
    nativePort = undefined;
    scheduleReconnect();
    return;
  }

  port.onMessage.addListener(handleNativeMessage);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (nativePort !== port) return;
    nativePort = undefined;
    hostOnline = false;
    scheduleStatusBroadcast();
    scheduleReconnect();
  });
  port.postMessage({ type: "hello" });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(connectHost, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
}

function reconnectHost() {
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  reconnectDelay = 1_000;
  const port = nativePort;
  nativePort = undefined;
  hostOnline = false;
  port?.disconnect();
  connectHost();
  scheduleStatusBroadcast();
}

async function handleNativeMessage(message) {
  if (message?.type === "helloResult") {
    hostOnline = Boolean(message.ok);
    hostVersion = message.version || null;
    hasConnected ||= hostOnline;
    if (hostOnline) reconnectDelay = 1_000;
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
  const startedAt = Date.now();
  activeCommands.set(id, {
    id,
    command,
    tabId: params.tab === undefined || !/^\d+$/.test(String(params.tab)) ? undefined : Number(params.tab),
    tabName: params.tab === undefined || /^\d+$/.test(String(params.tab)) ? undefined : String(params.tab),
    targetId: params.target,
    startedAt,
  });
  activity.commandsStarted += 1;
  activity.lastCommandAt = startedAt;
  scheduleStatusBroadcast();
  try {
    const result = await executeCommand(command, params, id);
    activity.commandsCompleted += 1;
    sendChunkedResponse(id, { ok: true, result, completedAt: Date.now() });
  } catch (error) {
    activity.commandsFailed += 1;
    sendChunkedResponse(id, { ok: false, error: errorMessage(error), details: error?.details, completedAt: Date.now() });
  } finally {
    activeCommands.delete(id);
    scheduleStatusBroadcast();
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
  const connectionState = hostOnline
    ? "connected"
    : nativePort
      ? "connecting"
      : hasConnected
        ? "reconnecting"
        : "disconnected";
  const live = {
    attachedTabs: [...attachedOwners.keys()],
    activeCommands: [...activeCommands.values()],
    activeCaptures: [...networkCaptures.values()].map((capture) => ({
      session: capture.id,
      tabId: capture.tabId,
      tabTitle: capture.tabTitle,
      startedAt: new Date(capture.startedAt).toISOString(),
      expiresAt: capture.expiresAt ? new Date(capture.expiresAt).toISOString() : null,
      requests: capture.requests.size,
      webSocketFrames: capture.webSockets.length,
    })),
    cdpSessions: [...manualCdpSessions.values()].map((session) => ({
      session: session.id,
      target: session.target,
      startedAt: new Date(session.startedAt).toISOString(),
      expiresAt: session.ttlMs === null ? null : new Date(session.startedAt + session.ttlMs).toISOString(),
    })),
    emulatedTabs: [...emulationOwners.keys()],
    activity: { ...activity },
  };
  const { auditLog = [] } = await chrome.storage.local.get("auditLog");
  return {
    bridgeOnline: hostOnline,
    nativeConnected: Boolean(nativePort),
    connectionState,
    versions: {
      extension: chrome.runtime.getManifest().version,
      nativeHost: hostVersion || null,
      protocol: PROTOCOL_VERSION,
    },
    ...live,
    recentCommands: auditLog.slice(-25).reverse(),
  };
}

function scheduleStatusBroadcast() {
  if (statusBroadcastTimer) {
    statusBroadcastQueued = true;
    return;
  }
  statusSnapshot().then((status) => {
    chrome.runtime.sendMessage({ type: "bridge-status-update", status }).catch(() => {});
  }).catch(() => {});
  statusBroadcastTimer = setTimeout(() => {
    statusBroadcastTimer = undefined;
    if (!statusBroadcastQueued) return;
    statusBroadcastQueued = false;
    scheduleStatusBroadcast();
  }, 50);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const action = message?.type === "bridge-clear-logs"
    ? chrome.storage.local.remove("auditLog").then(() => {
        activity.networkRequests = 0;
        nativePort?.postMessage({ type: "clearLogs", id: crypto.randomUUID() });
        return statusSnapshot();
      })
    : message?.type === "bridge-reconnect"
      ? (reconnectHost(), statusSnapshot())
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
  const completedAt = Date.now();
  const startedAt = activeCommands.get(id)?.startedAt || completedAt;
  auditLog.push({
    id,
    at: new Date(completedAt).toISOString(),
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
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
    if (["chrome-call", "extensions-list", "extension-reload"].includes(command)) {
      const result = command === "chrome-call"
        ? await rawChromeApi(params)
        : command === "extensions-list"
          ? await chrome.management.getAll()
          : await reloadExtension(params.extension);
      await audit(requestId, command, params, undefined, "ok");
      return result;
    }
    if (command === "audit") {
      const { auditLog = [] } = await chrome.storage.local.get("auditLog");
      const cutoff = params.since === undefined ? 0 : Date.now() - Number(params.since);
      const filtered = auditLog.filter((entry) => (
        (!params.status || entry.status === params.status)
        && (!params.command || entry.command === params.command)
        && (!cutoff || entry.completedAt >= cutoff)
      )).reverse();
      if (!params.summary) return filtered;
      const countBy = (key) => filtered.reduce((counts, entry) => ({ ...counts, [entry[key]]: (counts[entry[key]] || 0) + 1 }), {});
      return {
        total: filtered.length,
        byStatus: countBy("status"),
        byCommand: countBy("command"),
      };
    }

    const targetOnlyCommand = command === "cdp-session-stop"
      || (["cdp-send", "cdp-events"].includes(command) && (params.target || params.bridgeSession))
      || (command === "cdp-session-start" && params.target);
    tab = targetOnlyCommand ? undefined : await resolveTab(params.tab);
    const active = activeCommands.get(requestId);
    if (active && tab) {
      active.tabId = tab.id;
      active.tabTitle = tab.title || tab.url || "Untitled tab";
      scheduleStatusBroadcast();
    }
    const owner = `command:${requestId}`;
    let result;

    switch (command) {
      case "activate-tab":
        result = await chrome.tabs.update(tab.id, { active: true });
        break;
      case "tab-name":
        result = await nameTab(tab, params.name);
        break;
      case "new-tab":
        result = await chrome.tabs.create({ url: navigableUrl(params.url || "about:blank"), active: params.active !== false });
        break;
      case "close-tab":
        await chrome.tabs.remove(tab.id);
        result = { closed: true, tabId: tab.id };
        break;
      case "navigate":
        result = await navigateAndWait(tab, owner, params, () => chrome.tabs.update(tab.id, { url: navigableUrl(params.url) }));
        break;
      case "reload":
        result = await navigateAndWait(tab, owner, params, async () => {
          await chrome.tabs.reload(tab.id);
          return { reloaded: true, tabId: tab.id };
        });
        break;
      case "go-back":
        result = await navigateAndWait(tab, owner, params, async () => {
          await chrome.tabs.goBack(tab.id);
          return { navigated: "back", tabId: tab.id };
        });
        break;
      case "go-forward":
        result = await navigateAndWait(tab, owner, params, async () => {
          await chrome.tabs.goForward(tab.id);
          return { navigated: "forward", tabId: tab.id };
        });
        break;
      case "inspectability":
        result = await inspectability(tab);
        break;
      case "capabilities":
        result = await pageCapabilities(tab);
        break;
      case "doctor":
        result = await doctor(tab, owner, params);
        break;
      case "snapshot":
        result = await accessibilitySnapshot(tab.id, owner, params);
        break;
      case "locate":
        result = await locateElements(tab.id, owner, params);
        break;
      case "watch":
        result = await watchPage(tab, owner, params);
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
      case "screencast":
        result = await captureScreencast(tab.id, owner, params);
        break;
      case "eval":
        result = await evaluate(tab, owner, params);
        break;
      case "extract":
        result = await extractPage(tab.id, owner, params);
        break;
      case "click":
        result = await click(tab.id, owner, params);
        break;
      case "type":
        result = await typeText(tab.id, owner, params);
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
        result = presentNetwork(networkSnapshot(findCapture(params.session, tab.id)), params);
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
  const { tabNames = {} } = await chrome.storage.local.get("tabNames");
  const namesById = new Map(Object.entries(tabNames).map(([name, saved]) => [saved.tabId, name]));
  return (await chrome.tabs.query({})).map((tab) => ({
    id: tab.id,
    name: namesById.get(tab.id),
    windowId: tab.windowId,
    active: tab.active,
    title: tab.title,
    url: tab.url || "",
    attached: Boolean(tab.id && attachedOwners.has(tab.id)),
  }));
}

async function nameTab(tab, nameValue) {
  const name = String(nameValue || "");
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("Tab names may contain only letters, numbers, dot, underscore, and hyphen");
  const { tabNames = {} } = await chrome.storage.local.get("tabNames");
  for (const [existingName, saved] of Object.entries(tabNames)) {
    if (existingName !== name && saved.tabId === tab.id) delete tabNames[existingName];
  }
  tabNames[name] = { tabId: tab.id, url: tab.url || "", title: tab.title || "" };
  await chrome.storage.local.set({ tabNames });
  return { name, ...tabNames[name] };
}

async function rawChromeApi(params) {
  const namespace = String(params.api || "");
  const method = String(params.method || "");
  const api = chrome[namespace];
  if (!api || typeof api[method] !== "function") throw new Error("chrome call requires a callable --api and --method");
  const args = jsonValue(params.args, []);
  if (!Array.isArray(args)) throw new Error("chrome call --args must be a JSON array");
  return api[method](...args);
}

async function reloadExtension(extensionIdValue) {
  const extensionId = String(extensionIdValue || "");
  if (!extensionId) throw new Error("extension reload requires --extension=ID");
  if (extensionId === chrome.runtime.id) throw new Error("Chrome Bridge cannot reload itself while returning a CLI response; reload it from chrome://extensions");
  const extension = await chrome.management.get(extensionId);
  await chrome.management.setEnabled(extensionId, false);
  await chrome.management.setEnabled(extensionId, true);
  return { reloaded: true, extension: { id: extension.id, name: extension.name, type: extension.type } };
}

function navigableUrl(value) {
  const url = String(value || "");
  if (!url) throw new Error("A URL is required");
  return url;
}

async function waitForAction(tabId, owner, params) {
  const hasSemanticWait = Boolean(params.waitRole || params.waitName || params.waitText);
  if (!params.wait && !params.waitForUrl && !params.waitForSelector && !hasSemanticWait) return null;
  const timeout = durationMs(params.waitTimeout, 30_000);
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    const tab = await chrome.tabs.get(tabId);
    const loadMatched = params.wait !== "load" || tab.status === "complete";
    const urlMatched = !params.waitForUrl || String(tab.url || "").includes(String(params.waitForUrl));
    if (loadMatched && urlMatched) break;
    await sleep(100);
  }
  const current = await chrome.tabs.get(tabId);
  if (params.wait === "load" && current.status !== "complete") throw new Error(`Page did not finish loading within ${timeout}ms`);
  if (params.waitForUrl && !String(current.url || "").includes(String(params.waitForUrl))) throw new Error(`URL did not contain ${params.waitForUrl} within ${timeout}ms`);
  let selector;
  if (params.waitForSelector) {
    selector = await waitForPage(tabId, owner, { selector: params.waitForSelector, duration: Math.max(0, deadline - Date.now()) });
  }
  let semantic;
  if (hasSemanticWait) {
    semantic = await waitForPage(tabId, owner, {
      role: params.waitRole,
      name: params.waitName,
      targetText: params.waitText,
      state: params.waitState,
      exact: params.waitExact,
      nth: params.waitNth,
      within: params.waitWithin,
      duration: Math.max(0, deadline - Date.now()),
    });
  }
  return { matched: true, elapsedMs: timeout - Math.max(0, deadline - Date.now()), selector, semantic };
}

async function observeTab(tabId, beforeUrl, duration = 1_500) {
  const deadline = Date.now() + duration;
  let current = await chrome.tabs.get(tabId);
  let stableSince = Date.now();
  let last = `${current.url}|${current.status}`;
  while (Date.now() < deadline) {
    await sleep(100);
    current = await chrome.tabs.get(tabId);
    const next = `${current.url}|${current.status}`;
    if (next !== last) {
      last = next;
      stableSince = Date.now();
    }
    if (current.status === "complete" && Date.now() - stableSince >= 250 && (current.url !== beforeUrl || Date.now() + 500 >= deadline)) break;
  }
  return current;
}

async function navigateAndWait(tab, owner, params, action) {
  const result = await action();
  const waitResult = await waitForAction(tab.id, owner, params);
  const current = waitResult ? await chrome.tabs.get(tab.id) : await observeTab(tab.id, tab.url, 500);
  return { ...result, wait: waitResult || undefined, finalUrl: current.url || "", title: current.title || "" };
}

function tabAccess(tab) {
  let parsed;
  try { parsed = new URL(tab.url || "about:blank"); } catch { parsed = new URL("about:blank"); }
  const scheme = parsed.protocol.replace(/:$/, "");
  const owningExtensionId = scheme === "chrome-extension" ? parsed.hostname : null;
  const internal = ["chrome", "chrome-untrusted", "devtools", "view-source"].includes(scheme);
  const otherExtension = owningExtensionId && owningExtensionId !== chrome.runtime.id;
  const inspectable = !internal && !otherExtension;
  let reason = null;
  if (internal) reason = `${scheme}:// pages are protected Chrome surfaces and reject debugger attachment.`;
  else if (otherExtension) reason = `Chrome blocks one extension from debugging another extension's chrome-extension:// pages.`;
  return {
    tabId: tab.id,
    url: tab.url || "",
    scheme,
    inspectable,
    owningExtensionId,
    reason,
    httpPageWouldBeInspectable: !inspectable,
    backTargetKnown: false,
    goingBackWouldRestoreAccess: inspectable ? false : null,
  };
}

async function inspectability(tab) {
  const access = tabAccess(tab);
  const debuggerTarget = (await chrome.debugger.getTargets()).find((target) => target.tabId === tab.id && target.attached);
  return {
    ...access,
    debugger: debuggerOwnership(tab.id) || (debuggerTarget ? { blockedBy: "external-debugger", recovery: "Close DevTools or the other debugger client for this tab." } : null),
  };
}

async function pageCapabilities(tab) {
  const access = await inspectability(tab);
  const pdf = /\.pdf(?:$|[?#])/i.test(tab.url || "") || /[?&]file=.*\.pdf/i.test(tab.url || "");
  const documentAccess = access.inspectable && !pdf;
  return {
    tabId: tab.id,
    url: tab.url || "",
    scheme: access.scheme,
    pageType: pdf ? "pdf" : access.owningExtensionId ? "extension" : "document",
    capabilities: {
      domInspection: documentAccess,
      accessibilitySnapshot: documentAccess,
      screenshot: access.inspectable,
      evaluation: documentAccess,
      debuggerAttachment: access.inspectable,
      networkCapture: access.inspectable,
      storageAccess: documentAccess && ["http", "https", "file", "chrome-extension"].includes(access.scheme),
      input: documentAccess,
      extensionPageAccess: !access.owningExtensionId || access.owningExtensionId === chrome.runtime.id,
    },
    reasons: [access.reason, pdf ? "PDF tabs do not expose a normal page DOM." : null].filter(Boolean),
  };
}

async function doctor(tab, owner, params) {
  const access = await inspectability(tab);
  const manifest = chrome.runtime.getManifest();
  const versions = { cli: params.cliVersion || null, nativeHost: hostVersion || null, extension: manifest.version, protocol: PROTOCOL_VERSION };
  let permissions;
  try { permissions = await chrome.permissions.contains({ permissions: REQUIRED_PERMISSIONS, origins: REQUIRED_ORIGINS }); }
  catch (error) { permissions = errorMessage(error); }
  const checks = [
    { name: "native-messaging", ok: hostOnline && Boolean(nativePort), detail: hostOnline ? "connected" : "disconnected" },
    { name: "versions", ok: Boolean(versions.cli && versions.nativeHost) && versions.cli === versions.nativeHost && versions.cli === versions.extension, detail: versions },
    { name: "permissions", ok: permissions === true, detail: permissions === true ? { permissions: REQUIRED_PERMISSIONS, origins: REQUIRED_ORIGINS } : permissions },
    { name: "inspectability", ok: access.inspectable, detail: access.reason || "inspectable" },
  ];
  if (access.inspectable) {
    try {
      const evaluated = await withDebugger(tab.id, owner, (target) => cdp(target, "Runtime.evaluate", { expression: "1 + 1", returnByValue: true }));
      checks.push({ name: "cdp-evaluation", ok: evaluated.result?.value === 2, detail: evaluated.result?.value });
    } catch (error) {
      checks.push({ name: "cdp-evaluation", ok: false, detail: errorMessage(error), recovery: error?.details?.recovery });
    }
  }
  return { ok: checks.every((check) => check.ok), versions, checks, inspectability: access };
}

async function locateElements(tabId, owner, params) {
  return withDebugger(tabId, owner, async (target) => {
    let { matches } = await semanticMatches(target, params, params.maxResults === undefined ? 50 : Math.max(0, Number(params.maxResults)));
    if (params.nth !== undefined) {
      const selected = selectSemanticMatch(matches, params.nth);
      matches = selected.outcome === "match" ? [selected.match] : [];
    }
    return { tabId, url: (await chrome.tabs.get(tabId)).url || "", matches };
  });
}

function semanticQuery(params) {
  return {
    role: String(params.role || ""),
    name: String(params.name || ""),
    text: String(params.targetText ?? params.text ?? ""),
    exact: Boolean(params.exact),
    nth: params.nth,
    within: params.within,
  };
}

function hasSemanticTarget(params) {
  const query = semanticQuery(params);
  return Boolean(query.role || query.name || query.text);
}

async function semanticScopeBackendIds(target, selectorValue) {
  if (!selectorValue) return null;
  const selector = checkedSelector(selectorValue);
  const { root } = await cdp(target, "DOM.getDocument", { depth: -1, pierce: true });
  const { nodeId } = await cdp(target, "DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`Semantic scope not found: ${selector}`);
  const { node } = await cdp(target, "DOM.describeNode", { nodeId, depth: -1, pierce: true });
  const ids = new Set();
  const collect = (current) => {
    if (!current) return;
    if (current.backendNodeId) ids.add(current.backendNodeId);
    for (const child of current.children || []) collect(child);
    collect(current.contentDocument);
    for (const shadow of current.shadowRoots || []) collect(shadow);
  };
  collect(node);
  return ids;
}

async function describeSemanticNodes(target, nodes) {
  const matches = [];
  for (const candidate of nodes) {
    const resolved = await cdp(target, "DOM.resolveNode", { backendNodeId: candidate.backendDOMNodeId }).catch(() => null);
    if (!resolved?.object?.objectId) continue;
    try {
      const details = await cdp(target, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        returnByValue: true,
        functionDeclaration: `function() {
          const el=this, unique=s=>{try{return document.querySelectorAll(s).length===1}catch{return false}}, esc=CSS.escape;
          const generated=v=>/[a-f0-9]{8,}|(?:^|[-_])\\d{4,}|css-[a-z0-9]{5,}/i.test(v||'');
          const candidates=[];
          for(const attr of ['data-testid','data-test','name','aria-label']){const value=el.getAttribute?.(attr);if(value)candidates.push({selector:el.tagName.toLowerCase()+'['+attr+'="'+esc(value)+'"]',stable:true});}
          if(el.id)candidates.unshift({selector:'#'+esc(el.id),stable:!generated(el.id)});
          let chosen=candidates.find(item=>unique(item.selector));
          if(!chosen){let node=el,parts=[];while(node&&node.nodeType===1&&parts.length<6){let part=node.tagName.toLowerCase();const siblings=[...(node.parentElement?.children||[])].filter(item=>item.tagName===node.tagName);if(siblings.length>1)part+=':nth-of-type('+(siblings.indexOf(node)+1)+')';parts.unshift(part);const selector=parts.join(' > ');if(unique(selector)){chosen={selector,stable:false};break;}node=node.parentElement;}}
          const rect=el.getBoundingClientRect(), style=getComputedStyle(el), className=typeof el.className==='string'?el.className:'';
          return {selector:chosen?.selector||null,selectorStable:Boolean(chosen?.stable),generated:generated(el.id)||generated(className),visible:rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none'&&style.opacity!=='0',enabled:!el.disabled&&el.getAttribute?.('aria-disabled')!=='true',tag:el.tagName,coordinates:{x:rect.left+rect.width/2,y:rect.top+rect.height/2}};
        }`,
      });
      matches.push({
        backendNodeId: candidate.backendDOMNodeId,
        role: candidate.role?.value,
        name: candidate.name?.value,
        value: candidate.value?.value,
        description: candidate.description?.value,
        ...details.result?.value,
      });
    } finally {
      await cdp(target, "Runtime.releaseObject", { objectId: resolved.object.objectId }).catch(() => {});
    }
  }
  return matches;
}

async function semanticMatches(target, params, limit = 50, includeNearby = true) {
  await Promise.all([cdp(target, "Accessibility.enable"), cdp(target, "DOM.enable")]);
  const [{ nodes = [] }, scope] = await Promise.all([
    cdp(target, "Accessibility.getFullAXTree"),
    semanticScopeBackendIds(target, params.within),
  ]);
  const query = semanticQuery(params);
  const role = normalizeSemanticValue(query.role);
  const matching = nodes.filter((node) => {
    if (!node.backendDOMNodeId || (scope && !scope.has(node.backendDOMNodeId))) return false;
    return semanticNodeMatches(node, query);
  });
  const uniqueMatching = [...new Map(matching.map((node) => [node.backendDOMNodeId, node])).values()];
  const fallback = uniqueMatching.length || !includeNearby ? [] : nodes.filter((node) => (
    node.backendDOMNodeId
    && (!scope || scope.has(node.backendDOMNodeId))
    && (!role || normalizeSemanticValue(node.role?.value) === role)
    && (node.name?.value || node.value?.value)
  )).slice(0, 10);
  const [matches, nearby] = await Promise.all([
    describeSemanticNodes(target, uniqueMatching.slice(0, limit)),
    describeSemanticNodes(target, fallback),
  ]);
  return { query, matches, nearby };
}

async function resolveSemanticTarget(target, params) {
  const { query, matches, nearby } = await semanticMatches(target, params);
  const selected = selectSemanticMatch(matches, params.nth);
  if (selected.outcome === "no-match") {
    throw commandError("No semantic target matched", { outcome: "no-match", query, candidates: nearby });
  }
  if (selected.outcome === "ambiguous") {
    throw commandError(`Semantic target is ambiguous (${matches.length} matches)`, {
      outcome: "ambiguous",
      query,
      count: matches.length,
      candidates: matches.slice(0, 10),
      recovery: "Add --exact, --within, or --nth=N.",
    });
  }
  if (selected.outcome === "out-of-range") {
    throw commandError(`Semantic match index ${params.nth} is out of range`, { outcome: "no-match", query, count: matches.length, candidates: matches.slice(0, 10) });
  }
  return selected.match;
}

function globRegex(value) {
  return new RegExp(`^${String(value).replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`, "i");
}

async function watchPage(tab, owner, params) {
  const startedAt = Date.now();
  const timeout = durationMs(params.duration, 30_000);
  if (params.urlChanges) {
    const before = tab.url || "";
    while (Date.now() - startedAt <= timeout) {
      const current = await chrome.tabs.get(tab.id);
      if ((current.url || "") !== before) return { matched: true, events: [{ type: "url", before, after: current.url || "" }], elapsedMs: Date.now() - startedAt };
      await sleep(100);
    }
    return { matched: false, events: [], elapsedMs: Date.now() - startedAt };
  }
  if (params.selector) {
    try {
      const matched = await waitForPage(tab.id, owner, { selector: params.selector, duration: timeout });
      return { matched: true, events: [{ type: "selector", selector: params.selector }], elapsedMs: matched.elapsedMs };
    } catch (error) {
      if (!errorMessage(error).startsWith("Condition did not match")) throw error;
      return { matched: false, events: [], elapsedMs: Date.now() - startedAt };
    }
  }
  if (params.request) {
    const capture = networkCaptures.get((await startNetwork(tab.id)).session);
    const pattern = globRegex(params.request);
    try {
      while (Date.now() - startedAt <= timeout) {
        const matches = [...capture.requests.values()].filter((request) => pattern.test(request.url));
        if (matches.length) return { matched: true, events: matches, elapsedMs: Date.now() - startedAt };
        await sleep(100);
      }
      return { matched: false, events: [], elapsedMs: Date.now() - startedAt };
    } finally {
      await stopNetwork(capture).catch(() => {});
    }
  }
  return watchConsole(tab.id, owner, params.console, timeout);
}

async function watchConsole(tabId, owner, level, timeout) {
  if (consoleCaptures.has(tabId)) throw new Error(`Tab ${tabId} already has a console capture`);
  const capture = { events: [], startedAt: Date.now() };
  const levels = level === "all" ? null : new Set(level === "warning" ? ["warning", "warn"] : ["error", "exception"]);
  consoleCaptures.set(tabId, capture);
  try {
    return await withDebugger(tabId, owner, async (target) => {
      await Promise.all([cdp(target, "Runtime.enable"), cdp(target, "Log.enable")]);
      while (Date.now() - capture.startedAt <= timeout) {
        const events = capture.events.filter((event) => !levels || levels.has(event.level) || levels.has(event.source));
        if (events.length) return { matched: true, events, elapsedMs: Date.now() - capture.startedAt };
        await sleep(100);
      }
      return { matched: false, events: [], elapsedMs: Date.now() - capture.startedAt };
    });
  } finally {
    consoleCaptures.delete(tabId);
  }
}

async function accessibilitySnapshot(tabId, owner, params) {
  return withDebugger(tabId, owner, async (target) => {
    await Promise.all([cdp(target, "Accessibility.enable"), cdp(target, "DOM.enable")]);
    const result = await cdp(target, "Accessibility.getFullAXTree", params.depth ? { depth: Number(params.depth) } : undefined);
    let nodes = result.nodes || [];
    if (params.selector) {
      const { root } = await cdp(target, "DOM.getDocument", { depth: -1, pierce: true });
      const { nodeId } = await cdp(target, "DOM.querySelector", { nodeId: root.nodeId, selector: checkedSelector(params.selector) });
      if (!nodeId) throw new Error("Element not found");
      const { node } = await cdp(target, "DOM.describeNode", { nodeId, depth: -1, pierce: true });
      const backendIds = new Set();
      const collect = (current) => {
        if (current.backendNodeId) backendIds.add(current.backendNodeId);
        for (const child of current.children || []) collect(child);
        if (current.contentDocument) collect(current.contentDocument);
        if (current.shadowRoots) for (const shadow of current.shadowRoots) collect(shadow);
      };
      collect(node);
      nodes = nodes.filter((item) => backendIds.has(item.backendDOMNodeId));
    }
    const role = String(params.role || "").toLowerCase();
    const name = String(params.name || "").toLowerCase();
    if (role) nodes = nodes.filter((node) => String(node.role?.value || "").toLowerCase().includes(role));
    if (name) nodes = nodes.filter((node) => String(node.name?.value || "").toLowerCase().includes(name));
    const total = nodes.length;
    const maxNodes = params.maxNodes === undefined ? Infinity : Math.max(0, Number(params.maxNodes));
    nodes = nodes.slice(0, maxNodes);
    if (params.compact) {
      nodes = nodes.map((node) => ({
        nodeId: node.nodeId,
        backendDOMNodeId: node.backendDOMNodeId,
        role: node.role?.value,
        name: node.name?.value,
        value: node.value?.value,
        description: node.description?.value,
        properties: Object.fromEntries((node.properties || []).map((property) => [property.name, property.value?.value])),
      }));
    }
    return { tabId, url: (await chrome.tabs.get(tabId)).url || "", nodes, total, returned: nodes.length, limited: nodes.length < total, compact: Boolean(params.compact) };
  });
}

async function pageDom(tabId, owner, params) {
  return withDebugger(tabId, owner, async (target) => {
    const selector = params.selector ? checkedSelector(params.selector) : null;
    const expression = selector
      ? `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('Element not found'); return el.outerHTML; })()`
      : "'<!doctype html>\\n' + document.documentElement.outerHTML";
    const result = await cdp(target, "Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "DOM evaluation failed");
    return { html: result.result?.value || "", url: (await chrome.tabs.get(tabId)).url, selector: selector || undefined };
  });
}

async function visibleText(tabId, owner, params) {
  return withDebugger(tabId, owner, async (target) => {
    const selector = params.selector ? checkedSelector(params.selector) : null;
    const result = await cdp(target, "Runtime.evaluate", {
      expression: selector
        ? `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('Element not found'); return el.innerText || ''; })()`
        : "document.body?.innerText || ''",
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Visible-text evaluation failed");
    return { tabId, url: (await chrome.tabs.get(tabId)).url || "", text: result.result?.value || "", selector: selector || undefined };
  });
}

async function screenshot(tabId, owner, params) {
  return withDebugger(tabId, owner, async (target) => {
    await cdp(target, "Page.enable");
    const format = params.format === "jpeg" ? "jpeg" : "png";
    let clip;
    let resolvedTarget;
    if (params.selector || hasSemanticTarget(params)) {
      const resolved = await resolveTargetObject(target, params);
      resolvedTarget = resolved.target;
      try {
        const measured = await cdp(target, "Runtime.callFunctionOn", {
          objectId: resolved.objectId,
          returnByValue: true,
          functionDeclaration: "function(){this.scrollIntoView({block:'center',inline:'center'});const r=this.getBoundingClientRect();return{x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height,scale:1};}",
        });
        if (measured.exceptionDetails) throw new Error(measured.exceptionDetails.exception?.description || "Element screenshot failed");
        clip = measured.result.value;
      } finally {
        await cdp(target, "Runtime.releaseObject", { objectId: resolved.objectId }).catch(() => {});
      }
    }
    const result = await cdp(target, "Page.captureScreenshot", {
      format,
      quality: format === "jpeg" ? Math.max(1, Math.min(100, Number(params.quality) || 85)) : undefined,
      captureBeyondViewport: params.fullPage !== false,
      clip,
    });
    return { data: result.data, format, tabId, url: (await chrome.tabs.get(tabId)).url || "", target: resolvedTarget };
  });
}

async function captureScreencast(tabId, owner, params) {
  if (screencastCollectors.has(tabId)) throw new Error(`Tab ${tabId} already has a screencast running`);
  const collector = { frames: [] };
  screencastCollectors.set(tabId, collector);
  try {
    return await withDebugger(tabId, owner, async (target) => {
      await cdp(target, "Page.enable");
      await cdp(target, "Page.startScreencast", {
        format: params.format === "png" ? "png" : "jpeg",
        quality: Math.max(1, Math.min(100, Number(params.quality) || 80)),
        maxWidth: params.width === undefined ? undefined : Number(params.width),
        maxHeight: params.height === undefined ? undefined : Number(params.height),
        everyNthFrame: Math.max(1, Number(params.everyNthFrame) || 1),
      });
      await sleep(durationMs(params.duration, 5_000));
      await cdp(target, "Page.stopScreencast");
      return { format: "cdp-screencast-frames", frames: collector.frames };
    });
  } finally {
    screencastCollectors.delete(tabId);
  }
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
    return params.valueOnly ? result.result?.value : result.result;
  });
}

async function extractPage(tabId, owner, params) {
  const item = checkedSelector(params.item);
  const within = params.within ? checkedSelector(params.within) : null;
  const schema = jsonValue(params.schema, {});
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || !Object.keys(schema).length) throw new Error("extract requires --schema as a non-empty JSON object");
  const limit = Math.max(0, Math.min(1_000, Number(params.limit ?? 100)));
  return withDebugger(tabId, owner, async (target) => {
    const result = await cdp(target, "Runtime.evaluate", {
      expression: `(() => {
        const itemSelector=${JSON.stringify(item)}, withinSelector=${JSON.stringify(within)}, schema=${JSON.stringify(schema)}, limit=${limit};
        const root=withinSelector?document.querySelector(withinSelector):document;
        if(!root) throw new Error('Extraction scope not found: '+withinSelector);
        const nodes=[...root.querySelectorAll(itemSelector)];
        const read=(item,specValue)=>{
          const spec=typeof specValue==='string'?{selector:specValue}:specValue||{};
          let node=spec.selector?item.querySelector(spec.selector):item;
          if(spec.closest) node=node?.closest(spec.closest);
          if(!node) return null;
          if(spec.attribute) return node.getAttribute(spec.attribute);
          const property=spec.property||'innerText';
          const value=node[property];
          return value===undefined?node.getAttribute(property):value;
        };
        const items=nodes.slice(0,limit).map(item=>Object.fromEntries(Object.entries(schema).map(([key,spec])=>[key,read(item,spec)])));
        return {items,total:nodes.length,returned:items.length,limited:items.length<nodes.length,url:location.href};
      })()`,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Extraction failed");
    return result.result?.value;
  });
}

function checkedSelector(value) {
  const selector = String(value || "");
  if (!selector) throw new Error("A selector is required");
  return selector;
}

async function elementPoint(target, selectorValue) {
  const selector = checkedSelector(selectorValue);
  const result = await cdp(target, "Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Element not found'); el.scrollIntoView({block:'center',inline:'center'}); const r = el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,tag:el.tagName,text:el.innerText||el.value||''}; })()`,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Element lookup failed");
  return result.result.value;
}

async function resolveTargetObject(target, params) {
  let result;
  let metadata;
  if (params.selector) {
    const selector = checkedSelector(params.selector);
    result = await cdp(target, "Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})`, returnByValue: false });
    metadata = { selector };
  } else {
    metadata = hasSemanticTarget(params) ? await resolveSemanticTarget(target, params) : { backendNodeId: Number(params.backendNodeId) };
    result = await cdp(target, "DOM.resolveNode", { backendNodeId: metadata.backendNodeId }).catch(() => null);
  }
  if (!result?.result?.objectId && !result?.object?.objectId) throw new Error("Target element was not found or is stale");
  return { objectId: result.result?.objectId || result.object.objectId, target: metadata };
}

async function targetPoint(target, params) {
  if (params.selector) return { point: await elementPoint(target, params.selector), target: { selector: params.selector } };
  if (params.backendNodeId !== undefined) return { point: await backendNodePoint(target, params.backendNodeId), target: { backendNodeId: Number(params.backendNodeId) } };
  if (hasSemanticTarget(params)) {
    const semantic = await resolveSemanticTarget(target, params);
    return { point: await backendNodePoint(target, semantic.backendNodeId), target: semantic };
  }
  return { point: { x: Number(params.x), y: Number(params.y) }, target: { x: Number(params.x), y: Number(params.y) } };
}

async function backendNodePoint(target, backendNodeIdValue) {
  const backendNodeId = Number(backendNodeIdValue);
  if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) throw new Error("--backend-node-id must be a positive integer");
  let model;
  let node;
  try {
    await cdp(target, "DOM.enable");
    await cdp(target, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
    [{ model }, { node }] = await Promise.all([
      cdp(target, "DOM.getBoxModel", { backendNodeId }),
      cdp(target, "DOM.describeNode", { backendNodeId }),
    ]);
  } catch {
    throw new Error(`Backend DOM node ${backendNodeId} is stale or unavailable; take a new snapshot and retry`);
  }
  const quad = model?.content || model?.border;
  if (!quad?.length) throw new Error(`Backend DOM node ${backendNodeId} has no clickable box`);
  const xs = quad.filter((_, index) => index % 2 === 0);
  const ys = quad.filter((_, index) => index % 2 === 1);
  return {
    x: xs.reduce((sum, value) => sum + value, 0) / xs.length,
    y: ys.reduce((sum, value) => sum + value, 0) / ys.length,
    backendNodeId,
    tag: node?.nodeName,
  };
}

async function click(tabId, owner, params) {
  const before = await chrome.tabs.get(tabId);
  let point;
  let resolvedTarget;
  let pressed = false;
  const clickCount = params.double ? 2 : 1;
  let outcome = "success";
  try {
    await withDebugger(tabId, owner, async (target) => {
      ({ point, target: resolvedTarget } = await targetPoint(target, params));
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("click requires --selector, --backend-node-id, or numeric --x and --y");
      await cdp(target, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount });
      pressed = true;
      await cdp(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount });
    });
  } catch (error) {
    if (!pressed || errorMessage(error) !== "Detached while handling command.") throw error;
    outcome = "unknown";
  }
  const waitResult = await waitForAction(tabId, owner, params).catch((error) => {
    if (outcome !== "unknown") throw error;
    return { matched: false, error: errorMessage(error) };
  });
  const current = waitResult ? await chrome.tabs.get(tabId) : await observeTab(tabId, before.url);
  return {
    ...point,
    clickCount,
    outcome,
    dispatchCompleted: outcome === "success",
    sideEffectMayHaveOccurred: pressed,
    beforeUrl: before.url || "",
    lastKnownUrl: current.url || "",
    title: current.title || "",
    target: resolvedTarget,
    wait: waitResult || undefined,
    recommendedAction: outcome === "unknown" ? "inspect-current-state" : undefined,
  };
}

async function typeText(tabId, owner, params) {
  const text = String(params.text ?? "");
  return withDebugger(tabId, owner, async (target) => {
    const resolved = await resolveTargetObject(target, { ...params, text: params.targetText });
    try {
      const focused = await cdp(target, "Runtime.callFunctionOn", {
        objectId: resolved.objectId,
        returnByValue: true,
        functionDeclaration: "function(){this.focus();if('select' in this)this.select();else if(this.isContentEditable)document.execCommand('selectAll');return{tag:this.tagName};}",
      });
      if (focused.exceptionDetails) throw new Error(focused.exceptionDetails.exception?.description || "Type failed");
      await cdp(target, "Input.insertText", { text });
      return { ...focused.result?.value, length: text.length, target: resolved.target };
    } finally {
      await cdp(target, "Runtime.releaseObject", { objectId: resolved.objectId }).catch(() => {});
    }
  });
}

async function typeFocused(tabId, owner, params) {
  const text = String(params.text ?? "");
  return withDebugger(tabId, owner, async (target) => {
    await cdp(target, "Input.insertText", { text });
    return { length: text.length };
  });
}

async function hover(tabId, owner, params) {
  return withDebugger(tabId, owner, async (target) => {
    const { point, target: resolvedTarget } = await targetPoint(target, params);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("hover requires --selector or numeric --x and --y");
    await cdp(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    return { ...point, target: resolvedTarget };
  });
}

async function drag(tabId, owner, params) {
  return withDebugger(tabId, owner, async (target) => {
    const from = params.fromSelector ? await elementPoint(target, params.fromSelector) : { x: Number(params.fromX), y: Number(params.fromY) };
    const to = params.toSelector ? await elementPoint(target, params.toSelector) : { x: Number(params.toX), y: Number(params.toY) };
    if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) throw new Error("drag requires from/to selectors or coordinates");
    let resolveDrag;
    const dragData = new Promise((resolve) => { resolveDrag = resolve; });
    dragResolvers.set(tabId, resolveDrag);
    await cdp(target, "Input.setInterceptDrags", { enabled: true });
    try {
      await cdp(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
      await cdp(target, "Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
      await cdp(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + 8, y: from.y + 8, button: "left", buttons: 1 });
      const data = await Promise.race([dragData, sleep(2_000).then(() => null)]);
      if (!data) throw new Error("The source element did not start an HTML drag operation");
      await cdp(target, "Input.dispatchDragEvent", { type: "dragEnter", x: to.x, y: to.y, data });
      await cdp(target, "Input.dispatchDragEvent", { type: "dragOver", x: to.x, y: to.y, data });
      await cdp(target, "Input.dispatchDragEvent", { type: "drop", x: to.x, y: to.y, data });
      return { from, to };
    } finally {
      dragResolvers.delete(tabId);
      await cdp(target, "Input.setInterceptDrags", { enabled: false }).catch(() => {});
      await cdp(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 }).catch(() => {});
    }
  });
}

function keySpec(value) {
  const parts = String(value || "").split("+").filter(Boolean);
  const requestedKey = parts.pop();
  if (!requestedKey) throw new Error("press-key requires --key");
  const modifierBits = { alt: 1, control: 2, ctrl: 2, meta: 4, command: 4, shift: 8 };
  const modifierKeys = parts.map((part) => ({ control: "Control", ctrl: "Control", meta: "Meta", command: "Meta", alt: "Alt", shift: "Shift" })[part.toLowerCase()]).filter(Boolean);
  const modifiers = parts.reduce((mask, part) => mask | (modifierBits[part.toLowerCase()] || 0), 0);
  const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32 };
  const key = requestedKey === "Space" ? " " : requestedKey.length === 1 ? requestedKey.toLowerCase() : requestedKey;
  const code = /^[a-z]$/i.test(requestedKey) ? `Key${requestedKey.toUpperCase()}` : /^\d$/.test(requestedKey) ? `Digit${requestedKey}` : requestedKey;
  return { key, code, modifiers, modifierKeys, windowsVirtualKeyCode: codes[requestedKey] || (requestedKey.length === 1 ? requestedKey.toUpperCase().charCodeAt(0) : 0) };
}

async function pressKey(tabId, owner, params) {
  const spec = keySpec(params.key);
  return withDebugger(tabId, owner, async (target) => {
    const { modifierKeys, ...mainKey } = spec;
    let activeModifiers = 0;
    const modifierSpecs = { Alt: { code: "AltLeft", bit: 1, windowsVirtualKeyCode: 18 }, Control: { code: "ControlLeft", bit: 2, windowsVirtualKeyCode: 17 }, Meta: { code: "MetaLeft", bit: 4, windowsVirtualKeyCode: 91 }, Shift: { code: "ShiftLeft", bit: 8, windowsVirtualKeyCode: 16 } };
    try {
      for (const key of modifierKeys) {
        const modifier = modifierSpecs[key];
        activeModifiers |= modifier.bit;
        await cdp(target, "Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: modifier.code, modifiers: activeModifiers, windowsVirtualKeyCode: modifier.windowsVirtualKeyCode });
      }
      await cdp(target, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...mainKey, modifiers: activeModifiers });
      await cdp(target, "Input.dispatchKeyEvent", { type: "keyUp", ...mainKey, modifiers: activeModifiers });
    } finally {
      for (const key of [...modifierKeys].reverse()) {
        const modifier = modifierSpecs[key];
        activeModifiers &= ~modifier.bit;
        await cdp(target, "Input.dispatchKeyEvent", { type: "keyUp", key, code: modifier.code, modifiers: activeModifiers, windowsVirtualKeyCode: modifier.windowsVirtualKeyCode }).catch(() => {});
      }
    }
    return spec;
  });
}

function jsonValue(value, fallback) {
  if (value === undefined) return fallback;
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function fillForm(tabId, owner, params) {
  const elements = jsonValue(params.elements, []);
  if (!Array.isArray(elements) || !elements.length) throw new Error("fill-form requires --elements as a JSON array");
  return withDebugger(tabId, owner, async (target) => {
    const filled = [];
    for (const item of elements) {
      if (!item || typeof item !== "object" || (!item.selector && !hasSemanticTarget(item))) throw new Error("Each fill-form item requires selector, role, name, or text");
      const resolved = await resolveTargetObject(target, item);
      try {
        const result = await cdp(target, "Runtime.callFunctionOn", {
          objectId: resolved.objectId,
          arguments: [{ value: item.value }],
          returnByValue: true,
          functionDeclaration: `function(value) {
            if(this.type==='checkbox'||this.type==='radio') this.checked=value===true||value==='true';
            else this.value=String(value??'');
            this.dispatchEvent(new Event('input',{bubbles:true}));
            this.dispatchEvent(new Event('change',{bubbles:true}));
            return {tag:this.tagName};
          }`,
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Form fill failed");
        filled.push({ ...result.result?.value, selector: item.selector, target: resolved.target });
      } finally {
        await cdp(target, "Runtime.releaseObject", { objectId: resolved.objectId }).catch(() => {});
      }
    }
    return filled;
  });
}

async function uploadFile(tabId, owner, params) {
  const files = jsonValue(params.files, params.file ? [params.file] : []);
  if (!Array.isArray(files) || !files.length) throw new Error("upload-file requires --file or --files");
  return withDebugger(tabId, owner, async (target) => {
    const resolved = await resolveTargetObject(target, params);
    try {
      await cdp(target, "DOM.setFileInputFiles", { objectId: resolved.objectId, files: files.map(String) });
      return { selector: params.selector, target: resolved.target, files };
    } finally {
      await cdp(target, "Runtime.releaseObject", { objectId: resolved.objectId }).catch(() => {});
    }
  });
}

async function waitForPage(tabId, owner, params) {
  const timeout = durationMs(params.duration ?? params.waitTimeout, 30_000);
  const deadline = Date.now() + timeout;
  const semantic = Boolean(params.role || params.name || params.targetText);
  const expression = semantic ? null : params.expression
    ? `Boolean(${params.expression})`
    : params.selector
      ? `Boolean(document.querySelector(${JSON.stringify(String(params.selector))}))`
      : `Boolean(document.body?.innerText.includes(${JSON.stringify(String(params.text || ""))}))`;
  while (Date.now() <= deadline) {
    if ((await chrome.tabs.get(tabId)).status === "loading") {
      await sleep(100);
      continue;
    }
    try {
      return await withDebugger(tabId, owner, async (target) => {
        while (Date.now() <= deadline) {
          if ((await chrome.tabs.get(tabId)).status === "loading") {
            await sleep(100);
            continue;
          }
          if (semantic) {
            const semanticParams = { ...params, text: params.targetText };
            const { query, matches } = await semanticMatches(target, semanticParams, 50, false);
            const state = params.state || "attached";
            if (state === "hidden" && (!matches.length || matches.every((match) => !match.visible))) {
              return { matched: true, elapsedMs: timeout - Math.max(0, deadline - Date.now()), target: null, query };
            }
            if (matches.length) {
              const selected = selectSemanticMatch(matches, params.nth);
              if (selected.outcome === "ambiguous") {
                throw commandError(`Semantic target is ambiguous (${matches.length} matches)`, {
                  outcome: "ambiguous", query, count: matches.length, candidates: matches.slice(0, 10), recovery: "Add --exact, --within, or --nth=N.",
                });
              }
              if (selected.outcome === "out-of-range") {
                throw commandError(`Semantic match index ${params.nth} is out of range`, { outcome: "no-match", query, count: matches.length, candidates: matches.slice(0, 10) });
              }
              const match = selected.match;
              const stateMatched = state === "attached"
                || (state === "visible" && match.visible)
                || (state === "enabled" && match.enabled)
                || (state === "disabled" && !match.enabled);
              if (stateMatched) return { matched: true, elapsedMs: timeout - Math.max(0, deadline - Date.now()), target: match };
            } else if (state !== "hidden" && Date.now() + 100 > deadline) {
              const { nearby } = await semanticMatches(target, semanticParams, 50, true);
              throw commandError(`Semantic condition did not match within ${timeout}ms`, { outcome: "no-match", query, candidates: nearby });
            }
          } else {
            const result = await cdp(target, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Wait expression failed");
            if (result.result?.value) return { matched: true, elapsedMs: timeout - Math.max(0, deadline - Date.now()) };
          }
          await sleep(100);
        }
        throw new Error(`Condition did not match within ${timeout}ms`);
      });
    } catch (error) {
      if (errorMessage(error) !== "Detached while handling command." || !(await chrome.tabs.get(tabId).catch(() => null))) throw error;
    }
  }
  throw new Error(`Condition did not match within ${timeout}ms`);
}

async function handleDialog(tabId, owner, params) {
  return withDebugger(tabId, owner, async (target) => {
    await cdp(target, "Page.handleJavaScriptDialog", { accept: String(params.action || "accept") !== "dismiss", promptText: params.promptText === undefined ? undefined : String(params.promptText) });
    return { action: params.action || "accept" };
  });
}

async function resizePage(tabId, owner, params) {
  const width = Number(params.width);
  const height = Number(params.height);
  if (!(width > 0 && height > 0)) throw new Error("resize requires positive --width and --height");
  const hadEmulation = emulationOwners.has(tabId);
  const target = await emulationTarget(tabId);
  try {
    await cdp(target, "Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: Number(params.deviceScaleFactor) || 1, mobile: Boolean(params.mobile) });
    const ttlMs = scheduleEmulationCleanup(tabId, params.ttl);
    return { width, height, persistent: true, ...(ttlMs === null ? {} : { ttlMs }) };
  } catch (error) {
    if (!hadEmulation) {
      const emulationOwner = emulationOwners.get(tabId);
      emulationOwners.delete(tabId);
      await detach(tabId, emulationOwner);
    }
    throw error;
  }
}

async function emulatePage(tabId, owner, params) {
  const hadEmulation = emulationOwners.has(tabId);
  const target = await emulationTarget(tabId);
  try {
    if (params.clear) {
      await clearEmulation(tabId);
      return { cleared: true };
    }
    if (params.viewport) {
      const match = String(params.viewport).match(/^(\d+)x(\d+)(?:x([\d.]+))?$/);
      if (!match) throw new Error("--viewport must be WIDTHxHEIGHT or WIDTHxHEIGHTxDPR");
      await cdp(target, "Emulation.setDeviceMetricsOverride", { width: Number(match[1]), height: Number(match[2]), deviceScaleFactor: Number(match[3] || 1), mobile: Boolean(params.mobile) });
    }
    if (params.cpu !== undefined) await cdp(target, "Emulation.setCPUThrottlingRate", { rate: Math.max(1, Number(params.cpu)) });
    if (params.latitude !== undefined || params.longitude !== undefined) await cdp(target, "Emulation.setGeolocationOverride", { latitude: Number(params.latitude), longitude: Number(params.longitude), accuracy: Number(params.accuracy) || 1 });
    if (params.userAgent !== undefined) await cdp(target, "Emulation.setUserAgentOverride", { userAgent: String(params.userAgent) });
    if (params.colorScheme) await cdp(target, "Emulation.setEmulatedMedia", { features: params.colorScheme === "auto" ? [] : [{ name: "prefers-color-scheme", value: String(params.colorScheme) }] });
    if (params.headers !== undefined) await cdp(target, "Network.setExtraHTTPHeaders", { headers: jsonValue(params.headers, {}) });
    if ([params.offline, params.latency, params.download, params.upload].some((value) => value !== undefined)) {
      await cdp(target, "Network.emulateNetworkConditions", { offline: Boolean(params.offline), latency: Number(params.latency) || 0, downloadThroughput: params.download === undefined ? -1 : Number(params.download), uploadThroughput: params.upload === undefined ? -1 : Number(params.upload) });
    }
    const ttlMs = scheduleEmulationCleanup(tabId, params.ttl);
    return { configured: true, persistent: true, ...(ttlMs === null ? {} : { ttlMs }) };
  } catch (error) {
    if (!params.clear && !hadEmulation) {
      const emulationOwner = emulationOwners.get(tabId);
      emulationOwners.delete(tabId);
      await detach(tabId, emulationOwner);
    }
    throw error;
  }
}

function scheduleEmulationCleanup(tabId, ttl) {
  clearTimeout(emulationTimers.get(tabId));
  emulationTimers.delete(tabId);
  if (ttl === undefined) return null;
  const ttlMs = durationMs(ttl);
  emulationTimers.set(tabId, setTimeout(() => clearEmulation(tabId).catch(() => {}), ttlMs));
  return ttlMs;
}

async function clearEmulation(tabId) {
  if (!emulationOwners.has(tabId)) await emulationTarget(tabId);
  const target = { tabId };
  await Promise.allSettled([
    cdp(target, "Emulation.clearDeviceMetricsOverride"),
    cdp(target, "Emulation.clearGeolocationOverride"),
    cdp(target, "Emulation.setCPUThrottlingRate", { rate: 1 }),
    cdp(target, "Emulation.setEmulatedMedia", { features: [] }),
    cdp(target, "Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }),
    cdp(target, "Network.setExtraHTTPHeaders", { headers: {} }),
  ]);
  clearTimeout(emulationTimers.get(tabId));
  emulationTimers.delete(tabId);
  const emulationOwner = emulationOwners.get(tabId);
  emulationOwners.delete(tabId);
  await detach(tabId, emulationOwner);
}

async function emulationTarget(tabId) {
  if (!emulationOwners.has(tabId)) {
    const owner = `emulation:${tabId}`;
    await attach(tabId, owner);
    emulationOwners.set(tabId, owner);
  }
  return { tabId };
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
  if (networkCaptureByTab.has(tabId)) {
    const sessionId = networkCaptureByTab.get(tabId);
    throw commandError(`Tab ${tabId} already has an active network capture`, {
      blockedBy: "network-capture",
      sessionId,
      recovery: `chrome-bridge network stop --tab=${tabId} --session=${sessionId}`,
    });
  }
  const id = crypto.randomUUID();
  const tab = await chrome.tabs.get(tabId);
  const capture = {
    id,
    tabId,
    tabTitle: tab.title || tab.url || "Untitled tab",
    tabUrl: tab.url || "",
    owner: `network:${id}`,
    startedAt: Date.now(),
    stoppedAt: null,
    requests: new Map(),
    webSockets: [],
    pending: [],
    includeBodies: Boolean(params.bodies),
    urlFilter: String(params.urlFilter || "").toLowerCase(),
    lastEventAt: Date.now(),
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
  networkCaptures.set(id, capture);
  networkCaptureByTab.set(tabId, id);
  const lease = params.ttl ?? params.maxDuration;
  const ttlMs = lease === undefined ? null : durationMs(lease);
  capture.ttlMs = ttlMs;
  capture.expiresAt = ttlMs === null ? null : Date.now() + ttlMs;
  if (ttlMs !== null) capture.timer = setTimeout(() => stopNetwork(capture).catch(() => {}), ttlMs);
  scheduleStatusBroadcast();
  return { session: id, tabId, startedAt: new Date(capture.startedAt).toISOString(), ttlMs, expiresAt: capture.expiresAt ? new Date(capture.expiresAt).toISOString() : null, bodiesRequested: capture.includeBodies };
}

async function captureNetwork(tabId, params = {}) {
  const started = await startNetwork(tabId, params);
  const capture = networkCaptures.get(started.session);
  try {
    if (params.reload) await chrome.tabs.reload(tabId);
    const wait = params.wait === "network-idle"
      ? await waitForNetworkIdle(capture, durationMs(params.duration, 10_000))
      : (await sleep(durationMs(params.duration)), { mode: "duration", matched: true, elapsedMs: durationMs(params.duration) });
    const result = await stopNetwork(capture, Boolean(params.har));
    const records = [...capture.requests.values()];
    const metadata = {
      initialLoadCaptured: Boolean(params.reload),
      bodiesRequested: Boolean(params.bodies),
      bodiesCaptured: records.filter((record) => "body" in record).length,
      bodyCaptureErrors: records.filter((record) => record.bodyError).length,
      wait,
    };
    if (params.har) return { ...result, chromeBridge: metadata };
    return { ...presentNetwork(result, params), ...metadata };
  } catch (error) {
    await stopNetwork(capture).catch(() => {});
    throw error;
  }
}

async function waitForNetworkIdle(capture, timeout) {
  // ponytail: 500 ms quiet window; add a configurable idle window if long-polling apps need different semantics.
  const startedAt = Date.now();
  const deadline = startedAt + timeout;
  while (Date.now() <= deadline) {
    const tab = await chrome.tabs.get(capture.tabId);
    const pending = [...capture.requests.values()].filter((record) => !record.finishedTimestamp && !record.failed).length;
    if (tab.status === "complete" && pending === 0 && Date.now() - capture.lastEventAt >= 500) {
      return { mode: "network-idle", matched: true, elapsedMs: Date.now() - startedAt, quietMs: 500 };
    }
    await sleep(100);
  }
  return { mode: "network-idle", matched: false, elapsedMs: Date.now() - startedAt, pendingRequests: [...capture.requests.values()].filter((record) => !record.finishedTimestamp && !record.failed).length };
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
    url: capture.tabUrl,
    startedAt: new Date(capture.startedAt).toISOString(),
    stoppedAt: capture.stoppedAt ? new Date(capture.stoppedAt).toISOString() : null,
    expiresAt: capture.expiresAt ? new Date(capture.expiresAt).toISOString() : null,
    active: !capture.stoppedAt,
    bodiesRequested: capture.includeBodies,
    bodiesCaptured: [...capture.requests.values()].filter((record) => "body" in record).length,
    bodyCaptureErrors: [...capture.requests.values()].filter((record) => record.bodyError).length,
    requests: [...capture.requests.values()],
    webSockets: capture.webSockets,
  };
}

function presentNetwork(snapshot, params = {}) {
  if (params.websockets) {
    const { requests, ...metadata } = snapshot;
    return { ...metadata, webSockets: snapshot.webSockets };
  }

  let requests = snapshot.requests;
  if (params.errorsOnly) requests = requests.filter((record) => record.failed || Number(record.status) >= 400);
  if (params.eventStream) requests = requests.filter((record) => {
    const contentType = record.mimeType || record.responseHeaders?.["content-type"] || record.responseHeaders?.["Content-Type"] || "";
    return String(contentType).toLowerCase().includes("text/event-stream");
  });
  if (!params.graphql) return { ...snapshot, requests };

  const groups = new Map();
  for (const record of requests) {
    const operationNames = graphqlOperationNames(record);
    for (const operationName of operationNames) {
      const group = groups.get(operationName) || { operationName, count: 0, requests: [] };
      group.count += 1;
      group.requests.push(record);
      groups.set(operationName, group);
    }
  }
  const { requests: ignored, ...metadata } = snapshot;
  return { ...metadata, graphqlOperations: [...groups.values()] };
}

function graphqlOperationNames(record) {
  if (!record.postData) return ["anonymous"];
  try {
    const parsed = JSON.parse(record.postData);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries.map((entry) => String(entry?.operationName || "anonymous"));
  } catch {
    const match = String(record.postData).match(/\b(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    return [match?.[1] || "anonymous"];
  }
}

async function networkGetBody(capture, requestId, params) {
  if (capture.stoppedAt) throw new Error("Response bodies are only available while the capture is attached");
  const record = capture.requests.get(String(requestId)) || [...capture.requests.values()].find((item) => item.requestId === String(requestId));
  if (!record) throw new Error("Unknown request id for this capture");
  const result = await getResponseBody(capture, record, params);
  if (!params.pretty || result.base64Encoded) return result;
  try {
    return { ...result, parsed: JSON.parse(result.body) };
  } catch {
    return { ...result, prettyError: "Response body is not valid JSON" };
  }
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
  if (!/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(method)) throw new Error("A CDP method such as Runtime.evaluate is required");
  return method;
}

async function rawCdp(tab, owner, params) {
  const method = cdpMethod(params);
  const commandParams = typeof params.params === "string" ? JSON.parse(params.params) : (params.params || {});
  const persistent = params.bridgeSession && manualCdpSessions.get(String(params.bridgeSession));
  if (params.bridgeSession && !persistent) throw new Error("Unknown CDP bridge session");
  const root = persistent?.target || (params.target ? { targetId: String(params.target) } : { tabId: tab.id });
  const target = params.sessionId ? { ...root, sessionId: String(params.sessionId) } : root;
  if (persistent) return cdp(target, method, commandParams);
  return withRawDebugger(root, owner, async () => cdp(target, method, commandParams));
}

async function startCdpSession(tab, params) {
  const id = crypto.randomUUID();
  const target = params.target ? { targetId: String(params.target) } : { tabId: tab.id };
  const owner = `cdp-session:${id}`;
  if (target.tabId !== undefined) await attach(target.tabId, owner);
  else {
    const existing = (await chrome.debugger.getTargets()).find((candidate) => candidate.id === target.targetId && candidate.attached);
    if (existing) throw new Error(`Target ${target.targetId} is already attached to another debugger client`);
    await chrome.debugger.attach(target, PROTOCOL_VERSION);
  }
  const ttlMs = params.ttl === undefined ? null : durationMs(params.ttl);
  const session = { id, target, owner, startedAt: Date.now(), ttlMs };
  manualCdpSessions.set(id, session);
  if (ttlMs !== null) session.timer = setTimeout(() => stopCdpSession(id).catch(() => {}), ttlMs);
  scheduleStatusBroadcast();
  return { session: id, target, startedAt: new Date(session.startedAt).toISOString(), ...(ttlMs === null ? {} : { ttlMs, expiresAt: new Date(session.startedAt + ttlMs).toISOString() }) };
}

async function stopCdpSession(idValue) {
  const id = String(idValue || "");
  const session = manualCdpSessions.get(id);
  if (!session) throw new Error("cdp session stop requires a valid --bridge-session");
  manualCdpSessions.delete(id);
  clearTimeout(session.timer);
  if (session.target.tabId !== undefined) await detach(session.target.tabId, session.owner);
  else await chrome.debugger.detach(session.target).catch(() => {});
  scheduleStatusBroadcast();
  return { stopped: true, session: id, target: session.target };
}

async function captureCdpEvents(tab, owner, params) {
  const domain = String(params.domain || "");
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(domain)) throw new Error("A CDP --domain is required");
  const persistent = params.bridgeSession && manualCdpSessions.get(String(params.bridgeSession));
  if (params.bridgeSession && !persistent) throw new Error("Unknown CDP bridge session");
  const target = persistent?.target || (params.target ? { targetId: String(params.target) } : { tabId: tab.id });
  const key = debuggeeKey(target);
  if (eventCollectors.has(key)) throw new Error(`${key} already has a raw event capture`);
  const collector = { domain, events: [] };
  eventCollectors.set(key, collector);
  try {
    const run = async () => {
      await cdp(target, `${domain}.enable`, jsonValue(params.enableParams, {})).catch(() => {});
      await sleep(durationMs(params.duration, 5_000));
      return collector.events;
    };
    return persistent ? run() : withRawDebugger(target, owner, run);
  } finally {
    eventCollectors.delete(key);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const collector = eventCollectors.get(debuggeeKey(source));
  if (collector && method.startsWith(`${collector.domain}.`)) collector.events.push({ method, params, source, at: new Date().toISOString() });

  const tabId = source.tabId;
  if (!tabId) return;

  if (method === "Input.dragIntercepted") dragResolvers.get(tabId)?.(params.data);

  const captureId = networkCaptureByTab.get(tabId);
  const capture = captureId && networkCaptures.get(captureId);
  if (capture && method === "Target.attachedToTarget") handleAttachedTarget(capture, params);
  if (capture && method.startsWith("Network.")) handleNetworkEvent(capture, source, method, params);

  const consoleCapture = consoleCaptures.get(tabId);
  if (consoleCapture) handleConsoleEvent(consoleCapture, method, params);

  const scripts = scriptCollectors.get(tabId);
  if (scripts && method === "Debugger.scriptParsed") scripts.push(params);

  const trace = traceCollectors.get(tabId);
  if (trace && method === "Tracing.tracingComplete") trace.resolve(params.stream);

  const screencast = screencastCollectors.get(tabId);
  if (screencast && method === "Page.screencastFrame") {
    screencast.frames.push({ data: params.data, metadata: params.metadata, sessionId: params.sessionId });
    cdp({ tabId }, "Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) {
    emulationOwners.delete(source.tabId);
    clearTimeout(emulationTimers.get(source.tabId));
    emulationTimers.delete(source.tabId);
  }
  for (const [id, session] of manualCdpSessions) {
    if (debuggeeKey(session.target) === debuggeeKey(source)) {
      clearTimeout(session.timer);
      manualCdpSessions.delete(id);
    }
  }
  scheduleStatusBroadcast();
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
  capture.lastEventAt = Date.now();
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
    activity.networkRequests += 1;
    activity.lastNetworkAt = Date.now();
    scheduleStatusBroadcast();
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
    activity.networkBytes += Number(params.encodedDataLength) || 0;
    activity.lastNetworkAt = Date.now();
    scheduleStatusBroadcast();
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
    activity.webSocketFrames += 1;
    activity.lastNetworkAt = Date.now();
    scheduleStatusBroadcast();
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
    if (capture) {
      capture.stoppedAt = Date.now();
      clearTimeout(capture.timer);
      networkCaptures.delete(captureId);
    }
    networkCaptureByTab.delete(source.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  detachAll(tabId).catch(() => {});
});

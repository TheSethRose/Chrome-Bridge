const connection = document.querySelector("#connection");
const running = document.querySelector("#running");
const attachments = document.querySelector("#attachments");
const requests = document.querySelector("#requests");
const captures = document.querySelector("#captures");
const captureList = document.querySelector("#capture-list");
const activitySummary = document.querySelector("#activity-summary");
const commands = document.querySelector("#commands");
const updated = document.querySelector("#updated");
const clearLogs = document.querySelector("#clear-logs");
const logPort = chrome.runtime.connect({ name: "bridge-log-viewer" });
const logCache = new Map();
const logLoads = new Map();
const logStreams = new Map();
const expandedLogs = new Set();
const STRING_PAGE = 1_500;
const COLLECTION_PAGE = 50;
let commandSignature = "";

function replaceChildren(parent, children) {
  parent.replaceChildren(...children);
}

function decodeChunk(data, decoder) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return decoder.decode(bytes, { stream: true });
}

function parsed(raw) {
  try { return JSON.parse(raw); }
  catch { return raw; }
}

function loadLog(id) {
  if (logCache.has(id)) return Promise.resolve(logCache.get(id));
  if (logLoads.has(id)) return logLoads.get(id);

  const promise = new Promise((resolve, reject) => {
    logStreams.set(id, {
      chunks: { request: [], response: [] },
      decoders: { request: new TextDecoder(), response: new TextDecoder() },
      errors: {},
      resolve,
      reject,
    });
    logPort.postMessage({ type: "readLog", id });
  });
  logLoads.set(id, promise);
  return promise;
}

logPort.onMessage.addListener((message) => {
  const stream = logStreams.get(message?.id);
  if (!stream) return;
  if (message.type === "logChunk") {
    stream.chunks[message.part].push(decodeChunk(message.data, stream.decoders[message.part]));
  } else if (message.type === "logPartEnd") {
    stream.chunks[message.part].push(stream.decoders[message.part].decode());
  } else if (message.type === "logPartError") {
    stream.errors[message.part] = message.error;
  } else if (message.type === "logEnd") {
    const data = {
      request: stream.chunks.request.join(""),
      response: stream.chunks.response.join(""),
      errors: stream.errors,
    };
    logCache.set(message.id, data);
    logStreams.delete(message.id);
    stream.resolve(data);
  }
});

function icon(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", kind === "check"
    ? "M20 6 9 17l-5-5"
    : "M8 8h11v11H8zM5 16H4V5h11v1");
  svg.append(path);
  return svg;
}

function button(label, onClick) {
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = label;
  control.addEventListener("click", onClick);
  return control;
}

function scalarValue(value) {
  const cell = document.createElement("div");
  cell.className = `kv-value type-${value === null ? "null" : typeof value}`;
  if (typeof value !== "string" || value.length <= STRING_PAGE) {
    cell.textContent = value === null ? "null" : String(value);
    return cell;
  }

  let page = 0;
  const text = document.createElement("span");
  const controls = document.createElement("div");
  const previous = button("Previous", () => { page -= 1; draw(); });
  const next = button("Next", () => { page += 1; draw(); });
  const position = document.createElement("span");
  controls.className = "value-pager";
  controls.append(previous, position, next);
  const draw = () => {
    const start = page * STRING_PAGE;
    const end = Math.min(value.length, start + STRING_PAGE);
    text.textContent = value.slice(start, end);
    position.textContent = `${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${value.length.toLocaleString()} characters`;
    previous.disabled = page === 0;
    next.disabled = end === value.length;
  };
  draw();
  cell.append(text, controls);
  return cell;
}

function valueRow(key, value) {
  if (value && typeof value === "object") return collectionRow(key, value);
  const row = document.createElement("div");
  const name = document.createElement("div");
  name.className = "kv-key";
  name.textContent = key;
  row.className = "kv-row";
  row.append(name, scalarValue(value));
  return row;
}

function collectionRow(key, value) {
  const disclosure = document.createElement("details");
  const summary = document.createElement("summary");
  const name = document.createElement("span");
  const meta = document.createElement("span");
  const children = document.createElement("div");
  const entries = Object.entries(value);
  const type = Array.isArray(value) ? "Array" : "Object";
  let rendered = false;
  name.className = "kv-key";
  name.textContent = key;
  meta.className = "kv-meta";
  meta.textContent = `${type} · ${entries.length.toLocaleString()} ${Array.isArray(value) ? "items" : "keys"}`;
  children.className = "kv-children";
  summary.append(name, meta);
  disclosure.className = "kv-group";
  disclosure.append(summary, children);
  disclosure.addEventListener("toggle", () => {
    if (!disclosure.open || rendered) return;
    rendered = true;
    renderCollection(children, entries);
  });
  return disclosure;
}

function renderCollection(container, entries) {
  let page = 0;
  const draw = () => {
    const start = page * COLLECTION_PAGE;
    const end = Math.min(entries.length, start + COLLECTION_PAGE);
    const rows = entries.slice(start, end).map(([key, value]) => valueRow(key, value));
    if (entries.length > COLLECTION_PAGE) {
      const pager = document.createElement("div");
      const previous = button("Previous", () => { page -= 1; draw(); });
      const next = button("Next", () => { page += 1; draw(); });
      const position = document.createElement("span");
      pager.className = "collection-pager";
      position.textContent = `${start + 1}–${end} of ${entries.length.toLocaleString()}`;
      previous.disabled = page === 0;
      next.disabled = end === entries.length;
      pager.append(previous, position, next);
      rows.push(pager);
    }
    replaceChildren(container, rows);
  };
  draw();
}

function dataSection(label, part, data) {
  const section = document.createElement("section");
  const title = document.createElement("h3");
  const values = document.createElement("div");
  title.textContent = label;
  values.className = "kv-list";
  if (data.errors[part]) {
    values.append(valueRow("error", data.errors[part]));
  } else {
    const value = parsed(data[part]);
    renderCollection(values, value && typeof value === "object" ? Object.entries(value) : [["value", value]]);
  }
  section.append(title, values);
  return section;
}

function renderLogData(container, data) {
  replaceChildren(container, [
    dataSection("Sent to Chrome", "request", data),
    dataSection("Received from Chrome", "response", data),
  ]);
}

async function copyLog(entry, button) {
  button.disabled = true;
  try {
    const data = await loadLog(entry.id);
    await navigator.clipboard.writeText(JSON.stringify({
      sent: data.errors.request ? data.errors.request : parsed(data.request),
      received: data.errors.response ? data.errors.response : parsed(data.response),
    }, null, 2));
    button.replaceChildren(icon("check"));
    button.classList.add("copied");
    button.setAttribute("aria-label", `Copied ${entry.command} data`);
    setTimeout(() => {
      button.replaceChildren(icon("copy"));
      button.classList.remove("copied");
      button.setAttribute("aria-label", `Copy ${entry.command} request and response`);
    }, 1_200);
  } finally {
    button.disabled = false;
  }
}

function commandRow(entry) {
  const item = document.createElement("li");
  const disclosure = document.createElement("details");
  const summary = document.createElement("summary");
  const title = document.createElement("code");
  const tab = document.createElement("span");
  const state = document.createElement("span");
  const copy = document.createElement("button");
  const body = document.createElement("div");
  const entryKey = entry.id || `${entry.at}:${entry.command}`;
  const tabTitle = entry.tabTitle || entry.origin || "Browser";

  item.className = `command ${entry.status === "error" ? "error" : ""}`;
  disclosure.className = "command-disclosure";
  disclosure.open = expandedLogs.has(entryKey);
  title.textContent = entry.command;
  title.className = "command-name";
  tab.textContent = tabTitle;
  tab.title = tabTitle;
  tab.className = "tab-name";
  state.textContent = entry.status;
  state.className = "command-state";
  copy.type = "button";
  copy.className = "copy-log";
  copy.setAttribute("aria-label", `Copy ${entry.command} request and response`);
  copy.append(icon("copy"));
  body.className = "log-detail";
  summary.append(title, tab, state, copy);
  disclosure.append(summary, body);
  item.append(disclosure);

  const show = async () => {
    if (!entry.id) {
      body.textContent = "Request and response details are available for commands run after this extension update.";
      return;
    }
    body.classList.add("loading");
    body.textContent = "Loading complete request and response…";
    try { renderLogData(body, await loadLog(entry.id)); }
    catch (error) { body.textContent = error.message; }
    finally { body.classList.remove("loading"); }
  };
  disclosure.addEventListener("toggle", () => {
    if (disclosure.open) {
      for (const other of commands.querySelectorAll(".command-disclosure[open]")) {
        if (other !== disclosure) other.open = false;
      }
      expandedLogs.add(entryKey);
      show();
    } else {
      expandedLogs.delete(entryKey);
    }
  });
  copy.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (entry.id) copyLog(entry, copy).catch(() => {});
  });
  if (!entry.id) copy.disabled = true;
  if (disclosure.open) show();
  return item;
}

function renderCommands(entries) {
  const signature = JSON.stringify(entries.map(({ id, status, tabTitle, command }) => [id, status, tabTitle, command]));
  if (signature === commandSignature) return;
  commandSignature = signature;
  const items = entries.map(commandRow);
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No commands yet.";
    items.push(empty);
  }
  replaceChildren(commands, items);
}

function render(status) {
  const online = status.bridgeOnline && status.nativeConnected;
  const activeCommands = status.activeCommands || [];
  const activeCaptures = status.activeCaptures || [];
  const stats = status.activity || {};
  connection.textContent = online ? "Connected" : "Disconnected";
  connection.className = `status ${online ? "online" : "offline"}`;
  running.textContent = String(activeCommands.length);
  attachments.textContent = String((status.attachedTabs || []).length);
  requests.textContent = Number(stats.networkRequests || 0).toLocaleString();
  captures.textContent = String(activeCaptures.length);
  activitySummary.textContent = `${Number(stats.commandsCompleted || 0).toLocaleString()} completed · ${Number(stats.commandsFailed || 0).toLocaleString()} failed · ${formatBytes(stats.networkBytes || 0)} captured · ${Number(stats.webSocketFrames || 0).toLocaleString()} WebSocket frames`;

  const liveItems = activeCommands.map((command) => {
    const item = document.createElement("div");
    const title = document.createElement("strong");
    const details = document.createElement("span");
    const tabTitle = command.tabTitle || (command.tabId ? `Tab ${command.tabId}` : command.targetId ? `Target ${command.targetId}` : "Browser");
    title.textContent = `${command.command} · ${tabTitle}`;
    title.title = title.textContent;
    details.textContent = `Running · started ${new Date(command.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
    item.append(title, details);
    return item;
  });
  liveItems.push(...activeCaptures.map((capture) => {
    const item = document.createElement("div");
    const title = document.createElement("strong");
    const details = document.createElement("span");
    title.textContent = `Network · ${capture.tabTitle || "Active tab"}`;
    title.title = capture.tabTitle || "";
    details.textContent = `${capture.requests.toLocaleString()} requests · ${capture.webSocketFrames.toLocaleString()} WebSocket frames`;
    item.append(title, details);
    return item;
  }));
  if (!liveItems.length) {
    const empty = document.createElement("p");
    empty.className = "live-empty";
    empty.textContent = "No command or capture is running. Start a network capture to watch requests here.";
    liveItems.push(empty);
  }
  replaceChildren(captureList, liveItems);

  renderCommands(status.recentCommands);
  updated.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

async function refresh() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "bridge-status" });
    if (!response?.ok) throw new Error(response?.error || "Status unavailable");
    render(response.status);
  } catch {
    connection.textContent = "Unavailable";
    connection.className = "status offline";
  }
}

clearLogs.addEventListener("click", async () => {
  clearLogs.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "bridge-clear-logs" });
    if (!response?.ok) throw new Error(response?.error || "Unable to clear logs");
    logCache.clear();
    logLoads.clear();
    logStreams.clear();
    expandedLogs.clear();
    commandSignature = "";
    render(response.status);
  } finally {
    clearLogs.disabled = false;
  }
});

refresh();
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "bridge-status-update") render(message.status);
});

import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { normalizeCommand, parseArguments, parseDuration } from "./bin/chrome-bridge.mjs";
import { decodeNativeMessages, encodeNativeMessage } from "./native-host/host.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const execFile = promisify(execFileCallback);
const read = (file) => readFile(path.join(root, file), "utf8");
const manifest = JSON.parse(await read("extension/manifest.json"));
const background = await read("extension/background.js");
const skill = await read("skill/chrome-bridge/SKILL.md");
const skillCommands = await read("skill/chrome-bridge/references/commands.md");
const skillData = await read("skill/chrome-bridge/references/data-and-state.md");
const skillWorkflows = await read("skill/chrome-bridge/references/workflows.md");
const xSkill = await read("skill/x-chrome-bridge/SKILL.md");
const xSkillMetadata = await read("skill/x-chrome-bridge/agents/openai.yaml");
const linkedinSkill = await read("skill/linkedin-chrome-bridge/SKILL.md");
const linkedinSkillMetadata = await read("skill/linkedin-chrome-bridge/agents/openai.yaml");
const cliSource = await read("bin/chrome-bridge.mjs");
const sidepanelHtml = await read("extension/sidepanel.html");
const sidepanelScript = await read("extension/sidepanel.js");
const sidepanelCss = await read("extension/sidepanel.css");

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.type, "module");
assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'; base-uri 'none'");
assert.ok(!manifest.externally_connectable, "web pages must not be allowed to message the extension");
assert.equal(manifest.side_panel.default_path, "sidepanel.html");
assert.equal(manifest.action.default_title, "Chrome Bridge status");
for (const permission of ["debugger", "nativeMessaging", "tabs", "storage", "cookies", "history", "bookmarks", "downloads", "management", "sessions", "tabGroups", "topSites"]) {
  assert.ok(manifest.permissions.includes(permission), `missing ${permission} permission`);
}
assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
assert.doesNotMatch(background, /AUTHORIZATION_MS|pairingSecret|ensureAuthorized|authorizeTab|requestApproval|requireCapability|readOnly|redact|truncate|MAX_REQUESTS|MAX_EVENTS/);
assert.doesNotMatch(background, /\brandomId\(/, "network sessions must use a defined browser-native ID source");
assert.doesNotMatch(background, /cdp\([^\n]+"Target\.getTargets"/, "target inventory must use chrome.debugger.getTargets, which MV3 permits");
assert.doesNotMatch(cliSource, /pairing-code|pairingCode|readSecret|redact/);
assert.match(background, /requestChunk/);
assert.match(background, /responseChunk/);
assert.match(background, /bridge-status-update/);
assert.match(background, /bridge-clear-logs/);
assert.match(background, /bridge-reconnect/);
assert.match(background, /function scheduleReconnect/);
assert.match(background, /Math\.min\(reconnectDelay \* 2, 30_000\)/, "native-host reconnects must back off");
assert.match(background, /void chrome\.runtime\.lastError/);
assert.match(background, /durationMs: completedAt - startedAt/);
assert.match(background, /auditLog\.slice\(-25\)/);
const statusScheduler = background.match(/function scheduleStatusBroadcast\(\) \{[\s\S]*?\n\}/)?.[0] || "";
assert.doesNotMatch(statusScheduler, /clearTimeout\(statusBroadcastTimer\)/, "busy network events must not starve status broadcasts");
assert.match(statusScheduler, /statusBroadcastQueued/, "status broadcasts need a trailing update after throttling");
assert.match(background, /const activeCommands = new Map\(\)/);
assert.match(background, /activity\.networkRequests \+= 1/);
assert.match(sidepanelScript, /chrome\.runtime\.onMessage/);
assert.match(sidepanelScript, /document\.createElement\("details"\)/);
assert.match(sidepanelScript, /navigator\.clipboard\.writeText/);
assert.match(sidepanelScript, /entry\.tabTitle/);
assert.match(sidepanelScript, /STRING_PAGE = 1_500/);
assert.match(sidepanelScript, /COLLECTION_PAGE = 50/);
assert.match(sidepanelScript, /command-disclosure\[open\]/);
assert.match(sidepanelScript, /function filteredCommands/);
assert.match(sidepanelScript, /function readableTimestamp/);
assert.match(sidepanelScript, /item\.append\(disclosure, copy\)/, "copy control must sit beside details, not inside summary");
assert.doesNotMatch(sidepanelScript, /summary\.append\([^\n]*copy/, "summary must not contain nested buttons");
assert.doesNotMatch(sidepanelScript, /document\.createElement\("pre"\)/, "large log payloads must not render as a single preformatted block");
assert.match(sidepanelHtml, /id="clear-logs"/);
for (const id of ["reconnect", "command-search", "status-filter", "tab-filter", "log-summary"]) {
  assert.match(sidepanelHtml, new RegExp(`id="${id}"`), `missing log control ${id}`);
}
for (const id of ["running", "attachments", "requests", "captures", "activity-summary"]) {
  assert.match(sidepanelHtml, new RegExp(`id="${id}"`), `missing live activity field ${id}`);
}
assert.match(sidepanelScript, /status\.activeCommands/);
assert.match(sidepanelScript, /stats\.networkRequests/);
assert.match(sidepanelCss, /\.command\.error/);
assert.match(sidepanelCss, /\.command-state svg/);
assert.match(sidepanelCss, /width: 40px; height: 40px/, "copy target must remain comfortably clickable");
assert.doesNotMatch(sidepanelHtml, /<script(?![^>]*\bsrc=)/i, "side panel must not contain inline scripts");
assert.match(skill, /^---\nname: chrome-bridge\ndescription:/);
assert.match(skill, /references\/commands\.md/);
assert.match(skill, /references\/data-and-state\.md/);
assert.match(skill, /references\/workflows\.md/);
assert.match(xSkill, /^---\nname: x-chrome-bridge\ndescription:/);
assert.match(xSkill, /friendships\/create/);
assert.match(xSkill, /x-rate-limit-remaining/);
assert.match(xSkill, /Follows you/);
assert.match(xSkillMetadata, /\$x-chrome-bridge/);
assert.match(linkedinSkill, /^---\nname: linkedin-chrome-bridge\ndescription:/);
assert.match(linkedinSkill, /main#workspace/);
assert.match(linkedinSkill, /data-testid=mainFeed/);
assert.match(linkedinSkill, /msg-conversations-container__conversations-list/);
assert.match(linkedinSkill, /msg-s-message-list__event/);
assert.match(linkedinSkill, /mypreferences\/d\/download-my-data/);
assert.match(linkedinSkill, /preload\/sharebox/);
assert.match(linkedinSkill, /flagship-web\/rsc-action\/actions/);
assert.match(linkedinSkillMetadata, /\$linkedin-chrome-bridge/);
assert.match(skillCommands, /Use it for/);
assert.match(skillCommands, /What it returns or changes/);
for (const documented of [
  "status", "list-tabs", "new-tab", "close-tab", "activate-tab", "navigate", "reload", "go-back", "go-forward", "detach", "audit",
  "snapshot", "dom", "dom snapshot", "visible-text", "styles", "screenshot", "screencast", "eval",
  "click", "hover", "drag", "type", "type-text", "press-key", "fill-form", "upload-file", "wait-for", "handle-dialog",
  "network capture", "network start", "network tail", "network get-body", "network stop", "network export-har", "console capture",
  "scripts list", "scripts get", "resources tree", "resources get", "page mhtml", "cookies", "storage", "targets",
  "performance metrics", "performance profile", "performance trace", "resize", "emulate",
  "history search", "bookmarks tree", "bookmarks search", "downloads search", "extensions list", "extension reload", "chrome call",
  "cdp send", "cdp events", "cdp session-start", "cdp session-stop",
]) {
  assert.ok(skillCommands.includes("`" + documented), `missing command reference for ${documented}`);
}
for (const section of ["Where data lives", "How to find each kind of browser data", "Identifier model", "Network data lifecycle", "Large results and Native Messaging", "State lifetime and cleanup"]) {
  assert.match(skillData, new RegExp(section), `missing data guide section ${section}`);
}
for (const workflow of ["Discover a private API", "persistent CDP session", "Develop another unpacked extension", "Recover from an interrupted task"]) {
  assert.match(skillWorkflows, new RegExp(workflow), `missing workflow reference for ${workflow}`);
}

for (const command of [
  "network-capture", "network-get-body", "console-capture", "scripts-get", "resources-get", "page-mhtml",
  "dom-snapshot", "performance-trace", "history-search", "bookmarks-tree", "downloads-search", "cdp-send",
  "new-tab", "close-tab", "go-forward", "hover", "drag", "press-key", "fill-form", "upload-file",
  "wait-for", "handle-dialog", "resize", "emulate", "screencast", "cdp-session-start", "cdp-session-stop",
]) {
  assert.ok(background.includes(`case "${command}"`), `missing command handler ${command}`);
}
assert.match(background, /Target\.setAutoAttach/);
assert.match(background, /manualCdpSessions/);
assert.match(background, /chrome\[namespace\]/);
assert.doesNotMatch(background, /ALLOWED_CDP_DOMAINS/, "raw CDP must let Chrome decide protocol support");

assert.deepEqual(parseArguments(["network", "capture", "--tab=3", "--bodies"]), {
  positionals: ["network", "capture"],
  options: { tab: "3", bodies: true },
});
assert.equal(parseDuration("1.5s"), 1500);
assert.deepEqual(normalizeCommand(parseArguments(["network", "capture", "--duration=2s"])), {
  command: "network-capture",
  params: { duration: 2_000 },
});
assert.deepEqual(normalizeCommand(parseArguments(["cdp", "session-start", "--target=worker-1"])), {
  command: "cdp-session-start",
  params: { target: "worker-1" },
});
assert.deepEqual(normalizeCommand(parseArguments(["press-key", "Meta+A"])), {
  command: "press-key",
  params: { key: "Meta+A" },
});
assert.deepEqual(normalizeCommand(parseArguments(["new-tab", "https://example.com", "--active=false"])), {
  command: "new-tab",
  params: { active: false, url: "https://example.com" },
});

const framed = encodeNativeMessage({ hello: "world" });
const decoded = [];
const push = decodeNativeMessages((message) => decoded.push(message));
push(framed.subarray(0, 3));
push(framed.subarray(3, 8));
push(framed.subarray(8));
assert.deepEqual(decoded, [{ hello: "world" }]);

async function waitFor(check, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

const testHome = await mkdtemp(path.join(os.tmpdir(), "chrome-bridge-test-"));
const extensionId = "abcdefghijklmnopabcdefghijklmnop";
await Promise.all([
  mkdir(path.join(testHome, "requests")),
  mkdir(path.join(testHome, "responses")),
  writeFile(path.join(testHome, "config.json"), JSON.stringify({ extensionId })),
]);
const host = spawn(process.execPath, [path.join(root, "bin", "chrome-bridge.mjs"), `chrome-extension://${extensionId}/`], {
  env: { ...process.env, CHROME_BRIDGE_HOME: testHome },
  stdio: ["pipe", "pipe", "pipe"],
});
const hostMessages = [];
host.stdout.on("data", decodeNativeMessages((message) => hostMessages.push(message)));
host.stdin.write(encodeNativeMessage({ type: "hello" }));
await waitFor(() => hostMessages.find((message) => message.type === "helloResult" && message.ok), "native host did not connect");

const requestId = "request-1";
const largeExpression = `token=${"x".repeat(1_200_000)}`;
await writeFile(path.join(testHome, "requests", `${requestId}.json`), JSON.stringify({
  id: requestId,
  command: "eval",
  params: { expression: largeExpression },
  createdAt: Date.now(),
}));
await waitFor(() => hostMessages.find((message) => message.type === "requestEnd" && message.id === requestId), "native host did not forward chunked request");
const reconstructed = JSON.parse(hostMessages
  .filter((message) => message.type === "requestChunk" && message.id === requestId)
  .sort((left, right) => left.index - right.index)
  .map((message) => message.data)
  .join(""));
assert.equal(reconstructed.params.expression, largeExpression);

const response = JSON.stringify({ ok: true, result: { token: largeExpression }, completedAt: Date.now() });
host.stdin.write(encodeNativeMessage({ type: "responseStart", id: requestId }));
for (let index = 0, offset = 0; offset < response.length; index += 1, offset += 400_000) {
  host.stdin.write(encodeNativeMessage({ type: "responseChunk", id: requestId, index, data: response.slice(offset, offset + 400_000) }));
}
host.stdin.write(encodeNativeMessage({ type: "responseEnd", id: requestId }));
const hostResponse = await waitFor(async () => {
  try { return JSON.parse(await readFile(path.join(testHome, "responses", `${requestId}.json`), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}, "native host did not persist chunked response");
assert.equal(hostResponse.result.token, largeExpression);

const retainedRequest = JSON.parse(await readFile(path.join(testHome, "logs", `${requestId}.request.json`), "utf8"));
const retainedResponse = JSON.parse(await readFile(path.join(testHome, "logs", `${requestId}.response.json`), "utf8"));
assert.equal(retainedRequest.params.expression, largeExpression);
assert.equal(retainedResponse.result.token, largeExpression);

host.stdin.write(encodeNativeMessage({ type: "readLog", id: requestId }));
await waitFor(() => hostMessages.find((message) => message.type === "logEnd" && message.id === requestId), "native host did not stream retained log data");
const streamedPart = (part) => Buffer.concat(hostMessages
  .filter((message) => message.type === "logChunk" && message.id === requestId && message.part === part)
  .sort((left, right) => left.index - right.index)
  .map((message) => Buffer.from(message.data, "base64")))
  .toString("utf8");
assert.equal(JSON.parse(streamedPart("request")).params.expression, largeExpression);
assert.equal(JSON.parse(streamedPart("response")).result.token, largeExpression);

host.stdin.write(encodeNativeMessage({ type: "clearLogs", id: "clear-1" }));
await waitFor(() => hostMessages.find((message) => message.type === "logsCleared" && message.id === "clear-1"), "native host did not clear retained logs");
assert.deepEqual(await readdir(path.join(testHome, "logs")), []);
host.kill();
await rm(testHome, { recursive: true, force: true });

const setupHome = await mkdtemp(path.join(os.tmpdir(), "chrome-bridge-setup-test-"));
const setupRuntime = path.join(setupHome, "runtime");
await execFile(process.execPath, [path.join(root, "bin", "chrome-bridge.mjs"), "setup"], {
  env: { ...process.env, HOME: setupHome, CHROME_BRIDGE_HOME: setupRuntime },
});
const installedManifest = JSON.parse(await readFile(path.join(
  setupHome,
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "NativeMessagingHosts",
  "dev.sethrose.chrome_bridge.json",
), "utf8"));
const installedHost = spawn(installedManifest.path, installedManifest.allowed_origins, {
  env: { HOME: setupHome, PATH: "/usr/bin:/bin", CHROME_BRIDGE_HOME: setupRuntime },
  stdio: ["pipe", "pipe", "pipe"],
});
const installedMessages = [];
let installedError = "";
installedHost.stdout.on("data", decodeNativeMessages((message) => installedMessages.push(message)));
installedHost.stderr.on("data", (chunk) => { installedError += chunk.toString(); });
installedHost.stdin.write(encodeNativeMessage({ type: "hello" }));
await waitFor(
  () => installedMessages.find((message) => message.type === "helloResult" && message.ok),
  `setup-generated native host did not survive Chrome's PATH: ${installedError}`,
);
installedHost.kill();
assert.match(await readlink(path.join(setupHome, ".agents", "skills", "chrome-bridge")), /skill\/chrome-bridge$/);
assert.match(await readlink(path.join(setupHome, ".agents", "skills", "x-chrome-bridge")), /skill\/x-chrome-bridge$/);
assert.match(await readlink(path.join(setupHome, ".agents", "skills", "linkedin-chrome-bridge")), /skill\/linkedin-chrome-bridge$/);
await rm(setupHome, { recursive: true, force: true });

console.log("Chrome Bridge contracts verified.");

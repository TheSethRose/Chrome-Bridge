import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { normalizeCommand, parseArguments, parseDuration } from "./bin/chrome-bridge.mjs";
import { normalizeSemanticValue, selectSemanticMatch, semanticNodeMatches } from "./extension/semantic.js";
import { decodeNativeMessages, encodeNativeMessage } from "./native-host/host.mjs";
import { COMMANDS, schema } from "./shared/commands.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const execFile = promisify(execFileCallback);
const read = (file) => readFile(path.join(root, file), "utf8");
const packageJson = JSON.parse(await read("package.json"));
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
assert.doesNotMatch(
  background,
  /chrome\.tabs\.onUpdated\.addListener\([\s\S]{0,300}detachAll\(tabId\)/,
  "same-tab navigation must not detach an in-flight command",
);
const waitForPageSource = background.match(/async function waitForPage[\s\S]*?(?=\nasync function handleDialog)/)?.[0] || "";
assert.match(waitForPageSource, /chrome\.tabs\.get\(tabId\)/, "wait-for must not inspect the previous document during navigation");
assert.match(waitForPageSource, /Detached while handling command\./, "wait-for must recover when navigation replaces its debugger target");
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
for (const id of ["running", "attachments", "requests", "captures"]) {
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
assert.match(xSkill, /tweetTextarea_0/);
assert.match(xSkill, /dm-composer-textarea/);
assert.match(xSkill, /scheduledConfirmationPrimaryAction/);
assert.match(xSkill, /settings\/download_your_data/);
assert.match(xSkill, /HANDLE\/communities/);
assert.match(xSkill, /SearchBox_Search_Input/);
assert.match(xSkillMetadata, /\$x-chrome-bridge/);
assert.match(linkedinSkill, /^---\nname: linkedin-chrome-bridge\ndescription:/);
assert.match(linkedinSkill, /main#workspace/);
assert.match(linkedinSkill, /data-testid=mainFeed/);
assert.match(linkedinSkill, /msg-conversations-container__conversations-list/);
assert.match(linkedinSkill, /msg-s-message-list__event/);
assert.match(linkedinSkill, /mypreferences\/d\/download-my-data/);
assert.match(linkedinSkill, /preload\/sharebox/);
assert.match(linkedinSkill, /flagship-web\/rsc-action\/actions/);
assert.match(linkedinSkill, /notification-card-container/);
assert.match(linkedinSkill, /jobs-tracker/);
assert.match(linkedinSkill, /typeahead-input/);
assert.match(linkedinSkill, /my-items\/saved-posts/);
assert.match(linkedinSkill, /company\/ID\/admin/);
assert.match(linkedinSkill, /categories\/sign-in-and-security/);
assert.match(linkedinSkillMetadata, /\$linkedin-chrome-bridge/);
assert.match(skillCommands, /Use it for/);
assert.match(skillCommands, /What it returns or changes/);
for (const documented of [
  "status", "doctor", "inspectability", "capabilities", "list-tabs", "tab name", "new-tab", "close-tab", "activate-tab", "navigate", "reload", "go-back", "go-forward", "detach", "audit",
  "snapshot", "snapshot diff", "locate", "watch", "dom", "dom snapshot", "visible-text", "styles", "screenshot", "screencast", "eval",
  "click", "hover", "drag", "type", "type-text", "press-key", "fill-form", "upload-file", "wait-for", "handle-dialog",
  "network capture", "network start", "network tail", "network get-body", "network stop", "network export-har", "console capture",
  "scripts list", "scripts get", "resources tree", "resources get", "page mhtml", "cookies", "storage", "targets",
  "extract",
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
  "inspectability", "doctor", "extract",
]) {
  assert.ok(background.includes(`case "${command}"`), `missing command handler ${command}`);
}
assert.match(background, /Target\.setAutoAttach/);
assert.match(background, /manualCdpSessions/);
assert.match(background, /chrome\[namespace\]/);
assert.match(background, /backendNodePoint/);
assert.match(background, /resolveSemanticTarget/);
assert.match(background, /extractPage/);
assert.match(background, /sideEffectMayHaveOccurred/);
assert.match(background, /initialLoadCaptured/);
assert.match(background, /waitForNetworkIdle/);
assert.match(background, /async function inspectability/);
assert.match(background, /async function doctor/);
assert.match(background, /function presentNetwork/);
assert.match(background, /function scheduleEmulationCleanup/);
assert.match(background, /stopNetwork\(capture\)\.catch/);
assert.match(background, /stopCdpSession\(id\)\.catch/);
assert.match(background, /params\.valueOnly/);
assert.match(background, /params\.maxNodes/);
assert.doesNotMatch(background, /ALLOWED_CDP_DOMAINS/, "raw CDP must let Chrome decide protocol support");

assert.deepEqual(parseArguments(["network", "capture", "--tab=3", "--bodies"]), {
  positionals: ["network", "capture"],
  options: { tab: "3", bodies: true },
});
assert.equal(parseDuration("1.5s"), 1500);
assert.equal(parseDuration("1h"), 3_600_000);
assert.deepEqual(normalizeCommand(parseArguments(["network", "capture", "--tab=3", "--duration=2s"])), {
  command: "network-capture",
  params: { tab: 3, duration: 2_000 },
});
assert.deepEqual(normalizeCommand(parseArguments(["cdp", "session-start", "--target=worker-1"])), {
  command: "cdp-session-start",
  params: { target: "worker-1" },
});
assert.deepEqual(normalizeCommand(parseArguments(["press-key", "--tab=3", "Meta+A"])), {
  command: "press-key",
  params: { tab: 3, key: "Meta+A" },
});
assert.deepEqual(normalizeCommand(parseArguments(["new-tab", "https://example.com", "--active=false"])), {
  command: "new-tab",
  params: { active: false, url: "https://example.com" },
});
assert.deepEqual(normalizeCommand(parseArguments(["click", "--tab=3", "--backend-node-id=456", "--wait-for-url=/analytics"])), {
  command: "click",
  params: { tab: 3, backendNodeId: 456, waitForUrl: "/analytics" },
});
assert.deepEqual(normalizeCommand(parseArguments(["click", "--tab=3", "--role=tab", "--name=Top", "--wait-role=status", "--wait-name=Loaded"])), {
  command: "click",
  params: { tab: 3, role: "tab", name: "Top", waitRole: "status", waitName: "Loaded" },
});
assert.deepEqual(normalizeCommand(parseArguments(["wait-for", "--tab=3", "--role=button", "--name=Publish", "--state=enabled"])), {
  command: "wait-for",
  params: { tab: 3, role: "button", name: "Publish", state: "enabled" },
});
assert.deepEqual(normalizeCommand(parseArguments(["type", "--tab=3", "--role=textbox", "--name=Search", "--text=query"])), {
  command: "type",
  params: { tab: 3, role: "textbox", name: "Search", text: "query" },
});
assert.deepEqual(normalizeCommand(parseArguments(["extract", "--tab=3", "--item=article", "--schema={\"text\":{\"property\":\"innerText\"}}"])), {
  command: "extract",
  params: { tab: 3, item: "article", schema: "{\"text\":{\"property\":\"innerText\"}}" },
});
const semanticNode = { role: { value: "button" }, name: { value: "  Save   changes " }, value: { value: "" }, description: { value: "Submit form" } };
assert.equal(normalizeSemanticValue(semanticNode.name.value), "save changes");
assert.equal(semanticNodeMatches(semanticNode, { role: "button", name: "save", text: "", exact: false }), true);
assert.equal(semanticNodeMatches(semanticNode, { role: "button", name: "save", text: "", exact: true }), false);
assert.equal(semanticNodeMatches(semanticNode, { role: "button", name: "", text: "Submit form", exact: true }), true);
assert.deepEqual(selectSemanticMatch([{ id: 1 }, { id: 2 }]), { outcome: "ambiguous" });
assert.deepEqual(selectSemanticMatch([{ id: 1 }, { id: 2 }], 1), { outcome: "match", index: 1, match: { id: 2 } });
assert.deepEqual(normalizeCommand(parseArguments(["console", "tail", "--tab=3", "--duration=1s"])), {
  command: "console-capture",
  params: { tab: 3, duration: 1_000 },
});
assert.deepEqual(normalizeCommand(parseArguments(["snapshot", "--tab=linkedin-profile", "--compact"])), {
  command: "snapshot",
  params: { tab: "linkedin-profile", compact: true },
});
assert.deepEqual(normalizeCommand(parseArguments(["watch", "--tab=3", "--request=*/graphql", "--duration=30s"])), {
  command: "watch",
  params: { tab: 3, request: "*/graphql", duration: 30_000 },
});
assert.throws(() => normalizeCommand(parseArguments(["click", "--tab=3"])), /click requires a target[\s\S]*--role/);
assert.throws(() => normalizeCommand(parseArguments(["reload"])), /requires an explicit --tab=ID/);
assert.throws(() => normalizeCommand(parseArguments(["snapshot", "--max-node=10"])), /Did you mean --max-nodes/);
assert.throws(() => normalizeCommand(parseArguments(["watch", "--tab=3", "--url-changes", "--selector=main"])), /exactly one/);
assert.throws(() => normalizeCommand(parseArguments(["locate", "--tab=3"])), /requires --text, --role, or --name/);

const commandSchema = schema();
assert.equal(commandSchema.commands.length, COMMANDS.length);
const catalogIds = new Set(COMMANDS.map((entry) => entry.id));
for (const match of background.matchAll(/case "([^"]+)":/g)) assert.ok(catalogIds.has(match[1]), `handler ${match[1]} is missing from the command schema`);
for (const entry of COMMANDS.filter((item) => !["help", "commands", "setup", "snapshot-diff"].includes(item.id))) assert.ok(background.includes(`"${entry.id}"`), `catalog command ${entry.id} is missing a handler`);
for (const entry of commandSchema.commands) {
  assert.ok(entry.syntax, `${entry.name} is missing syntax`);
  assert.ok(entry.output, `${entry.name} is missing an output shape`);
  assert.ok(entry.examples.length >= 2, `${entry.name} needs two examples`);
  for (const [name, definition] of Object.entries(entry.arguments)) assert.ok(definition.type, `${entry.name} ${name} is missing a type`);
}

for (const args of [["snapshot", "--help"], ["eval", "--help"], ["network", "capture", "--help"]]) {
  const { stdout } = await execFile(process.execPath, [path.join(root, "bin", "chrome-bridge.mjs"), ...args]);
  const commandHelp = JSON.parse(stdout);
  assert.ok(commandHelp.syntax);
  assert.ok(commandHelp.requiredArguments);
  assert.ok(commandHelp.optionalArguments);
  assert.ok(commandHelp.examples.length >= 2);
  assert.ok(commandHelp.output);
}
const { stdout: schemaOutput } = await execFile(process.execPath, [path.join(root, "bin", "chrome-bridge.mjs"), "commands", "--json"]);
assert.equal(JSON.parse(schemaOutput).commands.length, COMMANDS.length);
const diffDirectory = await mkdtemp(path.join(os.tmpdir(), "chrome-bridge-diff-test-"));
const beforeSnapshot = path.join(diffDirectory, "before.json");
const afterSnapshot = path.join(diffDirectory, "after.json");
const diffArtifact = path.join(diffDirectory, "diff.json");
await Promise.all([
  writeFile(beforeSnapshot, JSON.stringify({ nodes: [{ backendDOMNodeId: 1, name: "Before" }, { backendDOMNodeId: 2, name: "Removed" }] })),
  writeFile(afterSnapshot, JSON.stringify({ nodes: [{ backendDOMNodeId: 1, name: "After" }, { backendDOMNodeId: 3, name: "Added" }] })),
]);
const { stdout: diffOutput } = await execFile(process.execPath, [path.join(root, "bin", "chrome-bridge.mjs"), "snapshot", "diff", `--before=${beforeSnapshot}`, `--after=${afterSnapshot}`, "--fields=counts", "--compact"]);
assert.deepEqual(JSON.parse(diffOutput), { counts: { added: 1, removed: 1, changed: 1 } });
const { stdout: receiptOutput } = await execFile(process.execPath, [path.join(root, "bin", "chrome-bridge.mjs"), "snapshot", "diff", `--before=${beforeSnapshot}`, `--after=${afterSnapshot}`, `--file=${diffArtifact}`]);
const receipt = JSON.parse(receiptOutput);
assert.equal(receipt.path, diffArtifact);
assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
assert.equal(receipt.bytes, (await readFile(diffArtifact)).length);
assert.equal(receipt.chromeBridgeVersion, packageJson.version);
await rm(diffDirectory, { recursive: true, force: true });
await assert.rejects(
  execFile(process.execPath, [path.join(root, "bin", "chrome-bridge.mjs"), "dom-summary"]),
  (error) => /Did you mean: dom snapshot/.test(error.stderr),
);
const doctorHome = await mkdtemp(path.join(os.tmpdir(), "chrome-bridge-doctor-test-"));
const { stdout: doctorOutput } = await execFile(process.execPath, [path.join(root, "bin", "chrome-bridge.mjs"), "doctor"], { env: { ...process.env, CHROME_BRIDGE_HOME: doctorHome } });
assert.deepEqual(JSON.parse(doctorOutput).checks[0], {
  name: "bridge-request",
  ok: false,
  detail: "Chrome Bridge is not set up; run chrome-bridge setup",
  recovery: "Run chrome-bridge setup, load or reload the unpacked extension, then retry doctor.",
});
await rm(doctorHome, { recursive: true, force: true });
assert.match(cliSource, /normalized\.command === "upload-file" \? undefined : normalized\.params\.file/, "upload input must not be reused as an output path");
assert.match(await read("native-host/host.mjs"), new RegExp(`HOST_VERSION = "${manifest.version}"`), "native host and extension versions must stay aligned");
assert.equal(packageJson.version, manifest.version, "CLI and extension versions must stay aligned");

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

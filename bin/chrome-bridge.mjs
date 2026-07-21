#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, ensureRuntime } from "../shared/runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = fileURLToPath(import.meta.url);

export function parseArguments(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const rawKey = token.slice(2, equals === -1 ? undefined : equals);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (rawKey.startsWith("no-") && equals === -1) {
      const positive = rawKey.slice(3).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[positive] = false;
    } else if (equals !== -1) {
      options[key] = token.slice(equals + 1);
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      options[key] = argv[++index];
    } else {
      options[key] = true;
    }
  }
  return { positionals, options };
}

export function parseDuration(value, fallback) {
  if (value === undefined) return fallback;
  const match = String(value).match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const factors = { ms: 1, s: 1_000, m: 60_000 };
  return Number(match[1]) * factors[(match[2] || "ms").toLowerCase()];
}

function extensionIdFromKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => String.fromCharCode(97 + nibble)).join("");
}

async function replaceSymlink(target, source) {
  const current = await lstat(target).catch(() => null);
  if (current?.isSymbolicLink()) await rm(target);
  else if (current) throw new Error(`Refusing to replace existing path: ${target}`);
  await symlink(source, target);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function setup() {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("Automatic native-host setup currently supports macOS and Linux");
  const paths = await ensureRuntime();
  const manifest = JSON.parse(await readFile(path.join(ROOT, "extension", "manifest.json"), "utf8"));
  const extensionId = extensionIdFromKey(manifest.key);
  await chmod(SCRIPT, 0o755);
  await atomicWriteJson(paths.config, { extensionId, projectRoot: ROOT });
  const launcher = path.join(paths.root, "native-host-launcher");
  await writeFile(launcher, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(SCRIPT)} "$@"\n`, { mode: 0o700 });
  await chmod(launcher, 0o700);

  const nativeManifest = {
    name: "dev.sethrose.chrome_bridge",
    description: "Chrome Bridge local CLI host",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const nativeDirectory = process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
    : path.join(os.homedir(), ".config", "google-chrome", "NativeMessagingHosts");
  await mkdir(nativeDirectory, { recursive: true });
  const nativeManifestPath = path.join(nativeDirectory, "dev.sethrose.chrome_bridge.json");
  await writeFile(nativeManifestPath, `${JSON.stringify(nativeManifest, null, 2)}\n`);

  const binDirectory = path.join(os.homedir(), ".local", "bin");
  const skillDirectory = path.join(os.homedir(), ".agents", "skills");
  await Promise.all([mkdir(binDirectory, { recursive: true }), mkdir(skillDirectory, { recursive: true })]);
  await Promise.all([
    replaceSymlink(path.join(binDirectory, "chrome-bridge"), SCRIPT),
    replaceSymlink(path.join(skillDirectory, "chrome-bridge"), path.join(ROOT, "skill", "chrome-bridge")),
    replaceSymlink(path.join(skillDirectory, "x-chrome-bridge"), path.join(ROOT, "skill", "x-chrome-bridge")),
    replaceSymlink(path.join(skillDirectory, "linkedin-chrome-bridge"), path.join(ROOT, "skill", "linkedin-chrome-bridge")),
  ]);

  return {
    installed: true,
    extensionId,
    loadUnpacked: path.join(ROOT, "extension"),
    nativeManifest: nativeManifestPath,
    cli: path.join(binDirectory, "chrome-bridge"),
    skill: path.join(skillDirectory, "chrome-bridge"),
    bonusSkill: path.join(skillDirectory, "x-chrome-bridge"),
    linkedinSkill: path.join(skillDirectory, "linkedin-chrome-bridge"),
    pathHint: process.env.PATH?.split(path.delimiter).includes(binDirectory) ? null : `export PATH="${binDirectory}:$PATH"`,
  };
}

export function normalizeCommand(parsed) {
  const words = [...parsed.positionals];
  const first = words.shift();
  const second = words[0];
  const options = { ...parsed.options };
  for (const key of ["active", "bodies", "har", "fullPage", "double", "mobile", "offline", "clear", "paintOrder", "domRects", "blendedColors", "textOpacities"]) {
    if (options[key] === "true") options[key] = true;
    if (options[key] === "false") options[key] = false;
  }

  if (options.duration !== undefined) options.duration = parseDuration(options.duration, 10_000);
  if (options.maxDuration !== undefined) options.maxDuration = parseDuration(options.maxDuration, 60_000);
  if (options.timeout !== undefined) options.timeout = parseDuration(options.timeout, 75_000);
  if (options.evalTimeout !== undefined) options.evalTimeout = parseDuration(options.evalTimeout, 5_000);
  if (options.tab !== undefined) options.tab = Number(options.tab);

  const nested = {
    "network capture": "network-capture",
    "network start": "network-start",
    "network tail": "network-tail",
    "network stop": "network-stop",
    "network get-body": "network-get-body",
    "network export-har": "network-export-har",
    "console capture": "console-capture",
    "console tail": "console-capture",
    "scripts list": "scripts-list",
    "scripts get": "scripts-get",
    "resources tree": "resources-tree",
    "resources get": "resources-get",
    "page mhtml": "page-mhtml",
    "dom snapshot": "dom-snapshot",
    "performance metrics": "performance-metrics",
    "performance profile": "performance-profile",
    "performance trace": "performance-trace",
    "history search": "history-search",
    "bookmarks tree": "bookmarks-tree",
    "bookmarks search": "bookmarks-search",
    "downloads search": "downloads-search",
    "extensions list": "extensions-list",
    "extension reload": "extension-reload",
    "chrome call": "chrome-call",
    "cdp send": "cdp-send",
    "cdp events": "cdp-events",
    "cdp session-start": "cdp-session-start",
    "cdp session-stop": "cdp-session-stop",
  };
  const pair = `${first || ""} ${second || ""}`;
  const command = nested[pair] || first;
  if (nested[pair]) words.shift();
  if (command === "eval") options.expression = words.join(" ");
  if (["navigate", "new-tab"].includes(command) && !options.url && words.length) options.url = words.join(" ");
  if (["type-text", "wait-for"].includes(command) && !options.text && words.length) options.text = words.join(" ");
  if (command === "press-key" && !options.key && words.length) options.key = words.join("+");
  if (command === "network-get-body" && !options.request && words.length) options.request = words[0];
  return { command, params: options };
}

async function request(command, params) {
  const paths = await ensureRuntime();
  await readFile(paths.config, "utf8").catch(() => { throw new Error("Chrome Bridge is not set up; run chrome-bridge setup"); });
  const id = randomUUID();
  await atomicWriteJson(path.join(paths.requests, `${id}.json`), { id, command, params, createdAt: Date.now() });
  const responseFile = path.join(paths.responses, `${id}.json`);
  const deadline = params.timeout === undefined ? Infinity : Date.now() + Number(params.timeout);
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(await readFile(responseFile, "utf8"));
      await rm(responseFile, { force: true });
      if (!response.ok) throw new Error(response.error || "Chrome Bridge command failed");
      return response.result;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await rm(path.join(paths.requests, `${id}.json`), { force: true });
  throw new Error("Chrome Bridge timed out; confirm the unpacked extension is loaded");
}

async function writeResultFile(result, file, command) {
  const target = path.resolve(String(file));
  if (command === "screenshot") await writeFile(target, Buffer.from(result.data, "base64"));
  else if (["performance-trace", "page-mhtml"].includes(command)) await writeFile(target, result.data);
  else await writeFile(target, `${JSON.stringify(result, null, 2)}\n`);
  const info = await lstat(target);
  return { file: target, bytes: info.size, format: result.format };
}

function help() {
  return {
    usage: "chrome-bridge <command> [options]",
    commands: [
      "status | list-tabs | new-tab | close-tab | activate-tab | navigate | reload | go-back | go-forward | detach",
      "snapshot | dom | dom snapshot | visible-text | styles | screenshot | screencast | eval",
      "click | hover | drag | type | type-text | press-key | fill-form | upload-file | wait-for | handle-dialog",
      "resize | emulate",
      "network capture|start|tail|stop|get-body|export-har",
      "console capture | scripts list|get | resources tree|get | page mhtml",
      "storage | cookies | targets",
      "performance metrics|profile|trace",
      "history search | bookmarks tree|search | downloads search | audit",
      "extensions list | extension reload | chrome call",
      "cdp session-start|session-stop | cdp send|events",
    ],
    commonOptions: ["--tab=ID", "--duration=10s", "--timeout=30s", "--file=PATH"],
  };
}

async function main() {
  const origin = process.argv[2];
  if (origin?.startsWith("chrome-extension://")) {
    const { runNativeHost } = await import("../native-host/host.mjs");
    await runNativeHost(origin);
    return;
  }

  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.positionals.length || ["help", "--help", "-h"].includes(parsed.positionals[0])) return help();
  if (parsed.positionals[0] === "setup") return setup();
  const normalized = normalizeCommand(parsed);
  const result = await request(normalized.command, normalized.params);
  return normalized.params.file ? writeResultFile(result, normalized.params.file, normalized.command) : result;
}

const entrypoint = process.argv[1] ? await realpath(process.argv[1]).catch(() => path.resolve(process.argv[1])) : "";
if (fileURLToPath(import.meta.url) === entrypoint) {
  main().then((result) => {
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }, (error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  });
}

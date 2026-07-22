#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { coerceAndValidate, helpFor, resolveCommand, schema, suggestions } from "../shared/commands.mjs";
import { atomicWriteJson, ensureRuntime } from "../shared/runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = fileURLToPath(import.meta.url);
const VERSION = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")).version;

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
  const match = String(value).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const factors = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
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
  const resolved = resolveCommand(parsed.positionals);
  if (!resolved) {
    const requested = parsed.positionals.slice(0, 2).join(" ");
    const likely = suggestions(requested);
    throw new Error(`Unknown command: ${requested || "(none)"}${likely.length ? `\nDid you mean: ${likely.join(", ")}?` : ""}\nUse: chrome-bridge help`);
  }
  const words = parsed.positionals.slice(resolved.consumed);
  const options = { ...parsed.options };
  const command = resolved.entry.id;
  if (command === "eval" && !options.expression) options.expression = words.join(" ");
  if (["navigate", "new-tab"].includes(command) && !options.url && words.length) options.url = words.join(" ");
  if (["type-text", "wait-for"].includes(command) && !options.text && words.length) options.text = words.join(" ");
  if (command === "press-key" && !options.key && words.length) options.key = words.join("+");
  if (command === "network-get-body" && !options.request && words.length) options.request = words[0];
  if (words.length && !["eval", "navigate", "new-tab", "type-text", "wait-for", "press-key", "network-get-body"].includes(command)) {
    throw new Error(`Unexpected argument: ${words[0]}. Use: ${resolved.entry.syntax}`);
  }
  delete options.help;
  delete options.json;
  return { command, params: coerceAndValidate(resolved.entry, options, (value) => parseDuration(value)) };
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
      if (!response.ok) {
        const error = new Error(response.error || "Chrome Bridge command failed");
        error.details = response.details;
        throw error;
      }
      return response.result;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await rm(path.join(paths.requests, `${id}.json`), { force: true });
  throw new Error("Chrome Bridge timed out; confirm the unpacked extension is loaded");
}

async function writeResultFile(result, file, command, params) {
  const target = path.resolve(String(file));
  if (command === "screenshot") await writeFile(target, Buffer.from(result.data, "base64"));
  else if (["performance-trace", "page-mhtml"].includes(command)) await writeFile(target, result.data);
  else await writeFile(target, `${serializeResult(result)}\n`);
  const info = await lstat(target);
  const sha256 = createHash("sha256").update(await readFile(target)).digest("hex");
  return {
    file: target,
    path: target,
    sha256,
    bytes: info.size,
    capturedAt: new Date().toISOString(),
    tabId: result?.tabId ?? (typeof params.tab === "number" ? params.tab : null),
    url: result?.url || result?.finalUrl || result?.lastKnownUrl || null,
    chromeBridgeVersion: VERSION,
    format: result?.format || (command === "screenshot" ? path.extname(target).slice(1) : "json"),
  };
}

function projectFields(value, fields) {
  if (!fields.length || value === null || typeof value !== "object") return value;
  const project = (item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(fields.filter((field) => field in item).map((field) => [field, item[field]]))
    : item;
  return Array.isArray(value) ? value.map(project) : project(value);
}

function shapeResult(value, params) {
  let result = value;
  if (params.jq) {
    const filtered = spawnSync("jq", ["-c", String(params.jq)], { input: JSON.stringify(result), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (filtered.error?.code === "ENOENT") throw new Error("--jq requires the jq executable on PATH");
    if (filtered.status !== 0) throw new Error(`jq failed: ${String(filtered.stderr || "unknown error").trim()}`);
    const values = String(filtered.stdout).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    result = values.length === 1 ? values[0] : values;
  }
  if (params.fields) result = projectFields(result, String(params.fields).split(",").map((field) => field.trim()).filter(Boolean));
  if (params.maxResults !== undefined) {
    const limit = Math.max(0, Number(params.maxResults));
    if (Array.isArray(result)) result = result.slice(0, limit);
    else if (result && typeof result === "object") result = Object.fromEntries(Object.entries(result).map(([key, item]) => [key, Array.isArray(item) ? item.slice(0, limit) : item]));
  }
  return result;
}

function serializeResult(result) {
  if (OUTPUT_OPTIONS.ndjson) return (Array.isArray(result) ? result : [result]).map((item) => JSON.stringify(item)).join("\n");
  return JSON.stringify(result, null, OUTPUT_OPTIONS.compact ? undefined : 2);
}

function comparableSnapshot(value) {
  const nodes = Array.isArray(value?.nodes) ? value.nodes : Array.isArray(value) ? value : null;
  if (!nodes) return value;
  return Object.fromEntries(nodes.map((node, index) => [String(node.backendDOMNodeId || node.nodeId || index), node]));
}

function diffValues(before, after, maxResults = 1_000) {
  const changes = { added: [], removed: [], changed: [] };
  const visit = (left, right, location = "$") => {
    if (changes.added.length + changes.removed.length + changes.changed.length >= maxResults) return;
    if (left === undefined) changes.added.push({ path: location, value: right });
    else if (right === undefined) changes.removed.push({ path: location, value: left });
    else if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
      if (!Object.is(left, right)) changes.changed.push({ path: location, before: left, after: right });
    } else {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) visit(left[key], right[key], `${location}.${key}`);
    }
  };
  visit(comparableSnapshot(before), comparableSnapshot(after));
  return { counts: Object.fromEntries(Object.entries(changes).map(([key, items]) => [key, items.length])), ...changes };
}

async function snapshotDiff(params) {
  const [before, after] = await Promise.all([params.before, params.after].map(async (file) => JSON.parse(await readFile(path.resolve(String(file)), "utf8"))));
  return diffValues(before, after, params.maxResults === undefined ? 1_000 : Number(params.maxResults));
}

let OUTPUT_OPTIONS = {};

async function main() {
  const origin = process.argv[2];
  if (origin?.startsWith("chrome-extension://")) {
    const { runNativeHost } = await import("../native-host/host.mjs");
    await runNativeHost(origin);
    return;
  }

  const parsed = parseArguments(process.argv.slice(2));
  OUTPUT_OPTIONS = parsed.options;
  if (!parsed.positionals.length || parsed.positionals[0] === "-h") return helpFor();
  if (parsed.positionals[0] === "help") return helpFor(parsed.positionals.slice(1));
  if (parsed.options.help) return helpFor(parsed.positionals);
  if (parsed.positionals[0] === "commands") return schema();
  if (parsed.positionals[0] === "setup") return setup();
  const normalized = normalizeCommand(parsed);
  OUTPUT_OPTIONS = normalized.params;
  if (normalized.command === "doctor") {
    normalized.params.cliVersion = VERSION;
    normalized.params.timeout ??= 5_000;
  }
  let result;
  try {
    result = normalized.command === "snapshot-diff" ? await snapshotDiff(normalized.params) : await request(normalized.command, normalized.params);
  } catch (error) {
    if (normalized.command !== "doctor") throw error;
    return {
      ok: false,
      versions: { cli: VERSION, nativeHost: null, extension: null, protocol: null },
      checks: [{ name: "bridge-request", ok: false, detail: error.message, recovery: "Run chrome-bridge setup, load or reload the unpacked extension, then retry doctor." }],
    };
  }
  result = shapeResult(result, normalized.params);
  const resultFile = normalized.params.out || (normalized.command === "upload-file" ? undefined : normalized.params.file);
  if (resultFile && ["screenshot", "performance-trace", "page-mhtml"].includes(normalized.command) && [normalized.params.fields, normalized.params.jq, normalized.params.maxResults, normalized.params.ndjson, normalized.params.compact].some((value) => value !== undefined && value !== false)) {
    throw new Error(`Output shaping cannot be combined with a raw ${normalized.command} artifact`);
  }
  return resultFile ? writeResultFile(result, resultFile, normalized.command, normalized.params) : result;
}

const entrypoint = process.argv[1] ? await realpath(process.argv[1]).catch(() => path.resolve(process.argv[1])) : "";
if (fileURLToPath(import.meta.url) === entrypoint) {
  main().then((result) => {
    if (result !== undefined) process.stdout.write(`${serializeResult(result)}\n`);
  }, (error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message, details: error.details }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

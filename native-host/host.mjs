import { appendFile, link, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { atomicWriteJson, ensureRuntime } from "../shared/runtime.mjs";

const MAX_FROM_CHROME = 64 * 1024 * 1024;
const MAX_TO_CHROME = 1024 * 1024;
const HOST_VERSION = "0.1.0";

export function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_TO_CHROME) throw new Error("Native message to Chrome exceeds 1 MB");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export function decodeNativeMessages(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length <= 0 || length > MAX_FROM_CHROME) throw new Error(`Invalid native message length: ${length}`);
      if (buffer.length < length + 4) return;
      const body = buffer.subarray(4, length + 4);
      buffer = buffer.subarray(length + 4);
      onMessage(JSON.parse(body.toString("utf8")));
    }
  };
}

export async function runNativeHost(origin) {
  const paths = await ensureRuntime();
  const config = JSON.parse(await readFile(paths.config, "utf8"));
  const expectedOrigin = `chrome-extension://${config.extensionId}/`;
  if (origin !== expectedOrigin) throw new Error(`Rejected native messaging origin: ${origin}`);

  let scanning = false;
  const send = (message) => new Promise((resolve) => {
    if (process.stdout.write(encodeNativeMessage(message))) resolve();
    else process.stdout.once("drain", resolve);
  });
  const writeState = () => atomicWriteJson(paths.state, { pid: process.pid, origin, connected: true, updatedAt: Date.now() }).catch(() => {});

  const retain = async (source, target) => {
    await rm(target, { force: true });
    await link(source, target);
  };

  const streamLogPart = async (id, part) => {
    const filePath = path.join(paths.logs, `${id}.${part}.json`);
    const file = await open(filePath, "r");
    const buffer = Buffer.alloc(200_000);
    let index = 0;
    try {
      await send({ type: "logPartStart", id, part });
      while (true) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        await send({ type: "logChunk", id, part, index, data: buffer.subarray(0, bytesRead).toString("base64") });
        index += 1;
      }
      await send({ type: "logPartEnd", id, part });
    } finally {
      await file.close();
    }
  };

  const streamLog = async (id) => {
    for (const part of ["request", "response"]) {
      try {
        await streamLogPart(id, part);
      } catch (error) {
        await send({ type: "logPartError", id, part, error: error.code === "ENOENT" ? "Log data is not available" : error.message });
      }
    }
    await send({ type: "logEnd", id });
  };

  const handle = async (message) => {
    if (message?.type === "hello") {
      await send({ type: "helloResult", ok: true, version: HOST_VERSION });
      writeState();
      return;
    }
    if (message?.type === "clearLogs") {
      const files = await readdir(paths.logs);
      await Promise.all(files.map((file) => rm(path.join(paths.logs, file), { force: true })));
      await send({ type: "logsCleared", id: message.id });
      return;
    }
    if (message?.type === "readLog" && typeof message.id === "string" && /^[a-zA-Z0-9-]+$/.test(message.id)) {
      await streamLog(message.id);
      return;
    }
    if (typeof message?.id !== "string") return;
    const partial = path.join(paths.responses, `.${message.id}.partial`);
    if (message.type === "responseStart") await writeFile(partial, "", { mode: 0o600 });
    else if (message.type === "responseChunk") await appendFile(partial, message.data, "utf8");
    else if (message.type === "responseEnd") {
      await retain(partial, path.join(paths.logs, `${message.id}.response.json`));
      await rename(partial, path.join(paths.responses, `${message.id}.json`));
    } else if (message.type === "response") {
      const responseFile = path.join(paths.responses, `${message.id}.json`);
      await atomicWriteJson(responseFile, message);
      await retain(responseFile, path.join(paths.logs, `${message.id}.response.json`));
    }
  };

  const scan = async () => {
    if (scanning) return;
    scanning = true;
    try {
      const files = (await readdir(paths.requests)).filter((file) => file.endsWith(".json"));
      for (const file of files) {
        const requestFile = path.join(paths.requests, file);
        let request;
        try {
          request = JSON.parse(await readFile(requestFile, "utf8"));
          await retain(requestFile, path.join(paths.logs, `${request.id}.request.json`));
          const serialized = JSON.stringify({ command: request.command, params: request.params });
          const chunkSize = 200_000;
          for (let index = 0, offset = 0; offset < serialized.length; index += 1, offset += chunkSize) {
            await send({ type: "requestChunk", id: request.id, index, data: serialized.slice(offset, offset + chunkSize) });
          }
          await send({ type: "requestEnd", id: request.id });
        } catch (error) {
          const id = request?.id || path.basename(file, ".json");
          await atomicWriteJson(path.join(paths.responses, `${id}.json`), { ok: false, error: error.message, completedAt: Date.now() });
        } finally {
          await rm(requestFile, { force: true });
        }
      }
    } finally {
      scanning = false;
    }
  };

  let handling = Promise.resolve();
  const decode = decodeNativeMessages((message) => {
    handling = handling.then(() => handle(message)).catch((error) => process.stderr.write(`${error.message}\n`));
  });
  process.stdin.on("data", decode);
  process.stdin.on("error", (error) => process.stderr.write(`${error.message}\n`));
  process.stdin.on("end", () => process.exit(0));
  setInterval(scan, 75);
  setInterval(writeState, 1_000);
  writeState();
}

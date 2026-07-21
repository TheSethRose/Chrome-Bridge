import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function runtimeDir() {
  if (process.env.CHROME_BRIDGE_HOME) return path.resolve(process.env.CHROME_BRIDGE_HOME);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "chrome-bridge");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || os.homedir(), "chrome-bridge");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "chrome-bridge");
}

export function runtimePaths() {
  const root = runtimeDir();
  return {
    root,
    requests: path.join(root, "requests"),
    responses: path.join(root, "responses"),
    logs: path.join(root, "logs"),
    config: path.join(root, "config.json"),
    state: path.join(root, "state.json"),
  };
}

export async function ensureRuntime() {
  const paths = runtimePaths();
  await Promise.all([
    mkdir(paths.root, { recursive: true, mode: 0o700 }),
    mkdir(paths.requests, { recursive: true, mode: 0o700 }),
    mkdir(paths.responses, { recursive: true, mode: 0o700 }),
    mkdir(paths.logs, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([chmod(paths.root, 0o700), chmod(paths.requests, 0o700), chmod(paths.responses, 0o700), chmod(paths.logs, 0o700)]).catch(() => {});
  return paths;
}

export async function atomicWriteJson(file, value, mode = 0o600) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode });
  await rename(temporary, file);
}

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock } from "./lock.js";
import { daemonPaths, ensurePrivateDir } from "./paths.js";
import { openSocket, socketIsLive } from "./socket.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const START_LOCK_TIMEOUT_MS = 30_000;
const STOP_WAIT_MS = 50;

// Concurrent cold tool calls used to spawn one daemon each; they then raced to
// bind the socket and to migrate the same CodeGraph database ("database is
// locked"). One launch per process, everyone else waits for it.
let launching = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readDaemonPackageVersion(paths) {
  try {
    const stamped = readFileSync(paths.packageVersion, "utf8").trim();
    if (stamped) return stamped;
  } catch {}
  try {
    const registry = JSON.parse(readFileSync(paths.registry, "utf8"));
    return typeof registry.version === "string" ? registry.version : null;
  } catch {
    return null;
  }
}

function daemonPid(paths) {
  try {
    const pid = Number(readFileSync(paths.pid, "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

async function daemonIsCurrent(paths) {
  if (!(await socketIsLive(paths.socket))) return false;
  return readDaemonPackageVersion(paths) === version;
}

async function stopDaemon(paths) {
  const pid = daemonPid(paths);
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await socketIsLive(paths.socket))) return;
    await sleep(STOP_WAIT_MS);
  }
  if (pid) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await socketIsLive(paths.socket))) return;
    await sleep(STOP_WAIT_MS);
  }
}

export async function connectDaemon() {
  const paths = daemonPaths();
  if (await daemonIsCurrent(paths)) {
    return openSocket(paths.socket);
  }

  if (!launching) {
    launching = ensureDaemon(paths).finally(() => {
      launching = null;
    });
  }
  await launching;
  return openSocket(paths.socket);
}

// One launch per process is not enough: several MCP servers and CLI invocations
// share one user-level daemon, so the autostart also has to be single across
// processes. Only the startup window is locked. A live socket from an older
// package is not current: path join and file-as-root live in the daemon, so an
// upgrade has to replace that process or 0.2.8's contract never takes effect.
async function ensureDaemon(paths) {
  const current = () => daemonIsCurrent(paths);
  const held = await acquireLock(paths.startLock, {
    timeoutMs: START_LOCK_TIMEOUT_MS,
    label: "daemon autostart",
    shortCircuit: current,
  });
  if (!held.release) return;
  try {
    if (await current()) return;
    if (await socketIsLive(paths.socket)) {
      await stopDaemon(paths);
    }
    await launchDaemon(paths);
  } finally {
    held.release();
  }
}

async function launchDaemon(paths) {
  ensurePrivateDir(dirname(paths.log));
  const logFd = openSync(paths.log, "a");
  const script = fileURLToPath(new URL("./daemon.js", import.meta.url));
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
    cwd: packageRoot,
  });
  child.unref();
  closeSync(logFd);

  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      const probe = await openSocket(paths.socket);
      probe.end();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `daemon did not start: ${lastError?.message || `see ${paths.log}`}`,
  );
}

export async function queryDaemon(request, { onProgress, signal } = {}) {
  const socket = await connectDaemon();
  socket.setEncoding("utf8");
  let buffer = "";
  let settled = false;

  const completion = new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const onAbort = () => {
      socket.destroy();
      finish(reject, new Error("request cancelled"));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.type === "progress") {
          onProgress?.(message);
        } else if (message.type === "error") {
          finish(reject, new Error(message.error));
        } else if (message.type === "result") {
          finish(resolve, message.result);
        }
      }
    });
    socket.on("error", (error) => finish(reject, error));
    socket.on("end", () => {
      if (!settled) {
        finish(
          reject,
          new Error("daemon returned an incomplete response"),
        );
      }
    });
    socket.on("close", () => {
      signal?.removeEventListener("abort", onAbort);
    });
  });

  socket.write(`${JSON.stringify(request)}\n`);
  try {
    return await completion;
  } finally {
    if (!socket.destroyed) socket.end();
  }
}

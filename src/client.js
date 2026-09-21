import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonPaths } from "./paths.js";

function openSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

// Concurrent cold tool calls used to spawn one daemon each; they then raced to
// bind the socket and to migrate the same CodeGraph database ("database is
// locked"). One launch per process, everyone else waits for it.
let launching = null;

export async function connectDaemon() {
  const paths = daemonPaths();
  try {
    return await openSocket(paths.socket);
  } catch {}

  if (!launching) {
    launching = launchDaemon(paths).finally(() => {
      launching = null;
    });
  }
  await launching;
  return openSocket(paths.socket);
}

async function launchDaemon(paths) {
  mkdirSync(dirname(paths.log), { recursive: true });
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

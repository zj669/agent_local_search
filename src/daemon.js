#!/usr/bin/env node

import { createServer } from "node:net";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { acquireLock } from "./lock.js";
import { daemonPaths, resolveRequestRoot, rootBucket } from "./paths.js";
import { RootContext } from "./root-context.js";
import { socketIsLive } from "./socket.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const CWD_SOURCES = new Set([
  "roots/list",
  "spawn cwd",
  "cwd argument",
  "shell cwd",
]);
const ROOT_LIMIT = 4;
const ROOT_TTL_MS = 5 * 60 * 1_000;
const DAEMON_IDLE_MS = 30 * 60 * 1_000;
const BIND_LOCK_TIMEOUT_MS = 30_000;
const paths = daemonPaths();
const roots = new Map();
const opening = new Map();
const graphDirs = {};
let lastRequestAt = Date.now();
let shuttingDown = false;

await mkdir(paths.daemonDir, { recursive: true });
await mkdir(dirname(paths.log), { recursive: true });

async function persistRegistry() {
  const value = {
    pid: process.pid,
    version,
    socket: paths.socket,
    startedAt: new Date(process.uptime() ? Date.now() - process.uptime() * 1_000 : Date.now()).toISOString(),
    roots: [...roots.values()].map((entry) => ({
      root: entry.root,
      status: entry.status,
      lastAccessedAt: new Date(entry.lastAccess).toISOString(),
    })),
  };
  await writeFile(paths.packageVersion, `${version}\n`);
  await writeFile(paths.registry, `${JSON.stringify(value, null, 2)}\n`);
}

function injectGraphDir(root) {
  const bucket = rootBucket(paths.base, root);
  graphDirs[root] = bucket.graphDir;
  process.env.CODEQ_CODEGRAPH_DATA_DIRS = JSON.stringify(graphDirs);
}

async function waitForSlot() {
  while (roots.size >= ROOT_LIMIT) {
    const candidate = [...roots.values()]
      .filter((entry) => entry.active === 0)
      .sort((a, b) => a.lastAccess - b.lastAccess)[0];
    if (candidate) {
      roots.delete(candidate.root);
      candidate.dispose();
      delete graphDirs[candidate.root];
      process.env.CODEQ_CODEGRAPH_DATA_DIRS = JSON.stringify(graphDirs);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// waitForSlot yields, so two cold requests for the same root used to build two
// RootContexts — two graph workers migrating one database. The promise is
// registered before the first await, so the second request joins the first.
async function contextFor(root) {
  const existing = roots.get(root);
  if (existing) {
    existing.touch();
    return existing;
  }
  const pending = opening.get(root);
  if (pending) return pending;
  const creating = (async () => {
    await waitForSlot();
    injectGraphDir(root);
    const context = new RootContext(root, paths.base);
    roots.set(root, context);
    context.startGraphIndex().catch(() => {});
    await persistRegistry();
    return context;
  })().finally(() => opening.delete(root));
  opening.set(root, creating);
  return creating;
}

function send(socket, message) {
  if (!socket.destroyed && socket.writable) {
    socket.write(`${JSON.stringify(message)}\n`);
  }
}

async function execute(request, socket) {
  lastRequestAt = Date.now();
  const routed = await resolveRequestRoot(request);
  const context = await contextFor(routed.root);
  const progress = (value) => send(socket, { type: "progress", ...value });

  const result = await context.use(async () => {
    if (request.command === "find") {
      return context.find(request.query, {
        constraint: routed.constraint,
        limit: request.limit,
      });
    }
    if (request.command === "grep") {
      return context.grep(request.query, {
        constraint: routed.constraint,
        glob: request.glob,
        context: request.context ?? 0,
        limit: request.limit,
        fuzzy: Boolean(request.fuzzy),
        regex: Boolean(request.regex),
        cursor: request.cursor,
        count: Boolean(request.count),
        ignoreCase: request.ignoreCase,
      });
    }
    if (request.command === "graph") {
      progress({ phase: "graph", message: `querying ${routed.root}` });
      return context.explore(
        request.query,
        { constraint: routed.constraint },
        progress,
      );
    }
    throw new Error(`unknown command: ${request.command}`);
  });

  return {
    ...result,
    rootSource: routed.source,
    rootNote: routed.note,
    cwdSource: CWD_SOURCES.has(request.cwdSource) ? request.cwdSource : null,
  };
}

const server = createServer((socket) => {
  socket.setEncoding("utf8");
  let input = "";
  let handled = false;

  socket.on("data", (chunk) => {
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline < 0 || handled) return;
    handled = true;
    let request;
    try {
      request = JSON.parse(input.slice(0, newline));
    } catch (error) {
      send(socket, { type: "error", error: `invalid request: ${error.message}` });
      socket.end();
      return;
    }
    execute(request, socket)
      .then(async (result) => {
        send(socket, { type: "result", result });
        socket.end();
        await persistRegistry();
      })
      .catch((error) => {
        send(socket, { type: "error", error: error.message || String(error) });
        socket.end();
      });
  });
  socket.on("error", () => {});
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  for (const context of roots.values()) context.dispose();
  roots.clear();
  await rm(paths.socket, { force: true }).catch(() => {});
  await rm(paths.pid, { force: true }).catch(() => {});
  process.exit(0);
}

// Binding is the other cross-process critical section: without this lock a
// second daemon unlinks a live socket and both end up half-owning it.
const bind = await acquireLock(paths.bindLock, {
  timeoutMs: BIND_LOCK_TIMEOUT_MS,
  label: "daemon bind",
  shortCircuit: () => socketIsLive(paths.socket),
});
if (!bind.release) process.exit(0);
let outcome = "listening";
try {
  if (await socketIsLive(paths.socket)) {
    outcome = "duplicate";
  } else {
    if (process.platform !== "win32" && existsSync(paths.socket)) {
      await rm(paths.socket, { force: true });
    }
    // Stamp the package version before the socket exists so a client that sees
    // a live socket can tell this process from an older daemon.
    await writeFile(paths.packageVersion, `${version}\n`);
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(paths.socket, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
    await writeFile(paths.pid, `${process.pid}\n`);
    await persistRegistry();
  }
} catch (error) {
  outcome =
    error.code === "EADDRINUSE" && (await socketIsLive(paths.socket))
      ? "duplicate"
      : error;
} finally {
  bind.release();
}

if (outcome === "duplicate") process.exit(0);
if (outcome !== "listening") {
  process.stderr.write(`codeq daemon: ${outcome.message || outcome}\n`);
  process.exit(1);
}
await persistRegistry();

const maintenance = setInterval(() => {
  const now = Date.now();
  for (const context of roots.values()) {
    if (context.active === 0 && now - context.lastAccess >= ROOT_TTL_MS) {
      roots.delete(context.root);
      context.dispose();
      delete graphDirs[context.root];
    }
  }
  process.env.CODEQ_CODEGRAPH_DATA_DIRS = JSON.stringify(graphDirs);
  void persistRegistry();
  if (
    now - lastRequestAt >= DAEMON_IDLE_MS &&
    [...roots.values()].every((context) => context.active === 0)
  ) {
    void shutdown();
  }
}, 30_000);
maintenance.unref();

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("uncaughtException", (error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
});

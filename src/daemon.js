#!/usr/bin/env node

import { createServer } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { daemonPaths, resolveRequestRoot, rootBucket } from "./paths.js";
import { RootContext } from "./root-context.js";

const CWD_SOURCES = new Set([
  "roots/list",
  "spawn cwd",
  "cwd argument",
  "shell cwd",
]);
const ROOT_LIMIT = 4;
const ROOT_TTL_MS = 5 * 60 * 1_000;
const DAEMON_IDLE_MS = 30 * 60 * 1_000;
const paths = daemonPaths();
const roots = new Map();
const graphDirs = {};
let lastRequestAt = Date.now();
let shuttingDown = false;

await mkdir(paths.daemonDir, { recursive: true });
await mkdir(dirname(paths.log), { recursive: true });

async function persistRegistry() {
  const value = {
    pid: process.pid,
    socket: paths.socket,
    startedAt: new Date(process.uptime() ? Date.now() - process.uptime() * 1_000 : Date.now()).toISOString(),
    roots: [...roots.values()].map((entry) => ({
      root: entry.root,
      status: entry.status,
      lastAccessedAt: new Date(entry.lastAccess).toISOString(),
    })),
  };
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

async function contextFor(root) {
  let context = roots.get(root);
  if (context) {
    context.touch();
    return context;
  }
  await waitForSlot();
  injectGraphDir(root);
  context = new RootContext(root, paths.base);
  roots.set(root, context);
  context.startGraphIndex().catch(() => {});
  await persistRegistry();
  return context;
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
        limit: request.limit ?? 50,
      });
    }
    if (request.command === "grep") {
      return context.grep(request.query, {
        constraint: routed.constraint,
        glob: request.glob,
        context: request.context ?? 0,
        limit: request.limit ?? 50,
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

if (process.platform !== "win32" && existsSync(paths.socket)) {
  await rm(paths.socket, { force: true });
}
await writeFile(paths.pid, `${process.pid}\n`);

server.listen(paths.socket, async () => {
  if (process.platform !== "win32") {
    try {
      const mode = (await readFile(paths.pid, "utf8")).trim();
      if (mode !== String(process.pid)) throw new Error("daemon pid changed");
    } catch {}
  }
  await persistRegistry();
});

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

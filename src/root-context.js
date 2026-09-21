import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FileFinder } from "@ff-labs/fff-node";
import { rootBucket } from "./paths.js";

const require = createRequire(import.meta.url);

function unwrap(result, operation) {
  if (!result.ok) throw new Error(`${operation}: ${result.error}`);
  return result.value;
}

function bundledNode() {
  const platformRoot = dirname(
    require.resolve(
      `@colbymchenry/codegraph-${process.platform}-${process.arch}/package.json`,
    ),
  );
  const candidates = [
    join(platformRoot, process.platform === "win32" ? "node.exe" : "node"),
    join(platformRoot, "node", "bin", process.platform === "win32" ? "node.exe" : "node"),
    join(platformRoot, "bin", process.platform === "win32" ? "node.exe" : "node"),
  ];
  const executable = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  if (!executable) {
    throw new Error("CodeGraph bundled Node runtime is missing");
  }
  return executable;
}

export class RootContext {
  constructor(root, dataDir) {
    this.root = root;
    this.location = rootBucket(dataDir, root);
    this.lastAccess = Date.now();
    this.active = 0;
    this.status = "indexing";
    this.warning = null;
    this.lastSuccessfulSync = null;
    this.finder = null;
    this.graphReady = false;
    this.graphProcess = null;
    this.graphPending = new Map();
    this.graphSequence = 0;
    this.graphProgressListeners = new Set();
    this.fffPromise = this.#initializeFff();
    this.graphPromise = null;
  }

  async #writeMetadata() {
    await mkdir(this.location.bucket, { recursive: true });
    await writeFile(
      this.location.metadata,
      `${JSON.stringify(
        {
          root: this.root,
          schema: 1,
          codegraphVersion: "1.6.0",
          lastAccessedAt: new Date(this.lastAccess).toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  }

  async #initializeFff() {
    await this.#writeMetadata();
    const created = FileFinder.create({
      basePath: this.root,
      aiMode: true,
    });
    this.finder = unwrap(created, "FFF initialization failed");
    const scanned = unwrap(
      await this.finder.waitForIndexReady(60_000),
      "FFF initial scan failed",
    );
    if (!scanned) {
      this.warning = "FFF initial scan is still running";
    }
    this.#refreshStatus();
    return this.finder;
  }

  #refreshStatus() {
    if (this.warning) {
      this.status = "degraded";
      return;
    }
    if (this.finder && this.graphReady) {
      this.status = "ready";
      return;
    }
    this.status = "indexing";
  }

  touch() {
    this.lastAccess = Date.now();
    void this.#writeMetadata();
  }

  async use(operation) {
    this.active += 1;
    this.touch();
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.touch();
    }
  }

  startGraphIndex(onProgress = () => {}) {
    this.graphProgressListeners.add(onProgress);
    if (!this.graphPromise) {
      this.graphPromise = this.#initializeGraph().catch((error) => {
        this.warning = `CodeGraph indexing failed: ${error.message}`;
        this.#refreshStatus();
        throw error;
      });
      this.graphPromise.catch(() => {});
    }
    return this.graphPromise.finally(() => {
      this.graphProgressListeners.delete(onProgress);
    });
  }

  async #initializeGraph() {
    await mkdir(this.location.graphDir, { recursive: true });
    const worker = fileURLToPath(new URL("./graph-worker.js", import.meta.url));
    this.graphProcess = spawn(
      bundledNode(),
      ["--liftoff-only", worker, this.root],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEQ_CODEGRAPH_DATA_DIRS: JSON.stringify({
            [this.root]: this.location.graphDir,
          }),
        },
      },
    );
    this.graphProcess.stderr.setEncoding("utf8");
    this.graphProcess.stderr.on("data", (chunk) => {
      process.stderr.write(`[codegraph:${this.location.key.slice(0, 8)}] ${chunk}`);
    });
    this.graphProcess.stdout.setEncoding("utf8");

    return new Promise((resolve, reject) => {
      let output = "";
      let settled = false;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      this.graphProcess.once("error", fail);
      this.graphProcess.once("exit", (code, signal) => {
        this.graphReady = false;
        const error = new Error(
          `CodeGraph worker exited (${signal || code || "unknown"})`,
        );
        fail(error);
        for (const pending of this.graphPending.values()) pending.reject(error);
        this.graphPending.clear();
        this.#refreshStatus();
      });
      this.graphProcess.stdout.on("data", (chunk) => {
        output += chunk;
        for (;;) {
          const newline = output.indexOf("\n");
          if (newline < 0) break;
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          if (!line) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.type === "progress") {
            for (const listener of this.graphProgressListeners) listener(message);
          } else if (message.type === "ready") {
            this.graphReady = true;
            this.lastSuccessfulSync = new Date().toISOString();
            if (!message.watching) {
              this.warning = "CodeGraph watcher could not be started";
            }
            this.#refreshStatus();
            if (!settled) {
              settled = true;
              resolve();
            }
          } else if (message.type === "sync") {
            this.lastSuccessfulSync = message.at;
            this.warning = null;
            this.#refreshStatus();
          } else if (message.type === "degraded") {
            this.warning = `CodeGraph watcher degraded: ${message.reason}`;
            this.#refreshStatus();
          } else if (message.type === "response") {
            const pending = this.graphPending.get(message.id);
            if (!pending) continue;
            this.graphPending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error));
            else pending.resolve(message.result);
          }
        }
      });
    });
  }

  metadata() {
    this.#refreshStatus();
    return {
      root: this.root,
      status: this.status,
      warning: this.warning,
      lastSuccessfulSync: this.lastSuccessfulSync,
    };
  }

  async find(query, options) {
    const finder = await this.fffPromise;
    const scoped = options.constraint
      ? `${options.constraint} ${query}`.trim()
      : query;
    const value = unwrap(
      finder.fileSearch(scoped, { pageSize: options.limit }),
      "FFF file search failed",
    );
    return {
      ...this.metadata(),
      total: value.totalMatched,
      results: value.items.map((item, index) => ({
        path: item.relativePath,
        size: item.size,
        modified: item.modified,
        gitStatus: item.gitStatus,
        score: value.scores[index]?.total ?? null,
      })),
    };
  }

  async grep(pattern, options) {
    const constraints = [];
    if (options.constraint) constraints.push(options.constraint);
    if (options.glob) constraints.push(options.glob);
    constraints.push(pattern);
    const value = unwrap(
      (await this.fffPromise).grep(constraints.join(" "), {
        mode: "plain",
        pageSize: options.limit,
        beforeContext: options.context,
        afterContext: options.context,
      }),
      "FFF content search failed",
    );
    return {
      ...this.metadata(),
      total: value.totalMatched,
      results: value.items.map((item) => ({
        path: item.relativePath,
        line: item.lineNumber,
        column: item.col + 1,
        text: item.lineContent,
        contextBefore: item.contextBefore || [],
        contextAfter: item.contextAfter || [],
      })),
    };
  }

  async explore(query, options, onProgress) {
    await this.startGraphIndex(onProgress);
    const scoped = options.constraint
      ? `${query} path:${options.constraint.replace(/\/$/, "")}`
      : query;
    const id = ++this.graphSequence;
    const result = await new Promise((resolve, reject) => {
      this.graphPending.set(id, { resolve, reject });
      this.graphProcess.stdin.write(`${JSON.stringify({ id, query: scoped })}\n`);
    });
    return {
      ...this.metadata(),
      query,
      result,
    };
  }

  dispose() {
    try {
      this.finder?.destroy();
    } catch {}
    const error = new Error("root context was evicted");
    for (const pending of this.graphPending.values()) pending.reject(error);
    this.graphPending.clear();
    try {
      this.graphProcess?.stdin.end();
      this.graphProcess?.kill("SIGTERM");
    } catch {}
    this.finder = null;
    this.graphReady = false;
    this.graphProcess = null;
  }
}

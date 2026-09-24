import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FileFinder } from "@ff-labs/fff-node";
import {
  encodeNextGrepCursor,
  GREP_COUNT_CURSOR_ERROR,
  grepCursorOffset,
  openGrepCursor,
  toFffCursor,
} from "./grep-cursor.js";
import {
  assertGrepPattern,
  grepCaseOptions,
  ignoreCaseCursorValue,
} from "./grep-mode.js";
import { acquireLock } from "./lock.js";
import {
  clampGrepContext,
  CONTEXT_CAP,
  COUNT_SCAN_CAP,
  RANK_WINDOW,
} from "./limits.js";
import { applyFindWindow, applyGrepWindow } from "./path-tier.js";
import {
  ensurePrivateDir,
  ensurePrivateFile,
  rootBucket,
} from "./paths.js";
import { planFindSearch, runFindSearch } from "./find-glob.js";

const require = createRequire(import.meta.url);

const GRAPH_LOCK_TIMEOUT_MS = 15 * 60 * 1_000;

function unwrap(result, operation) {
  if (!result.ok) throw new Error(`${operation}: ${result.error}`);
  return result.value;
}

function pageMeta(options = {}) {
  return {
    requestedLimit:
      Number.isSafeInteger(options.limit) && options.limit > 0
        ? options.limit
        : null,
    pageCap: RANK_WINDOW,
  };
}

function fffGrepOptions({ mode, ignoreCase, context }) {
  return {
    mode,
    ...grepCaseOptions(ignoreCase),
    pageSize: RANK_WINDOW,
    beforeContext: context,
    afterContext: context,
  };
}

function mapGrepHit(item) {
  return {
    path: item.relativePath,
    line: item.lineNumber,
    column: item.col + 1,
    text: item.lineContent,
    contextBefore: item.contextBefore || [],
    contextAfter: item.contextAfter || [],
  };
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
    this.fffUnwatch = null;
    this.fffPromise = this.#initializeFff();
    this.graphPromise = null;
  }

  async #writeMetadata() {
    ensurePrivateDir(this.location.bucket);
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
    ensurePrivateFile(this.location.metadata);
  }

  async #initializeFff() {
    await this.#writeMetadata();
    const created = FileFinder.create({
      basePath: this.root,
      aiMode: true,
    });
    this.finder = unwrap(created, "FFF initialization failed");
    this.#subscribeFffWatch();
    const scanned = unwrap(
      await this.finder.waitForIndexReady(60_000),
      "FFF initial scan failed",
    );
    if (!scanned) {
      this.warning = "FFF initial scan is still running";
    }
    this.#noteFffFreshness(this.finder);
    this.#refreshStatus();
    return this.finder;
  }

  #subscribeFffWatch() {
    if (!this.finder?.watch) return;
    const watched = this.finder.watch((events) => {
      if (!events?.some((event) => event.kind === "rescan")) return;
      this.warning = "FFF missed filesystem events and is rescanning";
      this.#refreshStatus();
      try {
        this.finder.scanFiles();
      } catch {}
    });
    if (watched.ok) this.fffUnwatch = watched.value;
  }

  #noteFffFreshness(finder) {
    const progressResult = finder.getScanProgress?.();
    if (!progressResult?.ok) return;
    const snap = progressResult.value;
    if (snap.isScanning) return;
    if (this.warning === "FFF initial scan is still running") {
      this.warning = null;
    }
    if (snap.isWatcherReady === false) {
      this.warning = this.warning || "FFF watcher is not covering this root";
    } else if (this.warning === "FFF watcher is not covering this root") {
      this.warning = null;
    }
    if (snap.isWatcherReady && !this.lastSuccessfulSync) {
      this.lastSuccessfulSync = new Date().toISOString();
    }
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

  // Opening a graph migrates and may index the database, which one SQLite writer
  // at a time can do. The lock lives next to the database so it covers every
  // process that could reach the same bucket, and is released once the worker
  // reports ready — queries after that run concurrently.
  async #initializeGraph() {
    const held = await acquireLock(this.location.graphLock, {
      timeoutMs: GRAPH_LOCK_TIMEOUT_MS,
      label: `codegraph ${this.root}`,
    });
    try {
      return await this.#openGraph();
    } finally {
      held.release?.();
    }
  }

  async #openGraph() {
    ensurePrivateDir(this.location.graphDir);
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
            else {
              pending.resolve({
                text: message.result,
                symbols: Array.isArray(message.symbols) ? message.symbols : [],
              });
            }
          }
        }
      });
    });
  }

  metadata() {
    if (this.finder) this.#noteFffFreshness(this.finder);
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
    const plan = planFindSearch(query, options.constraint);
    const { value, globFallback } = runFindSearch(plan, (needle) =>
      unwrap(
        finder.fileSearch(needle, { pageSize: RANK_WINDOW }),
        "FFF file search failed",
      ),
    );
    const mapped = value.items.map((item, index) => ({
      path: item.relativePath,
      size: item.size,
      modified: item.modified,
      gitStatus: item.gitStatus,
      score: value.scores[index]?.total ?? null,
      matchType: value.scores[index]?.matchType ?? null,
    }));
    return {
      ...this.metadata(),
      query,
      total: value.totalMatched,
      indexed: value.totalFiles ?? null,
      results: applyFindWindow(mapped, options.limit),
      preserveOrder: true,
      ...pageMeta(options),
      ...(globFallback ? { globFallback } : {}),
    };
  }

  async grep(pattern, options) {
    const regex = Boolean(options.regex);
    const fuzzyRequested = Boolean(options.fuzzy);
    const mode = assertGrepPattern(pattern, { regex });
    const finder = await this.fffPromise;
    const constraints = [];
    if (options.constraint) constraints.push(options.constraint);
    if (options.glob) constraints.push(options.glob);
    const query = [...constraints, pattern].join(" ");
    const context = clampGrepContext(options.context);
    const contextCapped =
      Number.isSafeInteger(options.context) && options.context > CONTEXT_CAP;
    const ignoreCaseBound = ignoreCaseCursorValue(options.ignoreCase);
    const search = {
      root: this.root,
      pattern,
      glob: options.glob || "",
      constraint: options.constraint || "",
      regex,
      fuzzy: fuzzyRequested,
      context,
      ignoreCase: ignoreCaseBound,
    };
    if (options.count) {
      if (options.cursor) throw new Error(GREP_COUNT_CURSOR_ERROR);
      return this.#grepCount({
        finder,
        query,
        pattern,
        mode,
        regex,
        fuzzyRequested,
        ignoreCase: options.ignoreCase,
      });
    }
    const grepOptions = fffGrepOptions({
      mode,
      ignoreCase: options.ignoreCase,
      context,
    });
    let windowStart = 0;
    let rankedOffset = 0;
    if (options.cursor) {
      const opened = openGrepCursor(options.cursor, search);
      grepOptions.mode = opened.mode;
      windowStart = opened.window;
      rankedOffset = opened.offset;
      if (windowStart > 0) grepOptions.cursor = toFffCursor(windowStart);
    }
    let value = unwrap(finder.grep(query, grepOptions), "FFF content search failed");
    let usedFuzzy = grepOptions.mode === "fuzzy";
    if (
      !options.cursor &&
      fuzzyRequested &&
      value.items.length === 0 &&
      mode !== "regex"
    ) {
      const fuzzy = unwrap(
        finder.grep(query, {
          ...grepOptions,
          mode: "fuzzy",
          cursor: null,
          beforeContext: 0,
          afterContext: 0,
        }),
        "FFF fuzzy content search failed",
      );
      if (fuzzy.items.length > 0) {
        value = fuzzy;
        usedFuzzy = true;
      }
    }
    const mapped = value.items.map(mapGrepHit);
    const { ranked, page } = applyGrepWindow(
      mapped,
      pattern,
      options.limit,
      rankedOffset,
    );
    const pageMode = usedFuzzy ? "fuzzy" : grepOptions.mode;
    const nextCursor = encodeNextGrepCursor(
      { ...search, mode: pageMode },
      {
        rankedLength: ranked.length,
        offset: rankedOffset,
        pageLength: page.length,
        windowStart,
        fffNextOffset: grepCursorOffset(value.nextCursor),
      },
    );
    return {
      ...this.metadata(),
      pattern,
      mode: pageMode,
      regex,
      fuzzyRequested,
      shown: page.length,
      nextCursor,
      results: page,
      context,
      contextCapped,
      ...pageMeta(options),
    };
  }

  async #grepCount({
    finder,
    query,
    pattern,
    mode,
    regex,
    fuzzyRequested,
    ignoreCase,
  }) {
    const grepOptions = fffGrepOptions({
      mode,
      ignoreCase,
      context: 0,
    });
    let value = unwrap(finder.grep(query, grepOptions), "FFF content search failed");
    let usedFuzzy = grepOptions.mode === "fuzzy";
    if (fuzzyRequested && value.items.length === 0 && mode !== "regex") {
      const fuzzy = unwrap(
        finder.grep(query, { ...grepOptions, mode: "fuzzy", cursor: null }),
        "FFF fuzzy content search failed",
      );
      if (fuzzy.items.length > 0) {
        value = fuzzy;
        usedFuzzy = true;
        grepOptions.mode = "fuzzy";
      }
    }
    let matchCount = 0;
    const files = new Set();
    let moreRemain = false;
    let current = value;
    while (true) {
      for (const item of current.items) {
        if (matchCount >= COUNT_SCAN_CAP) {
          moreRemain = true;
          break;
        }
        matchCount += 1;
        files.add(item.relativePath);
      }
      if (moreRemain) break;
      const next = grepCursorOffset(current.nextCursor);
      if (!Number.isSafeInteger(next) || next <= 0) break;
      if (current.items.length === 0) break;
      current = unwrap(
        finder.grep(query, { ...grepOptions, cursor: toFffCursor(next) }),
        "FFF content search failed",
      );
    }
    return {
      ...this.metadata(),
      pattern,
      mode: usedFuzzy ? "fuzzy" : grepOptions.mode,
      regex,
      fuzzyRequested,
      count: true,
      matchCount,
      fileCount: files.size,
      countTruncated: moreRemain,
      shown: 0,
      nextCursor: null,
      results: [],
      context: 0,
      contextCapped: false,
      ...pageMeta({}),
    };
  }

  async explore(query, options, onProgress) {
    await this.startGraphIndex(onProgress);
    const scoped = options.constraint
      ? `${query} path:${options.constraint.replace(/\/$/, "")}`
      : query;
    const id = ++this.graphSequence;
    const payload = await new Promise((resolve, reject) => {
      this.graphPending.set(id, { resolve, reject });
      this.graphProcess.stdin.write(`${JSON.stringify({ id, query: scoped })}\n`);
    });
    const text = typeof payload === "string" ? payload : payload.text;
    const symbols = typeof payload === "string" ? [] : payload.symbols || [];
    return {
      ...this.metadata(),
      query,
      constraint: options.constraint || null,
      result: text,
      symbols,
    };
  }

  dispose() {
    try {
      this.fffUnwatch?.();
    } catch {}
    this.fffUnwatch = null;
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

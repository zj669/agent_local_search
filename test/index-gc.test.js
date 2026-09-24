import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  indexGcOptionsFromEnv,
  listRootIndexes,
  pruneRootIndexes,
} from "../src/index-gc.js";
import {
  INDEX_COUNT_CAP,
  INDEX_KEEP_HOT_MS,
  INDEX_MAX_BYTES,
  INDEX_TTL_MS,
} from "../src/limits.js";
import { MCP_INSTRUCTIONS } from "../src/mcp-format.js";
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  rootBucket,
  rootsDir,
  unsafeRootReason,
} from "../src/paths.js";

const execFileAsync = promisify(execFile);
const bin = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));

function iso(ms) {
  return new Date(ms).toISOString();
}

function dataBase() {
  return mkdtempSync(join(tmpdir(), "codeq-index-gc-"));
}

function writeBucket(base, key, { root = `/tmp/${key}`, lastAccess, bytes = 256 } = {}) {
  const bucket = join(rootsDir(base), key);
  mkdirSync(join(bucket, "codegraph"), { recursive: true });
  const metadata = join(bucket, "root.json");
  writeFileSync(
    metadata,
    `${JSON.stringify(
      {
        root,
        schema: 1,
        codegraphVersion: "1.6.0",
        lastAccessedAt: iso(lastAccess),
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  );
  writeFileSync(join(bucket, "codegraph", "index.db"), "x".repeat(bytes), {
    mode: 0o644,
  });
  chmodSync(bucket, 0o755);
  return bucket;
}

function keysLeft(base) {
  const dir = rootsDir(base);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

function modeOf(path) {
  return statSync(path).mode & 0o777;
}

function gitRepo(parent, name) {
  const root = join(parent, name);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "session.ts"),
    "export function createSession() { return { id: 1 }; }\n",
  );
  mkdirSync(join(root, ".codegraph"), { recursive: true });
  writeFileSync(join(root, ".codegraph", "planted.txt"), "do-not-touch\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=codeq-test",
      "-c",
      "user.email=codeq@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  return realpathSync(root);
}

function stopDaemon(dataDir) {
  const pidFile = join(dataDir, "daemon", "daemon.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

test("TTL deletes stale indexes and keeps recent ones", () => {
  const base = dataBase();
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  writeBucket(base, "stale", { lastAccess: now - 10_000, bytes: 400 });
  writeBucket(base, "fresh", { lastAccess: now - 200, bytes: 400 });
  const result = pruneRootIndexes({
    base,
    now,
    ttlMs: 1_000,
    keepHotMs: 0,
    countCap: 100,
    maxBytes: INDEX_MAX_BYTES,
  });
  assert.deepEqual(result.deleted.sort(), ["stale"]);
  assert.deepEqual(keysLeft(base), ["fresh"]);
});

test("keep-hot retains a just-queried index even when TTL has expired", () => {
  const base = dataBase();
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  writeBucket(base, "hot", { lastAccess: now - 5_000 });
  writeBucket(base, "cold", { lastAccess: now - 120_000 });
  pruneRootIndexes({
    base,
    now,
    ttlMs: 0,
    keepHotMs: 30_000,
    countCap: 100,
    maxBytes: INDEX_MAX_BYTES,
  });
  assert.deepEqual(keysLeft(base), ["hot"]);
});

test("keep-hot wins over count cap: two hot indexes both stay", () => {
  const base = dataBase();
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  writeBucket(base, "hot-a", { lastAccess: now - 1_000 });
  writeBucket(base, "hot-b", { lastAccess: now - 2_000 });
  writeBucket(base, "cold", { lastAccess: now - 90_000 });
  pruneRootIndexes({
    base,
    now,
    ttlMs: INDEX_TTL_MS,
    keepHotMs: 10_000,
    countCap: 1,
    maxBytes: INDEX_MAX_BYTES,
  });
  assert.deepEqual(keysLeft(base), ["hot-a", "hot-b"]);
});

test("count cap LRU keeps the newest idle indexes", () => {
  const base = dataBase();
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  writeBucket(base, "a", { lastAccess: now - 50_000 });
  writeBucket(base, "b", { lastAccess: now - 40_000 });
  writeBucket(base, "c", { lastAccess: now - 30_000 });
  writeBucket(base, "d", { lastAccess: now - 20_000 });
  writeBucket(base, "e", { lastAccess: now - 10_000 });
  pruneRootIndexes({
    base,
    now,
    ttlMs: INDEX_TTL_MS,
    keepHotMs: 0,
    countCap: 2,
    maxBytes: INDEX_MAX_BYTES,
  });
  assert.deepEqual(keysLeft(base), ["d", "e"]);
});

test("size budget deletes oldest idle indexes until under the cap", () => {
  const base = dataBase();
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  writeBucket(base, "old", { lastAccess: now - 30_000, bytes: 8_000 });
  writeBucket(base, "mid", { lastAccess: now - 20_000, bytes: 8_000 });
  writeBucket(base, "new", { lastAccess: now - 10_000, bytes: 8_000 });
  const total = listRootIndexes(base).reduce((sum, entry) => sum + entry.bytes, 0);
  assert.ok(total > 20_000);
  pruneRootIndexes({
    base,
    now,
    ttlMs: INDEX_TTL_MS,
    keepHotMs: 0,
    countCap: 100,
    maxBytes: 12_000,
  });
  const remain = listRootIndexes(base);
  assert.deepEqual(
    remain.map((entry) => entry.key),
    ["new"],
  );
  assert.ok(remain[0].bytes <= 12_000);
});

test("does not delete an in-use index even when every budget is exceeded", () => {
  const base = dataBase();
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  writeBucket(base, "busy", { root: "/tmp/busy", lastAccess: now - 86_400_000, bytes: 9_000 });
  writeBucket(base, "idle", { root: "/tmp/idle", lastAccess: now - 86_400_000, bytes: 9_000 });
  pruneRootIndexes({
    base,
    now,
    ttlMs: 1,
    keepHotMs: 0,
    countCap: 0,
    maxBytes: 0,
    inUseKeys: ["busy"],
    inUseRoots: ["/tmp/busy"],
  });
  assert.deepEqual(keysLeft(base), ["busy"]);
});

test("a live graph lock counts as in-use", () => {
  const base = dataBase();
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const bucket = writeBucket(base, "locked", { lastAccess: now - 86_400_000 });
  writeFileSync(
    join(bucket, "codegraph.lock"),
    `${JSON.stringify({ pid: process.pid, label: "codegraph /tmp/locked" })}\n`,
  );
  pruneRootIndexes({
    base,
    now,
    ttlMs: 1,
    keepHotMs: 0,
    countCap: 0,
    maxBytes: 0,
  });
  assert.deepEqual(keysLeft(base), ["locked"]);
});

test("restart with empty memory still keeps a just-queried bucket via root.json", () => {
  const base = dataBase();
  const now = Date.now();
  writeBucket(base, "recent", { lastAccess: now - 2_000 });
  writeBucket(base, "ancient", { lastAccess: now - INDEX_TTL_MS - 60_000 });
  pruneRootIndexes({
    base,
    now,
    inUseKeys: [],
    inUseRoots: [],
    ttlMs: INDEX_TTL_MS,
    keepHotMs: INDEX_KEEP_HOT_MS,
    countCap: INDEX_COUNT_CAP,
    maxBytes: INDEX_MAX_BYTES,
  });
  assert.deepEqual(keysLeft(base), ["recent"]);
});

test("kept buckets are user-private; daemon dir and checkout trees are left alone", () => {
  const parent = dataBase();
  const base = join(parent, "data");
  const checkout = join(parent, "repo");
  mkdirSync(join(checkout, ".codegraph"), { recursive: true });
  writeFileSync(join(checkout, ".codegraph", "planted.txt"), "stay\n");
  mkdirSync(join(base, "daemon"), { recursive: true });
  writeFileSync(join(base, "daemon", "registry.json"), "{}\n");
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const kept = writeBucket(base, "keep", { lastAccess: now - 100 });
  writeBucket(base, "drop", { lastAccess: now - 10_000 });
  mkdirSync(rootsDir(base), { recursive: true });
  symlinkSync(checkout, join(rootsDir(base), "not-a-bucket"));
  pruneRootIndexes({
    base,
    now,
    ttlMs: 1_000,
    keepHotMs: 0,
    countCap: 100,
    maxBytes: INDEX_MAX_BYTES,
  });
  assert.equal(existsSync(join(base, "roots", "drop")), false);
  assert.equal(existsSync(kept), true);
  assert.equal(modeOf(kept), PRIVATE_DIR_MODE);
  assert.equal(modeOf(join(kept, "root.json")), PRIVATE_FILE_MODE);
  assert.equal(existsSync(join(base, "daemon", "registry.json")), true);
  assert.equal(readFileSync(join(checkout, ".codegraph", "planted.txt"), "utf8"), "stay\n");
  assert.equal(existsSync(join(rootsDir(base), "not-a-bucket")), true);
  assert.equal(unsafeRootReason("/"), "the filesystem root");
  assert.equal(unsafeRootReason(homedir()), "your home directory");
});

test("env knobs feed the daemon policy without changing defaults", () => {
  assert.deepEqual(indexGcOptionsFromEnv({}), {
    ttlMs: INDEX_TTL_MS,
    countCap: INDEX_COUNT_CAP,
    maxBytes: INDEX_MAX_BYTES,
    keepHotMs: INDEX_KEEP_HOT_MS,
  });
  assert.deepEqual(
    indexGcOptionsFromEnv({
      CODEQ_INDEX_TTL_MS: "1000",
      CODEQ_INDEX_COUNT_CAP: "3",
      CODEQ_INDEX_MAX_BYTES: "4096",
      CODEQ_INDEX_KEEP_HOT_MS: "50",
    }),
    { ttlMs: 1000, countCap: 3, maxBytes: 4096, keepHotMs: 50 },
  );
  assert.match(MCP_INSTRUCTIONS, /Unused on-disk indexes are pruned later/);
});

test(
  "daemon startup prune drops a stale disk index and keeps the live root",
  { timeout: 180_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-index-gc-live-"));
    const dataDir = join(parent, "data");
    const repo = gitRepo(parent, "app");
    const planted = join(repo, ".codegraph", "planted.txt");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    t.after(() => stopDaemon(dataDir));

    const stale = writeBucket(dataDir, "stale-old", {
      root: "/tmp/gone-checkout",
      lastAccess: Date.parse("2020-01-01T00:00:00.000Z"),
      bytes: 2_048,
    });
    mkdirSync(join(dataDir, "daemon"), { recursive: true });

    await execFileAsync(process.execPath, [bin, "--json", "find", "session.ts"], {
      cwd: repo,
      env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });

    assert.equal(existsSync(stale), false);
    const live = rootBucket(dataDir, repo);
    assert.equal(existsSync(live.bucket), true);
    assert.equal(existsSync(live.metadata), true);
    const meta = JSON.parse(readFileSync(live.metadata, "utf8"));
    assert.equal(meta.root, repo);
    assert.ok(Date.parse(meta.lastAccessedAt) > Date.parse("2020-01-01T00:00:00.000Z"));
    assert.equal(modeOf(live.bucket), PRIVATE_DIR_MODE);
    assert.equal(modeOf(live.metadata), PRIVATE_FILE_MODE);
    assert.equal(readFileSync(planted, "utf8"), "do-not-touch\n");
    assert.equal(existsSync(join(dataDir, "daemon", "registry.json")), true);
  },
);

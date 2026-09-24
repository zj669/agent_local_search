import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  INDEX_COUNT_CAP,
  INDEX_KEEP_HOT_MS,
  INDEX_MAX_BYTES,
  INDEX_TTL_MS,
} from "./limits.js";
import { breakStaleLock } from "./lock.js";
import {
  dataHome,
  ensurePrivateDir,
  ensurePrivateFile,
  rootsDir,
} from "./paths.js";

function envNumber(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

export function indexGcOptionsFromEnv(env = process.env) {
  return {
    ttlMs: envNumber(env.CODEQ_INDEX_TTL_MS, INDEX_TTL_MS),
    countCap: envNumber(env.CODEQ_INDEX_COUNT_CAP, INDEX_COUNT_CAP),
    maxBytes: envNumber(env.CODEQ_INDEX_MAX_BYTES, INDEX_MAX_BYTES),
    keepHotMs: envNumber(env.CODEQ_INDEX_KEEP_HOT_MS, INDEX_KEEP_HOT_MS),
  };
}

function contained(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function directoryBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) total += directoryBytes(path);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}

function readMetadata(bucket) {
  try {
    const value = JSON.parse(
      readFileSync(join(bucket, "root.json"), { encoding: "utf8" }),
    );
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function lastAccessMs(bucket, meta) {
  if (typeof meta?.lastAccessedAt === "string") {
    const stamp = Date.parse(meta.lastAccessedAt);
    if (Number.isFinite(stamp)) return stamp;
  }
  try {
    return statSync(bucket).mtimeMs;
  } catch {
    return 0;
  }
}

function bucketLocked(lockPath) {
  breakStaleLock(lockPath);
  return existsSync(lockPath);
}

export function listRootIndexes(base = dataHome()) {
  const root = rootsDir(base);
  if (!existsSync(root)) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const listed = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const bucket = join(root, entry.name);
    if (!contained(root, bucket)) continue;
    const meta = readMetadata(bucket);
    listed.push({
      key: entry.name,
      bucket,
      root: typeof meta?.root === "string" ? meta.root : null,
      lastAccess: lastAccessMs(bucket, meta),
      bytes: directoryBytes(bucket),
      locked: bucketLocked(join(bucket, "codegraph.lock")),
    });
  }
  return listed;
}

function isProtected(entry, { now, keepHotMs, inUseKeys, inUseRoots }) {
  if (entry.locked) return true;
  if (inUseKeys.has(entry.key)) return true;
  if (entry.root && inUseRoots.has(entry.root)) return true;
  return now - entry.lastAccess < keepHotMs;
}

function removeBucket(rootsRoot, bucket) {
  if (!contained(rootsRoot, bucket)) return false;
  try {
    rmSync(bucket, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// Reclaim unused CodeGraph buckets. FFF never lands here. Does not delete a
// bucket that is loaded, locked, or last queried inside keepHotMs — including
// after a daemon restart, which reads lastAccessedAt from root.json.
export function pruneRootIndexes({
  base = dataHome(),
  now = Date.now(),
  inUseKeys = [],
  inUseRoots = [],
  ttlMs = INDEX_TTL_MS,
  countCap = INDEX_COUNT_CAP,
  maxBytes = INDEX_MAX_BYTES,
  keepHotMs = INDEX_KEEP_HOT_MS,
} = {}) {
  const data = resolve(base);
  const rootsRoot = rootsDir(data);
  ensurePrivateDir(data);
  const deleted = [];
  const kept = [];
  if (!existsSync(rootsRoot)) {
    return { deleted, kept, bytes: 0 };
  }
  ensurePrivateDir(rootsRoot);

  const inUseKeySet = new Set(inUseKeys);
  const inUseRootSet = new Set(inUseRoots);
  const entries = listRootIndexes(data);
  const protectOpts = {
    now,
    keepHotMs,
    inUseKeys: inUseKeySet,
    inUseRoots: inUseRootSet,
  };

  let remaining = entries.length;
  let remainingBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const reclaimable = entries
    .filter((entry) => !isProtected(entry, protectOpts))
    .sort((a, b) => a.lastAccess - b.lastAccess || a.key.localeCompare(b.key));
  const removed = new Set();

  for (const entry of reclaimable) {
    const expired = now - entry.lastAccess >= ttlMs;
    const overCount = remaining > countCap;
    const overSize = remainingBytes > maxBytes;
    if (!expired && !overCount && !overSize) continue;
    if (!removeBucket(rootsRoot, entry.bucket)) continue;
    removed.add(entry.key);
    remaining -= 1;
    remainingBytes -= entry.bytes;
    deleted.push(entry.key);
  }

  for (const entry of entries) {
    if (removed.has(entry.key)) continue;
    ensurePrivateDir(entry.bucket);
    ensurePrivateFile(join(entry.bucket, "root.json"));
    kept.push(entry.key);
  }

  return { deleted, kept, bytes: Math.max(0, remainingBytes) };
}

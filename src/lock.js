import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

// One daemon per data directory, one CodeGraph migration per database: those two
// critical sections cross process boundaries, so a per-process guard cannot hold
// them. Everything after startup stays unlocked — concurrent queries from
// several clients are meant to run side by side.

const STALE_MS = 60_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function holderIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readHolder(path) {
  try {
    const holder = JSON.parse(readFileSync(path, "utf8"));
    return typeof holder?.pid === "number" ? holder : null;
  } catch {
    return null;
  }
}

export function tryAcquireLock(path, label = "") {
  mkdirSync(dirname(path), { recursive: true });
  let fd;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if (error.code === "EEXIST") return null;
    throw error;
  }
  try {
    writeSync(
      fd,
      `${JSON.stringify({ pid: process.pid, label, at: new Date().toISOString() })}\n`,
    );
  } finally {
    closeSync(fd);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      rmSync(path, { force: true });
    } catch {}
  };
}

// A lock whose holder is gone is not a lock. A lock file we cannot read yet was
// created moments ago by a racing process, so it only counts as stale once it is
// older than a whole startup budget.
export function breakStaleLock(path, staleMs = STALE_MS) {
  let age;
  try {
    age = Date.now() - statSync(path).mtimeMs;
  } catch {
    return false;
  }
  const holder = readHolder(path);
  if (holder) {
    if (holderIsAlive(holder.pid)) return false;
  } else if (age < staleMs) {
    return false;
  }
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(
  path,
  { timeoutMs = 30_000, pollMs = 25, staleMs = STALE_MS, label = "", shortCircuit } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = tryAcquireLock(path, label);
    if (release) return { release, shortCircuited: null };
    const early = shortCircuit ? await shortCircuit() : null;
    if (early) return { release: null, shortCircuited: early };
    if (Date.now() >= deadline) break;
    breakStaleLock(path, staleMs);
    await sleep(pollMs);
  }
  breakStaleLock(path, 0);
  const release = tryAcquireLock(path, label);
  if (release) return { release, shortCircuited: null };
  throw new Error(`timed out waiting for ${path}`);
}

export async function withFileLock(path, run, options = {}) {
  const held = await acquireLock(path, options);
  if (!held.release) return held.shortCircuited;
  try {
    return await run();
  } finally {
    held.release();
  }
}

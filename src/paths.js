import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function dataHome() {
  if (process.env.CODEQ_DATA_DIR) return resolve(process.env.CODEQ_DATA_DIR);
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "codeq");
  }
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "codeq");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "codeq");
}

export function daemonPaths(base = dataHome()) {
  const daemonDir = join(base, "daemon");
  const socket =
    platform() === "win32"
      ? `\\\\.\\pipe\\codeq-${createHash("sha256").update(base).digest("hex").slice(0, 16)}`
      : join(daemonDir, "codeq.sock");
  return {
    base,
    daemonDir,
    socket,
    pid: join(daemonDir, "daemon.pid"),
    registry: join(daemonDir, "registry.json"),
    log: join(daemonDir, "logs", "daemon.log"),
  };
}

export function rootBucket(base, canonicalRoot) {
  const key = createHash("sha256").update(canonicalRoot).digest("hex");
  const bucket = join(base, "roots", key);
  return {
    key,
    bucket,
    graphDir: join(bucket, "codegraph"),
    metadata: join(bucket, "root.json"),
  };
}

function expandPath(value, cwd) {
  if (value === "~") return homedir();
  if (value.startsWith(`~${sep}`) || value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

function existingDirectory(input) {
  let current = resolve(input);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!existsSync(current)) return parse(current).root;
  try {
    if (!statSync(current).isDirectory()) return dirname(current);
  } catch {
    return dirname(current);
  }
  return current;
}

function canonical(input) {
  try {
    return realpathSync(input);
  } catch {
    return resolve(input);
  }
}

function contains(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function gitRoot(input) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", existingDirectory(input), "rev-parse", "--show-toplevel"],
      { encoding: "utf8", timeout: 5_000 },
    );
    return canonical(stdout.trim());
  } catch {
    return null;
  }
}

export function unsafeRootReason(root) {
  const value = canonical(root);
  if (value === canonical(parse(value).root)) return "the filesystem root";
  if (value === canonical(homedir())) return "your home directory";
  return null;
}

export function isUnusableWorkspace(dir) {
  if (dir == null) return true;
  const value = String(dir).trim();
  if (value === "" || value.includes("${")) return true;
  return Boolean(unsafeRootReason(value));
}

export async function resolveRequestRoot(request) {
  const cwd = canonical(request.cwd || process.cwd());
  const targetAbsolute = request.path ? expandPath(request.path, cwd) : cwd;
  const targetExisting = canonical(existingDirectory(targetAbsolute));
  let root;

  if (request.root) {
    const explicit = expandPath(request.root, cwd);
    if (!existsSync(explicit) || !statSync(explicit).isDirectory()) {
      throw new Error(`--root must name an existing directory: ${explicit}`);
    }
    root = canonical(explicit);
  } else {
    root = await gitRoot(targetExisting);
    if (!root) {
      const cwdGit = await gitRoot(cwd);
      const cwdRoot = cwdGit || cwd;
      root = contains(cwdRoot, targetExisting) ? cwdRoot : targetExisting;
    }
  }

  const unsafe = unsafeRootReason(root);
  if (unsafe) {
    throw new Error(`refusing to index ${root}: it is ${unsafe}`);
  }

  let constraint = null;
  if (request.path) {
    const rel = relative(root, targetAbsolute);
    if (rel && (rel.startsWith("..") || isAbsolute(rel))) {
      throw new Error(`--path resolves outside selected root ${root}: ${targetAbsolute}`);
    }
    if (rel && rel !== ".") {
      constraint = rel.split(sep).join("/");
      if (existsSync(targetAbsolute) && statSync(targetAbsolute).isDirectory()) {
        constraint += "/";
      }
    }
  }

  return { root, constraint, target: targetAbsolute };
}

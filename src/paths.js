import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

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

export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {}
  return dir;
}

export function ensurePrivateFile(path) {
  try {
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch {}
  return path;
}

export function rootsDir(base = dataHome()) {
  return join(base, "roots");
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
    packageVersion: join(daemonDir, "package-version"),
    log: join(daemonDir, "logs", "daemon.log"),
    startLock: join(daemonDir, "autostart.lock"),
    bindLock: join(daemonDir, "bind.lock"),
  };
}

export function rootBucket(base, canonicalRoot) {
  const key = createHash("sha256").update(canonicalRoot).digest("hex");
  const bucket = join(rootsDir(base), key);
  return {
    key,
    bucket,
    graphDir: join(bucket, "codegraph"),
    metadata: join(bucket, "root.json"),
    graphLock: join(bucket, "codegraph.lock"),
  };
}

function expandPath(value, cwd) {
  if (value === "~") return homedir();
  if (value.startsWith(`~${sep}`) || value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

function looksRelative(value) {
  const text = String(value);
  if (
    text === "~" ||
    text.startsWith("~/") ||
    text.startsWith("~\\") ||
    text.startsWith(`~${sep}`)
  ) {
    return false;
  }
  return !isAbsolute(text);
}

// When root is set, a relative path always joins that root. Hosts and older
// daemons sometimes expand the same relative path against the session cwd or
// another checkout first; recover the relative suffix and join it onto root.
async function resolveScopedPath(pathValue, pathBase, cwd, { rejoinOutside = false } = {}) {
  if (looksRelative(pathValue)) {
    return expandPath(pathValue, pathBase);
  }
  const absolute = expandPath(pathValue, cwd);
  if (!rejoinOutside) return absolute;
  const base = canonical(pathBase);
  const resolved = canonical(absolute);
  if (contains(base, resolved)) return absolute;
  const origin = contains(cwd, resolved)
    ? cwd
    : (await gitRoot(resolved)) || (await gitRoot(existingDirectory(absolute)));
  if (!origin) return absolute;
  const rel = relative(canonical(origin), resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) return absolute;
  return rel === "" ? pathBase : resolve(pathBase, rel);
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

function relativePath(from, to) {
  return relative(from, to).split(sep).join("/");
}

async function enclosingWorktree(root) {
  if (existsSync(join(root, ".git"))) return null;
  const worktree = await gitRoot(root);
  if (!worktree || worktree === root) return null;
  return worktree;
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
  let root;
  let source;
  let note = null;
  let rootConstraint = null;
  // Relative path joins the selected root, not the session cwd: the caller who
  // passes root /other/repo with path src/agent means that repository's src/agent.
  let pathBase = cwd;

  if (request.root) {
    const explicit = expandPath(request.root, cwd);
    if (!existsSync(explicit)) {
      throw new Error(
        `root does not exist: ${explicit}. Pass root as the absolute path of a repository or worktree checkout, and narrow inside it with path.`,
      );
    }
    source = "root";
    if (statSync(explicit).isDirectory()) {
      const directory = canonical(explicit);
      pathBase = directory;
      // An index belongs to a repository, so a subdirectory narrows the
      // repository that holds it instead of opening a second index.
      const worktree = await enclosingWorktree(directory);
      if (worktree) {
        root = worktree;
        const inside = relativePath(worktree, directory);
        rootConstraint = `${inside}/`;
        note = `root named a subdirectory, so it resolved to this repository narrowed to ${inside}/ instead of a second index; pass a subdirectory as path, not root`;
      } else {
        root = directory;
      }
    } else if (request.path) {
      throw new Error(
        `root names a file and path was also passed: ${explicit}. Pass root as the repository checkout and put the file in path.`,
      );
    } else {
      const file = canonical(explicit);
      root = (await gitRoot(dirname(file))) || dirname(file);
      pathBase = root;
      rootConstraint = relativePath(root, file);
      note = `root named a file, so it resolved to this repository narrowed to ${rootConstraint}; pass a file as path, not root`;
    }
  }

  const targetAbsolute = request.path
    ? await resolveScopedPath(request.path, pathBase, cwd, {
        rejoinOutside: Boolean(request.root),
      })
    : pathBase;
  if (request.path && !existsSync(targetAbsolute)) {
    throw new Error(
      `path not found: ${request.path} resolved to ${targetAbsolute}, which does not exist. ` +
        `path is a directory or a single file inside ${
          request.root ? `root ${pathBase}` : `the selected repository`
        }, joined to it when relative — not a fuzzy fragment and not a glob.`,
    );
  }

  if (!request.root) {
    const targetExisting = canonical(existingDirectory(targetAbsolute));
    source = request.path ? "path" : "cwd";
    root = await gitRoot(targetExisting);
    if (!root) {
      const cwdGit = await gitRoot(cwd);
      const cwdRoot = cwdGit || cwd;
      if (contains(cwdRoot, targetExisting)) {
        root = cwdRoot;
        source = "cwd";
      } else {
        root = targetExisting;
      }
    }
  }

  const unsafe = unsafeRootReason(root);
  if (unsafe) {
    throw new Error(`refusing to index ${root}: it is ${unsafe}`);
  }

  let constraint = rootConstraint;
  if (request.path) {
    const rel = relative(root, targetAbsolute);
    if (rel && (rel.startsWith("..") || isAbsolute(rel))) {
      throw new Error(
        `path resolves outside the selected root ${root}: ${targetAbsolute}. Pass root as the repository that holds it, or a path inside this root.`,
      );
    }
    if (rel && rel !== ".") {
      constraint = rel.split(sep).join("/");
      if (statSync(targetAbsolute).isDirectory()) {
        constraint += "/";
      }
    }
  }

  return { root, constraint, target: targetAbsolute, source, note };
}

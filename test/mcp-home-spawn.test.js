import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createFramedParser, encodeMessage } from "../src/mcp.js";
import { parseMcpToolText } from "../src/mcp-format.js";

const bin = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));
const wrapper = fileURLToPath(new URL("../bin/codeq-mcp", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeTs(dir, relative, body) {
  const path = join(dir, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

function isolatedEnv(dataDir, extra = {}) {
  const env = { ...process.env, CODEQ_DATA_DIR: dataDir, ...extra };
  delete env.CODEQ_CWD;
  return env;
}

function indexedRoots(dataDir) {
  const rootsDir = join(dataDir, "roots");
  if (!existsSync(rootsDir)) return [];
  return readdirSync(rootsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const meta = join(rootsDir, entry.name, "root.json");
      if (!existsSync(meta)) return null;
      return JSON.parse(readFileSync(meta, "utf8")).root;
    })
    .filter(Boolean);
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

function initRepo(root, files) {
  mkdirSync(root, { recursive: true });
  for (const [relative, body] of Object.entries(files)) {
    writeTs(root, relative, body);
  }
  git(root, "init", "-b", "main");
  git(root, "add", "-A");
  git(
    root,
    "-c",
    "user.name=codeq-test",
    "-c",
    "user.email=codeq@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  return realpathSync(root);
}

class McpSession {
  constructor(child) {
    this.child = child;
    this.messages = [];
    this.stderr = "";
    this.nextId = 1;
    const parse = createFramedParser((message) => this.messages.push(message));
    child.stdout.on("data", (chunk) => parse(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
  }

  send(message) {
    this.child.stdin.write(encodeMessage(message));
  }

  async waitFor(predicate, timeout) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const match = this.messages.find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `timed out waiting for MCP message: ${JSON.stringify(this.messages)}\nstderr: ${this.stderr}`,
    );
  }

  async initialize() {
    const id = this.nextId++;
    this.send({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "codeq-home", version: "0" },
      },
    });
    return this.waitFor((message) => message.id === id, 5_000);
  }

  async listTools() {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method: "tools/list" });
    const listed = await this.waitFor((message) => message.id === id, 5_000);
    return listed.result.tools.map((tool) => tool.name);
  }

  async call(name, args, timeout = 60_000) {
    const id = this.nextId++;
    this.send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const message = await this.waitFor((message) => message.id === id, timeout);
    const text = message.result?.content?.[0]?.text || "";
    return {
      isError: Boolean(message.result?.isError),
      text,
      payload: message.result?.isError ? null : parseMcpToolText(text),
    };
  }

  close() {
    try {
      this.child.stdin.end();
    } catch {}
    try {
      this.child.kill("SIGTERM");
    } catch {}
  }
}

test(
  "HOME spawn does not index until tools/call with path; path B indexes B only",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-mcp-home-"));
    const dataDir = join(parent, "data");
    const env = isolatedEnv(dataDir);
    const repoB = initRepo(join(parent, "repo-b"), {
      "src/BetaUniqueModule.ts":
        'export const BETA_REPO_ONLY_TOKEN = "beta-only";\n',
    });

    let session;
    t.after(() => {
      session?.close();
      stopDaemon(dataDir);
    });

    session = new McpSession(
      spawn(process.execPath, [bin, "mcp"], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: homedir(),
        env,
      }),
    );

    const init = await session.initialize();
    assert.equal(init.result.serverInfo.name, "codeq");
    const names = await session.listTools();
    assert.deepEqual(names, ["find", "grep", "graph"]);
    assert.deepEqual(indexedRoots(dataDir), []);

    const missing = await session.call("find", { query: "BetaUniqueModule" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /no workspace \(spawned from home\)/);
    assert.match(missing.text, /Pass path or root/);
    assert.equal(missing.text.includes("refusing to index"), false);
    assert.deepEqual(indexedRoots(dataDir), []);
    assert.equal(
      indexedRoots(dataDir).some((root) => root === realpathSync(homedir())),
      false,
    );

    const found = await session.call("find", {
      query: "BetaUniqueModule",
      path: repoB,
    });
    assert.equal(found.isError, false, found.text);
    assert.equal(found.payload.root, repoB);
    assert.ok(
      found.payload.paths.some((path) => path.endsWith("BetaUniqueModule.ts")),
    );
    const roots = indexedRoots(dataDir);
    assert.deepEqual(roots, [repoB]);
    assert.equal(roots.includes(realpathSync(homedir())), false);
  },
);

test(
  "codeq-mcp wrapper from HOME + path indexes B only",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-wrapper-home-"));
    const dataDir = join(parent, "data");
    const env = isolatedEnv(dataDir, { CODEQ_NODE: process.execPath });
    const repoB = initRepo(join(parent, "repo-b"), {
      "src/BetaUniqueModule.ts":
        'export const BETA_REPO_ONLY_TOKEN = "beta-only";\n',
    });

    let session;
    t.after(() => {
      session?.close();
      stopDaemon(dataDir);
    });

    session = new McpSession(
      spawn("bash", [wrapper, "${workspaceFolder}"], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: homedir(),
        env,
      }),
    );

    await session.initialize();
    assert.deepEqual(indexedRoots(dataDir), []);
    const found = await session.call("find", {
      query: "BetaUniqueModule",
      path: repoB,
    });
    assert.equal(found.isError, false, found.text);
    assert.equal(found.payload.root, repoB);
    assert.deepEqual(indexedRoots(dataDir), [repoB]);
  },
);

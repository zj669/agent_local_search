import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createFramedParser, encodeMessage } from "../src/mcp.js";

const bin = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitAll(cwd, message) {
  git(cwd, "add", "-A");
  git(
    cwd,
    "-c",
    "user.name=codeq-test",
    "-c",
    "user.email=codeq@example.invalid",
    "commit",
    "-m",
    message,
  );
}

function writeTs(dir, relative, body) {
  const path = join(dir, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

function isolatedEnv(dataDir) {
  const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
  delete env.CODEQ_CWD;
  return env;
}

function noDotCodegraph(...roots) {
  for (const root of roots) {
    assert.equal(existsSync(join(root, ".codegraph")), false, root);
  }
}

function cli(args, { cwd, env, timeout = 60_000 }) {
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    return {
      ok: false,
      status: error.status,
      stdout: error.stdout?.toString() || "",
      stderr: error.stderr?.toString() || "",
    };
  }
}

function cliJson(args, options) {
  const result = cli(["--json", ...args], options);
  assert.equal(result.ok, true, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function cliStatusLine(args, { cwd, env, timeout = 60_000 }) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  const line = result.stderr
    .split("\n")
    .find((candidate) => candidate.startsWith("["));
  assert.ok(line, result.stderr);
  return line;
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

  async initialize({ roots = false } = {}) {
    const id = this.nextId++;
    this.send({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: roots ? { roots: { listChanged: true } } : {},
        clientInfo: { name: "codeq-parity", version: "0" },
      },
    });
    return this.waitFor((message) => message.id === id, 5_000);
  }

  notifyInitialized() {
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async replyRoots(workspace) {
    const request = await this.waitFor(
      (message) => message.method === "roots/list",
      5_000,
    );
    this.send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        roots: [{ uri: pathToFileURL(workspace).href, name: "workspace" }],
      },
    });
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
      message,
      isError: Boolean(message.result?.isError),
      text,
      payload: message.result?.structuredContent ?? null,
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

function spawnMcp({ cwd, env }) {
  const child = spawn(process.execPath, [bin, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env,
  });
  return new McpSession(child);
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
  commitAll(root, "fixture");
  return realpathSync(root);
}

const widget = (name, token, extra) =>
  [
    `export const ${token} = "${token}";`,
    `export function ${name.charAt(0).toLowerCase()}${name.slice(1)}Beacon() {`,
    `  return ${token};`,
    `}`,
    `export class ${name} {`,
    `  render() {`,
    `    return ${extra};`,
    `  }`,
    `}`,
    "",
  ].join("\n");

test(
  "a file or subdirectory passed as root is resolved, scoped, and named in the reply",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-root-shapes-"));
    const dataDir = join(parent, "data");
    const env = isolatedEnv(dataDir);
    const repo = initRepo(join(parent, "repo"), {
      "src/leagent/policy_selector.py": "SHARED_POLICY_TOKEN = 1\n",
      "src/leagent/reply_router.py": "SHARED_POLICY_TOKEN = 2\n",
      "packages/widget/index.ts": 'export const WIDGET_ONLY_TOKEN = "widget";\n',
    });
    const file = join(repo, "src/leagent/policy_selector.py");
    const subdirectory = join(repo, "packages/widget");

    let session;
    t.after(() => {
      session?.close();
      stopDaemon(dataDir);
    });
    session = spawnMcp({ cwd: repo, env });
    await session.initialize();

    const fileRoot = await session.call("grep", {
      pattern: "SHARED_POLICY_TOKEN",
      root: file,
    });
    assert.equal(fileRoot.isError, false, fileRoot.text);
    assert.equal(fileRoot.text.includes("--root"), false, fileRoot.text);
    assert.equal(fileRoot.payload.root, repo);
    assert.equal("rootSource" in fileRoot.payload, false);
    assert.equal("rootNote" in fileRoot.payload, false);
    assert.match(
      fileRoot.text.split("\n")[0],
      new RegExp(`root ${repo} via root argument; scope src/leagent/policy_selector.py \\(file-as-root; use path\\)`),
    );
    assert.deepEqual(
      [...new Set(fileRoot.payload.hits.map((item) => item.path))],
      ["src/leagent/policy_selector.py"],
    );

    const cliFileRoot = cliJson(["--root", file, "grep", "SHARED_POLICY_TOKEN"], {
      cwd: repo,
      env,
    });
    assert.equal(cliFileRoot.root, repo);
    assert.match(cliFileRoot.rootNote, /root named a file/);
    assert.deepEqual(
      [...new Set(cliFileRoot.results.map((item) => item.path))],
      ["src/leagent/policy_selector.py"],
    );
    assert.match(
      cliStatusLine(["--root", file, "grep", "SHARED_POLICY_TOKEN"], {
        cwd: repo,
        env,
      }),
      new RegExp(`^\\[\\w+\\] root ${repo} via root argument; scope src/leagent/policy_selector.py \\(file-as-root; use path\\)`),
    );

    const subdirectoryRoot = await session.call("find", {
      query: "index.ts",
      root: subdirectory,
    });
    assert.equal(subdirectoryRoot.isError, false, subdirectoryRoot.text);
    assert.equal(subdirectoryRoot.payload.root, repo);
    assert.equal("rootNote" in subdirectoryRoot.payload, false);
    assert.match(
      subdirectoryRoot.text.split("\n")[0],
      /scope packages\/widget\/ \(subdir-as-root; use path\)/,
    );
    assert.equal(
      subdirectoryRoot.text.split("\n")[0].includes("root named a subdirectory"),
      false,
    );
    assert.match(
      subdirectoryRoot.text.split("\n")[0],
      new RegExp(`root ${repo} via root argument; scope packages/widget/`),
    );
    assert.deepEqual(subdirectoryRoot.payload.paths, ["packages/widget/index.ts"]);

    const narrowed = await session.call("find", {
      query: "index.ts",
      path: "packages/widget",
    });
    assert.equal(narrowed.payload.root, repo);
    assert.equal("rootNote" in narrowed.payload, false);
    assert.deepEqual(narrowed.payload.paths, ["packages/widget/index.ts"]);

    const checkout = await session.call("find", { query: "index.ts", root: repo });
    assert.equal(checkout.payload.root, repo);
    assert.equal("rootNote" in checkout.payload, false);

    const missing = await session.call("find", {
      query: "index.ts",
      root: join(repo, "packages/typo"),
    });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /root does not exist/);
    assert.match(missing.text, /narrow inside it with path/);

    const missingPath = await session.call("find", {
      query: "index.ts",
      root: repo,
      path: "packages/typo",
    });
    assert.equal(missingPath.isError, true);
    assert.match(missingPath.text, /path not found: packages\/typo/);
    assert.ok(
      missingPath.text.includes(join(repo, "packages/typo")),
      missingPath.text,
    );

    // A file root, a subdirectory root, a path and the checkout itself all named
    // the same repository, so they must share the one index bucket it owns.
    assert.deepEqual(readdirSync(join(dataDir, "roots")).length, 1);

    noDotCodegraph(repo);
  },
);

test(
  "MCP stdio matches CLI: tools/list, worktree, cross-repo, multi-root, HOME spawn",
  { timeout: 240_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-mcp-parity-"));
    const dataDir = join(parent, "data");
    const env = isolatedEnv(dataDir);

    const repoA = initRepo(join(parent, "repo-a"), {
      "src/AlphaMainWidget.ts": widget(
        "AlphaMainWidget",
        "ALPHA_MAIN_CHECKOUT_TOKEN",
        '"SHARED_ON_MAIN_CONTENT"',
      ),
      "src/shared.ts": 'export const SHARED = "SHARED_ON_MAIN_CONTENT";\n',
      "README.md": "ALPHA_MAIN_CHECKOUT_TOKEN main checkout\n",
    });
    const worktree = join(parent, "repo-a-wt");
    git(repoA, "worktree", "add", "-b", "feature/worktree", worktree, "main");
    rmSync(join(worktree, "src/AlphaMainWidget.ts"));
    writeTs(
      worktree,
      "src/AlphaWorktreeWidget.ts",
      widget(
        "AlphaWorktreeWidget",
        "ALPHA_WORKTREE_ONLY_TOKEN",
        '"SHARED_ON_WORKTREE_CONTENT"',
      ),
    );
    writeTs(
      worktree,
      "src/shared.ts",
      'export const SHARED = "SHARED_ON_WORKTREE_CONTENT";\n',
    );
    writeFileSync(
      join(worktree, "README.md"),
      "ALPHA_WORKTREE_ONLY_TOKEN worktree checkout\n",
    );
    commitAll(worktree, "worktree files");
    const repoWt = realpathSync(worktree);

    const repoB = initRepo(join(parent, "repo-b"), {
      "src/BetaUniqueModule.ts": widget(
        "BetaUniqueModule",
        "BETA_REPO_ONLY_TOKEN",
        '"beta-only"',
      ),
      "README.md": "BETA_REPO_ONLY_TOKEN\n",
    });
    const repoC = initRepo(join(parent, "repo-c"), {
      "src/CharlieUniqueModule.ts": widget(
        "CharlieUniqueModule",
        "CHARLIE_REPO_ONLY_TOKEN",
        '"charlie-only"',
      ),
      "README.md": "CHARLIE_REPO_ONLY_TOKEN\n",
    });

    let session;
    let homeSession;
    let slashSession;
    let rootsFromHome;
    t.after(() => {
      session?.close();
      homeSession?.close();
      slashSession?.close();
      rootsFromHome?.close();
      stopDaemon(dataDir);
    });

    session = spawnMcp({ cwd: repoWt, env });
    const init = await session.initialize();
    assert.equal(init.result.serverInfo.name, "codeq");
    session.notifyInitialized();

    const names = await session.listTools();
    assert.deepEqual(names, ["find", "grep", "graph"]);
    for (const banned of [
      "start",
      "stop",
      "status",
      "sync",
      "rescan",
      "callers",
      "callees",
      "health",
    ]) {
      assert.equal(names.includes(banned), false, banned);
    }

    const mcpFindWt = await session.call("find", {
      query: "AlphaWorktreeWidget",
    });
    const cliFindWt = cliJson(["find", "AlphaWorktreeWidget"], {
      cwd: repoWt,
      env,
    });
    assert.equal(mcpFindWt.isError, false, mcpFindWt.text);
    assert.equal(mcpFindWt.payload.root, repoWt);
    assert.equal(cliFindWt.root, repoWt);
    assert.equal(
      mcpFindWt.text.split("\n")[0].includes(`root ${repoWt} via cwd:spawn cwd`),
      true,
      mcpFindWt.text.split("\n")[0],
    );
    assert.equal(mcpFindWt.payload.rootSource, undefined);
    assert.equal(mcpFindWt.payload.cwdSource, undefined);
    assert.equal(cliFindWt.rootSource, "cwd");
    assert.equal(cliFindWt.cwdSource, "shell cwd");
    assert.match(
      cliStatusLine(["find", "AlphaWorktreeWidget"], { cwd: repoWt, env }),
      new RegExp(`^\\[\\w+\\] root ${repoWt} via cwd:shell cwd`),
    );
    assert.ok(
      mcpFindWt.payload.paths.some((path) =>
        path.endsWith("AlphaWorktreeWidget.ts"),
      ),
    );
    assert.equal(
      cliFindWt.results.some((item) =>
        item.path.endsWith("AlphaWorktreeWidget.ts"),
      ),
      true,
    );

    const mcpFindMain = await session.call("find", { query: "AlphaMainWidget" });
    const cliFindMain = cliJson(["find", "AlphaMainWidget"], {
      cwd: repoWt,
      env,
    });
    assert.equal(mcpFindMain.payload.paths.length, 0);
    assert.equal(cliFindMain.total, 0);

    const mcpGrepWt = await session.call("grep", {
      pattern: "ALPHA_WORKTREE_ONLY_TOKEN",
    });
    const cliGrepWt = cliJson(["grep", "ALPHA_WORKTREE_ONLY_TOKEN"], {
      cwd: repoWt,
      env,
    });
    assert.equal(mcpGrepWt.payload.root, repoWt);
    assert.equal(cliGrepWt.root, repoWt);
    assert.ok(mcpGrepWt.payload.hits.length > 0);
    assert.equal(mcpGrepWt.payload.hits.length, cliGrepWt.shown);
    assert.equal(cliGrepWt.nextCursor, null);

    const mcpGrepMain = await session.call("grep", {
      pattern: "ALPHA_MAIN_CHECKOUT_TOKEN",
    });
    const cliGrepMain = cliJson(["grep", "ALPHA_MAIN_CHECKOUT_TOKEN"], {
      cwd: repoWt,
      env,
    });
    assert.equal(mcpGrepMain.payload.hits.length, 0);
    assert.equal(cliGrepMain.shown, 0);
    assert.equal(cliGrepMain.mode, "plain");

    const mcpGraphWt = await session.call(
      "graph",
      { query: "alphaWorktreeBeacon AlphaWorktreeWidget" },
      180_000,
    );
    const cliGraphWt = cliJson(
      ["graph", "alphaWorktreeBeacon AlphaWorktreeWidget"],
      { cwd: repoWt, env, timeout: 180_000 },
    );
    assert.equal(mcpGraphWt.isError, false, mcpGraphWt.text);
    assert.equal(mcpGraphWt.payload.root, repoWt);
    assert.equal(cliGraphWt.root, repoWt);
    assert.equal(
      mcpGraphWt.text.split("\n")[0].includes(`root ${repoWt} via cwd:spawn cwd`),
      true,
      mcpGraphWt.text.split("\n")[0],
    );
    const graphText = mcpGraphWt.text;
    assert.match(graphText, /AlphaWorktreeWidget/);
    assert.doesNotMatch(graphText, /AlphaMainWidget/);
    assert.equal(graphText.includes("```"), false);
    assert.equal(/verbatim/i.test(graphText), false);
    assert.equal(graphText.includes("codegraph_explore"), false);
    assert.match(graphText, /exact AlphaWorktreeWidget|AlphaWorktreeWidget/);
    assert.equal(graphText.includes("open these files"), false);
    assert.equal("sourceIncluded" in mcpGraphWt.payload, false);
    assert.equal("files" in mcpGraphWt.payload, false);
    assert.ok(
      mcpGraphWt.payload.entries.some((entry) =>
        entry.path.endsWith("AlphaWorktreeWidget.ts"),
      ),
    );
    // --json is the machine anchor and stays the whole daemon result.
    // Fast path leaves the explore dump empty; symbols still name the entry.
    assert.equal("result" in cliGraphWt, true);
    assert.equal(Array.isArray(cliGraphWt.symbols), true);
    assert.ok(
      (cliGraphWt.symbols || []).some((span) =>
        String(span.name).includes("AlphaWorktreeWidget"),
      ) || String(cliGraphWt.result).includes("AlphaWorktreeWidget"),
      "json dump must still name the worktree widget",
    );

    // Human CLI prints the same locator map as MCP, not the engine dump.
    const cliGraphHuman = cli(
      ["graph", "alphaWorktreeBeacon AlphaWorktreeWidget"],
      { cwd: repoWt, env, timeout: 180_000 },
    );
    assert.equal(cliGraphHuman.ok, true, cliGraphHuman.stderr);
    assert.equal(cliGraphHuman.stdout.includes("```"), false);
    assert.equal(/verbatim/i.test(cliGraphHuman.stdout), false);
    assert.equal(cliGraphHuman.stdout.includes("open these files"), false);
    assert.match(cliGraphHuman.stdout, /AlphaWorktreeWidget/);
    assert.equal(
      cliGraphHuman.stdout.trimEnd(),
      mcpGraphWt.text.split("\n").slice(1).join("\n"),
    );

    const cliGraphFull = cli(
      ["--full", "graph", "alphaWorktreeBeacon AlphaWorktreeWidget"],
      { cwd: repoWt, env, timeout: 180_000 },
    );
    assert.equal(cliGraphFull.ok, false);
    assert.match(cliGraphFull.stderr, /no --full or --detail/);

    const mcpFindB = await session.call("find", {
      query: "BetaUniqueModule",
      path: repoB,
    });
    const cliFindB = cliJson(["find", "BetaUniqueModule", "--path", repoB], {
      cwd: repoWt,
      env,
    });
    assert.equal(mcpFindB.payload.root, repoB);
    assert.equal(cliFindB.root, repoB);
    assert.equal(
      mcpFindB.text.split("\n")[0].includes(`root ${repoB} via path argument`),
      true,
      mcpFindB.text.split("\n")[0],
    );
    assert.equal(mcpFindB.payload.rootSource, undefined);
    assert.equal(cliFindB.rootSource, "path");
    assert.deepEqual(
      mcpFindB.payload.paths.filter((path) => path.endsWith("UniqueModule.ts")),
      ["src/BetaUniqueModule.ts"],
    );
    assert.equal(
      mcpFindB.payload.paths.some((path) => path.includes("Charlie")),
      false,
    );

    const mcpGrepB = await session.call("grep", {
      pattern: "BETA_REPO_ONLY_TOKEN",
      path: repoB,
    });
    assert.equal(mcpGrepB.payload.root, repoB);
    assert.ok(mcpGrepB.payload.hits.length > 0);

    const mcpFindC = await session.call("find", {
      query: "CharlieUniqueModule",
      root: repoC,
    });
    const cliFindC = cliJson(["find", "CharlieUniqueModule", "--root", repoC], {
      cwd: repoWt,
      env,
    });
    assert.equal(mcpFindC.payload.root, repoC);
    assert.equal(cliFindC.root, repoC);
    assert.equal(
      mcpFindC.text.split("\n")[0].includes(`root ${repoC} via root argument`),
      true,
      mcpFindC.text.split("\n")[0],
    );
    assert.equal(mcpFindC.payload.rootSource, undefined);
    assert.equal(cliFindC.rootSource, "root");
    assert.match(
      cliStatusLine(["find", "CharlieUniqueModule", "--root", repoC], {
        cwd: repoWt,
        env,
      }),
      new RegExp(`^\\[\\w+\\] root ${repoC} via root argument`),
    );
    assert.ok(
      mcpFindC.payload.paths.some((path) =>
        path.endsWith("CharlieUniqueModule.ts"),
      ),
    );
    assert.equal(
      mcpFindC.payload.paths.some((path) => path.includes("Beta")),
      false,
    );

    const mcpDefault = await session.call("find", {
      query: "AlphaWorktreeWidget",
    });
    const mcpDefaultBeta = await session.call("find", {
      query: "BetaUniqueModule",
    });
    const mcpDefaultCharlie = await session.call("grep", {
      pattern: "CHARLIE_REPO_ONLY_TOKEN",
    });
    assert.equal(mcpDefault.payload.root, repoWt);
    assert.ok(
      mcpDefault.payload.paths.some((path) =>
        path.endsWith("AlphaWorktreeWidget.ts"),
      ),
    );
    assert.equal(mcpDefaultBeta.payload.root, repoWt);
    assert.equal(mcpDefaultBeta.payload.paths.length, 0);
    assert.equal(mcpDefaultCharlie.payload.root, repoWt);
    assert.equal(mcpDefaultCharlie.payload.hits.length, 0);
    for (const reply of [mcpDefault, mcpDefaultBeta, mcpDefaultCharlie]) {
      assert.equal(
        reply.text.split("\n")[0].includes(`root ${repoWt} via cwd:spawn cwd`),
        true,
        reply.text.split("\n")[0],
      );
      assert.equal(reply.payload.rootSource, undefined);
      assert.equal(reply.payload.cwdSource, undefined);
    }

    noDotCodegraph(repoA, repoWt, repoB, repoC);

    homeSession = spawnMcp({ cwd: homedir(), env });
    await homeSession.initialize();
    const homeTools = await homeSession.listTools();
    assert.deepEqual(homeTools, ["find", "grep", "graph"]);
    const homeFind = await homeSession.call("find", { query: "AlphaWorktreeWidget" });
    assert.equal(homeFind.isError, true);
    assert.match(homeFind.text, /no workspace \(spawned from home\)/);
    assert.match(homeFind.text, /Pass path or root/);
    assert.equal(homeFind.text.includes("refusing to index"), false);
    const cliHome = cli(["find", "AlphaWorktreeWidget"], {
      cwd: homedir(),
      env,
    });
    assert.equal(cliHome.ok, false);
    assert.match(cliHome.stderr, /refusing to index/);
    assert.match(cliHome.stderr, /home directory/);

    const homeFindB = await homeSession.call("find", {
      query: "BetaUniqueModule",
      path: repoB,
    });
    assert.equal(homeFindB.isError, false, homeFindB.text);
    assert.equal(homeFindB.payload.root, repoB);
    assert.equal(homeFindB.payload.rootSource, undefined);
    assert.ok(
      homeFindB.payload.paths.some((path) => path.endsWith("BetaUniqueModule.ts")),
    );

    slashSession = spawnMcp({ cwd: "/", env });
    await slashSession.initialize();
    const slashFind = await slashSession.call("find", { query: "AlphaWorktreeWidget" });
    assert.equal(slashFind.isError, true);
    assert.match(slashFind.text, /no workspace \(spawned from home\)/);
    assert.match(slashFind.text, /Pass path or root/);
    assert.equal(slashFind.text.includes("refusing to index"), false);
    const cliSlash = cli(["find", "AlphaWorktreeWidget"], { cwd: "/", env });
    assert.equal(cliSlash.ok, false);
    assert.match(cliSlash.stderr, /filesystem root/);

    rootsFromHome = spawnMcp({ cwd: homedir(), env });
    await rootsFromHome.initialize({ roots: true });
    rootsFromHome.notifyInitialized();
    await rootsFromHome.replyRoots(repoWt);
    const viaRoots = await rootsFromHome.call("find", {
      query: "AlphaWorktreeWidget",
    });
    assert.equal(viaRoots.isError, false, viaRoots.text);
    assert.equal(viaRoots.payload.root, repoWt);
    assert.equal(
      viaRoots.text.split("\n")[0].includes(`root ${repoWt} via cwd:roots/list`),
      true,
      viaRoots.text.split("\n")[0],
    );
    assert.equal(viaRoots.payload.rootSource, undefined);
    assert.equal(viaRoots.payload.cwdSource, undefined);
    assert.ok(
      viaRoots.payload.paths.some((path) =>
        path.endsWith("AlphaWorktreeWidget.ts"),
      ),
    );
  },
);

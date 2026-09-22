import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createFramedParser, encodeMessage } from "../src/mcp.js";

// A replay of the session that produced the 0.2.8 fix list: the window sits in
// one worktree while every question is about another repository, so root, path
// and exactness all have to survive the trip.

const bin = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(root, relative, body) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function commit(root) {
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

function leagent(parent) {
  const root = join(parent, "leagent");
  write(
    root,
    "src/leagent/generator.py",
    [
      '"""Reply generation."""',
      "",
      "from src.leagent.retrieval.bm25 import get_scores",
      "",
      "",
      "class ChatFormatter:",
      "    def __init__(self, session):",
      "        self.session = session",
      "",
      "",
      "def format_chat_details(session, message, *, verbose=False):",
      '    """Render one chat message with its details."""',
      '    details = {"session": session.id, "message": message}',
      "    if verbose:",
      '        details["scores"] = get_scores(message)',
      "    return details",
      "",
      "",
      "def render_reply(session, message):",
      "    return format_chat_details(session, message, verbose=True)",
      "",
    ].join("\n"),
  );
  write(
    root,
    "src/leagent/agent/global_agent.py",
    [
      "from src.leagent.generator import format_chat_details",
      "",
      "",
      "class GlobalAgent:",
      '    """Owns the whole request lifecycle."""',
      "",
      "    def __init__(self, store):",
      "        self.store = store",
      "",
      "    def prepare_planner(self, request):",
      '        return {"planner": request.kind}',
      "",
      "    def run(self, request):",
      "        plan = self.prepare_planner(request)",
      "        return format_chat_details(request.session, plan)",
      "",
      "",
      "def build_global_agent(store):",
      "    return GlobalAgent(store)",
      "",
    ].join("\n"),
  );
  write(
    root,
    "src/leagent/agent/planner.py",
    [
      "from src.leagent.agent.global_agent import GlobalAgent",
      "",
      "",
      "def plan_for(agent: GlobalAgent, request):",
      "    return agent.prepare_planner(request)",
      "",
    ].join("\n"),
  );
  // Short-token neighbours: the engine seeds on format, chat and get, so these
  // files are what used to crowd the top of "open these files".
  write(
    root,
    "src/leagent/openai.py",
    [
      "def format_prompt(messages):",
      '    return "\\n".join(messages)',
      "",
      "",
      'def chat_completion(prompt, model="gpt"):',
      '    return {"prompt": format_prompt([prompt]), "model": model}',
      "",
      "",
      "def get_client():",
      "    return object()",
      "",
    ].join("\n"),
  );
  write(
    root,
    "src/leagent/retrieval/bm25.py",
    [
      "def get_scores(text):",
      "    return [len(token) for token in text.split()]",
      "",
      "",
      "def format_row(row):",
      '    return ", ".join(str(cell) for cell in row)',
      "",
    ].join("\n"),
  );
  write(
    root,
    "src/leagent/chat/field_constraints.py",
    [
      "def get_constraints(field):",
      '    return {"field": field}',
      "",
      "",
      "def format_constraint(constraint):",
      "    return repr(constraint)",
      "",
    ].join("\n"),
  );
  write(
    root,
    "tests/test_generator.py",
    [
      "from src.leagent.generator import format_chat_details",
      "",
      "",
      "def test_format_chat_details():",
      '    assert format_chat_details(None, "hi") is not None',
      "",
    ].join("\n"),
  );
  return commit(root);
}

function nantianmen(parent) {
  const root = join(parent, "leagent-nantianmen");
  write(
    root,
    "src/nantianmen/settings.py",
    [
      "import os",
      "",
      'NANTIANMEN_TEST_DATABASE_URL = os.environ.get("NANTIANMEN_TEST_DATABASE_URL", "")',
      "",
      "",
      "def database_url():",
      "    return NANTIANMEN_TEST_DATABASE_URL",
      "",
    ].join("\n"),
  );
  // The same relative path exists here, so resolving path against the window cwd
  // instead of the selected root would quietly search this repository.
  write(root, "src/leagent/agent/decoy.py", "DECOY = 1\n");
  return commit(root);
}

class Session {
  constructor(child) {
    this.child = child;
    this.messages = [];
    this.nextId = 1;
    const parse = createFramedParser((message) => this.messages.push(message));
    child.stdout.on("data", (chunk) => parse(chunk));
  }

  async waitFor(id, timeout) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const match = this.messages.find((message) => message.id === id);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for MCP reply ${id}`);
  }

  async call(name, args, timeout = 120_000) {
    const id = this.nextId++;
    this.child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    );
    const message = await this.waitFor(id, timeout);
    const text = message.result?.content?.[0]?.text || "";
    return {
      text,
      lines: text.split("\n"),
      isError: Boolean(message.result?.isError),
      payload: message.result?.structuredContent ?? null,
    };
  }
}

test(
  "one window, two repositories: root selects, path narrows, grep stays exact",
  { timeout: 300_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-two-repo-"));
    const dataDir = join(parent, "data");
    const repo = leagent(parent);
    const worktree = nantianmen(parent);

    const child = spawn(process.execPath, [bin, "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: worktree,
      env: { ...process.env, CODEQ_DATA_DIR: dataDir },
    });
    const session = new Session(child);
    t.after(() => {
      child.kill("SIGTERM");
      const pidFile = join(dataDir, "daemon", "daemon.pid");
      if (!existsSync(pidFile)) return;
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    });
    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: session.nextId++,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "codeq-session", version: "0" },
        },
      }),
    );
    await session.waitFor(1, 10_000);

    await t.test("a relative path joins the root, not the window cwd", async () => {
      const scoped = await session.call("graph", {
        root: repo,
        path: "src/leagent/agent",
        query: "how does GlobalAgent work",
      });
      assert.equal(scoped.isError, false, scoped.text);
      assert.match(
        scoped.lines[0],
        new RegExp(`^\\[\\w+\\] root ${repo} via root argument`),
      );
      assert.equal(scoped.payload.root, repo);
      assert.equal("rootSource" in scoped.payload, false);
      assert.ok(scoped.payload.entries.length > 0, scoped.text);
      for (const entry of scoped.payload.entries) {
        assert.ok(
          entry.path.startsWith("src/leagent/agent/"),
          `${entry.path} is outside the requested scope\n${scoped.text}`,
        );
      }
      assert.equal(scoped.text.includes("decoy"), false);
    });

    await t.test("a path that does not exist is an error, not the whole repo", async () => {
      const missing = await session.call("graph", {
        root: repo,
        path: "src/no_such_dir",
        query: "how does GlobalAgent work",
      });
      assert.equal(missing.isError, true, missing.text);
      assert.match(missing.text, /path not found: src\/no_such_dir/);
      assert.ok(missing.text.includes(join(repo, "src", "no_such_dir")), missing.text);
      assert.equal(missing.text.includes("open these files"), false);
    });

    await t.test("every path in one repository shares that repository's index", async () => {
      const wide = await session.call("find", { root: repo, query: "generator.py" });
      const narrow = await session.call("find", {
        root: repo,
        path: "src/leagent/agent",
        query: "planner.py",
      });
      const file = await session.call("find", {
        root: repo,
        path: "src/leagent/generator.py",
        query: "generator.py",
      });
      const subdirectoryAsRoot = await session.call("find", {
        root: join(repo, "src/leagent/agent"),
        query: "planner.py",
      });

      for (const reply of [wide, narrow, file, subdirectoryAsRoot]) {
        assert.equal(reply.isError, false, reply.text);
        assert.equal(reply.payload.root, repo);
      }
      assert.match(
        subdirectoryAsRoot.lines[0],
        new RegExp(`root ${repo} via root argument \\(root named a subdirectory`),
      );
      for (const reply of [narrow, subdirectoryAsRoot]) {
        assert.ok(
          reply.payload.paths.includes("src/leagent/agent/planner.py"),
          reply.text,
        );
        for (const path of reply.payload.paths) {
          assert.ok(path.startsWith("src/leagent/agent/"), reply.text);
        }
      }
      assert.equal(file.payload.paths[0], "src/leagent/generator.py");
    });

    await t.test("grep in the other repository is exact, then labelled fuzzy", async () => {
      const exact = await session.call("grep", {
        root: worktree,
        pattern: "PG_DATABASE_URL",
      });
      assert.equal(exact.payload.root, worktree);
      assert.equal(exact.payload.hits.length, 0);
      assert.equal(exact.lines[0].includes("[fuzzy]"), false);
      assert.equal(exact.text.includes("NANTIANMEN_TEST_DATABASE_URL"), false);
      assert.match(exact.text, /0 matches/);
      assert.match(exact.text, /pass regex: true/);
      assert.match(exact.text, /fuzzy: true/);

      const approximate = await session.call("grep", {
        root: worktree,
        pattern: "PG_DATABASE_URL",
        fuzzy: true,
      });
      assert.match(approximate.lines[0], /^\[\w+\]\[fuzzy\]/);
      assert.match(approximate.text, /DIFFERENT identifiers/);
      assert.match(
        approximate.text,
        /matched name: NANTIANMEN_TEST_DATABASE_URL \(not PG_DATABASE_URL\)/,
      );
    });

    await t.test("grep carries the definition line itself and does not fold the rest", async () => {
      const hits = await session.call("grep", {
        root: repo,
        pattern: "format_chat_details",
      });
      assert.equal("detail" in hits.payload, false);
      assert.match(
        hits.text,
        /^src\/leagent\/generator\.py:11:\d+ def format_chat_details\(session, message, \*, verbose=False\):$/m,
      );
      assert.equal(hits.text.includes("```"), false);
      assert.ok(hits.payload.hits.length >= 1);
    });

    await t.test("graph opens the query's definition site first", async () => {
      const map = await session.call("graph", {
        root: repo,
        query: "how does format_chat_details work",
      });
      assert.equal(map.isError, false, map.text);
      assert.match(map.text, /exact hit on format_chat_details/);
      assert.match(map.text, /hit: format_chat_details — src\/leagent\/generator\.py:11-/);
      const span = map.text.match(
        /open these files \(1\)\n1\. src\/leagent\/generator\.py:(\d+)-(\d+) — format_chat_details/,
      );
      assert.ok(span, map.text);
      const source = readFileSync(join(repo, "src/leagent/generator.py"), "utf8").split("\n");
      const start = Number(span[1]);
      const end = Number(span[2]);
      assert.equal(start, 11);
      assert.match(source[start - 1], /def format_chat_details/);
      assert.match(source[end - 1], /return details/);
      assert.ok(end < source.length, map.text);
      assert.equal(map.text.includes("relevant lines"), false);
      assert.match(map.text, /- get_scores \(src\/leagent\/retrieval\/bm25\.py:\d+\)/);
      assert.equal(map.text.split("- get_scores (").length - 1, 1);
      assert.equal(map.payload.entries[0].path, "src/leagent/generator.py");
      assert.equal(map.text.includes("```"), false);
      assert.equal("sourceIncluded" in map.payload, false);
      assert.equal("alsoRanked" in map.payload, false);
      assert.equal("paths" in map.payload, false);

      // The engine ranked these on format, chat and get; they are named in the
      // dump, but they are not the next Read.
      const noise = [
        "src/leagent/openai.py",
        "src/leagent/retrieval/bm25.py",
        "src/leagent/chat/field_constraints.py",
      ];
      const entryPaths = map.payload.entries.map((entry) => entry.path);
      for (const path of noise) {
        assert.equal(
          entryPaths.slice(0, 1).includes(path),
          false,
          `${path} is the first reading entry\n${map.text}`,
        );
      }
      assert.equal(map.text.includes("detail:\"full\""), false);

      const ignoredDetail = await session.call("graph", {
        root: repo,
        query: "how does format_chat_details work",
        detail: "full",
      });
      assert.equal(ignoredDetail.text.includes("```"), false);
      assert.equal(
        ignoredDetail.text.split("\n").slice(1).join("\n"),
        map.text.split("\n").slice(1).join("\n"),
      );
    });

    assert.equal(existsSync(join(repo, ".codegraph")), false);
    assert.equal(existsSync(join(worktree, ".codegraph")), false);
  },
);

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createFramedParser, encodeMessage } from "../src/mcp.js";
import { directCalleeNodes, directCallerNodes, pickDefinition, symbolIndex } from "../src/symbol-index.js";

const bin = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(root, relative, body) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

const WIDGET = [
  '"""Widget rendering."""',
  "",
  "from src.pkg.canvas import paint, shade",
  "from src.pkg.layout import layout",
  "",
  "",
  'STATUS = "idle"',
  "",
  "",
  "def clamp(value, limit):",
  "    return min(value, limit)",
  "",
  "",
  "def render_widget(status, items):",
  '    """Draw one widget."""',
  "    placed = layout(items)",
  "    placed = layout(placed)",
  "    color = paint(status)",
  "    tint = shade(color)",
  "    bounded = clamp(len(placed), 8)",
  "    status = color",
  '    return {"status": status, "count": bounded, "placed": placed, "tint": tint}',
  "",
  "",
  "class Widget:",
  "    def show(self, items):",
  "        return render_widget(STATUS, items)",
  "",
].join("\n");

const CANVAS = [
  "def paint(status):",
  '    return status or "plain"',
  "",
  "",
  "def shade(color): return color",
  "",
].join("\n");

const LAYOUT = ["def layout(items):", "    return list(items or [])", ""].join("\n");

const NOISE = [
  "def format_prompt(text):",
  "    return text",
  "",
  "",
  "def get_widget():",
  "    return None",
  "",
].join("\n");

const VIEW = [
  "def use(status):",
  "    return status",
  "",
  "",
  "def use_again(status):",
  "    return status",
  "",
  "",
  'status = "shown"',
  "",
].join("\n");

test("pickDefinition chooses the hinted function, not a shorter namesake", () => {
  const nodes = [
    { id: "a", kind: "function", name: "render_widget", filePath: "src/pkg/other.py", startLine: 1, endLine: 2 },
    { id: "b", kind: "function", name: "render_widget", filePath: "src/pkg/widget.py", startLine: 14, endLine: 22 },
    { id: "c", kind: "class", name: "Widget", filePath: "src/pkg/widget.py", startLine: 25, endLine: 27 },
  ];
  const picked = pickDefinition(nodes, { path: "src/pkg/widget.py", line: 14 });
  assert.equal(picked.id, "b");
});

test("direct callees are calls only, and each callee once", () => {
  const nodes = {
    self: { id: "self", name: "render_widget", filePath: "src/pkg/widget.py", startLine: 14 },
    layout: { id: "layout", name: "layout", filePath: "src/pkg/layout.py", startLine: 1 },
    paint: { id: "paint", name: "paint", filePath: "src/pkg/canvas.py", startLine: 1 },
  };
  const edges = [
    { kind: "imports", target: "layout" },
    { kind: "calls", target: "layout" },
    { kind: "calls", target: "layout" },
    { kind: "calls", target: "paint" },
    { kind: "references", target: "paint" },
  ];
  const callees = directCalleeNodes(nodes.self, edges, (id) => nodes[id]);
  assert.deepEqual(
    callees.map((node) => node.name),
    ["layout", "paint"],
  );
});

test("direct callers are calls only, and each caller once", () => {
  const nodes = {
    self: { id: "self", name: "render_widget", filePath: "src/pkg/widget.py", startLine: 14 },
    show: { id: "show", name: "show", filePath: "src/pkg/widget.py", startLine: 25 },
    boot: { id: "boot", name: "boot", filePath: "src/pkg/main.py", startLine: 3 },
  };
  const edges = [
    { kind: "calls", source: "show" },
    { kind: "calls", source: "show" },
    { kind: "calls", source: "boot" },
    { kind: "references", source: "boot" },
  ];
  const callers = directCallerNodes(nodes.self, edges, (id) => nodes[id]);
  assert.deepEqual(
    callers.map((node) => node.name),
    ["show", "boot"],
  );
});

test("symbolIndex maps callees and callers without getCode", () => {
  const nodes = [
    {
      id: "render",
      kind: "function",
      name: "render_widget",
      filePath: "src/pkg/widget.py",
      startLine: 14,
      endLine: 22,
    },
    {
      id: "shade",
      kind: "function",
      name: "shade",
      filePath: "src/pkg/canvas.py",
      startLine: 5,
      endLine: 5,
    },
    {
      id: "paint",
      kind: "function",
      name: "paint",
      filePath: "src/pkg/canvas.py",
      startLine: 1,
      endLine: 2,
    },
    {
      id: "show",
      kind: "method",
      name: "show",
      filePath: "src/pkg/widget.py",
      startLine: 25,
      endLine: 27,
    },
  ];
  const byName = { render_widget: [nodes[0]] };
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
  let coded = 0;
  const graph = {
    getNodesByName: (name) => byName[name] || [],
    getOutgoingEdges: () => [
      { kind: "calls", target: "shade" },
      { kind: "calls", target: "paint" },
    ],
    getIncomingEdges: () => [{ kind: "calls", source: "show" }],
    getNode: (id) => byId[id],
    getCode: async () => {
      coded += 1;
      return "def shade(color): return color";
    },
  };
  const symbols = symbolIndex(graph, "how does render_widget work");
  assert.equal(coded, 0);
  assert.equal(symbols.length, 1);
  assert.deepEqual(
    [symbols[0].startLine, symbols[0].endLine],
    [14, 22],
  );
  assert.equal(symbols[0].callees[0].text, undefined);
  assert.deepEqual(
    symbols[0].callees.map((callee) => callee.name),
    ["shade", "paint"],
  );
  assert.deepEqual(
    symbols[0].callers.map((caller) => caller.name),
    ["show"],
  );
});

test("symbolIndex keeps every exact-name definition in scope and drops the rest", () => {
  const nodes = [
    {
      id: "a",
      kind: "function",
      name: "dispatch",
      filePath: "src/pkg/a.py",
      startLine: 1,
      endLine: 4,
    },
    {
      id: "b",
      kind: "function",
      name: "dispatch",
      filePath: "src/pkg/b.py",
      startLine: 8,
      endLine: 12,
    },
    {
      id: "out",
      kind: "function",
      name: "dispatch",
      filePath: "src/other/dispatch.py",
      startLine: 2,
      endLine: 6,
    },
    {
      id: "ref",
      kind: "calls",
      name: "dispatch",
      filePath: "src/pkg/a.py",
      startLine: 20,
      endLine: 20,
    },
    {
      id: "short",
      kind: "function",
      name: "full",
      filePath: "src/pkg/short.py",
      startLine: 1,
      endLine: 2,
    },
  ];
  const graph = {
    getNodesByName: (name) =>
      name === "dispatch" ? nodes.filter((node) => node.name === "dispatch") : [nodes[4]],
    getOutgoingEdges: () => [],
    getIncomingEdges: () => [],
    getNode: () => null,
    getCode: async () => {
      throw new Error("getCode should not run");
    },
  };
  const symbols = symbolIndex(graph, "dispatch path:src/pkg");
  assert.deepEqual(
    symbols.map((span) => span.path),
    ["src/pkg/a.py", "src/pkg/b.py"],
  );
  assert.equal(
    symbols.some((span) => span.name === "full"),
    false,
  );
});

test(
  "a pkg/widget repository: symbol span, one callee list, grouped assignments",
  { timeout: 180_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-widget-"));
    const root = join(parent, "widget");
    write(root, "src/pkg/widget.py", WIDGET);
    write(root, "src/pkg/canvas.py", CANVAS);
    write(root, "src/pkg/layout.py", LAYOUT);
    write(root, "src/pkg/noise/format_help.py", NOISE);
    write(root, "src/pkg/view.py", VIEW);
    git(root, "init", "-b", "main");
    git(root, "add", "-A");
    git(root, "-c", "user.name=codeq-test", "-c", "user.email=codeq@example.invalid", "commit", "-m", "fixture");
    const repo = realpathSync(root);
    const dataDir = join(parent, "data");
    const child = spawn(process.execPath, [bin, "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: repo,
      env: { ...process.env, CODEQ_DATA_DIR: dataDir },
    });
    const messages = [];
    const parse = createFramedParser((message) => messages.push(message));
    child.stdout.on("data", (chunk) => parse(chunk));
    let nextId = 1;
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

    async function call(name, args) {
      const id = nextId++;
      child.stdin.write(
        encodeMessage({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      );
      const started = Date.now();
      while (Date.now() - started < 120_000) {
        const match = messages.find((message) => message.id === id);
        if (match) {
          const text = match.result?.content?.[0]?.text || "";
          return {
            text,
            isError: Boolean(match.result?.isError),
            payload: match.result?.structuredContent ?? null,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`timed out waiting for ${name}`);
    }

    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: nextId++,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "codeq-widget", version: "0" },
        },
      }),
    );
    const initStarted = Date.now();
    while (!messages.some((message) => message.id === 1)) {
      if (Date.now() - initStarted > 10_000) throw new Error("initialize timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const map = await call("graph", {
      root: repo,
      query: "how does render_widget work",
    });
    assert.equal(map.isError, false, map.text);
    const span = map.text.match(
      /^src\/pkg\/widget\.py:(\d+)-(\d+) render_widget$/m,
    );
    assert.ok(span, map.text);
    const lines = WIDGET.split("\n");
    const start = Number(span[1]);
    const end = Number(span[2]);
    assert.match(lines[start - 1], /def render_widget/);
    assert.match(lines[end - 1], /return \{/);
    assert.ok(end < lines.length, map.text);
    assert.equal(map.text.includes("relevant lines"), false);
    assert.equal(map.payload.entries[0].path, "src/pkg/widget.py");
    assert.equal(
      map.payload.entries.some((entry) =>
        entry.path.includes("src/pkg/noise/format_help.py"),
      ),
      false,
    );
    assert.equal(map.text.includes("1. src/pkg/noise/format_help.py"), false);
    for (const name of ["layout", "paint", "clamp", "shade"]) {
      assert.match(map.text, new RegExp(`${name}`), map.text);
    }
    assert.match(map.text, /src\/pkg\/canvas\.py:\d+(-\d+)? shade/);
    assert.equal(map.text.includes("def shade(color): return color"), false);
    assert.equal(map.text.includes('return status or "plain"'), false);
    assert.equal(map.text.includes("```"), false);
    assert.equal(Array.isArray(map.payload.callers), true);

    const grep = await call("grep", { root: repo, pattern: "status" });
    assert.equal(grep.isError, false, grep.text);
    assert.match(grep.text, /^src\/pkg\/widget\.py:\d+ STATUS = "idle"$/m);
    assert.match(grep.text, /^src\/pkg\/widget\.py:\d+ status = color$/m);
    assert.match(grep.text, /^src\/pkg\/view\.py:\d+ status = "shown"$/m);
    assert.match(grep.text, /return status/);
    assert.equal(grep.text.includes("more hits in these files:"), false);
    assert.equal(grep.text.includes("detail:\"full\""), false);
    assert.ok(grep.payload.hits.length >= 3);
    assert.equal(typeof grep.payload.truncated, "boolean");
  },
);

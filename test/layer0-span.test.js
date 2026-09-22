import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createFramedParser, encodeMessage } from "../src/mcp.js";
import { directCalleeNodes, pickDefinition, symbolIndex } from "../src/symbol-index.js";

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

test("symbolIndex reads a span and a one-line callee body from the graph", async () => {
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
  ];
  const byName = { render_widget: [nodes[0]] };
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const graph = {
    getNodesByName: (name) => byName[name] || [],
    getOutgoingEdges: () => [
      { kind: "calls", target: "shade" },
      { kind: "calls", target: "paint" },
    ],
    getNode: (id) => byId[id],
    getCode: async (id) => (id === "shade" ? "def shade(color): return color" : "def paint(status):\n    return status"),
  };
  const symbols = await symbolIndex(
    graph,
    "how does render_widget work",
    "- `render_widget` (src/pkg/widget.py:14) — 1 caller in `src/pkg/widget.py`",
  );
  assert.equal(symbols.length, 1);
  assert.deepEqual(
    [symbols[0].startLine, symbols[0].endLine],
    [14, 22],
  );
  assert.equal(symbols[0].callees[0].text, "def shade(color): return color");
  assert.equal(symbols[0].callees[1].text, undefined);
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
      /open these files \(1\)\n1\. src\/pkg\/widget\.py:(\d+)-(\d+) — render_widget\(function\)/,
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
      assert.equal(map.text.split(`- ${name} (`).length - 1, 1, map.text);
    }
    assert.match(map.text, /- shade \(src\/pkg\/canvas\.py:\d+\) def shade\(color\): return color/);
    assert.equal(map.text.includes('return status or "plain"'), false);
    assert.equal(map.text.includes("```"), false);

    const grep = await call("grep", { root: repo, pattern: "status" });
    assert.equal(grep.isError, false, grep.text);
    assert.match(grep.text, /^src\/pkg\/widget\.py:\d+:\d+ STATUS = "idle"$/m);
    assert.match(grep.text, /^src\/pkg\/widget\.py:\d+:\d+ status = color$/m);
    assert.match(grep.text, /^src\/pkg\/view\.py:\d+:\d+ status = "shown"$/m);
    assert.match(grep.text, /return status/);
    assert.equal(grep.text.includes("more hits in these files:"), false);
    assert.equal(grep.text.includes("detail:\"full\""), false);
    assert.ok(grep.payload.hits.length >= 3);
    assert.equal(typeof grep.payload.truncated, "boolean");
  },
);

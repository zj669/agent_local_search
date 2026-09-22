import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createCodeqExtension } from "../src/extension.js";
import { formatMcpToolResult } from "../../src/mcp-format.js";
import { maybeRerank } from "../../src/jev.js";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

function readSrc(relative) {
  return readFileSync(join(pkgRoot, relative), "utf8");
}

function mockPi() {
  const tools = [];
  const events = [];
  return {
    tools,
    events,
    registerTool(tool) {
      tools.push(tool);
    },
    unregisterTool() {
      throw new Error("unregisterTool must not be called");
    },
    on(event, handler) {
      events.push({ event, handler });
    },
  };
}

function load(options = {}) {
  const calls = [];
  const query =
    options.query ??
    (async (request, extra) => {
      calls.push({ request, extra });
      return {
        status: "ready",
        root: request.root || request.cwd,
        rootSource: request.root ? "root" : "cwd",
        warning: null,
        query: request.query,
        pattern: request.query,
        results: [],
        result: "",
      };
    });
  const pi = mockPi();
  const factory = createCodeqExtension({
    query,
    format: options.format ?? formatMcpToolResult,
    rerank: options.rerank,
  });
  factory(pi);
  const byName = Object.fromEntries(pi.tools.map((tool) => [tool.name, tool]));
  return { pi, calls, byName };
}

test("package is a Pi extension named @zj669/codeq-pi", () => {
  const pkg = JSON.parse(readSrc("package.json"));
  const cli = JSON.parse(readSrc("../package.json"));
  assert.equal(pkg.name, "@zj669/codeq-pi");
  assert.equal(pkg.version, "0.3.8");
  assert.equal(cli.version, "0.3.8");
  assert.deepEqual(pkg.pi, { extensions: ["./src/index.ts"] });
  assert.equal(pkg.keywords.includes("pi-package"), true);
  assert.equal(pkg.dependencies["@zj669/codeq"], "file:..");
  assert.equal(pkg.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(pkg.peerDependencies.typebox, "*");
});

test("default export registers tools without contacting the daemon", async () => {
  const { default: factory } = await import("../src/index.ts");
  assert.equal(typeof factory, "function");
  const pi = mockPi();
  factory(pi);
  assert.deepEqual(
    pi.tools.map((tool) => tool.name),
    ["find", "grep", "graph"],
  );
});

test("entry wires queryDaemon lazily and never FileFinder / pi-fff", () => {
  const entry = readSrc("src/index.ts");
  const extension = readSrc("src/extension.js");
  const combined = `${entry}\n${extension}`;
  assert.match(entry, /queryDaemon/);
  assert.match(entry, /@zj669\/codeq\/src\/client\.js/);
  assert.match(entry, /createCodeqExtension/);
  assert.equal(combined.includes("FileFinder"), false);
  assert.equal(combined.includes("@ff-labs/pi-fff"), false);
  assert.equal(combined.includes("unregisterTool"), false);
  assert.equal(combined.includes("CODEQ_CWD"), false);
  assert.equal(combined.includes("--exclude-tools"), false);
  assert.equal(combined.includes("leagent"), false);
  assert.equal(combined.includes("FULL_GREP_CONTEXT"), false);
  assert.equal(combined.includes("detailField"), false);
  assert.equal(/detail:\s*"full"/.test(combined), false);
  assert.match(entry, /export default createCodeqExtension/);
});

test("factory registers grep, find, and graph only, without querying", async () => {
  let queried = false;
  const { pi } = load({
    query: async () => {
      queried = true;
      return { status: "ready", results: [] };
    },
  });
  assert.deepEqual(
    pi.tools.map((tool) => tool.name),
    ["find", "grep", "graph"],
  );
  assert.equal(pi.tools.length, 3);
  assert.equal(queried, false);
  assert.deepEqual(pi.events, []);
  for (const tool of pi.tools) {
    assert.equal(typeof tool.promptSnippet, "string");
    assert.equal(Array.isArray(tool.promptGuidelines), true);
    assert.equal(
      tool.promptGuidelines.every((line) => line.includes(tool.name)),
      true,
    );
    assert.match(tool.description, /codeq/i);
    assert.equal("detail" in tool.parameters.properties, false);
  }
  assert.match(pi.tools[0].description, /not Pi's builtin fd/);
  assert.match(pi.tools[1].description, /not Pi's builtin rg/);
  assert.match(pi.tools[1].description, /literal string/);
  assert.match(pi.tools[2].description, /direct callees, and direct callers/);
  assert.match(pi.tools[2].description, /There is no callers tool/);
  assert.match(pi.tools[2].description, /where X is defined/);
  assert.match(pi.tools[2].description, /who calls/);
  assert.match(pi.tools[2].description, /For how-it-works, Read the entry/);
  assert.doesNotMatch(pi.tools[2].description, /Read the entry first/);
  const graphGuide = pi.tools[2].promptGuidelines.join("\n");
  assert.match(graphGuide, /where X is defined/);
  assert.match(graphGuide, /who calls/);
  assert.match(graphGuide, /how-it-works, Read the entry/);
  assert.doesNotMatch(graphGuide, /Read the entry first/);
  assert.match(
    pi.tools[2].parameters.properties.query.description,
    /who calls/,
  );
  assert.match(pi.tools[0].promptGuidelines.join("\n"), /not a glob/);
  assert.match(pi.tools[1].promptGuidelines.join("\n"), /literal string/);
  assert.equal(Boolean(pi.tools[1].parameters.properties.regex), true);
  const agentText = [
    ...pi.tools.map((tool) => tool.description),
    ...pi.tools.flatMap((tool) => tool.promptGuidelines),
    ...pi.tools.map((tool) => JSON.stringify(tool.parameters)),
  ].join("\n");
  assert.equal(/jev|noul|prod_shortlist|exact_neighborhood|skipped/i.test(agentText), false);
  assert.equal(Boolean(pi.tools[1].parameters.properties.cursor), true);
  assert.equal(Boolean(pi.tools[1].parameters.properties.context), false);
});

test("execute reads ctx.cwd on every call and never caches it", async () => {
  const { calls, byName } = load();
  let cwd = "/repos/alpha";
  const ctx = {
    get cwd() {
      return cwd;
    },
  };
  await byName.find.execute("1", { query: "foo.py" }, undefined, undefined, ctx);
  cwd = "/repos/beta";
  await byName.grep.execute(
    "2",
    { pattern: "TODO" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(calls[0].request.cwd, "/repos/alpha");
  assert.equal(calls[0].request.command, "find");
  assert.equal(calls[0].request.query, "foo.py");
  assert.equal(calls[1].request.cwd, "/repos/beta");
  assert.equal(calls[1].request.command, "grep");
  assert.equal(calls[1].request.query, "TODO");
});

test("forwards path, root, limit, glob, regex, cursor, fuzzy, and graph query", async () => {
  const { calls, byName } = load();
  const ctx = { cwd: "/session" };
  await byName.find.execute(
    "1",
    { query: "foo.py", path: "src/", root: "/repos/app", limit: 8 },
    undefined,
    undefined,
    ctx,
  );
  await byName.grep.execute(
    "2",
    {
      pattern: "render",
      path: "src/pkg",
      glob: "**/*.ts",
      fuzzy: true,
      regex: true,
      cursor: "opaque",
      limit: 4,
    },
    undefined,
    undefined,
    ctx,
  );
  await byName.graph.execute(
    "3",
    { query: "how does render work", root: "/repos/app" },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(calls[0].request, {
    command: "find",
    cwd: "/session",
    query: "foo.py",
    path: "src/",
    root: "/repos/app",
    limit: 8,
  });
  assert.deepEqual(calls[1].request, {
    command: "grep",
    cwd: "/session",
    query: "render",
    path: "src/pkg",
    glob: "**/*.ts",
    fuzzy: true,
    regex: true,
    cursor: "opaque",
    limit: 4,
  });
  assert.deepEqual(calls[2].request, {
    command: "graph",
    cwd: "/session",
    query: "how does render work",
    root: "/repos/app",
  });
});

test("prepareArguments maps builtin find pattern and strips @ / cwd / detail", () => {
  const { byName } = load();
  assert.deepEqual(byName.find.prepareArguments({ pattern: "foo.py" }), {
    query: "foo.py",
  });
  assert.deepEqual(
    byName.find.prepareArguments({
      query: "keep",
      pattern: "drop",
      path: "@src/",
      cwd: "/tmp/ignored",
      detail: "full",
    }),
    { query: "keep", path: "src/" },
  );
  assert.deepEqual(
    byName.grep.prepareArguments({
      query: "TODO",
      ignoreCase: true,
      literal: true,
      context: 2,
      detail: "full",
      path: "@src/pkg/foo.py",
    }),
    { pattern: "TODO", path: "src/pkg/foo.py" },
  );
});

test("content is the MCP/CLI map and details are locator fields", async () => {
  const { byName } = load({
    query: async (request) => ({
      status: "ready",
      root: "/repos/app",
      rootSource: "cwd",
      warning: null,
      query: request.query,
      pattern: request.query,
      results: [{ path: "src/pkg/foo.py", score: 1, matchType: "exact" }],
      result: "",
    }),
  });
  const result = await byName.find.execute(
    "1",
    { query: "foo.py" },
    undefined,
    undefined,
    { cwd: "/repos/app" },
  );
  const expected = formatMcpToolResult("find", {
    status: "ready",
    root: "/repos/app",
    rootSource: "cwd",
    warning: null,
    query: "foo.py",
    pattern: "foo.py",
    results: [{ path: "src/pkg/foo.py", score: 1, matchType: "exact" }],
    result: "",
  });
  assert.deepEqual(result.content, [{ type: "text", text: expected.text }]);
  assert.equal("command" in result.details, false);
  assert.equal(result.details.root, "/repos/app");
  assert.deepEqual(result.details.paths, ["src/pkg/foo.py"]);
  assert.equal("matches" in result.details, false);
  assert.match(result.content[0].text, /^\[ready\]/);
  assert.match(result.content[0].text, /src\/pkg\/foo\.py/);
});

test("passes abort signal through and returns isError on failure", async () => {
  const controller = new AbortController();
  const { byName } = load({
    query: async (_request, { signal }) => {
      assert.equal(signal, controller.signal);
      throw new Error("daemon down");
    },
  });
  const result = await byName.graph.execute(
    "1",
    { query: "how does foo work" },
    controller.signal,
    undefined,
    { cwd: "/session" },
  );
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "daemon down");
});

test("execute uses ctx.cwd even if params.cwd is present", async () => {
  const { calls, byName } = load();
  await byName.find.execute(
    "1",
    { query: "foo.py", cwd: "/from-params" },
    undefined,
    undefined,
    { cwd: "/from-session" },
  );
  assert.equal(calls[0].request.cwd, "/from-session");
});

test("missing session cwd is an error and does not query", async () => {
  let queried = false;
  const { byName } = load({
    query: async () => {
      queried = true;
      return { status: "ready", results: [] };
    },
  });
  const result = await byName.find.execute(
    "1",
    { query: "foo.py" },
    undefined,
    undefined,
    { cwd: "  " },
  );
  assert.equal(queried, false);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ctx\.cwd/);
});

test("rerank runs before format, matching CLI/MCP", async () => {
  const order = [];
  const { byName } = load({
    query: async () => {
      order.push("query");
      return { status: "ready", root: "/r", results: [{ path: "a.ts" }] };
    },
    rerank: async (name, request, result) => {
      order.push(`rerank:${name}:${request.cwd}`);
      return { ...result, results: [{ path: "ranked.ts" }] };
    },
    format: (name, result) => {
      order.push(`format:${result.results[0].path}`);
      return { text: result.results[0].path, structuredContent: { name } };
    },
  });
  const result = await byName.find.execute(
    "1",
    { query: "a" },
    undefined,
    undefined,
    { cwd: "/session" },
  );
  assert.deepEqual(order, [
    "query",
    "rerank:find:/session",
    "format:ranked.ts",
  ]);
  assert.equal(result.content[0].text, "ranked.ts");
});

test("find production shortlist skip and mixed-config grep still match CLI", async () => {
  let called = 0;
  const systemOne = async (payload) => {
    called += 1;
    const answers = {};
    for (const key of Object.keys(payload.questions)) {
      answers[key] = { type: "noul", noul: 0.1 };
    }
    return { answers };
  };
  const env = { CODEQ_JEV_KEY: "x" };
  const { byName } = load({
    query: async (request) => {
      if (request.command === "find") {
        return {
          status: "ready",
          root: "/repos/app",
          query: request.query,
          results: [
            { path: "src/pkg/foo.py", matchType: "exact" },
            { path: "src/pkg/other.py", matchType: "fuzzy" },
          ],
        };
      }
      return {
        status: "ready",
        root: "/repos/app",
        pattern: request.query,
        mode: "plain",
        results: [
          {
            path: "src/pkg/foo.py",
            line: 1,
            column: 1,
            text: "def render_widget():",
          },
          {
            path: ".github/workflows/ci.yml",
            line: 4,
            column: 1,
            text: "render_widget",
          },
        ],
      };
    },
    rerank: (name, request, result) =>
      maybeRerank(name, request, result, { env, systemOne }),
  });
  const ctx = { cwd: "/repos/app" };
  const found = await byName.find.execute(
    "1",
    { query: "foo.py" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(called, 0);
  assert.equal(/jev|noul|prod_shortlist|exact_neighborhood|skipped/i.test(found.content[0].text), false);
  const grepped = await byName.grep.execute(
    "2",
    { pattern: "render_widget" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(called, 1);
  assert.equal(/jev|noul|prod_shortlist|exact_neighborhood|skipped/i.test(grepped.content[0].text), false);
});

test("graph exact neighborhood skip matches CLI and empty entries are not that skip", async () => {
  let called = 0;
  const systemOne = async (payload) => {
    called += 1;
    const answers = {};
    for (const key of Object.keys(payload.questions)) {
      answers[key] = { type: "noul", noul: 0.1 };
    }
    return { answers };
  };
  const env = { CODEQ_JEV_KEY: "x" };
  const { byName } = load({
    query: async (request) => {
      if (request.query.includes("missing_widget")) {
        return {
          status: "ready",
          root: "/repos/app",
          query: request.query,
          result: "",
          symbols: [],
        };
      }
      return {
        status: "ready",
        root: "/repos/app",
        query: request.query,
        result: "",
        symbols: [
          {
            name: "render_widget",
            kind: "function",
            path: "src/pkg/foo.py",
            startLine: 14,
            endLine: 22,
            callees: [{ name: "layout", path: "src/pkg/layout.py", line: 1, endLine: 2 }],
            callers: [{ name: "show", path: "src/pkg/widget.py", line: 25, endLine: 27 }],
          },
        ],
      };
    },
    rerank: (name, request, result) =>
      maybeRerank(name, request, result, { env, systemOne }),
  });
  const ctx = { cwd: "/repos/app" };
  const mapped = await byName.graph.execute(
    "1",
    { query: "how does render_widget work" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(called, 0);
  assert.equal(
    /jev|noul|prod_shortlist|exact_neighborhood|skipped/i.test(mapped.content[0].text),
    false,
  );
  assert.match(
    mapped.content[0].text,
    /graph "how does render_widget work" — exact render_widget/,
  );
  assert.match(mapped.content[0].text, /^callers: show src\/pkg\/widget\.py:25$/m);
  const missed = await byName.graph.execute(
    "2",
    { query: "how does missing_widget work" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(called, 0);
  const missReranked = await maybeRerank(
    "graph",
    { query: "how does missing_widget work" },
    {
      status: "ready",
      root: "/repos/app",
      query: "how does missing_widget work",
      result: "",
      symbols: [],
    },
    { env, systemOne },
  );
  assert.equal(missReranked.jev.skipped, "too_few");
  assert.equal(
    /jev|noul|prod_shortlist|exact_neighborhood|skipped/i.test(missed.content[0].text),
    false,
  );
});

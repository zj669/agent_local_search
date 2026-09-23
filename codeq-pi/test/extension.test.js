import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  applyCodeqActiveTools,
  applyCodeqPromptOrder,
  CODEQ_BEFORE_BASH_GUIDELINE,
  CODEQ_TOOL_NAMES,
  createCodeqExtension,
  prioritizeCodeqTools,
  SAFE_TUI_WIDTH,
  wrapTuiLine,
} from "../src/extension.js";
import { EMPTY_TOOL_MENU, GREP_REGEX_REQUIRED, formatMcpToolResult } from "../../src/mcp-format.js";
import { maybeRerank } from "../../src/jev.js";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

function readSrc(relative) {
  return readFileSync(join(pkgRoot, relative), "utf8");
}

function mockPi(activeToolNames = []) {
  const tools = [];
  const events = [];
  let activeTools = [...activeToolNames];
  return {
    tools,
    events,
    registerTool(tool) {
      tools.push(tool);
    },
    unregisterTool() {
      throw new Error("unregisterTool must not be called");
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names) {
      activeTools = [...names];
    },
    on(event, handler) {
      events.push({ event, handler });
    },
  };
}

function handler(pi, event) {
  return pi.events.find((entry) => entry.event === event)?.handler;
}

/** Same rule order Pi 0.87.1 uses in buildRules / <tools>. */
function piToolsAndRules(selectedTools, snippets, toolGuidelines, promptGuidelines) {
  const tools = selectedTools
    .filter((name) => snippets[name])
    .map((name) => `- ${name}: ${snippets[name]}`);
  const rules = [];
  const seen = new Set();
  const addRule = (rule) => {
    const normalized = rule.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    rules.push(normalized);
  };
  const hasBash = selectedTools.includes("bash");
  const hasGrep = selectedTools.includes("grep");
  const hasFind = selectedTools.includes("find");
  const hasLs = selectedTools.includes("ls");
  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    addRule("Use bash for file operations like ls, rg, find");
  }
  for (const name of selectedTools) {
    for (const rule of toolGuidelines[name] ?? []) addRule(rule);
  }
  for (const rule of promptGuidelines ?? []) addRule(rule);
  return { tools, rules };
}

const DEFAULT_ACTIVE = [
  "read",
  "bash",
  "edit",
  "write",
  "find",
  "grep",
  "graph",
];

const PI_SNIPPETS = {
  read: "Read file contents",
  bash: "Execute bash commands (ls, grep, find, etc.)",
  edit: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
  write: "Create or overwrite files",
};

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
  const readme = readSrc("README.md");
  assert.equal(pkg.name, "@zj669/codeq-pi");
  assert.equal(pkg.version, "0.3.11");
  assert.equal(cli.version, "0.3.11");
  assert.deepEqual(pkg.pi, { extensions: ["./src/index.ts"] });
  assert.equal(pkg.keywords.includes("pi-package"), true);
  assert.equal(pkg.dependencies["@zj669/codeq"], "file:..");
  assert.equal(pkg.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(pkg.peerDependencies.typebox, "*");
  assert.match(readme, /pi install npm:@zj669\/codeq-pi/);
  assert.match(readme, /@zj669\/codeq@0\.3\.11/);
  assert.equal(readme.includes("not published"), false);
  assert.equal(readme.includes("/absolute/path/to/agent_local_search"), false);
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
  assert.equal(combined.includes("tool_call"), false);
  assert.equal(combined.includes("user_bash"), false);
  assert.match(extension, /setActiveTools/);
  assert.match(extension, /selectedTools/);
  assert.match(extension, /CODEQ_BEFORE_BASH_GUIDELINE/);
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
  assert.deepEqual(
    pi.events.map((entry) => entry.event),
    ["session_start", "before_agent_start"],
  );
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
  assert.equal(pi.tools[1].description.includes("host Ripgrep"), false);
  assert.equal(
    pi.tools[1].description.includes("do not open host Ripgrep"),
    false,
  );
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
  assert.equal(pi.tools[0].promptGuidelines[0], CODEQ_BEFORE_BASH_GUIDELINE);
  assert.equal(pi.tools[1].promptGuidelines[0], CODEQ_BEFORE_BASH_GUIDELINE);
  assert.equal(pi.tools[2].promptGuidelines[0], CODEQ_BEFORE_BASH_GUIDELINE);
  assert.equal(Boolean(pi.tools[1].parameters.properties.regex), true);
  assert.ok(pi.tools[1].parameters.required.includes("regex"));
  assert.ok(pi.tools[1].parameters.required.includes("pattern"));
  assert.equal(pi.tools[1].parameters.required.includes("fuzzy"), false);
  assert.match(pi.tools[1].parameters.properties.regex.description, /Required/);
  assert.equal(
    pi.tools[1].parameters.properties.regex.description.includes("Default false"),
    false,
  );
  const agentText = [
    ...pi.tools.map((tool) => tool.description),
    ...pi.tools.flatMap((tool) => tool.promptGuidelines),
    ...pi.tools.map((tool) => JSON.stringify(tool.parameters)),
  ].join("\n");
  assert.equal(/jev|noul|prod_shortlist|exact_neighborhood|tier_order|mixed_grep|skipped/i.test(agentText), false);
  assert.equal(Boolean(pi.tools[1].parameters.properties.cursor), true);
  assert.equal(Boolean(pi.tools[1].parameters.properties.context), true);
  assert.equal(Boolean(pi.tools[1].parameters.properties.count), true);
  assert.equal(Boolean(pi.tools[1].parameters.properties.ignoreCase), true);
  assert.match(pi.tools[1].description, /pass context \(at most 3\)/i);
  assert.equal(pi.tools[1].description.includes("host Ripgrep"), false);
  assert.equal(Boolean(pi.tools[0].parameters.properties.context), false);
  assert.equal(Boolean(pi.tools[2].parameters.properties.context), false);
});

test("prioritizeCodeqTools puts find/grep/graph before bash and keeps bash", () => {
  assert.deepEqual(CODEQ_TOOL_NAMES, ["find", "grep", "graph"]);
  assert.deepEqual(prioritizeCodeqTools(DEFAULT_ACTIVE), [
    "find",
    "grep",
    "graph",
    "read",
    "bash",
    "edit",
    "write",
  ]);
  assert.deepEqual(
    prioritizeCodeqTools(["read", "bash", "edit", "write", "grep", "graph"]),
    ["grep", "graph", "read", "bash", "edit", "write"],
  );
  assert.deepEqual(prioritizeCodeqTools(["find", "grep", "graph"]), [
    "find",
    "grep",
    "graph",
  ]);
  assert.deepEqual(
    prioritizeCodeqTools(["read", "bash", "my_tool", "find"]),
    ["find", "read", "bash", "my_tool"],
  );
  assert.deepEqual(prioritizeCodeqTools(["read", "bash", "edit", "write"]), [
    "read",
    "bash",
    "edit",
    "write",
  ]);
  assert.ok(prioritizeCodeqTools(DEFAULT_ACTIVE).includes("bash"));
});

test("session_start lists find/grep/graph before bash in the Pi <tools> list", () => {
  const { pi, byName } = load();
  pi.setActiveTools(DEFAULT_ACTIVE);
  handler(pi, "session_start")();
  const names = pi.getActiveTools();
  assert.deepEqual(names.slice(0, 3), ["find", "grep", "graph"]);
  assert.ok(names.includes("bash"));
  const snippets = {
    ...PI_SNIPPETS,
    find: byName.find.promptSnippet,
    grep: byName.grep.promptSnippet,
    graph: byName.graph.promptSnippet,
  };
  const { tools, rules } = piToolsAndRules(
    names,
    snippets,
    Object.fromEntries(
      Object.entries(byName).map(([name, tool]) => [name, tool.promptGuidelines]),
    ),
    [],
  );
  const bashAt = tools.findIndex((line) => line.startsWith("- bash:"));
  assert.ok(bashAt > 2);
  assert.equal(tools[0], `- find: ${byName.find.promptSnippet}`);
  assert.equal(tools[1], `- grep: ${byName.grep.promptSnippet}`);
  assert.equal(tools[2], `- graph: ${byName.graph.promptSnippet}`);
  assert.match(tools[bashAt], /ls, grep, find/);
  assert.equal(rules[0], CODEQ_BEFORE_BASH_GUIDELINE);
  assert.equal(
    rules.filter((line) => line === CODEQ_BEFORE_BASH_GUIDELINE).length,
    1,
  );
});

test("before_agent_start reorders selectedTools and leads promptGuidelines", () => {
  const { pi, byName } = load();
  pi.setActiveTools(DEFAULT_ACTIVE);
  const event = {
    systemPromptOptions: {
      selectedTools: [...DEFAULT_ACTIVE],
      promptGuidelines: ["Be concise in your responses"],
      toolGuidelines: {
        read: ["Use read to examine files instead of cat or sed."],
        bash: [
          "You can inspect PI_* environment variables for current model and session details.",
        ],
        find: [...byName.find.promptGuidelines],
        grep: [...byName.grep.promptGuidelines],
        graph: [...byName.graph.promptGuidelines],
      },
    },
  };
  handler(pi, "before_agent_start")(event);
  assert.deepEqual(pi.getActiveTools().slice(0, 3), ["find", "grep", "graph"]);
  assert.ok(pi.getActiveTools().includes("bash"));
  assert.deepEqual(event.systemPromptOptions.selectedTools.slice(0, 3), [
    "find",
    "grep",
    "graph",
  ]);
  assert.equal(
    event.systemPromptOptions.promptGuidelines[0],
    CODEQ_BEFORE_BASH_GUIDELINE,
  );
  const snippets = {
    ...PI_SNIPPETS,
    find: byName.find.promptSnippet,
    grep: byName.grep.promptSnippet,
    graph: byName.graph.promptSnippet,
  };
  const { tools, rules } = piToolsAndRules(
    event.systemPromptOptions.selectedTools,
    snippets,
    event.systemPromptOptions.toolGuidelines,
    event.systemPromptOptions.promptGuidelines,
  );
  assert.equal(tools[0].startsWith("- find:"), true);
  assert.ok(
    tools.findIndex((line) => line.startsWith("- bash:")) >
      tools.findIndex((line) => line.startsWith("- graph:")),
  );
  assert.equal(rules[0], CODEQ_BEFORE_BASH_GUIDELINE);
});

test("when Pi keeps builtins first, the bash guideline still leads <rules>", () => {
  const { byName } = load();
  const original = [...DEFAULT_ACTIVE];
  const options = {
    selectedTools: [...original],
    promptGuidelines: [],
    toolGuidelines: {
      read: ["Use read to examine files instead of cat or sed."],
      bash: [
        "You can inspect PI_* environment variables for current model and session details.",
      ],
      find: [...byName.find.promptGuidelines],
      grep: [...byName.grep.promptGuidelines],
      graph: [...byName.graph.promptGuidelines],
    },
  };
  applyCodeqPromptOrder(options);
  const { tools, rules } = piToolsAndRules(
    original,
    {
      ...PI_SNIPPETS,
      find: byName.find.promptSnippet,
      grep: byName.grep.promptSnippet,
      graph: byName.graph.promptSnippet,
    },
    options.toolGuidelines,
    options.promptGuidelines,
  );
  assert.equal(tools[0], `- read: ${PI_SNIPPETS.read}`);
  assert.equal(tools[1], `- bash: ${PI_SNIPPETS.bash}`);
  assert.equal(rules[0], CODEQ_BEFORE_BASH_GUIDELINE);
  assert.equal(options.toolGuidelines.read[0], CODEQ_BEFORE_BASH_GUIDELINE);
  assert.equal(options.promptGuidelines[0], CODEQ_BEFORE_BASH_GUIDELINE);
});

test("applyCodeqActiveTools does not drop bash or add a fourth tool", () => {
  const pi = mockPi(DEFAULT_ACTIVE);
  applyCodeqActiveTools(pi);
  assert.deepEqual(pi.getActiveTools(), [
    "find",
    "grep",
    "graph",
    "read",
    "bash",
    "edit",
    "write",
  ]);
  const missing = mockPi(["read", "bash", "edit", "write"]);
  applyCodeqActiveTools(missing);
  assert.deepEqual(missing.getActiveTools(), [
    "read",
    "bash",
    "edit",
    "write",
  ]);
  const noApi = { registerTool() {}, on() {} };
  applyCodeqActiveTools(noApi);
  const { pi: loaded } = load();
  assert.equal(loaded.tools.length, 3);
  assert.equal(
    loaded.events.some((entry) => entry.event === "tool_call"),
    false,
  );
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
    { pattern: "TODO", regex: false },
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
  assert.equal(calls[1].request.regex, false);
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
      context: 2,
      count: false,
      ignoreCase: false,
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
    context: 2,
    count: false,
    ignoreCase: false,
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
    { pattern: "TODO", path: "src/pkg/foo.py", ignoreCase: true, context: 2 },
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

test("missing required find/grep/graph strings return the shared menu", async () => {
  let queried = false;
  const { byName } = load({
    query: async () => {
      queried = true;
      return { status: "ready", results: [] };
    },
  });
  const ctx = { cwd: "/session" };
  const find = await byName.find.execute("1", {}, undefined, undefined, ctx);
  const grep = await byName.grep.execute(
    "2",
    { pattern: "" },
    undefined,
    undefined,
    ctx,
  );
  const graph = await byName.graph.execute(
    "3",
    { query: "  " },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(queried, false);
  assert.equal(find.isError, true);
  assert.equal(grep.isError, true);
  assert.equal(graph.isError, true);
  assert.equal(find.content[0].text, EMPTY_TOOL_MENU);
  assert.equal(grep.content[0].text, EMPTY_TOOL_MENU);
  assert.equal(graph.content[0].text, EMPTY_TOOL_MENU);
  assert.equal(find.content[0].text.includes("find requires query"), false);
});

test("grep without regex is a missing required field, not the empty-call menu", async () => {
  let queried = false;
  const { byName } = load({
    query: async () => {
      queried = true;
      return { status: "ready", results: [] };
    },
  });
  const ctx = { cwd: "/session" };
  const omitted = await byName.grep.execute(
    "1",
    { pattern: "TODO" },
    undefined,
    undefined,
    ctx,
  );
  const stringRegex = await byName.grep.execute(
    "2",
    { pattern: "TODO", regex: "false" },
    undefined,
    undefined,
    ctx,
  );
  const literal = await byName.grep.execute(
    "3",
    { pattern: "TODO", regex: false },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(queried, true);
  assert.equal(omitted.isError, true);
  assert.equal(omitted.content[0].text, GREP_REGEX_REQUIRED);
  assert.equal(omitted.content[0].text.includes("codeq needs"), false);
  assert.equal(omitted.content[0].text.includes("fuzzy"), false);
  assert.equal(stringRegex.isError, true);
  assert.equal(stringRegex.content[0].text, GREP_REGEX_REQUIRED);
  assert.equal(literal.isError, undefined);
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

test("find production shortlist skip and singleton mixed grep skip match CLI", async () => {
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
      if (request.query === "crowded") {
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
              text: "def crowded():",
            },
            {
              path: "src/pkg/bar.py",
              line: 2,
              column: 1,
              text: "crowded()",
            },
            {
              path: "src/pkg/foo_test.py",
              line: 8,
              column: 1,
              text: "def test_crowded():",
            },
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
  assert.equal(
    /jev|noul|prod_shortlist|exact_neighborhood|tier_order|mixed_grep|skipped/i.test(found.content[0].text),
    false,
  );
  const grepped = await byName.grep.execute(
    "2",
    { pattern: "render_widget", regex: false },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(called, 0);
  assert.equal(
    /jev|noul|prod_shortlist|exact_neighborhood|tier_order|mixed_grep|skipped/i.test(grepped.content[0].text),
    false,
  );
  const crowded = await byName.grep.execute(
    "3",
    { pattern: "crowded", regex: false },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(called, 1);
  assert.equal(
    /jev|noul|prod_shortlist|exact_neighborhood|tier_order|mixed_grep|skipped/i.test(crowded.content[0].text),
    false,
  );
});

test("mixed-tier find skip matches CLI and all-config find still reranks", async () => {
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
      if (request.query === "ci.yml") {
        return {
          status: "ready",
          root: "/repos/app",
          query: request.query,
          results: [
            { path: "src/pkg/foo.py", matchType: "fuzzy" },
            { path: ".github/workflows/ci.yml", matchType: "fuzzy" },
          ],
        };
      }
      return {
        status: "ready",
        root: "/repos/app",
        query: request.query,
        results: [
          { path: ".github/workflows/ci.yml", matchType: "fuzzy" },
          { path: ".editorconfig", matchType: "fuzzy" },
        ],
      };
    },
    rerank: (name, request, result) =>
      maybeRerank(name, request, result, { env, systemOne }),
  });
  const ctx = { cwd: "/repos/app" };
  const mixed = await byName.find.execute(
    "1",
    { query: "ci.yml" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(called, 0);
  assert.equal(
    /jev|noul|prod_shortlist|exact_neighborhood|tier_order|mixed_grep|skipped/i.test(mixed.content[0].text),
    false,
  );
  const allConfig = await byName.find.execute(
    "2",
    { query: "editorconfig" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(called, 1);
  assert.equal(
    /jev|noul|prod_shortlist|exact_neighborhood|tier_order|mixed_grep|skipped/i.test(allConfig.content[0].text),
    false,
  );
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
    /jev|noul|prod_shortlist|exact_neighborhood|tier_order|mixed_grep|skipped/i.test(mapped.content[0].text),
    false,
  );
  assert.match(
    mapped.content[0].text,
    /graph "how does render_widget work" — exact render_widget/,
  );
  assert.match(mapped.content[0].text, /^callers$/m);
  assert.match(mapped.content[0].text, /^src\/pkg\/widget\.py:25-27 show$/m);
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
    /jev|noul|prod_shortlist|exact_neighborhood|tier_order|mixed_grep|skipped/i.test(missed.content[0].text),
    false,
  );
});

const ANSI = /\x1b\[[0-9;]*m/g;

function visible(line) {
  return String(line).replace(ANSI, "").length;
}

function assertFits(lines, width) {
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(
      visible(line) <= width,
      `TUI line ${visible(line)} > ${width}: ${String(line).replace(ANSI, "")}`,
    );
  }
}

const NANTIANMEN_ROOT = "/Users/zj669/project/leagent-nantianmen";
const LONG_ABS_LOCATOR = `${NANTIANMEN_ROOT}/src/leagent_nantianmen/flows/factory.py`;

function longGraphFormatted() {
  return formatMcpToolResult("graph", {
    status: "ready",
    root: NANTIANMEN_ROOT,
    rootSource: "root",
    query: "NantianmenFlowFactory create_flow",
    result: "",
    symbols: [
      {
        name: "NantianmenFlowFactory",
        kind: "class",
        path: LONG_ABS_LOCATOR,
        startLine: 120,
        endLine: 180,
        callees: [
          { name: "run_step", path: LONG_ABS_LOCATOR, line: 40, endLine: 55 },
        ],
        callers: [{ name: "main", path: LONG_ABS_LOCATOR, line: 400, endLine: 420 }],
      },
    ],
  });
}

test("wrapTuiLine keeps root and via when the freshness line is wider than the TUI", () => {
  const first = `[ready] root ${NANTIANMEN_ROOT} via root argument`;
  const wrapped = wrapTuiLine(first, 48);
  assert.ok(wrapped.every((line) => line.length <= 48));
  assert.ok(wrapped.some((line) => line.includes("[ready]")));
  assert.ok(
    wrapped.some((line) => line === NANTIANMEN_ROOT || line.endsWith(NANTIANMEN_ROOT)),
    wrapped.join("\n"),
  );
  assert.ok(wrapped.some((line) => line.startsWith("via ")));
  assert.equal(wrapped.join("").includes("via root argument"), true);
});

test("wrapTuiLine hard-wraps an unbreakable locator and keeps path, span, and name", () => {
  const locator = `${LONG_ABS_LOCATOR}:120-180 NantianmenFlowFactory`;
  assert.ok(locator.length > 80);
  const wrapped = wrapTuiLine(locator, SAFE_TUI_WIDTH);
  assert.ok(wrapped.every((line) => line.length <= SAFE_TUI_WIDTH));
  const joined = wrapped.join("");
  assert.equal(joined.includes(LONG_ABS_LOCATOR), true);
  assert.equal(joined.includes("120-180"), true);
  assert.equal(joined.includes("NantianmenFlowFactory"), true);
  assert.ok(
    wrapped.some((line) => /factory\.py:120-180 NantianmenFlowFactory/.test(line)),
    wrapped.join("\n"),
  );
});

test("Pi renderCall/renderResult wrap to the given width; model text stays one-line locators", async () => {
  const { byName } = load({
    query: async (request) => ({
      status: "ready",
      root: NANTIANMEN_ROOT,
      rootSource: "root",
      query: request.query,
      result: "",
      symbols: [
        {
          name: "NantianmenFlowFactory",
          kind: "class",
          path: LONG_ABS_LOCATOR,
          startLine: 120,
          endLine: 180,
          callees: [],
          callers: [],
        },
      ],
    }),
  });
  const theme = {
    bold: (s) => s,
    fg: (color, text) => `\x1b[32m${text}\x1b[39m`,
  };
  const executed = await byName.graph.execute(
    "1",
    { query: "NantianmenFlowFactory create_flow", root: NANTIANMEN_ROOT },
    undefined,
    undefined,
    { cwd: NANTIANMEN_ROOT },
  );
  const model = executed.content[0].text;
  assert.match(model, /^\[ready\] root \/Users\/zj669\/project\/leagent-nantianmen via root argument$/m);
  assert.match(
    model,
    new RegExp(`^${LONG_ABS_LOCATOR.replace(/\//g, "\\/")}:120-180 NantianmenFlowFactory$`, "m"),
  );
  assert.ok(
    model
      .split("\n")
      .some((line) => line.length > 80 && line.includes("NantianmenFlowFactory")),
  );

  const call = byName.graph.renderCall(
    { query: "NantianmenFlowFactory create_flow", root: NANTIANMEN_ROOT },
    theme,
  );
  const result = byName.graph.renderResult(
    executed,
    { expanded: false },
    theme,
  );
  for (const width of [80, 78, SAFE_TUI_WIDTH, 40]) {
    assertFits(call.render(width), width);
    assertFits(result.render(width), width);
  }
  assertFits(call.render(), SAFE_TUI_WIDTH);
  assertFits(result.render(), SAFE_TUI_WIDTH);

  const inner = 78;
  const boxed = result.render(inner).map((line) => ` ${line.replace(ANSI, "")}`);
  assert.ok(boxed.every((line) => line.length <= 80));

  const rendered = result.render(78).map((line) => line.replace(ANSI, "")).join("\n");
  assert.match(rendered, /\[ready\]/);
  assert.match(rendered, /root /);
  assert.match(rendered, /via root argument/);
  assert.match(rendered, /NantianmenFlowFactory/);
  assert.match(rendered, /120-180/);
});

test("81-column locator plus Pi Box pad is what threw 82 > 80; wrapped render stays under 80", () => {
  const locator = `${"src/leagent_nantianmen/bench/decidexxxxxxxxxxxxxxx.py"}:120-180 decide_final_result`;
  assert.equal(locator.length, 81);
  const formatted = formatMcpToolResult("graph", {
    status: "ready",
    root: NANTIANMEN_ROOT,
    rootSource: "root",
    query: "decide_final_result",
    result: "",
    symbols: [
      {
        name: "decide_final_result",
        kind: "function",
        path: "src/leagent_nantianmen/bench/decidexxxxxxxxxxxxxxx.py",
        startLine: 120,
        endLine: 180,
        callees: [],
        callers: [],
      },
    ],
  });
  assert.match(formatted.text, /^src\/leagent_nantianmen\/bench\/decidexxxxxxxxxxxxxxx\.py:120-180 decide_final_result$/m);
  const { byName } = load();
  const result = byName.graph.renderResult(
    { content: [{ type: "text", text: formatted.text }] },
    { expanded: true },
    { fg: (_c, s) => s },
  );
  const inner = result.render(78);
  assertFits(inner, 78);
  assert.ok(inner.every((line) => ` ${line}`.length <= 80));
  assert.equal(longGraphFormatted().text.includes(LONG_ABS_LOCATOR), true);
});

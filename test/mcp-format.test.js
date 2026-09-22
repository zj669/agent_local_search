import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMcpToolResult,
  freshnessLine,
  rootOrigin,
} from "../src/mcp-format.js";
import { parseExploreDump, queryIdentifiers } from "../src/graph-map.js";

const stale = {
  status: "degraded",
  warning: "FFF watcher is not covering this root",
  lastSuccessfulSync: "2026-09-21T10:00:00.000Z",
  root: "/repo",
  rootSource: "cwd",
  cwdSource: "roots/list",
};

function exploreDump(files = 2) {
  const section = (path, symbols, first) =>
    [
      `**\`${path}\`** — ${symbols}`,
      "",
      "```javascript",
      ...Array.from({ length: 20 }, (_, i) => `${first + i}\tconst line${i} = ${i};`),
      "```",
      "",
    ].join("\n");
  return [
    "**Exploration: how does createSession work**",
    "",
    `Found 43 symbols across ${files} files.`,
    "",
    "**Blast radius — what depends on these (update/verify before editing)**",
    "",
    "- `createSession` (src/session.ts:12) — 3 callers in `src/app.ts`; tests: `test/session.test.js`",
    "- `TOOLS` (src/app.ts:52) — 2 callers in `src/app.ts`; tested via callers: `test/app.test.js`",
    "",
    "**Source Code**",
    "",
    "> The code below is the **verbatim, current on-disk source** of these files. Treat each block as a Read you have already performed: do not Read a file shown here.",
    "",
    section("src/session.ts", "createSession(function), TOOLS(constant), send(calls), imports(imports), +5 more", 1),
    section("src/app.ts", "send(calls), positiveInteger(calls), jsonRpcError(calls), +24 more", 252),
    ...(files > 2
      ? [section("lib/extra.ts", "helper(function), +2 more", 1)]
      : []),
    "**Not shown above — explore these names for their source**",
    "",
    "- src/other.ts: helper:4, widget:9",
    "",
    "> Some file sections were trimmed for size. For a specific symbol you still need, run another `codegraph_explore` (or `codegraph_node`) with its exact name.",
  ].join("\n");
}

const graphResult = {
  ...stale,
  status: "ready",
  warning: null,
  query: "how does createSession work",
  result: exploreDump(),
  symbols: [
    {
      name: "createSession",
      kind: "function",
      path: "src/session.ts",
      startLine: 12,
      endLine: 40,
      callees: [
        { name: "send", path: "src/app.ts", line: 252, endLine: 270 },
        { name: "send", path: "src/app.ts", line: 252, endLine: 270 },
        {
          name: "ready",
          path: "src/session.ts",
          line: 4,
          endLine: 4,
          text: "function ready() { return true; }",
        },
      ],
    },
  ],
};

test("freshness line leads every MCP reply", () => {
  const formatted = formatMcpToolResult("find", {
    ...stale,
    query: "app",
    total: 1,
    results: [{ path: "src/app.ts", size: 12 }],
  });
  assert.match(
    formatted.text,
    /^\[degraded\] root \/repo via cwd \(roots\/list\) lastSuccessfulSync /,
  );
  assert.match(formatted.text, /warning FFF watcher/);
  const payload = formatted.structuredContent;
  assert.equal(payload.status, "degraded");
  assert.equal(payload.root, "/repo");
  assert.equal(payload.truncated, false);
  assert.equal("rootSource" in payload, false);
  assert.equal("command" in payload, false);
  assert.deepEqual(payload.paths, ["src/app.ts"]);
});

test("ready replies omit lastSuccessfulSync from the first line", () => {
  const formatted = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    lastSuccessfulSync: "2026-09-21T10:00:00.000Z",
    query: "app",
    results: [{ path: "src/app.ts" }],
  });
  assert.equal(formatted.text.split("\n")[0], "[ready] root /repo");
});

test("the text channel is a map, never the payload serialized again", () => {
  for (const command of ["find", "grep", "graph"]) {
    const formatted = formatMcpToolResult(command, {
      ...graphResult,
      query: "how does createSession work",
      pattern: "createSession",
      results: [{ path: "src/app.ts", line: 1, column: 1, text: "x" }],
    });
    assert.equal(formatted.text.includes('"status": "ready"'), false);
    assert.equal(formatted.text.includes('"rootSource"'), false);
    assert.throws(() => JSON.parse(formatted.text.split("\n").slice(1).join("\n")));
  }
});

test("every reply says which argument selected the root", () => {
  assert.equal(rootOrigin({ rootSource: "root" }), "root argument");
  assert.equal(rootOrigin({ rootSource: "path" }), "path argument");
  assert.equal(
    rootOrigin({ rootSource: "cwd", cwdSource: "spawn cwd" }),
    "cwd (spawn cwd)",
  );
  assert.equal(rootOrigin({}), null);

  for (const command of ["find", "grep", "graph"]) {
    const explicit = formatMcpToolResult(command, {
      status: "ready",
      root: "/other/repo",
      rootSource: "root",
      cwdSource: "spawn cwd",
      results: [],
      result: exploreDump(),
    });
    assert.equal(
      explicit.text.split("\n")[0],
      "[ready] root /other/repo via root argument",
    );
    assert.equal(explicit.structuredContent.root, "/other/repo");
    assert.equal("rootSource" in explicit.structuredContent, false);
  }
});

test("graph is a locator map: no source, no engine self-description", () => {
  const formatted = formatMcpToolResult("graph", graphResult);
  const text = formatted.text;

  assert.equal(text.includes("```"), false);
  assert.equal(/verbatim/i.test(text), false);
  assert.equal(/already performed/i.test(text), false);
  assert.equal(text.includes("codegraph_explore"), false);
  assert.equal(text.includes("detail:\"full\""), false);

  assert.match(text, /graph "how does createSession work" — 43 symbols in 2 files/);
  assert.match(text, /exact hit on createSession/);
  assert.match(text, /hit: createSession — src\/session\.ts:12-40/);
  assert.match(text, /open these files \(1\)/);
  assert.match(text, /1\. src\/session\.ts:12-40 — createSession\(function\)/);
  assert.match(text, /calls \(direct\)/);
  assert.match(text, /- send \(src\/app\.ts:252\)/);
  assert.equal(text.split("- send (").length - 1, 1);
  assert.match(text, /- ready \(src\/session\.ts:4\) function ready\(\) \{ return true; \}/);

  const payload = formatted.structuredContent;
  assert.equal(payload.truncated, false);
  assert.deepEqual(payload.entries[0], {
    symbol: "createSession",
    path: "src/session.ts",
    startLine: 12,
    endLine: 40,
    kind: "function",
  });
  assert.deepEqual(
    payload.callees.map((callee) => callee.name),
    ["send", "ready"],
  );
});

test("graph still has navigable entries when the identifier did not hit", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "how does format_chat_details work",
  });
  assert.match(formatted.text, /NO exact hit on format_chat_details/);
  assert.match(formatted.text, /engine ranked these instead: createSession, TOOLS/);
  assert.ok(formatted.structuredContent.entries.length > 0);
  assert.equal(formatted.structuredContent.entries[0].path, "src/session.ts");
});

test("graph opens the query identifier's span first", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "how does format_chat_details work",
    result: [
      "Found 61 symbols across 4 files.",
      "",
      "- `format_chat_details` (src/pkg/generator.py:317) — 5 callers",
      "",
      "**`src/pkg/openai.py`** — format_prompt(function)",
      "",
      "```python",
      "1\tdef format_prompt():",
      "```",
      "",
      "**`src/pkg/generator.py`** — format_chat_details(function)",
      "",
      "```python",
      "317\tdef format_chat_details():",
      "```",
    ].join("\n"),
    symbols: [
      {
        name: "format_chat_details",
        kind: "function",
        path: "src/pkg/generator.py",
        startLine: 317,
        endLine: 340,
        callees: [
          { name: "get_scores", path: "src/pkg/bm25.py", line: 4, endLine: 9 },
        ],
      },
    ],
  });
  assert.match(formatted.text, /hit: format_chat_details — src\/pkg\/generator\.py:317-340/);
  assert.equal(formatted.structuredContent.entries[0].path, "src/pkg/generator.py");
  assert.match(formatted.text, /- get_scores \(src\/pkg\/bm25\.py:4\)/);
});

test("graph caps the callee list and keeps multi-line bodies out", () => {
  const callees = Array.from({ length: 9 }, (_, i) => ({
    name: `step${i}`,
    path: `src/pkg/step${i}.py`,
    line: i + 1,
    endLine: i + 4,
    text: "return step",
  }));
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    symbols: [
      {
        name: "createSession",
        kind: "function",
        path: "src/session.ts",
        startLine: 12,
        endLine: 40,
        callees,
      },
    ],
  });
  assert.match(formatted.text, /- step0 \(src\/pkg\/step0\.py:1\)/);
  assert.match(formatted.text, /- step7 \(src\/pkg\/step7\.py:8\)/);
  assert.equal(formatted.text.includes("step8"), false);
  assert.equal(formatted.text.includes("return step"), false);
  assert.equal(formatted.structuredContent.truncated, true);
  assert.match(formatted.text, /truncated: 1 more direct callee/);
});

test("graph says when one query stacked several topics", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "regression benchmark replay",
  });
  assert.match(
    formatted.text,
    /this query names 3 topics \(regression, benchmark, replay\), so this map is wider than one symbol\./,
  );
});

test("grep groups hits by file, prefers definitions, and does not fold the rest", () => {
  const hits = [
    { path: "src/pkg/view.py", line: 2, column: 12, text: "    return status" },
    { path: "src/pkg/view.py", line: 4, column: 12, text: "    print(status)" },
    { path: "src/pkg/widget.py", line: 8, column: 16, text: "    color = paint(status)" },
    { path: "src/pkg/widget.py", line: 3, column: 1, text: 'STATUS = "idle"' },
    { path: "src/pkg/widget.py", line: 14, column: 5, text: "    status = color" },
    { path: "src/pkg/widget.py", line: 10, column: 20, text: "def render_widget(status, items):" },
    { path: "src/pkg/view.py", line: 6, column: 1, text: 'status = "shown"' },
  ];
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "status",
    mode: "plain",
    results: hits,
  });
  const text = formatted.text;
  assert.match(text, /^src\/pkg\/widget\.py:3:1 STATUS = "idle"$/m);
  assert.match(text, /return status/);
  assert.equal(text.includes("detail:\"full\""), false);
  assert.equal(formatted.structuredContent.hits.length, 7);
  assert.equal(formatted.structuredContent.truncated, false);
});

test("grep is exact by default and never labels itself fuzzy", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "createSession",
    mode: "plain",
    results: [
      {
        path: "src/app.ts",
        line: 4,
        column: 1,
        text: "  export function createSession() {}",
      },
    ],
  });
  assert.equal(formatted.text.includes("[fuzzy]"), false);
  assert.match(formatted.text, /grep createSession — 1 match in 1 file/);
  assert.deepEqual(formatted.structuredContent.hits[0], {
    path: "src/app.ts",
    line: 4,
    column: 1,
    text: "export function createSession() {}",
  });
});

test("grep zero hits stay zero and point at regex and fuzzy", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "PG_DATABASE_URL",
    mode: "plain",
    fuzzyRequested: false,
    results: [],
  });
  assert.match(formatted.text, /grep PG_DATABASE_URL — 0 matches/);
  assert.match(formatted.text, /pass regex: true if you meant a regular expression/);
  assert.match(formatted.text, /fuzzy: true for approximate names/);
  assert.deepEqual(formatted.structuredContent.hits, []);
});

test("grep fuzzy is labelled on the first line and names what it matched", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "GRAPH_SUMMERY_CHARS",
    mode: "fuzzy",
    fuzzyRequested: true,
    results: [
      {
        path: "src/mcp-format.js",
        line: 1,
        column: 7,
        text: "const GRAPH_SUMMARY_CHARS = 4_000;",
      },
    ],
  });
  assert.equal(formatted.text.split("\n")[0], "[ready][fuzzy] root /repo");
  assert.match(formatted.text, /matched name: GRAPH_SUMMARY_CHARS/);
});

test("grep reports a real nextCursor instead of a fake total", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "reply_success",
    mode: "plain",
    nextCursor: "abc",
    results: Array.from({ length: 16 }, (_, i) => ({
      path: `src/file${i}.ts`,
      line: i + 1,
      column: 1,
      text: "reply_success()",
    })),
  });
  assert.match(formatted.text, /grep reply_success — 16 shown, more remain/);
  assert.match(formatted.text, /cursor=abc/);
  assert.equal(formatted.structuredContent.truncated, true);
  assert.equal(formatted.structuredContent.nextCursor, "abc");
});

test("find replies are paths, not file metadata", () => {
  const formatted = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "codeq",
    total: 2,
    results: [
      {
        path: "bin/codeq.js",
        size: 4_096,
        score: 88,
        matchType: "exact",
      },
      { path: "src/grep-mode.js", score: 30 },
    ],
  });
  assert.match(formatted.text, /find codeq — 2 matches/);
  assert.equal(formatted.text.includes("4096"), false);
  assert.equal(formatted.text.includes("88"), false);
  assert.deepEqual(formatted.structuredContent.paths, [
    "bin/codeq.js",
    "src/grep-mode.js",
  ]);
});

test("find pins exact path matches first without Jev", () => {
  const formatted = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "foo.py",
    total: 3,
    results: [
      { path: "src/pkg/foo_test.py", matchType: "prefix" },
      { path: "src/pkg/other.py", matchType: "fuzzy" },
      { path: "src/pkg/foo.py", matchType: "exact" },
    ],
  });
  assert.deepEqual(formatted.structuredContent.paths, [
    "src/pkg/foo.py",
    "src/pkg/foo_test.py",
    "src/pkg/other.py",
  ]);
});

test("find says glob syntax is not how find works", () => {
  const formatted = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "mr_review_service/**/*profile*",
    total: 0,
    results: [],
  });
  assert.match(formatted.text, /find is a fuzzy path fragment, not a glob/);
});

test("the dump parser keys off the file-section marker, not a path regex", () => {
  const dump = parseExploreDump(exploreDump(3));
  assert.deepEqual(
    dump.files.map((file) => file.path),
    ["src/session.ts", "src/app.ts", "lib/extra.ts"],
  );
  assert.equal(dump.symbolCount, 43);
});

test("query identifiers drop the prose around them", () => {
  assert.deepEqual(queryIdentifiers("how does formatMcpToolResult work"), [
    "formatMcpToolResult",
  ]);
  assert.equal(freshnessLine({ status: "ready" }), "[ready]");
});

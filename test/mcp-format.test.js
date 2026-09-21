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

// Shaped like a real CodeGraph explore dump: summary, blast radius, the
// verbatim banner, one file section per file, then the trimmed-note epilogue
// that names tools codeq does not expose.
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
    "> The code below is the **verbatim, current on-disk source** of these files — re-read from disk on this call and line-numbered, byte-for-byte identical to what the Read tool returns. Treat each block as a Read you have already performed: do not Read a file shown here.",
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
    "> Some file sections were trimmed for size. For a specific symbol you still need, run another `codegraph_explore` (or `codegraph_node`) with its exact name — line-numbered source, cheaper and more complete than Read.",
  ].join("\n");
}

const graphResult = {
  ...stale,
  status: "ready",
  warning: null,
  query: "how does createSession work",
  result: exploreDump(),
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
  assert.equal(payload.lastSuccessfulSync, stale.lastSuccessfulSync);
  assert.deepEqual(Object.keys(payload).slice(0, 7), [
    "status",
    "warning",
    "lastSuccessfulSync",
    "root",
    "rootSource",
    "rootNote",
    "cwdSource",
  ]);
  assert.deepEqual(payload.paths, ["src/app.ts"]);
  assert.equal(payload.shown, 1);
  assert.deepEqual(payload.results, []);
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
    assert.equal(formatted.text.includes("\\n"), false);
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
  assert.equal(
    rootOrigin({ rootSource: "cwd", cwdSource: "cwd argument" }),
    "cwd (cwd argument)",
  );
  assert.equal(rootOrigin({ rootSource: "cwd" }), "cwd");
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
    assert.equal(explicit.structuredContent.rootSource, "root");
  }
});

test("an unknown root source degrades to the plain root line", () => {
  const formatted = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    results: [],
  });
  assert.equal(formatted.text.split("\n")[0], "[ready] root /repo");
});

test("graph layer 0 is a map: no source, no engine self-description", () => {
  const formatted = formatMcpToolResult("graph", graphResult);
  const text = formatted.text;

  assert.equal(text.includes("```"), false);
  assert.equal(/verbatim/i.test(text), false);
  assert.equal(/already performed/i.test(text), false);
  assert.equal(text.includes("codegraph_explore"), false);
  assert.equal(text.includes("codegraph_node"), false);

  assert.match(text, /graph "how does createSession work" — 43 symbols in 2 files/);
  assert.match(text, /exact hit on createSession/);
  assert.match(text, /hit: createSession — src\/session\.ts:12/);
  assert.match(text, /open these files \(2\)/);
  assert.match(
    text,
    /1\. src\/session\.ts:12 — createSession\(function\), TOOLS\(constant\), send \+5 · relevant lines 1-20/,
  );
  assert.match(text, /2\. src\/app\.ts — send, positiveInteger, jsonRpcError \+23 · relevant lines 252-271/);
  assert.match(text, /no source in this map\. detail:"full" returns source for these 2 files/);
  assert.ok(text.length <= 1_500, `layer 0 is ${text.length} chars`);

  const payload = formatted.structuredContent;
  assert.equal(payload.sourceIncluded, false);
  assert.deepEqual(payload.paths, ["src/session.ts", "src/app.ts"]);
  assert.deepEqual(payload.exactHits, [
    { symbol: "createSession", path: "src/session.ts", line: 12 },
  ]);
  assert.deepEqual(payload.files[1].renderedLines, [252, 271]);
  assert.equal(payload.files[0].symbolCount, 9);
});

test("graph paths are the files to open; pointers and folded names are alsoRanked", () => {
  const payload = formatMcpToolResult("graph", graphResult).structuredContent;
  assert.deepEqual(payload.paths, ["src/session.ts", "src/app.ts"]);
  assert.equal(payload.paths.includes("src/other.ts"), false);
  assert.equal(payload.paths.includes("test/session.test.js"), false);
  assert.deepEqual(payload.alsoRanked, ["TOOLS", "src/other.ts"]);
});

test("graph layer 1 repeats layer 0 verbatim and then adds source", () => {
  const summary = formatMcpToolResult("graph", graphResult);
  const full = formatMcpToolResult("graph", graphResult, { detail: "full" });

  assert.equal(full.text.startsWith(summary.text), true);
  assert.match(full.text, /```javascript/);
  assert.equal(full.text.includes("codegraph_explore"), false);
  assert.equal(full.structuredContent.sourceIncluded, true);
  assert.equal(full.structuredContent.omitted.files, 0);
  assert.equal(full.structuredContent.detail, "full");
});

test("graph layer 1 drops whole file sections and names what it dropped", () => {
  const huge = Array.from(
    { length: 400 },
    (_, i) => `${i + 1}\tconst padding${i} = "${"x".repeat(60)}";`,
  ).join("\n");
  const dump = [
    "Found 9 symbols across 2 files.",
    "",
    "**`src/session.ts`** — createSession(function)",
    "",
    "```javascript",
    huge,
    "```",
    "",
    "**`src/app.ts`** — send(calls)",
    "",
    "```javascript",
    huge,
    "```",
  ].join("\n");
  const full = formatMcpToolResult(
    "graph",
    { ...graphResult, result: dump },
    { detail: "full" },
  );
  assert.match(full.text, /omitted source for 1 file \(src\/app\.ts\)/);
  assert.match(full.text, /pass path=src\/app\.ts to get that one in full/);
  assert.equal(/verbatim/i.test(full.text), false);
  assert.equal(full.structuredContent.omitted.files, 1);
});

test("graph says so when the query identifier did not hit", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "how does format_chat_details work",
  });
  assert.match(formatted.text, /NO exact hit on format_chat_details/);
  assert.match(formatted.text, /engine ranked these instead: createSession, TOOLS/);
  assert.match(formatted.text, /grep the exact name/);
  assert.deepEqual(formatted.structuredContent.exactHits, []);
});

test("graph folds the file list rather than cutting characters", () => {
  const sections = Array.from({ length: 30 }, (_, i) =>
    [
      `**\`src/file${i}.ts\`** — symbol${i}(function), other${i}(calls), +9 more`,
      "",
      "```javascript",
      `1\tconst a = ${i};`,
      "```",
      "",
    ].join("\n"),
  );
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    result: ["Found 300 symbols across 30 files.", "", ...sections].join("\n"),
  });
  assert.ok(formatted.text.length <= 1_500, `layer 0 is ${formatted.text.length} chars`);
  assert.match(formatted.text, /more files the engine rendered — detail:"full"/);
  assert.ok(formatted.structuredContent.paths.length <= 12);
});

test("grep is exact by default and never labels itself fuzzy", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    warning: null,
    lastSuccessfulSync: stale.lastSuccessfulSync,
    root: "/repo",
    pattern: "createSession",
    mode: "plain",
    fuzzyRequested: false,
    shown: 1,
    moreRemain: false,
    results: [
      {
        path: "src/app.ts",
        line: 4,
        column: 1,
        text: "  export function createSession() {}",
        contextBefore: ["prev"],
        contextAfter: ["next"],
      },
    ],
  });
  assert.equal(formatted.text.includes("[fuzzy]"), false);
  assert.match(formatted.text, /grep createSession — 1 match in 1 file, exact/);
  assert.match(formatted.text, /^src\/app\.ts:4:1 export function createSession\(\) \{\}$/m);
  assert.equal(formatted.text.includes("prev"), false);
  assert.deepEqual(formatted.structuredContent.hits[0], {
    path: "src/app.ts",
    line: 4,
    column: 1,
    text: "export function createSession() {}",
  });
  assert.equal(formatted.structuredContent.fuzzy, false);
  assert.equal(formatted.structuredContent.moreRemain, false);
});

test("grep zero hits stay zero and point at the opt-in", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "PG_DATABASE_URL",
    mode: "plain",
    fuzzyRequested: false,
    shown: 0,
    moreRemain: false,
    results: [],
  });
  assert.equal(formatted.text.split("\n")[0].includes("[fuzzy]"), false);
  assert.match(formatted.text, /grep PG_DATABASE_URL — 0 matches, exact/);
  assert.match(formatted.text, /pass fuzzy: true for approximate names/);
  assert.match(formatted.text, /NOT the same identifier/);
  assert.equal(formatted.structuredContent.shown, 0);
  assert.deepEqual(formatted.structuredContent.hits, []);
});

test("grep fuzzy is labelled on the first line and names what it matched", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "GRAPH_SUMMERY_CHARS",
    mode: "fuzzy",
    fuzzyRequested: true,
    shown: 1,
    moreRemain: false,
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
  assert.match(
    formatted.text,
    /grep GRAPH_SUMMERY_CHARS — 0 exact matches; 1 fuzzy match, DIFFERENT identifiers/,
  );
  assert.match(
    formatted.text,
    /matched name: GRAPH_SUMMARY_CHARS \(not GRAPH_SUMMERY_CHARS\)/,
  );
  assert.equal(formatted.structuredContent.mode, "fuzzy");
  assert.equal(formatted.structuredContent.fuzzy, true);
});

test("grep reports this page, not a total it cannot know", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "reply_success",
    mode: "plain",
    shown: 50,
    moreRemain: true,
    results: Array.from({ length: 50 }, (_, i) => ({
      path: `src/file${i}.ts`,
      line: i + 1,
      column: 1,
      text: "reply_success()",
    })),
  });
  assert.match(formatted.text, /grep reply_success — 50 shown, more remain, exact/);
  assert.match(formatted.text, /more: raise limit, or narrow with glob\/path/);
  assert.equal(formatted.text.includes("total"), false);
  assert.equal(formatted.structuredContent.moreRemain, true);
  assert.equal(formatted.structuredContent.shown, 50);
});

test("grep full adds context lines the summary withholds", () => {
  const result = {
    status: "ready",
    root: "/repo",
    pattern: "createSession",
    mode: "plain",
    shown: 1,
    moreRemain: false,
    results: [
      {
        path: "src/app.ts",
        line: 4,
        column: 1,
        text: "export function createSession() {}",
        contextBefore: ["prev"],
        contextAfter: ["next"],
      },
    ],
  };
  const full = formatMcpToolResult("grep", result, { detail: "full" });
  assert.match(full.text, /src\/app\.ts-3- prev/);
  assert.match(full.text, /src\/app\.ts-5- next/);
  assert.deepEqual(full.structuredContent.hits[0].contextBefore, ["prev"]);
});

test("find replies are paths, not file metadata", () => {
  const formatted = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "codeq",
    total: 2,
    indexed: 40,
    results: [
      {
        path: "bin/codeq.js",
        size: 4_096,
        modified: 1_758_000_000,
        gitStatus: "modified",
        score: 88,
        matchType: "exact",
      },
      { path: "src/grep-mode.js", size: 12, modified: 1, gitStatus: "clean", score: 30 },
    ],
  });
  assert.match(formatted.text, /find codeq — 2 matches/);
  assert.match(formatted.text, /^bin\/codeq\.js$/m);
  assert.equal(formatted.text.includes("4096"), false);
  assert.equal(formatted.text.includes("modified"), false);
  assert.equal(formatted.text.includes("88"), false);
  assert.equal(formatted.structuredContent.indexed, 40);

  const full = formatMcpToolResult(
    "find",
    {
      status: "ready",
      root: "/repo",
      query: "codeq",
      total: 1,
      results: [{ path: "bin/codeq.js", score: 88, matchType: "exact" }],
    },
    { detail: "full" },
  );
  assert.match(full.text, /bin\/codeq\.js · score 88 exact/);
  assert.deepEqual(full.structuredContent.results, [
    { path: "bin/codeq.js", score: 88, matchType: "exact" },
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
  assert.match(formatted.text, /pass profile\./);
});

test("the dump parser keys off the file-section marker, not a path regex", () => {
  const dump = parseExploreDump(exploreDump(3));
  assert.deepEqual(
    dump.files.map((file) => file.path),
    ["src/session.ts", "src/app.ts", "lib/extra.ts"],
  );
  assert.deepEqual(dump.files[0].renderedLines, [1, 20]);
  assert.deepEqual(dump.pointers, [{ path: "src/other.ts", symbols: "helper:4, widget:9" }]);
  assert.equal(dump.blast.length, 2);
  assert.equal(dump.symbolCount, 43);
});

test("query identifiers drop the prose around them", () => {
  assert.deepEqual(queryIdentifiers("how does formatMcpToolResult work"), [
    "formatMcpToolResult",
  ]);
  assert.deepEqual(queryIdentifiers("GlobalAgent prepare_planner"), [
    "GlobalAgent",
    "prepare_planner",
  ]);
  assert.equal(freshnessLine({ status: "ready" }), "[ready]");
});

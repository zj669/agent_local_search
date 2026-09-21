import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMcpToolResult,
  freshnessLine,
  parseMcpToolText,
  rootOrigin,
} from "../src/mcp-format.js";

const stale = {
  status: "degraded",
  warning: "FFF watcher is not covering this root",
  lastSuccessfulSync: "2026-09-21T10:00:00.000Z",
  root: "/repo",
  rootSource: "cwd",
  cwdSource: "roots/list",
};

test("freshness line leads every MCP payload", () => {
  const formatted = formatMcpToolResult("find", {
    ...stale,
    total: 1,
    results: [{ path: "src/app.ts", size: 12 }],
  });
  assert.match(
    formatted.text,
    /^\[degraded\] root \/repo via cwd \(roots\/list\) lastSuccessfulSync /,
  );
  assert.match(formatted.text, /warning FFF watcher/);
  const payload = parseMcpToolText(formatted.text);
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
  assert.deepEqual(payload.results, [{ path: "src/app.ts" }]);
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
      result: "graph dump",
    });
    assert.equal(
      explicit.text.split("\n")[0],
      "[ready] root /other/repo via root argument",
    );
    assert.equal(explicit.payload.root, "/other/repo");
    assert.equal(explicit.payload.rootSource, "root");
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

test("graph summary truncates and keeps a full-text escape hatch", () => {
  const body = `see src/auth.ts and lib/session.ts\n${"symbol dump line\n".repeat(300)}`;
  const summary = formatMcpToolResult(
    "graph",
    { ...stale, status: "ready", warning: null, result: body },
    { detail: "summary" },
  );
  const payload = parseMcpToolText(summary.text);
  assert.equal(payload.truncated, true);
  assert.match(payload.hint, /detail: "full"/);
  assert.equal(payload.result, undefined);
  assert.ok(payload.summary.endsWith("…"));
  assert.ok(payload.paths.includes("src/auth.ts"));

  const full = formatMcpToolResult(
    "graph",
    { ...stale, result: body },
    { detail: "full" },
  );
  assert.equal(parseMcpToolText(full.text).result, body.trimEnd());
  assert.equal(parseMcpToolText(full.text).truncated, false);
});

test("grep summary drops context but keeps match lines", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    warning: null,
    lastSuccessfulSync: stale.lastSuccessfulSync,
    root: "/repo",
    mode: "regex",
    fuzzyFallback: false,
    total: 1,
    results: [
      {
        path: "src/app.ts",
        line: 4,
        column: 1,
        text: "export function foo() {}",
        contextBefore: ["prev"],
        contextAfter: ["next"],
      },
    ],
  });
  const payload = parseMcpToolText(formatted.text);
  assert.deepEqual(payload.results[0], {
    path: "src/app.ts",
    line: 4,
    column: 1,
    text: "export function foo() {}",
  });
  assert.equal(freshnessLine({ status: "ready" }), "[ready]");
});

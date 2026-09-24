import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FIND_CONFIRM,
  formatMcpToolResult,
  GRAPH_LOCATED,
  IDENTIFIER_GREP_LOCATED,
  identifierGraphHook,
} from "../src/mcp-format.js";
import { dataHome } from "../src/paths.js";
import {
  grepExcerptWindow,
  isSidecarTail,
  sidecarDir,
  sidecarTailLine,
  sweepSidecars,
  writeSidecar,
} from "../src/sidecar.js";
import { SIDECAR_COUNT_CAP, SIDECAR_TTL_MS, SIDECAR_WINDOW } from "../src/limits.js";

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "codeq-sidecar-repo-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const lines = [];
  for (let i = 1; i <= 80; i += 1) {
    lines.push(`line_${i} token_${i} createSession`);
  }
  writeFileSync(join(root, "src", "app.ts"), `${lines.join("\n")}\n`);
  writeFileSync(
    join(root, "src", "entry.ts"),
    [
      "export function createSession() {",
      "  return boot();",
      "}",
      "export function boot() {",
      "  return 1;",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "callee.ts"),
    "export function send() {\n  return 2;\n}\n",
  );
  return root;
}

function dataBase() {
  return mkdtempSync(join(tmpdir(), "codeq-sidecar-data-"));
}

function withDataDir(dir, fn) {
  const prev = process.env.CODEQ_DATA_DIR;
  process.env.CODEQ_DATA_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CODEQ_DATA_DIR;
    else process.env.CODEQ_DATA_DIR = prev;
  }
}

test("sidecar dir is dataHome/sidecars, not world-readable tmp", () => {
  const dir = sidecarDir();
  assert.equal(dir, join(dataHome(), "sidecars"));
  assert.equal(dir.includes("/tmp/codeq-"), false);
  assert.equal(/\/tmp\/codeq-\S+\.md$/.test(dir), false);
});

test("grep ±40 writes a unique 0600 sidecar; find count 0-hit and empty do not", () => {
  const root = fixtureRepo();
  const base = dataBase();
  const hit = {
    path: "src/app.ts",
    line: 10,
    column: 1,
    text: "line_10 token_10 createSession",
  };

  const written = writeSidecar(
    {
      command: "grep",
      root,
      query: "createSession",
      excerpts: [grepExcerptWindow(hit)],
    },
    { base },
  );
  assert.ok(written);
  assert.equal(written.integrity, "complete");
  assert.equal(existsSync(written.path), true);
  assert.equal(written.path.startsWith(sidecarDir(base)), true);
  assert.equal(written.path.includes(root), false);
  const mode = statSync(written.path).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(statSync(sidecarDir(base)).mode & 0o777, 0o700);
  const again = writeSidecar(
    {
      command: "grep",
      root,
      query: "createSession",
      excerpts: [grepExcerptWindow(hit)],
    },
    { base },
  );
  assert.ok(again);
  assert.notEqual(again.path, written.path);
  const body = readFileSync(written.path, "utf8");
  assert.match(body, /^src\/app\.ts$/m);
  assert.match(body, /^src\/app\.ts:10 line_10 token_10 createSession$/m);
  assert.match(body, /^src\/app\.ts:1 /m);
  assert.match(body, /^src\/app\.ts:50 /m);
  assert.equal(body.includes("src/app.ts:51 "), false);
  assert.equal(body.includes("[fuzzy]"), false);
  assert.equal(/jev|noul|prod_shortlist/i.test(body), false);
  assert.equal(/verbatim|already Read/i.test(body), false);
  assert.match(sidecarTailLine(written), /^sidecar complete /);
  assert.equal(sidecarTailLine(written).includes("next:"), false);
  assert.equal(isSidecarTail(sidecarTailLine(written)), true);

  withDataDir(base, () => {
    const formatted = formatMcpToolResult("grep", {
      status: "ready",
      root,
      pattern: "createSession",
      mode: "plain",
      results: [hit],
    });
    const tail = formatted.text.trimEnd().split("\n").at(-1);
    assert.equal(isSidecarTail(tail), true);
    assert.match(tail, /^sidecar complete /);
    assert.equal(formatted.text.includes("next: Read"), false);
    assert.equal(formatted.text.includes(IDENTIFIER_GREP_LOCATED), true);
    assert.equal(
      formatted.text.includes(identifierGraphHook("createSession")),
      true,
    );
    const sidecarPath = tail.split(" ")[2];
    assert.equal(existsSync(sidecarPath), true);
    assert.equal(sidecarPath.startsWith(sidecarDir(base)), true);
    assert.match(formatted.text, /^src\/app\.ts:10 /m);
    assert.equal(formatted.text.includes("line_1 token_1"), false);

    const phrase = formatMcpToolResult("grep", {
      status: "ready",
      root,
      pattern: "line_10 token_10",
      mode: "plain",
      results: [hit],
    });
    assert.equal(phrase.text.includes("located."), false);
    assert.equal(isSidecarTail(phrase.text.trimEnd().split("\n").at(-1)), true);

    const count = formatMcpToolResult("grep", {
      status: "ready",
      root,
      pattern: "createSession",
      mode: "plain",
      count: true,
      matchCount: 12,
      fileCount: 1,
      results: [hit],
    });
    assert.equal(count.text.split("\n").some(isSidecarTail), false);

    const miss = formatMcpToolResult("grep", {
      status: "ready",
      root,
      pattern: "createSession",
      mode: "plain",
      results: [],
    });
    assert.equal(miss.text.split("\n").some(isSidecarTail), false);

    const found = formatMcpToolResult("find", {
      status: "ready",
      root,
      query: "app.ts",
      results: [{ path: "src/app.ts" }],
    });
    assert.equal(found.text.split("\n").some(isSidecarTail), false);
    assert.equal(found.text.includes(FIND_CONFIRM), true);
  });
});

test("exact graph sidecar is entry span only, not callers or callees", () => {
  const root = fixtureRepo();
  const base = dataBase();
  const formatted = withDataDir(base, () =>
    formatMcpToolResult("graph", {
      status: "ready",
      root,
      query: "createSession",
      result: "",
      symbols: [
        {
          name: "createSession",
          kind: "function",
          path: "src/entry.ts",
          startLine: 1,
          endLine: 3,
          callees: [
            { name: "send", path: "src/callee.ts", line: 1, endLine: 3 },
          ],
          callers: [{ name: "boot", path: "src/entry.ts", line: 4, endLine: 6 }],
        },
      ],
    }),
  );
  for (const line of GRAPH_LOCATED) {
    assert.equal(formatted.text.includes(line), true);
  }
  const tail = formatted.text.trimEnd().split("\n").at(-1);
  assert.equal(isSidecarTail(tail), true);
  assert.match(tail, /^sidecar complete /);
  const path = tail.split(" ")[2];
  assert.equal(path.startsWith(sidecarDir(base)), true);
  const body = readFileSync(path, "utf8");
  assert.match(body, /export function createSession/);
  assert.match(body, /return boot/);
  assert.equal(body.includes("src/callee.ts"), false);
  assert.equal(body.includes("export function send"), false);
  assert.equal(formatted.text.includes("export function createSession"), false);
  assert.equal(formatted.text.includes("next: Read"), false);

  const miss = formatMcpToolResult("graph", {
    status: "ready",
    root,
    query: "missing_identifier",
    result: "",
    symbols: [],
  });
  assert.equal(miss.text.split("\n").some(isSidecarTail), false);
  assert.equal(miss.text.includes("located."), false);
});

test("reliable span on grep uses the envelope instead of ±40", () => {
  const root = fixtureRepo();
  const base = dataBase();
  const written = writeSidecar(
    {
      command: "grep",
      root,
      query: "createSession",
      excerpts: [
        grepExcerptWindow({
          path: "src/entry.ts",
          line: 1,
          startLine: 1,
          endLine: 3,
        }),
      ],
    },
    { base },
  );
  assert.equal(written.integrity, "complete");
  const body = readFileSync(written.path, "utf8");
  assert.match(body, /^src\/entry\.ts:1 /m);
  assert.match(body, /^src\/entry\.ts:3 /m);
  assert.equal(body.includes("src/entry.ts:4 "), false);
});

test("sidecar caps omit honestly and mark partial", () => {
  const root = fixtureRepo();
  const base = dataBase();
  const hits = [10, 50].map((line) => ({
    path: "src/app.ts",
    start: line - SIDECAR_WINDOW,
    end: line + SIDECAR_WINDOW,
  }));
  const partial = writeSidecar(
    {
      command: "grep",
      root,
      query: "token",
      excerpts: hits,
    },
    { base, maxBytes: 400, fileMaxBytes: 200 },
  );
  assert.ok(partial);
  assert.equal(partial.integrity, "partial");
  const body = readFileSync(partial.path, "utf8");
  assert.match(body, /^omitted /m);
  assert.match(sidecarTailLine(partial), /^sidecar partial /);
  assert.match(
    sidecarTailLine(partial),
    /skip this file; at most one Read of the source span/,
  );
  assert.equal(sidecarTailLine(partial).includes("next:"), false);
});

test("fuzzy grep sidecar is labelled; context:N still prints on channel A", () => {
  const root = fixtureRepo();
  const base = dataBase();
  const hit = {
    path: "src/app.ts",
    line: 10,
    column: 1,
    text: "line_10 token_10 createSession",
    contextBefore: ["line_9 token_9 createSession"],
    contextAfter: ["line_11 token_11 createSession"],
  };
  withDataDir(base, () => {
    const fuzzy = formatMcpToolResult("grep", {
      status: "ready",
      root,
      pattern: "createSessian",
      mode: "fuzzy",
      results: [hit],
    });
    assert.equal(fuzzy.text.includes("located."), false);
    const fuzzyTail = fuzzy.text.trimEnd().split("\n").at(-1);
    assert.equal(isSidecarTail(fuzzyTail), true);
    const fuzzyPath = fuzzyTail.split(" ")[2];
    assert.equal(fuzzyPath.startsWith(sidecarDir(base)), true);
    const fuzzyBody = readFileSync(fuzzyPath, "utf8");
    assert.match(fuzzyBody, /^\[fuzzy\]$/m);

    const neighbors = formatMcpToolResult("grep", {
      status: "ready",
      root,
      pattern: "createSession",
      mode: "plain",
      context: 1,
      results: [hit],
    });
    assert.match(neighbors.text, /^src\/app\.ts:9 /m);
    assert.match(neighbors.text, /^src\/app\.ts:11 /m);
    assert.equal(isSidecarTail(neighbors.text.trimEnd().split("\n").at(-1)), true);
  });
});

test("TTL and count cap sweep leftover sidecars", () => {
  const base = dataBase();
  const dir = sidecarDir(base);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const old = join(dir, "old.txt");
  writeFileSync(old, "stale\n", { mode: 0o600 });
  const ancient = Date.now() / 1000 - SIDECAR_TTL_MS / 1000 - 60;
  utimesSync(old, ancient, ancient);
  sweepSidecars(base);
  assert.equal(existsSync(old), false);

  for (let i = 0; i < SIDECAR_COUNT_CAP + 5; i += 1) {
    const path = join(dir, `keep-${String(i).padStart(3, "0")}.txt`);
    writeFileSync(path, `n=${i}\n`, { mode: 0o600 });
    const stamp = Date.now() / 1000 - (SIDECAR_COUNT_CAP + 5 - i);
    utimesSync(path, stamp, stamp);
  }
  sweepSidecars(base);
  const remain = readdirSync(dir).filter((name) => name.startsWith("keep-"));
  assert.equal(remain.length, SIDECAR_COUNT_CAP);
});

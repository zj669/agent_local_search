import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  FIND_CAP,
  GREP_CAP,
  JEV_CANDIDATE_CAP,
  RANK_WINDOW,
  pageLimit,
} from "../src/limits.js";
import {
  applyFindWindow,
  applyGrepWindow,
  isDocsPath,
  isPreferredHit,
  pathTier,
  rankFindResults,
  rankGrepHits,
} from "../src/path-tier.js";

test("visible caps stay 16 and the rank window is 48", () => {
  assert.equal(RANK_WINDOW, 48);
  assert.equal(FIND_CAP, 16);
  assert.equal(GREP_CAP, 16);
  assert.equal(JEV_CANDIDATE_CAP, 16);
  assert.equal(pageLimit(4, FIND_CAP), 4);
  assert.equal(pageLimit(100, FIND_CAP), 16);
  assert.equal(pageLimit(undefined, GREP_CAP), 16);
  const src = readFileSync(
    fileURLToPath(new URL("../src/root-context.js", import.meta.url)),
    "utf8",
  );
  assert.equal((src.match(/pageSize: RANK_WINDOW/g) || []).length, 2);
  assert.equal(src.includes("pageLimit(options.limit, FIND_CAP)"), false);
  assert.equal(src.includes("pageLimit(options.limit, GREP_CAP)"), false);
});

test("isDocsPath matches doc segments and README names", () => {
  assert.equal(isDocsPath("docs/guide.md"), true);
  assert.equal(isDocsPath("doc/api.md"), true);
  assert.equal(isDocsPath("documentation/index.md"), true);
  assert.equal(isDocsPath("examples/foo.py"), true);
  assert.equal(isDocsPath("example/foo.py"), true);
  assert.equal(isDocsPath("samples/foo.py"), true);
  assert.equal(isDocsPath("sample/foo.py"), true);
  assert.equal(isDocsPath("tutorials/intro.md"), true);
  assert.equal(isDocsPath("tutorial/intro.md"), true);
  assert.equal(isDocsPath("README.md"), true);
  assert.equal(isDocsPath("readme.rst"), true);
  assert.equal(isDocsPath("src/README"), true);
  assert.equal(isDocsPath("src/pkg/foo.py"), false);
  assert.equal(isDocsPath("src/documentation.ts"), false);
  assert.equal(isDocsPath("src/examples.ts"), false);
});

test("pathTier demotes docs more than tests, production is 0", () => {
  assert.equal(pathTier("src/pkg/foo.py"), 0);
  assert.equal(pathTier("test/foo_test.py"), 1);
  assert.equal(pathTier("src/pkg/foo_test.py"), 1);
  assert.equal(pathTier("docs/foo.py"), 2);
  assert.equal(pathTier("test/README.md"), 2);
});

test("find ranking pins exact, then production over docs, without basename pin", () => {
  const ranked = rankFindResults([
    { path: "docs/widget.md", matchType: "fuzzy" },
    { path: "README.md", matchType: "fuzzy" },
    { path: "src/pkg/widget.py", matchType: "fuzzy" },
    { path: "src/pkg/other.py", matchType: "exact" },
    { path: "test/widget_test.py", matchType: "fuzzy" },
  ]);
  assert.deepEqual(
    ranked.map((item) => item.path),
    [
      "src/pkg/other.py",
      "src/pkg/widget.py",
      "test/widget_test.py",
      "docs/widget.md",
      "README.md",
    ],
  );

  const basename = rankFindResults([
    { path: "src/pkg/other.py", matchType: "fuzzy" },
    { path: "docs/foo.py", matchType: "fuzzy" },
  ]);
  assert.deepEqual(
    basename.map((item) => item.path),
    ["src/pkg/other.py", "docs/foo.py"],
  );
});

test("find window membership pulls production from beyond the visible 16", () => {
  const results = [
    ...Array.from({ length: 20 }, (_, i) => ({
      path: `docs/note${i}.md`,
      matchType: "fuzzy",
    })),
    { path: "src/pkg/needed.py", matchType: "fuzzy" },
  ];
  const ranked = rankFindResults(results);
  assert.equal(ranked.length, 21);
  assert.equal(
    ranked.some((item) => item.path === "docs/note0.md"),
    true,
  );
  const visible = applyFindWindow(results);
  assert.equal(visible.length, 16);
  assert.equal(visible[0].path, "src/pkg/needed.py");
  assert.equal(
    visible.some((item) => item.path.startsWith("docs/")),
    true,
  );
  assert.equal(
    applyFindWindow(results, 4)[0].path,
    "src/pkg/needed.py",
  );
});

test("grep ranks production files before tests and docs, preferred hits inside a file", () => {
  const hits = [
    { path: "README.md", line: 10, column: 1, text: "def foo():" },
    { path: "src/pkg/foo.py", line: 20, column: 5, text: "    return foo" },
    { path: "src/pkg/foo.py", line: 1, column: 5, text: "def foo():" },
    { path: "docs/guide.md", line: 3, column: 1, text: "foo in docs" },
    { path: "test/foo_test.py", line: 1, column: 5, text: "def foo():" },
  ];
  const ranked = rankGrepHits(hits, "foo");
  assert.deepEqual(
    ranked.map((hit) => `${hit.path}:${hit.line}`),
    [
      "src/pkg/foo.py:1",
      "src/pkg/foo.py:20",
      "test/foo_test.py:1",
      "README.md:10",
      "docs/guide.md:3",
    ],
  );
  assert.equal(isPreferredHit(hits[2], "foo"), true);
});

test("grep window membership keeps docs in the window and pages ranked 17+", () => {
  const hits = [
    ...Array.from({ length: 20 }, (_, i) => ({
      path: `docs/hit${i}.md`,
      line: 1,
      column: 1,
      text: "TOKEN",
    })),
    {
      path: "src/pkg/impl.py",
      line: 4,
      column: 1,
      text: "def TOKEN():",
    },
    ...Array.from({ length: 27 }, (_, i) => ({
      path: `docs/more${i}.md`,
      line: 1,
      column: 1,
      text: "TOKEN",
    })),
  ];
  assert.equal(hits.length, 48);
  const first = applyGrepWindow(hits, "TOKEN");
  assert.equal(first.ranked.length, 48);
  assert.equal(
    first.ranked.some((hit) => hit.path.startsWith("docs/")),
    true,
  );
  assert.equal(first.page.length, 16);
  assert.equal(first.page[0].path, "src/pkg/impl.py");
  assert.equal(
    first.page.some((hit) => hit.path === "src/pkg/impl.py"),
    true,
  );

  const second = applyGrepWindow(hits, "TOKEN", undefined, 16);
  assert.equal(second.page.length, 16);
  assert.equal(
    second.page.some((hit) => hit.path === "src/pkg/impl.py"),
    false,
  );
  assert.deepEqual(
    second.page.map((hit) => hit.path),
    first.ranked.slice(16, 32).map((hit) => hit.path),
  );
  assert.equal(
    second.page.every((hit) => hit.path.startsWith("docs/")),
    true,
  );
});

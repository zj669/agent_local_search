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
import { isTestPath } from "../src/graph-map.js";
import {
  applyFindWindow,
  applyGrepWindow,
  isConfigPath,
  isDocsPath,
  isPreferredHit,
  pathTier,
  rankFindResults,
  rankGrepHits,
} from "../src/path-tier.js";

function dumpFileRank(hits, pattern) {
  const groups = [];
  const index = new Map();
  for (const hit of hits || []) {
    if (!index.has(hit.path)) {
      index.set(hit.path, groups.length);
      groups.push({ path: hit.path, hits: [] });
    }
    groups[index.get(hit.path)].hits.push(hit);
  }
  groups.sort((a, b) => pathTier(a.path) - pathTier(b.path));
  const ordered = [];
  for (const group of groups) {
    const preferred = group.hits
      .filter((hit) => isPreferredHit(hit, pattern))
      .sort((a, b) => a.line - b.line);
    const rest = group.hits
      .filter((hit) => !isPreferredHit(hit, pattern))
      .sort((a, b) => a.line - b.line);
    ordered.push(...preferred, ...rest);
  }
  return ordered;
}

function hit(path, line, text = "TOKEN") {
  return { path, line, column: 1, text };
}

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
  assert.equal(isDocsPath(".agents/skills/x/SKILL.md"), true);
  assert.equal(isDocsPath(".agents/skills/x/SKILL"), true);
  assert.equal(isDocsPath("src/skills/encode.ts"), false);
  assert.equal(isDocsPath("src/skills/x.ts"), false);
});

test("isTestPath matches foo.test.ts without treating production files as tests", () => {
  assert.equal(isTestPath("library/src/actions/args/args.test.ts"), true);
  assert.equal(isTestPath("library/src/actions/args/args.test.js"), true);
  assert.equal(isTestPath("httpx/_auth.py"), false);
  assert.equal(isTestPath("tests/foo.py"), true);
  assert.equal(isTestPath("test/foo.py"), true);
  assert.equal(isTestPath("src/pkg/foo_test.py"), true);
  assert.equal(isTestPath("src/pkg/foo.spec.ts"), true);
  assert.equal(isTestPath("src/__tests__/foo.ts"), true);
  assert.equal(pathTier("src/skills/encode.ts"), 0);
  assert.equal(pathTier(".agents/skills/x/SKILL.md"), 3);
  assert.equal(pathTier("library/src/actions/args/args.test.ts"), 2);
});

test("pathTier demotes docs more than tests, production is 0", () => {
  assert.equal(pathTier("src/pkg/foo.py"), 0);
  assert.equal(pathTier("test/foo_test.py"), 2);
  assert.equal(pathTier("src/pkg/foo_test.py"), 2);
  assert.equal(pathTier("docs/foo.py"), 3);
  assert.equal(pathTier("docs/guide.md"), 3);
  assert.equal(pathTier("test/README.md"), 3);
  assert.equal(pathTier("foo.test.ts"), 2);
});

test("pathTier demotes config/CI below production and above tests", () => {
  assert.equal(pathTier(".github/workflows/ci.yml"), 1);
  assert.equal(pathTier("src/pkg/py.typed"), 1);
  assert.equal(pathTier(".browserslistrc"), 1);
  assert.equal(pathTier(".eleventy.js"), 1);
  assert.equal(pathTier("eslint.config.js"), 1);
  assert.equal(pathTier("karma.conf.js"), 1);
  assert.equal(pathTier(".eslintrc"), 1);
  assert.equal(pathTier(".circleci/config.yml"), 1);
  assert.equal(pathTier(".gitlab/ci.yml"), 1);
  assert.equal(isConfigPath(".gitlab/ci.yml"), true);

  assert.equal(pathTier("src/hidden/.eleventy.js"), 0);
  assert.equal(pathTier("src/config/load.py"), 0);
  assert.equal(pathTier("pkg/webpack.config.js"), 0);
  assert.equal(pathTier("src/pkg/foo.py"), 0);
  assert.equal(isConfigPath("src/hidden/.eleventy.js"), false);
  assert.equal(isConfigPath("src/config/load.py"), false);
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

  const withConfig = rankFindResults([
    { path: "docs/widget.md", matchType: "fuzzy" },
    { path: ".github/workflows/ci.yml", matchType: "fuzzy" },
    { path: "src/pkg/widget.py", matchType: "fuzzy" },
    { path: "eslint.config.js", matchType: "fuzzy" },
    { path: "test/widget_test.py", matchType: "fuzzy" },
  ]);
  assert.deepEqual(
    withConfig.map((item) => item.path),
    [
      "src/pkg/widget.py",
      ".github/workflows/ci.yml",
      "eslint.config.js",
      "test/widget_test.py",
      "docs/widget.md",
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

test("find vis16 membership pulls production ahead of a config/CI FFF page", () => {
  function legacyTier(filePath) {
    const docs = isDocsPath(filePath) ? 2 : 0;
    const test = isTestPath(filePath) ? 1 : 0;
    return Math.max(docs, test);
  }
  function legacyRank(items) {
    const exact = [];
    const rest = [];
    for (const item of items) {
      if (item.matchType === "exact") exact.push(item);
      else rest.push(item);
    }
    const restOrder = rest.map((item, index) => ({ item, index }));
    restOrder.sort((a, b) => {
      const tier = legacyTier(a.item.path) - legacyTier(b.item.path);
      if (tier) return tier;
      return a.index - b.index;
    });
    return [...exact, ...restOrder.map((entry) => entry.item)];
  }

  const configC = { path: ".github/workflows/ci.yml", matchType: "fuzzy" };
  const prodB = { path: "src/pkg/needed.py", matchType: "fuzzy" };
  const configs = [
    configC,
    { path: ".browserslistrc", matchType: "fuzzy" },
    { path: "src/pkg/py.typed", matchType: "fuzzy" },
    { path: ".eleventy.js", matchType: "fuzzy" },
    { path: "eslint.config.js", matchType: "fuzzy" },
    { path: ".eslintrc", matchType: "fuzzy" },
    { path: ".wallaby.js", matchType: "fuzzy" },
    { path: "karma.conf.js", matchType: "fuzzy" },
    ...Array.from({ length: 8 }, (_, i) => ({
      path: `.github/workflows/job${i}.yml`,
      matchType: "fuzzy",
    })),
  ];
  assert.equal(configs.length, 16);
  const filler = Array.from({ length: 31 }, (_, i) => ({
    path: `docs/note${i}.md`,
    matchType: "fuzzy",
  }));
  const window = [...configs, prodB, ...filler];
  assert.equal(window.length, 48);

  const legacyVisible = legacyRank(window).slice(0, 16);
  assert.equal(
    legacyVisible.some((item) => item.path === configC.path),
    true,
  );
  assert.equal(
    legacyVisible.some((item) => item.path === prodB.path),
    false,
  );

  const visible = applyFindWindow(window);
  assert.equal(visible.length, 16);
  assert.equal(
    visible.some((item) => item.path === prodB.path),
    true,
  );
  assert.equal(visible[0].path, prodB.path);
  assert.equal(
    rankFindResults(window).every(
      (item, index, list) =>
        index === 0 || pathTier(list[index - 1].path) <= pathTier(item.path),
    ),
    true,
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

test("same-tier grep round-robin pulls a later production file into vis16", () => {
  const hits = [
    ...Array.from({ length: 16 }, (_, i) => hit("src/pkg/crowded.py", i + 1)),
    hit("src/pkg/needed.py", 4, "def TOKEN():"),
    ...Array.from({ length: 31 }, (_, i) => hit(`src/pkg/other${i}.py`, 1)),
  ];
  assert.equal(hits.length, 48);
  const dumped = dumpFileRank(hits, "TOKEN");
  assert.equal(
    dumped.slice(0, 16).some((item) => item.path === "src/pkg/needed.py"),
    false,
  );
  const first = applyGrepWindow(hits, "TOKEN");
  assert.equal(first.ranked.length, 48);
  assert.equal(first.page.length, 16);
  assert.equal(
    first.page.some((item) => item.path === "src/pkg/needed.py"),
    true,
  );
  assert.equal(first.page[0].path, "src/pkg/crowded.py");
  assert.equal(first.page[1].path, "src/pkg/needed.py");
  assert.equal(
    first.page.filter((item) => item.path === "src/pkg/crowded.py").length,
    1,
  );
  assert.deepEqual(rankGrepHits(first.page, "TOKEN"), first.page);

  const second = applyGrepWindow(hits, "TOKEN", undefined, 16);
  assert.deepEqual(second.page, first.ranked.slice(16, 32));
  assert.notDeepEqual(
    second.page.map((item) => `${item.path}:${item.line}`),
    hits.slice(16, 32).map((item) => `${item.path}:${item.line}`),
  );
});

test("grep does not promote test files before a same-window production file is exhausted", () => {
  const prod = Array.from({ length: 9 }, (_, i) =>
    hit("src/pkg/impl.py", i + 1, i === 0 ? "def TOKEN():" : "TOKEN"),
  );
  const tests = Array.from({ length: 20 }, (_, i) =>
    hit("library/src/actions/args/args.test.ts", i + 1),
  );
  const docs = Array.from({ length: 19 }, (_, i) =>
    hit(".agents/skills/x/SKILL.md", i + 1),
  );
  const hits = [...tests, ...prod, ...docs];
  assert.equal(hits.length, 48);
  const { page, ranked } = applyGrepWindow(hits, "TOKEN");
  assert.equal(page.length, 16);
  assert.deepEqual(
    page.slice(0, 9).map((item) => item.path),
    Array(9).fill("src/pkg/impl.py"),
  );
  assert.equal(
    page.slice(9).every((item) => item.path.endsWith("args.test.ts")),
    true,
  );
  assert.equal(
    page.some((item) => item.path.includes("SKILL.md")),
    false,
  );
  const firstTest = ranked.findIndex((item) => item.path.endsWith("args.test.ts"));
  const lastProd = ranked.map((item) => item.path).lastIndexOf("src/pkg/impl.py");
  assert.ok(firstTest > lastProd);
});

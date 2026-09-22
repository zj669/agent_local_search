import assert from "node:assert/strict";
import test from "node:test";
import {
  extractCandidates,
  jevClientOptions,
  jevConfig,
  jevEnabled,
  JEV_TIMEOUT_MS,
  maybeRerank,
  prodShortlistSkip,
  rerank,
  skipReason,
} from "../src/jev.js";
import { formatMcpToolResult } from "../src/mcp-format.js";

const grepResult = {
  status: "ready",
  root: "/repo",
  pattern: "render_widget",
  mode: "plain",
  results: [
    {
      path: "src/pkg/foo_test.py",
      line: 8,
      column: 1,
      text: "def test_render_widget_includes_name():",
    },
    {
      path: "src/pkg/foo.py",
      line: 14,
      column: 1,
      text: "def render_widget(name, color, width=12):",
      contextBefore: ["", ""],
      contextAfter: [
        '    """Paint a named widget onto the canvas."""',
        "    boxed = layout(name, width)",
      ],
    },
    {
      path: "src/ui/widget.py",
      line: 9,
      column: 1,
      text: 'def render_widget(name, theme="gray"):',
    },
  ],
};

const prodGrepResult = {
  status: "ready",
  root: "/repo",
  pattern: "render_widget",
  mode: "plain",
  results: [
    {
      path: "src/pkg/foo.py",
      line: 14,
      column: 1,
      text: "def render_widget(name, color, width=12):",
    },
    {
      path: "src/ui/widget.py",
      line: 9,
      column: 1,
      text: 'def render_widget(name, theme="gray"):',
    },
    {
      path: "src/pkg/layout.py",
      line: 3,
      column: 1,
      text: "def render_widget_box():",
    },
  ],
};

function noulFor(state, questions) {
  const answers = {};
  for (const key of Object.keys(questions)) {
    const index = Number(key.slice(1));
    const anchors = Object.keys(state.hits);
    const anchor = anchors[index] || "";
    const impl = /foo\.py:14|widget\.py:9/.test(anchor);
    answers[key] = { type: "noul", noul: impl ? 0.9 : 0.08 };
  }
  return { model: "configured-model", answers, usage: { input_tokens: 1, output_tokens: 1 } };
}

test("Jev runs iff a key is configured", () => {
  assert.equal(jevEnabled({}), false);
  assert.equal(jevEnabled({ CODEQ_JEV: "1" }), false);
  assert.equal(jevEnabled({ TYPESAFE_API_KEY: "x" }), false);
  assert.equal(jevEnabled({ CODEQ_JEV_KEY: "   " }), false);
  assert.equal(jevEnabled({ CODEQ_JEV_KEY: "x" }), true);
  const configured = jevConfig({
    CODEQ_JEV_KEY: "x",
    CODEQ_JEV_URL: "https://jev.example.test",
    CODEQ_JEV_MODEL: "configured-model",
  });
  assert.equal(configured.url, "https://jev.example.test");
  assert.equal(configured.model, "configured-model");
  assert.equal(configured.timeoutMs, 800);
  assert.equal(JEV_TIMEOUT_MS, 800);
  const options = jevClientOptions({
    CODEQ_JEV_KEY: "x",
    CODEQ_JEV_URL: "https://jev.example.test",
    CODEQ_JEV_MODEL: "configured-model",
  });
  assert.equal(options.baseURL, "https://jev.example.test");
  assert.equal(options.defaultModel, "configured-model");
  assert.equal(options.timeout, 800);
  assert.equal(options.retry.maxRetries, 0);
});

test("maybeRerank is a no-op when disabled", async () => {
  const ranked = await maybeRerank("grep", { query: "render_widget" }, grepResult, {
    env: {},
    systemOne: async () => {
      throw new Error("should not call Jev");
    },
  });
  assert.deepEqual(ranked.results, grepResult.results);
  assert.deepEqual(ranked.jev, { applied: false, skipped: "no_key" });
});

test("zero and one hits skip Jev", async () => {
  const empty = { ...grepResult, results: [] };
  const once = { ...grepResult, results: grepResult.results.slice(0, 1) };
  const systemOne = async () => {
    throw new Error("should not call Jev");
  };
  assert.equal(await rerank("grep", { query: "render_widget" }, empty, { systemOne }), empty);
  assert.equal(await rerank("grep", { query: "render_widget" }, once, { systemOne }), once);
  const skipped = await maybeRerank("grep", { query: "render_widget" }, once, {
    env: { CODEQ_JEV_KEY: "x" },
    systemOne,
  });
  assert.equal(skipped.jev.skipped, "too_few");
});

test("rerank sorts grep hits by Noul and never drops one", async () => {
  const seen = [];
  const ranked = await rerank(
    "grep",
    { query: "how does render_widget work", command: "grep" },
    grepResult,
    {
      systemOne: async (payload) => {
        seen.push(payload);
        return noulFor(payload.state, payload.questions);
      },
    },
  );
  assert.equal(ranked.results.length, 3);
  assert.deepEqual(
    ranked.results.map((hit) => `${hit.path}:${hit.line}`),
    ["src/pkg/foo.py:14", "src/ui/widget.py:9", "src/pkg/foo_test.py:8"],
  );
  assert.equal(ranked.preserveOrder, true);
  const payload = seen[0];
  assert.equal(payload.state.request.tool, "grep");
  assert.equal(Object.keys(payload.questions).some((key) => key.startsWith("s")), false);
  assert.equal(Object.keys(payload.questions).some((key) => key.includes("choice")), false);
});

test("fail-open returns the engine page on Jev errors", async () => {
  const ranked = await maybeRerank(
    "grep",
    { query: "render_widget" },
    grepResult,
    {
      env: { CODEQ_JEV_KEY: "x" },
      systemOne: async () => {
        throw new Error("timeout");
      },
    },
  );
  assert.deepEqual(ranked.results, grepResult.results);
  assert.deepEqual(ranked.jev, { applied: false, skipped: "timeout" });
});

test("literal grep with a production vis16 skips the optional rerank", async () => {
  let called = 0;
  const systemOne = async () => {
    called += 1;
    throw new Error("should not call optional rerank");
  };
  assert.equal(prodShortlistSkip("grep", { query: "render_widget" }, prodGrepResult), true);
  const ranked = await maybeRerank("grep", { query: "render_widget" }, prodGrepResult, {
    env: { CODEQ_JEV_KEY: "x" },
    systemOne,
  });
  assert.equal(called, 0);
  assert.deepEqual(ranked.jev, { applied: false, skipped: "prod_shortlist" });
  assert.equal(ranked.preserveOrder, true);
  assert.deepEqual(ranked.results, prodGrepResult.results);
  const formatted = formatMcpToolResult("grep", ranked);
  assert.equal(/jev|noul|prod_shortlist|skipped/i.test(formatted.text), false);
});

test("no key is still no_key on a production vis16", async () => {
  const ranked = await maybeRerank("grep", { query: "render_widget" }, prodGrepResult, {
    env: {},
    systemOne: async () => {
      throw new Error("should not call optional rerank");
    },
  });
  assert.deepEqual(ranked.jev, { applied: false, skipped: "no_key" });
});

test("regex, fuzzy, find, and mixed-tier grep still call the optional rerank", async () => {
  const calls = [];
  const systemOne = async (payload) => {
    calls.push(payload.state.request.tool);
    const answers = {};
    for (const key of Object.keys(payload.questions)) {
      answers[key] = { type: "noul", noul: 0.1 };
    }
    return { answers };
  };
  const env = { CODEQ_JEV_KEY: "x" };

  await maybeRerank(
    "grep",
    { query: "render_widget", regex: true },
    { ...prodGrepResult, mode: "regex" },
    { env, systemOne },
  );
  await maybeRerank(
    "grep",
    { query: "render_widget", fuzzy: true },
    { ...prodGrepResult, mode: "fuzzy" },
    { env, systemOne },
  );
  await maybeRerank("grep", { query: "render_widget" }, grepResult, { env, systemOne });
  await maybeRerank(
    "find",
    { query: "foo.py" },
    {
      status: "ready",
      query: "foo.py",
      results: [
        { path: "src/pkg/foo.py", matchType: "exact" },
        { path: "src/pkg/other.py", matchType: "fuzzy" },
      ],
    },
    { env, systemOne },
  );

  assert.deepEqual(calls, ["grep", "grep", "grep", "find"]);
  assert.equal(prodShortlistSkip("grep", { regex: true }, { ...prodGrepResult, mode: "regex" }), false);
  assert.equal(
    prodShortlistSkip("grep", { query: "render_widget" }, grepResult),
    false,
  );
  assert.equal(prodShortlistSkip("find", { query: "foo.py" }, prodGrepResult), false);
  assert.equal(
    prodShortlistSkip(
      "grep",
      { query: "render_widget" },
      {
        mode: "plain",
        results: [
          { path: "src/pkg/foo.py", line: 1, column: 1, text: "def render_widget():" },
          {
            path: "library/src/actions/args/args.test.ts",
            line: 11,
            column: 1,
            text: "render_widget()",
          },
        ],
      },
    ),
    false,
  );
});

test("skipReason maps HTTP and timeouts", () => {
  assert.equal(skipReason({ status: 401 }), "http_4xx");
  assert.equal(skipReason({ status: 503 }), "http_5xx");
  assert.equal(skipReason({ message: "Request timed out" }), "timeout");
});

test("find pins exact path matches above Noul", async () => {
  const result = {
    status: "ready",
    query: "foo.py",
    results: [
      { path: "src/pkg/foo_test.py", matchType: "prefix" },
      { path: "src/pkg/foo.py", matchType: "exact" },
      { path: "src/pkg/other.py", matchType: "fuzzy" },
    ],
  };
  const ranked = await rerank("find", { query: "foo.py" }, result, {
    systemOne: async (payload) => {
      assert.equal(payload.state.hits["src/pkg/foo.py"].matchType, "exact");
      const answers = {};
      for (const key of Object.keys(payload.questions)) {
        answers[key] = {
          type: "noul",
          noul: payload.state.hits[Object.keys(payload.state.hits)[Number(key.slice(1))]]
            ?.path === "src/pkg/other.py"
            ? 0.99
            : 0.1,
        };
      }
      return { answers };
    },
  });
  assert.equal(ranked.results[0].path, "src/pkg/foo.py");
  assert.equal(ranked.results[0].matchType, "exact");
  assert.deepEqual(
    ranked.results.map((item) => item.path),
    ["src/pkg/foo.py", "src/pkg/other.py", "src/pkg/foo_test.py"],
  );
});

test("grep preserveOrder keeps Jev sequence on the map", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "render_widget",
    mode: "plain",
    preserveOrder: true,
    results: [
      {
        path: "src/pkg/foo.py",
        line: 14,
        column: 1,
        text: "def render_widget(name, color, width=12):",
      },
      {
        path: "src/pkg/foo_test.py",
        line: 8,
        column: 1,
        text: "def test_render_widget_includes_name():",
      },
    ],
  });
  const defAt = formatted.text.indexOf("src/pkg/foo.py:14");
  const testAt = formatted.text.indexOf("src/pkg/foo_test.py:8");
  assert.ok(defAt > 0 && testAt > defAt, formatted.text);
  assert.equal(formatted.text.includes("Jev"), false);
  assert.equal(formatted.text.includes("noul"), false);
});

test("graph candidates are entry spans and callees, not files", () => {
  const dump = [
    "Found 2 symbols across 2 files.",
    "",
    "- `render_widget` (src/pkg/foo.py:14) — 1 caller",
    "",
    "**`src/pkg/foo.py`** — render_widget(function)",
    "",
    "```python",
    "14\tdef render_widget():",
    "```",
  ].join("\n");
  const result = {
    status: "ready",
    root: "/repo",
    query: "how does render_widget work",
    result: dump,
    symbols: [
      {
        name: "render_widget",
        kind: "function",
        path: "src/pkg/foo.py",
        startLine: 14,
        endLine: 22,
        callees: [{ name: "layout", path: "src/pkg/layout.py", line: 1, endLine: 2 }],
      },
    ],
  };
  const candidates = extractCandidates("graph", { query: result.query }, result);
  assert.deepEqual(
    candidates.map((item) => item.kind),
    ["entry", "callee"],
  );
  assert.equal(candidates[0].pinned, true);
  assert.equal(candidates[0].anchor, "src/pkg/foo.py:14");
  assert.equal(candidates[1].anchor, "src/pkg/layout.py:1");
});

test("graph candidates include callers after callees", () => {
  const dump = [
    "Found 1 symbols across 1 files.",
    "",
    "- `render_widget` (src/pkg/foo.py:14) — 1 caller",
    "",
    "**`src/pkg/foo.py`** — render_widget(function)",
  ].join("\n");
  const result = {
    status: "ready",
    root: "/repo",
    query: "how does render_widget work",
    result: dump,
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
  const candidates = extractCandidates("graph", { query: result.query }, result);
  assert.deepEqual(
    candidates.map((item) => item.kind),
    ["entry", "callee", "caller"],
  );
  assert.equal(candidates[2].anchor, "src/pkg/widget.py:25");
  assert.equal(candidates.length <= 16, true);
});

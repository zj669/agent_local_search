const GRAPH_SUMMARY_CHARS = 4_000;
const SOURCE_PATH =
  /(?:^|[\s`"'()[\]])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w.-]*)/g;

export const MCP_INSTRUCTIONS = `codeq is local find, grep, and graph for one repository at a time. Indexes are created automatically on first use. Never ask the user to init, never write a .codegraph directory into the project, and never merge results across repositories.

When to use which tool:
- graph: how code works, a symbol, callers, callees, impact, or "where is X used". One call is enough — explore already includes related files, call paths, and blast radius. There is no callers tool.
- find: file names and paths.
- grep: file contents. Patterns may be literal or regex (auto-detected). All-match patterns like .* are rejected. Prefer a concrete identifier.

Indexing starts on tools/call, never on initialize or tools/list. Prefer roots/list when the client gives a real project folder (not $HOME or /); otherwise use process.cwd() if that is a project. If the server was spawned from $HOME, pass path or root on the call. Pass path or root to search a different repository. Each call uses exactly one root.

Default replies start with a freshness line, then a short summary and paths. Pass detail: "full" when you need complete match text or the full graph dump. If truncated is true, more remains — request detail "full" instead of guessing.`;

export function freshnessLine(result = {}) {
  const status = result.status || "unknown";
  const parts = [`[${status}]`];
  if (result.root) parts.push(`root ${result.root}`);
  if (result.lastSuccessfulSync) {
    parts.push(`lastSuccessfulSync ${result.lastSuccessfulSync}`);
  }
  if (result.warning) parts.push(`warning ${result.warning}`);
  return parts.join(" ");
}

export function parseMcpToolText(text) {
  const newline = String(text).indexOf("\n");
  const body = newline >= 0 ? String(text).slice(newline + 1) : String(text);
  return JSON.parse(body);
}

function uniquePaths(values) {
  const seen = new Set();
  const paths = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    paths.push(value);
  }
  return paths;
}

function extractSourcePaths(text) {
  const paths = [];
  SOURCE_PATH.lastIndex = 0;
  let match;
  while ((match = SOURCE_PATH.exec(text))) {
    paths.push(match[1]);
  }
  return uniquePaths(paths);
}

function freshnessFields(command, result) {
  return {
    status: result.status ?? null,
    warning: result.warning ?? null,
    lastSuccessfulSync: result.lastSuccessfulSync ?? null,
    root: result.root ?? null,
    command,
  };
}

export function formatMcpToolResult(command, result, { detail = "summary" } = {}) {
  const full = detail === "full";
  let extra;

  if (command === "find") {
    const results = result.results || [];
    extra = {
      total: result.total ?? results.length,
      paths: uniquePaths(results.map((item) => item.path)),
      results: full ? results : results.map((item) => ({ path: item.path })),
    };
  } else if (command === "grep") {
    const results = result.results || [];
    extra = {
      total: result.total ?? results.length,
      mode: result.mode ?? null,
      fuzzyFallback: Boolean(result.fuzzyFallback),
      paths: uniquePaths(results.map((item) => item.path)),
      results: full
        ? results
        : results.map((item) => ({
            path: item.path,
            line: item.line,
            column: item.column,
            text: item.text,
          })),
    };
  } else {
    const text = String(result.result ?? "").trimEnd();
    const paths = extractSourcePaths(text);
    if (full || text.length <= GRAPH_SUMMARY_CHARS) {
      extra = {
        query: result.query,
        paths,
        truncated: false,
        result: text,
      };
    } else {
      extra = {
        query: result.query,
        paths,
        truncated: true,
        hint: 'Pass detail: "full" for the complete graph dump.',
        summary: `${text.slice(0, GRAPH_SUMMARY_CHARS).trimEnd()}\n…`,
      };
    }
  }

  const payload = { ...freshnessFields(command, result), ...extra };
  return {
    payload,
    text: `${freshnessLine(result)}\n${JSON.stringify(payload, null, 2)}`,
  };
}

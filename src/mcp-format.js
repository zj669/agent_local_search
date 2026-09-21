const GRAPH_SUMMARY_CHARS = 4_000;
const SOURCE_PATH =
  /(?:^|[\s`"'()[\]])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w.-]*)/g;

export const MCP_INSTRUCTIONS = `codeq is local find, grep, and graph for one repository at a time. Indexes are created automatically on first use. Never ask the user to init, never write a .codegraph directory into the project, and never merge results across repositories.

When to use which tool:
- graph: how code works, a symbol, callers, callees, impact, or "where is X used". Query with identifiers, or "how does X work" where X is identifiers — not a multi-paragraph question. One call is enough — explore already includes related files, call paths, and blast radius. There is no callers tool. graph returns a map of the code to read next, not a written answer.
- find: file names and paths, matched fuzzily, including dotfiles and dot-directories such as .claude/skills and .cursor/rules. Not a glob: **/*profile* matches nothing, pass profile.
- grep: file contents. One identifier or one regex per call (regex is auto-detected). All-match patterns like .* are rejected.

Indexing starts on tools/call, never on initialize or tools/list. Prefer roots/list when the client gives a real project folder (not $HOME or /); otherwise use process.cwd() if that is a project. If the server was spawned from $HOME, pass path or root on the call. Each call uses exactly one root.

root and path are not interchangeable. root is the repository, checkout, or worktree to search: pass it whenever the question is about a repository other than the session cwd. path narrows inside that repository and takes a directory or a single file. A subdirectory passed as root builds a second index of that subdirectory instead of narrowing, and a file passed as root falls back to the repository holding it; both cases say so in the reply.

Every reply names the resolved absolute root and where it came from: "root <abs> via root argument", "via path argument", or "via cwd (roots/list | spawn cwd | cwd argument | shell cwd)", followed by a parenthesised note when root was not a repository checkout. Read that line. When the root is not the repository you asked about — the usual cause is omitting root while working across two repositories — retry the same call with root set to that repository instead of interpreting the result.

Default replies start with that line, then a short summary and paths, which is enough to choose files to open. Pass detail: "full" only when you need complete match text or the full graph dump. If truncated is true, more remains — request detail "full" instead of guessing.`;

export function rootOrigin(result = {}) {
  if (result.rootSource === "root") return "root argument";
  if (result.rootSource === "path") return "path argument";
  if (result.rootSource !== "cwd") return null;
  return result.cwdSource ? `cwd (${result.cwdSource})` : "cwd";
}

export function freshnessLine(result = {}) {
  const status = result.status || "unknown";
  const parts = [`[${status}]`];
  if (result.root) {
    const origin = rootOrigin(result);
    parts.push(`root ${result.root}${origin ? ` via ${origin}` : ""}`);
    if (result.rootNote) parts.push(`(${result.rootNote})`);
  }
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
    rootSource: result.rootSource ?? null,
    rootNote: result.rootNote ?? null,
    cwdSource: result.cwdSource ?? null,
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

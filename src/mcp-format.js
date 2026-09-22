import {
  neighborhood,
  symbolLabel,
} from "./graph-map.js";
import {
  CALLEE_CAP,
  FIND_CAP,
  GREP_CAP,
  MATCH_TEXT_CHARS,
} from "./limits.js";

export const MCP_INSTRUCTIONS = `codeq is local find, grep, and graph for one repository at a time. Indexes are created automatically on first use. Never ask the user to init, never write a .codegraph directory into the project, and never merge results across repositories.

When to use which tool:
- graph: how code works, a symbol, callers, callees, impact, or "where is X used". Also use graph for call chains and pipelines (for example tracing which functions a request passes through from an entry handler): once you know one entry symbol from a single grep, query graph with identifiers or "how does X work" where X is that symbol — not a multi-paragraph question. graph returns the recommended reading entries (the query symbol's own span when it hits, otherwise an engine-selected span) and its direct callees with file:line for each hop. Prefer it over Bash or repeated grep for the next hop. One call is enough. There is no callers tool. graph returns a map of the code to read next, not a written answer, and never source.
- find: file names and paths, matched fuzzily, including dotfiles and dot-directories such as .claude/skills and .cursor/rules. Not a glob: **/*profile* matches nothing, pass profile.
- grep: file contents. Default matching is a literal string, not rg and not a regular expression. Pass regex: true for a regular expression. All-match patterns like .* are rejected when regex is on. Zero hits means zero hits. Pass fuzzy: true to also accept approximate names; those replies are labelled [fuzzy] and name DIFFERENT identifiers.

Indexing starts on tools/call, never on initialize or tools/list. Prefer roots/list when the client gives a real project folder (not $HOME or /); otherwise use process.cwd() if that is a project. If the server was spawned from $HOME, pass path or root on the call. Each call uses exactly one root.

root and path are not interchangeable. An explicit root overrides Git/cwd detection for this call. If you omit root, the session cwd (and Git worktree detection) selects the index — that is the wrong tree when the question is about another repository. path narrows that one call inside the selected repository and takes a directory or a single file; it never builds or switches an index. A relative path is joined to the selected root, not to the session cwd, and a path that does not exist is an error naming the absolute path that was tried — never a silent whole-repository search. A subdirectory or file passed as root resolves to the repository that holds it, narrowed to that subdirectory or file; the reply's first line says so.

Every reply names the resolved absolute root and where it came from: "root <abs> via root argument", "via path argument", or "via cwd (roots/list | spawn cwd | cwd argument | shell cwd)", followed by a parenthesised note when root was not a repository checkout. Read that line. When the root is not the repository you asked about — the usual cause is omitting root while working across two repositories — retry the same call with root set to that repository instead of interpreting the result.

Replies are locators: the first line, then a short map of where to Read next. graph is the query symbol's own span plus about 8 direct callees. grep is matching lines. find is paths. None of them return source. Read the named span with your own Read. When a reply is truncated it says so, and for grep it gives an opaque cursor bound to that same search.`;

export function rootOrigin(result = {}) {
  if (result.rootSource === "root") return "root argument";
  if (result.rootSource === "path") return "path argument";
  if (result.rootSource !== "cwd") return null;
  return result.cwdSource ? `cwd (${result.cwdSource})` : "cwd";
}

export function freshnessLine(result = {}) {
  const status = result.status || "unknown";
  const parts = [`[${status}]${result.mode === "fuzzy" ? "[fuzzy]" : ""}`];
  if (result.root) {
    const origin = rootOrigin(result);
    parts.push(`root ${result.root}${origin ? ` via ${origin}` : ""}`);
    if (result.rootNote) parts.push(`(${result.rootNote})`);
  }
  if (status === "degraded" || status === "indexing") {
    if (result.lastSuccessfulSync) {
      parts.push(`lastSuccessfulSync ${result.lastSuccessfulSync}`);
    }
    if (result.warning) parts.push(`warning ${result.warning}`);
  }
  return parts.join(" ");
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

function locatorFields(result, truncated) {
  return {
    status: result.status ?? null,
    root: result.root ?? null,
    truncated: Boolean(truncated),
  };
}

function clampText(text) {
  const trimmed = String(text ?? "").trimStart().trimEnd();
  if (trimmed.length <= MATCH_TEXT_CHARS) return trimmed;
  return `${trimmed.slice(0, MATCH_TEXT_CHARS)}…`;
}

function countFiles(items) {
  return new Set(items.map((item) => item.path)).size;
}

function hasGlobSyntax(query) {
  return /\*|\?\?|\[[^\]]+\]/.test(String(query || ""));
}

function literalFragment(query) {
  const segments = String(query || "")
    .split("/")
    .map((segment) => segment.replace(/[*?[\]]/g, ""))
    .filter(Boolean);
  return segments[segments.length - 1] || "the name";
}

function identifierAt(text, column) {
  const line = String(text ?? "");
  const index = Math.max(0, Math.min(line.length - 1, (column || 1) - 1));
  if (!/[A-Za-z0-9_$]/.test(line[index] || "")) return null;
  let start = index;
  let end = index;
  while (start > 0 && /[A-Za-z0-9_$]/.test(line[start - 1])) start -= 1;
  while (end < line.length - 1 && /[A-Za-z0-9_$]/.test(line[end + 1])) end += 1;
  return line.slice(start, end + 1);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPreferredHit(hit, pattern) {
  const raw = String(hit.text ?? "");
  const text = raw.trim();
  const at = identifierAt(raw, hit.column);
  const ident = at || (!/[.*+?^${}()|[\]\\]/.test(pattern) ? pattern : null);
  if (!ident) {
    return /^(?:export\s+)?(?:async\s+)?(?:def|function|func|fn|class|const|let|var|val|interface|struct|type|enum)\b/.test(
      text,
    );
  }
  const name = escapeRegExp(ident);
  if (
    new RegExp(
      `(?:^|\\s)(?:async\\s+)?(?:def|function|func|fn|fun|class|interface|struct|trait|type|enum|const|let|var|val)\\s+${name}\\b`,
    ).test(text)
  ) {
    return true;
  }
  if (new RegExp(`(?:^|[^\\w$])${name}\\s*=(?!=)`).test(text)) return true;
  if (new RegExp(`(?:^|[^\\w$])${name}\\s*:(?!:)`).test(text)) return true;
  return false;
}

function orderGrepHits(hits, pattern, preserveOrder) {
  if (preserveOrder) return hits;
  const preferred = [];
  const rest = [];
  for (const hit of hits) {
    if (isPreferredHit(hit, pattern)) preferred.push(hit);
    else rest.push(hit);
  }
  if (preferred.length === 0) return hits;
  return [...preferred, ...rest];
}

function appendHit(lines, hit) {
  lines.push(`${hit.path}:${hit.line}:${hit.column} ${clampText(hit.text)}`);
}

function appendGroupedHits(lines, hits) {
  const groups = [];
  const index = new Map();
  for (const hit of hits) {
    if (!index.has(hit.path)) {
      index.set(hit.path, groups.length);
      groups.push({ path: hit.path, hits: [] });
    }
    groups[index.get(hit.path)].hits.push(hit);
  }
  const many = groups.length > 1;
  for (const group of groups) {
    if (many) lines.push(group.path);
    for (const hit of group.hits) appendHit(lines, hit);
  }
}

function fuzzyNames(hits, pattern) {
  const names = [];
  const seen = new Set();
  for (const hit of hits) {
    const name = identifierAt(hit.text, hit.column);
    if (!name || name === pattern || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length === 3) break;
  }
  return names;
}

function pinExactFind(results) {
  const exact = [];
  const rest = [];
  for (const item of results || []) {
    if (item.matchType === "exact") exact.push(item);
    else rest.push(item);
  }
  return [...exact, ...rest];
}

function formatFind(result) {
  const results = pinExactFind(result.results).slice(0, FIND_CAP);
  const query = result.query ?? "";
  const shown = results.length;
  const matched = result.total ?? shown;
  const truncated = shown < matched;
  const lines = [];

  lines.push(
    truncated
      ? `find ${query} — ${shown} shown, ${matched} matched`
      : `find ${query} — ${shown} match${shown === 1 ? "" : "es"}`,
  );
  if (shown > 0) {
    lines.push("");
    for (const item of results) lines.push(item.path);
  }
  if (truncated) {
    lines.push("", "more: refine the path fragment. this page is capped at 16.");
  }
  if (hasGlobSyntax(query)) {
    lines.push(
      "",
      `find is a fuzzy path fragment, not a glob: drop the **/ and pass ${literalFragment(
        query,
      )}.`,
    );
  }

  return {
    lines,
    truncated,
    structured: {
      paths: uniquePaths(results.map((item) => item.path)),
    },
  };
}

function formatGrep(result) {
  const hits = (result.results || []).slice(0, GREP_CAP);
  const pattern = result.pattern ?? "";
  const mode = result.mode ?? "plain";
  const fuzzy = mode === "fuzzy";
  const nextCursor = result.nextCursor || null;
  const truncated = Boolean(nextCursor);
  const preserveOrder = Boolean(result.preserveOrder);
  const display = orderGrepHits(hits, pattern, preserveOrder);
  const lines = [];

  if (fuzzy) {
    lines.push(
      `grep ${pattern} — 0 exact matches; ${hits.length} fuzzy match${
        hits.length === 1 ? "" : "es"
      }, DIFFERENT identifiers`,
    );
  } else if (hits.length === 0) {
    lines.push(`grep ${pattern} — 0 matches`);
  } else if (truncated) {
    lines.push(
      `grep ${pattern} — ${hits.length} shown, more remain`,
    );
  } else {
    lines.push(
      `grep ${pattern} — ${hits.length} match${hits.length === 1 ? "" : "es"} in ${countFiles(
        hits,
      )} file${countFiles(hits) === 1 ? "" : "s"}`,
    );
  }

  if (display.length > 0) {
    lines.push("");
    appendGroupedHits(lines, display);
  }

  if (fuzzy) {
    const names = fuzzyNames(hits, pattern);
    lines.push(
      "",
      names.length > 0
        ? `matched name: ${names.join(", ")} (not ${pattern}). confirm the spelling before concluding.`
        : `these are approximate matches, not ${pattern}. confirm the spelling before concluding.`,
    );
  } else if (hits.length === 0) {
    lines.push("");
    if (result.fuzzyRequested) {
      lines.push(
        "nothing in this repository matches that pattern, exact or fuzzy.",
        result.regex
          ? "check the root above if you meant another repository."
          : "if you meant a regular expression, pass regex: true, or check the root above if you meant another repository.",
      );
    } else {
      lines.push(
        "nothing in this repository contains that pattern. next: pass regex: true if you meant a regular expression (this is not rg),",
        "or fuzzy: true for approximate names (they will be labelled [fuzzy] and are NOT the same identifier), or check the root above if you meant another repository.",
      );
    }
  } else if (truncated && nextCursor) {
    lines.push(
      "",
      `more: pass cursor on the same grep (same root, pattern, glob, path, regex, fuzzy). cursor=${nextCursor}`,
    );
  }

  return {
    lines,
    truncated,
    structured: {
      hits: display.map((hit) => ({
        path: hit.path,
        line: hit.line,
        column: hit.column,
        text: clampText(hit.text),
      })),
      ...(nextCursor ? { nextCursor } : {}),
    },
  };
}

function spanRange(span) {
  const end = span.endLine || span.startLine;
  return end !== span.startLine ? `${span.startLine}-${end}` : `${span.startLine}`;
}

function formatCallee(callee) {
  const oneLine =
    callee.text &&
    callee.endLine === callee.line &&
    !String(callee.text).includes("\n");
  return `- ${callee.name} (${callee.path}:${callee.line})${
    oneLine ? ` ${clampText(callee.text)}` : ""
  }`;
}

function formatGraph(result) {
  const map = neighborhood(result);
  const { dump, identifiers, hits, entries, callees, hiddenCallees } = map;
  const query = result.query ?? "";
  const truncated = hiddenCallees.length > 0;
  const scale =
    dump.symbolCount != null && dump.fileCount != null
      ? `${dump.symbolCount} symbol${
          dump.symbolCount === 1 ? "" : "s"
        } in ${dump.fileCount} file${dump.fileCount === 1 ? "" : "s"}`
      : `${dump.files.length} file${dump.files.length === 1 ? "" : "s"}`;
  const lines = [];

  if (hits.length > 0) {
    lines.push(
      `graph "${query}" — ${scale}, exact hit${
        hits.length === 1 ? "" : "s"
      } on ${hits.map((hit) => hit.symbol).join(", ")}`,
    );
  } else {
    lines.push(
      `graph "${query}" — ${scale}, NO exact hit on ${
        identifiers.join(", ") || query
      }`,
    );
    const ranked = dump.blast
      .slice(0, 3)
      .map((entry) => entry.name)
      .concat(
        dump.blast.length === 0
          ? dump.files.flatMap((file) => file.symbols.slice(0, 1).map((s) => s.name))
          : [],
      )
      .slice(0, 3);
    if (ranked.length > 0) {
      lines.push(
        `engine ranked these instead: ${ranked.join(
          ", ",
        )}. Narrow with path=, or grep the exact name.`,
      );
    }
  }

  if (entries.length > 0) {
    lines.push("");
    for (const entry of entries) {
      lines.push(`hit: ${entry.symbol} — ${entry.path}:${spanRange(entry)}`);
    }
    lines.push("");
    lines.push(`open these files (${entries.length})`);
    entries.forEach((entry, index) => {
      lines.push(
        `${index + 1}. ${entry.path}:${spanRange(entry)} — ${symbolLabel({
          name: entry.symbol,
          kind: entry.kind,
        })}`,
      );
    });
  } else {
    lines.push("");
    lines.push(
      "open these files (0) — the engine rendered no file section for this query.",
      "narrow with path=, or query the exact identifier.",
    );
  }

  if (callees.length > 0) {
    lines.push("", "calls (direct)");
    for (const callee of callees) lines.push(formatCallee(callee));
    if (hiddenCallees.length > 0) {
      lines.push(
        `truncated: ${hiddenCallees.length} more direct callee${
          hiddenCallees.length === 1 ? "" : "s"
        } not listed. this is a bounded neighborhood, not an exhaustive callgraph.`,
      );
    }
  }

  if (identifiers.length >= 3) {
    lines.push(
      "",
      `this query names ${identifiers.length} topics (${identifiers.join(
        ", ",
      )}), so this map is wider than one symbol.`,
    );
  }

  return {
    lines,
    truncated,
    structured: {
      entries: entries.map((entry) => ({
        symbol: entry.symbol,
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine || entry.startLine,
        ...(entry.kind ? { kind: entry.kind } : {}),
      })),
      callees: callees.map((callee) => ({
        name: callee.name,
        path: callee.path,
        line: callee.line,
        ...(callee.endLine ? { endLine: callee.endLine } : {}),
      })),
    },
  };
}

export function formatMcpToolResult(command, result) {
  const formatted =
    command === "find"
      ? formatFind(result)
      : command === "grep"
        ? formatGrep(result)
        : formatGraph(result);

  const first = freshnessLine(result);
  return {
    firstLine: first,
    map: formatted.lines.join("\n"),
    text: `${first}\n${formatted.lines.join("\n")}`,
    structuredContent: {
      ...locatorFields(result, formatted.truncated),
      ...formatted.structured,
    },
  };
}

export { CALLEE_CAP, FIND_CAP, GREP_CAP };

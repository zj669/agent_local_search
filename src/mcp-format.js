import { hasGlobSyntax, literalFragment } from "./find-glob.js";
import { neighborhood } from "./graph-map.js";
import {
  CALLEE_CAP,
  CALLER_CAP,
  CONTEXT_CAP,
  COUNT_SCAN_CAP,
  FIND_CAP,
  GREP_CAP,
  MATCH_TEXT_CHARS,
  RANK_WINDOW,
} from "./limits.js";
import { identifierAt, rankFindResults, rankGrepHits } from "./path-tier.js";

export const MCP_INSTRUCTIONS = `codeq is local find, grep, and graph for one repository at a time. Indexes are created automatically on first use. Never ask the user to init, never write a .codegraph directory into the project, and never merge results across repositories.

Indexing starts on tools/call, never on initialize or tools/list. Prefer roots/list when the client gives a real project folder (not $HOME or /); otherwise use process.cwd() if that is a project. If the server was spawned from $HOME, pass path or root on the call. Each call uses exactly one root.

path only narrows this call inside the selected root; it never builds or switches an index. Pass root for another repository, checkout, or worktree.

Every reply's first line names the resolved absolute root and via (root argument, path argument, or cwd-derived). Read that line. When the root is not the repository you asked about — the usual cause is omitting root while working across two repositories — retry the same call with root set to that repository instead of interpreting the result.

Replies are locators. Read source with the host Read tool.`;

export const EMPTY_TOOL_MENU = `codeq needs find.query, grep.pattern, or graph.query — do not call with {}.
find: path fragment (not a glob, not "a or b").
grep: literal token; regex:true only for a real regexp (| or groups).
graph: one identifier (callers/callees/how-it-works). Then host Read the spans.`;

export function rootOrigin(result = {}) {
  if (result.rootSource === "root") return "root argument";
  if (result.rootSource === "path") return "path argument";
  if (result.rootSource !== "cwd") return null;
  return result.cwdSource ? `cwd:${result.cwdSource}` : "cwd";
}

function scopeNote(result) {
  const note = result.rootNote;
  if (!note) return "";
  const file = note.match(/root named a file[\s\S]*?narrowed to (\S+)/);
  if (file) {
    return `; scope ${file[1].replace(/;$/, "")} (file-as-root; use path)`;
  }
  const sub = note.match(/root named a subdirectory[\s\S]*?narrowed to (\S+)/);
  if (sub) {
    return `; scope ${sub[1].replace(/;$/, "")} (subdir-as-root; use path)`;
  }
  return `; ${note}`;
}

export function freshnessLine(result = {}) {
  const status = result.status || "unknown";
  const parts = [`[${status}]${result.mode === "fuzzy" ? "[fuzzy]" : ""}`];
  if (result.root) {
    const origin = rootOrigin(result);
    parts.push(
      `root ${result.root}${origin ? ` via ${origin}` : ""}${scopeNote(result)}`,
    );
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

const UNESCAPED_ALTERNATION_OR_GROUP = /(?:^|[^\\])(?:\\\\)*[|()]/;

function hasUnescapedAlternationOrGroup(pattern) {
  return UNESCAPED_ALTERNATION_OR_GROUP.test(String(pattern || ""));
}

function looksLikeRegexWildcards(pattern) {
  const text = String(pattern || "");
  return /\.\*|\.\+/.test(text) || hasUnescapedAlternationOrGroup(text);
}

function isIdentifierPattern(pattern) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(pattern || "").trim());
}

function findBooleanOrHint(query) {
  const text = String(query ?? "");
  if (!/\bor\b/.test(text)) return null;
  const parts = text
    .split(/\bor\b/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return 'find is not boolean; use two find calls, not "a or b".';
  }
  return `find is not boolean; search ${parts
    .map((part) => `"${part}"`)
    .join(" and ")} as two find calls.`;
}

function orderGrepHits(hits, pattern, preserveOrder) {
  if (preserveOrder) return hits;
  return rankGrepHits(hits, pattern);
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

function orderFindResults(results, preserveOrder) {
  if (preserveOrder) return results || [];
  return rankFindResults(results);
}

function shortFindFragment(query) {
  const text = String(query ?? "").trim();
  return text.length > 0 && !/[\s./]/.test(text);
}

function pageCapped(result, truncated) {
  const requested = result.requestedLimit;
  const pageCap = result.pageCap ?? RANK_WINDOW;
  return Boolean(truncated && requested != null && requested > pageCap);
}

function formatFind(result) {
  const results = orderFindResults(result.results, result.preserveOrder);
  const query = result.query ?? "";
  const shown = results.length;
  const matched = result.total ?? shown;
  const truncated = shown < matched;
  const capped = pageCapped(result, truncated);
  const pageCap = result.pageCap ?? RANK_WINDOW;
  const lines = [];

  lines.push(
    truncated
      ? `find ${query} — ${shown}/${matched} matches`
      : `find ${query} — ${shown} match${shown === 1 ? "" : "es"}`,
  );
  if (shown > 0) {
    lines.push("");
    for (const item of results) lines.push(item.path);
  }
  if (truncated) {
    lines.push(
      "",
      capped
        ? `capped at ${pageCap}; more: refine query/path`
        : "more: refine query/path",
    );
    if (shortFindFragment(query)) {
      lines.push(
        "find is a path fragment, not a glob; a short token matches widely — use a filename with extension, a directory, or host Glob",
      );
    }
  }
  if (result.globFallback) {
    lines.push(
      "",
      `query looked like a glob; searched "${result.globFallback.to}"`,
    );
  } else if (hasGlobSyntax(query) && shown === 0) {
    lines.push(
      "",
      `find uses path fragments, not globs; try "${literalFragment(query) || "the name"}".`,
    );
  }
  if (shown === 0) {
    const orHint = findBooleanOrHint(query);
    if (orHint) lines.push("", orHint);
  }

  return {
    lines,
    truncated,
    structured: {
      paths: uniquePaths(results.map((item) => item.path)),
      ...(result.globFallback ? { globFallback: result.globFallback } : {}),
    },
  };
}

function appendHitBlock(lines, hit, context) {
  if (context > 0) {
    const before = hit.contextBefore || [];
    const startLine = hit.line - before.length;
    for (let index = 0; index < before.length; index += 1) {
      lines.push(`${hit.path}:${startLine + index} ${clampText(before[index])}`);
    }
    lines.push(`${hit.path}:${hit.line} ${clampText(hit.text)}`);
    const after = hit.contextAfter || [];
    for (let index = 0; index < after.length; index += 1) {
      lines.push(`${hit.path}:${hit.line + 1 + index} ${clampText(after[index])}`);
    }
    return;
  }
  lines.push(`${hit.path}:${hit.line} ${clampText(hit.text)}`);
}

function appendHits(lines, hits, context = 0) {
  for (let index = 0; index < hits.length; index += 1) {
    if (index > 0 && context > 0) lines.push("");
    appendHitBlock(lines, hits[index], context);
  }
}

function formatGrepCount(result) {
  const pattern = result.pattern ?? "";
  const matchCount = result.matchCount ?? 0;
  const fileCount = result.fileCount ?? 0;
  const truncated = Boolean(result.countTruncated);
  const fileWord = fileCount === 1 ? "file" : "files";
  const matchWord = matchCount === 1 ? "match" : "matches";
  const lines = truncated
    ? [
        `grep ${pattern} — ≥${COUNT_SCAN_CAP} matches in ${fileCount} ${fileWord}, more remain`,
      ]
    : [`grep ${pattern} — ${matchCount} ${matchWord} in ${fileCount} ${fileWord}`];
  return {
    lines,
    truncated,
    structured: {
      hits: [],
      matchCount,
      fileCount,
    },
  };
}

function formatGrep(result) {
  if (result.count) return formatGrepCount(result);

  const hits = result.results || [];
  const pattern = result.pattern ?? "";
  const mode = result.mode ?? "plain";
  const fuzzy = mode === "fuzzy";
  const nextCursor = result.nextCursor || null;
  const truncated = Boolean(nextCursor);
  const preserveOrder = Boolean(result.preserveOrder);
  const display = orderGrepHits(hits, pattern, preserveOrder);
  const context = Number.isSafeInteger(result.context) ? result.context : 0;
  const capped = pageCapped(result, truncated);
  const pageCap = result.pageCap ?? RANK_WINDOW;
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
    lines.push(`grep ${pattern} — ${hits.length} shown, more remain`);
  } else {
    lines.push(
      `grep ${pattern} — ${hits.length} match${hits.length === 1 ? "" : "es"} in ${countFiles(
        hits,
      )} file${countFiles(hits) === 1 ? "" : "s"}`,
    );
  }

  if (result.contextCapped) {
    lines.push(`context capped at ${CONTEXT_CAP}`);
  }

  if (display.length > 0) {
    lines.push("");
    appendHits(lines, display, context);
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
      lines.push("check root above");
    } else {
      lines.push(
        "check root above; fuzzy:true only for approximate/different identifiers",
      );
    }
    if (looksLikeRegexWildcards(pattern) && !result.regex) {
      lines.push(
        "regex:true if this was a regular expression; this grep was literal",
      );
    }
  } else if (truncated) {
    lines.push(
      "",
      capped ? `capped at ${pageCap}; more: cursor` : "more: next page available",
    );
  }

  if (
    hits.length > 0 &&
    !fuzzy &&
    mode !== "regex" &&
    !result.regex &&
    isIdentifierPattern(pattern)
  ) {
    lines.push(`callers/callees: graph ${String(pattern).trim()}`);
  }

  return {
    lines,
    truncated,
    structured: {
      hits: display.map((hit) => {
        const item = {
          path: hit.path,
          line: hit.line,
          column: hit.column,
          text: clampText(hit.text),
        };
        if (context > 0) {
          item.before = (hit.contextBefore || []).map(clampText);
          item.after = (hit.contextAfter || []).map(clampText);
        }
        return item;
      }),
      ...(nextCursor ? { nextCursor } : {}),
    },
  };
}

function spanRange(start, end) {
  return end && end !== start ? `${start}-${end}` : `${start}`;
}

function formatLocator(path, start, end, name) {
  return `${path}:${spanRange(start, end)} ${name}`;
}

function uniqueSymbols(entries) {
  const names = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = String(entry.symbol).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(entry.symbol);
  }
  return names;
}

function appendLocators(lines, items, nameOf) {
  for (const item of items) {
    lines.push(
      formatLocator(
        item.path,
        item.line ?? item.startLine,
        item.endLine || item.line || item.startLine,
        nameOf(item),
      ),
    );
  }
}

function formatGraph(result) {
  const map = neighborhood(result);
  const {
    identifiers,
    entries,
    callees,
    callers,
    hiddenCallees,
    hiddenCallers,
  } = map;
  const query = result.query ?? "";
  const truncated = hiddenCallees.length > 0 || hiddenCallers.length > 0;
  const lines = [];

  if (entries.length > 0) {
    lines.push(
      `graph "${query}" — exact ${uniqueSymbols(entries).join(", ")}`,
    );
    lines.push("");
    appendLocators(lines, entries, (entry) => entry.symbol);
    if (callees.length > 0) {
      lines.push("", "callees");
      appendLocators(lines, callees, (callee) => callee.name);
      if (hiddenCallees.length > 0) {
        lines.push(`+${hiddenCallees.length} callees omitted`);
      }
    }
    if (callers.length > 0) {
      lines.push("", "callers");
      appendLocators(lines, callers, (caller) => caller.name);
      if (hiddenCallers.length > 0) {
        lines.push(`+${hiddenCallers.length} callers omitted`);
      }
    }
  } else if (identifiers.length > 0) {
    lines.push(
      `graph "${query}" — NO exact hit on ${identifiers.join(", ")}`,
    );
    lines.push(
      `next: grep ${identifiers.join(", ")}; narrow path if needed`,
    );
  } else {
    lines.push(`graph "${query}" — NO exact hit`);
    lines.push(`next: query an identifier or "how does X work"`);
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
      callers: callers.map((caller) => ({
        name: caller.name,
        path: caller.path,
        line: caller.line,
        ...(caller.endLine ? { endLine: caller.endLine } : {}),
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

export { CALLEE_CAP, CALLER_CAP, FIND_CAP, GREP_CAP };

import {
  exactHits,
  parseExploreDump,
  queryIdentifiers,
  symbolLabel,
} from "./graph-map.js";

const MAP_FILES = 12;
const MAP_SYMBOLS = 4;
const MAP_BLAST = 5;
const MAP_FOLDED_NAMES = 6;
const MATCH_TEXT_CHARS = 200;
const GRAPH_MAP_CHARS = 1_500;
const GRAPH_SOURCE_CHARS = 16_000;

export const MCP_INSTRUCTIONS = `codeq is local find, grep, and graph for one repository at a time. Indexes are created automatically on first use. Never ask the user to init, never write a .codegraph directory into the project, and never merge results across repositories.

When to use which tool:
- graph: how code works, a symbol, callers, callees, impact, or "where is X used". Query with identifiers, or "how does X work" where X is identifiers — not a multi-paragraph question. One call is enough — explore already includes related files, call paths, and blast radius. There is no callers tool. graph returns a map of the code to read next, not a written answer.
- find: file names and paths, matched fuzzily, including dotfiles and dot-directories such as .claude/skills and .cursor/rules. Not a glob: **/*profile* matches nothing, pass profile.
- grep: file contents. One identifier or one regex per call (regex is auto-detected). All-match patterns like .* are rejected. Matching is exact by default: zero hits means zero hits. Pass fuzzy: true to also accept approximate names; those replies are labelled [fuzzy] and name DIFFERENT identifiers.

Indexing starts on tools/call, never on initialize or tools/list. Prefer roots/list when the client gives a real project folder (not $HOME or /); otherwise use process.cwd() if that is a project. If the server was spawned from $HOME, pass path or root on the call. Each call uses exactly one root.

root and path are not interchangeable. root is the repository, checkout, or worktree to search: pass it whenever the question is about a repository other than the session cwd. path narrows inside that repository and takes a directory or a single file. A subdirectory passed as root builds a second index of that subdirectory instead of narrowing, and a file passed as root falls back to the repository holding it; both cases say so in the reply.

Every reply names the resolved absolute root and where it came from: "root <abs> via root argument", "via path argument", or "via cwd (roots/list | spawn cwd | cwd argument | shell cwd)", followed by a parenthesised note when root was not a repository checkout. Read that line. When the root is not the repository you asked about — the usual cause is omitting root while working across two repositories — retry the same call with root set to that repository instead of interpreting the result.

Replies come in two layers. The default is layer 0: that first line, then a short map — hit symbols, the files to open next with their relevant line ranges, and what depends on them. It carries no source code, because opening the named files with your own Read is cheaper than us forwarding them. Pass detail: "full" for layer 1, which repeats the whole layer 0 map and then adds source (graph) or full match metadata (grep/find). When a reply says it omitted something, it says how to get it; take that route instead of guessing.`;

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
  if (result.lastSuccessfulSync) {
    parts.push(`lastSuccessfulSync ${result.lastSuccessfulSync}`);
  }
  if (result.warning) parts.push(`warning ${result.warning}`);
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

function formatFind(result, full) {
  const results = result.results || [];
  const query = result.query ?? "";
  const shown = results.length;
  const matched = result.total ?? shown;
  const lines = [];

  lines.push(
    shown < matched
      ? `find ${query} — ${shown} shown, ${matched} matched`
      : `find ${query} — ${shown} match${shown === 1 ? "" : "es"}`,
  );
  if (shown > 0) {
    lines.push("");
    for (const item of results) {
      if (!full) {
        lines.push(item.path);
        continue;
      }
      const score = item.score == null ? "" : ` · score ${item.score}`;
      const kind = item.matchType ? ` ${item.matchType}` : "";
      lines.push(`${item.path}${score}${kind}`);
    }
  }
  if (shown < matched) {
    lines.push("", "more: raise limit, or pass a longer path fragment.");
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
    structured: {
      query,
      shown,
      matched,
      indexed: result.indexed ?? null,
      paths: uniquePaths(results.map((item) => item.path)),
      weakFolded: 0,
      results: full
        ? results.map((item) => ({
            path: item.path,
            score: item.score ?? null,
            matchType: item.matchType ?? null,
          }))
        : [],
    },
  };
}

function formatGrep(result, full) {
  const hits = result.results || [];
  const pattern = result.pattern ?? "";
  const mode = result.mode ?? "plain";
  const fuzzy = mode === "fuzzy";
  const shown = result.shown ?? hits.length;
  const moreRemain = Boolean(result.moreRemain);
  const label = mode === "regex" ? "regex" : "exact";
  const lines = [];

  if (fuzzy) {
    lines.push(
      `grep ${pattern} — 0 exact matches; ${shown} fuzzy match${
        shown === 1 ? "" : "es"
      }, DIFFERENT identifiers`,
    );
  } else if (shown === 0) {
    lines.push(`grep ${pattern} — 0 matches, ${label}`);
  } else if (moreRemain) {
    lines.push(`grep ${pattern} — ${shown} shown, more remain, ${label}`);
  } else {
    lines.push(
      `grep ${pattern} — ${shown} match${shown === 1 ? "" : "es"} in ${countFiles(
        hits,
      )} file${countFiles(hits) === 1 ? "" : "s"}, ${label}`,
    );
  }

  if (shown > 0) {
    lines.push("");
    for (const hit of hits) {
      if (full) {
        for (let i = 0; i < (hit.contextBefore || []).length; i += 1) {
          const line = hit.line - hit.contextBefore.length + i;
          lines.push(`${hit.path}-${line}- ${hit.contextBefore[i]}`);
        }
      }
      lines.push(`${hit.path}:${hit.line}:${hit.column} ${clampText(hit.text)}`);
      if (full) {
        for (let i = 0; i < (hit.contextAfter || []).length; i += 1) {
          lines.push(`${hit.path}-${hit.line + i + 1}- ${hit.contextAfter[i]}`);
        }
      }
    }
  }

  if (fuzzy) {
    const names = fuzzyNames(hits, pattern);
    lines.push(
      "",
      names.length > 0
        ? `matched name: ${names.join(", ")} (not ${pattern}). confirm the spelling before concluding.`
        : `these are approximate matches, not ${pattern}. confirm the spelling before concluding.`,
    );
  } else if (shown === 0) {
    lines.push("");
    if (result.fuzzyRequested) {
      lines.push(
        "nothing in this repository matches that pattern, exact or fuzzy.",
        "check the root above if you meant another repository.",
      );
    } else {
      lines.push(
        "nothing in this repository contains that pattern. next: pass fuzzy: true for approximate names",
        "(they will be labelled [fuzzy] and are NOT the same identifier), or check the root above if you meant another repository.",
      );
    }
  } else if (moreRemain) {
    lines.push(
      "",
      "more: raise limit, or narrow with glob/path. (cursor pagination: 0.2.8)",
    );
  }

  return {
    lines,
    structured: {
      pattern,
      mode,
      fuzzy: Boolean(result.fuzzyRequested),
      shown,
      moreRemain,
      paths: uniquePaths(hits.map((hit) => hit.path)),
      hits: hits.map((hit) => ({
        path: hit.path,
        line: hit.line,
        column: hit.column,
        text: full ? hit.text : clampText(hit.text),
        ...(full
          ? {
              contextBefore: hit.contextBefore || [],
              contextAfter: hit.contextAfter || [],
            }
          : {}),
      })),
    },
  };
}

function fileLine(file, index, hitLines) {
  const anchor = hitLines.get(file.path);
  const names = file.symbols.slice(0, MAP_SYMBOLS).map(symbolLabel);
  const rest = file.symbolCount - MAP_SYMBOLS;
  const symbols = names.length > 0 ? ` — ${names.join(", ")}${rest > 0 ? ` +${rest}` : ""}` : "";
  const rendered = file.renderedLines
    ? ` · relevant lines ${file.renderedLines[0]}-${file.renderedLines[1]}`
    : "";
  return `${index}. ${file.path}${anchor ? `:${anchor}` : ""}${symbols}${rendered}`;
}

function graphMap(result, dump, identifiers, hits, fileCap) {
  const lines = [];
  const query = result.query ?? "";
  const scale =
    dump.symbolCount != null && dump.fileCount != null
      ? `${dump.symbolCount} symbols in ${dump.fileCount} file${
          dump.fileCount === 1 ? "" : "s"
        }`
      : `${dump.files.length} file${dump.files.length === 1 ? "" : "s"}`;

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

  if (hits.length > 0) {
    lines.push("");
    for (const hit of hits) {
      lines.push(
        `hit: ${hit.symbol} — ${hit.path}${hit.line ? `:${hit.line}` : ""}`,
      );
    }
  }

  const hitLines = new Map();
  for (const hit of hits) {
    if (hit.line && !hitLines.has(hit.path)) hitLines.set(hit.path, hit.line);
  }

  const shownFiles = dump.files.slice(0, fileCap);
  lines.push("");
  if (shownFiles.length === 0) {
    lines.push(
      "open these files (0) — the engine rendered no file section for this query.",
      "narrow with path=, or query the exact identifier.",
    );
  } else {
    lines.push(`open these files (${shownFiles.length})`);
    shownFiles.forEach((file, index) => {
      lines.push(fileLine(file, index + 1, hitLines));
    });
    if (dump.files.length > shownFiles.length) {
      lines.push(
        `+${dump.files.length - shownFiles.length} more files the engine rendered — detail:"full"`,
      );
    }
  }

  const wanted = new Set(identifiers.map((name) => name.toLowerCase()));
  const related = dump.blast.filter((entry) => wanted.has(entry.name.toLowerCase()));
  const folded = dump.blast.filter((entry) => !wanted.has(entry.name.toLowerCase()));
  if (related.length > 0) {
    lines.push("", "depends on this (blast radius, query symbols only)");
    for (const entry of related.slice(0, MAP_BLAST)) {
      lines.push(`- ${entry.name} (${entry.path}:${entry.line}) — ${entry.detail}`);
    }
  }
  if (folded.length > 0) {
    if (related.length === 0) lines.push("");
    lines.push(
      `+${folded.length} other symbol${
        folded.length === 1 ? "" : "s"
      } the engine ranked (${folded
        .slice(0, MAP_FOLDED_NAMES)
        .map((entry) => entry.name)
        .join(", ")}) — detail:"full"`,
    );
  }

  if (dump.pointers.length > 0) {
    lines.push(
      "",
      `also ranked, no source rendered: ${dump.pointers
        .slice(0, 4)
        .map((pointer) => pointer.path)
        .join(", ")}${dump.pointers.length > 4 ? ` +${dump.pointers.length - 4}` : ""}`,
    );
  }

  return { lines, folded, related, shownFiles };
}

function graphSource(dump, hits) {
  const targets = new Set(hits.map((hit) => hit.path));
  const ordered = [
    ...dump.files.filter((file) => targets.has(file.path)),
    ...dump.files.filter((file) => !targets.has(file.path)),
  ].filter((file) => file.source.length > 0);

  const kept = [];
  const omitted = [];
  let spent = 0;
  for (const file of ordered) {
    const section = [
      file.header,
      "",
      `\`\`\`${file.language}`,
      ...file.source,
      "```",
    ].join("\n");
    if (kept.length > 0 && spent + section.length > GRAPH_SOURCE_CHARS) {
      omitted.push(file.path);
      continue;
    }
    spent += section.length;
    kept.push(section);
  }
  return { kept, omitted };
}

function formatGraph(result, full) {
  const dump = parseExploreDump(result.result);
  const identifiers = queryIdentifiers(result.query);
  const hits = exactHits(dump, identifiers);
  // The budget is spent by dropping whole file entries, never by cutting
  // characters: a half-written path is worse than an honest "+N more files".
  let fileCap = MAP_FILES;
  let map = graphMap(result, dump, identifiers, hits, fileCap);
  while (map.lines.join("\n").length > GRAPH_MAP_CHARS && fileCap > 3) {
    fileCap -= 1;
    map = graphMap(result, dump, identifiers, hits, fileCap);
  }
  const lines = [...map.lines];
  const source = full ? graphSource(dump, hits) : { kept: [], omitted: [] };
  const dumpSize = String(result.result ?? "").length;

  // This hook is part of layer 0 and is repeated verbatim by layer 1, which
  // appends the source below it — so it says "map", not "reply".
  const sourceFiles = dump.files.filter((file) => file.source.length > 0).length;
  lines.push(
    "",
    sourceFiles > 0
      ? `no source in this map. detail:"full" returns source for these ${sourceFiles} file${
          sourceFiles === 1 ? "" : "s"
        } (~${Math.round(dumpSize / 1024)} KB), target file first.`
      : 'no source in this map. detail:"full" returns the engine output for this query.',
  );

  if (full) {
    lines.push("", "**Source Code**");
    if (source.omitted.length === 0 && dump.verbatimNote) {
      lines.push("", dump.verbatimNote);
    }
    for (const section of source.kept) lines.push("", section);
    if (source.omitted.length > 0) {
      lines.push(
        "",
        `omitted source for ${source.omitted.length} file${
          source.omitted.length === 1 ? "" : "s"
        } (${source.omitted.join(", ")}) — pass path=${
          source.omitted[0]
        } to get that one in full.`,
      );
    }
  }

  return {
    lines,
    structured: {
      query: result.query ?? null,
      exactHits: hits.map((hit) => ({
        symbol: hit.symbol,
        path: hit.path,
        line: hit.line,
      })),
      files: map.shownFiles.map((file) => ({
        path: file.path,
        symbols: file.symbols.slice(0, MAP_SYMBOLS).map((symbol) => symbol.name),
        symbolCount: file.symbolCount,
        renderedLines: file.renderedLines,
      })),
      paths: map.shownFiles.map((file) => file.path),
      alsoRanked: uniquePaths([
        ...map.folded.map((entry) => entry.name),
        ...dump.pointers.map((pointer) => pointer.path),
      ]),
      omitted: {
        files: source.omitted.length,
        reason: source.omitted.length > 0 ? "graph source budget" : null,
      },
      sourceIncluded: source.kept.length > 0,
    },
  };
}

export function formatMcpToolResult(command, result, { detail = "summary" } = {}) {
  const full = detail === "full";
  const formatted =
    command === "find"
      ? formatFind(result, full)
      : command === "grep"
        ? formatGrep(result, full)
        : formatGraph(result, full);

  const first = freshnessLine(result);
  return {
    firstLine: first,
    map: formatted.lines.join("\n"),
    text: `${first}\n${formatted.lines.join("\n")}`,
    structuredContent: {
      ...freshnessFields(command, result),
      detail: full ? "full" : "summary",
      ...formatted.structured,
    },
  };
}

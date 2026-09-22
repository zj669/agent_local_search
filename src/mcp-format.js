import {
  exactHits,
  parseExploreDump,
  queryIdentifiers,
  rankFiles,
  symbolLabel,
} from "./graph-map.js";

const MAP_FILES = 12;
const MAP_SYMBOLS = 4;
const MAP_BLAST = 5;
const MAP_FOLDED_NAMES = 6;
const MAP_TOPICS = 3;
const CALLEE_CAP = 8;
const GREP_SHOW = 16;
const MATCH_TEXT_CHARS = 200;
// Layer 1 has to pay for itself: grep spends it on context lines, so detail
// "full" without an explicit context still gets some.
export const FULL_GREP_CONTEXT = 2;
const GRAPH_MAP_CHARS = 1_500;
const GRAPH_SOURCE_CHARS = 16_000;

export const MCP_INSTRUCTIONS = `codeq is local find, grep, and graph for one repository at a time. Indexes are created automatically on first use. Never ask the user to init, never write a .codegraph directory into the project, and never merge results across repositories.

When to use which tool:
- graph: how code works, a symbol, callers, callees, impact, or "where is X used". Query with identifiers, or "how does X work" where X is identifiers — not a multi-paragraph question. One call is enough — explore already includes related files, call paths, and blast radius. There is no callers tool. graph returns a map of the code to read next, not a written answer.
- find: file names and paths, matched fuzzily, including dotfiles and dot-directories such as .claude/skills and .cursor/rules. Not a glob: **/*profile* matches nothing, pass profile.
- grep: file contents. One identifier or one regex per call (regex is auto-detected). All-match patterns like .* are rejected. Matching is exact by default: zero hits means zero hits. Pass fuzzy: true to also accept approximate names; those replies are labelled [fuzzy] and name DIFFERENT identifiers.

Indexing starts on tools/call, never on initialize or tools/list. Prefer roots/list when the client gives a real project folder (not $HOME or /); otherwise use process.cwd() if that is a project. If the server was spawned from $HOME, pass path or root on the call. Each call uses exactly one root.

root and path are not interchangeable, but only root selects an index. root is the repository, checkout, or worktree to search: pass it whenever the question is about a repository other than the session cwd. path narrows that one call inside the selected repository and takes a directory or a single file; it never builds or switches an index, so any number of paths share one index per repository. A relative path is joined to the selected root, not to the session cwd, and a path that does not exist is an error naming the absolute path that was tried — never a silent whole-repository search. A subdirectory or file passed as root resolves to the repository that holds it, narrowed to that subdirectory or file; the reply's first line says so.

Every reply names the resolved absolute root and where it came from: "root <abs> via root argument", "via path argument", or "via cwd (roots/list | spawn cwd | cwd argument | shell cwd)", followed by a parenthesised note when root was not a repository checkout. Read that line. When the root is not the repository you asked about — the usual cause is omitting root while working across two repositories — retry the same call with root set to that repository instead of interpreting the result.

Replies come in two layers. The default is layer 0: that first line, then a short map. For graph that map is the query symbol's own span (start line–end line of that function or class, not the whole file) plus its direct callees (name, file, line, about 8). Read that span; do not open the whole file, and do not split a pipeline question into one graph call per identifier — a query that names several symbols returns one wider map. For grep, hits are grouped by file with definition and assignment lines first; the rest are folded into a count. It carries no source code, because opening the named span with your own Read is cheaper than us forwarding it. Pass detail: "full" for layer 1, which repeats the whole layer 0 map and then adds source (graph) or full match metadata (grep/find). When a reply says it omitted something, it says how to get it; take that route instead of guessing.`;

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

function partitionGrep(hits, pattern) {
  const preferred = [];
  const rest = [];
  for (const hit of hits) {
    if (isPreferredHit(hit, pattern)) preferred.push(hit);
    else rest.push(hit);
  }
  if (preferred.length === 0) {
    return { shown: hits.slice(0, GREP_SHOW), folded: hits.slice(GREP_SHOW) };
  }
  return {
    shown: preferred.slice(0, GREP_SHOW),
    folded: [...preferred.slice(GREP_SHOW), ...rest],
  };
}

function appendHit(lines, hit, full) {
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

function appendGroupedHits(lines, hits, full) {
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
    for (const hit of group.hits) appendHit(lines, hit, full);
  }
}

function orderGrepFull(hits, pattern) {
  const groups = [];
  const index = new Map();
  for (const hit of hits) {
    if (!index.has(hit.path)) {
      index.set(hit.path, groups.length);
      groups.push([]);
    }
    groups[index.get(hit.path)].push(hit);
  }
  const ordered = [];
  for (const group of groups) {
    ordered.push(
      ...group.filter((hit) => isPreferredHit(hit, pattern)),
      ...group.filter((hit) => !isPreferredHit(hit, pattern)),
    );
  }
  return ordered;
}

function foldHitsLine(folded) {
  const files = uniquePaths(folded.map((hit) => hit.path));
  const listed = files.slice(0, 8);
  const extra = files.length > listed.length ? ` +${files.length - listed.length}` : "";
  return `+${folded.length} more hits in these files: ${listed.join(", ")}${extra} — detail:"full"`;
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

  const partition = partitionGrep(hits, pattern);
  const display = full ? hits : partition.shown;
  if (display.length > 0) {
    lines.push("");
    appendGroupedHits(lines, full ? orderGrepFull(hits, pattern) : display, full);
  }
  if (!full && partition.folded.length > 0) {
    lines.push("", foldHitsLine(partition.folded));
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

function spansForHits(hits, symbols) {
  const byName = new Map(
    (symbols || [])
      .filter((span) => span && span.name && span.path && span.startLine)
      .map((span) => [span.name.toLowerCase(), span]),
  );
  const spans = [];
  const seen = new Set();
  for (const hit of hits) {
    const span = byName.get(hit.symbol.toLowerCase());
    if (!span || seen.has(span.name.toLowerCase())) continue;
    seen.add(span.name.toLowerCase());
    spans.push(span);
  }
  return spans;
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

function directCallees(spans) {
  const seen = new Set();
  const callees = [];
  for (const span of spans) {
    for (const callee of span.callees || []) {
      if (!callee || !callee.name || !callee.path || !callee.line) continue;
      const key = `${callee.name}\0${callee.path}\0${callee.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      callees.push(callee);
    }
  }
  return callees;
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

function graphMap(result, dump, identifiers, hits, ranked, fileCap) {
  const lines = [];
  const query = result.query ?? "";
  const scale =
    dump.symbolCount != null && dump.fileCount != null
      ? `${dump.symbolCount} symbol${
          dump.symbolCount === 1 ? "" : "s"
        } in ${dump.fileCount} file${dump.fileCount === 1 ? "" : "s"}`
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

  const spans = spansForHits(hits, result.symbols);
  const spanByName = new Map(spans.map((span) => [span.name.toLowerCase(), span]));

  if (hits.length > 0) {
    lines.push("");
    for (const hit of hits) {
      const span = spanByName.get(hit.symbol.toLowerCase());
      const loc = span
        ? `${span.path}:${spanRange(span)}`
        : `${hit.path}${hit.line ? `:${hit.line}` : ""}`;
      lines.push(`hit: ${hit.symbol} — ${loc}`);
    }
  }

  const hitLines = new Map();
  for (const hit of hits) {
    if (hit.line && !hitLines.has(hit.path)) hitLines.set(hit.path, hit.line);
  }

  const callees = directCallees(spans);
  const shownCallees = callees.slice(0, CALLEE_CAP);
  const hiddenCallees = callees.slice(CALLEE_CAP);
  const shownFiles = spans.length > 0 ? [] : ranked.files.slice(0, fileCap);
  lines.push("");
  if (spans.length > 0) {
    lines.push(`open these files (${spans.length})`);
    spans.forEach((span, index) => {
      lines.push(
        `${index + 1}. ${span.path}:${spanRange(span)} — ${symbolLabel(span)}`,
      );
    });
    if (shownCallees.length > 0) {
      lines.push("", "calls (direct)");
      for (const callee of shownCallees) lines.push(formatCallee(callee));
      if (hiddenCallees.length > 0) {
        lines.push(`+${hiddenCallees.length} more callees — detail:"full"`);
      }
    }
  } else if (shownFiles.length === 0) {
    lines.push(
      "open these files (0) — the engine rendered no file section for this query.",
      "narrow with path=, or query the exact identifier.",
    );
  } else {
    lines.push(`open these files (${shownFiles.length})`);
    shownFiles.forEach((file, index) => {
      lines.push(fileLine(file, index + 1, hitLines));
    });
    if (ranked.files.length > shownFiles.length) {
      lines.push(
        `+${ranked.files.length - shownFiles.length} more files the engine rendered — detail:"full"`,
      );
    }
  }

  if (ranked.folded.length > 0) {
    lines.push(
      "",
      `also ranked, on shorter tokens than ${identifiers.join(", ")}: ${ranked.folded
        .slice(0, MAP_FOLDED_NAMES)
        .map((file) => file.path)
        .join(", ")}${
        ranked.folded.length > MAP_FOLDED_NAMES
          ? ` +${ranked.folded.length - MAP_FOLDED_NAMES}`
          : ""
      } — detail:"full" expands them.`,
    );
  }

  if (identifiers.length >= MAP_TOPICS) {
    lines.push(
      "",
      `this query names ${identifiers.length} topics (${identifiers.join(
        ", ",
      )}), so this map is wider than one symbol.`,
    );
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

  return {
    lines,
    folded,
    related,
    shownFiles,
    spans,
    callees,
    hiddenCallees,
    foldedFiles: ranked.folded,
  };
}

function graphSource(dump, ranked) {
  const order = new Map(ranked.files.map((file, index) => [file.path, index]));
  const ordered = dump.files
    .filter((file) => file.source.length > 0)
    .map((file, index) => ({ file, rank: order.get(file.path) ?? order.size + index }))
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.file);

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
  const ranked = rankFiles(dump, hits, identifiers);
  // The budget is spent by dropping whole file entries, never by cutting
  // characters: a half-written path is worse than an honest "+N more files".
  let fileCap = MAP_FILES;
  let map = graphMap(result, dump, identifiers, hits, ranked, fileCap);
  while (map.lines.join("\n").length > GRAPH_MAP_CHARS && fileCap > 3) {
    fileCap -= 1;
    map = graphMap(result, dump, identifiers, hits, ranked, fileCap);
  }
  const lines = [...map.lines];
  const source = full ? graphSource(dump, ranked) : { kept: [], omitted: [] };
  const dumpSize = String(result.result ?? "").length;

  // This hook is part of layer 0 and is repeated verbatim by layer 1, which
  // appends the source below it — so it says "map", not "reply".
  const sourceFiles = dump.files.filter((file) => file.source.length > 0).length;
  lines.push(
    "",
    sourceFiles > 0
      ? `no source in this map. detail:"full" returns source for ${
          sourceFiles === 1 ? "this 1 file" : `these ${sourceFiles} files`
        } (~${Math.round(dumpSize / 1024)} KB), target file first.`
      : 'no source in this map. detail:"full" returns the engine output for this query.',
  );

  if (full && map.hiddenCallees.length > 0) {
    lines.push("", "more callees");
    for (const callee of map.hiddenCallees) lines.push(formatCallee(callee));
  }

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
      files:
        map.spans.length > 0
          ? map.spans.map((span) => ({
              path: span.path,
              symbols: [span.name],
              symbolCount: 1,
              renderedLines: [span.startLine, span.endLine || span.startLine],
            }))
          : map.shownFiles.map((file) => ({
              path: file.path,
              symbols: file.symbols.slice(0, MAP_SYMBOLS).map((symbol) => symbol.name),
              symbolCount: file.symbolCount,
              renderedLines: file.renderedLines,
            })),
      paths:
        map.spans.length > 0
          ? map.spans.map((span) => span.path)
          : map.shownFiles.map((file) => file.path),
      callees: map.callees.map((callee) => ({
        name: callee.name,
        path: callee.path,
        line: callee.line,
        ...(callee.endLine ? { endLine: callee.endLine } : {}),
        ...(callee.text && callee.endLine === callee.line ? { text: callee.text } : {}),
      })),
      alsoRanked: uniquePaths([
        ...map.folded.map((entry) => entry.name),
        ...map.foldedFiles.map((file) => file.path),
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

import { CALLEE_CAP, ENTRY_CAP } from "./limits.js";

const FILE_SECTION = /^\*\*`([^`]+)`\*\*(?:\s+—\s+(.*))?$/;
const BLAST_LINE = /^- `([^`]+)`\s+\(([^()]+?):(\d+)\)\s+—\s+(.*)$/;
const SUMMARY_LINE = /^Found (\d+) symbols? across (\d+) files?\.$/;
const POINTER_HEADER = "**Not shown above";
const POINTER_LINE = /^- ([^\s:]+):\s+(.+)$/;
const FENCE = /^```/;
const NUMBERED = /^(\d+)\t/;

// Edge kinds CodeGraph puts in a file-section header when a symbol got there by
// relationship rather than definition. The suffix answers "why is this name
// here", which never changes which file to open next, so layer 0 drops it.
const RELATION_KINDS = new Set([
  "calls",
  "called",
  "references",
  "extends",
  "implements",
  "overrides",
  "instantiates",
  "returns",
  "type_of",
  "decorates",
  "imports",
  "exports",
  "import",
  "export",
  "contains",
]);

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "by",
  "call",
  "called",
  "calls",
  "can",
  "do",
  "does",
  "flow",
  "for",
  "from",
  "get",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "path",
  "the",
  "this",
  "to",
  "use",
  "used",
  "uses",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with",
  "work",
  "works",
]);

export function queryIdentifiers(query) {
  const tokens = String(query || "").match(/[A-Za-z_][A-Za-z0-9_$]*/g) || [];
  const seen = new Set();
  const identifiers = [];
  for (const token of tokens) {
    if (token.length < 3) continue;
    if (STOP_WORDS.has(token.toLowerCase())) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    identifiers.push(token);
  }
  return identifiers;
}

function parseSymbols(suffix) {
  if (!suffix) return { symbols: [], total: 0 };
  const head = suffix.split(" · ")[0];
  const more = head.match(/,\s*\+(\d+)\s+more\s*$/);
  const extra = more ? Number(more[1]) : 0;
  const listed = (more ? head.slice(0, more.index) : head)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const symbols = [];
  const byName = new Map();
  for (const entry of listed) {
    const match = entry.match(/^(.+?)\(([^()]+)\)$/);
    const name = match ? match[1].trim() : entry;
    const kind = match ? match[2].trim() : null;
    if (kind && name === kind) continue;
    const seen = byName.get(name);
    if (seen) {
      // The engine can list one name twice, once per edge kind. Keep the
      // definition kind: it is the one that says what the symbol is.
      if (seen.kind && RELATION_KINDS.has(seen.kind) && kind && !RELATION_KINDS.has(kind)) {
        seen.kind = kind;
      }
      continue;
    }
    const symbol = { name, kind };
    byName.set(name, symbol);
    symbols.push(symbol);
  }
  return { symbols, total: listed.length + extra };
}

export function symbolLabel(symbol) {
  if (!symbol.kind || RELATION_KINDS.has(symbol.kind)) return symbol.name;
  return `${symbol.name}(${symbol.kind})`;
}

export function parseExploreDump(text) {
  const lines = String(text || "").split("\n");
  const dump = {
    symbolCount: null,
    fileCount: null,
    blast: [],
    files: [],
    pointers: [],
    verbatimNote: null,
  };
  let section = null;
  let inPointers = false;
  let fence = null;

  for (const line of lines) {
    if (fence !== null) {
      if (FENCE.test(line)) {
        fence = null;
        continue;
      }
      section?.source.push(line);
      const numbered = line.match(NUMBERED);
      if (numbered && section) {
        const number = Number(numbered[1]);
        if (section.renderedLines === null) section.renderedLines = [number, number];
        else section.renderedLines[1] = number;
      }
      continue;
    }

    if (line.startsWith("> The code below")) {
      dump.verbatimNote = line;
      continue;
    }

    const summary = line.match(SUMMARY_LINE);
    if (summary) {
      dump.symbolCount = Number(summary[1]);
      dump.fileCount = Number(summary[2]);
      continue;
    }

    const file = line.match(FILE_SECTION);
    if (file) {
      const { symbols, total } = parseSymbols(file[2]);
      section = {
        path: file[1],
        header: line,
        symbols,
        symbolCount: total,
        renderedLines: null,
        language: "",
        source: [],
      };
      dump.files.push(section);
      inPointers = false;
      continue;
    }

    if (line.startsWith(POINTER_HEADER)) {
      inPointers = true;
      section = null;
      continue;
    }

    if (FENCE.test(line) && section) {
      section.language = line.slice(3).trim();
      fence = section;
      continue;
    }

    if (inPointers) {
      const pointer = line.match(POINTER_LINE);
      if (pointer) dump.pointers.push({ path: pointer[1], symbols: pointer[2] });
      continue;
    }

    const blast = line.match(BLAST_LINE);
    if (blast && dump.files.length === 0) {
      dump.blast.push({
        name: blast[1],
        path: blast[2],
        line: Number(blast[3]),
        detail: blast[4].replace(/`/g, ""),
      });
    }
  }

  return dump;
}

const PATH_IN_TEXT = /(?:[\w.@+-]+\/)+[\w.@+-]+\.\w+/g;

// The engine seeds its search by splitting format_chat_details into format, chat
// and details, so its render order puts whatever matched a short token first.
// Layer 0 ranks by the identifier that was actually asked for: its definition
// site, then the files the blast radius ties to it, then everything else.
export function rankFiles(dump, hits, identifiers) {
  const wanted = new Set(identifiers.map((name) => name.toLowerCase()));
  const rendered = new Map(dump.files.map((file) => [file.path, file]));
  const files = [];
  const taken = new Set();
  const add = (file) => {
    if (!file || taken.has(file.path)) return;
    taken.add(file.path);
    files.push(file);
  };

  for (const hit of hits) {
    if (!hit.path) continue;
    // The engine can name a definition site it never rendered a section for.
    // It is still the first file to open.
    add(
      rendered.get(hit.path) || {
        path: hit.path,
        header: null,
        symbols: [{ name: hit.symbol, kind: null }],
        symbolCount: 1,
        renderedLines: null,
        language: "",
        source: [],
      },
    );
  }
  for (const file of dump.files) {
    if (file.symbols.some((symbol) => wanted.has(symbol.name.toLowerCase()))) add(file);
  }
  if (files.length === 0) return { files: dump.files, folded: [] };

  const linked = new Set();
  for (const entry of dump.blast) {
    if (!wanted.has(entry.name.toLowerCase())) continue;
    for (const path of entry.detail.match(PATH_IN_TEXT) || []) linked.add(path);
  }
  for (const file of dump.files) {
    if (linked.has(file.path)) add(file);
  }
  return { files, folded: dump.files.filter((file) => !taken.has(file.path)) };
}

export function exactHits(dump, identifiers, cap = ENTRY_CAP) {
  const wanted = new Map(identifiers.map((name) => [name.toLowerCase(), name]));
  const hits = [];
  const seen = new Set();
  const add = (name, path, line) => {
    const key = name.toLowerCase();
    if (!wanted.has(key) || seen.has(key)) return;
    seen.add(key);
    hits.push({ symbol: name, path, line });
  };
  for (const entry of dump.blast) add(entry.name, entry.path, entry.line);
  for (const file of dump.files) {
    for (const symbol of file.symbols) add(symbol.name, file.path, null);
  }
  return hits.slice(0, cap);
}

export function applyOrder(items, order, keyOf) {
  if (!Array.isArray(order) || order.length === 0) return items;
  const remaining = [...items];
  const out = [];
  for (const key of order) {
    const index = remaining.findIndex((item) => keyOf(item) === key);
    if (index < 0) continue;
    out.push(remaining.splice(index, 1)[0]);
  }
  out.push(...remaining);
  return out;
}

function symbolMap(symbols) {
  const byName = new Map();
  for (const span of symbols || []) {
    if (!span?.name) continue;
    const key = span.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, span);
  }
  return byName;
}

function entryKey(entry) {
  return `${entry.symbol}\0${entry.path}\0${entry.startLine}`;
}

export function resolveEntries(dump, identifiers, symbols = []) {
  const byName = symbolMap(symbols);
  const hits = exactHits(dump, identifiers, ENTRY_CAP);
  const entries = [];
  const seen = new Set();
  const push = (entry) => {
    if (!entry?.path || !entry.startLine) return;
    const key = entryKey(entry);
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };

  for (const hit of hits) {
    const span = byName.get(hit.symbol.toLowerCase());
    push({
      symbol: span?.name || hit.symbol,
      path: span?.path || hit.path,
      startLine: span?.startLine || hit.line,
      endLine: span?.endLine || span?.startLine || hit.line,
      kind: span?.kind || null,
      pinned: true,
      callees: span?.callees || [],
    });
  }
  // No exact hit: do not promote engine-ranked spans into reading entries.
  // Those locations are not this query's next Read.
  return entries.slice(0, ENTRY_CAP);
}

export function collectCallees(entries, cap = CALLEE_CAP) {
  const seen = new Set();
  const callees = [];
  for (const entry of entries) {
    for (const callee of entry.callees || []) {
      if (!callee?.name || !callee.path || !callee.line) continue;
      const key = `${callee.name}\0${callee.path}\0${callee.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      callees.push({
        name: callee.name,
        path: callee.path,
        line: callee.line,
        endLine: callee.endLine,
        text: callee.text,
      });
    }
  }
  return { shown: callees.slice(0, cap), hidden: callees.slice(cap) };
}

export function neighborhood(result) {
  const dump = parseExploreDump(result.result);
  const identifiers = queryIdentifiers(result.query);
  const resolved = resolveEntries(dump, identifiers, result.symbols);
  const entries = applyOrder(
    resolved,
    result.entryOrder,
    (entry) => `${entry.path}:${entry.startLine}`,
  );
  const collected = collectCallees(entries);
  const callees = applyOrder(
    collected.shown,
    result.calleeOrder,
    (callee) => `${callee.path}:${callee.line}`,
  );
  return {
    dump,
    identifiers,
    hits: exactHits(dump, identifiers),
    entries,
    callees,
    hiddenCallees: collected.hidden,
    extraFiles: Math.max(0, dump.files.length - entries.length),
  };
}

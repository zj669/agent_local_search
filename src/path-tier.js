import { isTestPath } from "./graph-map.js";
import { FIND_CAP, GREP_CAP, pageLimit } from "./limits.js";

const DOCS_SEGMENT = /(^|\/)(docs?|documentation|examples?|samples?|tutorials?)(\/|$)/i;

function posixPath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

export function isDocsPath(filePath) {
  const path = posixPath(filePath);
  if (DOCS_SEGMENT.test(path)) return true;
  const base = path.split("/").pop() || "";
  return /^readme(?:\..+)?$/i.test(base);
}

export function pathTier(filePath) {
  const docs = isDocsPath(filePath) ? 2 : 0;
  const test = isTestPath(filePath) ? 1 : 0;
  return Math.max(docs, test);
}

export function identifierAt(text, column) {
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

export function isPreferredHit(hit, pattern) {
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

export function rankFindResults(results) {
  const exact = [];
  const rest = [];
  for (const item of results || []) {
    if (item.matchType === "exact") exact.push(item);
    else rest.push(item);
  }
  const restOrder = rest.map((item, index) => ({ item, index }));
  restOrder.sort((a, b) => {
    const tier = pathTier(a.item.path) - pathTier(b.item.path);
    if (tier) return tier;
    return a.index - b.index;
  });
  return [...exact, ...restOrder.map((entry) => entry.item)];
}

export function rankGrepHits(hits, pattern) {
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

export function applyFindWindow(results, limit) {
  return rankFindResults(results).slice(0, pageLimit(limit, FIND_CAP));
}

export function applyGrepWindow(hits, pattern, limit, offset = 0) {
  const ranked = rankGrepHits(hits, pattern);
  const cap = pageLimit(limit, GREP_CAP);
  const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
  return {
    ranked,
    page: ranked.slice(start, start + cap),
  };
}

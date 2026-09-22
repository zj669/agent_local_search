import { isTestPath } from "./graph-map.js";
import { FIND_CAP, GREP_CAP, pageLimit } from "./limits.js";

const DOCS_SEGMENT = /(^|\/)(docs?|documentation|examples?|samples?|tutorials?)(\/|$)/i;
const AGENTS_SEGMENT = /(^|\/)\.agents(\/|$)/;
const SKILL_BASENAME = /^skill(?:\.md)?$/i;

function posixPath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

const CI_SEGMENT = /(^|\/)\.(github|circleci|gitlab)(\/|$)/;
const RC_BASENAME = /^\.[^./]*rc(\.|$)/i;
const BROWSERSLIST_RC = /^\.browserslistrc$/i;
const ROOT_DOT_SCRIPT = /^\.[^/]+\.(js|cjs|mjs|ts)$/i;
const ROOT_CONFIG_SCRIPT = /\.config\.(js|cjs|mjs|ts|json)$/i;
const ROOT_KARMA = /^karma\.conf\./i;

function isRepoRootFile(path) {
  const relative = posixPath(path).replace(/^\.\/+/, "");
  const segments = relative.split("/").filter((part) => part && part !== ".");
  return segments.length === 1;
}

export function isDocsPath(filePath) {
  const path = posixPath(filePath);
  if (DOCS_SEGMENT.test(path)) return true;
  if (AGENTS_SEGMENT.test(path)) return true;
  const base = path.split("/").pop() || "";
  if (SKILL_BASENAME.test(base)) return true;
  return /^readme(?:\..+)?$/i.test(base);
}

export function isConfigPath(filePath) {
  const path = posixPath(filePath);
  if (CI_SEGMENT.test(path)) return true;
  const base = path.split("/").pop() || "";
  if (base.toLowerCase() === "py.typed") return true;
  if (RC_BASENAME.test(base) || BROWSERSLIST_RC.test(base)) return true;
  if (!isRepoRootFile(path)) return false;
  return (
    ROOT_DOT_SCRIPT.test(base) ||
    ROOT_CONFIG_SCRIPT.test(base) ||
    ROOT_KARMA.test(base)
  );
}

export function pathTier(filePath) {
  if (isDocsPath(filePath)) return 3;
  if (isTestPath(filePath)) return 2;
  if (isConfigPath(filePath)) return 1;
  return 0;
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

function orderHitsInFile(hits, pattern) {
  const preferred = hits
    .filter((hit) => isPreferredHit(hit, pattern))
    .sort((a, b) => a.line - b.line);
  const rest = hits
    .filter((hit) => !isPreferredHit(hit, pattern))
    .sort((a, b) => a.line - b.line);
  return [...preferred, ...rest];
}

function roundRobinFiles(groups) {
  const queues = groups.map((group) => [...group.hits]);
  const ordered = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const queue of queues) {
      if (queue.length === 0) continue;
      ordered.push(queue.shift());
      progressed = true;
    }
  }
  return ordered;
}

export function rankGrepHits(hits, pattern) {
  const groups = [];
  const firstSeen = new Map();
  for (const hit of hits || []) {
    if (!firstSeen.has(hit.path)) {
      firstSeen.set(hit.path, groups.length);
      groups.push({ path: hit.path, hits: [] });
    }
    groups[firstSeen.get(hit.path)].hits.push(hit);
  }
  for (const group of groups) {
    group.hits = orderHitsInFile(group.hits, pattern);
    group.tier = pathTier(group.path);
  }
  groups.sort((a, b) => {
    const tier = a.tier - b.tier;
    if (tier) return tier;
    return firstSeen.get(a.path) - firstSeen.get(b.path);
  });
  const ordered = [];
  let index = 0;
  while (index < groups.length) {
    let end = index + 1;
    while (end < groups.length && groups[end].tier === groups[index].tier) {
      end += 1;
    }
    ordered.push(...roundRobinFiles(groups.slice(index, end)));
    index = end;
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

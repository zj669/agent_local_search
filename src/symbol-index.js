import { queryIdentifiers } from "./graph-map.js";

const DEFINITION_KINDS = new Set([
  "function",
  "method",
  "class",
  "struct",
  "interface",
  "trait",
  "protocol",
  "enum",
  "type_alias",
  "constant",
  "variable",
  "component",
]);

const CALL_KINDS = new Set(["calls", "instantiates"]);
const ONE_LINE_CAP = 8;

const BLAST_LINE = /^- `([^`]+)`\s+\(([^()]+?):(\d+)\)\s+—\s+/;

export function queryWithoutScope(query) {
  return String(query || "").replace(/\s+path:\S+\s*$/, "");
}

export function definitionHints(text) {
  const hints = new Map();
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("**Source Code**") || line.startsWith("**`")) break;
    const blast = line.match(BLAST_LINE);
    if (!blast) continue;
    const key = blast[1].toLowerCase();
    if (hints.has(key)) continue;
    hints.set(key, { name: blast[1], path: blast[2], line: Number(blast[3]) });
  }
  return hints;
}

function kindRank(kind) {
  if (kind === "function" || kind === "method") return 0;
  if (kind === "class") return 1;
  return 2;
}

export function pickDefinition(nodes, hint) {
  const defs = (nodes || []).filter(
    (node) => node && DEFINITION_KINDS.has(node.kind) && node.startLine > 0 && node.filePath,
  );
  if (defs.length === 0) return null;
  if (hint) {
    const exact = defs.find(
      (node) => node.filePath === hint.path && node.startLine === hint.line,
    );
    if (exact) return exact;
    const containing = defs
      .filter(
        (node) =>
          node.filePath === hint.path &&
          node.startLine <= hint.line &&
          (node.endLine || node.startLine) >= hint.line,
      )
      .sort(
        (a, b) =>
          (a.endLine || a.startLine) -
          a.startLine -
          ((b.endLine || b.startLine) - b.startLine),
      );
    if (containing.length > 0) return containing[0];
  }
  return [...defs].sort((a, b) => {
    const byKind = kindRank(a.kind) - kindRank(b.kind);
    if (byKind) return byKind;
    const span =
      (a.endLine || a.startLine) -
      a.startLine -
      ((b.endLine || b.startLine) - b.startLine);
    if (span) return span;
    return a.startLine - b.startLine;
  })[0];
}

export function directCalleeNodes(node, edges, getNode) {
  const seen = new Set();
  const callees = [];
  for (const edge of edges || []) {
    if (!edge || !CALL_KINDS.has(edge.kind)) continue;
    const target = getNode(edge.target);
    if (!target || target.id === node.id || !target.startLine || !target.filePath) continue;
    const key = `${target.name}\0${target.filePath}\0${target.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    callees.push(target);
  }
  return callees;
}

async function oneLineText(graph, node) {
  if (!node.endLine || node.endLine !== node.startLine) return null;
  let code;
  try {
    code = await graph.getCode(node.id);
  } catch {
    return null;
  }
  const text = String(code ?? "").trim();
  if (!text || text.includes("\n")) return null;
  return text;
}

export async function symbolIndex(graph, query, dumpText) {
  const hints = definitionHints(dumpText);
  const names = queryIdentifiers(queryWithoutScope(query));
  const symbols = [];
  let oneLines = 0;
  for (const name of names) {
    const node = pickDefinition(graph.getNodesByName(name), hints.get(name.toLowerCase()));
    if (!node) continue;
    const callees = [];
    for (const target of directCalleeNodes(
      node,
      graph.getOutgoingEdges(node.id),
      (id) => graph.getNode(id),
    )) {
      const entry = {
        name: target.name,
        path: target.filePath,
        line: target.startLine,
        endLine: target.endLine || target.startLine,
      };
      if (entry.endLine === entry.line && oneLines < ONE_LINE_CAP) {
        const text = await oneLineText(graph, target);
        if (text) entry.text = text;
        oneLines += 1;
      }
      callees.push(entry);
    }
    symbols.push({
      name: node.name,
      kind: node.kind,
      path: node.filePath,
      startLine: node.startLine,
      endLine: node.endLine || node.startLine,
      callees,
    });
  }
  return symbols;
}

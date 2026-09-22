import {
  DEFINITION_KINDS,
  inPathScope,
  kindRank,
  queryIdentifiers,
} from "./graph-map.js";

const CALL_KINDS = new Set(["calls", "instantiates"]);

const BLAST_LINE = /^- `([^`]+)`\s+\(([^()]+?):(\d+)\)\s+—\s+/;

export function queryWithoutScope(query) {
  return String(query || "").replace(/\s+path:\S+\s*$/, "");
}

export function pathConstraint(query) {
  const match = String(query || "").match(/\s+path:(\S+)\s*$/);
  return match ? match[1] : null;
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

function relatedNodes(node, edges, getNode, endpoint) {
  const seen = new Set();
  const related = [];
  for (const edge of edges || []) {
    if (!edge || !CALL_KINDS.has(edge.kind)) continue;
    const other = getNode(edge[endpoint]);
    if (!other || other.id === node.id || !other.startLine || !other.filePath) continue;
    const key = `${other.name}\0${other.filePath}\0${other.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    related.push(other);
  }
  return related;
}

export function directCalleeNodes(node, edges, getNode) {
  return relatedNodes(node, edges, getNode, "target");
}

export function directCallerNodes(node, edges, getNode) {
  return relatedNodes(node, edges, getNode, "source");
}

function locator(node) {
  return {
    name: node.name,
    path: node.filePath,
    line: node.startLine,
    endLine: node.endLine || node.startLine,
  };
}

function exactNameDefs(graph, name, constraint) {
  const wanted = name.toLowerCase();
  return (graph.getNodesByName(name) || []).filter((node) => {
    if (!node || !DEFINITION_KINDS.has(node.kind)) return false;
    if (!node.startLine || !node.filePath) return false;
    if (String(node.name).toLowerCase() !== wanted) return false;
    return inPathScope(node.filePath, constraint);
  });
}

function locatorsFrom(node, edges, getNode, endpoint) {
  return relatedNodes(node, edges, getNode, endpoint).map(locator);
}

export function identifiersHaveExactDefs(graph, query) {
  const names = queryIdentifiers(queryWithoutScope(query));
  if (names.length === 0) return false;
  if (typeof graph?.getNodesByName !== "function") return false;
  const constraint = pathConstraint(query);
  try {
    for (const name of names) {
      if (exactNameDefs(graph, name, constraint).length === 0) return false;
    }
  } catch {
    return false;
  }
  return true;
}

export function symbolIndex(graph, query) {
  const constraint = pathConstraint(query);
  const names = queryIdentifiers(queryWithoutScope(query));
  const symbols = [];
  const seen = new Set();
  const getNode = (id) => graph.getNode(id);
  for (const name of names) {
    for (const node of exactNameDefs(graph, name, constraint)) {
      const key = `${node.name}\0${node.filePath}\0${node.startLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({
        name: node.name,
        kind: node.kind,
        path: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine || node.startLine,
        callees: locatorsFrom(node, graph.getOutgoingEdges(node.id), getNode, "target"),
        callers: locatorsFrom(
          node,
          typeof graph.getIncomingEdges === "function"
            ? graph.getIncomingEdges(node.id)
            : [],
          getNode,
          "source",
        ),
      });
    }
  }
  return symbols;
}

export async function graphSearch(graph, query, explore) {
  if (identifiersHaveExactDefs(graph, query)) {
    try {
      return { result: "", symbols: symbolIndex(graph, query) };
    } catch {
      // Fall through to the 0.3.2 explore + pin path.
    }
  }
  const text = await explore(query);
  let symbols = [];
  try {
    symbols = symbolIndex(graph, query);
  } catch {
    symbols = [];
  }
  return { result: text, symbols };
}

export { DEFINITION_KINDS };

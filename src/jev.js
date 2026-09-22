import {
  exactHits,
  parseExploreDump,
  queryIdentifiers,
  rankFiles,
} from "./graph-map.js";

export const JEV_MODEL = "jev-1.13.0";

const NOUL_TRUE =
  "This hit is useful next-read evidence for answering the request query (a definition or implementation of the named function).";
const NOUL_FALSE =
  "This hit does not help answer the request query (a test, alias, comment, or unrelated mention).";
const SCORE_LEVELS = [
  "Not useful; fold away from the first screen",
  "Secondary; keep but can fold",
  "Primary next-read; keep prominent",
];

function flagOn(value) {
  const flag = String(value || "")
    .trim()
    .toLowerCase();
  return flag === "1" || flag === "true" || flag === "on" || flag === "yes";
}

export function jevEnabled(env = process.env) {
  return flagOn(env.CODEQ_JEV) && Boolean(env.TYPESAFE_API_KEY);
}

function compact(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (value == null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

function requestLayer(command, request, result) {
  return compact({
    query: request.query ?? result.query ?? result.pattern ?? "",
    tool: command,
    path: request.path,
    glob: request.glob,
    matchMode: result.mode,
  });
}

export function extractCandidates(command, request, result) {
  if (command === "find") {
    return (result.results || []).map((item, index) => ({
      index,
      anchor: item.path,
      record: compact({
        path: item.path,
        matchType: item.matchType,
      }),
    }));
  }
  if (command === "grep") {
    return (result.results || []).map((item, index) => {
      const before = item.contextBefore || [];
      const after = item.contextAfter || [];
      const local =
        before.length > 0 || after.length > 0
          ? { before, match: item.text, after }
          : {};
      return {
        index,
        anchor: `${item.path}:${item.line}`,
        record: compact({
          path: item.path,
          line: item.line,
          column: item.column,
          text: item.text,
          ...local,
        }),
      };
    });
  }
  if (command === "graph") {
    const dump = parseExploreDump(result.result);
    const identifiers = queryIdentifiers(result.query ?? request.query);
    const hits = exactHits(dump, identifiers);
    const ranked = rankFiles(dump, hits, identifiers);
    return ranked.files.map((file, index) => ({
      index,
      anchor: file.renderedLines
        ? `${file.path}:${file.renderedLines[0]}`
        : file.path,
      path: file.path,
      record: compact({
        path: file.path,
        symbols: file.symbols.map((symbol) =>
          compact({ name: symbol.name, kind: symbol.kind }),
        ),
        symbolCount: file.symbolCount,
        span: file.renderedLines
          ? { start: file.renderedLines[0], end: file.renderedLines[1] }
          : undefined,
      }),
    }));
  }
  return [];
}

function buildState(command, request, result, candidates) {
  const hits = {};
  for (const candidate of candidates) hits[candidate.anchor] = candidate.record;
  return { request: requestLayer(command, request, result), hits };
}

function permute(items, order, keyOf) {
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

function applyRanking(command, result, candidates, ranked) {
  const byIndex = new Map(ranked.map((item) => [item.index, item]));
  const ordered = [...candidates].sort((a, b) => {
    const left = byIndex.get(a.index);
    const right = byIndex.get(b.index);
    const noul = (right?.noul ?? 0) - (left?.noul ?? 0);
    if (noul !== 0) return noul;
    const score = (right?.score ?? 0) - (left?.score ?? 0);
    if (score !== 0) return score;
    return a.index - b.index;
  });
  if (command === "graph") {
    return {
      ...result,
      fileOrder: ordered.map((item) => item.path),
    };
  }
  const keys = ordered.map((item) =>
    command === "find" ? item.record.path : item.anchor,
  );
  const results = permute(
    result.results || [],
    keys,
    command === "find"
      ? (item) => item.path
      : (item) => `${item.path}:${item.line}`,
  );
  return {
    ...result,
    results,
    ...(command === "grep" ? { preserveOrder: true } : {}),
  };
}

let clientPromise = null;

async function defaultSystemOne(payload) {
  const { TypeSafeClient, noul, score } = await import("@typesafe-ai/sdk");
  if (!clientPromise) {
    clientPromise = Promise.resolve(
      new TypeSafeClient({
        defaultModel: JEV_MODEL,
        logLevel: "off",
        timeout: 10_000,
        retry: {
          maxRetries: 0,
          apiTimeoutError: false,
          apiConnectionError: false,
        },
      }),
    );
  }
  const client = await clientPromise;
  const questions = {};
  for (const [key, question] of Object.entries(payload.questions)) {
    if (question.type === "noul") {
      questions[key] = noul(question.instructions, question.criteria);
    } else {
      questions[key] = score(question.instructions, question.criteria);
    }
  }
  return client.systemOne({
    model: JEV_MODEL,
    state: payload.state,
    questions,
  });
}

function questionsFor(candidates) {
  const questions = {};
  for (const [index, candidate] of candidates.entries()) {
    questions[`n${index}`] = {
      type: "noul",
      instructions: `Does the hit \`${candidate.anchor}\` help answer the request query?`,
      criteria: { true: NOUL_TRUE, false: NOUL_FALSE },
    };
    questions[`s${index}`] = {
      type: "score",
      instructions: `How should a search wrapper present \`${candidate.anchor}\` for the request query?`,
      criteria: SCORE_LEVELS,
    };
  }
  return questions;
}

function readAnswers(answers, candidates) {
  return candidates.map((candidate, index) => {
    const noulAnswer = answers[`n${index}`];
    const scoreAnswer = answers[`s${index}`];
    const noul =
      noulAnswer && typeof noulAnswer.noul === "number" ? noulAnswer.noul : 0;
    const score =
      scoreAnswer && typeof scoreAnswer.score === "number"
        ? scoreAnswer.score
        : 0;
    return { index: candidate.index, noul, score };
  });
}

export async function rerank(
  command,
  request,
  result,
  { systemOne = defaultSystemOne } = {},
) {
  const candidates = extractCandidates(command, request, result);
  if (candidates.length <= 1) return result;
  const payload = {
    state: buildState(command, request, result, candidates),
    questions: questionsFor(candidates),
  };
  const response = await systemOne(payload);
  if (!response?.answers) return result;
  const ranked = readAnswers(response.answers, candidates);
  const next = applyRanking(command, result, candidates, ranked);
  if (command !== "graph") {
    const before = (result.results || []).length;
    const after = (next.results || []).length;
    if (after !== before) return result;
  } else if ((next.fileOrder || []).length !== candidates.length) {
    return result;
  }
  return next;
}

export async function maybeRerank(command, request, result, options) {
  if (!jevEnabled(options?.env ?? process.env)) return result;
  try {
    return await rerank(command, request, result, options);
  } catch {
    return result;
  }
}

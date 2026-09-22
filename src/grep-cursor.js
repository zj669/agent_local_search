export const GREP_CURSOR_ERROR =
  "grep cursor is not valid for this search. It is opaque and bound to the same root, pattern, glob, path, regex, and fuzzy as the call that issued it. Pass that cursor back unchanged. A mismatch or a stale cursor is an error, not page 1.";

function canonical(value) {
  return String(value ?? "");
}

function payloadFor(search) {
  return {
    v: 1,
    root: canonical(search.root),
    pattern: canonical(search.pattern),
    glob: canonical(search.glob),
    constraint: canonical(search.constraint),
    regex: Boolean(search.regex),
    fuzzy: Boolean(search.fuzzy),
    mode: canonical(search.mode),
  };
}

export function encodeGrepCursor(search, offset) {
  const inner = Number(offset);
  if (!Number.isSafeInteger(inner) || inner <= 0) return null;
  if (!search.mode) return null;
  const token = Buffer.from(
    JSON.stringify({ ...payloadFor(search), offset: inner }),
    "utf8",
  ).toString("base64url");
  return token;
}

export function grepCursorOffset(nextCursor) {
  if (nextCursor == null) return null;
  if (typeof nextCursor === "number") return nextCursor;
  const offset = nextCursor._offset ?? nextCursor.offset;
  return Number.isSafeInteger(offset) && offset > 0 ? offset : null;
}

export function toFffCursor(offset) {
  return { __brand: "GrepCursor", _offset: offset };
}

export function openGrepCursor(token, search) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(token), "base64url").toString("utf8"));
  } catch {
    throw new Error(GREP_CURSOR_ERROR);
  }
  const expected = payloadFor(search);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.v !== 1 ||
    parsed.root !== expected.root ||
    parsed.pattern !== expected.pattern ||
    parsed.glob !== expected.glob ||
    parsed.constraint !== expected.constraint ||
    parsed.regex !== expected.regex ||
    parsed.fuzzy !== expected.fuzzy ||
    !Number.isSafeInteger(parsed.offset) ||
    parsed.offset <= 0 ||
    !["plain", "regex", "fuzzy"].includes(parsed.mode)
  ) {
    throw new Error(GREP_CURSOR_ERROR);
  }
  return { cursor: toFffCursor(parsed.offset), mode: parsed.mode };
}

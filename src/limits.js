export const FIND_CAP = 16;
export const GREP_CAP = 16;
export const RANK_WINDOW = 48;
export const ENTRY_CAP = 3;
export const CALLEE_CAP = 4;
export const CALLER_CAP = 4;
export const JEV_TIMEOUT_MS = 800;
export const JEV_CANDIDATE_CAP = 16;
export const MATCH_TEXT_CHARS = 200;
export const CONTEXT_CAP = 3;
export const COUNT_SCAN_CAP = 4096;

export function pageLimit(requested, cap, fallback = cap) {
  if (!Number.isSafeInteger(requested) || requested <= 0) return fallback;
  return Math.min(requested, cap);
}

export function clampGrepContext(requested) {
  if (!Number.isSafeInteger(requested) || requested <= 0) return 0;
  return Math.min(requested, CONTEXT_CAP);
}

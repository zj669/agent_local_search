export const FIND_CAP = 16;
export const GREP_CAP = 16;
export const ENTRY_CAP = 3;
export const CALLEE_CAP = 8;
export const JEV_TIMEOUT_MS = 800;
export const JEV_CANDIDATE_CAP = 16;
export const MATCH_TEXT_CHARS = 200;

export function pageLimit(requested, cap) {
  const value = Number.isSafeInteger(requested) && requested > 0 ? requested : cap;
  return Math.min(value, cap);
}

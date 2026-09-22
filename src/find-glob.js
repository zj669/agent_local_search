export function hasGlobSyntax(query) {
  return /\*|\?\?|\[[^\]]+\]/.test(String(query || ""));
}

export function literalFragment(query) {
  const segments = String(query || "")
    .split("/")
    .map((segment) => segment.replace(/[*?[\]]/g, ""))
    .filter(Boolean);
  return segments[segments.length - 1] || "";
}

export function globFallbackFragment(query) {
  if (!hasGlobSyntax(query)) return null;
  const fragment = literalFragment(query);
  if (!fragment || fragment === String(query || "")) return null;
  return fragment;
}

export function scopedFindQuery(query, constraint) {
  return constraint ? `${constraint} ${query}`.trim() : query;
}

export function planFindSearch(query, constraint) {
  const fragment = globFallbackFragment(query);
  if (fragment) {
    return {
      primary: scopedFindQuery(fragment, constraint),
      globFallback: { from: query, to: fragment },
    };
  }
  return {
    primary: scopedFindQuery(query, constraint),
    globFallback: null,
  };
}

export function runFindSearch(plan, search) {
  return {
    value: search(plan.primary),
    globFallback: plan.globFallback,
  };
}

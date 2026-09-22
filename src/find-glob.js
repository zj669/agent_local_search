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
  return {
    primary: scopedFindQuery(query, constraint),
    fallback: fragment
      ? {
          query: scopedFindQuery(fragment, constraint),
          globFallback: { from: query, to: fragment },
        }
      : null,
  };
}

export function runFindSearch(plan, search) {
  const first = search(plan.primary);
  if ((first?.items?.length ?? 0) > 0 || !plan.fallback) {
    return { value: first, globFallback: null };
  }
  return {
    value: search(plan.fallback.query),
    globFallback: plan.fallback.globFallback,
  };
}

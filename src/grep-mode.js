const WILDCARD_ONLY =
  /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/;

function hasRegexSyntax(pattern) {
  return /[.*+?^${}()|[\]\\]/.test(pattern);
}

export function detectGrepMode(pattern) {
  if (!hasRegexSyntax(pattern)) return "plain";
  try {
    new RegExp(pattern);
    return "regex";
  } catch {
    return "plain";
  }
}

export function isWildcardOnlyPattern(pattern) {
  const trimmed = String(pattern ?? "").trim();
  return hasRegexSyntax(trimmed) && WILDCARD_ONLY.test(trimmed);
}

export function wildcardPatternError(pattern) {
  return (
    `Pattern '${pattern}' matches everything — grep needs a concrete substring ` +
    `or identifier. Example: pattern: 'MyClass' or pattern: 'export function'.`
  );
}

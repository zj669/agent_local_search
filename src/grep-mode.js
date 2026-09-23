const WILDCARD_ONLY =
  /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/;

function hasRegexSyntax(pattern) {
  return /[.*+?^${}()|[\]\\]/.test(pattern);
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

export function invalidRegexError(pattern, cause) {
  return (
    `Pattern '${pattern}' is not a valid regular expression (${cause}). ` +
    `Fix the regex, or pass regex: false to search the literal string.`
  );
}

export function grepCaseOptions(ignoreCase) {
  return { smartCase: ignoreCase !== false };
}

export function ignoreCaseCursorValue(ignoreCase) {
  if (ignoreCase === true) return "true";
  if (ignoreCase === false) return "false";
  return "default";
}

export function assertGrepPattern(pattern, { regex = false } = {}) {
  if (!regex) return "plain";
  if (isWildcardOnlyPattern(pattern)) {
    throw new Error(wildcardPatternError(pattern));
  }
  try {
    new RegExp(pattern);
  } catch (error) {
    throw new Error(invalidRegexError(pattern, error.message));
  }
  return "regex";
}

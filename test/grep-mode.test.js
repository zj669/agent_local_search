import assert from "node:assert/strict";
import test from "node:test";
import {
  detectGrepMode,
  isWildcardOnlyPattern,
  wildcardPatternError,
} from "../src/grep-mode.js";

test("detects literal, regex, and invalid-regex-as-plain", () => {
  assert.equal(detectGrepMode("TODO"), "plain");
  assert.equal(detectGrepMode("createSession"), "plain");
  assert.equal(detectGrepMode("foo.*Bar"), "regex");
  assert.equal(detectGrepMode("createSess.*"), "regex");
  assert.equal(detectGrepMode("interface\\{\\}"), "regex");
  assert.equal(detectGrepMode("("), "plain");
});

test("rejects all-match wildcard patterns", () => {
  for (const pattern of [".*", ".*?", ".+", ".", "*", ".*$", "^.*"]) {
    assert.equal(isWildcardOnlyPattern(pattern), true, pattern);
  }
  assert.equal(isWildcardOnlyPattern("TODO"), false);
  assert.equal(isWildcardOnlyPattern("foo.*Bar"), false);
  assert.match(wildcardPatternError(".*"), /matches everything/);
});

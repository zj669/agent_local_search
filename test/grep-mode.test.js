import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGrepPattern,
  isWildcardOnlyPattern,
  wildcardPatternError,
} from "../src/grep-mode.js";

test("literal is the default; regex must be explicit and valid", () => {
  assert.equal(assertGrepPattern("TODO"), "plain");
  assert.equal(assertGrepPattern("foo.ts"), "plain");
  assert.equal(assertGrepPattern("process.env"), "plain");
  assert.equal(assertGrepPattern("array[0]"), "plain");
  assert.equal(assertGrepPattern("foo.*Bar"), "plain");
  assert.equal(assertGrepPattern("foo.*Bar", { regex: true }), "regex");
  assert.equal(assertGrepPattern("interface\\{\\}", { regex: true }), "regex");
  assert.throws(() => assertGrepPattern("(", { regex: true }), /not a valid regular expression/);
});

test("rejects all-match wildcard patterns only when regex is on", () => {
  for (const pattern of [".*", ".*?", ".+", ".", "*", ".*$", "^.*"]) {
    assert.equal(isWildcardOnlyPattern(pattern), true, pattern);
    assert.throws(() => assertGrepPattern(pattern, { regex: true }), /matches everything/);
    assert.equal(assertGrepPattern(pattern), "plain");
  }
  assert.equal(isWildcardOnlyPattern("TODO"), false);
  assert.equal(isWildcardOnlyPattern("foo.*Bar"), false);
  assert.match(wildcardPatternError(".*"), /matches everything/);
});

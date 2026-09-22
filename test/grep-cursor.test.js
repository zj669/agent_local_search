import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeGrepCursor,
  GREP_CURSOR_ERROR,
  openGrepCursor,
} from "../src/grep-cursor.js";

const search = {
  root: "/repo",
  pattern: "TODO",
  glob: "**/*.ts",
  constraint: "src/",
  regex: false,
  fuzzy: false,
  mode: "plain",
};

test("grep cursor is opaque, bound to the search, and reconstructs the engine offset", () => {
  const token = encodeGrepCursor(search, 12);
  assert.equal(typeof token, "string");
  assert.equal(token.includes("/repo"), false);
  const opened = openGrepCursor(token, search);
  assert.equal(opened.mode, "plain");
  assert.equal(opened.cursor._offset, 12);
});

test("grep cursor mismatch and junk are errors, not page 1", () => {
  const token = encodeGrepCursor(search, 12);
  assert.throws(
    () => openGrepCursor(token, { ...search, root: "/other" }),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
  assert.throws(
    () => openGrepCursor(token, { ...search, pattern: "FIXME" }),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
  assert.throws(
    () => openGrepCursor(token, { ...search, regex: true }),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
  assert.throws(
    () => openGrepCursor(token, { ...search, glob: "**/*.js" }),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
  assert.throws(
    () => openGrepCursor("not-a-cursor", search),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
  assert.equal(encodeGrepCursor(search, 0), null);
});

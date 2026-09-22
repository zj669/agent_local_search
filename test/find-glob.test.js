import assert from "node:assert/strict";
import test from "node:test";
import {
  globFallbackFragment,
  hasGlobSyntax,
  literalFragment,
  planFindSearch,
  runFindSearch,
} from "../src/find-glob.js";

test("glob syntax and literal fragments stay one shared rule", () => {
  assert.equal(hasGlobSyntax("**/*blueprint*"), true);
  assert.equal(hasGlobSyntax("*session*"), true);
  assert.equal(hasGlobSyntax("mr_review_service/**/*profile*"), true);
  assert.equal(hasGlobSyntax("blueprint"), false);
  assert.equal(hasGlobSyntax("src/pkg/foo.py"), false);
  assert.equal(literalFragment("**/*blueprint*"), "blueprint");
  assert.equal(literalFragment("mr_review_service/**/*profile*"), "profile");
  assert.equal(literalFragment("*session*"), "session");
});

test("glob fallback is planned only for glob-shaped queries", () => {
  assert.equal(globFallbackFragment("blueprint"), null);
  assert.equal(globFallbackFragment("**/*blueprint*"), "blueprint");
  const glob = planFindSearch("**/*blueprint*", "src/");
  assert.equal(glob.primary, "src/ blueprint");
  assert.deepEqual(glob.globFallback, {
    from: "**/*blueprint*",
    to: "blueprint",
  });
  const plain = planFindSearch("blueprint", null);
  assert.equal(plain.primary, "blueprint");
  assert.equal(plain.globFallback, null);
});

test("glob-shaped queries search the fragment once", () => {
  const plan = planFindSearch("**/*blueprint*", null);
  const seen = [];
  const hits = runFindSearch(plan, (query) => {
    seen.push(query);
    return { items: [{ relativePath: "src/blueprint.ts" }], totalMatched: 1 };
  });
  assert.deepEqual(seen, ["blueprint"]);
  assert.deepEqual(hits.globFallback, {
    from: "**/*blueprint*",
    to: "blueprint",
  });
  assert.equal(hits.value.items.length, 1);

  seen.length = 0;
  const miss = runFindSearch(plan, (query) => {
    seen.push(query);
    return { items: [], totalMatched: 0 };
  });
  assert.deepEqual(seen, ["blueprint"]);
  assert.equal(miss.value.items.length, 0);
  assert.deepEqual(miss.globFallback, {
    from: "**/*blueprint*",
    to: "blueprint",
  });
});

test("non-glob queries keep the 0.3.2 search string", () => {
  const plan = planFindSearch("blueprint", "src/");
  const seen = [];
  const hits = runFindSearch(plan, (query) => {
    seen.push(query);
    return { items: [{ relativePath: "src/blueprint.ts" }], totalMatched: 1 };
  });
  assert.deepEqual(seen, ["src/ blueprint"]);
  assert.equal(hits.globFallback, null);
});

test("empty glob fragments keep the original query and do not mark a rewrite", () => {
  const plan = planFindSearch("**/*", null);
  assert.equal(plan.primary, "**/*");
  assert.equal(plan.globFallback, null);
  const seen = [];
  runFindSearch(plan, (query) => {
    seen.push(query);
    return { items: [], totalMatched: 0 };
  });
  assert.deepEqual(seen, ["**/*"]);
});

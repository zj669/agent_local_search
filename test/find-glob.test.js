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
  assert.equal(glob.primary, "src/ **/*blueprint*");
  assert.deepEqual(glob.fallback, {
    query: "src/ blueprint",
    globFallback: { from: "**/*blueprint*", to: "blueprint" },
  });
  const plain = planFindSearch("blueprint", null);
  assert.equal(plain.primary, "blueprint");
  assert.equal(plain.fallback, null);
});

test("glob fallback searches once and only after a zero-hit first pass", () => {
  const plan = planFindSearch("**/*blueprint*", null);
  const seen = [];
  const hits = runFindSearch(plan, (query) => {
    seen.push(query);
    return { items: [{ relativePath: "src/session.ts" }], totalMatched: 1 };
  });
  assert.deepEqual(seen, ["**/*blueprint*"]);
  assert.equal(hits.globFallback, null);
  assert.equal(hits.value.items.length, 1);

  seen.length = 0;
  const missThenHit = runFindSearch(plan, (query) => {
    seen.push(query);
    if (query === "blueprint") {
      return { items: [{ relativePath: "src/blueprint.ts" }], totalMatched: 1 };
    }
    return { items: [], totalMatched: 0 };
  });
  assert.deepEqual(seen, ["**/*blueprint*", "blueprint"]);
  assert.deepEqual(missThenHit.globFallback, {
    from: "**/*blueprint*",
    to: "blueprint",
  });

  seen.length = 0;
  const stillMiss = runFindSearch(plan, (query) => {
    seen.push(query);
    return { items: [], totalMatched: 0 };
  });
  assert.deepEqual(seen, ["**/*blueprint*", "blueprint"]);
  assert.equal(stillMiss.value.items.length, 0);
});

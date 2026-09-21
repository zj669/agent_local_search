import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveRequestRoot, unsafeRootReason } from "../src/paths.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(parent, name) {
  const root = join(parent, name);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "marker.js"), `export const marker = "${name}";\n`);
  git(root, "init", "-b", "main");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=codeq-test",
    "-c",
    "user.email=codeq@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  return realpathSync(root);
}

test("routes each request to exactly one target repository", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-routing-"));
  const repoA = repository(parent, "repo-a");
  const repoB = repository(parent, "repo-b");

  const local = await resolveRequestRoot({ cwd: repoA });
  assert.equal(local.root, repoA);
  assert.equal(local.constraint, null);

  const crossRepo = await resolveRequestRoot({
    cwd: repoA,
    path: "../repo-b",
  });
  assert.equal(crossRepo.root, repoB);
  assert.equal(crossRepo.constraint, null);

  const localAgain = await resolveRequestRoot({ cwd: repoA });
  assert.equal(localAgain.root, repoA);
});

test("a linked worktree resolves to its own checkout", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-worktree-"));
  const main = repository(parent, "main");
  const linked = join(parent, "linked");
  git(main, "worktree", "add", "-b", "proof-branch", linked, "main");

  const routed = await resolveRequestRoot({
    cwd: join(linked, "src"),
  });
  assert.equal(routed.root, realpathSync(linked));
  assert.notEqual(routed.root, main);
});

test("refuses the filesystem root and home directory", () => {
  assert.equal(unsafeRootReason("/"), "the filesystem root");
  assert.equal(unsafeRootReason(homedir()), "your home directory");
});

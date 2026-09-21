import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveRequestRoot, unsafeRootReason, isUnusableWorkspace } from "../src/paths.js";

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
  assert.equal(local.source, "cwd");

  const crossRepo = await resolveRequestRoot({
    cwd: repoA,
    path: "../repo-b",
  });
  assert.equal(crossRepo.root, repoB);
  assert.equal(crossRepo.constraint, null);
  assert.equal(crossRepo.source, "path");

  const explicitRoot = await resolveRequestRoot({ cwd: repoA, root: repoB });
  assert.equal(explicitRoot.root, repoB);
  assert.equal(explicitRoot.source, "root");

  const localAgain = await resolveRequestRoot({ cwd: repoA });
  assert.equal(localAgain.root, repoA);
  assert.equal(localAgain.source, "cwd");
});

test("a file passed as root searches its repository and narrows to that file", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-file-root-"));
  const repo = repository(parent, "repo");
  const file = join(repo, "src", "marker.js");

  const routed = await resolveRequestRoot({ cwd: repo, root: file });
  assert.equal(routed.root, repo);
  assert.equal(routed.constraint, "src/marker.js");
  assert.equal(routed.source, "root");
  assert.match(routed.note, /root named a file/);
  assert.match(routed.note, /pass a file as path, not root/);

  const asPath = await resolveRequestRoot({ cwd: repo, path: "src/marker.js" });
  assert.equal(asPath.root, routed.root);
  assert.equal(asPath.constraint, routed.constraint);
  assert.equal(asPath.note, null);

  await assert.rejects(
    resolveRequestRoot({ cwd: repo, root: file, path: "src" }),
    /root names a file and path was also passed/,
  );
});

test("root must exist, and says what to pass when it does not", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-missing-root-"));
  const repo = repository(parent, "repo");

  await assert.rejects(
    resolveRequestRoot({ cwd: repo, root: join(repo, "src", "typo") }),
    (error) => {
      assert.match(error.message, /root does not exist/);
      assert.match(error.message, /repository or worktree checkout/);
      assert.match(error.message, /narrow inside it with path/);
      return true;
    },
  );
});

test("a subdirectory passed as root keeps its own index and says so", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-subdir-root-"));
  const repo = repository(parent, "repo");
  const subdirectory = join(repo, "src");

  const routed = await resolveRequestRoot({ cwd: repo, root: subdirectory });
  assert.equal(routed.root, subdirectory);
  assert.equal(routed.constraint, null);
  assert.equal(routed.source, "root");
  assert.match(routed.note, new RegExp(`subdirectory of ${repo}`));
  assert.match(routed.note, new RegExp(`pass root ${repo} with path src`));

  const checkout = await resolveRequestRoot({ cwd: repo, root: repo });
  assert.equal(checkout.root, repo);
  assert.equal(checkout.note, null);

  const narrowed = await resolveRequestRoot({ cwd: repo, path: "src" });
  assert.equal(narrowed.root, repo);
  assert.equal(narrowed.constraint, "src/");
  assert.equal(narrowed.note, null);
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
  assert.equal(isUnusableWorkspace("/"), true);
  assert.equal(isUnusableWorkspace(homedir()), true);
  assert.equal(isUnusableWorkspace("${workspaceFolder}"), true);
  assert.equal(isUnusableWorkspace(""), true);
});

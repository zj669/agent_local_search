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

test("a subdirectory passed as root narrows its repository instead of indexing itself", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-subdir-root-"));
  const repo = repository(parent, "repo");
  const subdirectory = join(repo, "src");

  const routed = await resolveRequestRoot({ cwd: repo, root: subdirectory });
  assert.equal(routed.root, repo);
  assert.equal(routed.constraint, "src/");
  assert.equal(routed.source, "root");
  assert.match(routed.note, /root named a subdirectory/);
  assert.match(routed.note, /narrowed to src\/ instead of a second index/);
  assert.match(routed.note, /pass a subdirectory as path, not root/);

  const checkout = await resolveRequestRoot({ cwd: repo, root: repo });
  assert.equal(checkout.root, repo);
  assert.equal(checkout.note, null);

  const narrowed = await resolveRequestRoot({ cwd: repo, path: "src" });
  assert.equal(narrowed.root, repo);
  assert.equal(narrowed.constraint, "src/");
  assert.equal(narrowed.note, null);
});

test("a nested checkout passed as root is still its own repository", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-nested-checkout-"));
  const outer = repository(parent, "outer");
  const inner = repository(join(outer, "vendor"), "inner");

  const routed = await resolveRequestRoot({ cwd: outer, root: inner });
  assert.equal(routed.root, inner);
  assert.equal(routed.constraint, null);
  assert.equal(routed.note, null);
});

test("one root plus many paths is one index: paths only narrow the call", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-path-scope-"));
  const repo = repository(parent, "repo");
  mkdirSync(join(repo, "src", "agent"), { recursive: true });
  writeFileSync(join(repo, "src", "agent", "global.py"), "class GlobalAgent:\n    pass\n");

  const directory = await resolveRequestRoot({ cwd: repo, root: repo, path: "src/agent" });
  const file = await resolveRequestRoot({
    cwd: repo,
    root: repo,
    path: "src/agent/global.py",
  });
  const absolute = await resolveRequestRoot({
    cwd: repo,
    root: repo,
    path: join(repo, "src", "agent"),
  });
  const whole = await resolveRequestRoot({ cwd: repo, root: repo });

  for (const routed of [directory, file, absolute, whole]) {
    assert.equal(routed.root, repo);
    assert.equal(routed.source, "root");
  }
  assert.equal(directory.constraint, "src/agent/");
  assert.equal(file.constraint, "src/agent/global.py");
  assert.equal(absolute.constraint, "src/agent/");
  assert.equal(whole.constraint, null);
});

test("a relative path joins the selected root, not the session cwd", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-path-join-"));
  const session = repository(parent, "session");
  const other = repository(parent, "other");
  mkdirSync(join(other, "src", "agent"), { recursive: true });
  writeFileSync(join(other, "src", "agent", "global.py"), "class GlobalAgent:\n    pass\n");
  // The same relative path exists in the session repository, so resolving
  // against the cwd would silently search the wrong tree instead of missing.
  mkdirSync(join(session, "src", "agent"), { recursive: true });
  writeFileSync(join(session, "src", "agent", "decoy.py"), "decoy = 1\n");

  const routed = await resolveRequestRoot({
    cwd: session,
    root: other,
    path: "src/agent",
  });
  assert.equal(routed.root, other);
  assert.equal(routed.constraint, "src/agent/");
  assert.equal(routed.target, join(other, "src", "agent"));
  assert.equal(routed.source, "root");
});

function linkedWorktrees(parent) {
  const main = repository(parent, "repo");
  const wtA = join(parent, "wt-a");
  const wtB = join(parent, "wt-b");
  git(main, "worktree", "add", "-b", "tree-a", wtA, "main");
  git(main, "worktree", "add", "-b", "tree-b", wtB, "main");
  for (const [tree, marker] of [
    [wtA, "a"],
    [wtB, "b"],
  ]) {
    mkdirSync(join(tree, "src", "pkg"), { recursive: true });
    writeFileSync(join(tree, "src", "pkg", "foo.py"), `TREE = "${marker}"\n`);
  }
  return {
    wtA: realpathSync(wtA),
    wtB: realpathSync(wtB),
  };
}

test("cwd in worktree A, root worktree B, relative path=src/pkg searches B", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-wt-path-"));
  const { wtA, wtB } = linkedWorktrees(parent);

  const routed = await resolveRequestRoot({
    cwd: wtA,
    root: wtB,
    path: "src/pkg",
  });
  assert.equal(routed.root, wtB);
  assert.notEqual(routed.root, wtA);
  assert.equal(routed.constraint, "src/pkg/");
  assert.equal(routed.target, join(wtB, "src", "pkg"));
  assert.equal(routed.source, "root");
});

test("missing relative path names the joined absolute path under the selected root", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-wt-missing-"));
  const { wtA, wtB } = linkedWorktrees(parent);

  await assert.rejects(
    resolveRequestRoot({ cwd: wtA, root: wtB, path: "src/pkg/nope.py" }),
    (error) => {
      assert.match(error.message, /path not found: src\/pkg\/nope\.py/);
      assert.ok(
        error.message.includes(join(wtB, "src", "pkg", "nope.py")),
        error.message,
      );
      assert.equal(
        error.message.includes(join(wtA, "src", "pkg", "nope.py")),
        false,
        error.message,
      );
      assert.equal(error.message.includes("--root"), false);
      assert.equal(error.message.includes("--path"), false);
      return true;
    },
  );
});

test("a file as root on a worktree is the enclosing worktree plus that file", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-wt-file-root-"));
  const { wtA, wtB } = linkedWorktrees(parent);
  const file = join(wtB, "src", "pkg", "foo.py");

  const routed = await resolveRequestRoot({ cwd: wtA, root: file });
  assert.equal(routed.root, wtB);
  assert.notEqual(routed.root, wtA);
  assert.equal(routed.constraint, "src/pkg/foo.py");
  assert.equal(routed.source, "root");
  assert.match(routed.note, /root named a file/);
  assert.equal(JSON.stringify(routed).includes("--root"), false);
});

test("an absolute path under the session cwd still scopes the selected root", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-wt-abs-path-"));
  const { wtA, wtB } = linkedWorktrees(parent);

  const routed = await resolveRequestRoot({
    cwd: wtA,
    root: wtB,
    path: join(wtA, "src", "pkg"),
  });
  assert.equal(routed.root, wtB);
  assert.equal(routed.constraint, "src/pkg/");
  assert.equal(routed.target, join(wtB, "src", "pkg"));
});

test("a path that does not exist is an error naming the joined absolute path", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "codeq-missing-path-")));
  mkdirSync(join(repo, "src"), { recursive: true });

  await assert.rejects(
    resolveRequestRoot({ cwd: repo, root: repo, path: "src/no_such_dir" }),
    (error) => {
      assert.match(error.message, /path not found: src\/no_such_dir/);
      assert.ok(
        error.message.includes(join(repo, "src", "no_such_dir")),
        error.message,
      );
      assert.match(error.message, /not a fuzzy fragment and not a glob/);
      return true;
    },
  );

  await assert.rejects(
    resolveRequestRoot({ cwd: repo, path: "src/no_such_dir" }),
    /path not found: src\/no_such_dir/,
  );
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

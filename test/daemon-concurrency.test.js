import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { acquireLock, breakStaleLock, tryAcquireLock } from "../src/lock.js";
import { daemonPaths } from "../src/paths.js";

const execFileAsync = promisify(execFile);
const bin = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));

function repository(parent, name) {
  const root = join(parent, name);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "session.ts"),
    "export function createSession() { return { id: 1 }; }\n",
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=codeq-test",
      "-c",
      "user.email=codeq@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  return root;
}

function stopDaemon(dataDir) {
  const pidFile = join(dataDir, "daemon", "daemon.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

test(
  "many cold processes start one daemon and then query it at the same time",
  { timeout: 300_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-concurrency-"));
    const dataDir = join(parent, "data");
    const repo = repository(parent, "app");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    t.after(() => stopDaemon(dataDir));

    // Separate processes, no warm daemon, all racing the same socket bind and the
    // same CodeGraph migration.
    const calls = [
      ["find", "session.ts"],
      ["grep", "createSession"],
      ["graph", "createSession"],
      ["find", "src"],
      ["grep", "createSession"],
      ["graph", "createSession"],
    ];
    const replies = await Promise.all(
      calls.map(([command, query]) =>
        execFileAsync(process.execPath, [bin, "--json", command, query], {
          cwd: repo,
          env,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        }),
      ),
    );

    for (const [index, reply] of replies.entries()) {
      const payload = JSON.parse(reply.stdout);
      assert.equal(payload.command, calls[index][0]);
      assert.equal(payload.root, realpathSync(repo));
      assert.match(payload.status, /ready|indexing|degraded/);
    }

    const log = existsSync(join(dataDir, "daemon", "logs", "daemon.log"))
      ? readFileSync(join(dataDir, "daemon", "logs", "daemon.log"), "utf8")
      : "";
    assert.equal(/EADDRINUSE/.test(log), false, log);
    assert.equal(/database is locked/.test(log), false, log);
    assert.equal(/duplicate column name/.test(log), false, log);

    // One daemon, one index bucket, and the startup locks released themselves.
    assert.deepEqual(readdirSync(join(dataDir, "roots")).length, 1);
    const registry = JSON.parse(
      readFileSync(join(dataDir, "daemon", "registry.json"), "utf8"),
    );
    assert.equal(registry.roots.length, 1);
    assert.equal(existsSync(join(dataDir, "daemon", "autostart.lock")), false);
    assert.equal(existsSync(join(dataDir, "daemon", "bind.lock")), false);

    // A second client reaching the live daemon while another query is in flight
    // must not queue behind it.
    const slow = execFileAsync(
      process.execPath,
      [bin, "--json", "graph", "createSession"],
      { cwd: repo, env, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    const quick = await execFileAsync(
      process.execPath,
      [bin, "--json", "grep", "createSession"],
      { cwd: repo, env, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    assert.equal(JSON.parse(quick.stdout).command, "grep");
    assert.equal(JSON.parse((await slow).stdout).command, "graph");
    assert.equal(registry.pid, JSON.parse(
      readFileSync(join(dataDir, "daemon", "registry.json"), "utf8"),
    ).pid);
  },
);

test("a second daemon refuses to unlink a live socket", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-second-daemon-"));
  const dataDir = join(parent, "data");
  const repo = repository(parent, "app");
  const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
  t.after(() => stopDaemon(dataDir));

  await execFileAsync(process.execPath, [bin, "--json", "find", "session.ts"], {
    cwd: repo,
    env,
    encoding: "utf8",
  });
  const paths = daemonPaths(dataDir);
  const first = Number(readFileSync(paths.pid, "utf8").trim());

  const daemon = fileURLToPath(new URL("../src/daemon.js", import.meta.url));
  const second = await execFileAsync(process.execPath, [daemon], {
    env,
    encoding: "utf8",
  });
  assert.equal(second.stderr, "");
  assert.equal(Number(readFileSync(paths.pid, "utf8").trim()), first);

  const after = await execFileAsync(
    process.execPath,
    [bin, "--json", "find", "session.ts"],
    { cwd: repo, env, encoding: "utf8" },
  );
  assert.equal(JSON.parse(after.stdout).command, "find");
});

test("a lock is held once, and released when its holder is gone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codeq-lock-"));
  const lock = join(directory, "nested", "test.lock");

  const release = tryAcquireLock(lock, "first");
  assert.ok(release);
  assert.equal(tryAcquireLock(lock, "second"), null);
  assert.equal(breakStaleLock(lock), false, "a live holder is never stale");
  release();
  assert.equal(existsSync(lock), false);

  writeFileSync(lock, `${JSON.stringify({ pid: 2 ** 30, at: "old" })}\n`);
  assert.equal(breakStaleLock(lock), true, "a dead holder's lock is stale");

  const held = await acquireLock(lock, { timeoutMs: 500 });
  const waiter = await acquireLock(lock, {
    timeoutMs: 5_000,
    pollMs: 10,
    shortCircuit: () => true,
  });
  assert.equal(waiter.release, null, "the waiter short-circuited instead");
  assert.equal(waiter.shortCircuited, true);
  held.release();
});

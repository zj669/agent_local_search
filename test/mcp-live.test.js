import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createFramedParser, encodeMessage } from "../src/mcp.js";

const bin = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function waitFor(messages, predicate, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const match = messages.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for MCP message: ${JSON.stringify(messages)}`);
}

test("MCP find/grep/graph reuse the daemon and do not write .codegraph", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-mcp-it-"));
  const repo = join(parent, "app");
  const dataDir = join(parent, "data");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "src", "session.ts"),
    "export function createSession() { return { id: 1 }; }\n",
  );
  git(repo, "init", "-b", "main");
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=codeq-test",
    "-c",
    "user.email=codeq@example.invalid",
    "commit",
    "-m",
    "fixture",
  );

  const child = spawn(process.execPath, [bin, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: repo,
    env: { ...process.env, CODEQ_DATA_DIR: dataDir },
  });
  t.after(() => {
    child.kill("SIGTERM");
    const pidFile = join(dataDir, "daemon", "daemon.pid");
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
  });

  const messages = [];
  const parse = createFramedParser((message) => messages.push(message));
  child.stdout.on("data", (chunk) => parse(chunk));
  const send = (message) => child.stdin.write(encodeMessage(message));

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "codeq-live", version: "0" },
    },
  });
  await waitFor(messages, (message) => message.id === 1, 5_000);

  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "find", arguments: { query: "session.ts" } },
  });
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "grep", arguments: { pattern: "createSess.*" } },
  });
  send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "graph", arguments: { query: "createSession" } },
  });
  send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "grep", arguments: { pattern: ".*" } },
  });
  const find = await waitFor(messages, (message) => message.id === 2, 30_000);
  const grep = await waitFor(messages, (message) => message.id === 3, 30_000);
  const graph = await waitFor(messages, (message) => message.id === 4, 120_000);
  const wildcard = await waitFor(messages, (message) => message.id === 5, 10_000);

  const findPayload = find.result.structuredContent;
  const grepPayload = grep.result.structuredContent;
  const graphPayload = graph.result.structuredContent;

  assert.equal(find.result.isError, undefined);
  assert.equal(grep.result.isError, undefined);
  assert.equal(graph.result.isError, undefined, graph.result.content[0].text);
  assert.match(find.result.content[0].text, /^\[(ready|indexing|degraded)\]/);
  assert.match(find.result.content[0].text, /lastSuccessfulSync|root /);
  assert.equal(findPayload.command, "find");
  assert.ok(findPayload.paths?.some((item) => item.endsWith("session.ts")));
  assert.match(find.result.content[0].text, /^src\/session\.ts$/m);

  assert.ok(grepPayload.hits.some((item) => item.path.endsWith("session.ts")));
  assert.equal(grepPayload.mode, "regex");
  assert.equal(grepPayload.fuzzy, false);
  assert.match(grep.result.content[0].text, /^src\/session\.ts:1:\d+ /m);

  const graphText = graph.result.content[0].text;
  assert.equal(graphText.includes("```"), false);
  assert.equal(/verbatim/i.test(graphText), false);
  assert.equal(/already performed/i.test(graphText), false);
  assert.equal(graphText.includes("codegraph_explore"), false);
  assert.match(graphText, /open these files/);
  assert.match(graphText, /createSession/);
  assert.equal(graphPayload.sourceIncluded, false);
  assert.ok(graphPayload.files.some((file) => file.path.endsWith("session.ts")));
  assert.ok(graphPayload.paths.every((path) => !path.startsWith("../")));
  assert.equal(wildcard.result.isError, true);
  assert.match(wildcard.result.content[0].text, /matches everything/);

  send({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "graph", arguments: { query: "createSession", detail: "full" } },
  });
  send({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "grep", arguments: { pattern: "createSessionn" } },
  });
  send({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "grep", arguments: { pattern: "createSessionn", fuzzy: true } },
  });

  const graphFull = await waitFor(messages, (message) => message.id === 6, 120_000);
  const fullText = graphFull.result.content[0].text;
  assert.equal(graphFull.result.structuredContent.sourceIncluded, true);
  assert.match(fullText, /```/);
  assert.equal(fullText.includes("codegraph_explore"), false);
  const mapOf = (text) => text.split("\n").slice(1).join("\n");
  assert.equal(mapOf(fullText).startsWith(mapOf(graph.result.content[0].text)), true);

  const typo = await waitFor(messages, (message) => message.id === 7, 30_000);
  assert.equal(typo.result.structuredContent.shown, 0);
  assert.equal(typo.result.content[0].text.split("\n")[0].includes("[fuzzy]"), false);
  assert.match(typo.result.content[0].text, /0 matches, exact/);
  assert.match(typo.result.content[0].text, /pass fuzzy: true/);

  const approximate = await waitFor(messages, (message) => message.id === 8, 30_000);
  assert.equal(approximate.result.structuredContent.mode, "fuzzy");
  assert.match(approximate.result.content[0].text.split("\n")[0], /^\[\w+\]\[fuzzy\]/);
  assert.match(approximate.result.content[0].text, /DIFFERENT identifiers/);

  assert.equal(existsSync(join(repo, ".codegraph")), false);
});

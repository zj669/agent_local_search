import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bin = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));

function run(args, options = {}) {
  try {
    return execFileSync(process.execPath, [bin, ...args], {
      encoding: "utf8",
      ...options,
    });
  } catch (error) {
    error.stdout = error.stdout?.toString() || "";
    error.stderr = error.stderr?.toString() || "";
    throw error;
  }
}

test("CLI help includes mcp and the three query commands", () => {
  const stdout = run(["--help"]);
  assert.match(stdout, /codeq mcp/);
  assert.match(stdout, /find/);
  assert.match(stdout, /grep/);
  assert.match(stdout, /--limit N/);
  assert.match(stdout, /graph/);
});

test("mcp help describes the stdio server", () => {
  const stdout = run(["mcp", "--help"]);
  assert.match(stdout, /stdio MCP server/);
  assert.match(stdout, /find, grep, and graph/);
});

test("mcp rejects extra arguments", () => {
  let failed = false;
  try {
    run(["mcp", "--json"]);
  } catch (error) {
    failed = true;
    assert.match(error.stderr, /does not take additional arguments/);
    assert.equal(error.status, 2);
  }
  assert.equal(failed, true);
});

test("unknown CLI commands still fail without adding daemon controls", () => {
  let failed = false;
  try {
    run(["status"]);
  } catch (error) {
    failed = true;
    assert.match(error.stderr, /unknown command: status/);
  }
  assert.equal(failed, true);
});

test("codeq mcp speaks framed JSON-RPC on stdio", async () => {
  const { spawn } = await import("node:child_process");
  const { encodeMessage, createFramedParser } = await import("../src/mcp.js");
  const child = spawn(process.execPath, [bin, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  const parse = createFramedParser((message) => messages.push(message));
  child.stdout.on("data", (chunk) => parse(chunk));
  child.stdin.write(
    encodeMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "codeq-test", version: "0" },
      },
    }),
  );
  const started = Date.now();
  while (Date.now() - started < 2000 && messages.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(messages[0]?.result?.serverInfo?.name, "codeq");
  assert.deepEqual(
    messages[0]?.result?.capabilities,
    { tools: {} },
  );
});

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
  assert.match(stdout, /--regex/);
  assert.match(stdout, /--cursor TOKEN/);
  assert.match(stdout, /--count/);
  assert.match(stdout, /--ignore-case/);
  assert.match(stdout, /--case-sensitive/);
  assert.match(stdout, /--context N/);
  assert.match(stdout, /graph/);
  assert.equal(stdout.includes("--full"), false);
});

test("CLI rejects --count on find and mixed case flags", () => {
  let countOnFind = false;
  try {
    run(["find", "foo", "--count"]);
  } catch (error) {
    countOnFind = true;
    assert.match(error.stderr, /--count is not valid for find/);
    assert.equal(error.status, 2);
  }
  assert.equal(countOnFind, true);

  let mixed = false;
  try {
    run(["grep", "foo", "--ignore-case", "--case-sensitive"]);
  } catch (error) {
    mixed = true;
    assert.match(error.stderr, /cannot use --ignore-case and --case-sensitive together/);
    assert.equal(error.status, 2);
  }
  assert.equal(mixed, true);
});

test("human CLI grep --context uses the same neighbor locators as MCP", async () => {
  const { formatMcpToolResult } = await import("../src/mcp-format.js");
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "match",
    mode: "plain",
    context: 2,
    results: [
      {
        path: "src/app.ts",
        line: 10,
        column: 1,
        text: "const match = 1;",
        contextBefore: ["const a = 1;", "const b = 2;"],
        contextAfter: ["const c = 3;", "const d = 4;"],
      },
    ],
  });
  assert.match(formatted.map, /^src\/app\.ts:8 const a = 1;$/m);
  assert.match(formatted.map, /^src\/app\.ts:10 const match = 1;$/m);
  assert.match(formatted.map, /^src\/app\.ts:12 const d = 4;$/m);
});

test("CLI rejects --full", () => {
  let failed = false;
  try {
    run(["--full", "graph", "foo"]);
  } catch (error) {
    failed = true;
    assert.match(error.stderr, /no --full or --detail/);
    assert.equal(error.status, 2);
  }
  assert.equal(failed, true);
});

test("mcp help describes the stdio server", () => {
  const stdout = run(["mcp", "--help"]);
  assert.match(stdout, /stdio MCP server/);
  assert.match(stdout, /find, grep, and graph/);
  assert.match(stdout, /roots\/list/);
  assert.match(stdout, /codeq-mcp/);
  assert.match(stdout, /does not index/);
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

test("codeq mcp replies to OpenCode NDJSON initialize without Content-Length", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [bin, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    stdout = Buffer.concat([stdout, chunk]);
  });
  child.stdin.write(
    Buffer.from(
      "7b226d6574686f64223a22696e697469616c697a65222c22706172616d73223a7b2270726f746f636f6c56657273696f6e223a22323032352d31312d3235222c226361706162696c6974696573223a7b22726f6f7473223a7b7d7d2c22636c69656e74496e666f223a7b226e616d65223a226f70656e636f6465222c2276657273696f6e223a22312e31382e3331227d7d2c226a736f6e727063223a22322e30222c226964223a307d0a",
      "hex",
    ),
  );
  const started = Date.now();
  while (Date.now() - started < 2000 && !stdout.includes(0x0a)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  const text = stdout.toString("utf8");
  assert.notEqual(text.length, 0, "OpenCode initialize must get a stdout reply");
  assert.equal(text.includes("Content-Length:"), false);
  assert.match(text, /^\{/);
  assert.match(text, /\}\n$/);
  const reply = JSON.parse(text.trim());
  assert.equal(reply.id, 0);
  assert.equal(reply.result.protocolVersion, "2025-06-18");
  assert.equal(reply.result.serverInfo.name, "codeq");
});

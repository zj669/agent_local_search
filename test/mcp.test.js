import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createFramedParser,
  createMcpServer,
  encodeMessage,
  negotiateProtocolVersion,
} from "../src/mcp.js";
import { parseMcpToolText } from "../src/mcp-format.js";

const { version } = createRequire(import.meta.url)("../package.json");

function collectMessages(stream) {
  const messages = [];
  const parse = createFramedParser((message) => messages.push(message));
  stream.on("data", (chunk) => {
    parse(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  return messages;
}

async function waitFor(messages, predicate, timeout = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const match = messages.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for MCP message: ${JSON.stringify(messages)}`);
}

async function withServer(options, fn) {
  const input = new PassThrough();
  const output = new PassThrough();
  const raw = [];
  output.on("data", (chunk) => {
    raw.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
  });
  const messages = collectMessages(output);
  const server = createMcpServer({
    cwd: "/tmp/workspace",
    query: async (request) => ({
      root: request.root || request.cwd,
      status: "ready",
      warning: null,
      total: 0,
      results: [],
      result: "graph-output",
      request,
    }),
    ...options,
  });
  server.attach(input, output);
  await fn({
    input,
    messages,
    send(message, framing = "content-length") {
      input.write(encodeMessage(message, framing));
    },
    writeRaw(buffer) {
      input.write(buffer);
    },
    rawOutput() {
      return Buffer.concat(raw);
    },
    waitFor(predicate) {
      return waitFor(messages, predicate);
    },
    server,
  });
  input.end();
}

test("negotiates a protocol version the server supports", () => {
  assert.equal(negotiateProtocolVersion("2024-11-05"), "2024-11-05");
  assert.equal(negotiateProtocolVersion("2025-03-26"), "2025-03-26");
  assert.equal(negotiateProtocolVersion("not-a-version"), "2025-06-18");
  assert.equal(negotiateProtocolVersion("2025-11-25"), "2025-06-18");
});

test("framed parser reassembles split headers and bodies", () => {
  const messages = [];
  const parse = createFramedParser((message) => messages.push(message));
  const encoded = encodeMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
  parse(encoded.subarray(0, 8));
  parse(encoded.subarray(8, 20));
  parse(encoded.subarray(20));
  assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
});

// OpenCode 1.18.31 stdin: 170-byte NDJSON initialize, hex ends 7d0a (`}\n`).
const OPENCODE_INITIALIZE = Buffer.from(
  "7b226d6574686f64223a22696e697469616c697a65222c22706172616d73223a7b2270726f746f636f6c56657273696f6e223a22323032352d31312d3235222c226361706162696c6974696573223a7b22726f6f7473223a7b7d7d2c22636c69656e74496e666f223a7b226e616d65223a226f70656e636f6465222c2276657273696f6e223a22312e31382e3331227d7d2c226a736f6e727063223a22322e30222c226964223a307d0a",
  "hex",
);

test("OpenCode NDJSON initialize is a complete frame without Content-Length", () => {
  assert.equal(OPENCODE_INITIALIZE.length, 170);
  assert.equal(OPENCODE_INITIALIZE[OPENCODE_INITIALIZE.length - 2], 0x7d);
  assert.equal(OPENCODE_INITIALIZE[OPENCODE_INITIALIZE.length - 1], 0x0a);
  assert.equal(OPENCODE_INITIALIZE.toString("utf8").includes("Content-Length"), false);

  const messages = [];
  const framings = [];
  const parse = createFramedParser((message, framing) => {
    messages.push(message);
    framings.push(framing);
  });
  parse(OPENCODE_INITIALIZE.subarray(0, 40));
  assert.equal(messages.length, 0);
  parse(OPENCODE_INITIALIZE.subarray(40, 90));
  assert.equal(messages.length, 0);
  parse(OPENCODE_INITIALIZE.subarray(90));
  assert.equal(messages.length, 1);
  assert.deepEqual(framings, ["ndjson"]);
  assert.equal(messages[0].method, "initialize");
  assert.equal(messages[0].id, 0);
  assert.equal(messages[0].params.protocolVersion, "2025-11-25");
  assert.deepEqual(messages[0].params.capabilities, { roots: {} });
  assert.equal(messages[0].params.clientInfo.name, "opencode");
});

test("NDJSON replies omit Content-Length and keep Content-Length replies framed", () => {
  const ndjson = encodeMessage({ jsonrpc: "2.0", id: 0, method: "ping" }, "ndjson");
  const ndjsonText = ndjson.toString("utf8");
  assert.equal(ndjsonText.includes("Content-Length"), false);
  assert.equal(ndjsonText.endsWith("\n"), true);
  assert.equal(ndjsonText.slice(0, -1).includes("\n"), false);

  const framed = encodeMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.match(framed.toString("utf8"), /^Content-Length: \d+\r\n\r\n/);
});

test("OpenCode NDJSON handshake: initialize → initialized → tools/list → find", async () => {
  await withServer({}, async ({ send, writeRaw, waitFor, rawOutput, input }) => {
    writeRaw(OPENCODE_INITIALIZE);
    const init = await waitFor((message) => message.id === 0);
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "codeq");
    assert.equal(init.result.serverInfo.version, version);
    const initBytes = rawOutput().toString("utf8");
    assert.equal(initBytes.includes("Content-Length:"), false);
    assert.match(initBytes, /^\{/);
    assert.match(initBytes, /\}\n$/);

    send({ jsonrpc: "2.0", method: "notifications/initialized" }, "ndjson");
    const listRoots = await waitFor((message) => message.method === "roots/list");
    assert.equal(rawOutput().toString("utf8").includes("Content-Length:"), false);
    input.write(
      encodeMessage(
        {
          jsonrpc: "2.0",
          id: listRoots.id,
          result: { roots: [{ uri: "file:///tmp/workspace", name: "workspace" }] },
        },
        "ndjson",
      ),
    );

    send({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "ndjson");
    const listed = await waitFor((message) => message.id === 1);
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ["find", "grep", "graph"],
    );

    send(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "find", arguments: { query: "app.ts" } },
      },
      "ndjson",
    );
    const find = await waitFor((message) => message.id === 2);
    assert.equal(find.result.isError, undefined);
    assert.match(find.result.content[0].text, /^\[ready\]/);

    send(
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: {
          requestId: 2,
          reason: "AbortError: The operation was aborted.",
        },
      },
      "ndjson",
    );

    const all = rawOutput().toString("utf8");
    assert.equal(all.includes("Content-Length:"), false);
    for (const line of all.split("\n").filter(Boolean)) {
      JSON.parse(line);
    }
  });
});

test("replies use the framing of each request", async () => {
  await withServer({}, async ({ send, waitFor, rawOutput }) => {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    await waitFor((message) => message.id === 1);
    const afterFramed = rawOutput().toString("utf8");
    assert.match(afterFramed, /^Content-Length: /);

    const framedLength = rawOutput().length;
    send({ jsonrpc: "2.0", id: 2, method: "ping" }, "ndjson");
    await waitFor((message) => message.id === 2);
    const ndjsonReply = rawOutput().subarray(framedLength).toString("utf8");
    assert.equal(ndjsonReply.includes("Content-Length:"), false);
    assert.match(ndjsonReply, /^\{/);
    assert.match(ndjsonReply, /\}\n$/);
    assert.equal(JSON.parse(ndjsonReply.trim()).id, 2);
  });
});

test("initialize advertises only find, grep, and graph", async () => {
  await withServer({}, async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    const init = await waitFor((message) => message.id === 1);
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.equal(init.result.serverInfo.name, "codeq");
    assert.equal(init.result.serverInfo.version, version);
    assert.match(init.result.instructions, /never ask the user to init/i);
    assert.match(init.result.instructions, /graph: how code works/i);
    assert.match(init.result.instructions, /There is no callers tool/i);
    assert.match(init.result.instructions, /detail: "full"/i);

    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await waitFor((message) => message.id === 2);
    const names = listed.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, ["find", "grep", "graph"]);
    for (const banned of [
      "start",
      "stop",
      "status",
      "sync",
      "rescan",
      "callers",
      "callees",
      "health",
    ]) {
      assert.equal(names.includes(banned), false);
    }
  });
});

test("tools map 1:1 onto daemon find/grep/graph requests", async () => {
  const seen = [];
  await withServer(
    {
      query: async (request) => {
        seen.push(request);
        return {
          root: "/repo",
          status: "indexing",
          warning: null,
          total: 1,
          results: [{ path: "src/app.ts" }],
          result: "explore",
        };
      },
    },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {} },
      });
      await waitFor((message) => message.id === 1);

      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "find",
          arguments: { query: "app.ts", path: "src", limit: 5 },
        },
      });
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "grep",
          arguments: {
            pattern: "TODO",
            glob: "**/*.ts",
            context: 1,
            root: "/repo",
            limit: 8,
          },
        },
      });
      send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "graph",
          arguments: { query: "auth session", path: "../other" },
        },
      });

      const find = await waitFor((message) => message.id === 2);
      const grep = await waitFor((message) => message.id === 3);
      const graph = await waitFor((message) => message.id === 4);

      assert.equal(find.result.isError, undefined);
      assert.equal(parseMcpToolText(find.result.content[0].text).command, "find");
      assert.equal(parseMcpToolText(grep.result.content[0].text).command, "grep");
      assert.equal(parseMcpToolText(graph.result.content[0].text).command, "graph");
      assert.match(find.result.content[0].text, /^\[indexing\]/);

      assert.deepEqual(seen[0], {
        command: "find",
        cwd: "/tmp/workspace",
        query: "app.ts",
        path: "src",
        limit: 5,
      });
      assert.deepEqual(seen[1], {
        command: "grep",
        cwd: "/tmp/workspace",
        query: "TODO",
        glob: "**/*.ts",
        context: 1,
        root: "/repo",
        limit: 8,
      });
      assert.deepEqual(seen[2], {
        command: "graph",
        cwd: "/tmp/workspace",
        query: "auth session",
        path: "../other",
      });
    },
  );
});

test("unknown tools and daemon failures are tool errors, not extra commands", async () => {
  await withServer(
    {
      query: async () => {
        throw new Error("boom");
      },
    },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      });
      await waitFor((message) => message.id === 1);

      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "sync", arguments: {} },
      });
      const unknown = await waitFor((message) => message.id === 2);
      assert.equal(unknown.result.isError, true);
      assert.match(unknown.result.content[0].text, /unknown tool/);

      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "find", arguments: { query: "x" } },
      });
      const failed = await waitFor((message) => message.id === 3);
      assert.equal(failed.result.isError, true);
      assert.equal(failed.result.content[0].text, "boom");
    },
  );
});

test("path/root and cwd switch a single root with no fusion", async () => {
  const seen = [];
  await withServer(
    {
      query: async (request) => {
        seen.push(request);
        return { root: request.root || request.path, status: "ready" };
      },
    },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {} },
      });
      await waitFor((message) => message.id === 1);
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "find",
          arguments: {
            query: "main.go",
            cwd: "/repos/alpha",
            path: "../beta",
          },
        },
      });
      await waitFor((message) => message.id === 2);
      assert.deepEqual(seen[0], {
        command: "find",
        cwd: "/repos/alpha",
        query: "main.go",
        path: "../beta",
      });
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "find", arguments: { query: "widget" } },
      });
      await waitFor((message) => message.id === 3);
      assert.equal(seen[1].cwd, "/tmp/workspace");
      assert.equal(seen[1].path, undefined);
      assert.equal(seen[1].root, undefined);
    },
  );
});

test("uses client roots as the session cwd, like pi-fff ctx.cwd", async () => {
  const seen = [];
  await withServer(
    {
      query: async (request) => {
        seen.push(request);
        return { root: request.cwd, status: "ready", results: [] };
      },
    },
    async ({ send, waitFor, input }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: { roots: { listChanged: true } },
        },
      });
      await waitFor((message) => message.id === 1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const listRoots = await waitFor(
        (message) => message.method === "roots/list",
      );
      input.write(
        encodeMessage({
          jsonrpc: "2.0",
          id: listRoots.id,
          result: { roots: [{ uri: "file:///repos/workspace", name: "workspace" }] },
        }),
      );
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "find", arguments: { query: "pkg" } },
      });
      await waitFor((message) => message.id === 2);
      assert.equal(seen[0].cwd, "/repos/workspace");

      send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
      const relist = await waitFor(
        (message) => message.method === "roots/list" && message.id !== listRoots.id,
      );
      input.write(
        encodeMessage({
          jsonrpc: "2.0",
          id: relist.id,
          result: { roots: [{ uri: "file:///repos/other", name: "other" }] },
        }),
      );
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "find", arguments: { query: "pkg" } },
      });
      await waitFor((message) => message.id === 3);
      assert.equal(seen[1].cwd, "/repos/other");
    },
  );
});

test("defaults to process.cwd and ignores CODEQ_CWD-style path env", async () => {
  const previous = process.env.CODEQ_CWD;
  process.env.CODEQ_CWD = "/env/should-not-win";
  const seen = [];
  try {
    await withServer(
      {
        cwd: undefined,
        query: async (request) => {
          seen.push(request);
          return { root: request.cwd, status: "ready", results: [] };
        },
      },
      async ({ send, waitFor }) => {
        send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {} },
        });
        await waitFor((message) => message.id === 1);
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "find", arguments: { query: "pkg" } },
        });
        await waitFor((message) => message.id === 2);
        assert.equal(seen[0].cwd, process.cwd());
        assert.notEqual(seen[0].cwd, "/env/should-not-win");
      },
    );
  } finally {
    if (previous === undefined) delete process.env.CODEQ_CWD;
    else process.env.CODEQ_CWD = previous;
  }
});

test("tool schemas do not mention a workspace path env", async () => {
  await withServer({}, async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {} },
    });
    await waitFor((message) => message.id === 1);
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await waitFor((message) => message.id === 2);
    const blob = JSON.stringify(listed.result.tools);
    assert.equal(blob.includes("CODEQ_CWD"), false);
    const grep = listed.result.tools.find((tool) => tool.name === "grep");
    assert.equal(Boolean(grep.inputSchema.properties.limit), true);
    assert.equal(Boolean(grep.inputSchema.properties.detail), true);
    for (const tool of listed.result.tools) {
      assert.equal(Boolean(tool.inputSchema.properties.path), true);
      assert.equal(Boolean(tool.inputSchema.properties.root), true);
    }
  });
});

test("MCP replies start with freshness and keep a graph budget", async () => {
  await withServer(
    {
      query: async () => ({
        status: "degraded",
        warning: "stale",
        lastSuccessfulSync: "2026-09-21T10:00:00.000Z",
        root: "/repo",
        result: `src/app.ts\n${"line\n".repeat(900)}`,
      }),
    },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {} },
      });
      await waitFor((message) => message.id === 1);
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "graph", arguments: { query: "auth" } },
      });
      const graph = await waitFor((message) => message.id === 2);
      assert.match(
        graph.result.content[0].text,
        /^\[degraded\] root \/repo lastSuccessfulSync /,
      );
      const payload = parseMcpToolText(graph.result.content[0].text);
      assert.equal(payload.truncated, true);
      assert.equal(payload.result, undefined);
      assert.match(payload.hint, /detail: "full"/);
    },
  );
});

test("README default MCP snippet uses global codeq and spawn cwd, not CODEQ_CWD", () => {
  const readme = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"),
    "utf8",
  );
  assert.equal(readme.includes("CODEQ_CWD"), true);
  assert.match(readme, /Do not set `CODEQ_CWD`/);
  const firstSnippet = readme.split("```json")[1].split("```")[0];
  assert.match(firstSnippet, /"command": "codeq"/);
  assert.match(firstSnippet, /"cwd": "\$\{workspaceFolder\}"/);
  assert.equal(firstSnippet.includes("npx"), false);
  assert.equal(firstSnippet.includes("CODEQ_CWD"), false);
  assert.match(readme, /spawn working directory/);
});

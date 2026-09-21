import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { queryDaemon } from "./client.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

const TOOLS = [
  {
    name: "find",
    title: "Find files",
    description:
      "Find files by name or path using the local codeq index (FFF). Indexes the selected root automatically on first use; never ask the user to init or create a project-local index. Pass path or root to search a different repository. Each call uses exactly one root; results from multiple repositories are never merged.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "File name or path fragment to search for",
        },
        path: {
          type: "string",
          description:
            "Optional path constraint relative to cwd. If it points at another repository, that root is used instead.",
        },
        root: {
          type: "string",
          description:
            "Optional explicit index root. Overrides Git/cwd detection for this call.",
        },
        cwd: {
          type: "string",
          description:
            "Working directory for resolving relative path/root. Defaults to the workspace or CODEQ_CWD.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum number of file matches to return",
        },
      },
      required: ["query"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "grep",
    title: "Search file contents",
    description:
      "Search file contents using the local codeq index (FFF). Indexes the selected root automatically on first use; never ask the user to init. Pass path or root to search a different repository. Each call uses exactly one root; results from multiple repositories are never merged.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Text pattern to search for",
        },
        path: {
          type: "string",
          description:
            "Optional path constraint relative to cwd. If it points at another repository, that root is used instead.",
        },
        root: {
          type: "string",
          description:
            "Optional explicit index root. Overrides Git/cwd detection for this call.",
        },
        cwd: {
          type: "string",
          description:
            "Working directory for resolving relative path/root. Defaults to the workspace or CODEQ_CWD.",
        },
        glob: {
          type: "string",
          description: "Optional glob used to constrain matches, for example **/*.ts",
        },
        context: {
          type: "integer",
          minimum: 0,
          description: "Number of context lines before and after each match",
        },
      },
      required: ["pattern"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "graph",
    title: "Explore the code graph",
    description:
      "Explore related symbols and files with CodeGraph explore. Indexes the selected root automatically on first use; never ask the user to init or write a .codegraph directory into the project. Pass path or root to query a different repository. Each call uses exactly one root.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language or symbol query for related code and relationships",
        },
        path: {
          type: "string",
          description:
            "Optional path constraint relative to cwd. If it points at another repository, that root is used instead.",
        },
        root: {
          type: "string",
          description:
            "Optional explicit index root. Overrides Git/cwd detection for this call.",
        },
        cwd: {
          type: "string",
          description:
            "Working directory for resolving relative path/root. Defaults to the workspace or CODEQ_CWD.",
        },
      },
      required: ["query"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
];

export function negotiateProtocolVersion(requested) {
  if (PROTOCOL_VERSIONS.includes(requested)) return requested;
  return PROTOCOL_VERSIONS[0];
}

export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body,
  ]);
}

export function createFramedParser(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = findHeaderEnd(buffer);
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const length = parseContentLength(header);
      if (length === null) {
        throw new Error("MCP message is missing Content-Length");
      }
      const bodyStart = headerEnd;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length);
      buffer = buffer.subarray(bodyStart + length);
      onMessage(JSON.parse(body.toString("utf8")));
    }
  };
}

function findHeaderEnd(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) return crlf + 4;
  const lf = buffer.indexOf("\n\n");
  if (lf >= 0) return lf + 2;
  return -1;
}

function parseContentLength(header) {
  for (const line of header.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    if (name === "content-length") {
      const value = Number(line.slice(separator + 1).trim());
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`invalid Content-Length: ${line}`);
      }
      return value;
    }
  }
  return null;
}

function defaultCwd(override) {
  if (override) return override;
  if (process.env.CODEQ_CWD) return process.env.CODEQ_CWD;
  return process.cwd();
}

function fileUriToPath(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function positiveInteger(value, name, allowZero = false) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (allowZero ? parsed < 0 : parsed < 1)
  ) {
    throw new Error(
      `${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`,
    );
  }
  return parsed;
}

function toolRequest(name, args, cwd) {
  if (name === "find") {
    if (typeof args.query !== "string" || args.query.trim() === "") {
      throw new Error("find requires query");
    }
    const request = {
      command: "find",
      cwd,
      query: args.query,
    };
    if (args.path !== undefined) request.path = String(args.path);
    if (args.root !== undefined) request.root = String(args.root);
    if (args.limit !== undefined) {
      request.limit = positiveInteger(args.limit, "limit");
    }
    return request;
  }
  if (name === "grep") {
    if (typeof args.pattern !== "string" || args.pattern.trim() === "") {
      throw new Error("grep requires pattern");
    }
    const request = {
      command: "grep",
      cwd,
      query: args.pattern,
    };
    if (args.path !== undefined) request.path = String(args.path);
    if (args.root !== undefined) request.root = String(args.root);
    if (args.glob !== undefined) request.glob = String(args.glob);
    if (args.context !== undefined) {
      request.context = positiveInteger(args.context, "context", true);
    }
    return request;
  }
  if (name === "graph") {
    if (typeof args.query !== "string" || args.query.trim() === "") {
      throw new Error("graph requires query");
    }
    const request = {
      command: "graph",
      cwd,
      query: args.query,
    };
    if (args.path !== undefined) request.path = String(args.path);
    if (args.root !== undefined) request.root = String(args.root);
    return request;
  }
  throw new Error(`unknown tool: ${name}`);
}

function jsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

export function createMcpServer({
  query = queryDaemon,
  cwd: fallbackCwd,
} = {}) {
  let workspaceCwd = defaultCwd(fallbackCwd);
  let clientSupportsRoots = false;
  let rootsPromise = Promise.resolve();
  const pending = new Map();
  const inFlight = new Map();
  let nextServerId = 1;
  let send = () => {};

  const serverInfo = {
    name: "codeq",
    version,
  };

  function respond(message) {
    send(message);
  }

  async function requestClient(method, params) {
    const id = `codeq-${nextServerId++}`;
    const result = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    send({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  async function refreshRoots() {
    if (!clientSupportsRoots) return;
    try {
      const result = await requestClient("roots/list");
      const root = result?.roots?.find((entry) => entry?.uri?.startsWith("file:"));
      const path = fileUriToPath(root?.uri);
      if (path) workspaceCwd = path;
    } catch {}
  }

  async function callTool(name, args, meta, signal) {
    await rootsPromise;
    const request = toolRequest(name, args ?? {}, args?.cwd || workspaceCwd);
    const result = await query(request, {
      signal,
      onProgress: (progress) => {
        if (meta?.progressToken === undefined) return;
        send({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: meta.progressToken,
            progress: progress.current ?? 0,
            total: progress.total,
            message:
              progress.message ||
              `${progress.phase || "indexing"}${
                progress.total ? ` ${progress.current}/${progress.total}` : ""
              }`,
          },
        });
      },
    });
    const payload = { command: name, ...result };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
  }

  async function handleMessage(message) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      respond(jsonRpcError(null, -32600, "invalid request"));
      return;
    }

    if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message || "client error"));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    const { id, method, params } = message;
    const isNotification = id === undefined;

    if (method === "notifications/cancelled") {
      const requestId = params?.requestId;
      inFlight.get(requestId)?.abort();
      return;
    }
    if (method === "notifications/initialized") {
      rootsPromise = refreshRoots();
      return;
    }
    if (isNotification) return;

    if (method === "initialize") {
      clientSupportsRoots = Boolean(params?.capabilities?.roots);
      respond({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: {
            tools: {},
          },
          serverInfo,
          instructions:
            "codeq searches one local repository at a time with find, grep, and graph. Indexes are created automatically on first use. Use path or root to switch repositories; never merge results across roots, and never ask the user to init or create a .codegraph directory.",
        },
      });
      return;
    }

    if (method === "ping") {
      respond({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      respond({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    }

    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (!TOOLS.some((tool) => tool.name === name)) {
        respond({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `unknown tool: ${name}` }],
            isError: true,
          },
        });
        return;
      }
      const controller = new AbortController();
      inFlight.set(id, controller);
      try {
        const result = await callTool(name, args, params?._meta, controller.signal);
        respond({ jsonrpc: "2.0", id, result });
      } catch (error) {
        respond({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: error.message || String(error),
              },
            ],
            isError: true,
          },
        });
      } finally {
        inFlight.delete(id);
      }
      return;
    }

    respond(jsonRpcError(id ?? null, -32601, `method not found: ${method}`));
  }

  return {
    attach(input, output) {
      send = (message) => {
        if (output.writableEnded || output.destroyed) return;
        output.write(encodeMessage(message));
      };
      const parse = createFramedParser((message) => {
        handleMessage(message).catch((error) => {
          process.stderr.write(`codeq mcp: ${error.message}\n`);
        });
      });
      input.on("data", (chunk) => {
        try {
          parse(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        } catch (error) {
          send(jsonRpcError(null, -32700, error.message));
        }
      });
    },
    handleMessage,
    setSend(fn) {
      send = fn;
    },
    get cwd() {
      return workspaceCwd;
    },
  };
}

export async function runMcpServer(options = {}) {
  const server = createMcpServer(options);
  process.stdin.resume();
  server.attach(process.stdin, process.stdout);
  await new Promise((resolve) => {
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
  });
}

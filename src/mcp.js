import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { queryDaemon } from "./client.js";
import { formatMcpToolResult, MCP_INSTRUCTIONS } from "./mcp-format.js";
import { isUnusableWorkspace } from "./paths.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

const ROOTS_LIST_TIMEOUT_MS = 5_000;

const PATH_PROPERTY = {
  type: "string",
  description:
    "Narrow this one call inside the selected repository: a directory (src/, mr_review_service, mr_review_service/profiles) or a single file (src/leagent/chat/policy_selector.py). This is the only way to scope a search, and it never creates or switches an index: every path in a repository reuses that repository's one index. A relative path is joined to root when root is passed, otherwise to the session cwd; absolute, ~/, and ../ paths that leave the workspace switch to that repository, but prefer root for that. A path that does not exist is an error that names the absolute path tried, not a silent search of the whole repository. Each call uses exactly one root.",
};

const ROOT_PROPERTY = {
  type: "string",
  description:
    "Absolute path of the repository, checkout, or worktree to search, for this call only, overriding Git/cwd detection. Pass it whenever the repository you are asking about is not the session cwd: a second clone, another checkout or worktree, or any repository when the server was spawned from $HOME. Omitting it silently searches the session cwd, which is the wrong tree when your question is about another repository. root is the only thing that selects an index, and one repository has one index: a subdirectory or a file passed as root resolves to the repository that holds it, narrowed to that subdirectory or file, and says so in the reply. To scope a search, keep root at the checkout and pass path. Every reply names the resolved root and where it came from; if that root is not the repository you meant, retry with root.",
};

export const NO_WORKSPACE_ERROR =
  "no workspace (spawned from home). Pass path or root to a repository on this call.";

const CWD_PROPERTY = {
  type: "string",
  description:
    "Working directory for resolving relative path/root. Defaults to the MCP client's session workspace (roots/list) or process.cwd() when that is a real project, not $HOME or /.",
};

const LIMIT_PROPERTY = {
  type: "integer",
  minimum: 1,
  description: "Maximum number of matches to return",
};

const DETAIL_PROPERTY = {
  type: "string",
  enum: ["summary", "full"],
  description:
    'summary (default) is layer 0: the resolved root, the hit symbols, the files to open next with their relevant line ranges, and what depends on them — no source code, because opening those files yourself is cheaper than us forwarding them. full is layer 1: the whole layer 0 map repeated verbatim, then source (graph) or full match text and metadata (grep/find). Pass full only when you need to quote the code; when a reply says it omitted something, it also says how to get just that part.',
};

const FRESHNESS_SCHEMA = {
  status: { type: ["string", "null"] },
  warning: { type: ["string", "null"] },
  lastSuccessfulSync: { type: ["string", "null"] },
  root: { type: ["string", "null"] },
  rootSource: { type: ["string", "null"] },
  rootNote: { type: ["string", "null"] },
  cwdSource: { type: ["string", "null"] },
  command: { type: "string" },
  detail: { type: "string", enum: ["summary", "full"] },
};

const OUTPUT_SCHEMA_NOTE =
  "Machine fields only. The text block is self-contained and is NOT a serialized copy of this object: codeq deliberately does not repeat the JSON in the text channel (MCP 2025-06-18 SHOULD), because that duplication is what the layered format exists to remove. A client that ignores structuredContent loses numbers, never a decision.";

const TOOLS = [
  {
    name: "find",
    title: "Find files",
    description:
      "Find files by name or path using the local codeq index (FFF). Indexes the selected root automatically on first use; never ask the user to init or create a project-local index. Pass root to search a different repository and path to narrow inside one. Each call uses exactly one root; results from multiple repositories are never merged.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "File name or path fragment, matched fuzzily against every indexed path, for example leagent.py, profiles/leagent, profile, or SKILL.md. Dotfiles and dot-directories such as .claude/skills and .cursor/rules are indexed, so look for skills and rules here instead of a native glob tool. Glob syntax is not supported: **/*profile* matches nothing, pass profile instead.",
        },
        path: PATH_PROPERTY,
        root: ROOT_PROPERTY,
        cwd: CWD_PROPERTY,
        limit: LIMIT_PROPERTY,
        detail: DETAIL_PROPERTY,
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      description: OUTPUT_SCHEMA_NOTE,
      properties: {
        ...FRESHNESS_SCHEMA,
        query: { type: "string" },
        shown: { type: "integer" },
        matched: { type: "integer" },
        indexed: { type: ["integer", "null"] },
        paths: { type: "array", items: { type: "string" } },
        weakFolded: { type: "integer" },
        results: {
          type: "array",
          description: 'Only filled when detail is "full".',
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              score: { type: ["number", "null"] },
              matchType: { type: ["string", "null"] },
            },
          },
        },
      },
      required: ["status", "root", "command", "shown", "paths"],
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
      "Search file contents using the local codeq index (FFF). Auto-detects regex and rejects all-match patterns like .*. Matching is exact by default: zero hits means zero hits, and nothing is silently re-run as fuzzy. Pass fuzzy true to also accept approximate names; those replies are labelled [fuzzy] on the first line and name DIFFERENT identifiers. Indexes the selected root automatically on first use; never ask the user to init. Pass root to search a different repository and path to narrow inside one. Each call uses exactly one root; results from multiple repositories are never merged.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "One identifier or one regex, for example focus_item_sources or reply_.*_actor. Regex is auto-detected, so no mode flag is needed. Search one name per call instead of an or-chain of unrelated names.",
        },
        path: PATH_PROPERTY,
        root: ROOT_PROPERTY,
        cwd: CWD_PROPERTY,
        glob: {
          type: "string",
          description: "Optional glob used to constrain matches, for example **/*.ts",
        },
        context: {
          type: "integer",
          minimum: 0,
          description: "Number of context lines before and after each match",
        },
        fuzzy: {
          type: "boolean",
          description:
            "Default false. When the exact pattern has zero hits, also try approximate matching. Those results are NOT the same identifier — the reply is labelled [fuzzy] and names what it actually matched, so confirm the spelling before concluding anything from them. Leave it off when you know the identifier.",
        },
        limit: LIMIT_PROPERTY,
        detail: DETAIL_PROPERTY,
      },
      required: ["pattern"],
    },
    outputSchema: {
      type: "object",
      description: OUTPUT_SCHEMA_NOTE,
      properties: {
        ...FRESHNESS_SCHEMA,
        pattern: { type: "string" },
        mode: { type: "string", enum: ["plain", "regex", "fuzzy"] },
        fuzzy: { type: "boolean" },
        shown: { type: "integer" },
        moreRemain: { type: "boolean" },
        paths: { type: "array", items: { type: "string" } },
        hits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              line: { type: "integer" },
              column: { type: "integer" },
              text: { type: "string" },
            },
          },
        },
      },
      required: ["status", "root", "command", "shown", "moreRemain", "paths"],
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
      "Explore related symbols and files with CodeGraph explore. Returns a map of the code — hit symbols, the files to open next with their relevant line ranges, and the blast radius — to read next, not a written answer, so expect to open the files it names with your own Read. Do not look for a callers tool. Indexes the selected root automatically on first use; never ask the user to init or write a .codegraph directory into the project. Pass root to query a different repository and path to narrow inside one. Each call uses exactly one root. The default reply is layer 0 and carries no source code; pass detail full for layer 1, which repeats the map and then adds source with the query's target file first.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Identifiers, or "how does X work" where X is identifiers, for example "GlobalAgent prepare_planner saas_reply_planner" or "how does saas_message build CommandReplyResponse". Identifier-shaped queries match the graph; a multi-paragraph question does not.',
        },
        path: PATH_PROPERTY,
        root: ROOT_PROPERTY,
        cwd: CWD_PROPERTY,
        detail: DETAIL_PROPERTY,
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      description: OUTPUT_SCHEMA_NOTE,
      properties: {
        ...FRESHNESS_SCHEMA,
        query: { type: ["string", "null"] },
        exactHits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              path: { type: "string" },
              line: { type: ["integer", "null"] },
            },
          },
        },
        files: {
          type: "array",
          description: "The files to open next, in the order the map lists them.",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              symbols: { type: "array", items: { type: "string" } },
              symbolCount: { type: "integer" },
              renderedLines: {
                type: ["array", "null"],
                items: { type: "integer" },
              },
            },
          },
        },
        paths: {
          type: "array",
          description: "Same file list as files[].path: what to open next, nothing else.",
          items: { type: "string" },
        },
        alsoRanked: { type: "array", items: { type: "string" } },
        omitted: {
          type: "object",
          properties: {
            files: { type: "integer" },
            reason: { type: ["string", "null"] },
          },
        },
        sourceIncluded: { type: "boolean" },
      },
      required: ["status", "root", "command", "files", "paths", "sourceIncluded"],
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

export function encodeMessage(message, framing = "content-length") {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (framing === "ndjson") {
    return Buffer.concat([body, Buffer.from("\n", "utf8")]);
  }
  if (framing !== "content-length") {
    throw new Error(`unknown MCP framing: ${framing}`);
  }
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body,
  ]);
}

function parseJsonMessage(raw, framing) {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch (error) {
    error.framing = framing;
    throw error;
  }
}

export function createFramedParser(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      let start = 0;
      while (
        start < buffer.length &&
        (buffer[start] === 0x0a || buffer[start] === 0x0d)
      ) {
        start += 1;
      }
      if (start > 0) buffer = buffer.subarray(start);
      if (buffer.length === 0) return;

      if (buffer[0] === 0x7b || buffer[0] === 0x5b) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        let line = buffer.subarray(0, newline);
        if (line.length > 0 && line[line.length - 1] === 0x0d) {
          line = line.subarray(0, line.length - 1);
        }
        buffer = buffer.subarray(newline + 1);
        onMessage(parseJsonMessage(line, "ndjson"), "ndjson");
        continue;
      }

      const headerEnd = findHeaderEnd(buffer);
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const length = parseContentLength(header);
      if (length === null) {
        const error = new Error("MCP message is missing Content-Length");
        error.framing = "content-length";
        throw error;
      }
      const bodyStart = headerEnd;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length);
      buffer = buffer.subarray(bodyStart + length);
      onMessage(parseJsonMessage(body, "content-length"), "content-length");
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
    if (args.fuzzy !== undefined) request.fuzzy = Boolean(args.fuzzy);
    if (args.context !== undefined) {
      request.context = positiveInteger(args.context, "context", true);
    }
    if (args.limit !== undefined) {
      request.limit = positiveInteger(args.limit, "limit");
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
  const spawnCwd = defaultCwd(fallbackCwd);
  let workspaceCwd = isUnusableWorkspace(spawnCwd) ? null : spawnCwd;
  let workspaceCwdSource = workspaceCwd ? "spawn cwd" : null;
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

  async function requestClient(method, params, timeoutMs, framing) {
    const id = `codeq-${nextServerId++}`;
    const result = new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      if (timeoutMs) {
        waiter.timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error(`${method} timeout`));
        }, timeoutMs);
      }
      pending.set(id, waiter);
    });
    send({ jsonrpc: "2.0", id, method, params }, framing);
    return result;
  }

  async function refreshRoots(framing) {
    if (!clientSupportsRoots) return;
    try {
      const result = await requestClient(
        "roots/list",
        undefined,
        ROOTS_LIST_TIMEOUT_MS,
        framing,
      );
      const roots = result?.roots || [];
      for (const entry of roots) {
        const path = fileUriToPath(entry?.uri);
        if (path && !isUnusableWorkspace(path)) {
          workspaceCwd = path;
          workspaceCwdSource = "roots/list";
          return;
        }
      }
    } catch {}
  }

  function sessionCwd(args) {
    if (args?.cwd != null && String(args.cwd).trim() !== "") {
      if (!isUnusableWorkspace(args.cwd)) {
        return { cwd: String(args.cwd), source: "cwd argument" };
      }
    }
    return { cwd: workspaceCwd, source: workspaceCwd ? workspaceCwdSource : null };
  }

  async function callTool(name, args, meta, signal, framing) {
    await rootsPromise;
    const session = sessionCwd(args);
    const cwd = session.cwd;
    const hasPath = args?.path != null && String(args.path).trim() !== "";
    const hasRoot = args?.root != null && String(args.root).trim() !== "";
    if (!cwd && !hasPath && !hasRoot) {
      throw new Error(NO_WORKSPACE_ERROR);
    }
    const request = toolRequest(name, args ?? {}, cwd || spawnCwd);
    request.cwdSource = session.source ?? "spawn cwd";
    const result = await query(request, {
      signal,
      onProgress: (progress) => {
        if (meta?.progressToken === undefined) return;
        send(
          {
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
          },
          framing,
        );
      },
    });
    const formatted = formatMcpToolResult(name, result, {
      detail: args?.detail === "full" ? "full" : "summary",
    });
    return {
      content: [{ type: "text", text: formatted.text }],
      structuredContent: formatted.structuredContent,
    };
  }

  async function handleMessage(message, framing = "content-length") {
    const reply = (payload) => send(payload, framing);

    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      reply(jsonRpcError(null, -32600, "invalid request"));
      return;
    }

    if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (waiter.timer) clearTimeout(waiter.timer);
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
      rootsPromise = refreshRoots(framing);
      return;
    }
    if (method === "notifications/roots/list_changed") {
      rootsPromise = refreshRoots(framing);
      return;
    }
    if (isNotification) return;

    if (method === "initialize") {
      clientSupportsRoots = Boolean(params?.capabilities?.roots);
      reply({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: {
            tools: {},
          },
          serverInfo,
          instructions: MCP_INSTRUCTIONS,
        },
      });
      return;
    }

    if (method === "ping") {
      reply({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      reply({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    }

    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (!TOOLS.some((tool) => tool.name === name)) {
        reply({
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
        const result = await callTool(
          name,
          args,
          params?._meta,
          controller.signal,
          framing,
        );
        reply({ jsonrpc: "2.0", id, result });
      } catch (error) {
        reply({
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

    reply(jsonRpcError(id ?? null, -32601, `method not found: ${method}`));
  }

  return {
    attach(input, output) {
      send = (message, framing = "content-length") => {
        if (output.writableEnded || output.destroyed) return;
        output.write(encodeMessage(message, framing));
      };
      const parse = createFramedParser((message, framing) => {
        handleMessage(message, framing).catch((error) => {
          process.stderr.write(`codeq mcp: ${error.message}\n`);
        });
      });
      input.on("data", (chunk) => {
        try {
          parse(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        } catch (error) {
          send(
            jsonRpcError(null, -32700, error.message),
            error.framing || "content-length",
          );
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

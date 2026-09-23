/**
 * Native Pi extension factory. Registers find / grep / graph with those names
 * so they override Pi builtins (rg / fd). queryDaemon is injected by the
 * default entry and must only run inside execute, never while registering.
 */
import { Type } from "typebox";
import { EMPTY_TOOL_MENU } from "@zj669/codeq/src/mcp-format.js";

const PATH_DESCRIPTION =
  "Narrow this call inside the selected root; never selects an index. Relative paths are relative to that root.";

const ROOT_DESCRIPTION =
  "Repository/checkout/worktree for this call; overrides cwd/Git detection. Set it for cross-repo/worktree queries.";

const FIND_DESCRIPTION =
  "codeq fuzzy file/path lookup, including dotfiles — not Pi's builtin fd. Query is a path fragment, not a glob.";

const GREP_DESCRIPTION =
  "codeq literal string search by default; this is not rg and not Pi's builtin rg. Pass regex:true for a regular expression, fuzzy:true for approximate/different identifiers. Need nearby source for a hit, pass context (at most 3); this is not rg and not host Read. Returns matching lines.";

const GRAPH_DESCRIPTION =
  "codeq graph: identifiers, or a short question about how X works, where X is defined, or who calls / uses X. Returns an entry span, direct callees, and direct callers — a map, not an answer or source. For how-it-works, Read the entry. For who-calls or where-used, use the callers locators; do not grep that name first. Bounded neighborhood, not an exhaustive callgraph. There is no callers tool.";

function pathField() {
  return Type.Optional(Type.String({ description: PATH_DESCRIPTION }));
}

function rootField() {
  return Type.Optional(Type.String({ description: ROOT_DESCRIPTION }));
}

function limitField() {
  return Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Page size 1-48 (default 16). Values above 48 are capped; use cursor for more.",
    }),
  );
}

function stripAt(value) {
  if (typeof value !== "string") return value;
  return value.startsWith("@") ? value.slice(1) : value;
}

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value, name, allowZero = false) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed < 1)) {
    throw new Error(
      `${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`,
    );
  }
  return parsed;
}

function prepareShared(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const next = { ...args };
  if (next.path !== undefined) next.path = stripAt(next.path);
  if (next.root !== undefined) next.root = stripAt(next.root);
  delete next.cwd;
  delete next.literal;
  delete next.detail;
  return next;
}

function prepareFindArgs(args) {
  const next = prepareShared(args);
  if (!next || typeof next !== "object") return next;
  if (typeof next.query !== "string" && typeof next.pattern === "string") {
    next.query = next.pattern;
  }
  delete next.pattern;
  return next;
}

function prepareGrepArgs(args) {
  const next = prepareShared(args);
  if (!next || typeof next !== "object") return next;
  if (typeof next.pattern !== "string" && typeof next.query === "string") {
    next.pattern = next.query;
  }
  delete next.query;
  return next;
}

function sessionCwd(ctx) {
  const cwd = ctx?.cwd;
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new Error("codeq tools require session ctx.cwd");
  }
  return cwd;
}

function toolRequest(name, params, cwd) {
  if (name === "find") {
    if (typeof params.query !== "string" || params.query.trim() === "") {
      throw new Error(EMPTY_TOOL_MENU);
    }
    const request = {
      command: "find",
      cwd,
      query: params.query,
    };
    if (params.path !== undefined) request.path = String(params.path);
    if (params.root !== undefined) request.root = String(params.root);
    if (params.limit !== undefined) {
      request.limit = positiveInteger(params.limit, "limit");
    }
    return request;
  }
  if (name === "grep") {
    if (typeof params.pattern !== "string" || params.pattern.trim() === "") {
      throw new Error(EMPTY_TOOL_MENU);
    }
    const request = {
      command: "grep",
      cwd,
      query: params.pattern,
    };
    if (params.path !== undefined) request.path = String(params.path);
    if (params.root !== undefined) request.root = String(params.root);
    if (params.glob !== undefined) request.glob = String(params.glob);
    if (params.fuzzy !== undefined) request.fuzzy = Boolean(params.fuzzy);
    if (params.regex !== undefined) request.regex = Boolean(params.regex);
    if (params.cursor !== undefined) request.cursor = String(params.cursor);
    if (params.limit !== undefined) {
      request.limit = positiveInteger(params.limit, "limit");
    }
    if (params.context !== undefined) {
      request.context = positiveInteger(params.context, "context", true);
    }
    if (params.count !== undefined) request.count = Boolean(params.count);
    if (params.ignoreCase !== undefined) {
      request.ignoreCase = Boolean(params.ignoreCase);
    }
    return request;
  }
  if (name === "graph") {
    if (typeof params.query !== "string" || params.query.trim() === "") {
      throw new Error(EMPTY_TOOL_MENU);
    }
    const request = {
      command: "graph",
      cwd,
      query: params.query,
    };
    if (params.path !== undefined) request.path = String(params.path);
    if (params.root !== undefined) request.root = String(params.root);
    return request;
  }
  throw new Error(`unknown tool: ${name}`);
}

function paint(theme, color, text) {
  return theme?.fg ? theme.fg(color, text) : text;
}

function textComponent(text) {
  const lines = String(text).split("\n");
  return {
    render() {
      return lines;
    },
    invalidate() {},
  };
}

function renderCall(name, args, theme) {
  const title = paint(theme, "toolTitle", theme?.bold ? theme.bold(name) : name);
  const focus =
    name === "grep"
      ? trimString(args?.pattern)
      : trimString(args?.query) || trimString(args?.pattern);
  const path = trimString(args?.path) || trimString(args?.root) || ".";
  const body = focus
    ? `${title} ${paint(theme, "accent", focus)} ${paint(theme, "toolOutput", `in ${path}`)}`
    : `${title} ${paint(theme, "toolOutput", path)}`;
  return textComponent(body);
}

function renderResult(result, options, theme) {
  const output =
    result?.content?.find((part) => part.type === "text")?.text?.trim() ?? "";
  if (!output) {
    return textComponent(paint(theme, "muted", "No output"));
  }
  const color = result?.isError ? "error" : "toolOutput";
  const lines = output.split("\n");
  const shown = options?.expanded ? lines : lines.slice(0, 8);
  const painted = shown.map((line) => paint(theme, color, line));
  if (lines.length > shown.length) {
    painted.push(
      paint(theme, "muted", `... (${lines.length - shown.length} more lines)`),
    );
  }
  return textComponent(painted.join("\n"));
}

function progressText(progress = {}) {
  return (
    progress.message ||
    `${progress.phase || "indexing"}${
      progress.total ? ` ${progress.current}/${progress.total}` : ""
    }`
  );
}

export function createCodeqExtension({
  query,
  format,
  rerank = async (_name, _request, result) => result,
} = {}) {
  if (typeof query !== "function") {
    throw new Error("createCodeqExtension requires query");
  }
  if (typeof format !== "function") {
    throw new Error("createCodeqExtension requires format");
  }

  function executeTool(name) {
    return async function execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        if (signal?.aborted) {
          throw new Error("request cancelled");
        }
        const cwd = sessionCwd(ctx);
        const request = toolRequest(name, params ?? {}, cwd);
        const result = await query(request, {
          signal,
          onProgress: (progress) => {
            onUpdate?.({
              content: [{ type: "text", text: progressText(progress) }],
              details: {},
            });
          },
        });
        const ranked = await rerank(name, request, result);
        const formatted = format(name, ranked);
        return {
          content: [{ type: "text", text: formatted.text }],
          details: formatted.structuredContent ?? {},
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error?.message || String(error),
            },
          ],
          details: {},
          isError: true,
        };
      }
    };
  }

  const tools = [
    {
      name: "find",
      label: "find",
      description: FIND_DESCRIPTION,
      promptSnippet: "Find files by name or path (codeq / FFF, not fd)",
      promptGuidelines: [
        "find is codeq path search, not a glob tool and not fd: pass profile, not **/*profile*.",
        "find matches the whole indexed path, including dotfiles such as .cursor/rules. Use grep for contents and graph for call chains.",
        "find searches one repository per call. Pass root for another checkout; pass path to narrow inside the selected root. Never merge results across repositories.",
      ],
      parameters: Type.Object({
        query: Type.String({
          description:
            "Path fragment, matched fuzzily (foo.py, profiles/app, SKILL.md). Not a glob: pass profile, not **/*profile*. Dotfiles are indexed.",
        }),
        path: pathField(),
        root: rootField(),
        limit: limitField(),
      }),
      prepareArguments: prepareFindArgs,
      execute: executeTool("find"),
      renderCall(args, theme) {
        return renderCall("find", args, theme);
      },
      renderResult,
    },
    {
      name: "grep",
      label: "grep",
      description: GREP_DESCRIPTION,
      promptSnippet: "Search file contents (codeq / FFF, not rg)",
      promptGuidelines: [
        "grep is codeq content search, not rg. Default matching is a literal string. Pass regex: true for a regular expression.",
        "grep is exact by default: zero hits means zero hits. Pass fuzzy: true only for approximate/different identifiers; those replies are labelled [fuzzy].",
        "grep searches one repository per call. Pass root for another checkout; pass path to narrow. Continuation uses an opaque cursor bound to the same search.",
      ],
      parameters: Type.Object({
        pattern: Type.String({
          description:
            "literal string by default. This is not rg: dots, brackets, and $ are literal unless regex is true.",
        }),
        path: pathField(),
        root: rootField(),
        glob: Type.Optional(
          Type.String({
            description:
              "Optional glob used to constrain matches, for example **/*.ts",
          }),
        ),
        regex: Type.Optional(
          Type.Boolean({
            description:
              "Default false. When true, pattern is a regular expression. Leave it off for a literal search — foo.ts, process.env, and array[0] are literals. This is not rg.",
          }),
        ),
        fuzzy: Type.Optional(
          Type.Boolean({
            description:
              "Default false. Approximate matching for different identifiers, labelled [fuzzy]. NOT the same identifier.",
          }),
        ),
        cursor: Type.Optional(
          Type.String({
            description:
              "Opaque continuation from a previous grep nextCursor. Bound to the same root, pattern, glob, path, regex, fuzzy, context, and ignoreCase. A mismatch is an error, not page 1.",
          }),
        ),
        limit: limitField(),
        context: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "Neighboring source lines around each hit. Default 0, maximum 3. Not rg and not host Read.",
          }),
        ),
        count: Type.Optional(
          Type.Boolean({
            description:
              "When true, return match and file counts only, with no locators. Ignores context. Does not accept cursor.",
          }),
        ),
        ignoreCase: Type.Optional(
          Type.Boolean({
            description:
              "This is not rg. Omit for smart-case; true forces case-insensitive matching; false is case-sensitive.",
          }),
        ),
      }),
      prepareArguments: prepareGrepArgs,
      execute: executeTool("grep"),
      renderCall(args, theme) {
        return renderCall("grep", args, theme);
      },
      renderResult,
    },
    {
      name: "graph",
      label: "graph",
      description: GRAPH_DESCRIPTION,
      promptSnippet: "Explore the code graph (codeq / CodeGraph)",
      promptGuidelines: [
        "graph is codeq CodeGraph explore, not a written answer. Query identifiers, how X works, where X is defined, or who calls / uses X — not a multi-paragraph question.",
        "graph: for how-it-works, Read the entry. For who-calls or where-used, use the callers locators; do not grep that name first. There is no callers tool.",
        "graph searches one repository per call. Pass root for another checkout; pass path to narrow. Replies are locators, never source.",
      ],
      parameters: Type.Object({
        query: Type.String({
          description:
            'Identifiers, or a short question about how X works, where X is defined, or who calls / uses X. Identifier-shaped queries match the graph; a multi-paragraph question does not.',
        }),
        path: pathField(),
        root: rootField(),
      }),
      prepareArguments: prepareShared,
      execute: executeTool("graph"),
      renderCall(args, theme) {
        return renderCall("graph", args, theme);
      },
      renderResult,
    },
  ];

  return function codeqPi(pi) {
    for (const tool of tools) {
      pi.registerTool(tool);
    }
  };
}

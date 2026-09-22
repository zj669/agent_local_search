/**
 * Native Pi extension factory. Registers find / grep / graph with those names
 * so they override Pi builtins (rg / fd). queryDaemon is injected by the
 * default entry and must only run inside execute, never while registering.
 */
import { Type } from "typebox";

const PATH_DESCRIPTION =
  "Narrow this one call inside the selected repository: a directory (src/, profiles/app) or a single file (src/pkg/foo.py). This is the only way to scope a search, and it never creates or switches an index: every path in a repository reuses that repository's one index. A relative path is joined to root when root is passed, otherwise to the session cwd — even when the cwd is another checkout or worktree of the same repository. Absolute, ~/, and ../ paths that leave the workspace switch to that repository, but prefer root for that: if root is set, an absolute path under the session cwd or another checkout is still treated as a path inside that root. A path that does not exist is an error that names the absolute path tried, not a silent search of the whole repository. Each call uses exactly one root.";

const ROOT_DESCRIPTION =
  "Absolute path of the repository, checkout, or worktree to search, for this call only, overriding Git/cwd detection. Pass it whenever the repository you are asking about is not the session cwd: a second clone, another checkout or worktree, or any repository when Pi was started from $HOME. Omitting it silently searches the session cwd, which is the wrong tree when your question is about another repository. root is the only thing that selects an index, and one repository has one index: a subdirectory or a file passed as root resolves to the repository that holds it, narrowed to that subdirectory or file, and says so in the reply. To scope a search, keep root at the checkout and pass path. Every reply names the resolved root and where it came from; if that root is not the repository you meant, retry with root.";

const FIND_DESCRIPTION =
  "Find files by name or path using the local codeq index (FFF), not Pi's builtin fd/glob find. Indexes the selected root automatically on first use; never ask the user to init or create a project-local index. Pass root to search a different repository and path to narrow inside one. Each call uses exactly one root; results from multiple repositories are never merged. Glob syntax is not supported: **/*profile* matches nothing, pass profile instead. Replies are locators (paths), not source.";

const GREP_DESCRIPTION =
  "Search file contents using the local codeq index (FFF), not Pi's builtin rg. Default matching is a literal string — this is not rg. Pass regex true for a regular expression. All-match patterns like .* are rejected when regex is on. Matching is exact by default: zero hits means zero hits, and nothing is silently re-run as fuzzy. Pass fuzzy true to also accept approximate names; those replies are labelled [fuzzy] on the first line and name DIFFERENT identifiers. Indexes the selected root automatically on first use; never ask the user to init. Pass root to search a different repository and path to narrow inside one. Each call uses exactly one root; results from multiple repositories are never merged. Replies are locators (path:line), not source.";

const GRAPH_DESCRIPTION =
  'Explore related symbols and files with the local codeq index (CodeGraph explore). Use this for call chains and pipelines (tracing which functions run from an entry point): it returns recommended reading entries — the query symbol\'s own span (start–end of that function or class, not the whole file) when that identifier hits, otherwise an engine-selected span — and its direct callees (name, file, line) so you can walk the chain without Bash or one grep per hop. Returns a map of the code to read next, not a written answer and not source. Read that span; do not split a pipeline into one graph call per identifier. A query that names several symbols returns one wider map. Indexes the selected root automatically on first use; never ask the user to init or write a .codegraph directory into the project. Pass root to query a different repository and path to narrow inside one. Each call uses exactly one root.';

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
      description: "Maximum number of matches to return",
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
  delete next.ignoreCase;
  delete next.literal;
  delete next.detail;
  delete next.context;
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
      throw new Error("find requires query");
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
      throw new Error("grep requires pattern");
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
    return request;
  }
  if (name === "graph") {
    if (typeof params.query !== "string" || params.query.trim() === "") {
      throw new Error("graph requires query");
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
            "File name or path fragment, matched fuzzily against every indexed path, for example foo.py, profiles/app, profile, or SKILL.md. Dotfiles and dot-directories such as .claude/skills and .cursor/rules are indexed, so look for skills and rules here instead of a native glob tool. Glob syntax is not supported: **/*profile* matches nothing, pass profile instead.",
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
        "grep is codeq content search, not rg. Default matching is a literal string. Pass regex: true for a regular expression. All-match patterns like .* are rejected when regex is on.",
        "grep is exact by default: zero hits means zero hits. Pass fuzzy: true only to try approximate names; those replies are labelled [fuzzy] and name DIFFERENT identifiers.",
        "grep searches one repository per call. Pass root for another checkout; pass path to narrow inside the selected root. After 1-2 greps, read the named span. Use graph for the next hop in a call chain. Continuation uses an opaque cursor bound to the same search.",
      ],
      parameters: Type.Object({
        pattern: Type.String({
          description:
            "One identifier or one literal string, for example focus_item_sources. This is not rg: dots, brackets, and $ are literal unless regex is true. Search one name per call instead of an or-chain of unrelated names.",
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
              "Default false. When the exact pattern has zero hits, also try approximate matching. Those results are NOT the same identifier — the reply is labelled [fuzzy] and names what it actually matched, so confirm the spelling before concluding anything from them. Leave it off when you know the identifier.",
          }),
        ),
        cursor: Type.Optional(
          Type.String({
            description:
              "Opaque continuation from a previous grep nextCursor. Bound to the same root, pattern, glob, path, regex, and fuzzy. A mismatch is an error, not page 1.",
          }),
        ),
        limit: limitField(),
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
        'graph is codeq CodeGraph explore, not a written answer. Query identifiers or "how does X work" where X is identifiers — not a multi-paragraph question.',
        "graph returns recommended reading entries and their direct callees. Read that span; do not split a pipeline into one graph call per identifier. There is no callers tool.",
        "graph searches one repository per call. Pass root for another checkout; pass path to narrow. Replies are locators, never source.",
      ],
      parameters: Type.Object({
        query: Type.String({
          description:
            'Identifiers, or "how does X work" where X is identifiers, for example "Widget render_widget", "how does render_widget work", or "how does handle work" after you learn the entry handler name. Use this for call-chain questions once you have one symbol to anchor on. A query that names several identifiers returns one wider map — do not split it into one call per identifier. Identifier-shaped queries match the graph; a multi-paragraph question does not.',
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

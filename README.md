# codeq

`codeq` combines FFF file/content search and CodeGraph exploration behind one
local CLI, a stdio MCP server, and an automatically managed per-user daemon.

```bash
codeq find router
codeq grep "TODO" --glob "**/*.ts" --context 2
codeq grep PG_DATABASE_URL --fuzzy
codeq graph "how does authentication reach the session store?"
codeq graph "how does saas_reply build CommandReplyResponse" --full
codeq mcp
```

Node.js `>=22.5 <25` is required. Cursor's PATH `node` may be 26; use the
`codeq-mcp` wrapper, which pins Homebrew `node@22` or nvm/fnm 22.

## Cursor MCP

Install globally, then put this in **`~/.cursor/mcp.json`** (global; this is
the default). Project `.cursor/mcp.json` is optional.

```bash
npm install -g @zj669/codeq
```

```json
{
  "mcpServers": {
    "codeq": {
      "type": "stdio",
      "command": "codeq-mcp",
      "args": ["${workspaceFolder}"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

`codeq-mcp` is the official wrapper. It never uses `npx` on the stdio pipe
(npx steals stdin and the handshake times out). It execs
`node bin/codeq.js mcp` with a Node in `>=22.5 <25`.

Do **not** set `cwd`. Cursor ignores mcp.json `cwd` here: the MCP helper's
cwd is `/`, and the stdio child starts in `$HOME`. `${workspaceFolder}` in
`args` is a **hint only** and is sometimes left uninterpolated. Do not set `CODEQ_CWD`.
Do not use `WORKSPACE_FOLDER_PATHS` as the only root — it is a
multi-root list, and the first entry is not always the current window.

MCP is **lazy**. `initialize` / `tools/list` do not pick a root or index.
Indexing starts on `tools/call` when there is a real target: `path` / `root`
on that call, else `roots/list` if the client gave a non-HOME folder, else a
spawn cwd that is not `$HOME` or `/`. Spawned from `$HOME` with no path/root
and no usable `roots/list`, the tool returns a "pass path or root" error
instead of indexing home.

The MCP tools are `find`, `grep`, and `graph`. They reuse the same user-level
daemon as the CLI. A call always searches exactly one root. Pass `root` to
search another repository and `path` to narrow inside one (CLI `--root` /
`--path`).

`root` is a repository, checkout, or worktree, and `path` is the scope inside
it — a directory or a single file. **Only `root` selects an index**: one
repository has one FFF index and one CodeGraph database, and every `path` in it
reuses them. A subdirectory or a file passed as `root` resolves to the
repository that holds it, narrowed to that subdirectory or file, and the reply's
first line says so.

A relative `path` is joined to the selected `root`, not to the session cwd, so
`root /other/repo` with `path src/agent` searches `/other/repo/src/agent` even
when the window sits in a different checkout. A `path` that does not exist is an
error naming the absolute path that was tried — never a silent search of the
whole repository.

stdio accepts both newline-delimited JSON-RPC (one object per line, as
OpenCode sends) and LSP `Content-Length` frames (as Cursor sends). Each reply
uses the same framing as that request. There is no Python framing bridge.

`grep` auto-detects regex and rejects all-match patterns such as `.*`. It is
**exact by default**: zero hits are reported as zero hits, never silently
re-run as an approximate search. Pass `fuzzy: true` (CLI `--fuzzy`) to accept
approximate names; those replies are labelled `[fuzzy]` on the first line, say
which identifier they actually matched, and are **not** the name you asked for.
Both CLI and MCP accept `--limit` / `limit`.

## Two layers per reply

Every reply starts with index freshness (`ready` / `indexing` / `degraded` and
`lastSuccessfulSync`) and the resolved root. After that there are two layers,
and the default is the cheap one:

- **layer 0** (default, `detail: "summary"`) is a map: the hit symbols, the
  files to open next with their relevant line ranges, and what depends on them.
  It carries **no source code** — opening the named files with the host's own
  `Read` is cheaper than codeq forwarding them, and it keeps a `graph` reply
  around 1 KB instead of 5 KB.
- **layer 1** (`detail: "full"`, CLI `--full`) repeats the whole layer 0 map
  verbatim and then adds what the map withheld: source for `graph` with the
  query's target file first, context lines and full metadata for `grep` and
  `find`.

`graph` ranks the files to open by the identifier that was asked for: its
definition site first, then the files the blast radius ties to it. CodeGraph
seeds its search by splitting `format_chat_details` into `format`, `chat` and
`details`, so files that only matched a short token are named under
`also ranked` instead of the top of the list, and `detail: "full"` still returns
their source.

A layer 1 `graph` reply that does not fit drops **whole file sections**, never
half a file, and names what it dropped plus the `path=` that retrieves it.

```text
[ready] root /repo via root argument
graph "how does formatMcpToolResult work" — 43 symbols in 3 files, exact hit on formatMcpToolResult

hit: formatMcpToolResult — src/mcp-format.js:82

open these files (3)
1. src/mcp-format.js:82 — formatMcpToolResult(function), MCP_INSTRUCTIONS(constant) +7 · relevant lines 1-135
2. src/mcp.js — send, positiveInteger, isUnusableWorkspace, jsonRpcError +25 · relevant lines 252-438
3. bin/codeq.js — fail, positiveInteger, queryDaemon, rootOrigin +21 · relevant lines 1-190

depends on this (blast radius, query symbols only)
- formatMcpToolResult (src/mcp-format.js:82) — 3 callers in src/mcp.js; tests: test/mcp-format.test.js
+4 other symbols the engine ranked (TOOLS, toolRequest, MCP_INSTRUCTIONS, MCP_USAGE) — detail:"full"

no source in this map. detail:"full" returns source for these 3 files (~16 KB), target file first.
```

The MCP text block is that map and nothing else. Machine fields (`shown`,
`moreRemain`, `files[].renderedLines`, `score`, …) travel in
`structuredContent`, described by each tool's `outputSchema`. This is a
**deliberate deviation** from the MCP 2025-06-18 note that a tool returning
structured content SHOULD also serialize it into a text block: doing that
re-added about 10% pure escaping tax and buried the map in the middle of the
reply. The text channel is self-contained, so a client that ignores
`structuredContent` loses numbers, never a decision.

CLI human output prints the same layer 0 map on stdout with the status line on
stderr. `--json` is unaffected by layers: it stays the complete daemon result
and is the stable anchor for scripts.

Every reply also names the resolved absolute root and which input selected it,
so a call that landed in the wrong repository is visible without re-deriving
the routing:

```text
[ready] root /abs/path/to/B via root argument
[ready] root /abs/path/to/A via cwd (roots/list)
[ready] root /abs/repo via root argument (root named a file, so it resolved to
this repository narrowed to src/policy.py; pass a file as path, not root)
```

The origin is `root argument`, `path argument`, or `cwd (...)` with the cwd's
own source: `roots/list`, `spawn cwd`, `cwd argument`, or the CLI's
`shell cwd`. MCP `structuredContent` and `--json` carry the same values as `rootSource`
and `cwdSource`, plus `rootNote` for the parenthesised note. When that root is
not the repository you meant — usually from omitting `root` while working
across two repositories — retry with `root`.

## Install, update, and uninstall

Install:

```bash
npm install -g @zj669/codeq
```

Update:

```bash
npm update -g @zj669/codeq
```

Uninstall:

```bash
npm uninstall -g @zj669/codeq
```

As a fallback, install the latest source archive from GitHub:

```bash
npm install -g https://github.com/zj669/agent_local_search/archive/refs/heads/main.tar.gz
```

To pin the current GitHub release instead:

```bash
npm install -g https://github.com/zj669/agent_local_search/archive/refs/tags/v0.2.8.tar.gz
```

## Commands

```text
codeq [--root PATH] [--json|--full] find  <query>   [--path PATH] [--limit N]
codeq [--root PATH] [--json|--full] grep  <pattern> [--path PATH] [--glob GLOB] [--context N] [--limit N] [--fuzzy]
codeq [--root PATH] [--json|--full] graph <query>   [--path PATH]
codeq mcp
```

There are no daemon-management or indexing commands. The first query starts the
daemon and automatically indexes its selected root. `--path` and `--root` (or
the MCP `path` / `root` arguments) can route one request to another repository,
but a request always searches exactly one root.

The root is the deepest Git worktree containing the target. This means a linked
Git worktree gets its own indexes and is always read from its own checkout. For
non-Git directories, `codeq` uses the current directory unless `--path` escapes
it. The filesystem root and the user's home directory are refused.

An index is created only when the root changes. `--root packages/foo` inside a
worktree therefore searches the worktree narrowed to `packages/foo` — the same
thing `--path packages/foo` does — instead of building a second index; a nested
checkout with its own `.git` is still its own root. A `--root` that names a file
is resolved to the repository holding it, with the file as the scope, and a
`--root` that does not exist is an error rather than a new index.

Any number of processes — several editor windows, their MCP servers, and the
CLI — share one daemon per user. Autostart is guarded by a lock file, so the
socket is bound and each CodeGraph database is migrated exactly once; after
that, queries from different clients run side by side rather than in a queue.

## Data

No index files are written into source trees. State is stored at:

- Linux: `${XDG_DATA_HOME:-~/.local/share}/codeq`
- macOS: `~/Library/Application Support/codeq`
- Windows: `%LOCALAPPDATA%\codeq`

Each canonical root gets a SHA-256-addressed bucket under `roots/`. FFF's index
is memory-only. CodeGraph's database, WAL, locks, and related data all live in
that external bucket.

CodeGraph is pinned to `@colbymchenry/codegraph@1.6.0`. Installation applies a
checksum-guarded patch only to its data-directory resolver; a source checksum or
version mismatch aborts installation. FFF is used unchanged through its public
Node API.

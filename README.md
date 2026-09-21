# codeq

`codeq` combines FFF file/content search and CodeGraph exploration behind one
local CLI, a stdio MCP server, and an automatically managed per-user daemon.

```bash
codeq find router
codeq grep "TODO" --glob "**/*.ts" --context 2
codeq graph "how does authentication reach the session store?"
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
daemon as the CLI. A call always searches exactly one root. Pass `path` /
`root` to search another repository (CLI `--path` / `--root`).

stdio accepts both newline-delimited JSON-RPC (one object per line, as
OpenCode sends) and LSP `Content-Length` frames (as Cursor sends). Each reply
uses the same framing as that request. There is no Python framing bridge.

`grep` auto-detects regex, retries as fuzzy when a literal search has zero
hits, and rejects all-match patterns such as `.*`. Both CLI and MCP accept
`--limit` / `limit`. MCP replies start with index freshness (`ready` /
`indexing` / `degraded` and `lastSuccessfulSync`) and default to a short
summary plus paths; pass `detail: "full"` for complete match text or the full
graph dump.

Every reply also names the resolved absolute root and which input selected it,
so a call that landed in the wrong repository is visible without re-deriving
the routing:

```text
[ready] root /abs/path/to/B via root argument
[ready] root /abs/path/to/A via cwd (roots/list)
```

The origin is `root argument`, `path argument`, or `cwd (...)` with the cwd's
own source: `roots/list`, `spawn cwd`, `cwd argument`, or the CLI's
`shell cwd`. MCP payloads and `--json` carry the same values as `rootSource`
and `cwdSource`. When that root is not the repository you meant — usually from
omitting `root` while working across two repositories — retry with `root`.

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
npm install -g https://github.com/zj669/agent_local_search/archive/refs/tags/v0.2.5.tar.gz
```

## Commands

```text
codeq [--root PATH] [--json] find  <query>   [--path PATH] [--limit N]
codeq [--root PATH] [--json] grep  <pattern> [--path PATH] [--glob GLOB] [--context N] [--limit N]
codeq [--root PATH] [--json] graph <query>   [--path PATH]
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

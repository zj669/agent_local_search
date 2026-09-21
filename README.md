# codeq

`codeq` combines FFF file/content search and CodeGraph exploration behind one
local CLI, a stdio MCP server, and an automatically managed per-user daemon.

```bash
codeq find router
codeq grep "TODO" --glob "**/*.ts" --context 2
codeq graph "how does authentication reach the session store?"
codeq mcp
```

Node.js `>=22.5 <25` is required.

## Cursor MCP

After a global install (`npm install -g @zj669/codeq`), add this to
`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "codeq": {
      "type": "stdio",
      "command": "codeq",
      "args": ["mcp"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

`cwd` is Cursor's stdio **spawn working directory** for the MCP process — the
same `process.cwd()` the CLI reads from your shell. It is not a `codeq`
argument and not an environment variable. Do not set `CODEQ_CWD`.

If the client sends `roots/list`, that session workspace is used; otherwise
codeq uses this spawn cwd. Git then promotes the directory to the deepest
worktree, the same way the CLI does. Spawned from `$HOME` or `/` with no
workspace path, searches refuse those roots.

Without a global install, `npx` also works if you still set spawn `cwd`:

```json
{
  "mcpServers": {
    "codeq": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@zj669/codeq", "mcp"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

The MCP tools are `find`, `grep`, and `graph`. They reuse the same user-level
daemon as the CLI, index a root automatically on first use, and accept `path` /
`root` to switch repositories. A call always searches exactly one root.

`grep` auto-detects regex, retries as fuzzy when a literal search has zero
hits, and rejects all-match patterns such as `.*`. Both CLI and MCP accept
`--limit` / `limit`. MCP replies start with index freshness (`ready` /
`indexing` / `degraded` and `lastSuccessfulSync`) and default to a short
summary plus paths; pass `detail: "full"` for complete match text or the full
graph dump.

Workspace discovery matches the FFF plugin in pi (`@ff-labs/pi-fff`): no
project-path env var. Prefer `roots/list` when the client provides it, else
the spawn `process.cwd()`.

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
npm install -g https://github.com/zj669/agent_local_search/archive/refs/tags/v0.2.2.tar.gz
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
# codeq

`codeq` combines FFF file/content search and CodeGraph exploration behind one
local CLI and an automatically managed per-user daemon.

```bash
npm install -g @codeq/cli

codeq find router
codeq grep "TODO" --glob "**/*.ts" --context 2
codeq graph "how does authentication reach the session store?"
```

Node.js `>=22.5 <25` is required.

## Commands

```text
codeq [--root PATH] [--json] find  <query>   [--path PATH] [--limit N]
codeq [--root PATH] [--json] grep  <pattern> [--path PATH] [--glob GLOB] [--context N]
codeq [--root PATH] [--json] graph <query>   [--path PATH]
```

There are no daemon-management or indexing commands. The first query starts the
daemon and automatically indexes its selected root. `--path` and `--root` can
route one request to another repository, but a request always searches exactly
one root.

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
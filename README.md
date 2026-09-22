# codeq

Local **find / grep / graph** for one repository at a time. One CLI, a stdio MCP
server, and a per-user daemon. Three tools only — not a fourth.

```bash
npm i -g @zj669/codeq@0.2.12
```

Needs **Node 22.5–24** (not 26). **Do not use `npx`** — npx steals stdin and
the handshake times out.

```bash
codeq find foo.py
codeq grep "TODO" --glob "**/*.py" --context 2
codeq graph "how does foo work"
codeq mcp
```

## Pi

Native Pi coding-agent extension (not MCP): [`codeq-pi/`](codeq-pi/). Same
three tools, same daemon. Same-name `grep` / `find` override Pi's `rg` /
`fd`; `graph` is new. Install: `pi install` in that directory.

## Cursor MCP

Global install, then **`~/.cursor/mcp.json`**. Command must be `codeq-mcp` (the
official wrapper: pins Node 22.5–24, never npx). Do **not** set `cwd`.
Do not set `CODEQ_CWD`.

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

`${workspaceFolder}` in `args` is a hint only (sometimes left uninterpolated).
Handshake does not index.

## Other MCP clients

Everyone else starts **`codeq mcp`**. Do not invent a second wrapper. Full
configs: [docs/mcp-install.md](docs/mcp-install.md).

| Client | Command |
|---|---|
| Claude Code | `claude mcp add --scope user --transport stdio codeq -- codeq mcp` |
| OpenAI Codex | `codex mcp add codeq -- codeq mcp` |
| Gemini CLI | `gemini mcp add -s user -t stdio codeq codeq mcp` |
| 反重力 (`agy`) | `agy mcp add -t stdio codeq codeq mcp` |
| OpenCode | `opencode mcp add codeq -- codeq mcp` |

If `codeq` is missing from PATH, put the absolute path from `which codeq` in
the config — still not npx.

## `root` vs `path`

| | Role |
|---|---|
| `root` | **Selects the index** for this call: absolute path of a repository, checkout, or worktree. |
| `path` | **Narrows this call** inside that index. A directory or a file, e.g. `src/pkg/foo.py`. Never builds a second index. |

A relative `path` is joined to the selected `root` (0.2.12), not to the session
cwd. `{ "root": "/abs/path/to/B", "path": "src/pkg/foo.py" }` searches
`/abs/path/to/B/src/pkg/foo.py` even when the window sits in another checkout.
One call, one root — no multi-repo merge. Spawned from `$HOME` with no
`path`/`root` and no usable `roots/list`: pass a repository; home is not
indexed.

```json
{ "query": "foo.py", "path": "src/pkg/foo.py" }
```

```json
{ "query": "foo.py", "root": "/abs/path/to/A" }
```

Every reply's first line names the resolved root (`via root argument` /
`via path argument` / `via cwd`). Wrong tree → retry with `root`.

Default replies are a map (no source). `detail: "full"` / `--full` adds source.
`grep` is exact by default; `--fuzzy` / `fuzzy: true` is labelled `[fuzzy]`.

## Optional Jev rerank

Set `CODEQ_JEV_KEY` on the MCP server `env` (or the CLI process) to rerank the
current page. Optional: `CODEQ_JEV_URL`, `CODEQ_JEV_MODEL`. No key, timeout, or
4xx/5xx **skips** rerank. The reply text never names Jev. Not a fourth tool.
`--json` is not reranked.

## Data

Indexes live outside the project tree (Linux
`${XDG_DATA_HOME:-~/.local/share}/codeq`, macOS
`~/Library/Application Support/codeq`, Windows `%LOCALAPPDATA%\codeq`). FFF is
unpatched. CodeGraph is pinned to 1.6.0 with a data-dir patch only.

```bash
npm uninstall -g @zj669/codeq
```

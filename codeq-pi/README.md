# `@zj669/codeq-pi`

Native [Pi](https://github.com/earendil-works/pi) coding-agent **extension**
(not MCP). Same three tools as the `codeq` CLI: `find`, `grep`, `graph`.
Queries go to the existing user-level codeq daemon. Same-name `grep` / `find`
override Pi's builtin `rg` / `fd`; `graph` is new. Schema matches
`@zj669/codeq@0.3.11` (locators, literal grep, opaque grep cursor).

```bash
npm i -g @zj669/codeq@0.3.11
pi install npm:@zj669/codeq-pi
```

Needs **Node 22.5–24**, same as `@zj669/codeq`. Do not install alongside
`@ff-labs/pi-fff` in **override** mode — both register `grep` / `find`, and the
first loaded extension wins. Default pi-fff (`ffgrep` / `fffind`) does not
collide, but the model then sees two search stacks.

If you already pass `--tools`, include `grep,find,graph` or these tools never
enter the registry. `defaultTools` is not an install step.

Do **not** set `CODEQ_CWD`. Each call uses the Pi session `ctx.cwd`, plus
optional `path` / `root` (same meaning as CLI/MCP). One call, one repository.
Optional `CODEQ_JEV_KEY` on the Pi process reranks the current page the same
way CLI/MCP do; the reply never names that reranker.

There is no `detail`. Pass `context` (at most 3) for neighboring lines around a hit, `count: true` for match and file totals, and `ignoreCase` to override smart-case. `grep` is a literal by
default; pass `regex: true` for a regular expression and `cursor` to continue
the same search.

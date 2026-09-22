# `@zj669/codeq-pi`

Native [Pi](https://github.com/earendil-works/pi) coding-agent **extension**
(not MCP). Same three tools as the `codeq` CLI: `find`, `grep`, `graph`.
Queries go to the existing user-level codeq daemon. Same-name `grep` / `find`
override Pi's builtin `rg` / `fd`; `graph` is new.

```bash
npm i -g @zj669/codeq@0.2.12
pi install npm:@zj669/codeq-pi
```

Until the npm package exists, install this directory:

```bash
pi install /absolute/path/to/agent_local_search/codeq-pi
# or, from a trusted project:
pi install -l /absolute/path/to/agent_local_search/codeq-pi
```

Try once without writing settings:

```bash
pi -e /absolute/path/to/agent_local_search/codeq-pi/src/index.ts
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

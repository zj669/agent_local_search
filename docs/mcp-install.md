# 把 `@zj669/codeq` 接到 MCP 客户端

MCP install for Claude Code, Codex, Gemini CLI, Cursor, 反重力 (`agy`), and OpenCode.

包版本钉 **`@zj669/codeq@0.3.9`**。stdio 同时吃 LSP `Content-Length` 和 NDJSON，**不要再套一层 Python / bash 夹层**。Cursor 用官方包装器 `codeq-mcp`（只钉 Node 22.5–24、躲开 npx）；其它客户端用 `codeq mcp`。不要发明第二个包装器。

下列安装命令在 2026-09-22 的 Linux VM 上对 **0.2.11** 跑过。**0.3.9** 的 MCP 入口没变（仍是 `codeq mcp` / `codeq-mcp`）；相对 `path` 接到这次选中的 `root`。0.3.0 起回包是 locator（没有 `detail:"full"`），grep 默认字面匹配；0.3.1 把 miss 的伪入口砍掉并压缩 schema/地图。请装 0.3.9。

## 结论

| 客户端 | 安装 / 写入配置 | initialize + tools/list | tools/call |
|---|---|---|---|
| Claude Code **2.1.278** | 过 | 过（`✔ Connected`） | 健康检查已握手；无 Anthropic 钥，未跑模型回合 |
| OpenAI Codex **0.155.1** | 过 | 配置 `enabled`；`codex exec` 因 OpenAI 401 没进会话 | 未跑 |
| Gemini CLI **0.60.0** | 过 | 过（信任工作区后 `✓ Connected`） | 无 Gemini 钥，未跑模型回合 |
| Cursor Agent CLI **2026.09.18-9a7762b** | 过（`~/.cursor/mcp.json` + `codeq-mcp`） | 过（`ready`，3 个工具） | `agent` 未登录，未跑模型回合 |
| 反重力 = **Google Antigravity CLI `agy` 1.2.8** | 过 | `agy mcp list` 显示 `enabled`；TUI/`-p` 要 Google 登录 | 未跑 |
| OpenCode **1.18.32** | 过 | 过（`✓ connected`，从 `$HOME` 拉起也连） | 过（`codeq_find` → `src/pkg/foo.py`） |
| MCP Inspector **2.7.0**（通用 stdio） | 过 | 过 | 过（find / grep / graph，以及 `path` 换仓） |

对不上的是宿主登录 / 文件夹信任，不是 framing、shebang、或 handshake 顺序。

Node：包装器 `codeq-mcp` 要求 **Node `>=22.5 <25`**（不要 26）。

---

## 1. 先装包

```bash
node -v    # 例如 v22.22.2；需要 22.5–24.x
npm i -g @zj669/codeq@0.3.9,
which codeq
which codeq-mcp
```

PATH 上会出现：

```text
codeq       →  …/bin/codeq        （shebang: #!/usr/bin/env node）
codeq-mcp   →  …/bin/codeq-mcp    （官方包装器，exec node …/bin/codeq.js mcp）
```

找不到命令时用 `which codeq` / `which codeq-mcp` 的**绝对路径**填进配置，**不要改用 `npx`**（npx 会占住 stdio，handshake 超时）。

自检（可选）：

```bash
codeq --help
CODEQ_MCP_DRY_RUN=1 codeq-mcp
```

---

## 2. 所有客户端共用的语义

MCP 只暴露三个工具：**`find` / `grep` / `graph`**。不要第四个工具，不要 `setWorkspace`。

**懒加载。** `initialize` 和 `tools/list` 不选 root、不建索引。索引只发生在真正的 `tools/call`，并且这次调用要有目标：

1. 这次的 `root` 或 `path`，否则
2. 客户端 `roots/list` 给的非 `$HOME` / `/` 目录，否则
3. 进程 cwd 不是 `$HOME` / `/`

从 `$HOME` 拉起、又没给 `path`/`root`、也没有可用 `roots/list` 时，工具返回：

```text
no workspace (spawned from home). Pass path or root to a repository on this call.
```

**不会**去索引家目录。

### `root` 和 `path`（换仓只靠参数）

| 参数 | 作用 |
|---|---|
| `root` | **选索引。** 仓库 / checkout / worktree 的绝对路径，只对这一次调用有效。 |
| `path` | **收窄这一次搜索。** 目录或文件，例如 `src/pkg/foo.py`。不另开索引。相对路径接到这次选中的 `root`（0.3.0 与 0.2.12 相同）；没有 `root` 时接到 session cwd。如果宿主已经把相对 path 扩成了另一棵 checkout 下的绝对路径，仍按同一相对 scope 接到这次的 `root`。不存在的 path 会报出拼好的绝对路径，不会悄悄搜整个仓。绝对路径逃出当前仓则换仓（更稳妥的做法是传 `root`）。 |

一次调用只用一个 root，**不做多仓结果融合**。下一调用不带路径，不会粘在上一次的 B 上。例子用 `src/pkg/foo.py`，不要把某一个仓库名写进工具描述。

```json
{ "query": "foo.py", "path": "src/pkg/foo.py" }
```

```json
{ "query": "foo.py", "root": "/abs/path/to/A" }
```

```json
{ "query": "bar.py", "path": "/abs/path/to/B" }
```

回包第一行会写 `[ready] root … via root argument` 或 `via path argument` 或 `via cwd:roots/list`。对不上就再带 `root`。默认回包是 bounded locations（graph 的 `entries`/`callees`，grep 的 `hits`，find 的 `paths`），没有源码、没有 `detail`。grep 默认字面匹配，需要正则时显式 `regex: true`；翻页用绑定本次搜索的 opaque `cursor`。

**不要：**

- 配 `"cwd": "${workspaceFolder}"`（Cursor 会忽略；其它宿主也不要靠它当产品故事）
- 设 `CODEQ_CWD`
- 用 `npx` 当 `command`
- 为 framing 再包一层

Cursor 把 `${workspaceFolder}` 放在 **`args` 里当 hint**；字面量 `${…}` / `$HOME` / `/` 时包装器不 `cd`，MCP 照样启动。

---

## 3. Claude Code

```bash
claude mcp add --scope user --transport stdio codeq -- codeq mcp
```

`claude mcp list` 会做健康检查，成功时：

```text
codeq: codeq mcp - ✔ Connected
```

写入 `~/.claude.json` 的 `mcpServers`：

```json
{
  "mcpServers": {
    "codeq": {
      "type": "stdio",
      "command": "codeq",
      "args": ["mcp"],
      "env": {}
    }
  }
}
```

Jev 可选：在 `claude mcp add` 里加 `--env CODEQ_JEV_KEY=…`（先写 `--transport stdio`，再写服务器名，避免 `--env` 把名字当成另一对 KEY=VALUE），或直接把变量名写进上面的 `env`。不要把密钥写进 git。

项目级改 `--scope project`（仓库根 `.mcp.json`）。`--` 后面才是启动命令，不要丢掉。

---

## 4. OpenAI Codex

```bash
codex mcp add codeq -- codeq mcp
```

写入 `~/.codex/config.toml`：

```toml
[mcp_servers.codeq]
command = "codeq"
args = ["mcp"]
```

可选环境变量（值自己填，不要提交）：

```toml
[mcp_servers.codeq.env]
CODEQ_JEV_KEY = "…"
```

`codex mcp list` 里 `Auth: Unsupported` 只表示这个 stdio 服务器没有 OAuth，不是失败。登录之后开一轮对话，用 `/mcp` 看工具即可。

---

## 5. Gemini CLI

```bash
gemini mcp add -s user -t stdio codeq codeq mcp
```

写入 `~/.gemini/settings.json`：

```json
{
  "mcpServers": {
    "codeq": {
      "command": "codeq",
      "args": ["mcp"]
    }
  }
}
```

0.60 默认开文件夹信任。未信任的目录会看到 MCP disabled。在**你自己的项目目录**里信任该文件夹（CLI 首次对话框，或 `~/.gemini/trustedFolders.json` 里对该路径写 `TRUST_FOLDER`），再 `gemini mcp list`，成功时是 `✓ Connected`。

CI / 无 TTY 时可以设 `GEMINI_CLI_TRUST_WORKSPACE=true`（只信任当前这次工作区）。不要为了图省事关全局安全开关。

---

## 6. Cursor（编辑器 + Agent CLI）

全局推荐 `~/.cursor/mcp.json`（每个窗口都有）。**command 必须是 `codeq-mcp`**，不要 `npx`，不要 `cwd`：

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

可选 Jev：在 `env` 里加 `CODEQ_JEV_KEY`（以及可选的 `CODEQ_JEV_URL` / `CODEQ_JEV_MODEL`）。不要写入仓库里的 mcp.json 密钥。

写入后可用 Cursor Agent CLI 确认：

```bash
agent mcp enable codeq
agent mcp list            # codeq: ready
agent mcp list-tools codeq
```

应看到三个工具：`find` / `grep` / `graph`（参数含 `query`/`pattern`、`path`、`root`）。GUI 编辑器读同一份 `mcp.json`。

包装器会：在 Homebrew `node@22` / nvm / fnm / volta 里找 **22.5–24**；把 `$1`（`${workspaceFolder}`）当 hint，含 `${` 的字面量丢掉；然后 `exec node <package>/bin/codeq.js mcp`。从 `$HOME` 带着未插值的 `'${workspaceFolder}'` 也能握手；HOME 调用仍要求 `path`/`root`。

---

## 7. 反重力（Google Antigravity）

中文常说的「反重力」就是 **Google Antigravity**。CLI 二进制是 **`agy`**，不是 npm 包名 `antigravity`。

```bash
# 安装 CLI（实测：Antigravity CLI 1.2.8 → ~/.local/bin/agy）
curl -fsSL https://antigravity.google/cli/install.sh | bash

agy mcp add -t stdio codeq codeq mcp
agy mcp list
```

`agy mcp add` 写入 **`~/.gemini/config/mcp_config.json`**：

```json
{
  "mcpServers": {
    "codeq": {
      "command": "codeq",
      "args": ["mcp"],
      "disabled": false
    }
  }
}
```

`agy mcp list` 成功时：`codeq  stdio  enabled  codeq mcp`。

官方文档还提到：

- 全局：`~/.gemini/config/mcp_config.json`（CLI 实测写入这里）
- 工作区：`.agents/mcp_config.json`
- 较旧的 IDE 指南：`~/.gemini/antigravity/mcp_config.json`

以编辑器 **Manage MCP Servers → View raw config** 打开的那份为准。IDE 里不要用相对路径当 `command`（社区报告过 `initialize` EOF）；不确定 PATH 时填 `which codeq` 的绝对路径。配置和 `agy mcp` 子命令本身不需要登录。

---

## 8. OpenCode

```bash
opencode mcp add codeq -- codeq mcp
```

写入 `~/.config/opencode/opencode.jsonc`：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "codeq": {
      "type": "local",
      "command": ["codeq", "mcp"]
    }
  }
}
```

`opencode mcp list` 在项目目录和 `$HOME` 都可以是 `✓ connected`。OpenCode 走 NDJSON；codeq 按请求的帧回。不要再套 Python 桥。

实测 `codeq_find` `query=foo.py` 命中 `src/pkg/foo.py`。

---

## 9. 其它 stdio 客户端

任何按 MCP stdio 拉起子进程的宿主都可以。不要 npx。不要第二个包装器。

### MCP Inspector

```bash
npm install -g @modelcontextprotocol/inspector

# 子命令放在 --method 前面，不要写成 `-- codeq mcp`
mcp-inspector --cli codeq mcp --method tools/list --format json
mcp-inspector --cli codeq mcp --method tools/call \
  --tool-name find --tool-arg query=foo.py --tool-arg root=/abs/path/to/A \
  --format json --cwd "$HOME"
```

`tools/list` 返回 `find` / `grep` / `graph`；从 `$HOME` 带 `root` 的 `find` 命中 `src/pkg/foo.py`。

---

## 10. 可选：Jev 重排

**只有**进程环境里有非空 `CODEQ_JEV_KEY` 时才打。没有钥、超时、4xx/5xx 都跳过，地图还是今天的。回复文本不出现 “Jev”。不是第四个工具。

| 变量 | 作用 |
|---|---|
| `CODEQ_JEV_KEY` | 有才启用；空 / 未设 = 跳过 |
| `CODEQ_JEV_URL` | 可选 API root |
| `CODEQ_JEV_MODEL` | 可选模型 id |

各客户端都是把这些放进该服务器的 `env`（Claude `--env`、Codex `--env` / TOML、Gemini `-e`、Cursor `mcp.json` 的 `env`、agy `--env`、OpenCode `--env` / `environment`）。**不要**把密钥写进 git，**不要**设 `CODEQ_CWD`。

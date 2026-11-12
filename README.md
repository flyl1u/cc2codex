# cc2codex

**English** · Hand off half-finished coding sessions between **Claude Code** and **Codex**. When one runs out of quota, `cc2codex` / `codex2cc` turns its local session log into a compact handoff document (user requests, task list, plan, changed files, git state, and the last few turns in full), and a skill on the other side reads it and picks up where the work stopped. It runs entirely offline and calls no model, so it still works after you have hit the limit. It also finds every interrupted session across projects: Claude Code can open a new session for each one, and Codex gets a ready-to-paste prompt per session.

**中文** · 在 Claude Code 和 Codex 之间接力开发。一边额度用完了，就把它的会话整理成交接文档，让另一边读完接着干；同时断了好几个会话也能逐个接上。

| 命令 | 方向 | 读取的记录 | 接手方的 skill |
| --- | --- | --- | --- |
| `cc2codex` | Claude Code → Codex | `~/.claude/projects/<项目>/<会话>.jsonl` | Codex：`resume-from-claude` |
| `codex2cc` | Codex → Claude Code | `~/.codex/sessions/**/rollout-*.jsonl` | Claude Code：`resume-from-codex` |

- **不调用任何模型**：直接解析两个工具存在本地的会话记录，额度用完也能跑。
- **去噪压缩**：几十到上百 MB 的记录压到 30KB 左右，丢掉思考过程、请求原文、文件快照、注入的系统提示等噪音。
- **多会话**：一条命令找出所有项目里中断的会话。
- **默认脱敏**：疑似 API Key、令牌、密码、私钥会替换成 `[已脱敏]`。
- **零依赖**：只要 Node.js 18+。

## 安装（一次）

```bash
git clone https://github.com/flyl1u/cc2codex.git
cd cc2codex
node bin/cc2codex.js install-skill   # 同时安装 Codex 的 resume-from-claude 和 Claude Code 的 resume-from-codex
npm link                             # 可选：全局可用 cc2codex 和 codex2cc 两个命令
```

skill 里写的是本目录的绝对路径，所以不 `npm link` 也能用。移动了本目录后，重新运行一次 `install-skill`。

## 使用

### Claude Code 额度用完 → 去 Codex 接着做

在 Codex 里打开同一个项目文件夹，说：

> 接着 Claude 的活继续

Codex 会自己生成交接文档、读完、核对 git，然后向你复述目标和下一步，你确认后它继续干。

### Codex 额度用完 → 回 Claude Code 接着做

在 Claude Code 里打开同一个项目文件夹，说「接着 Codex 的活继续」，或者输入 `/resume-from-codex`。

### 同时断了好几个会话

两边的能力不一样，skill 的处理也不一样：

- **Claude Code 接 Codex**：Claude Code（桌面版）能自己开新会话。skill 会列出所有中断的 Codex 会话，问你一次，然后当前会话接一个，其余的各开一个新会话，每个会话的工作目录设成它原来的项目。在终端里用 Claude Code 时，它会给你每个会话一行 `claude "..."` 命令。
- **Codex 接 Claude Code**：Codex 不能自己开新对话。skill 会在当前对话里接当前项目那个会话，其余的整理成清单，每一条是一句「接着 Claude 的会话 `<id>` 继续」并注明项目目录，你在 Codex 里为每条各开一个新对话粘贴进去即可。

也可以自己在终端里看：

```bash
cc2codex --interrupted -a    # 所有项目里中断的 Claude Code 会话，附逐条接手指令
codex2cc --interrupted -a    # 所有项目里中断的 Codex 会话
```

判断「中断」只读每个会话文件的末尾：以额度或 API 错误结束、停在工具调用上、工具返回后没有继续、用户消息没得到回复、Codex 的一轮任务没有正常结束或被中止。最近 3 分钟还在写入的会话视为可能仍在运行，不会列入。

### 手动生成交接文档

```bash
cc2codex                    # 当前项目最近的 Claude Code 会话
codex2cc -s 01a1c928        # 按 id 前缀指定；本项目找不到时会跨项目找
cc2codex --list             # 列出本项目的会话
cc2codex --list -a          # 列出所有项目最近 24 小时的会话（带状态）
```

然后对另一边说「先读 `<打印出来的路径>`，接着做下去」。

## 生成的文件

每个会话一个目录，多个会话同时接手也不会互相覆盖：

```
<项目>/.handoff/
├── .gitignore                 # 内容是 *，整个目录不进 git
├── claude-ca8efd19/           # cc2codex 生成，claude-<会话 id 前 8 位>
│   ├── HANDOFF.md             # 交接文档（有长度预算）
│   └── transcript.md          # 完整时间线，需要细节时查
└── codex-01a1c928/            # codex2cc 生成
    ├── HANDOFF.md
    └── transcript.md
```

`HANDOFF.md` 包含：给接手者的说明、会话信息、中断状态、用户的全部原话、任务列表、计划文件、改动过的文件、Git 现状（含会话里改过的其他仓库）、早期压缩摘要、精简时间线、中断前最后两轮的现场。

## 全部选项

```
-s, --session <id|文件>   指定会话（id 前缀或 .jsonl 路径），默认取最近修改的
-o, --out <目录>          输出目录
-i, --interrupted         列出中断的会话并给出逐个接手的方法
-a, --all-projects        配合 --interrupted / --list，扫描所有项目
    --since <小时>        配合 --interrupted，只看最近多少小时，默认 24
    --json                配合 --interrupted / --list，输出 JSON（skill 用它）
    --max-chars <n>       HANDOFF.md 的长度预算，默认 30000 字符
    --detail-turns <n>    末尾完整保留的轮数，默认 2
    --stdout              把 HANDOFF.md 打印到标准输出，不写文件
    --no-redact           不脱敏，保留原文
-q, --quiet               只打印交接文档路径（适合脚本和 hook）
```

## 它是怎么工作的

- `src/locate.js`：把项目路径编码成 Claude Code 的目录名（`D:\my-app` → `D--my-app`），路径过长被截断时按记录里的 `cwd` 匹配。
- `src/parse.js`：流式读取 Claude Code 的 JSONL，从最后一条消息沿 `parentUuid` 回溯出当前主线（排除回退分支和子代理侧链），并跨过自动压缩的边界；`analyze()` 从统一的事件流里还原任务列表、计划文件、改动文件、错误和中断点。
- `src/codex.js`：索引 `~/.codex/sessions` 下所有 rollout 文件的 `session_meta`，按 `cwd` 找到项目的线程（排除子代理线程），沿 `history_base` 把分页或 fork 的多个文件拼成完整线程；工具调用优先取 Codex 自己的 `item_completed` 结构化记录（`CommandExecution`、`FileChange` 等），过滤掉 AGENTS.md、环境信息等注入的用户消息，再转换成同一种事件流交给 `analyze()`。
- `src/status.js`：只读会话文件末尾判断是否中断，一次扫描所有项目也不到一秒。
- `src/redact.js`：按常见形态（`sk-…`、`ghp_…`、`AKIA…`、JWT、`Bearer …`、`password=…`、私钥块等）脱敏。
- `src/render.js`：按长度预算渲染，超出时逐级压缩时间线、早期摘要、诉求和现场。
- `src/cli.js`：两个命令共用的入口逻辑。

## 安全提醒

会话记录里可能有你贴过的密钥、命令输出等敏感内容。cc2codex 默认会把常见形态的密钥脱敏，但规则不可能覆盖所有情况；`.handoff/` 默认被 git 忽略，分享给别人前请自己再检查一遍。

## 开发

```bash
npm test   # node:test，用合成的会话记录覆盖两个方向的解析、多会话扫描、脱敏和命令行
```

GitHub Actions 会在 Windows、macOS、Linux 和 Node 18 / 20 / 22 上跑同一套测试。

## License

MIT

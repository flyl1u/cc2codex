# cc2codex

在 Claude Code 和 Codex 之间接力开发。一边额度用完了，就把当前会话整理成一份交接文档，让另一边读完接着干。

| 命令 | 方向 | 读取的记录 | 接手方的 skill |
| --- | --- | --- | --- |
| `cc2codex` | Claude Code → Codex | `~/.claude/projects/<项目>/<会话>.jsonl` | Codex：`resume-from-claude` |
| `codex2cc` | Codex → Claude Code | `~/.codex/sessions/**/rollout-*.jsonl` | Claude Code：`resume-from-codex` |

- **不调用任何模型**：直接解析两个工具存在本地的会话记录，额度用完也能跑。
- **去噪压缩**：几十到上百 MB 的记录压到 30KB 左右，丢掉思考过程、请求原文、文件快照、注入的系统提示等噪音。
- **零依赖**：只要 Node.js 18+。

## 安装（一次）

```bash
cd D:\cc2codex
npm link                 # 全局可用 cc2codex 和 codex2cc 两个命令
cc2codex install-skill   # 同时安装 Codex 的 resume-from-claude 和 Claude Code 的 resume-from-codex
```

不想 `npm link` 的话，也可以直接用 `node D:\cc2codex\bin\cc2codex.js` / `node D:\cc2codex\bin\codex2cc.js`。skill 里写的就是这种绝对路径，所以不 link 也能用。移动了本目录后，重新运行一次 `install-skill`。

## 使用流程

### Claude Code 额度用完 → 去 Codex 接着做

1. 在 Codex 里打开**同一个项目目录**。
2. 说「接着 Claude 的活继续」。skill 会自己运行 `cc2codex`、读交接文档、核对 git，然后向你复述目标和下一步。
3. 确认后它开始干活。

没装 skill 时：在项目目录运行 `cc2codex`，再把它打印的那句话发给 Codex。

### Codex 额度用完 → 回 Claude Code 接着做

1. 在 Claude Code 里打开同一个项目目录。
2. 说「接着 Codex 的活继续」，或者输入 `/resume-from-codex`。
3. 确认复述无误后继续。

没装 skill 时：运行 `codex2cc`，再让 Claude 读 `.handoff/HANDOFF.md`。

### 接的不是最近那个会话

```bash
cc2codex --list          # 列出本项目的 Claude Code 会话
codex2cc --list          # 列出本项目的 Codex 会话
cc2codex -s 2f98f672     # 按 id 前缀指定
codex2cc -s path/to/rollout-xxx.jsonl   # 直接指定会话文件
```

在 skill 里也可以直接说「接 Claude 那个叫『官网优化』的会话」，它会先 `--list` 再选。

## 生成的文件

| 文件 | 内容 |
| --- | --- |
| `.handoff/HANDOFF.md` | 交接文档：用户全部原话、中断状态、任务列表、计划文件、改动文件、Git 现状（含会话里改过的其他仓库）、精简时间线、中断前最后两轮的现场 |
| `.handoff/transcript.md` | 完整时间线，需要细节时查 |
| `.handoff/.gitignore` | 让这个目录不进 git |

两个方向共用 `.handoff/`，后生成的覆盖先生成的，文档标题会写明方向。

### 其他选项

```bash
cc2codex --stdout > handoff.md   # 不写 .handoff，直接输出
cc2codex --max-chars 20000       # 调整 HANDOFF.md 的长度预算（默认 30000 字符）
cc2codex --detail-turns 3        # 末尾完整保留 3 轮（默认 2）
cc2codex -q                      # 静默，适合放进 hook
```

## 它是怎么工作的

- `src/locate.js`：把项目路径编码成 Claude Code 的目录名（`D:\FocuSD` → `D--FocuSD`），路径过长被截断时按记录里的 `cwd` 匹配。
- `src/parse.js`：流式读取 Claude Code 的 JSONL，从最后一条消息沿 `parentUuid` 回溯出当前主线（排除回退分支和子代理侧链），并跨过自动压缩的边界；`analyze()` 从统一的事件流里还原任务列表、计划文件、改动文件、错误和中断点。
- `src/codex.js`：索引 `~/.codex/sessions` 下所有 rollout 文件的 `session_meta`，按 `cwd` 找到项目的线程（排除子代理线程），沿 `history_base` 把分页或 fork 的多个文件拼成完整线程；工具调用优先取 Codex 自己的 `item_completed` 结构化记录（`CommandExecution`、`FileChange` 等），过滤掉 AGENTS.md、环境信息等注入的用户消息，再转换成同一种事件流交给 `analyze()`。
- `src/render.js`：按长度预算渲染，超出时逐级压缩时间线、早期摘要、诉求和现场。
- `src/cli.js`：两个命令共用的入口逻辑。

## 安全提醒

会话记录里可能有你贴过的密钥、命令输出等敏感内容，`.handoff/` 会原样带上一部分。它默认被 git 忽略，分享给别人前请自己检查一遍。

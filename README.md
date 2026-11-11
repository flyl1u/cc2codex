# cc2codex

在 Claude Code 里做到一半额度用完了？`cc2codex` 把当前会话整理成一份交接文档，让 Codex 读完就能接着干。

- **不调用任何模型**：直接解析 Claude Code 存在本地的会话记录（`~/.claude/projects/<项目>/<会话>.jsonl`），额度用完也能跑。
- **去噪压缩**：几十 MB 的记录压到 30KB 左右，丢掉思考过程、请求原文、文件快照等噪音。
- **零依赖**：只要 Node.js 18+。

## 安装

```bash
cd D:\cc2codex
npm link              # 全局可用 cc2codex 命令
cc2codex install-skill   # 把 resume-from-claude skill 装进 Codex
```

不想 `npm link` 的话，也可以直接 `node D:\cc2codex\bin\cc2codex.js`。

## 用法

在项目根目录（就是 Claude Code 当时打开的目录）运行：

```bash
cc2codex
```

会生成：

| 文件 | 内容 |
| --- | --- |
| `.handoff/HANDOFF.md` | 交接文档：用户全部原话、中断状态、任务列表、计划文件、改动文件、Git 现状、精简时间线、中断前最后两轮的完整现场 |
| `.handoff/transcript.md` | 完整时间线，供需要细节时查 |
| `.handoff/.gitignore` | 让这个目录不进 git |

然后在 Codex 里打开同一个项目，说「接着 Claude 的活继续」（装了 skill），或者发：

> 请先完整阅读 .handoff/HANDOFF.md，这是我在 Claude Code 里做到一半的工作。核对代码现状后，复述目标、进度和你准备的下一步，等我确认再动手。

### 常用选项

```bash
cc2codex --list                 # 列出本项目所有会话
cc2codex -s 2f98f672            # 指定会话（id 前缀）
cc2codex -s path/to/x.jsonl     # 直接指定会话文件
cc2codex --stdout | clip        # 不写文件，直接复制到剪贴板
cc2codex --max-chars 20000      # 调整 HANDOFF.md 的长度预算
cc2codex --detail-turns 3       # 末尾完整保留 3 轮
```

## 它是怎么工作的

1. `src/locate.js`：把项目路径编码成 Claude Code 的目录名（`D:\FocuSD` → `D--FocuSD`），找到最近修改的会话；路径过长被截断时，按记录里的 `cwd` 字段匹配。
2. `src/parse.js`：逐行流式读取 JSONL，从最后一条消息沿 `parentUuid` 回溯出当前主线（排除回退分支和子代理侧链），跨过自动压缩的边界；同时还原任务列表（`TodoWrite` / `update_plan` / `TaskCreate`）、计划文件、改动文件、API 错误和中断点。
3. `src/render.js`：按长度预算渲染，超出时逐级压缩时间线和早期摘要；最后两轮始终完整保留。

## 安全提醒

会话记录里可能有你粘贴过的密钥、命令输出等敏感内容，`.handoff/` 会原样带上一部分。它默认被 git 忽略，分享给别人前请自己检查一遍。

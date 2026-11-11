---
name: resume-from-claude
description: |
  接手用户在 Claude Code 里做到一半的开发工作（通常是 Claude 额度用完了）。读取 cc2codex 从本地 Claude Code 会话记录提取的交接文档 .handoff/HANDOFF.md，核对代码现状后继续开发。
  触发方式：「接着 Claude 的活」「继续 Claude Code 里的工作」「Claude 额度用完了，你接着做」「读一下 handoff」「resume from claude」
  Use when the user wants to continue work that was started in Claude Code (e.g. Claude ran out of quota), or mentions .handoff/HANDOFF.md.
---

# resume-from-claude：接手 Claude Code 的半成品

用户之前在 Claude Code 里开发这个项目，中途被打断了。你要做的是**接着做下去**，而不是重新设计。

## 第一步：拿到交接文档

1. 在项目根目录查看 `.handoff/HANDOFF.md` 是否存在，以及它的生成时间是否晚于最后一次 Claude 会话。
2. 不存在或已过期，就运行下面的命令重新生成（只读本地文件，几秒钟完成）：

   ```bash
   {{CC2CODEX}}
   ```

   - 如果提示找不到会话：用 `{{CC2CODEX}} --list` 列出该项目的会话，或问用户 Claude Code 当时打开的是哪个目录，再用 `{{CC2CODEX}} <那个目录> -o .handoff` 生成。
   - 用户说要接的不是最近一个会话时，用 `--list` 找到它，再用 `--session <id 前缀>` 指定。

## 第二步：读懂上下文

完整阅读 `.handoff/HANDOFF.md`，重点是：

- **用户的全部诉求**：用户原话，是需求的唯一可靠来源。后面的消息会修正前面的，以最新的为准。
- **中断状态 / 当前任务列表 / 计划文件**：做到哪一步了，还剩什么。
- **中断前最后的现场**：Claude 最后在做什么、跑了什么命令、拿到什么结果。若中断在某个工具调用上，那一步很可能没做完或没做对。
- **Git 现状**：注意会话可能改了项目目录以外的仓库，文档里会一并列出。

需要更多细节（某个决定的来由、某次报错的完整输出）时，到 `.handoff/transcript.md` 里搜索，不要整篇读完。

## 第三步：核对，再复述

1. 跑 `git status`、`git diff`、`git log --oneline -10`，确认记录里说的改动确实在代码里。**记录和代码不一致时以代码为准**，并把差异告诉用户。
2. 用三到五句话向用户复述：
   - 这个任务的目标是什么；
   - 已经完成了什么（提到关键提交或文件）；
   - 中断在哪里，还剩什么；
   - 你准备的下一步。
3. **等用户确认后再改代码**。用户已经明确说「直接继续」时可以跳过等待。

## 注意

- 沿用 Claude 已经定下的方案、命名和代码风格，除非用户要求改，不要推翻重来。
- 交接文档里「Claude 说过的话」是上一位助手的说法，不一定正确；用户原话和代码才是事实。
- 记录里提到的推送、部署、发消息等对外操作，即使 Claude 当时准备做，也要先问用户。
- `.handoff/` 目录自带 `.gitignore`，不要提交它。

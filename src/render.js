'use strict';
// 把解析结果渲染成 HANDOFF.md（精简、有长度预算）和 transcript.md（完整时间线）
const fs = require('fs');
const path = require('path');

function trunc(s, n) {
  if (!s) return '';
  s = String(s);
  if (s.length <= n) return s;
  return s.slice(0, n) + `…（省略 ${s.length - n} 字）`;
}

function oneLine(s, n) {
  return trunc(String(s || '').replace(/\s+/g, ' ').trim(), n);
}

function fmtTs(ts) {
  if (!ts) return '?';
  const d = new Date(ts);
  if (isNaN(d)) return ts;
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function rel(p, cwd) {
  if (!p || !cwd) return p;
  const r = path.relative(cwd, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.replace(/\\/g, '/') : p;
}

function quote(s) {
  return String(s).split('\n').map((l) => '> ' + l).join('\n');
}

function fence(s, lang = '') {
  const body = String(s).replace(/```/g, '`​``');
  return '```' + lang + '\n' + body + '\n```';
}

// 把嵌入内容里的 Markdown 标题降两级，避免和交接文档自己的章节混在一起（代码块内不动）
function demote(s) {
  let inFence = false;
  return String(s || '')
    .split('\n')
    .map((l) => {
      if (/^\s*```/.test(l)) inFence = !inFence;
      if (inFence) return l;
      return l.replace(/^(#{1,4}) /, (m, h) => '#'.repeat(h.length + 2) + ' ');
    })
    .join('\n');
}

function stripReminders(s) {
  return String(s || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

function shortName(name) {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[1]}.${m[2]}` : name;
}

const SILENT_TOOLS = /(update_plan|mark_chapter|ToolSearch)$/;

// 工具调用的一行描述
function toolSummary(item, cwd) {
  const { name, input: i = {} } = item;
  const r = (p) => '`' + rel(p, cwd) + '`';
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `${name} \`${oneLine(i.command, 160)}\`` + (i.description ? ` — ${oneLine(i.description, 80)}` : '');
    case 'Read':
      return `Read ${r(i.file_path)}`;
    case 'Write':
      return `Write ${r(i.file_path)}（${String(i.content || '').split('\n').length} 行）`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${r(i.file_path)}`;
    case 'NotebookEdit':
      return `NotebookEdit ${r(i.notebook_path)}`;
    case 'Glob':
      return `Glob \`${i.pattern}\``;
    case 'Grep':
      return `Grep \`${oneLine(i.pattern, 80)}\`` + (i.path ? ` in ${r(i.path)}` : '');
    case 'Agent':
    case 'Task':
      return `子代理[${i.subagent_type || 'general'}] ${oneLine(i.description || i.prompt, 100)}`;
    case 'WebFetch':
      return `WebFetch ${i.url}`;
    case 'WebSearch':
      return `WebSearch “${oneLine(i.query, 100)}”`;
    case 'Skill':
      return `Skill ${i.skill}` + (i.args ? ` ${oneLine(i.args, 60)}` : '');
    case 'TodoWrite':
      return '更新任务列表';
    default:
      if (/wrap_up$/.test(name)) return `阶段小结：${oneLine(i.recap, 300)}`;
      return `${shortName(name)} ${oneLine(JSON.stringify(i), 120)}`;
  }
}

function resultMark(item, detail) {
  const res = item.result;
  if (!res) return ' ⚠ 无结果（可能被中断）';
  if (res.isError) return ` ✗ 失败：${oneLine(res.text, detail ? 400 : 160)}`;
  return '';
}

function taskList(tasks) {
  const mark = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
  return tasks.map((t) => `- ${mark[t.status] || '[ ]'} ${t.content}${t.status === 'in_progress' ? '  ← 进行中' : ''}`).join('\n');
}

// 精简版的一轮
function renderTurnCondensed(turn, idx, cwd, level) {
  if (level >= 3) {
    const n = turn.items.filter((x) => x.type === 'tool' && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(x.name)).length;
    return `- 第 ${idx + 1} 轮：${oneLine(turn.user || '（无用户消息）', 80)}${n ? `（改文件 ${n} 次）` : ''}`;
  }
  const caps = [
    { user: 400, lastText: 800, otherText: 200, others: 3 },
    { user: 200, lastText: 400, otherText: 120, others: 1 },
    { user: 120, lastText: 200, otherText: 0, others: 0 },
  ][level];
  const out = [`### 第 ${idx + 1} 轮 · ${fmtTs(turn.ts)}`];
  if (turn.user) out.push(`- **用户**：${oneLine(turn.user, caps.user)}`);
  const texts = turn.items.filter((x) => x.type === 'text');
  const tools = turn.items.filter((x) => x.type === 'tool' && !SILENT_TOOLS.test(x.name));
  if (caps.others && texts.length > 1) {
    for (const t of texts.slice(0, -1).slice(-caps.others)) out.push(`- Claude：${oneLine(t.text, caps.otherText)}`);
  }
  const edited = [...new Set(tools.filter((t) => ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(t.name) && !(t.result && t.result.isError)).map((t) => rel(t.input.file_path || t.input.notebook_path, cwd)))];
  if (edited.length) out.push(`- 改动：${edited.slice(0, 12).map((f) => '`' + f + '`').join('、')}${edited.length > 12 ? ` 等 ${edited.length} 个` : ''}`);
  const counts = {};
  for (const t of tools) counts[shortName(t.name)] = (counts[shortName(t.name)] || 0) + 1;
  const failed = tools.filter((t) => t.result && t.result.isError).length;
  if (tools.length) out.push(`- 工具：${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join('，')}${failed ? `（${failed} 次失败）` : ''}`);
  for (const t of tools.filter((t) => /wrap_up$/.test(t.name))) out.push(`- 📌 ${toolSummary(t, cwd)}`);
  const errs = turn.items.filter((x) => x.type === 'error');
  for (const e of errs.slice(-2)) out.push(`- ⚠ 错误：${oneLine(e.text, 160)}`);
  if (texts.length) out.push(`- **Claude 本轮最后说**：${oneLine(texts[texts.length - 1].text, caps.lastText)}`);
  return out.join('\n');
}

// 完整版的一轮（用于中断前现场和 transcript）
function renderTurnDetailed(turn, idx, cwd, { textCap, resultCap, maxItems = Infinity }) {
  const out = [`### 第 ${idx + 1} 轮 · ${fmtTs(turn.ts)}`];
  if (turn.user) out.push('**用户：**\n\n' + quote(trunc(turn.user, textCap * 2)));
  for (const img of turn.images) out.push(`（附图：\`${img}\`）`);
  const visible = turn.items.filter((it) => !(it.type === 'tool' && SILENT_TOOLS.test(it.name)));
  if (visible.length > maxItems) out.push(`（本轮前面还有 ${visible.length - maxItems} 步已省略，完整过程见 .handoff/transcript.md）`);
  for (const it of visible.slice(-maxItems)) {
    if (it.type === 'text') out.push('**Claude：** ' + demote(trunc(it.text, textCap)));
    else if (it.type === 'error') out.push(`⚠ **错误：** ${trunc(it.text, 500)}`);
    else if (it.type === 'notice') out.push(`（系统通知：${oneLine(it.text, 200)}）`);
    else if (it.type === 'tool') {
      if (SILENT_TOOLS.test(it.name)) continue;
      let line = `- 🔧 ${toolSummary(it, cwd)}${resultMark(it, true)}`;
      const res = it.result;
      if (res && !res.isError && resultCap && ['Bash', 'PowerShell', 'Agent', 'Task'].includes(it.name) && res.text && res.text.trim()) {
        const body = res.text.replace(/^Shell cwd was reset to .*$/gm, '').trim();
        if (body) line += '\n\n' + fence(trunc(body, resultCap)).split('\n').map((l) => '  ' + l).join('\n');
      }
      out.push(line);
    }
  }
  return out.join('\n\n');
}

function readPlan(data) {
  if (data.planPath) {
    try { return { path: data.planPath, text: fs.readFileSync(data.planPath, 'utf8') }; } catch { /* 文件已不在，退回记录里的内容 */ }
  }
  if (data.planText) return { path: data.planPath, text: data.planText };
  return null;
}

function renderHandoff(data, git, opts = {}) {
  const { meta, turns } = data;
  const cwd = meta.cwd;
  const maxChars = opts.maxChars || 30000;
  const detailTurns = opts.detailTurns || 2;
  const humanTurns = turns.filter((t) => t.user);

  const head = [];
  head.push('# Claude Code → Codex 交接文档');
  head.push(`> 由 cc2codex 于 ${fmtTs(new Date().toISOString())} 从本地 Claude Code 会话记录自动提取，没有经过任何模型二次总结。文中的「Claude」指上一位开发助手，「用户」就是现在和你对话的人。`);
  head.push(`## 给接手者的说明
1. 这是一个开发到一半被打断的会话（通常是 Claude 额度用完）。你的任务是**接着做下去**，不是从头再来。
2. 建议阅读顺序：「用户的全部诉求」→「当前任务列表 / 计划」→「中断前最后的现场」。时间线用来补背景。
3. 记录可能落后于代码。动手前先跑 \`git status\` / \`git diff\` 核对，**两者不一致时以代码为准**。
4. 开始改代码前，先用两三句话向用户复述：目标是什么、已经完成了什么、你准备的下一步，等用户确认。
5. 需要更多细节时看 \`.handoff/transcript.md\`（完整时间线），或原始记录 \`${meta.file}\`。`);

  head.push(`## 会话信息
- 项目目录：\`${cwd || '?'}\`
- 会话：${meta.title ? `「${meta.title}」 ` : ''}\`${meta.sessionId || path.basename(meta.file, '.jsonl')}\`
- 时间：${fmtTs(meta.firstTs)} → ${fmtTs(meta.lastTs)}，共 ${humanTurns.length} 轮用户消息
- Git 分支（会话中）：${meta.gitBranch || '无'}；Claude Code 版本：${meta.version || '?'}`);

  const state = ['## 中断状态'];
  if (data.interruption) state.push(`- ${data.interruption}`);
  const lastErr = data.errors[data.errors.length - 1];
  if (lastErr) state.push(`- 最近一次 API 错误（${fmtTs(lastErr.ts)}，第 ${lastErr.turnIndex + 1} 轮）：${oneLine(lastErr.text, 200)}`);
  const lastRecap = data.recaps[data.recaps.length - 1];
  if (lastRecap) state.push(`- Claude 最近一次阶段小结（第 ${lastRecap.turnIndex + 1} 轮）：${oneLine(lastRecap.text, 400)}`);
  if (data.tasks && data.tasks.some((t) => t.status !== 'completed')) state.push('- 任务列表里还有未完成的项，见下方。');
  if (state.length === 1) state.push('- 会话正常结束在 Claude 的一段回复上，没有发现明显的中断信号；请结合最后的现场判断是否还有没做完的事。');

  const asksSec = (perAsk) => {
    const asks = ['## 用户的全部诉求（按时间顺序）'];
    turns.forEach((t, i) => {
      if (!t.user) return;
      asks.push(`**${i + 1}.** ${fmtTs(t.ts)}\n\n${quote(trunc(t.user, perAsk))}` + (t.images.length ? `\n\n（附图 ${t.images.length} 张：${t.images.map((x) => '`' + x + '`').join('、')}）` : ''));
    });
    return asks;
  };

  const progress = [];
  if (data.tasks && data.tasks.length) progress.push(`## 当前任务列表（最后更新于 ${fmtTs(data.tasksTs)}）\n${taskList(data.tasks)}`);
  const plan = readPlan(data);
  if (plan) progress.push(`## 计划文件${plan.path ? `（\`${plan.path}\`）` : ''}\n\n${trunc(demote(plan.text.trim()), 8000)}`);

  const filesSec = [];
  if (data.files.size) {
    const list = [...data.files.entries()].sort((a, b) => b[1].lastTurn - a[1].lastTurn);
    filesSec.push('## Claude 改动过的文件（最近改动的在前）\n' + list.slice(0, 60).map(([f, v]) => `- \`${rel(f, cwd)}\` ×${v.count}（最后在第 ${v.lastTurn + 1} 轮）`).join('\n') + (list.length > 60 ? `\n- …另有 ${list.length - 60} 个` : ''));
  }
  if (git) filesSec.push('## Git 现状（生成本文件时）\n' + fence(git));

  const firstDetail = Math.max(0, turns.length - detailTurns);
  const tailLevels = [
    { textCap: 3000, resultCap: 1200, maxItems: Infinity },
    { textCap: 1500, resultCap: 500, maxItems: 60 },
    { textCap: 800, resultCap: 200, maxItems: 30 },
    { textCap: 400, resultCap: 0, maxItems: 15 },
  ];
  const tailSec = (level) => {
    const tail = ['## 中断前最后的现场' + (level ? '（按长度预算截取了最近的部分）' : '（完整）')];
    for (let i = firstDetail; i < turns.length; i++) tail.push(renderTurnDetailed(turns[i], i, cwd, tailLevels[level]));
    return tail;
  };

  const compactSec = (cap) => (data.compact ? [`## 早期对话摘要（Claude 自动压缩上下文时写的，覆盖第 ${data.compact.turnIndex} 轮之前）\n\n${trunc(demote(stripReminders(data.compact.text)), cap)}`] : []);

  const timelineSec = (level) => {
    const out = ['## 工作时间线（精简）'];
    for (let i = 0; i < firstDetail; i++) out.push(renderTurnCondensed(turns[i], i, cwd, level));
    return firstDetail > 0 ? out : [];
  };

  // 逐级压缩：[时间线级别, 早期摘要上限, 现场级别, 每条诉求上限]，直到满足长度预算
  const askCap = humanTurns.length > 30 ? 400 : humanTurns.length > 12 ? 800 : 1500;
  const attempts = [
    [0, 12000, 0, askCap],
    [1, 10000, 1, askCap],
    [2, 8000, 1, Math.min(askCap, 800)],
    [2, 5000, 2, 500],
    [3, 4000, 2, 300],
    [3, 2500, 3, 200],
  ];
  let doc = '';
  for (const [level, compactCap, tailLevel, perAsk] of attempts) {
    const parts = [...head, state.join('\n'), ...asksSec(perAsk), ...progress, ...filesSec, ...compactSec(compactCap), ...timelineSec(level), ...tailSec(tailLevel)];
    doc = parts.join('\n\n') + '\n';
    if (doc.length <= maxChars) break;
  }
  return doc;
}

function renderTranscript(data) {
  const { meta, turns } = data;
  const out = [`# 完整时间线：${meta.title || meta.sessionId || ''}`, `> 项目 \`${meta.cwd}\`，原始记录 \`${meta.file}\`。思考过程和大块工具输出已省略。`];
  turns.forEach((t, i) => {
    for (const c of data.compacts.filter((c) => c.turnIndex === i)) {
      out.push(`---\n\n## ⟲ 此处 Claude 压缩过上下文，压缩摘要如下\n\n${demote(stripReminders(c.text))}\n\n---`);
    }
    out.push(renderTurnDetailed(t, i, meta.cwd, { textCap: 6000, resultCap: 500 }));
  });
  return out.join('\n\n') + '\n';
}

module.exports = { renderHandoff, renderTranscript, fmtTs };

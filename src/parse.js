'use strict';
// 流式解析 Claude Code 会话 JSONL，抽取出对接力有用的结构化信息
const fs = require('fs');
const readline = require('readline');

const PLAN_RE = /[\\/]\.claude[\\/]plans[\\/][^\\/]+\.md$/i;
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (!c) return '';
      if (c.type === 'text') return c.text || '';
      if (c.type === 'image') return '[图片]';
      if (c.type === 'tool_reference') return '';
      return c.text || '';
    })
    .filter(Boolean)
    .join('\n');
}

// 把斜杠命令包装成可读形式，过滤掉本地命令输出等噪音
function cleanHumanText(t) {
  if (!t) return null;
  // 桌面版会把 <system-reminder> 等系统提醒存成用户消息，去掉后为空就不是用户说的话
  const s = t.replace(/<(system-reminder|task-notification)>[\s\S]*?<\/\1>/g, '').trim();
  if (!s) return null;
  if (/^<local-command-(stdout|stderr)>/.test(s)) return null;
  if (/^Caveat: The messages below were generated/.test(s)) return null;
  const cmd = s.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = (s.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
    return `${cmd[1].trim()} ${args.trim()}`.trim();
  }
  return s;
}

function slimRecord(o) {
  const r = { uuid: o.uuid, parent: o.parentUuid || null, logicalParent: o.logicalParentUuid || null, side: !!o.isSidechain, ts: o.timestamp, events: [] };
  const ev = r.events;

  if (o.type === 'user') {
    const c = o.message && o.message.content;
    if (o.isCompactSummary) {
      ev.push({ kind: 'compact', text: textOf(c) });
    } else if (Array.isArray(c) && c.some((x) => x && x.type === 'tool_result')) {
      for (const x of c) {
        if (x && x.type === 'tool_result') {
          ev.push({ kind: 'tool_result', id: x.tool_use_id, isError: !!x.is_error, text: textOf(x.content) });
        }
      }
    } else if (o.isMeta) {
      const t = textOf(c);
      if (/^\[Image: source:/.test(t)) ev.push({ kind: 'image', text: t.replace(/^\[Image: source:\s*/, '').replace(/\]$/, '') });
    } else if (o.origin && o.origin.kind && o.origin.kind !== 'human') {
      const t = textOf(c);
      ev.push({ kind: 'notice', text: t.slice(0, 400) });
    } else {
      const t = cleanHumanText(textOf(c));
      if (t) ev.push({ kind: 'user', text: t });
    }
  } else if (o.type === 'assistant') {
    const c = (o.message && o.message.content) || [];
    if (o.isApiErrorMessage) {
      ev.push({ kind: 'api_error', text: textOf(c) });
    } else {
      for (const x of Array.isArray(c) ? c : []) {
        if (!x) continue;
        if (x.type === 'text' && x.text && x.text.trim()) ev.push({ kind: 'text', text: x.text.trim() });
        else if (x.type === 'tool_use') ev.push({ kind: 'tool_use', id: x.id, name: x.name, input: x.input || {} });
      }
    }
  } else if (o.type === 'system') {
    if (o.subtype === 'api_error') {
      const e = o.error || {};
      ev.push({ kind: 'api_error', text: e.formatted || e.message || 'API error' });
    } else if (o.subtype === 'compact_boundary') {
      ev.push({ kind: 'compact_boundary' });
    }
  }
  return r;
}

async function parseSession(file) {
  const meta = { agent: 'Claude', file, title: null, cwd: null, gitBranch: null, version: null, firstTs: null, lastTs: null, sessionId: null };
  const records = new Map(); // uuid → slim record
  let lastUuid = null;
  const msgOrder = []; // 主线消息在文件中的顺序，用于跨压缩边界续接

  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line.length < 2) continue;
    // 最大的噪音（请求原文、文件快照）直接按类型前缀跳过，避免 JSON.parse 开销
    if (line.startsWith('{"type":"api-request') || line.startsWith('{"type":"file-history')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'custom-title' && o.customTitle) meta.title = o.customTitle;
    if (o.type === 'relocated' && o.relocatedCwd) meta.cwd = o.relocatedCwd;
    if (!o.uuid) continue;
    if (o.cwd && !meta.cwd) meta.cwd = o.cwd;
    if (o.gitBranch) meta.gitBranch = o.gitBranch;
    if (o.version) meta.version = o.version;
    if (o.sessionId) meta.sessionId = o.sessionId;
    if (o.timestamp) {
      if (!meta.firstTs) meta.firstTs = o.timestamp;
      meta.lastTs = o.timestamp;
    }
    const r = slimRecord(o);
    records.set(o.uuid, r);
    if (!r.side && (o.type === 'user' || o.type === 'assistant' || o.type === 'system')) {
      lastUuid = o.uuid;
      msgOrder.push(o.uuid);
    }
  }

  // 从最后一条消息沿 parentUuid 回溯，得到当前主线（排除被回退/重写的分支和 subagent 侧链）
  const chain = [];
  const seen = new Set();
  let cur = lastUuid;
  const msgPos = new Map(msgOrder.map((u, i) => [u, i]));
  while (cur && records.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const r = records.get(cur);
    chain.push(r);
    cur = r.parent || r.logicalParent;
    // 压缩边界的 logicalParentUuid 常指向文件里不存在的记录，此时接到文件中它前面的那条消息继续回溯
    if ((!cur || !records.has(cur)) && msgPos.has(r.uuid)) {
      let i = msgPos.get(r.uuid) - 1;
      while (i >= 0 && seen.has(msgOrder[i])) i--;
      cur = i >= 0 ? msgOrder[i] : null;
    }
  }
  chain.reverse();
  const mainline = chain.length >= 3 ? chain : [...records.values()].filter((r) => !r.side);

  // 展平事件并去重（压缩后保留段可能重复出现）
  const events = [];
  const seenTool = new Set();
  const seenResult = new Set();
  for (const r of mainline) {
    for (const e of r.events) {
      if (e.kind === 'tool_use') { if (seenTool.has(e.id)) continue; seenTool.add(e.id); }
      if (e.kind === 'tool_result') { if (seenResult.has(e.id)) continue; seenResult.add(e.id); }
      events.push({ ...e, ts: r.ts });
    }
  }
  return analyze(meta, events);
}

function analyze(meta, events) {
  const results = new Map();
  for (const e of events) if (e.kind === 'tool_result') results.set(e.id, e);

  const turns = []; // { user, images, items: [...] }
  let compact = null; // 最近一次自动压缩生成的摘要
  const compacts = [];
  let turn = null;
  const ensureTurn = () => {
    if (!turn) { turn = { user: null, ts: null, images: [], items: [] }; turns.push(turn); }
    return turn;
  };

  let tasks = null;
  let tasksTs = null;
  let taskSeq = 0;
  const files = new Map(); // path → { count, lastTurn }
  let planPath = null;
  let planText = null;
  const recaps = [];
  const errors = [];

  for (const e of events) {
    switch (e.kind) {
      case 'user':
        turn = { user: e.text, ts: e.ts, images: [], items: [] };
        turns.push(turn);
        break;
      case 'image':
        ensureTurn().images.push(e.text);
        break;
      case 'compact':
        compact = { text: e.text, turnIndex: turns.length };
        compacts.push(compact);
        break;
      case 'notice':
        ensureTurn().items.push({ type: 'notice', text: e.text, ts: e.ts });
        break;
      case 'api_error':
        ensureTurn().items.push({ type: 'error', text: e.text, ts: e.ts });
        errors.push({ text: e.text, ts: e.ts, turnIndex: turns.length - 1 });
        break;
      case 'text':
        ensureTurn().items.push({ type: 'text', text: e.text, ts: e.ts });
        break;
      case 'tool_use': {
        const res = results.get(e.id) || null;
        ensureTurn().items.push({ type: 'tool', name: e.name, input: e.input, result: res, ts: e.ts });
        const inp = e.input || {};
        // 任务列表状态
        if (e.name === 'TodoWrite' && Array.isArray(inp.todos)) {
          tasks = inp.todos.map((t) => ({ content: t.content || t.subject || '', status: t.status || 'pending' }));
          tasksTs = e.ts;
        } else if (/update_plan$/.test(e.name)) {
          if (Array.isArray(inp.items)) tasks = inp.items.map((t) => ({ content: t.content, status: t.status || 'pending' }));
          else if (tasks) {
            if (inp.advance) {
              const i = tasks.findIndex((t) => t.status === 'in_progress');
              if (i >= 0) tasks[i].status = 'completed';
              const n = tasks.findIndex((t) => t.status === 'pending');
              if (n >= 0) tasks[n].status = 'in_progress';
            }
            for (const d of inp.done || []) if (tasks[d - 1]) tasks[d - 1].status = 'completed';
            if (inp.start && tasks[inp.start - 1]) tasks[inp.start - 1].status = 'in_progress';
          }
          tasksTs = e.ts;
        } else if (/wrap_up$/.test(e.name)) {
          if (tasks) tasks.forEach((t) => { t.status = 'completed'; });
          if (inp.recap) recaps.push({ text: inp.recap, ts: e.ts, turnIndex: turns.length - 1 });
        } else if (e.name === 'TaskCreate') {
          tasks = tasks || [];
          taskSeq += 1;
          tasks.push({ id: String(taskSeq), content: inp.subject || inp.description || '', status: 'pending' });
          tasksTs = e.ts;
        } else if (e.name === 'TaskUpdate' && tasks) {
          const t = tasks.find((x) => x.id === String(inp.taskId));
          if (t && inp.status) t.status = inp.status;
          tasksTs = e.ts;
        }
        // 计划文件与改动文件
        const fp = inp.file_path || inp.notebook_path;
        if (EDIT_TOOLS.has(e.name) && fp) {
          if (PLAN_RE.test(fp)) {
            planPath = fp;
            if (e.name === 'Write' && inp.content) planText = inp.content;
          } else if (!(res && res.isError) && !/[\\/]\.codex[\\/]/i.test(fp)) {
            // ~/.codex 下是 Codex 自己的临时文件（截图脚本等），不算项目改动
            const f = files.get(fp) || { count: 0, lastTurn: 0 };
            f.count += 1;
            f.lastTurn = turns.length - 1;
            files.set(fp, f);
          }
        }
        if (e.name === 'ExitPlanMode' && inp.plan) planText = inp.plan;
        break;
      }
      default:
        break;
    }
  }

  // 判断中断状态
  const A = meta.agent || 'Claude';
  const lastTurn = turns[turns.length - 1];
  let interruption = null;
  if (lastTurn) {
    const last = lastTurn.items[lastTurn.items.length - 1];
    if (!last) interruption = `用户最后一条消息发出后，${A} 还没有任何回应。`;
    else if (last.type === 'error') interruption = `会话以错误结束：${last.text}`;
    else if (last.type === 'tool' && !last.result) interruption = `中断在工具调用 ${last.name} 上，没有拿到结果。`;
    else if (last.type === 'tool') interruption = `最后一步是工具调用 ${last.name}，之后 ${A} 没有再给出结论（可能被中断）。`;
  }

  return { meta, turns, compact, compacts, tasks, tasksTs, files, planPath, planText, recaps, errors, interruption };
}

module.exports = { parseSession, analyze };

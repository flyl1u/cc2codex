'use strict';
// Codex 会话记录：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// 一个线程可能分页存在多个文件里（session_meta.history_base 指向前一页），fork 出来的线程也一样
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const url = require('url');
const { analyze } = require('./parse');

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/^rollout-.*\.jsonl$/.test(e.name)) out.push(p);
  }
  return out;
}

// 读第一行 session_meta（里面带着几十 KB 的系统提示词，所以多读一点）
function readMeta(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(512 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.slice(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    const o = JSON.parse(nl >= 0 ? text.slice(0, nl) : text);
    if (o.type !== 'session_meta') return null;
    const p = o.payload || {};
    const st = fs.statSync(file);
    return {
      file,
      id: p.id,
      cwd: p.cwd,
      ts: p.timestamp,
      firstOrdinal: typeof o.ordinal === 'number' ? o.ordinal : 0,
      historyBase: p.history_base || null,
      subagent: p.thread_source === 'subagent' || (typeof p.source === 'object' && p.source && p.source.subagent),
      mtime: st.mtimeMs,
      size: st.size,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

let indexCache = null;
function indexAll() {
  if (!indexCache) indexCache = walk(path.join(codexHome(), 'sessions')).map(readMeta).filter(Boolean);
  return indexCache;
}

function threadTitles() {
  const titles = new Map();
  try {
    for (const l of fs.readFileSync(path.join(codexHome(), 'session_index.jsonl'), 'utf8').split('\n')) {
      if (!l) continue;
      try { const o = JSON.parse(l); if (o.id && o.thread_name) titles.set(o.id, o.thread_name); } catch { /* 忽略坏行 */ }
    }
  } catch { /* 没有索引文件 */ }
  return titles;
}

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

// 某个项目目录下的 Codex 线程（不含子代理），每个线程取最新的那一页文件
function findCodexSessions(projectDir) {
  const want = norm(projectDir);
  const titles = threadTitles();
  const byThread = new Map();
  for (const m of indexAll()) {
    if (m.subagent || !m.cwd || norm(m.cwd) !== want) continue;
    const prev = byThread.get(m.id);
    if (!prev || m.mtime > prev.mtime) byThread.set(m.id, m);
  }
  return [...byThread.values()]
    .map((m) => ({ ...m, title: titles.get(m.id) || null }))
    .sort((a, b) => b.mtime - a.mtime);
}

function resolveCodexSession({ projectDir, session }) {
  if (session && (session.endsWith('.jsonl') || /[\\/]/.test(session))) {
    const m = readMeta(path.resolve(session));
    if (!m) throw new Error(`不是有效的 Codex 会话文件：${session}`);
    return { ...m, title: threadTitles().get(m.id) || null };
  }
  const list = findCodexSessions(projectDir);
  if (!list.length) {
    throw new Error(
      `在 ${path.join(codexHome(), 'sessions')} 下没有找到项目 ${path.resolve(projectDir)} 的 Codex 会话。\n` +
        `请在 Codex 当时打开的项目目录运行，或用 --session <rollout 文件路径> 指定。`
    );
  }
  if (session) {
    const hit = list.find((s) => s.id === session || s.id.startsWith(session));
    if (!hit) throw new Error(`该项目下没有 id 以 ${session} 开头的 Codex 会话，可用 --list 查看。`);
    return hit;
  }
  return list[0];
}

async function readRecords(file, endOrdinal) {
  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    // 跳过体积最大又没用的记录
    if (/^\{"timestamp":"[^"]*","ordinal":\d+,"type":"(token_usage_record|world_state)"/.test(line)) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (endOrdinal !== undefined && typeof o.ordinal === 'number' && o.ordinal >= endOrdinal) break;
    out.push(o);
  }
  return out;
}

// 沿 history_base 拼出整条线程的记录
async function threadRecords(head, depth = 0) {
  const own = await readRecords(head.file);
  const hb = head.historyBase;
  if (!hb || !hb.thread_id || depth > 20) return own;
  const end = hb.end_ordinal_exclusive;
  const prev = indexAll()
    .filter((m) => m.id === hb.thread_id && m.file !== head.file && m.firstOrdinal < end)
    .sort((a, b) => b.firstOrdinal - a.firstOrdinal)[0];
  if (!prev) return own;
  const earlier = await threadRecords({ ...prev }, depth + 1);
  return [...earlier.filter((o) => typeof o.ordinal !== 'number' || o.ordinal < end), ...own];
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c && (c.text || (c.type === 'input_image' ? '[图片]' : ''))) || '').filter(Boolean).join('\n');
}

// 用户消息里混着 AGENTS.md、环境信息等注入内容，只留用户自己说的话
function userParts(content) {
  const out = [];
  for (const c of Array.isArray(content) ? content : [{ text: String(content || '') }]) {
    if (!c) continue;
    if (c.type === 'input_image') { out.push('[图片]'); continue; }
    const t = (c.text || '').trim();
    if (!t) continue;
    if (/^# AGENTS\.md instructions/.test(t)) continue;
    const reply = t.match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
    if (reply) {
      try {
        for (const q of JSON.parse(reply[1])) out.push(`（回答 Codex 的提问「${String(q.question || '').slice(0, 200)}」）${q.answer}`);
      } catch { out.push(t); }
      continue;
    }
    if (/^<[a-z_]+[\s>][\s\S]*<\/[a-z_]+>$/.test(t)) continue; // 整段都是注入的标签块
    out.push(t);
  }
  return out.join('\n');
}

function jsonArgs(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s || '{}'); } catch { return { raw: s }; }
}

function patchFiles(patch) {
  const files = [];
  for (const m of String(patch || '').matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) files.push({ op: m[1], path: m[2].trim() });
  return files;
}

function strLiteral(s) {
  try { return JSON.parse(s); } catch { return s.slice(1, -1); }
}

// 新版 Codex 用 exec 工具执行一段 JS，里面再调用 tools.exec_command / tools.apply_patch 等
function expandExecScript(code) {
  const calls = [];
  const re = /tools\.(\w+)\(/g;
  let m;
  while ((m = re.exec(code))) {
    const name = m[1];
    const rest = code.slice(m.index + m[0].length, m.index + m[0].length + 20000);
    if (name === 'exec_command') {
      const c = rest.match(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/);
      calls.push({ name: 'Bash', input: { command: c ? strLiteral(c[1].replace(/^'|'$/g, '"')) : '(命令在脚本变量里)' } });
    } else if (name === 'apply_patch') {
      for (const f of patchFiles(rest)) calls.push({ name: f.op === 'Add' ? 'Write' : 'Edit', input: { file_path: f.path, content: '' } });
    } else if (name === 'view_image') {
      const p = rest.match(/\bpath\s*:\s*("(?:[^"\\]|\\.)*")/);
      calls.push({ name: 'view_image', input: { path: p ? strLiteral(p[1]) : '' } });
    } else if (name !== 'write_stdin' && name !== 'clock__curr_time') {
      calls.push({ name, input: {} });
    }
  }
  return calls.length ? calls : [{ name: 'exec', input: { script: code.slice(0, 200) } }];
}

function normalizeFunctionCall(name, args) {
  const a = jsonArgs(args);
  if (name === 'shell' || name === 'exec_command' || name === 'shell_command') {
    const cmd = Array.isArray(a.command) ? a.command.join(' ') : a.command || a.cmd || '';
    return [{ name: 'Bash', input: { command: cmd } }];
  }
  if (name === 'apply_patch') return patchFiles(a.input || a.patch || args).map((f) => ({ name: f.op === 'Add' ? 'Write' : 'Edit', input: { file_path: f.path } }));
  if (name === 'update_plan') {
    return [{ name: 'update_plan', input: { items: (a.plan || []).map((p) => ({ content: p.step, status: p.status })) } }];
  }
  if (name === 'request_user_input_async' || name === 'request_user_input') {
    const qs = (a.questions || []).map((q) => q.title || q.question).filter(Boolean);
    return [{ name: 'AskUser', input: { question: qs.join(' / ') } }];
  }
  return [{ name, input: a }];
}

function outputText(out) {
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) return out.map((x) => (x && x.text) || '').join('\n');
  if (out && typeof out === 'object') return out.output || out.content || JSON.stringify(out);
  return '';
}

function looksFailed(text) {
  return /^Script (failed|error)/i.test(text) || /Process exited with code [1-9]/.test(text) || /^Error:/.test(text);
}

function fromFileUrl(p) {
  if (typeof p !== 'string' || !p.startsWith('file://')) return p;
  try { return url.fileURLToPath(p); } catch { return p; }
}

function maybeJson(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

// item_completed 事件是 Codex 自己整理好的结构化工具记录，优先使用
function itemToCalls(item) {
  switch (item.type) {
    case 'CommandExecution': {
      const parsed = maybeJson(item.parsed_cmd);
      let cmd = Array.isArray(parsed) && parsed[0] && parsed[0].cmd;
      if (!cmd) {
        const c = maybeJson(item.command);
        cmd = Array.isArray(c) ? c[c.length - 1] : String(c || '');
      }
      const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
      return [{ name: 'Bash', input: { command: cmd }, result: { isError: failed, text: String(maybeJson(item.aggregated_output) || '') } }];
    }
    case 'FileChange': {
      const changes = maybeJson(item.changes) || {};
      const failed = item.status === 'failed';
      return Object.entries(changes).map(([p, c]) => ({
        name: c && c.type === 'add' ? 'Write' : 'Edit',
        input: { file_path: p, content: '' },
        result: { isError: failed, text: item.stderr || item.stdout || '' },
      }));
    }
    case 'ImageView':
      return [{ name: 'view_image', input: { path: fromFileUrl(item.path) }, result: { isError: false, text: '' } }];
    case 'McpToolCall': {
      const r = item.result || {};
      return [{ name: `mcp__${item.server}__${item.tool}`, input: item.arguments || {}, result: { isError: !!r.isError || item.status === 'failed', text: contentText(r.content) } }];
    }
    case 'WebSearch':
      return [{ name: 'WebSearch', input: { query: item.query || '' }, result: { isError: false, text: '' } }];
    default:
      return [];
  }
}

// 把 Codex 记录转换成与 Claude 解析器相同的事件流
function toEvents(records) {
  const events = [];
  const meta = { cwd: null, gitBranch: null, version: null, firstTs: null, lastTs: null };
  let turnOpen = false;
  const pendingCalls = new Map(); // call_id → 展开后的事件 id 列表
  const hasItems = records.some((o) => o.type === 'event_msg' && o.payload && o.payload.type === 'item_completed' && /^(CommandExecution|FileChange)$/.test((o.payload.item || {}).type));
  const pendingExec = new Map(); // hasItems 模式下尚未拿到输出的 exec 调用：call_id → 占位事件
  let seq = 0;

  const push = (e, ts) => events.push({ ...e, ts });
  for (const o of records) {
    const p = o.payload || {};
    const ts = o.timestamp;
    if (ts) { if (!meta.firstTs) meta.firstTs = ts; meta.lastTs = ts; }
    if (o.type === 'session_meta') {
      meta.cwd = meta.cwd || p.cwd;
      meta.version = p.cli_version || meta.version;
      if (p.git && p.git.branch) meta.gitBranch = p.git.branch;
      continue;
    }
    if (o.type === 'turn_context' && p.cwd) { meta.cwd = p.cwd; continue; }
    if (o.type === 'compacted') {
      if (p.message && p.message.trim()) push({ kind: 'compact', text: p.message }, ts);
      continue;
    }
    if (o.type === 'event_msg') {
      if (p.type === 'task_started') turnOpen = true;
      else if (p.type === 'task_complete') turnOpen = false;
      else if (p.type === 'turn_aborted') { turnOpen = false; push({ kind: 'api_error', text: `本轮被中断（${p.reason || 'aborted'}）` }, ts); }
      else if (p.type === 'error' || p.type === 'stream_error') push({ kind: 'api_error', text: p.message || p.error || JSON.stringify(p).slice(0, 300) }, ts);
      else if (p.type === 'item_completed' && hasItems && p.item) {
        for (const c of itemToCalls(p.item)) {
          const id = `item-${seq++}`;
          push({ kind: 'tool_use', id, name: c.name, input: c.input }, ts);
          push({ kind: 'tool_result', id, isError: c.result.isError, text: c.result.text }, ts);
        }
      }
      continue;
    }
    if (o.type !== 'response_item') continue;

    if (p.type === 'message') {
      if (p.role === 'user') {
        const t = userParts(p.content);
        if (t) push({ kind: 'user', text: t }, ts);
      } else if (p.role === 'assistant') {
        const t = contentText(p.content).trim();
        if (t) push({ kind: 'text', text: t }, ts);
      }
    } else if (hasItems && p.type === 'custom_tool_call' && (p.name === 'exec' || p.name === 'apply_patch')) {
      // 具体操作由 item_completed 记录；这里只留占位，用来发现中断时没跑完的调用
      const ph = { kind: 'pending_exec', code: p.input || '', ts };
      events.push(ph);
      pendingExec.set(p.call_id || p.id, ph);
    } else if (hasItems && p.type === 'custom_tool_call_output') {
      pendingExec.delete(p.call_id);
    } else if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
      let calls;
      if (p.type === 'local_shell_call') calls = [{ name: 'Bash', input: { command: ((p.action || {}).command || []).join(' ') } }];
      else if (p.name === 'exec') calls = expandExecScript(p.input || '');
      else if (p.name === 'apply_patch') calls = patchFiles(p.input).map((f) => ({ name: f.op === 'Add' ? 'Write' : 'Edit', input: { file_path: f.path } }));
      else calls = normalizeFunctionCall(p.name, p.type === 'custom_tool_call' ? { input: p.input } : p.arguments);
      const ids = [];
      calls.forEach((c, i) => {
        const id = `${p.call_id || p.id}#${i}`;
        ids.push(id);
        push({ kind: 'tool_use', id, name: c.name, input: c.input }, ts);
      });
      pendingCalls.set(p.call_id || p.id, ids);
    } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output' || p.type === 'local_shell_call_output') {
      const text = outputText(p.output);
      const ids = pendingCalls.get(p.call_id) || [];
      for (const id of ids) push({ kind: 'tool_result', id, isError: looksFailed(text), text }, ts);
    }
  }
  if (turnOpen) meta.turnOpen = true;
  // 没拿到输出的 exec 调用展开成“无结果”的工具调用，其余占位删掉
  const unfinished = new Set(pendingExec.values());
  const out = [];
  for (const e of events) {
    if (e.kind !== 'pending_exec') { out.push(e); continue; }
    if (!unfinished.has(e)) continue;
    expandExecScript(e.code).forEach((c, i) => out.push({ kind: 'tool_use', id: `unfinished-${seq++}-${i}`, name: c.name, input: c.input, ts: e.ts }));
  }
  return { events: out, meta };
}

async function parseCodexSession(head) {
  const records = await threadRecords(head);
  const { events, meta: m } = toEvents(records);
  const meta = {
    agent: 'Codex',
    file: head.file,
    title: head.title || null,
    cwd: m.cwd || head.cwd,
    gitBranch: m.gitBranch,
    version: m.version,
    firstTs: m.firstTs,
    lastTs: m.lastTs,
    sessionId: head.id,
  };
  const data = analyze(meta, events);
  if (m.turnOpen && !data.interruption) data.interruption = 'Codex 最后一轮任务开始后没有正常结束（可能额度用完或被中断）。';
  return data;
}

module.exports = { codexHome, findCodexSessions, resolveCodexSession, parseCodexSession };

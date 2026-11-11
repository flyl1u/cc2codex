'use strict';
// 只读会话文件末尾，快速判断会话是否中断（不做完整解析，便于一次扫描很多会话）
const fs = require('fs');
const path = require('path');
const { projectsRoot, findSessions } = require('./locate');
const { findCodexSessions, allCodexThreads } = require('./codex');

const RUNNING_MS = 3 * 60 * 1000; // 最近 3 分钟内还在写入的，视为可能仍在运行

function tailLines(file, bytes) {
  const st = fs.statSync(file);
  const len = Math.min(st.size, bytes);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, st.size - len);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  if (len < st.size) lines.shift(); // 第一行可能不完整
  return lines.filter(Boolean);
}

function parseLines(lines) {
  const out = [];
  for (const l of lines) {
    try { out.push(JSON.parse(l)); } catch { /* 跳过不完整或损坏的行 */ }
  }
  return out;
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join(' ') : '');
// 去掉 <system-reminder> 等注入块后没剩下内容，就是系统注入的消息
const stripInjected = (t) => String(t || '').replace(/<(system-reminder|local-command-[a-z]+|task-notification)>[\s\S]*?<\/\1>/g, '').trim();
const isInjected = (t) => !stripInjected(t);
const short = (s, n = 120) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Claude Code：从最后一条主线消息判断
function claudeStatus(file) {
  const recs = parseLines(tailLines(file, 512 * 1024));
  let title = null;
  let lastPrompt = null;
  let cwd = null;
  for (const o of recs) {
    if (o.type === 'custom-title' && o.customTitle) title = o.customTitle;
    if (o.type === 'last-prompt' && o.lastPrompt) lastPrompt = o.lastPrompt;
    if (o.cwd) cwd = o.cwd;
  }
  let status = 'done';
  let reason = '';
  for (let i = recs.length - 1; i >= 0; i--) {
    const o = recs[i];
    if (!o.uuid || o.isSidechain) continue;
    if (o.type === 'system') {
      if (o.subtype === 'api_error') { status = 'interrupted'; reason = `API 错误：${short((o.error || {}).formatted || (o.error || {}).message)}`; break; }
      continue; // stop_hook_summary、compact_boundary 等
    }
    if (o.type === 'assistant') {
      const c = (o.message && o.message.content) || [];
      if (o.isApiErrorMessage) { status = 'interrupted'; reason = `额度或 API 错误：${short(textOf(c))}`; break; }
      const types = (Array.isArray(c) ? c : []).map((x) => x && x.type);
      if (types.includes('tool_use')) {
        const t = c.find((x) => x && x.type === 'tool_use');
        status = 'interrupted'; reason = `中断在工具调用 ${t.name} 上`; break;
      }
      if (types.includes('text')) break; // 正常以一段回复结束
      status = 'interrupted'; reason = '回复生成到一半'; break;
    }
    if (o.type === 'user') {
      const c = o.message && o.message.content;
      if (Array.isArray(c) && c.some((x) => x && x.type === 'tool_result')) { status = 'interrupted'; reason = '工具返回后没有继续'; break; }
      if (o.isCompactSummary) { status = 'interrupted'; reason = '压缩上下文后没有继续'; break; }
      if (o.isMeta || isInjected(textOf(c))) continue; // 系统注入的提醒，不是用户说的话
      status = 'interrupted'; reason = `用户消息没有得到回复：${short(stripInjected(textOf(c)), 60)}`; break;
    }
  }
  return { title: title || (lastPrompt ? short(lastPrompt, 50) : null), cwd, status, reason };
}

// Codex：看最后一轮任务是否正常结束
function codexStatus(file) {
  const recs = parseLines(tailLines(file, 1024 * 1024));
  let state = 'idle';
  let reason = '';
  for (const o of recs) {
    const p = o.payload || {};
    if (o.type !== 'event_msg') continue;
    if (p.type === 'task_started') { state = 'open'; reason = ''; }
    else if (p.type === 'task_complete') { if (state !== 'error') state = 'done'; }
    else if (p.type === 'turn_aborted') { state = 'aborted'; reason = `本轮被中断（${p.reason || 'aborted'}）`; }
    else if (p.type === 'error' || p.type === 'stream_error') { state = 'error'; reason = `错误：${short(p.message || p.error)}`; }
  }
  if (state === 'open') return { status: 'interrupted', reason: '最后一轮任务没有正常结束（可能额度用完）' };
  if (state === 'aborted' || state === 'error') return { status: 'interrupted', reason };
  return { status: 'done', reason: '' };
}

function withRunning(s, mtime) {
  if (s.status === 'interrupted' && Date.now() - mtime < RUNNING_MS) return { ...s, status: 'running', reason: '最近几分钟还在写入，可能仍在运行' };
  return s;
}

// 列出会话及其状态。source: 'claude' | 'codex'
function scanSessions(source, { projectDir, allProjects, sinceHours }) {
  const since = Date.now() - sinceHours * 3600 * 1000;
  let sessions;
  if (source === 'codex') {
    sessions = (allProjects ? allCodexThreads() : findCodexSessions(projectDir)).filter((s) => s.mtime >= since);
  } else if (allProjects) {
    sessions = [];
    let dirs = [];
    try { dirs = fs.readdirSync(projectsRoot()); } catch { /* 没有 projects 目录 */ }
    for (const d of dirs) {
      const dir = path.join(projectsRoot(), d);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const file = path.join(dir, n);
        const st = fs.statSync(file);
        if (st.mtimeMs >= since && st.size > 0) sessions.push({ id: n.slice(0, -6), file, mtime: st.mtimeMs, size: st.size });
      }
    }
  } else {
    sessions = findSessions(projectDir).filter((s) => s.mtime >= since);
  }

  const out = [];
  for (const s of sessions) {
    let st;
    try {
      st = source === 'codex' ? { ...codexStatus(s.file), title: s.title, cwd: s.cwd } : claudeStatus(s.file);
    } catch {
      continue;
    }
    st = withRunning(st, s.mtime);
    out.push({ source, id: s.id, file: s.file, mtime: s.mtime, project: st.cwd || s.cwd || projectDir, title: st.title || null, status: st.status, reason: st.reason });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

module.exports = { scanSessions, claudeStatus, codexStatus };

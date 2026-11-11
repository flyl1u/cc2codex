'use strict';
// 定位 Claude Code 的会话记录：项目路径 → ~/.claude/projects/<编码目录>/<session>.jsonl
const fs = require('fs');
const path = require('path');
const os = require('os');

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function projectsRoot() {
  return path.join(claudeHome(), 'projects');
}

// Claude Code 把路径里所有非字母数字字符替换成 '-'，例如 D:\my-app → D--my-app
function encodeProjectPath(p) {
  return path.resolve(p).replace(/[^a-zA-Z0-9]/g, '-');
}

function normPath(p) {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

// 读文件开头一段，找出记录里的 cwd 字段
function peekCwd(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.slice(0, n).toString('utf8');
    const m = text.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse('"' + m[1] + '"') : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function listSessionFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => {
      const file = path.join(dir, n);
      const st = fs.statSync(file);
      return { id: n.replace(/\.jsonl$/, ''), file, mtime: st.mtimeMs, size: st.size };
    })
    .filter((s) => s.size > 0)
    .sort((a, b) => b.mtime - a.mtime);
}

// 找到某个项目目录对应的所有会话（按最近修改排序）
function findSessions(projectDir) {
  const root = projectsRoot();
  const enc = encodeProjectPath(projectDir);
  const exact = path.join(root, enc);
  if (fs.existsSync(exact)) return listSessionFiles(exact);

  // 路径过长时目录名会被截断，退而按前缀匹配，再用记录里的 cwd 校验
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return []; }
  const want = normPath(projectDir);
  const candidates = dirs.filter((d) => enc.startsWith(d.slice(0, 150)) || d.startsWith(enc.slice(0, 150)));
  const pool = candidates.length ? candidates : dirs;
  const out = [];
  for (const d of pool) {
    for (const s of listSessionFiles(path.join(root, d))) {
      const cwd = peekCwd(s.file);
      if (cwd && normPath(cwd) === want) out.push(s);
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function resolveSession({ projectDir, session }) {
  if (session && (session.endsWith('.jsonl') || session.includes('/') || session.includes('\\'))) {
    const file = path.resolve(session);
    if (!fs.existsSync(file)) throw new Error(`找不到会话文件：${file}`);
    return { id: path.basename(file, '.jsonl'), file };
  }
  if (session) {
    // 先在本项目里找，找不到再跨项目按文件名找（多会话接力时，新会话可能开在别的目录）
    const local = findSessions(projectDir).find((s) => s.id.startsWith(session));
    if (local) return local;
    let dirs = [];
    try { dirs = fs.readdirSync(projectsRoot()); } catch { /* 没有 projects 目录 */ }
    for (const d of dirs) {
      const hit = listSessionFiles(path.join(projectsRoot(), d)).find((s) => s.id.startsWith(session));
      if (hit) return hit;
    }
    throw new Error(`没有 id 以 ${session} 开头的 Claude Code 会话，可用 --list 或 --interrupted --all-projects 查看。`);
  }
  const sessions = findSessions(projectDir);
  if (!sessions.length) {
    throw new Error(
      `在 ${projectsRoot()} 下没有找到项目 ${path.resolve(projectDir)} 的 Claude Code 会话。\n` +
        `请在项目根目录运行，或用 --session <会话文件路径> 指定。`
    );
  }
  return sessions[0];
}

module.exports = { claudeHome, projectsRoot, encodeProjectPath, findSessions, resolveSession };

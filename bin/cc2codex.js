#!/usr/bin/env node
'use strict';
// cc2codex：把 Claude Code 会话整理成 Codex 能直接接手的交接文档
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { findSessions, resolveSession, projectsRoot } = require('../src/locate');
const { parseSession } = require('../src/parse');
const { renderHandoff, renderTranscript, fmtTs } = require('../src/render');

const HELP = `cc2codex —— 把 Claude Code 会话接力给 Codex

用法：
  cc2codex [项目目录]            为该项目最近的 Claude Code 会话生成 .handoff/HANDOFF.md
  cc2codex --list [项目目录]     列出该项目的所有会话
  cc2codex install-skill          把 resume-from-claude skill 安装到 Codex（~/.codex/skills）

选项：
  -s, --session <id|文件>   指定会话（id 前缀或 .jsonl 路径），默认取最近修改的
  -o, --out <目录>          输出目录，默认 <项目目录>/.handoff
      --max-chars <n>       HANDOFF.md 的长度预算，默认 30000 字符
      --detail-turns <n>    末尾完整保留的轮数，默认 2
      --stdout              把 HANDOFF.md 打印到标准输出，不写文件
  -q, --quiet               不打印提示信息（适合放进 hook）
  -h, --help                显示帮助
`;

function parseArgs(argv) {
  const a = { project: null, session: null, out: null, maxChars: 30000, detailTurns: 2, list: false, stdout: false, quiet: false, cmd: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${x} 需要一个参数`);
      return argv[++i];
    };
    if (x === '-h' || x === '--help') a.cmd = 'help';
    else if (x === '--list' || x === '-l') a.list = true;
    else if (x === '-s' || x === '--session') a.session = next();
    else if (x === '-o' || x === '--out') a.out = next();
    else if (x === '--max-chars') a.maxChars = parseInt(next(), 10) || 30000;
    else if (x === '--detail-turns') a.detailTurns = Math.max(1, parseInt(next(), 10) || 2);
    else if (x === '--stdout') a.stdout = true;
    else if (x === '-q' || x === '--quiet') a.quiet = true;
    else if (x === 'install-skill' && !a.cmd && !a.project) a.cmd = 'install-skill';
    else if (x.startsWith('-')) throw new Error(`未知选项 ${x}，用 --help 查看用法`);
    else a.project = x;
  }
  return a;
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trimEnd() : null;
}

function gitSnapshot(cwd) {
  if (!cwd || !fs.existsSync(cwd) || git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const cap = (s, n) => {
    const lines = (s || '').split('\n').filter(Boolean);
    return lines.length > n ? [...lines.slice(0, n), `…另有 ${lines.length - n} 行`].join('\n') : lines.join('\n');
  };
  const parts = [];
  parts.push(`$ git branch --show-current\n${git(cwd, ['branch', '--show-current']) || '(detached)'}`);
  parts.push(`$ git status --short\n${cap(git(cwd, ['status', '--short']), 60) || '(工作区干净)'}`);
  const stat = git(cwd, ['diff', '--stat', 'HEAD']);
  if (stat) parts.push(`$ git diff --stat HEAD\n${cap(stat, 40)}`);
  const log = git(cwd, ['log', '--oneline', '-8']);
  if (log) parts.push(`$ git log --oneline -8\n${log}`);
  return parts.join('\n\n');
}

// 会话可能跨多个仓库改文件（比如 cwd 是 A，实际改的是 B），把这些仓库的状态都带上
function gitAll(target, files) {
  const top = (dir) => (fs.existsSync(dir) ? git(dir, ['rev-parse', '--show-toplevel']) : null);
  const norm = (p) => path.resolve(p).toLowerCase();
  const mainRoot = top(target);
  const roots = new Map();
  const seenDirs = new Set();
  for (const f of files) {
    const dir = path.dirname(path.resolve(target, f));
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const r = top(dir);
    if (r && (!mainRoot || norm(r) !== norm(mainRoot))) roots.set(norm(r), r);
  }
  const parts = [];
  const main = gitSnapshot(target);
  if (main) parts.push(`# 仓库 ${mainRoot}（项目目录）\n${main}`);
  for (const r of [...roots.values()].slice(0, 3)) parts.push(`# 仓库 ${r}（会话里也改过这里的文件）\n${gitSnapshot(r)}`);
  return parts.length ? parts.join('\n\n') : null;
}

// 读会话文件末尾，找标题和最后一条用户输入，用于 --list
function peekTail(file) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const grab = (re) => {
      let m, last = null;
      while ((m = re.exec(text))) last = m[1];
      if (!last) return null;
      try { return JSON.parse('"' + last + '"'); } catch { return last; }
    };
    return { title: grab(/"customTitle":"((?:[^"\\]|\\.)*)"/g), lastPrompt: grab(/"lastPrompt":"((?:[^"\\]|\\.)*)"/g) };
  } catch {
    return {};
  }
}

function listCmd(projectDir) {
  const sessions = findSessions(projectDir);
  if (!sessions.length) {
    console.log(`没有找到 ${projectDir} 的会话（查找位置：${projectsRoot()}）`);
    return;
  }
  console.log(`${path.resolve(projectDir)} 的 Claude Code 会话（最近的在前）：\n`);
  for (const s of sessions) {
    const t = peekTail(s.file);
    const label = t.title || (t.lastPrompt ? t.lastPrompt.replace(/\s+/g, ' ').slice(0, 50) : '');
    console.log(`  ${s.id.slice(0, 8)}  ${fmtTs(new Date(s.mtime).toISOString())}  ${(s.size / 1048576).toFixed(1).padStart(5)}MB  ${label}`);
  }
  console.log('\n用 cc2codex --session <id 前缀> 选择其中一个。');
}

function installSkill() {
  const src = path.join(__dirname, '..', 'skill', 'resume-from-claude', 'SKILL.md');
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const destDir = path.join(codexHome, 'skills', 'resume-from-claude');
  const cli = `node "${path.resolve(__dirname, 'cc2codex.js')}"`;
  const body = fs.readFileSync(src, 'utf8').replace(/\{\{CC2CODEX\}\}/g, cli);
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'SKILL.md'), body);
  console.log(`已安装 Codex skill：${path.join(destDir, 'SKILL.md')}`);
  console.log(`skill 里调用 CLI 的命令是：${cli}`);
  console.log('如果之后移动了 cc2codex 的目录，重新运行一次 install-skill 即可。');
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.cmd === 'help') return void process.stdout.write(HELP);
  if (a.cmd === 'install-skill') return installSkill();
  const projectDir = path.resolve(a.project || process.cwd());
  if (a.list) return listCmd(projectDir);

  const started = Date.now();
  const s = resolveSession({ projectDir, session: a.session });
  const data = await parseSession(s.file);

  // 直接给了会话文件而没给项目目录时，用会话记录里的 cwd
  let target = projectDir;
  if (!a.project && a.session && /[\\/]|\.jsonl$/.test(a.session) && data.meta.cwd && fs.existsSync(data.meta.cwd)) target = data.meta.cwd;
  if (!data.meta.cwd) data.meta.cwd = target;

  const gitText = gitAll(target, [...data.files.keys()]);
  const handoff = renderHandoff(data, gitText, { maxChars: a.maxChars, detailTurns: a.detailTurns });
  if (a.stdout) return void process.stdout.write(handoff);

  const outDir = path.resolve(a.out || path.join(target, '.handoff'));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'HANDOFF.md'), handoff);
  fs.writeFileSync(path.join(outDir, 'transcript.md'), renderTranscript(data));
  // 让 .handoff 自己忽略自己，不污染用户的 git
  const gi = path.join(outDir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');

  if (a.quiet) return;
  const humanTurns = data.turns.filter((t) => t.user).length;
  const relOut = path.relative(process.cwd(), outDir) || '.';
  console.log(`✓ 已从会话 ${data.meta.title ? `「${data.meta.title}」` : s.id} 生成交接文档（${((Date.now() - started) / 1000).toFixed(1)}s）`);
  console.log(`  记录 ${(fs.statSync(s.file).size / 1048576).toFixed(1)}MB → HANDOFF.md ${(Buffer.byteLength(handoff) / 1024).toFixed(0)}KB，${humanTurns} 轮用户消息，${data.files.size} 个改动文件`);
  if (data.interruption) console.log(`  中断状态：${data.interruption}`);
  console.log(`  输出：${path.join(relOut, 'HANDOFF.md')}、${path.join(relOut, 'transcript.md')}`);
  console.log('\n在 Codex 里打开这个项目，发一句：');
  console.log('  请先完整阅读 .handoff/HANDOFF.md，这是我在 Claude Code 里做到一半的工作。核对代码现状后，复述目标、进度和你准备的下一步，等我确认再动手。');
  console.log('（装了 resume-from-claude skill 的话，直接说「接着 Claude 的活继续」也行）');
}

main().catch((e) => {
  console.error('cc2codex 出错：' + (e && e.message ? e.message : e));
  process.exit(1);
});

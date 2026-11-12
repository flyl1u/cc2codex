'use strict';
// 两个方向共用的命令行逻辑：cc2codex（Claude Code → Codex）与 codex2cc（Codex → Claude Code）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { findSessions, resolveSession, projectsRoot, claudeHome } = require('./locate');
const { parseSession } = require('./parse');
const { codexHome, findCodexSessions, resolveCodexSession, parseCodexSession } = require('./codex');
const { renderHandoff, renderTranscript, fmtTs } = require('./render');
const { scanSessions } = require('./status');
const { redact } = require('./redact');

const DIRECTIONS = {
  claude: {
    cmd: 'cc2codex',
    src: 'Claude Code',
    dst: 'Codex',
    resumePrompt: '请先完整阅读 .handoff/HANDOFF.md，这是我在 Claude Code 里做到一半的工作。核对代码现状后，复述目标、进度和你准备的下一步，等我确认再动手。',
    skillHint: '（装了 resume-from-claude skill 的话，在 Codex 里直接说「接着 Claude 的活继续」也行）',
  },
  codex: {
    cmd: 'codex2cc',
    src: 'Codex',
    dst: 'Claude Code',
    resumePrompt: '请先完整阅读 .handoff/HANDOFF.md，这是我在 Codex 里做到一半的工作。核对代码现状后，复述目标、进度和你准备的下一步，等我确认再动手。',
    skillHint: '（装了 resume-from-codex skill 的话，在 Claude Code 里直接说「接着 Codex 的活继续」或输入 /resume-from-codex 也行）',
  },
};

function help(d) {
  return `${d.cmd} —— 把 ${d.src} 会话接力给 ${d.dst}

用法：
  ${d.cmd} [项目目录]            为该项目最近的 ${d.src} 会话生成 .handoff/HANDOFF.md
  ${d.cmd} --list [项目目录]     列出该项目的所有 ${d.src} 会话
  ${d.cmd} --interrupted [-a]    列出中断的 ${d.src} 会话（-a 跨所有项目），并给出逐个接手的方法
  ${d.cmd} install-skill          安装两个方向的 skill（Codex 的 resume-from-claude、Claude Code 的 resume-from-codex）

选项：
  -s, --session <id|文件>   指定会话（id 前缀或 .jsonl 路径），默认取最近修改的；本项目找不到时会跨项目找
  -o, --out <目录>          输出目录，默认 <项目目录>/.handoff/${d.cmd === 'cc2codex' ? 'claude' : 'codex'}-<会话 id 前 8 位>
  -a, --all-projects        配合 --interrupted / --list，扫描所有项目
      --since <小时>        配合 --interrupted，只看最近多少小时内活动过的会话，默认 24
      --json                配合 --interrupted / --list，输出 JSON（给 skill 用）
      --max-chars <n>       HANDOFF.md 的长度预算，默认 30000 字符
      --detail-turns <n>    末尾完整保留的轮数，默认 2
      --stdout              把 HANDOFF.md 打印到标准输出，不写文件
      --no-redact           不脱敏（默认会把疑似密钥、令牌、密码替换成 [已脱敏]）
  -q, --quiet               不打印提示信息（适合放进 hook）
  -h, --help                显示帮助

另一个方向用 ${d.cmd === 'cc2codex' ? 'codex2cc' : 'cc2codex'}。
`;
}

function parseArgs(argv) {
  const a = { project: null, session: null, out: null, maxChars: 30000, detailTurns: 2, list: false, stdout: false, quiet: false, cmd: null, interrupted: false, allProjects: false, sinceHours: 24, json: false, redact: true };
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
    else if (x === '--interrupted' || x === '-i') a.interrupted = true;
    else if (x === '-a' || x === '--all-projects') a.allProjects = true;
    else if (x === '--since') a.sinceHours = Math.max(1, parseFloat(next()) || 24);
    else if (x === '--json') a.json = true;
    else if (x === '--no-redact') a.redact = false;
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

// 读 Claude 会话文件末尾，找标题和最后一条用户输入，用于 --list
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

function listCmd(dirKey, projectDir) {
  const d = DIRECTIONS[dirKey];
  const sessions = dirKey === 'codex' ? findCodexSessions(projectDir) : findSessions(projectDir);
  if (!sessions.length) {
    const where = dirKey === 'codex' ? path.join(codexHome(), 'sessions') : projectsRoot();
    console.log(`没有找到 ${projectDir} 的 ${d.src} 会话（查找位置：${where}）`);
    return;
  }
  console.log(`${path.resolve(projectDir)} 的 ${d.src} 会话（最近的在前）：\n`);
  for (const s of sessions) {
    let label = s.title || '';
    if (!label && dirKey === 'claude') {
      const t = peekTail(s.file);
      label = t.title || (t.lastPrompt ? t.lastPrompt.replace(/\s+/g, ' ').slice(0, 50) : '');
    }
    console.log(`  ${s.id.slice(0, 8)}  ${fmtTs(new Date(s.mtime).toISOString())}  ${(s.size / 1048576).toFixed(1).padStart(5)}MB  ${label}`);
  }
  console.log(`\n用 ${d.cmd} --session <id 前缀> 选择其中一个。`);
}

// 列出中断的会话，并按接手方的能力给出办法：
// Claude Code 能自己开新会话，skill 会逐个开；Codex 不能，所以给用户逐条可粘贴的话
function interruptedCmd(dirKey, a, projectDir) {
  const d = DIRECTIONS[dirKey];
  const all = scanSessions(dirKey, { projectDir, allProjects: a.allProjects, sinceHours: a.sinceHours });
  const hits = all.filter((s) => s.status === 'interrupted');
  const running = all.filter((s) => s.status === 'running');
  if (a.json) {
    const pick = (s) => ({ id: s.id, shortId: s.id.slice(0, 8), project: s.project, title: s.title, lastActive: new Date(s.mtime).toISOString(), status: s.status, reason: s.reason, file: s.file });
    return void process.stdout.write(JSON.stringify({ source: d.src, interrupted: hits.map(pick), running: running.map(pick) }, null, 2) + '\n');
  }
  const scope = a.allProjects ? '所有项目' : path.resolve(projectDir);
  if (!hits.length) {
    console.log(`最近 ${a.sinceHours} 小时内，${scope} 没有中断的 ${d.src} 会话。`);
    if (running.length) console.log(`另有 ${running.length} 个会话可能仍在运行：${running.map((s) => s.id.slice(0, 8)).join('、')}`);
    return;
  }
  console.log(`最近 ${a.sinceHours} 小时内，${scope} 有 ${hits.length} 个中断的 ${d.src} 会话：\n`);
  hits.forEach((s, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${s.id.slice(0, 8)}  ${fmtTs(new Date(s.mtime).toISOString())}  ${s.title || '(无标题)'}`);
    console.log(`      项目：${s.project}`);
    console.log(`      原因：${s.reason}`);
  });
  if (running.length) console.log(`\n（另有 ${running.length} 个会话最近几分钟还在写入，可能仍在运行，未列入：${running.map((s) => s.id.slice(0, 8)).join('、')}）`);
  const other = dirKey === 'claude' ? 'Claude' : 'Codex';
  if (dirKey === 'claude') {
    console.log(`\nCodex 不能自己开新对话，请为每个会话在 Codex 里各开一个新对话（先打开对应的项目文件夹），分别发：\n`);
  } else {
    console.log(`\n在 Claude Code 里说「接着 Codex 的活继续」，装了 resume-from-codex skill 的桌面版会为每个会话各开一个新会话。`);
    console.log(`也可以手动在 Claude Code 里为每个会话各开一个会话（先打开对应的项目文件夹），分别发：\n`);
  }
  hits.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. [${s.project}] 接着 ${other} 的会话 ${s.id.slice(0, 8)} 继续`));
}

function installSkills() {
  const root = path.join(__dirname, '..');
  const targets = [
    { name: 'resume-from-claude', cmd: 'cc2codex.js', dir: path.join(codexHome(), 'skills'), app: 'Codex' },
    { name: 'resume-from-codex', cmd: 'codex2cc.js', dir: path.join(claudeHome(), 'skills'), app: 'Claude Code' },
  ];
  for (const t of targets) {
    const cli = `node "${path.join(root, 'bin', t.cmd)}"`;
    const body = fs.readFileSync(path.join(root, 'skill', t.name, 'SKILL.md'), 'utf8').replace(/\{\{CLI\}\}/g, cli);
    const dest = path.join(t.dir, t.name);
    const file = path.join(dest, 'SKILL.md');
    fs.mkdirSync(dest, { recursive: true });
    // 已有版本和要写入的不同（可能被用户手改过），先备份再覆盖
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== body) {
      fs.copyFileSync(file, file + '.bak');
      console.log(`  原有的 ${t.name} 与新版不同，已备份为 SKILL.md.bak`);
    }
    fs.writeFileSync(file, body);
    console.log(`已安装 ${t.app} skill：${file}`);
  }
  console.log('如果之后移动了 cc2codex 的目录，重新运行一次 install-skill 即可。');
}

async function run(dirKey, argv) {
  const d = DIRECTIONS[dirKey];
  const a = parseArgs(argv);
  if (a.cmd === 'help') return void process.stdout.write(help(d));
  if (a.cmd === 'install-skill') return installSkills();
  const projectDir = path.resolve(a.project || process.cwd());
  if (a.interrupted) return interruptedCmd(dirKey, a, projectDir);
  if (a.list && (a.json || a.allProjects)) {
    // --list 的扩展形式：复用扫描逻辑，列出全部会话（含状态）
    const all = scanSessions(dirKey, { projectDir, allProjects: a.allProjects, sinceHours: a.allProjects ? a.sinceHours : 24 * 365 });
    if (a.json) return void process.stdout.write(JSON.stringify(all.map(({ file, ...s }) => ({ ...s, file, lastActive: new Date(s.mtime).toISOString() })), null, 2) + '\n');
    for (const s of all) console.log(`  ${s.id.slice(0, 8)}  ${fmtTs(new Date(s.mtime).toISOString())}  ${s.status === 'interrupted' ? '中断' : s.status === 'running' ? '运行中' : '完成'}  ${s.project}  ${s.title || ''}`);
    return;
  }
  if (a.list) return listCmd(dirKey, projectDir);

  const started = Date.now();
  let s;
  let data;
  if (dirKey === 'codex') {
    s = resolveCodexSession({ projectDir, session: a.session });
    data = await parseCodexSession(s);
  } else {
    s = resolveSession({ projectDir, session: a.session });
    data = await parseSession(s.file);
  }

  // 指定了会话却没给项目目录时（会话文件路径、或跨项目找到的 id），以会话记录里的 cwd 为准
  let target = projectDir;
  if (!a.project && a.session && data.meta.cwd && fs.existsSync(data.meta.cwd)) target = path.resolve(data.meta.cwd);
  if (!data.meta.cwd) data.meta.cwd = target;
  const sid = String(data.meta.sessionId || s.id);

  let handoff = renderHandoff(data, gitAll(target, [...data.files.keys()]), { maxChars: a.maxChars, detailTurns: a.detailTurns });
  let transcript = renderTranscript(data);
  let redacted = 0;
  if (a.redact) {
    const h = redact(handoff);
    const t = redact(transcript);
    handoff = h.text;
    transcript = t.text;
    redacted = h.count + t.count;
  }
  if (a.stdout) return void process.stdout.write(handoff);

  // 每个会话一个子目录，多个会话同时接手时互不覆盖
  const handoffRoot = path.join(target, '.handoff');
  const outDir = path.resolve(a.out || path.join(handoffRoot, `${dirKey}-${sid.slice(0, 8)}`));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'HANDOFF.md'), handoff);
  fs.writeFileSync(path.join(outDir, 'transcript.md'), transcript);
  // 让 .handoff 自己忽略自己，不污染用户的 git
  const giDir = a.out ? outDir : handoffRoot;
  const gi = path.join(giDir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');

  // 本项目还有别的中断会话时提醒一下
  let others = [];
  try {
    others = scanSessions(dirKey, { projectDir: target, allProjects: false, sinceHours: 24 }).filter((x) => x.status === 'interrupted' && !sid.startsWith(x.id) && !x.id.startsWith(sid));
  } catch { /* 提醒失败不影响主流程 */ }

  const handoffPath = path.join(outDir, 'HANDOFF.md');
  if (a.quiet) return void console.log(handoffPath);
  const humanTurns = data.turns.filter((t) => t.user).length;
  const relOut = path.relative(process.cwd(), outDir) || '.';
  console.log(`✓ 已从 ${d.src} 会话 ${data.meta.title ? `「${data.meta.title}」` : s.id} 生成交接文档（${((Date.now() - started) / 1000).toFixed(1)}s）`);
  console.log(`  记录 ${(fs.statSync(s.file).size / 1048576).toFixed(1)}MB → HANDOFF.md ${(Buffer.byteLength(handoff) / 1024).toFixed(0)}KB，${humanTurns} 轮用户消息，${data.files.size} 个改动文件`);
  if (data.interruption) console.log(`  中断状态：${data.interruption}`);
  if (redacted) console.log(`  已把 ${redacted} 处疑似密钥/令牌/密码替换成 [已脱敏]（需要原文用 --no-redact）`);
  console.log(`  输出：${path.join(relOut, 'HANDOFF.md')}、${path.join(relOut, 'transcript.md')}`);
  console.log(`  交接文档：${handoffPath}`);
  console.log(`\n在 ${d.dst} 里打开这个项目，发一句：`);
  console.log(`  ${d.resumePrompt.replace('.handoff/HANDOFF.md', path.relative(target, handoffPath).replace(/\\/g, '/'))}`);
  console.log(d.skillHint);
  if (others.length) {
    console.log(`\n⚠ 这个项目最近 24 小时还有 ${others.length} 个中断的 ${d.src} 会话：${others.map((x) => `${x.id.slice(0, 8)}${x.title ? `「${x.title}」` : ''}`).join('、')}`);
    console.log(`  用 ${d.cmd} --interrupted -a 查看全部，并逐个接手。`);
  }
}

function main(dirKey) {
  run(dirKey, process.argv.slice(2)).catch((e) => {
    console.error(`${DIRECTIONS[dirKey].cmd} 出错：` + (e && e.message ? e.message : e));
    process.exit(1);
  });
}

module.exports = { main, run };

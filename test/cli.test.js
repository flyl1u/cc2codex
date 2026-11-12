'use strict';
// 端到端：真正运行两个命令，检查输出目录、多会话扫描和脱敏
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeEnv, makeClaudeSession, makeCodexThread, setOld, FAKE_KEY } = require('./fixtures');

const env = makeEnv();
test.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
const claude = makeClaudeSession(env);
const codex = makeCodexThread(env);
for (const f of [claude.file, ...codex.files]) setOld(f);

function run(cmd, args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', cmd), ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: env.claudeHome, CODEX_HOME: env.codexHome },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('cc2codex：每个会话一个目录，默认脱敏', () => {
  const out = run('cc2codex.js', [env.project, '-q']).trim();
  assert.equal(out, path.join(env.project, '.handoff', `claude-${claude.id.slice(0, 8)}`, 'HANDOFF.md'));
  const doc = fs.readFileSync(out, 'utf8');
  assert.match(doc, /请实现登录功能/);
  assert.ok(!doc.includes(FAKE_KEY), '密钥应被脱敏');
  assert.ok(fs.existsSync(path.join(path.dirname(out), 'transcript.md')));
  assert.equal(fs.readFileSync(path.join(env.project, '.handoff', '.gitignore'), 'utf8'), '*\n');
});

test('cc2codex --no-redact 保留原文', () => {
  const doc = run('cc2codex.js', [env.project, '--no-redact', '--stdout']);
  assert.ok(doc.includes(FAKE_KEY));
});

test('codex2cc：写到 codex- 目录，两个方向互不覆盖', () => {
  const out = run('codex2cc.js', [env.project, '-q']).trim();
  assert.equal(path.basename(path.dirname(out)), `codex-${codex.id.slice(0, 8)}`);
  assert.match(fs.readFileSync(out, 'utf8'), /^# Codex → Claude Code 交接文档/);
  assert.ok(fs.existsSync(path.join(env.project, '.handoff', `claude-${claude.id.slice(0, 8)}`, 'HANDOFF.md')));
});

test('--interrupted --json 跨项目列出中断会话', () => {
  const c = JSON.parse(run('cc2codex.js', ['--interrupted', '-a', '--json']));
  assert.deepEqual(c.interrupted.map((s) => s.id), [claude.id]);
  assert.equal(path.resolve(c.interrupted[0].project), path.resolve(env.project));
  const x = JSON.parse(run('codex2cc.js', ['--interrupted', '-a', '--json']));
  assert.deepEqual(x.interrupted.map((s) => s.id), [codex.id]);
});

test('-s 跨项目查找：在别的目录也能按 id 前缀找到会话', () => {
  const out = run('codex2cc.js', ['-s', codex.id.slice(0, 8), '-q']).trim();
  assert.ok(out.startsWith(path.join(env.project, '.handoff')));
});

test('最近几分钟还在写入的会话视为运行中', () => {
  fs.utimesSync(claude.file, new Date(), new Date());
  const c = JSON.parse(run('cc2codex.js', ['--interrupted', '-a', '--json']));
  assert.equal(c.interrupted.length, 0);
  assert.deepEqual(c.running.map((s) => s.id), [claude.id]);
  setOld(claude.file);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { makeEnv, makeClaudeSession, makeCodexThread } = require('./fixtures');

const env = makeEnv();
test.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
process.env.CLAUDE_CONFIG_DIR = env.claudeHome;
process.env.CODEX_HOME = env.codexHome;
const claude = makeClaudeSession(env);
const codex = makeCodexThread(env);

const { parseSession } = require('../src/parse');
const { resolveCodexSession, parseCodexSession, findCodexSessions } = require('../src/codex');
const { renderHandoff } = require('../src/render');
const { claudeStatus, codexStatus } = require('../src/status');

test('Claude：只保留当前主线，跨过压缩边界', async () => {
  const d = await parseSession(claude.file);
  const asks = d.turns.filter((t) => t.user).map((t) => t.user);
  assert.equal(asks.length, 3);
  assert.match(asks[0], /请实现登录功能/);
  assert.equal(asks[1], '换一种方式实现');
  assert.equal(asks[2], '继续写测试');
  const all = JSON.stringify(d.turns);
  assert.ok(!all.includes('这条被回退了'), '回退分支不应出现');
  assert.ok(!all.includes('子代理的输出'), '子代理侧链不应出现');
  assert.ok(!all.includes('工作目录变了'), 'system-reminder 注入不应算作用户消息');
  assert.match(d.compact.text, /改用 session/);
  assert.equal(d.meta.title, '实现登录');
});

test('Claude：任务列表、改动文件、中断状态', async () => {
  const d = await parseSession(claude.file);
  assert.deepEqual(d.tasks.map((t) => t.status), ['in_progress', 'pending']);
  assert.deepEqual([...d.files.keys()], [claude.loginFile]);
  assert.match(d.interruption, /错误结束.*limit/);
  assert.equal(d.errors.length, 1);
});

test('Codex：沿 history_base 拼接分页，丢掉被编辑掉的消息和注入内容', async () => {
  const head = resolveCodexSession({ projectDir: env.project });
  assert.equal(head.id, codex.id);
  assert.equal(head.title, '暗色模式');
  const d = await parseCodexSession(head);
  const asks = d.turns.filter((t) => t.user).map((t) => t.user);
  assert.deepEqual(asks, ['加一个暗色模式', '改成深蓝配色', '（回答 Codex 的提问「要不要保留浅色模式？」）保留']);
  assert.ok(!JSON.stringify(d.turns).includes('AGENTS.md'));
});

test('Codex：结构化记录里的改动文件、计划、未完成的调用', async () => {
  const d = await parseCodexSession(resolveCodexSession({ projectDir: env.project }));
  assert.deepEqual([...d.files.entries()].map(([f, v]) => [f, v.count]), [[codex.theme, 2]]);
  assert.match(d.planText, /深蓝为主色/);
  assert.match(d.interruption, /Bash/);
  const lastTool = d.turns.at(-1).items.filter((x) => x.type === 'tool').at(-1);
  assert.equal(lastTool.input.command, 'npm run build');
  assert.equal(lastTool.result, null);
});

test('Codex：子代理线程不出现在会话列表里', () => {
  assert.deepEqual(findCodexSessions(env.project).map((s) => s.id), [codex.id]);
});

test('状态检测：两个会话都判为中断', () => {
  assert.equal(claudeStatus(claude.file).status, 'interrupted');
  const s = codexStatus(codex.files[1]);
  assert.equal(s.status, 'interrupted');
});

test('渲染：遵守长度预算，标题写明方向', async () => {
  const d = await parseCodexSession(resolveCodexSession({ projectDir: env.project }));
  const doc = renderHandoff(d, null, { maxChars: 30000 });
  assert.ok(doc.startsWith('# Codex → Claude Code 交接文档'));
  assert.ok(doc.length <= 30000);
  const big = await parseSession(claude.file);
  big.turns[0].user = '很长的需求。'.repeat(20000);
  const small = renderHandoff(big, null, { maxChars: 8000 });
  assert.ok(small.length <= 8000, `长度 ${small.length}`);
  assert.ok(small.startsWith('# Claude Code → Codex 交接文档'));
});

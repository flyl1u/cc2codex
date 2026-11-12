'use strict';
// 在临时目录里造出 Claude Code 和 Codex 的会话记录，结构取自真实记录，内容是虚构的
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodeProjectPath } = require('../src/locate');

const FAKE_KEY = 'sk-ant-api03-' + 'x'.repeat(40);

function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function setOld(file, hoursAgo = 2) {
  const t = new Date(Date.now() - hoursAgo * 3600 * 1000);
  fs.utimesSync(file, t, t);
}

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc2codex-test-'));
  const project = path.join(root, 'my-app');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  const claudeHome = path.join(root, 'claude-home');
  const codexHome = path.join(root, 'codex-home');
  return { root, project, claudeHome, codexHome };
}

// Claude Code 会话：含回退分支、子代理侧链、压缩边界（logicalParent 指向不存在的记录）、
// 注入的 system-reminder、TodoWrite、失败的工具调用，最后以额度错误结束
function makeClaudeSession(env, id = 'aaaaaaaa-1111-2222-3333-444444444444') {
  const { project } = env;
  const base = { cwd: project, sessionId: id, version: '2.1.0', gitBranch: 'main', isSidechain: false };
  let n = 0;
  const ts = () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString();
  const user = (uuid, parent, content, extra = {}) => ({ ...base, type: 'user', uuid, parentUuid: parent, timestamp: ts(), message: { role: 'user', content }, ...extra });
  const asst = (uuid, parent, content, extra = {}) => ({ ...base, type: 'assistant', uuid, parentUuid: parent, timestamp: ts(), message: { role: 'assistant', content }, ...extra });
  const loginFile = path.join(project, 'src', 'login.js');

  const records = [
    { type: 'custom-title', customTitle: '实现登录', sessionId: id },
    user('u1', null, `请实现登录功能，测试用的 key 是 ${FAKE_KEY}`, { origin: { kind: 'human' } }),
    asst('a1', 'u1', [{ type: 'text', text: '好的，先列计划。' }]),
    asst('a2', 'a1', [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: '写登录接口', status: 'in_progress' }, { content: '写测试', status: 'pending' }] } }]),
    user('r1', 'a2', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
    asst('a3', 'r1', [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: loginFile, old_string: 'a', new_string: 'b' } }]),
    user('r2', 'a3', [{ type: 'tool_result', tool_use_id: 't2', content: 'edited' }]),
    // 被回退掉的分支
    user('x1', 'r2', '这条被回退了', { origin: { kind: 'human' } }),
    asst('x2', 'x1', [{ type: 'text', text: '回退分支里的回复' }]),
    // 子代理侧链
    asst('s1', 'r2', [{ type: 'text', text: '子代理的输出' }], { isSidechain: true }),
    // 回退后重新提问
    user('u2', 'r2', '换一种方式实现', { origin: { kind: 'human' } }),
    asst('a4', 'u2', [{ type: 'text', text: '已经换成 session 方式。' }]),
    { ...base, type: 'system', subtype: 'compact_boundary', uuid: 'cb', parentUuid: null, logicalParentUuid: 'missing-uuid', timestamp: ts() },
    user('cs', 'cb', '摘要：已实现登录接口，改用 session。', { isCompactSummary: true }),
    user('inj', 'cs', [{ type: 'text', text: '<system-reminder>\n工作目录变了\n</system-reminder>' }], { origin: { kind: 'human' } }),
    user('u3', 'inj', '继续写测试', { origin: { kind: 'human' } }),
    asst('a5', 'u3', [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test', description: '跑测试' } }]),
    user('r3', 'a5', [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: '1 failing' }]),
    asst('a6', 'r3', [{ type: 'text', text: "You've hit your 5-hour limit" }], { isApiErrorMessage: true }),
  ];
  const file = path.join(env.claudeHome, 'projects', encodeProjectPath(project), `${id}.jsonl`);
  writeJsonl(file, records);
  return { id, file, loginFile };
}

// Codex 线程：第一页文件 + 编辑消息后从 ordinal 10 接续的第二页文件，外加一个子代理线程
function makeCodexThread(env, id = '01aaaaaa-0000-7000-8000-000000000001') {
  const { project } = env;
  const theme = path.join(project, 'src', 'theme.css');
  let n = 0;
  const ts = () => new Date(Date.UTC(2026, 0, 2, 0, 0, n++)).toISOString();
  const rec = (ordinal, type, payload) => ({ timestamp: ts(), ordinal, type, payload });
  const userMsg = (ordinal, ...texts) => rec(ordinal, 'response_item', { type: 'message', role: 'user', content: texts.map((t) => ({ type: 'input_text', text: t })) });
  const ev = (ordinal, payload) => rec(ordinal, 'event_msg', payload);
  const dir = path.join(env.codexHome, 'sessions', '2026', '01', '02');

  const page1 = [
    rec(0, 'session_meta', { id, cwd: project, cli_version: '0.1.0', thread_source: 'user', base_instructions: 'x'.repeat(100000) }),
    ev(1, { type: 'task_started' }),
    userMsg(2, `# AGENTS.md instructions for ${project}\n\n<INSTRUCTIONS>规则</INSTRUCTIONS>`, '<environment_context>\n  <cwd>x</cwd>\n</environment_context>'),
    userMsg(3, '加一个暗色模式'),
    rec(4, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的，开始改。' }] }),
    rec(5, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'await tools.exec_command({cmd:"ls src"})' }),
    ev(6, { type: 'item_completed', item: { type: 'CommandExecution', parsed_cmd: [{ cmd: 'ls src' }], status: 'completed', aggregated_output: 'theme.css' } }),
    rec(7, 'response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Script completed' }] }),
    ev(8, { type: 'item_completed', item: { type: 'FileChange', status: 'completed', changes: { [theme]: { type: 'add', content: 'body{}' } } } }),
    ev(9, { type: 'task_complete' }),
    ev(10, { type: 'task_started' }),
    userMsg(11, '旧的第二条，后来被用户编辑掉了'),
  ];
  const page2 = [
    rec(10, 'session_meta', { id, cwd: project, cli_version: '0.1.0', thread_source: 'user', history_base: { thread_id: id, end_ordinal_exclusive: 10 } }),
    ev(11, { type: 'task_started' }),
    userMsg(12, '改成深蓝配色'),
    rec(13, 'response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'q1', arguments: JSON.stringify({ questions: [{ title: '要不要保留浅色模式？' }] }) }),
    rec(14, 'response_item', { type: 'function_call_output', call_id: 'q1', output: '{"accepted":true}' }),
    userMsg(15, '<send_user_message_question_reply>\n[{"question":"要不要保留浅色模式？","answer":"保留"}]\n</send_user_message_question_reply>'),
    ev(16, { type: 'item_completed', item: { type: 'Plan', text: '# 配色计划\n- 深蓝为主色' } }),
    ev(17, { type: 'item_completed', item: { type: 'FileChange', status: 'completed', changes: { [theme]: { type: 'update' } } } }),
    rec(18, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'await tools.exec_command({cmd:"npm run build"})' }),
  ];
  const sub = [
    rec(0, 'session_meta', { id: '01bbbbbb-0000-7000-8000-000000000002', cwd: project, thread_source: 'subagent', source: { subagent: {} } }),
    userMsg(1, '子代理任务'),
  ];
  const f1 = path.join(dir, `rollout-2026-01-02T00-00-00-${id}.jsonl`);
  const f2 = path.join(dir, `rollout-2026-01-02T01-00-00-${id}_01cccccc-0000-7000-8000-000000000003.jsonl`);
  const f3 = path.join(dir, 'rollout-2026-01-02T02-00-00-01bbbbbb-0000-7000-8000-000000000002.jsonl');
  writeJsonl(f1, page1);
  writeJsonl(f2, page2);
  writeJsonl(f3, sub);
  fs.writeFileSync(path.join(env.codexHome, 'session_index.jsonl'), JSON.stringify({ id, thread_name: '暗色模式' }) + '\n');
  return { id, files: [f1, f2, f3], theme };
}

module.exports = { makeEnv, makeClaudeSession, makeCodexThread, setOld, FAKE_KEY };

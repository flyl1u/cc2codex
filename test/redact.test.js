'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { redact } = require('../src/redact');

test('常见密钥和令牌被替换', () => {
  const cases = [
    'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
    'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123',
    '"password": "hunter2hunter2"',
    'git clone https://user:s3cretpass@github.com/x/y',
    'AWS key AKIAABCDEFGHIJKLMNOP here',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
  ];
  for (const c of cases) {
    const r = redact(c);
    assert.ok(r.count >= 1, `应脱敏：${c}`);
    assert.match(r.text, /\[已脱敏\]/);
  }
});

test('普通文字和代码表达式不被误伤', () => {
  const cases = [
    'max_tokens: 4096',
    'const apiKey = process.env.API_KEY',
    'the auth flow uses OAuth',
    'tokenizer=cl100k_base_v2',
    '$env:SIGNING_KEY = (Get-Content key.txt -Raw)',
    'password = ${PASSWORD}',
  ];
  for (const c of cases) assert.equal(redact(c).count, 0, `不应脱敏：${c}`);
});

test('同一个密钥只计一次', () => {
  assert.equal(redact('API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123').count, 1);
});

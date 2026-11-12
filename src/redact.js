'use strict';
// 交接文档会带上用户消息和命令输出，其中可能有密钥、令牌、密码。默认把常见形态替换掉。
const MASK = '[已脱敏]';

const PATTERNS = [
  // 私钥整块
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => `-----BEGIN PRIVATE KEY-----${MASK}-----END PRIVATE KEY-----`],
  // 各家 API Key / 令牌的固定前缀
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, () => `sk-${MASK}`],
  [/\b(gh[pousr]_)[A-Za-z0-9]{30,}/g, (m, p) => p + MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, () => `github_pat_${MASK}`],
  [/\bAKIA[0-9A-Z]{16}\b/g, () => `AKIA${MASK}`],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, () => `AIza${MASK}`],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, () => `xox-${MASK}`],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, () => `npm_${MASK}`],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, () => MASK],
  // Authorization: Bearer xxx
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g, (m, p) => p + MASK],
  // URL 里的 user:password@
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]{3,}@/gi, (m, p) => `${p}${MASK}@`],
  // key=value / "key": "value" 形式，key 名里带 secret、token、password 等
  [
    /((?:api[_-]?key|apikey|secret|token|passwd|password|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth)["']?\s*[:=]\s*["']?)([^\s"'`,;&)<>]{8,})/gi,
    (m, k, v) => (v.includes(MASK) || /^([([{@]|\$\{|\$[A-Z_]|<|process\.env|os\.environ|env\(|true|false|null|undefined)/i.test(v) ? m : k + MASK),
  ],
];

function redact(text) {
  let count = 0;
  let out = String(text || '');
  for (const [re, fn] of PATTERNS) {
    out = out.replace(re, (...args) => {
      const r = fn(...args);
      if (r !== args[0]) count += 1;
      return r;
    });
  }
  return { text: out, count };
}

module.exports = { redact, MASK };

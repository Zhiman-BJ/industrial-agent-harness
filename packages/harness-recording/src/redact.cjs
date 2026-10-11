'use strict';

// Text redaction for demo-copy export (#104). Two deterministic layers:
// 1. Key-based: any value under a secret-sounding key becomes [REDACTED].
// 2. Pattern-based: home paths with usernames, credential-carrying URLs,
//    bearer tokens, common API-key literals, private endpoints, and
//    caller-selected literals.
// Binary assets are NEVER rewritten here — they go through the human review
// workflow in demo-export.cjs. This module makes no claim to recognize all
// sensitive content (#104: "不宣称自动识别所有敏感内容").

const RULES_VERSION = 1;

const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|api_?key|access_?key|authorization|credential|cookie)/i;

const REDACTED = '[REDACTED]';

function compileRules({ literals = [] } = {}) {
  const literalPatterns = literals
    .filter(literal => typeof literal === 'string' && literal.length > 0)
    .map(literal => ({
      pattern: new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      replacement: REDACTED,
    }));
  return [
    // https://user:pass@host → https://[REDACTED]@host (before the IP rule so
    // the credential part is consumed first).
    { pattern: /(https?:\/\/)[^\s:@/"']+:[^\s@/"']+@/g, replacement: '$1[REDACTED]@' },
    // Home paths leak the username; keep the rest of the path readable.
    { pattern: /(?:[A-Za-z]:\\+Users\\+|\/Users\/|\/home\/)[^/\s"'\\]+/g, replacement: '~' },
    { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: 'Bearer [REDACTED]' },
    { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: '[REDACTED_API_KEY]' },
    {
      pattern:
        /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.0\.0\.1)\b/g,
      replacement: '[REDACTED_ENDPOINT]',
    },
    ...literalPatterns,
  ];
}

// Apply the pattern layer to one free-text string.
function redactString(value, rules) {
  let result = value;
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

// Deep-walk a parsed event: secret-sounding keys lose their values outright;
// every other string value goes through the pattern layer. Tool arguments
// arrive as JSON-encoded strings (AgentEvent contract), so a string that
// parses as JSON/object-array is redacted recursively and re-serialized only
// when something actually changed. Non-strings pass through untouched, so
// seq/relMs and structural numbers are preserved.
function redactValue(value, rules) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object') {
          const redacted = redactValue(parsed, rules);
          const serialized = JSON.stringify(redacted);
          return serialized === value ? value : serialized;
        }
      } catch {
        // Not JSON despite the braces — treat as plain text below.
      }
    }
    return redactString(value, rules);
  }
  if (Array.isArray(value)) return value.map(item => redactValue(item, rules));
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, inner] of Object.entries(value)) {
      copy[key] =
        typeof inner === 'string' && SECRET_KEY_PATTERN.test(key) && inner.length > 0
          ? REDACTED
          : redactValue(inner, rules);
    }
    return copy;
  }
  return value;
}

function redactEvent(event, rules) {
  return redactValue(event, rules);
}

// Report which rules fired on a text, for review tooling. Never used to gate
// exports — the demo bundle still requires human review either way.
function auditText(value, rules) {
  const hits = [];
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(value)) hits.push(rule.pattern.source.slice(0, 40));
  }
  return hits;
}

module.exports = { RULES_VERSION, compileRules, redactEvent, redactString, auditText, REDACTED };

const { StringDecoder } = require('node:string_decoder');

function environmentSecrets(environment) {
  return [
    ...new Set(
      Object.entries(environment)
        .filter(
          ([key, value]) =>
            /(?:api.?key|(?:^|_)token$|secret|password|authorization)/i.test(key) &&
            typeof value === 'string' &&
            value.length > 3,
        )
        .map(([, value]) => value),
    ),
  ];
}

// Retain enough raw suffix to detect a secret crossing any byte/chunk boundary.
// Only the redacted output is persisted. Provider usage parsing may use raw input.
class StreamRedactor {
  constructor(secrets) {
    const ordered = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
    this.maxLength = Math.max(1, ...ordered.map(secret => secret.length));
    this.pattern = ordered.length
      ? new RegExp(
          ordered.map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
          'g',
        )
      : null;
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
  }
  write(chunk) {
    this.pending += this.decoder.write(chunk);
    return this.consume(false);
  }
  end() {
    this.pending += this.decoder.end();
    return this.consume(true);
  }
  consume(final) {
    let cutoff = final
      ? this.pending.length
      : Math.max(0, this.pending.length - this.maxLength + 1);
    if (!final && cutoff > 0 && /[\uD800-\uDBFF]/.test(this.pending[cutoff - 1])) cutoff--;
    if (!cutoff) return '';
    let output = '',
      consumed = 0;
    if (this.pattern) {
      this.pattern.lastIndex = 0;
      let match;
      while ((match = this.pattern.exec(this.pending)) && match.index < cutoff) {
        output += this.pending.slice(consumed, match.index) + '[REDACTED]';
        consumed = match.index + match[0].length;
      }
    }
    if (consumed < cutoff) {
      output += this.pending.slice(consumed, cutoff);
      consumed = cutoff;
    }
    this.pending = this.pending.slice(consumed);
    return output;
  }
}
module.exports = { StreamRedactor, environmentSecrets };

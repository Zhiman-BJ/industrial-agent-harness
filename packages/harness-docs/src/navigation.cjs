'use strict';

// Docs navigation reducer (#103): path and anchor jumps with a back stack.
// Pure and headless so the panel wiring (#102) stays a thin adapter; the
// stack depth is capped so pathological navigation cannot grow unbounded.

const { LIMITS } = require('./limits.cjs');

class DocsError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
  }
}

function createDocsNavigation({ start } = {}) {
  let stack = [];
  if (start) stack.push({ id: start.id, anchor: start.anchor ?? null });

  return {
    open(id, anchor = null) {
      if (typeof id !== 'string' || id.length === 0)
        throw new DocsError('docs:nav', 'open requires a doc id');
      const top = stack[stack.length - 1];
      if (top && top.id === id && (top.anchor ?? null) === (anchor ?? null)) return this.current();
      if (stack.length >= LIMITS.maxStackDepth) stack = stack.slice(-LIMITS.maxStackDepth + 1);
      stack.push({ id, anchor: anchor ?? null });
      return this.current();
    },
    back() {
      if (stack.length > 1) stack.pop();
      return this.current();
    },
    current() {
      const entry = stack[stack.length - 1] ?? null;
      return { ...entry, depth: stack.length, canBack: stack.length > 1 };
    },
    reset(id, anchor = null) {
      stack = [];
      if (id) stack.push({ id, anchor: anchor ?? null });
      return this.current();
    },
  };
}

module.exports = { createDocsNavigation };

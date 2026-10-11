'use strict';

// Closure purity (#105 acceptance precursor): replay must never reach an
// execution path. Until the #102 composition wires a fail-on-call sandbox,
// this pins the structural half — the replay package (and the recording
// package it consumes) may only require node builtins at runtime. No
// TaskService, no agent runtimes, no network, no app imports.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGES = [
  path.join(__dirname, '..', 'src'),
  path.join(__dirname, '..', '..', 'harness-recording', 'src'),
];

function requiresOf(file) {
  const source = fs.readFileSync(file, 'utf8');
  const spec = /require\((['"])([^'"]+)\1\)/g;
  const specs = [];
  let match;
  while ((match = spec.exec(source))) specs.push(match[2]);
  return specs;
}

// Rough comment stripper: forbidden-name scanning must only see code, not
// documentation that legitimately explains what the package avoids.
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

test('replay and recording sources require only node builtins at runtime', () => {
  for (const directory of PACKAGES) {
    for (const entry of fs.readdirSync(directory)) {
      if (!entry.endsWith('.cjs')) continue;
      const file = path.join(directory, entry);
      for (const spec of requiresOf(file)) {
        assert.match(
          spec,
          /^(node:|\.{1,2}\/)/,
          `${file} must only require node builtins or sibling modules, found: ${spec}`,
        );
      }
    }
  }
});

test('the replay engine ignores host globals it must never touch', () => {
  // Importing the engine under a poisoned environment would be the full
  // fail-on-call test; without a process sandbox the next best pin is that
  // the engine module graph contains no execution-reachability markers.
  const forbidden = [/TaskService/, /createSession/, /agent-kimi/, /fetch\(/, /child_process/];
  for (const directory of PACKAGES) {
    for (const entry of fs.readdirSync(directory)) {
      if (!entry.endsWith('.cjs')) continue;
      const source = withoutComments(fs.readFileSync(path.join(directory, entry), 'utf8'));
      for (const pattern of forbidden)
        assert.doesNotMatch(source, pattern, `${entry} must not reference ${pattern}`);
    }
  }
});

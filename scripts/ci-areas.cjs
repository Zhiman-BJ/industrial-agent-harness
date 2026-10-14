// Area classifier shared with the CI gating job (.github/workflows/ci.yml).
// Kept pure and dependency-free so the portable suite can unit-test the
// exact rules the workflow applies. Runtime resources (any file under a
// skills/ directory, e.g. packages/domain-skills/skills/*/SKILL.md) are not
// documentation: edits there must gate the layers that load them.

const docs = file =>
  !/(^|\/)skills\//.test(file) &&
  (/\.md$/i.test(file) || file === 'LICENSE' || file.startsWith('doc/'));

const withinDesktop = file => docs(file) || file.startsWith('apps/desktop/');

function classify(entries) {
  const files = [];
  for (const entry of entries) {
    if (typeof entry?.filename !== 'string')
      throw Error('classify expects { filename, previous_filename? } entries.');
    files.push(entry.filename);
    // Renames and copies carry the pre-move path; a source file moved into
    // doc/ must still gate the layers its old location affects.
    if (typeof entry.previous_filename === 'string' && entry.previous_filename)
      files.push(entry.previous_filename);
  }
  const docsOnly = files.length > 0 && files.every(withinDesktop) && files.every(docs);
  const sharedChanged = files.length === 0 || files.some(file => !withinDesktop(file));
  return { docsOnly, sharedChanged };
}

// PRs exercise the core product paths. Main pushes and an explicit manual full
// run also qualify fresh installations and both supported macOS versions.
function plan(entries, { eventName, full = false }) {
  if (typeof full !== 'boolean') throw Error('full must be a boolean.');
  const complete = full || !['pull_request', 'workflow_dispatch'].includes(eventName);
  return {
    core: complete || eventName !== 'pull_request' || !classify(entries).docsOnly,
    full: complete,
  };
}

function failedJobs(jobs) {
  const { core, full } = jobs.changes?.outputs || {};
  if (
    !['true', 'false'].includes(core) ||
    !['true', 'false'].includes(full) ||
    (full === 'true' && core !== 'true')
  )
    return ['changes'];
  const expected = {
    changes: true,
    repository: true,
    portable: core === 'true',
    desktop: core === 'true',
    'industrial-linux': core === 'true',
    industrial: full === 'true',
  };
  return Object.entries(expected)
    .filter(([name, required]) => {
      const result = jobs[name]?.result;
      return result !== 'success' && !(result === 'skipped' && !required);
    })
    .map(([name]) => name);
}

module.exports = { classify, docs, withinDesktop, plan, failedJobs };

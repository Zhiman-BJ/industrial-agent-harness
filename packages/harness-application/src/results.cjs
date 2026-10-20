const { resultContentStatus } = require('./result-artifacts.cjs');
const { createEvidenceInspector } = require('@industrial-agent-harness/domain-runtime');
const {
  ResultGroupSchema,
  ResultSelectionRequestSchema,
} = require('@industrial-agent-harness/contracts');

// Durable application metadata references canonical records; it never writes
// Actions, engineering state, verification, or Checkpoints.
class TaskResults {
  constructor(chats, entry, turnId, runtime, emit) {
    Object.assign(this, { chats, entry, turnId, runtime, emit });
    this.projectId = chats.project(entry.project.path, entry.project.domain).key;
  }
  all() {
    return this.chats.latestEvents(this.entry.id, 'results-changed').map(event => event.results);
  }
  snapshot() {
    return (
      this.all().find(result => result.turnId === this.turnId) || {
        schemaVersion: '1',
        projectId: this.projectId,
        chatId: this.entry.id,
        turnId: this.turnId,
        revision: 0,
        phase: 'running',
        requestStatus: 'running',
        actionIds: [],
        groups: [],
        selection: null,
      }
    );
  }
  save(value, eventId) {
    value.revision++;
    this.emit({ type: 'results-changed', eventId, results: value });
    return this.view(value);
  }
  matching(input) {
    return this.all()
      .flatMap(result => result.groups)
      .filter(group => {
        const artifact = this.runtime?.get('artifact', group.primaryArtifactId);
        return (
          artifact?.projectId === this.projectId &&
          artifact.relativePath === input.relativePath &&
          artifact.sha256 === input.sha256
        );
      });
  }
  register(result) {
    const value = this.snapshot();
    const action = this.runtime?.get('action', result.action.id);
    if (!action || action.projectId !== this.projectId)
      throw Error('Result Action is outside this project.');
    if (value.actionIds.includes(action.id)) return this.view(value);
    if (this.all().some(prior => prior.actionIds.includes(action.id)))
      throw Error('Result Action already belongs to another request.');
    const presentation = this.runtime.get('presentation', action.id);
    value.actionIds.push(action.id);
    for (const declared of presentation?.groups || []) {
      const { key, supersedesInput, ...references } = declared;
      const matches = supersedesInput ? this.matching(supersedesInput) : [];
      const group = ResultGroupSchema.parse({
        schemaVersion: '1',
        id: `${action.id}:${key}`,
        projectId: this.projectId,
        chatId: this.entry.id,
        turnId: this.turnId,
        actionId: action.id,
        ...references,
        // Content identity plus explicit producer relation; ambiguous aliases do not fold.
        supersedes: matches.length === 1 && action.status === 'completed' ? [matches[0].id] : [],
        verificationRefs: [{ actionId: action.id, verificationId: action.verification.id }],
      });
      value.groups.push(group);
    }
    // Check references can target a group from an earlier request. Preserve its
    // identity in this request rather than relabeling it as a newly made model.
    value.checks ||= [];
    for (const check of presentation?.checks || []) {
      for (const group of this.matching(check.input))
        value.checks.push({
          groupId: group.id,
          actionId: action.id,
          verificationId: action.verification.id,
          artifactIds: check.artifactIds,
        });
    }
    if (presentation?.diagnostics.length) value.diagnostics = presentation.diagnostics;
    return this.save(value, `results:${this.turnId}:${action.id}`);
  }
  select(request) {
    if (this.entry.resultContext !== this)
      throw Error('Result request is stale; call list_results in the active request.');
    const parsed = ResultSelectionRequestSchema.parse(request);
    const value = this.snapshot();
    if (parsed.revision !== value.revision)
      throw Error('Result selection is stale; call list_results and retry.');
    const known = (parsed.historical ? this.all() : [value]).flatMap(result => result.groups);
    const replaced = new Set(
      this.all().flatMap(result => result.groups.flatMap(group => group.supersedes)),
    );
    const inspect = createEvidenceInspector(this.entry.project.path);
    for (const id of parsed.groupIds) {
      const group = known.find(group => group.id === id);
      if (
        !group ||
        group.projectId !== this.projectId ||
        group.chatId !== this.entry.id ||
        (!parsed.historical && (group.turnId !== this.turnId || replaced.has(id)))
      )
        throw Error('Unknown, out-of-scope or superseded result; call list_results and retry.');
      const primary = this.runtime?.get('artifact', group.primaryArtifactId);
      if (!parsed.historical) {
        const checks = this.all()
          .flatMap(result => result.checks || [])
          .filter(check => check.groupId === group.id);
        for (const ref of [...group.verificationRefs, ...checks]) {
          const verification = this.runtime?.get('verification', ref.verificationId);
          if (
            verification?.status === 'passed' &&
            inspect(verification.evidence?.inputHashes).status !== 'matches'
          )
            throw Error(
              'Verification inputs changed or could not be checked; rerun checks or choose a historical version.',
            );
        }
      }
      if (
        !parsed.historical &&
        (!primary ||
          ['changed', 'unavailable'].includes(resultContentStatus(this.runtime, primary)))
      )
        throw Error(
          'Result content is stale or unavailable; refresh the result or choose a historical version.',
        );
    }
    value.selection = {
      groupIds: [...new Set(parsed.groupIds)],
      historical: parsed.historical,
      basedOnRevision: value.revision,
    };
    return this.save(value, `selection:${this.turnId}:${value.revision + 1}`);
  }
  settle(status, background = false) {
    const value = this.snapshot();
    const phase = background ? 'background' : 'settled';
    if (value.phase === phase && value.requestStatus === status) return;
    value.phase = phase;
    value.requestStatus = status;
    // Settlement persists metadata and readiness without depending on rendering.
    value.revision++;
    this.emit({
      type: 'results-changed',
      eventId: `results-phase:${this.turnId}:${value.revision}`,
      results: value,
    });
    if (!background)
      this.emit({
        type: 'results-ready',
        eventId: `results-ready:${this.turnId}`,
        results: value,
        autoPreviewEligible: ['completed', 'finished'].includes(status) && !this.wasBackground,
      });
    this.wasBackground ||= background;
  }
  view(
    value = this.snapshot(),
    contentStatuses = new Map(),
    inspect = createEvidenceInspector(this.entry.project.path),
  ) {
    const all = this.all();
    const groups = all.flatMap(result => result.groups);
    const checks = all.flatMap(result => result.checks || []);
    const replaced = new Set(groups.flatMap(group => group.supersedes));
    const selected = new Set(value.selection?.groupIds || []);
    const displayed = [...value.groups];
    for (const id of selected) {
      const group = groups.find(group => group.id === id);
      if (group && !displayed.some(current => current.id === id)) displayed.push(group);
    }
    return {
      ...value,
      historicalGroups: groups
        .filter(group => group.turnId !== this.turnId)
        .map(group => ({
          id: group.id,
          title: group.title,
          turnId: group.turnId,
          superseded: replaced.has(group.id),
        })),
      groups: displayed.map(group => {
        const action = this.runtime?.get('action', group.actionId);
        const primary = this.runtime?.get('artifact', group.primaryArtifactId);
        const related = checks.filter(check => check.groupId === group.id);
        const refs = [...group.verificationRefs, ...related];
        if (primary && !contentStatuses.has(primary.id))
          contentStatuses.set(primary.id, resultContentStatus(this.runtime, primary));
        return {
          ...group,
          historical:
            group.turnId !== this.turnId ||
            (selected.has(group.id) && value.selection?.historical === true),
          superseded: replaced.has(group.id),
          selected: selected.has(group.id),
          artifacts: [
            ...new Set(
              [
                group.primaryArtifactId,
                group.previewArtifactId,
                ...group.attachmentArtifactIds,
                ...group.companionArtifactIds,
                ...related.flatMap(check => check.artifactIds),
              ].filter(Boolean),
            ),
          ]
            .map(id => this.runtime?.get('artifact', id))
            .filter(Boolean),
          executionStatus: action?.status || 'unavailable',
          contentStatus: primary ? contentStatuses.get(primary.id) : 'unavailable',
          verifications: [...new Set(refs.map(ref => ref.verificationId))]
            .map(id => this.runtime?.get('verification', id))
            .filter(Boolean)
            .map(verification => ({
              ...verification,
              inputStatus: inspect(verification.evidence?.inputHashes),
            })),
        };
      }),
      executionStatus: !['completed', 'finished'].includes(value.requestStatus)
        ? value.requestStatus
        : value.actionIds.some(id => this.runtime?.get('action', id)?.status === 'failed')
          ? 'partial'
          : 'completed',
    };
  }
}
module.exports = { TaskResults };

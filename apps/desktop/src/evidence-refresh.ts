import type {
  AgentEvent,
  EvidenceInputStatus,
  EvidenceRefresh,
} from '@industrial-agent-harness/viewer-builtin/api';

export function evidenceLabel(input?: EvidenceInputStatus) {
  return input?.status === 'changed'
    ? 'Inputs changed · rerun checks for the current project'
    : input?.status === 'matches'
      ? 'Recorded input files are unchanged'
      : input?.status === 'unavailable'
        ? 'Current inputs could not be checked'
        : 'Current inputs have not been checked';
}

// Merge observations only: never replay a result, alter its verdict, or replace
// newly streamed messages with an older history response.
export function refreshEventEvidence(events: AgentEvent[], refresh: EvidenceRefresh | null) {
  const unavailable: EvidenceInputStatus = { status: 'unavailable', changedPaths: [] };
  function status(current: EvidenceInputStatus | undefined, next: EvidenceInputStatus | undefined) {
    if (!next || JSON.stringify(current) === JSON.stringify(next)) return current;
    return next;
  }
  let changed = false;
  const updated = events.map(event => {
    if (event.type === 'industrial-result') {
      const inputStatus = status(
        event.inputStatus,
        refresh ? refresh.actions[event.action.id] : unavailable,
      );
      if (inputStatus === event.inputStatus) return event;
      changed = true;
      return { ...event, inputStatus };
    }
    if (event.type !== 'results-ready' && event.type !== 'results-changed') return event;
    let groupsChanged = false;
    const groups = event.results.groups.map(group => {
      let checksChanged = false;
      const verifications = group.verifications.map(verification => {
        const inputStatus = status(
          verification.inputStatus,
          refresh ? refresh.verifications[verification.id] : unavailable,
        );
        if (inputStatus === verification.inputStatus) return verification;
        checksChanged = true;
        return { ...verification, inputStatus };
      });
      if (!checksChanged) return group;
      groupsChanged = true;
      return { ...group, verifications };
    });
    if (!groupsChanged) return event;
    changed = true;
    return { ...event, results: { ...event.results, groups } };
  });
  return changed ? updated : events;
}

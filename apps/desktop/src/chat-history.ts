import type { AgentEvent, ChatHistory } from '@industrial-agent-harness/viewer-builtin/api';
import { appendDisplayEvents } from './agent-events.ts';

// A history reply is a snapshot. Preserve events persisted after that snapshot
// while IPC was in flight, without duplicating chunks already in the snapshot.
export function mergeHistoryEvents(history: ChatHistory, received: AgentEvent[]): ChatHistory {
  const newer = received.filter(
    event =>
      event.chatId === history.chat.id &&
      event.eventRevision !== undefined &&
      event.eventRevision > (history.eventRevision ?? 0),
  );
  if (!newer.length) return history;
  const eventsByTurn = new Map<string | undefined, AgentEvent[]>();
  for (const event of newer) {
    const events = eventsByTurn.get(event.turnId);
    if (events) events.push(event);
    else eventsByTurn.set(event.turnId, [event]);
  }
  const turns = history.turns.map(turn => {
    const events = eventsByTurn.get(turn.id);
    if (!events) return turn;
    let status = turn.status;
    for (const event of events) {
      if (event.type === 'done') status = event.result.status;
      else if (event.type === 'error') status = 'error';
    }
    return { ...turn, events: appendDisplayEvents(turn.events, events), status };
  });
  return {
    ...history,
    turns,
    eventRevision: Math.max(
      history.eventRevision ?? 0,
      ...newer.map(event => event.eventRevision!),
    ),
    executing: turns.at(-1)?.status === 'running' && history.executing,
  };
}

import type { AgentEvent } from '@industrial-agent-harness/viewer-builtin/api';

export function latestEvent<Type extends AgentEvent['type']>(
  events: AgentEvent[],
  type: Type,
): Extract<AgentEvent, { type: Type }> | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === type) return event as Extract<AgentEvent, { type: Type }>;
  }
}

export function appendDisplayEvents(current: AgentEvent[], events: AgentEvent[]): AgentEvent[] {
  if (!events.length) return current;
  const updated = [...current];
  let subagentIndices: Map<string, number> | undefined;
  let contentIndex = updated.length - 1;
  while (
    contentIndex >= 0 &&
    (updated[contentIndex].type === 'status' || updated[contentIndex].type === 'step')
  )
    contentIndex--;
  for (const event of events) {
    if (event.type === 'subagent-state') {
      if (!subagentIndices) {
        subagentIndices = new Map();
        for (let index = 0; index < updated.length; index++) {
          const item = updated[index];
          if (item.type === 'subagent-state' && !subagentIndices.has(item.id))
            subagentIndices.set(item.id, index);
        }
      }
      const index = subagentIndices.get(event.id);
      if (index !== undefined) {
        updated[index] = event;
        continue;
      }
      subagentIndices.set(event.id, updated.length);
    }
    const previous = updated[contentIndex];
    if (
      (previous?.type === 'text' && event.type === 'text') ||
      (previous?.type === 'thinking' && event.type === 'thinking')
    ) {
      updated[contentIndex] = { ...previous, text: previous.text + event.text };
    } else {
      updated.push(event);
      if (event.type !== 'status' && event.type !== 'step') contentIndex = updated.length - 1;
    }
  }
  return updated;
}

// Adapted from eda-harness-demo/src/features/replay/ThinkingPreview.tsx for live SDK events.
import {useEffect, useId, useMemo, useState} from 'react';
import {ChevronDown, ChevronRight} from 'lucide-react';

export function ThinkingPreview({text, active}: {text: string; active: boolean}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const lines = useMemo(() => text.split('\n').flatMap(line => line.match(/.{1,74}(?:\s|$)|.{1,74}/g) ?? []).filter(line => line.trim()), [text]);
  useEffect(() => {if (!active) setExpanded(false);}, [active]);
  return <section className="ia-thinking" data-active={active} data-expanded={expanded}>
    <button type="button" className="ia-thinking-head" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
      {expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
      <span>{active ? 'Thinking…' : 'Thinking'}</span>
    </button>
    {(active || expanded) && <p id={contentId}>{expanded ? text : lines.slice(-3).join('\n')}</p>}
  </section>;
}

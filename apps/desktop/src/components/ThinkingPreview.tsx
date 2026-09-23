// Adapted from eda-harness-demo/src/features/replay/ThinkingPreview.tsx for live SDK events.
import {useEffect, useId, useMemo, useState} from 'react';

export function ThinkingPreview({text, active}: {text: string; active: boolean}) {
  const lines = useMemo(() => text.split('\n').flatMap(line => line.match(/.{1,74}(?:\s|$)|.{1,74}/g) ?? []).filter(line => line.trim()), [text]);
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const contentId = useId();
  const count = Math.max(1, Math.ceil(lines.length / 2));
  useEffect(() => {
    setPage(0);
    if (expanded || !active || count < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => setPage(value => (value + 1) % count), 2600);
    return () => clearInterval(timer);
  }, [text, active, count, expanded]);
  return <div className="ia-thinking" data-expanded={expanded}><div className="ia-thinking-head"><b>Thinking</b><button type="button" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>{expanded ? 'Collapse' : 'Expand'}</button></div><p id={contentId}>{expanded ? text : lines.slice(page * 2, page * 2 + 2).join('\n')}</p>{!expanded && count > 1 && <small>{page + 1} / {count}</small>}</div>;
}

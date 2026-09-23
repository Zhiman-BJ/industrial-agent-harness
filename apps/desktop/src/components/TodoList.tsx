// Adapted from eda-harness-demo/src/features/replay/PlanTodo.tsx for Kimi's live Todo display blocks.
import {useState} from 'react';
import {Check, ChevronDown, ChevronRight, Circle, LoaderCircle} from 'lucide-react';

export function TodoList({items, running}: {items: Array<{title: string; status: 'pending' | 'in_progress' | 'done'}>; running: boolean}) {
  const [expanded, setExpanded] = useState(false);
  const focus = Math.max(0, items.findIndex(item => item.status === 'in_progress'));
  const start = Math.max(0, Math.min(focus - 1, items.length - 3));
  const visible = expanded ? items : items.slice(start, start + 3);
  return <section className="ia-todo" aria-label="Agent todo list"><button className="ia-todo-title" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}<b>Todo</b><small>{items.filter(item => item.status === 'done').length} / {items.length}</small></button><ol>{visible.map((item, index) => <li key={`${item.title}:${index}`} data-status={item.status}><span className={item.status === 'in_progress' && running ? 'ia-todo-spin' : ''}>{item.status === 'done' ? <Check size={13}/> : item.status === 'in_progress' ? <LoaderCircle size={13}/> : <Circle size={11}/>}</span><span>{item.title}</span></li>)}</ol></section>;
}

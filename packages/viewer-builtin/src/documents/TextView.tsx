import {useMemo, useState} from 'react';
import {PageControls} from './PageControls';

export function TextView({text, query = ''}: {text: string; query?: string}) {
  const [wrap, setWrap] = useState(true);
  const [cursor, setCursor] = useState({query, page: 0});
  const lines = useMemo(() => {
    const needle = query.toLocaleLowerCase();
    return text.split('\n').map((value, index) => ({value, number: index + 1})).filter(line => !needle || line.value.toLocaleLowerCase().includes(needle));
  }, [text, query]);
  const page = cursor.query === query ? cursor.page : 0;
  return <div className="rp-document-text">
    <div className="rp-document-options"><label><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)}/>Wrap lines</label><span>{lines.length} {query ? 'matching ' : ''}lines</span></div>
    <pre className={wrap ? 'is-wrapped' : ''}>{lines.slice(page * 200, (page + 1) * 200).map(line => <span className="rp-document-line" key={line.number}><span className="rp-document-line-number">{line.number}</span><span>{line.value || '\u200B'}</span></span>)}</pre>
    {!lines.length && <p>No matching lines.</p>}
    <PageControls page={page} pages={Math.ceil(lines.length / 200)} onPage={value => setCursor({query, page: value})}/>
  </div>;
}

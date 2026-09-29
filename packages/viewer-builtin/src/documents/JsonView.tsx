import {useMemo, useState} from 'react';
import {PageControls} from './PageControls';
type Json = null | boolean | number | string | Json[] | {[key: string]: Json};

function JsonNode({name, value, root = false}: {name: string; value: Json; root?: boolean}) {
  const [open, setOpen] = useState(root);
  const [page, setPage] = useState(0);
  const entries = useMemo(() => value !== null && typeof value === 'object' ? Object.entries(value) : null, [value]);
  if (!entries) {
    const text = JSON.stringify(value);
    return <div className="rp-json-leaf"><b>{name}</b><code data-value-type={value === null ? 'null' : typeof value}>{text.length > 500 ? `${text.slice(0, 500)}… (see Source)` : text}</code></div>;
  }
  const size = entries.length;
  return <div className="rp-json-node">
    <button className="rp-json-toggle" aria-expanded={open} onClick={() => setOpen(current => !current)}><span>{open ? '▾' : '▸'}</span><b>{name}</b><small>{Array.isArray(value) ? `Array [${size}]` : `Object {${size}}`}</small></button>
    {open && <div className="rp-json-children">{entries.slice(page * 50, (page + 1) * 50).map(([key, child]) => <JsonNode key={key} name={key} value={child}/>)}{size > 50 && <PageControls page={page} pages={Math.ceil(size / 50)} onPage={setPage}/>}</div>}
  </div>;
}

export function JsonView({text, lines}: {text: string; lines: boolean}) {
  const values = useMemo(() => {
    const source = text.replace(/^\uFEFF/, '');
    return lines ? source.split(/\r?\n/).map((line, index) => ({line, number: index + 1})).filter(item => item.line.trim()).map(item => ({name: `Line ${item.number}`, value: JSON.parse(item.line) as Json})) : [{name: '$', value: JSON.parse(source) as Json}];
  }, [text, lines]);
  const [page, setPage] = useState(0);
  return <div className="rp-document-json">
    {lines && <p>{values.length} records · 20 per page</p>}
    {values.slice(page * 20, (page + 1) * 20).map(record => <JsonNode key={record.name} name={record.name} value={record.value} root/>)}
    {lines && <PageControls page={page} pages={Math.ceil(values.length / 20)} onPage={setPage}/>} {!values.length && <p>No records.</p>}
  </div>;
}

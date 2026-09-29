import {useMemo, useState} from 'react';
import {PageControls} from './PageControls';

export function TableView({rows, columns, ragged, query}: {rows: string[][]; columns: number; ragged: boolean; query: string}) {
  const [header, setHeader] = useState(true);
  const [cursor, setCursor] = useState({query, header, page: 0});
  const filtered = useMemo(() => {
    const needle = query.toLocaleLowerCase();
    return rows.slice(header ? 1 : 0).map((cells, index) => ({cells, index: index + (header ? 2 : 1)})).filter(row => !needle || row.cells.some(cell => cell.toLocaleLowerCase().includes(needle)));
  }, [rows, header, query]);
  const page = cursor.query === query && cursor.header === header ? cursor.page : 0;
  const pages = Math.ceil(filtered.length / 100);
  return <div className="rp-document-table">
    <div className="rp-document-options"><label><input type="checkbox" checked={header} onChange={event => setHeader(event.target.checked)}/>First row is header</label><span>{filtered.length} / {Math.max(0, rows.length - (header ? 1 : 0))} rows · {columns} columns</span></div>
    {ragged && <p role="status">Rows have different column counts. Missing cells are shown as —.</p>}
    <table><thead><tr><th scope="col">Row</th>{Array.from({length: columns}, (_, i) => <th scope="col" key={i}>{header ? rows[0]?.[i] ?? `Column ${i + 1}` : `Column ${i + 1}`}</th>)}</tr></thead>
      <tbody>{filtered.slice(page * 100, (page + 1) * 100).map(row => <tr key={row.index}><th scope="row">{row.index}</th>{Array.from({length: columns}, (_, i) => <td key={i}>{row.cells[i] ?? <span aria-label="Missing cell">—</span>}</td>)}</tr>)}</tbody></table>
    {!filtered.length && <p>No matching rows.</p>}
    <PageControls page={page} pages={pages} onPage={value => setCursor({query, header, page: value})}/>
  </div>;
}

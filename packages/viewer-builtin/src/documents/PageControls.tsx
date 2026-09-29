export function PageControls({page, pages, onPage}: {page: number; pages: number; onPage: (page: number) => void}) {
  return <nav className="rp-document-pages" aria-label="Document pages">
    <button disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</button>
    <span>Page {page + 1} / {Math.max(1, pages)}</span>
    <button disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>Next</button>
  </nav>;
}

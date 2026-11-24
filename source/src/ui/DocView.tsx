import { useEffect, useState } from 'react';
import { canvasToBlob, previewUrl } from '../core/image';
import { ocrFresh } from '../core/ocr';
import { layout, loadFonts, paint } from '../core/typeset';
import { FILTERS, type FilterId, type Page } from '../core/types';
import { Back, Compare, Crop, Download, Plus, Replace, Rotate, Trash } from './icons';
import Strip from './Strip';

interface Props {
  pages: Page[];
  sel: number;
  readable: boolean;
  setSel: (i: number) => void;
  onBack: () => void;
  onCrop: () => void;
  onRotate: () => void;
  onReplace: () => void;
  onDelete: () => void;
  onAdd: () => void;
  onFilter: (f: FilterId) => void;
  onFingers: (on: boolean) => void;
  onReadable: (on: boolean) => void;
  onMove: (from: number, to: number) => void;
  onExport: () => void;
}

function usePreview(page: Page | undefined, raw: boolean) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!page) return;
    let live = true;
    setLoading(true);
    previewUrl(page, 1400, raw)
      .then((u) => live && (setUrl(u), setLoading(false)))
      .catch(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [page, raw]);
  return { url, loading };
}

/** Shows the uniformly re-typeset version of the selected scan (same font, size and spacing on every page). */
function ReadablePreview({ pages, sel }: { pages: Page[]; sel: number }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    const made: string[] = [];
    (async () => {
      const fonts = await loadFonts();
      const laid = layout(pages, 'letter', fonts).filter((l) => l.scan === sel);
      const out: string[] = [];
      for (const lp of laid) {
        if (lp.image) out.push(await previewUrl(pages[sel], 1400));
        else {
          const u = URL.createObjectURL(await canvasToBlob(paint(lp, 1.6), 'image/jpeg', 0.9));
          made.push(u);
          out.push(u);
        }
      }
      if (live) setUrls(out);
    })().catch(() => undefined);
    return () => {
      live = false;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [pages, sel]);
  return (
    <div className="readable" data-testid="readable-preview">
      {urls.map((u, i) => (
        <img key={u} src={u} alt={`Readable text, page ${sel + 1}${urls.length > 1 ? ` part ${i + 1}` : ''}`} />
      ))}
      <p className="ocr-note">Read on your device. May contain mistakes.</p>
    </div>
  );
}

export default function DocView(p: Props) {
  const page = p.pages[p.sel];
  const showReadable = p.readable && p.pages.every(ocrFresh);
  const after = usePreview(page, false);
  const [compare, setCompare] = useState(false);
  const before = usePreview(compare && !showReadable ? page : undefined, true);
  const [pos, setPos] = useState(50);

  if (!page) return null;
  return (
    <div className="screen doc">
      <header className="topbar">
        <button className="icon-btn" onClick={p.onBack} aria-label="Back to home"><Back /></button>
        <div className="pager">
          <button className="mini" onClick={() => p.onMove(p.sel, p.sel - 1)} disabled={p.sel === 0} aria-label="Move page earlier">←</button>
          <span>Page {p.sel + 1} of {p.pages.length}</span>
          <button className="mini" onClick={() => p.onMove(p.sel, p.sel + 1)} disabled={p.sel >= p.pages.length - 1} aria-label="Move page later">→</button>
        </div>
        <button className="btn primary small" onClick={p.onExport}><Download size={18} /> PDF</button>
      </header>

      <div className="preview">
        {showReadable ? (
          <ReadablePreview pages={p.pages} sel={p.sel} />
        ) : (
          after.url && (
            <div className="cmp">
              <img src={after.url} alt={`Page ${p.sel + 1}`} className="after" />
              {compare && before.url && (
                <>
                  <img src={before.url} alt="" className="before" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />
                  <div className="cut" style={{ left: `${pos}%` }} />
                  <span className="tag l">Before</span>
                  <span className="tag r">After</span>
                  <input type="range" min={0} max={100} value={pos} onChange={(e) => setPos(+e.target.value)} aria-label="Before and after slider" />
                </>
              )}
            </div>
          )
        )}
        {!showReadable && (
          <button className={'chip float' + (compare ? ' on' : '')} onClick={() => setCompare((c) => !c)} aria-pressed={compare}>
            <Compare size={18} /> Compare
          </button>
        )}
        {after.loading && !showReadable && <div className="loading"><i /></div>}
      </div>

      <div className="filters" role="tablist" aria-label="Filters">
        {FILTERS.map((f) => (
          <button key={f.id} role="tab" aria-selected={page.filter === f.id} className={'chip' + (page.filter === f.id ? ' on' : '')} onClick={() => p.onFilter(f.id)} disabled={p.readable}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="options">
        <label className="switch">
          <input type="checkbox" checked={page.fingers} onChange={(e) => p.onFingers(e.target.checked)} />
          <span /> Remove fingers
        </label>
        <label className="switch">
          <input type="checkbox" checked={p.readable} onChange={(e) => p.onReadable(e.target.checked)} />
          <span /> Readable text
        </label>
      </div>

      <Strip pages={p.pages} sel={p.sel} onSelect={p.setSel} onMove={p.onMove} onAdd={p.onAdd} />

      <footer className="toolbar">
        <button className="tool" onClick={p.onCrop}><Crop /><span>Crop</span></button>
        <button className="tool" onClick={p.onRotate}><Rotate /><span>Rotate</span></button>
        <button className="tool" onClick={p.onReplace}><Replace /><span>Replace</span></button>
        <button className="tool" onClick={p.onAdd}><Plus /><span>Add page</span></button>
        <button className="tool danger" onClick={p.onDelete}><Trash /><span>Delete</span></button>
      </footer>
    </div>
  );
}

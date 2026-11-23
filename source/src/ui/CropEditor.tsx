import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { detectCorners } from '../core/image';
import type { Page, PageShape, Pt } from '../core/types';
import { Back, Check, Expand, Wand } from './icons';

interface Props {
  page: Page;
  onApply: (corners: Pt[], shape: PageShape) => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}

const FULL: Pt[] = [
  { x: 0.02, y: 0.02 },
  { x: 0.98, y: 0.02 },
  { x: 0.98, y: 0.98 },
  { x: 0.02, y: 0.98 },
];
const LOUPE = 112;

/** Drag the four corners to fit the paper. Handles have a 44px touch target and a magnifier. */
export default function CropEditor({ page, onApply, onCancel, onError }: Props) {
  const [corners, setCorners] = useState<Pt[]>(page.corners);
  const [shape, setShape] = useState<PageShape>(page.shape ?? 'auto');
  const [url, setUrl] = useState('');
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const u = URL.createObjectURL(page.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [page.blob]);

  useLayoutEffect(() => {
    const measure = () => {
      const el = wrap.current;
      if (!el) return;
      const maxW = el.clientWidth;
      const maxH = el.clientHeight;
      const s = Math.min(maxW / page.w, maxH / page.h);
      setBox({ w: Math.floor(page.w * s), h: Math.floor(page.h * s) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [page.w, page.h]);

  const move = useCallback(
    (i: number, e: React.PointerEvent) => {
      const el = e.currentTarget.parentElement!.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - el.left) / el.width));
      const y = Math.min(1, Math.max(0, (e.clientY - el.top) / el.height));
      setCorners((c) => c.map((p, k) => (k === i ? { x, y } : p)));
    },
    [],
  );

  const auto = async () => {
    setBusy(true);
    try {
      const r = await detectCorners(page.blob);
      setCorners(r.corners);
      if (!r.found) onError('Could not find the page edges. Drag the corners to fit it.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Detection failed.');
    } finally {
      setBusy(false);
    }
  };

  const pts = corners.map((c) => `${c.x * box.w},${c.y * box.h}`).join(' ');
  const d = drag !== null ? corners[drag] : null;
  // loupe shows a 3x magnified patch around the dragged corner, parked at the opposite upper side
  const zoom = 3;
  const loupeLeft = d && d.x > 0.5 ? 8 : box.w - LOUPE - 8;

  return (
    <div className="screen crop">
      <header className="topbar">
        <button className="icon-btn" onClick={onCancel} aria-label="Cancel"><Back /></button>
        <h2>Adjust corners</h2>
        <button className="btn primary small" onClick={() => onApply(corners, shape)} disabled={busy}><Check size={18} /> Done</button>
      </header>

      <div className="crop-stage" ref={wrap}>
        {url && (
          <div className="crop-box" style={{ width: box.w, height: box.h }}>
            <img src={url} width={box.w} height={box.h} draggable={false} alt="Document to crop" />
            <svg width={box.w} height={box.h} className="crop-svg">
              <polygon points={pts} className="crop-poly" />
            </svg>
            {corners.map((c, i) => (
              <div
                key={i}
                className={'handle' + (drag === i ? ' active' : '')}
                style={{ left: c.x * box.w, top: c.y * box.h }}
                role="slider"
                aria-label={['Top left', 'Top right', 'Bottom right', 'Bottom left'][i] + ' corner'}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDrag(i);
                  move(i, e);
                }}
                onPointerMove={(e) => drag === i && move(i, e)}
                onPointerUp={() => setDrag(null)}
                onPointerCancel={() => setDrag(null)}
              >
                <span />
              </div>
            ))}
            {d && (
              <div
                className="loupe"
                style={{
                  width: LOUPE,
                  height: LOUPE,
                  left: loupeLeft,
                  top: 8,
                  backgroundImage: `url(${url})`,
                  backgroundSize: `${box.w * zoom}px ${box.h * zoom}px`,
                  backgroundPosition: `${-(d.x * box.w * zoom - LOUPE / 2)}px ${-(d.y * box.h * zoom - LOUPE / 2)}px`,
                }}
              >
                <i />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="shape-row" role="radiogroup" aria-label="Page shape">
        <span>Page shape</span>
        {([['auto', 'Auto'], ['letter', 'Letter'], ['a4', 'A4'], ['free', 'As drawn']] as [PageShape, string][]).map(([v, t]) => (
          <button key={v} role="radio" aria-checked={shape === v} className={'chip small' + (shape === v ? ' on' : '')} onClick={() => setShape(v)}>{t}</button>
        ))}
      </div>

      <footer className="toolbar two">
        <button className="tool" onClick={auto} disabled={busy}><Wand /> <span>{busy ? 'Detecting…' : 'Auto detect'}</span></button>
        <button className="tool" onClick={() => setCorners(FULL)} disabled={busy}><Expand /> <span>Full image</span></button>
      </footer>
    </div>
  );
}

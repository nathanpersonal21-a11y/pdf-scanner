import { useEffect, useRef, useState } from 'react';
import { previewUrl } from '../core/image';
import type { Page } from '../core/types';
import { Plus } from './icons';

function Thumb({ page }: { page: Page }) {
  const [u, setU] = useState('');
  useEffect(() => {
    let live = true;
    previewUrl(page, 240)
      .then((x) => live && setU(x))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [page]);
  return u ? <img src={u} alt="" draggable={false} /> : <div className="ph spin" />;
}

interface Props {
  pages: Page[];
  sel: number;
  onSelect: (i: number) => void;
  onMove: (from: number, to: number) => void;
  onAdd: () => void;
}

/** Thumbnail strip. Long-press (or click-and-drag with a mouse) a page, then slide it to reorder. */
export default function Strip({ pages, sel, onSelect, onMove, onAdd }: Props) {
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const timer = useRef<number>(0);
  const moved = useRef(false);
  const box = useRef<HTMLDivElement>(null);

  // while dragging, stop the strip from scrolling under the finger
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const stop = (e: TouchEvent) => {
      if (dragRef.current) e.preventDefault();
    };
    el.addEventListener('touchmove', stop, { passive: false });
    return () => el.removeEventListener('touchmove', stop);
  }, []);

  const targetAt = (x: number): number => {
    const kids = Array.from(box.current!.querySelectorAll<HTMLElement>('[data-i]'));
    let best = 0;
    let bd = Infinity;
    kids.forEach((k, i) => {
      const r = k.getBoundingClientRect();
      const d = Math.abs(x - (r.left + r.width / 2));
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };

  const down = (i: number, e: React.PointerEvent) => {
    moved.current = false;
    window.clearTimeout(timer.current);
    const mouse = e.pointerType === 'mouse';
    timer.current = window.setTimeout(() => {
      setDrag({ from: i, to: i });
      moved.current = true;
      navigator.vibrate?.(8);
    }, mouse ? 120 : 260);
  };
  const mv = (e: React.PointerEvent) => {
    if (dragRef.current) setDrag({ from: dragRef.current.from, to: targetAt(e.clientX) });
  };
  const up = () => {
    window.clearTimeout(timer.current);
    const d = dragRef.current;
    if (d) {
      if (d.from !== d.to) onMove(d.from, d.to);
      setDrag(null);
    }
  };

  return (
    <div className="strip" ref={box} onPointerMove={mv} onPointerUp={up} onPointerCancel={() => { window.clearTimeout(timer.current); setDrag(null); }}>
      {pages.map((p, i) => (
        <button
          key={p.id}
          data-i={i}
          className={'thumb' + (i === sel ? ' sel' : '') + (drag?.from === i ? ' dragging' : '') + (drag && drag.to === i && drag.from !== i ? ' target' : '')}
          onPointerDown={(e) => down(i, e)}
          onClick={() => { if (!moved.current) onSelect(i); moved.current = false; }}
          aria-label={`Page ${i + 1}`}
          aria-current={i === sel}
        >
          <Thumb page={p} />
          <span className="num">{i + 1}</span>
        </button>
      ))}
      <button className="thumb add" onClick={onAdd} aria-label="Add page"><Plus /></button>
    </div>
  );
}

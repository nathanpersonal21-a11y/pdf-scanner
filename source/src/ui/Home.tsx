import { useEffect, useRef, useState } from 'react';
import type { Doc } from '../core/types';
import { Camera, File as FileIcon, ImageIcon, Trash } from './icons';

interface Props {
  recents: Doc[];
  engine: 'loading' | 'ready' | 'error';
  onScan: () => void;
  onFiles: (files: File[]) => void;
  onOpen: (d: Doc) => void;
  onDelete: (d: Doc) => void;
}

function Thumb({ blob }: { blob?: Blob }) {
  const [u, setU] = useState('');
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setU(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return u ? <img src={u} alt="" /> : <div className="ph"><FileIcon /></div>;
}

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia('(display-mode: standalone)').matches;

export default function Home({ recents, engine, onScan, onFiles, onOpen, onDelete }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [tip, setTip] = useState(() => isIOS && !standalone && localStorage.getItem('tip-a2hs') !== '1');

  return (
    <div className="screen home">
      <div className="home-scroll">
        <header className="home-head">
          <h1>DocScan</h1>
          <p>Scan to PDF. Everything stays on your device.</p>
        </header>

        <div className="actions">
          <button className="action primary" onClick={onScan}>
            <span className="ico"><Camera size={28} /></span>
            <span><b>Scan Document</b><small>Use the camera</small></span>
          </button>
          <button className="action" onClick={() => input.current?.click()}>
            <span className="ico"><ImageIcon size={28} /></span>
            <span><b>Upload Images</b><small>JPG or PNG</small></span>
          </button>
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,.jpg,.jpeg,.png"
            multiple
            hidden
            onChange={(e) => {
              const f = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (f.length) onFiles(f);
            }}
          />
        </div>

        {engine !== 'ready' && (
          <div className={'engine ' + engine}>
            {engine === 'loading' ? 'Preparing scanner engine… first launch only' : 'Scanner engine failed to load. Reload the app.'}
          </div>
        )}

        {tip && (
          <div className="tip">
            <div>
              <b>Install on your iPhone</b>
              <p>Tap Share, then <i>Add to Home Screen</i>. DocScan then works offline.</p>
            </div>
            <button className="icon-btn" aria-label="Dismiss" onClick={() => { localStorage.setItem('tip-a2hs', '1'); setTip(false); }}>✕</button>
          </div>
        )}

        <section className="recent">
          <h3>Recent Scans</h3>
          {recents.length === 0 ? (
            <div className="empty">
              <FileIcon size={34} />
              <p>No scans yet. Your documents will appear here.</p>
            </div>
          ) : (
            <ul>
              {recents.map((d) => (
                <li key={d.id}>
                  <button className="recent-item" onClick={() => onOpen(d)}>
                    <div className="rthumb"><Thumb blob={d.thumb} /></div>
                    <div className="rmeta">
                      <b>{d.name}</b>
                      <small>{d.pages.length} page{d.pages.length === 1 ? '' : 's'} · {new Date(d.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small>
                    </div>
                  </button>
                  <button className="icon-btn" aria-label={`Delete ${d.name}`} onClick={() => onDelete(d)}><Trash size={20} /></button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

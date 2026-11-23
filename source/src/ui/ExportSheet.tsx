import { useEffect, useState } from 'react';
import { canShareFile, downloadBlob, exportPdf, pdfBlob, safeName } from '../core/pdf';
import type { OutputMode, Page, PageSize } from '../core/types';
import { Download, Share } from './icons';

interface Props {
  pages: Page[];
  initialName: string;
  readable: boolean;
  ensurePages: () => Promise<Page[] | null>;
  onRename: (name: string) => void;
  onClose: () => void;
  onError: (m: string) => void;
}

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="field">
      <span className="lbl">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map(([v, t]) => (
          <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{t}</button>
        ))}
      </div>
    </div>
  );
}

export default function ExportSheet({ pages, initialName, readable, ensurePages, onRename, onClose, onError }: Props) {
  const [name, setName] = useState(initialName);
  const [size, setSize] = useState<PageSize>('letter');
  const [mode, setMode] = useState<OutputMode>('color');
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [result, setResult] = useState<{ blob: Blob; file: File } | null>(null);
  const [savedNote, setSavedNote] = useState('');

  // any option change invalidates a previously built PDF
  useEffect(() => setResult(null), [name, size, mode, pages, readable]);

  const create = async () => {
    setProgress([0, pages.length]);
    setSavedNote('');
    try {
      const filename = safeName(name);
      let use = pages;
      if (readable) {
        const ready = await ensurePages();
        if (!ready) return;
        use = ready;
      }
      const bytes = await exportPdf(use, { name: filename.replace(/\.pdf$/, ''), size, mode, readable, onProgress: (d, t) => setProgress([d, t]) });
      const blob = pdfBlob(bytes);
      setResult({ blob, file: new File([blob], filename, { type: 'application/pdf' }) });
      onRename(name);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not create the PDF.');
    } finally {
      setProgress(null);
    }
  };

  const download = () => {
    if (!result) return;
    downloadBlob(result.blob, result.file.name);
    setSavedNote('Saved to your downloads.');
  };
  const share = async () => {
    if (!result) return;
    try {
      await navigator.share({ files: [result.file], title: result.file.name });
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') onError('Sharing failed. Use Download instead.');
    }
  };

  const mb = result ? (result.blob.size / 1048576).toFixed(result.blob.size > 1048576 ? 1 : 2) : '';

  return (
    <div className="sheet-wrap" role="dialog" aria-modal="true" aria-label="Export PDF">
      <div className="scrim" onClick={progress ? undefined : onClose} />
      <div className="sheet">
        <div className="grab" />
        <h2>Export PDF</h2>
        <div className="field">
          <label className="lbl" htmlFor="pdfname">File name</label>
          <div className="name-row">
            <input id="pdfname" value={name} onChange={(e) => setName(e.target.value)} placeholder="Scan" autoComplete="off" spellCheck={false} />
            <span>.pdf</span>
          </div>
        </div>
        <Seg label="Page size" value={size} onChange={setSize} options={[['letter', 'Letter'], ['a4', 'A4'], ['auto', 'Auto']]} />
        {readable ? (
          <p className="note">Readable text is on: every page is re-typeset with the same font, size and spacing as selectable text. Pages with no readable text keep a cleaned scan.</p>
        ) : (
          <Seg label="Output" value={mode} onChange={setMode} options={[['color', 'Color'], ['gray', 'Grayscale'], ['bw', 'Black & White']]} />
        )}
        <p className="meta">{pages.length} page{pages.length === 1 ? '' : 's'}{result ? ` · ${mb} MB` : ''}</p>

        {!result && (
          <button className="btn primary wide" onClick={create} disabled={!!progress}>
            {progress ? `Creating page ${Math.min(progress[0] + 1, progress[1])} of ${progress[1]}…` : 'Create PDF'}
          </button>
        )}
        {result && (
          <div className="done-row">
            <button className="btn primary wide" onClick={download}><Download size={20} /> Download PDF</button>
            {canShareFile(result.file) && <button className="btn wide" onClick={share}><Share size={20} /> Share / Save to Files</button>}
            {savedNote && <p className="ok">{savedNote}</p>}
          </div>
        )}
        <button className="btn link" onClick={onClose} disabled={!!progress}>Close</button>
      </div>
    </div>
  );
}

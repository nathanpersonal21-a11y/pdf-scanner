import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCV } from './core/cv';
import { deleteDoc, listDocs, saveDoc } from './core/db';
import { canvasToBlob, detectCorners, makeSource, renderPage } from './core/image';
import { uid, type Doc, type FilterId, type Page, type Pt } from './core/types';
import Camera from './ui/Camera';
import CropEditor from './ui/CropEditor';
import DocView from './ui/DocView';
import ExportSheet from './ui/ExportSheet';
import Home from './ui/Home';
import { Camera as CamIcon, ImageIcon } from './ui/icons';

type Screen = 'home' | 'camera' | 'crop' | 'doc';

const defaultName = () => {
  const d = new Date();
  return `Scan ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(':', '.')}`;
};

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [doc, setDoc] = useState<Doc | null>(null);
  const [sel, setSel] = useState(0);
  const [recents, setRecents] = useState<Doc[]>([]);
  const [engine, setEngine] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [replaceId, setReplaceId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  const say = useCallback((m: string) => {
    setNotice(m);
    window.setTimeout(() => setNotice((cur) => (cur === m ? '' : cur)), 5000);
  }, []);

  const refresh = useCallback(() => listDocs().then(setRecents), []);

  useEffect(() => {
    refresh();
    loadCV().then(() => setEngine('ready')).catch((e) => { setEngine('error'); say(e.message); });
  }, [refresh, say]);

  // autosave to this device (IndexedDB) shortly after any change
  useEffect(() => {
    if (!doc || !doc.pages.length) return;
    const t = window.setTimeout(async () => {
      let thumb: Blob | undefined;
      try {
        thumb = await canvasToBlob(await renderPage(doc.pages[0], { maxSide: 260 }), 'image/jpeg', 0.8);
      } catch { /* thumbnail is optional */ }
      await saveDoc({ ...doc, thumb });
    }, 800);
    return () => window.clearTimeout(t);
  }, [doc]);

  const mutate = (fn: (d: Doc) => Doc) => setDoc((d) => (d ? { ...fn(d), updated: Date.now() } : d));
  const patchPage = (id: string, patch: Partial<Page>) =>
    mutate((d) => ({ ...d, pages: d.pages.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));

  /** Turns image files/blobs into pages with auto-detected borders. */
  const buildPages = async (inputs: Blob[]): Promise<Page[]> => {
    const out: Page[] = [];
    for (let i = 0; i < inputs.length; i++) {
      setBusy(inputs.length > 1 ? `Processing image ${i + 1} of ${inputs.length}…` : 'Finding page edges…');
      try {
        const src = await makeSource(inputs[i]);
        const det = await detectCorners(src.blob);
        out.push({ id: uid(), blob: src.blob, w: src.w, h: src.h, corners: det.corners, rotation: 0, filter: 'document', fingers: true });
      } catch (e) {
        say(e instanceof Error ? e.message : 'An image could not be processed.');
      }
    }
    setBusy('');
    return out;
  };

  const addPages = (pages: Page[]) => {
    if (!pages.length) return false;
    setDoc((d) => {
      const base = d ?? { id: uid(), name: defaultName(), updated: Date.now(), pages: [] };
      return { ...base, updated: Date.now(), pages: [...base.pages, ...pages] };
    });
    return true;
  };

  const handleFiles = async (files: File[]) => {
    const imgs = files.filter((f) => /^image\/(jpeg|png)$/.test(f.type) || /\.(jpe?g|png)$/i.test(f.name) || f.type.startsWith('image/'));
    if (!imgs.length) return say('Please choose JPG or PNG images.');

    if (replaceId && doc) {
      const [np] = await buildPages([imgs[0]]);
      if (np) {
        patchPage(replaceId, { blob: np.blob, w: np.w, h: np.h, corners: np.corners, rotation: 0 });
        setScreen('doc');
      }
      setReplaceId(null);
      return;
    }
    const startIndex = doc?.pages.length ?? 0;
    const pages = await buildPages(imgs);
    if (addPages(pages)) {
      setSel(startIndex);
      setScreen('doc');
    }
  };

  const handleCapture = async (photo: Blob) => {
    if (replaceId && doc) {
      const [np] = await buildPages([photo]);
      if (np) patchPage(replaceId, { blob: np.blob, w: np.w, h: np.h, corners: np.corners, rotation: 0 });
      setReplaceId(null);
      setScreen('doc');
      return;
    }
    const pages = await buildPages([photo]);
    if (addPages(pages)) setSel((doc?.pages.length ?? 0) + pages.length - 1);
  };

  const closeCamera = () => {
    setReplaceId(null);
    setScreen(doc && doc.pages.length ? 'doc' : 'home');
  };

  const goHome = () => {
    setScreen('home');
    setDoc(null);
    setSel(0);
    setTimeout(refresh, 900);
  };

  const removePage = () => {
    if (!doc) return;
    if (!window.confirm('Delete this page?')) return;
    const left = doc.pages.filter((_, i) => i !== sel);
    if (!left.length) {
      deleteDoc(doc.id).then(refresh);
      setDoc(null);
      setScreen('home');
      return;
    }
    mutate((d) => ({ ...d, pages: left }));
    setSel(Math.min(sel, left.length - 1));
  };

  const movePage = (from: number, to: number) => {
    if (!doc || to < 0 || to >= doc.pages.length || from === to) return;
    mutate((d) => {
      const pages = [...d.pages];
      const [m] = pages.splice(from, 1);
      pages.splice(to, 0, m);
      return { ...d, pages };
    });
    setSel(to);
  };

  const page = doc?.pages[sel];

  return (
    <div className="app">
      {screen === 'home' && (
        <Home
          recents={recents}
          engine={engine}
          onScan={() => { setDoc(null); setSel(0); setScreen('camera'); }}
          onFiles={(f) => { setDoc(null); setSel(0); handleFiles(f); }}
          onOpen={(d) => { setDoc(d); setSel(0); setScreen('doc'); }}
          onDelete={(d) => { if (window.confirm(`Delete “${d.name}”?`)) deleteDoc(d.id).then(refresh); }}
        />
      )}

      {screen === 'camera' && (
        <Camera
          pageCount={doc?.pages.length ?? 0}
          replacing={!!replaceId}
          onCapture={handleCapture}
          onFiles={handleFiles}
          onClose={closeCamera}
        />
      )}

      {screen === 'crop' && page && (
        <CropEditor
          page={page}
          onCancel={() => setScreen('doc')}
          onError={say}
          onApply={(corners: Pt[]) => { patchPage(page.id, { corners }); setScreen('doc'); }}
        />
      )}

      {screen === 'doc' && doc && page && (
        <DocView
          pages={doc.pages}
          sel={sel}
          setSel={setSel}
          onBack={goHome}
          onCrop={() => setScreen('crop')}
          onRotate={() => patchPage(page.id, { rotation: (page.rotation + 90) % 360 })}
          onReplace={() => { setReplaceId(page.id); setScreen('camera'); }}
          onDelete={removePage}
          onAdd={() => setAddMenu(true)}
          onFilter={(f: FilterId) => patchPage(page.id, { filter: f })}
          onFingers={(on) => patchPage(page.id, { fingers: on })}
          onMove={movePage}
          onExport={() => setExporting(true)}
        />
      )}

      {exporting && doc && (
        <ExportSheet
          pages={doc.pages}
          initialName={doc.name}
          onRename={(name) => mutate((d) => ({ ...d, name }))}
          onClose={() => setExporting(false)}
          onError={say}
        />
      )}

      {addMenu && (
        <div className="sheet-wrap" role="dialog" aria-label="Add page">
          <div className="scrim" onClick={() => setAddMenu(false)} />
          <div className="sheet">
            <div className="grab" />
            <h2>Add page</h2>
            <button className="btn wide" onClick={() => { setAddMenu(false); setReplaceId(null); setScreen('camera'); }}><CamIcon size={20} /> Scan with camera</button>
            <button className="btn wide" onClick={() => { setAddMenu(false); uploadRef.current?.click(); }}><ImageIcon size={20} /> Upload images</button>
            <button className="btn link" onClick={() => setAddMenu(false)}>Cancel</button>
          </div>
        </div>
      )}

      <input
        ref={uploadRef}
        type="file"
        accept="image/jpeg,image/png,.jpg,.jpeg,.png"
        multiple
        hidden
        onChange={(e) => {
          const f = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (f.length) handleFiles(f);
        }}
      />

      {busy && (
        <div className="busy" role="status"><div className="spinner" /><p>{busy}</p></div>
      )}
      {notice && <div className="toast" role="alert" onClick={() => setNotice('')}>{notice}</div>}
    </div>
  );
}

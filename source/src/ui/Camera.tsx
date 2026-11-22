import { useCallback, useEffect, useRef, useState } from 'react';
import { cvReady, loadCV } from '../core/cv';
import { canvasToBlob, detectInCanvas } from '../core/image';
import type { Pt } from '../core/types';
import { Check, Close, Flip, ImageIcon } from './icons';

interface Props {
  pageCount: number;
  replacing?: boolean;
  onCapture: (photo: Blob) => void | Promise<void>;
  onFiles: (files: File[]) => void;
  onClose: () => void;
}

type Facing = 'environment' | 'user';

/** Live camera with edge-detection overlay. Falls back to the system camera/photo picker if blocked. */
export default function Camera({ pageCount, replacing, onCapture, onFiles, onClose }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const small = useRef<HTMLCanvasElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const nativeCam = useRef<HTMLInputElement>(null);
  const [facing, setFacing] = useState<Facing>('environment');
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const [dims, setDims] = useState({ w: 16, h: 9 });
  const [quad, setQuad] = useState<Pt[] | null>(null);
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [multiCam, setMultiCam] = useState(false);

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLive(false);
    setError('');
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This browser cannot open the camera here. Use the photo picker below instead.');
        return;
      }
      try {
        stop();
        const s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 2560 }, height: { ideal: 1440 } },
          audio: false,
        });
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = s;
        const v = video.current!;
        v.srcObject = s;
        await v.play().catch(() => undefined);
        setLive(true);
        navigator.mediaDevices.enumerateDevices().then((ds) => setMultiCam(ds.filter((d) => d.kind === 'videoinput').length > 1)).catch(() => undefined);
      } catch (e) {
        const name = (e as DOMException)?.name;
        if (name === 'NotAllowedError' || name === 'SecurityError')
          setError('Camera access was denied. Allow the camera in your browser settings, or use the photo picker below.');
        else if (name === 'NotFoundError' || name === 'OverconstrainedError')
          setError('No camera was found on this device. Use the photo picker below instead.');
        else setError('The camera could not be started. Use the photo picker below instead.');
      }
    })();
    return () => {
      cancelled = true;
      stop();
    };
  }, [facing, stop]);

  // live edge overlay (low rate, small frame) once the engine is ready
  useEffect(() => {
    if (!live) return;
    let alive = true;
    loadCV().catch(() => undefined);
    const tick = async () => {
      const v = video.current;
      if (!alive || !v || !v.videoWidth) return;
      setDims({ w: v.videoWidth, h: v.videoHeight });
      if (cvReady() && !busy) {
        const sc = 360 / Math.max(v.videoWidth, v.videoHeight);
        const c = (small.current ??= document.createElement('canvas'));
        c.width = Math.round(v.videoWidth * sc);
        c.height = Math.round(v.videoHeight * sc);
        c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
        try {
          const r = await detectInCanvas(c);
          if (alive) setQuad(r.found ? r.corners : null);
        } catch {
          /* ignore frame errors */
        }
      }
    };
    const id = window.setInterval(tick, 500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [live, busy]);

  const shoot = async () => {
    const v = video.current;
    if (!v || !v.videoWidth || busy) return;
    setBusy(true);
    setFlash(true);
    setTimeout(() => setFlash(false), 140);
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d')!.drawImage(v, 0, 0);
      await onCapture(await canvasToBlob(c, 'image/jpeg', 0.95));
    } finally {
      setBusy(false);
    }
  };

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) onFiles(files);
  };

  return (
    <div className="screen camera">
      <div className="cam-stage">
        <video ref={video} playsInline muted autoPlay className={error ? 'hidden' : ''} />
        {quad && live && (
          <svg className="cam-overlay" viewBox={`0 0 ${dims.w} ${dims.h}`} preserveAspectRatio="xMidYMid meet">
            <polygon points={quad.map((p) => `${p.x * dims.w},${p.y * dims.h}`).join(' ')} />
          </svg>
        )}
        {flash && <div className="flash" />}
        {!live && !error && <div className="cam-msg">Starting camera…</div>}
        {error && (
          <div className="cam-msg err">
            <p>{error}</p>
            <button className="btn primary" onClick={() => nativeCam.current?.click()}>Take photo with camera app</button>
            <button className="btn" onClick={() => fileInput.current?.click()}>Choose from library</button>
          </div>
        )}
      </div>

      <header className="cam-top">
        <button className="round dark" onClick={onClose} aria-label="Close camera"><Close /></button>
        <span className="hint">{replacing ? 'Retake page' : live ? 'Fit the page in view' : ''}</span>
        {multiCam ? (
          <button className="round dark" onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))} aria-label="Switch camera"><Flip /></button>
        ) : <span className="round ghost" />}
      </header>

      <footer className="cam-bottom">
        <button className="round dark" onClick={() => fileInput.current?.click()} aria-label="Choose from library"><ImageIcon /></button>
        <button className="shutter" onClick={shoot} disabled={!live || busy} aria-label="Capture"><i /></button>
        {pageCount > 0 && !replacing ? (
          <button className="round done" onClick={onClose} aria-label={`Done, ${pageCount} pages`}>
            <Check /><b>{pageCount}</b>
          </button>
        ) : <span className="round ghost" />}
      </footer>

      <input ref={fileInput} type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" multiple={!replacing} hidden onChange={pick} />
      <input ref={nativeCam} type="file" accept="image/*" capture="environment" hidden onChange={pick} />
    </div>
  );
}

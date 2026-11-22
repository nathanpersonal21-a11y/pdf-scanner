/* eslint-disable @typescript-eslint/no-explicit-any */
import { setCV } from './cvcore';

let loading: Promise<any> | null = null;
let ready: any = null;

export const cvReady = () => ready;

/** Loads the self-hosted OpenCV.js (WASM) once. Cached by the service worker for offline use. */
export function loadCV(): Promise<any> {
  if (ready) return Promise.resolve(ready);
  if (loading) return loading;
  loading = new Promise<any>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('opencv.js', document.baseURI).href;
    s.async = true;
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not load the scanning engine. Check your connection and reload.'));
    };
    s.onload = async () => {
      try {
        let c: any = (window as any).cv;
        if (c && typeof c.then === 'function') c = await c;
        else if (!c || !c.Mat) await new Promise<void>((r) => { c.onRuntimeInitialized = () => r(); });
        ready = c;
        setCV(c);
        resolve(c);
      } catch (e) {
        loading = null;
        reject(e);
      }
    };
    document.head.appendChild(s);
  });
  return loading;
}

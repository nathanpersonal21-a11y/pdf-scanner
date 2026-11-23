/* eslint-disable @typescript-eslint/no-explicit-any */
import { applyFilter, detectQuad, removeFingers, rotateMat, toGrayInPlace, warpDocument } from './cvcore';
import { loadCV } from './cv';
import type { FilterId, OutputMode, Page, Pt } from './types';

const MAX_SOURCE = 3000;

// OpenCV work is synchronous; serialise it and yield between jobs so the UI can paint.
let chain: Promise<unknown> = Promise.resolve();
export function enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = chain.then(() => new Promise<void>((r) => setTimeout(r, 0))).then(fn);
  chain = run.catch(() => undefined);
  return run;
}

export function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This image could not be read. Try a JPG or PNG.'));
    };
    img.src = url;
  });
}

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/jpeg', q = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image.'))), type, q),
  );
}

/** Normalises a photo/file into a JPEG (EXIF rotation applied, max 3000 px) ready for storage. */
export async function makeSource(input: Blob): Promise<{ blob: Blob; w: number; h: number }> {
  const img = await blobToImage(input);
  const s = Math.min(1, MAX_SOURCE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * s));
  const h = Math.max(1, Math.round(img.naturalHeight * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { blob: await canvasToBlob(c, 'image/jpeg', 0.93), w, h };
}

async function blobToMat(blob: Blob): Promise<any> {
  const cv = await loadCV();
  const img = await blobToImage(blob);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return cv.imread(c);
}

function matToCanvas(cv: any, mat: any): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = mat.cols;
  c.height = mat.rows;
  cv.imshow(c, mat);
  return c;
}

/** Auto-detect the document corners in a stored source image. */
export function detectCorners(blob: Blob): Promise<{ corners: Pt[]; found: boolean }> {
  return enqueue(async () => {
    const cv = await loadCV();
    const src = await blobToMat(blob);
    try {
      return detectQuad(src);
    } finally {
      src.delete();
    }
  });
}

/** Same detection for a live video frame canvas (used for the camera overlay). */
export async function detectInCanvas(c: HTMLCanvasElement): Promise<{ corners: Pt[]; found: boolean }> {
  const cv = await loadCV();
  const src = cv.imread(c);
  try {
    return detectQuad(src);
  } finally {
    src.delete();
  }
}

export interface RenderOpts {
  maxSide?: number;
  mode?: OutputMode; // export colour mode override
  raw?: boolean; // "before" view: warp only, no enhancement / finger removal
  filter?: FilterId;
}

/** Full pipeline for one page: crop + perspective → fingers → filter → rotate. */
export function renderPage(page: Page, opts: RenderOpts = {}): Promise<HTMLCanvasElement> {
  return enqueue(async () => {
    const cv = await loadCV();
    const src = await blobToMat(page.blob);
    let cur: any = null;
    try {
      cur = warpDocument(src, page.corners, opts.maxSide ?? 2200, page.shape ?? 'auto');
      if (!opts.raw) {
        if (page.fingers) removeFingers(cur);
        const f: FilterId = opts.mode === 'bw' ? 'bw' : opts.filter ?? page.filter;
        const filtered = applyFilter(cur, f);
        cur.delete();
        cur = filtered;
        if (opts.mode === 'gray') toGrayInPlace(cur);
      }
      const rotated = rotateMat(cur, page.rotation);
      cur.delete();
      cur = rotated;
      return matToCanvas(cv, cur);
    } finally {
      src.delete();
      if (cur) cur.delete();
    }
  });
}

const cache = new Map<string, string>();
const keyOf = (p: Page, tag: string) =>
  [p.id, tag, p.filter, p.fingers, p.rotation, p.shape ?? 'auto', p.corners.map((c) => c.x.toFixed(4) + ',' + c.y.toFixed(4)).join(';')].join('|');

/** Cached object URL of a rendered page (preview or thumbnail). */
export async function previewUrl(page: Page, maxSide: number, raw = false): Promise<string> {
  const k = keyOf(page, `${maxSide}${raw ? 'raw' : ''}`);
  const hit = cache.get(k);
  if (hit) return hit;
  const canvas = await renderPage(page, { maxSide, raw });
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.85);
  const url = URL.createObjectURL(blob);
  if (cache.size > 80) {
    const first = cache.keys().next().value as string;
    URL.revokeObjectURL(cache.get(first)!);
    cache.delete(first);
  }
  cache.set(k, url);
  return url;
}

export function sourceUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
import { canvasToBlob, renderPage } from './image';
import type { OcrLine, OcrPage, OcrPara, Page } from './types';

// Text recognition runs fully on-device (Tesseract compiled to WASM, self-hosted, English).
let workerP: Promise<any> | null = null;
let progressCb: ((p: number) => void) | null = null;

export const ocrKey = (p: Page) =>
  [p.rotation, p.fingers, p.corners.map((c) => c.x.toFixed(3) + ',' + c.y.toFixed(3)).join(';')].join('|');

export const ocrFresh = (p: Page) => !!p.ocr && p.ocr.key === ocrKey(p);

function getWorker(): Promise<any> {
  if (!workerP) {
    workerP = (async () => {
      const { createWorker } = await import('tesseract.js');
      const base = new URL('ocr/', document.baseURI).href;
      const w = await createWorker('eng', 1, {
        workerPath: base + 'worker.min.js',
        corePath: base,
        langPath: base,
        workerBlobURL: false,
        gzip: true,
        cacheMethod: 'none',
        logger: (m: any) => {
          if (m.status === 'recognizing text' && progressCb) progressCb(m.progress);
        },
      });
      await w.setParameters({ preserve_interword_spaces: '0' });
      return w;
    })().catch((e) => {
      workerP = null;
      throw new Error('The reading engine could not be loaded. Check your connection once, then try again. (' + (e?.message ?? e) + ')');
    });
  }
  return workerP;
}

const ALLOWED = /[^\x20-\x7E -ÿ‘’“”–—•…€]/g;
export const clean = (s: string) => s.replace(ALLOWED, '').replace(/\s+/g, ' ').trim();

function median(a: number[]) {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)];
}

/** Reads one page (cropped, flattened, shadow-free) and returns paragraphs of clean text. */
export async function readPage(page: Page, onProgress?: (p: number) => void): Promise<OcrPage> {
  const canvas = await renderPage(page, { maxSide: 2000, filter: 'document' });
  const png = await canvasToBlob(canvas, 'image/png');
  const worker = await getWorker();
  progressCb = onProgress ?? null;
  let data: any;
  try {
    ({ data } = await worker.recognize(png, {}, { blocks: true }));
  } finally {
    progressCb = null;
  }
  const paras: OcrPara[] = [];
  let words = 0;
  for (const block of data.blocks ?? []) {
    const bt = String(block.blocktype ?? '');
    if (/IMAGE|HORZ_LINE|VERT_LINE|NOISE/i.test(bt)) continue;
    for (const para of block.paragraphs ?? []) {
      const lines: OcrLine[] = [];
      for (const ln of para.lines ?? []) {
        const ws = (ln.words ?? []).filter((w: any) => w.confidence >= 35 && /[A-Za-z0-9]/.test(w.text));
        const text = clean(ws.map((w: any) => w.text).join(' '));
        if (!text) continue;
        const sym = ws.flatMap((w: any) => (w.symbols ?? []).map((y: any) => y.bbox.y1 - y.bbox.y0)).filter((v: number) => v > 0);
        const h = sym.length ? sym.reduce((a: number, c: number) => a + c, 0) / sym.length : Math.max(1, ln.bbox.y1 - ln.bbox.y0);
        lines.push({ text, h, r: ln.rowAttributes?.rowHeight ?? 0 });
        words += ws.length;
      }
      if (lines.length) paras.push({ lines });
    }
  }
  const all = paras.flatMap((p) => p.lines);
  return { key: ocrKey(page), paras, medianH: median(all.map((l) => l.h)), medianR: median(all.map((l) => l.r).filter((v) => v > 0)), words };
}

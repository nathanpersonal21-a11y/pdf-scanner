import { PDFDocument } from 'pdf-lib';
import { canvasToBlob, renderPage } from './image';
import type { OutputMode, Page, PageSize } from './types';

const SIZES = { letter: [612, 792], a4: [595.28, 841.89] } as const;

export interface ExportOptions {
  name: string;
  size: PageSize;
  mode: OutputMode;
  onProgress?: (done: number, total: number) => void;
}

export function safeName(n: string): string {
  const base = n.trim().replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
  return (base || 'Scan') + '.pdf';
}

/** Renders every page at full quality and assembles one multi-page PDF, entirely in the browser. */
export async function exportPdf(pages: Page[], opts: ExportOptions): Promise<Uint8Array> {
  if (!pages.length) throw new Error('Add at least one page first.');
  const pdf = await PDFDocument.create();
  pdf.setTitle(opts.name);
  pdf.setProducer('DocScan');
  pdf.setCreator('DocScan');

  for (let i = 0; i < pages.length; i++) {
    opts.onProgress?.(i, pages.length);
    const canvas = await renderPage(pages[i], { maxSide: 2200, mode: opts.mode });
    const jpg = await canvasToBlob(canvas, 'image/jpeg', 0.9);
    const img = await pdf.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
    const landscape = canvas.width > canvas.height;
    let pw: number;
    let ph: number;
    if (opts.size === 'auto') {
      // assume ~200 dpi capture so the page size is natural for the scan
      pw = (canvas.width * 72) / 200;
      ph = (canvas.height * 72) / 200;
    } else {
      const [a, b] = SIZES[opts.size];
      pw = landscape ? b : a;
      ph = landscape ? a : b;
    }
    const page = pdf.addPage([pw, ph]);
    const s = Math.min(pw / img.width, ph / img.height);
    const w = img.width * s;
    const h = img.height * s;
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  opts.onProgress?.(pages.length, pages.length);
  return pdf.save();
}

export function pdfBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function canShareFile(file: File): boolean {
  const nav = navigator as unknown as { share?: unknown; canShare?: (d: ShareData) => boolean };
  return typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] });
}

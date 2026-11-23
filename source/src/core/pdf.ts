import { PDFDocument, rgb } from 'pdf-lib';
import { canvasToBlob, renderPage } from './image';
import { layout, loadFonts } from './typeset';
import type { OutputMode, Page, PageSize } from './types';

const SIZES = { letter: [612, 792], a4: [595.28, 841.89] } as const;

export interface ExportOptions {
  name: string;
  size: PageSize;
  mode: OutputMode;
  readable?: boolean; // re-typeset all pages as uniform text (needs page.ocr on every page)
  onProgress?: (done: number, total: number) => void;
}

export function safeName(n: string): string {
  const base = n.trim().replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
  return (base || 'Scan') + '.pdf';
}

async function addImagePage(pdf: PDFDocument, page: Page, size: PageSize, mode: OutputMode) {
  const canvas = await renderPage(page, { maxSide: 2200, mode });
  const jpg = await canvasToBlob(canvas, 'image/jpeg', 0.9);
  const img = await pdf.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
  const landscape = canvas.width > canvas.height;
  let pw: number;
  let ph: number;
  if (size === 'auto') {
    // assume ~200 dpi capture so the page size is natural for the scan
    pw = (canvas.width * 72) / 200;
    ph = (canvas.height * 72) / 200;
  } else {
    const [a, b] = SIZES[size];
    pw = landscape ? b : a;
    ph = landscape ? a : b;
  }
  const pg = pdf.addPage([pw, ph]);
  const s = Math.min(pw / img.width, ph / img.height);
  const w = img.width * s;
  const h = img.height * s;
  pg.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
}

/** Builds one multi-page PDF entirely in the browser: scanned images, or uniform re-typeset text. */
export async function exportPdf(pages: Page[], opts: ExportOptions): Promise<Uint8Array> {
  if (!pages.length) throw new Error('Add at least one page first.');
  const pdf = await PDFDocument.create();
  pdf.setTitle(opts.name);
  pdf.setProducer('DocScan');
  pdf.setCreator('DocScan');

  if (opts.readable) {
    const size: PageSize = opts.size === 'auto' ? 'letter' : opts.size;
    const fonts = await loadFonts(pdf);
    const laid = layout(pages, size, fonts);
    for (let i = 0; i < laid.length; i++) {
      opts.onProgress?.(i, laid.length);
      const lp = laid[i];
      if (lp.image) {
        await addImagePage(pdf, pages[lp.scan], size, 'gray');
        continue;
      }
      const pg = pdf.addPage([lp.width, lp.height]);
      for (const l of lp.lines)
        pg.drawText(l.text, { x: l.x, y: lp.height - l.top, size: l.size, font: l.bold ? fonts.bold : fonts.regular, color: rgb(0.07, 0.07, 0.07) });
    }
    opts.onProgress?.(laid.length, laid.length);
    return pdf.save();
  }

  for (let i = 0; i < pages.length; i++) {
    opts.onProgress?.(i, pages.length);
    await addImagePage(pdf, pages[i], opts.size, opts.mode);
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

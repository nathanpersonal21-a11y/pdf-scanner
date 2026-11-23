import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import type { OcrPage, Page, PageSize } from './types';

/** One uniform page style for every scan: same font, size, line spacing, margins and paragraph gaps. */
export const STYLE = { body: 11, leading: 1.5, paraGap: 8, margin: 64, h1: 1.5, h2: 1.25 };

export interface LaidLine {
  text: string;
  x: number;
  top: number; // baseline distance from the top of the page, in points
  size: number;
  bold: boolean;
}
export interface LaidPage {
  scan: number; // index of the scanned page this came from
  width: number;
  height: number;
  lines: LaidLine[];
  image?: boolean; // page had no readable text: fall back to the cleaned scan
}

export function dims(size: PageSize): [number, number] {
  return size === 'a4' ? [595.28, 841.89] : [612, 792];
}

export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  doc: PDFDocument;
}
export async function loadFonts(doc?: PDFDocument): Promise<Fonts> {
  const d = doc ?? (await PDFDocument.create());
  return { doc: d, regular: await d.embedFont(StandardFonts.Helvetica), bold: await d.embedFont(StandardFonts.HelveticaBold) };
}

function wrap(text: string, width: number, size: number, font: PDFFont): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.split(' ')) {
    const t = cur ? cur + ' ' + w : w;
    if (cur && font.widthOfTextAtSize(t, size) > width) {
      out.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) out.push(cur);
  return out;
}

/** Joins OCR lines of one paragraph into flowing text, repairing words hyphenated at line ends. */
function flow(lines: string[]): string {
  let s = '';
  for (const l of lines) {
    if (!s) s = l;
    else if (/[a-z]-$/.test(s) && /^[a-z]/.test(l)) s = s.slice(0, -1) + l;
    else s += ' ' + l;
  }
  return s;
}

/** Lays out all scanned pages with one consistent style. Pages without readable text become image pages. */
export function layout(pages: Page[], size: PageSize, fonts: Fonts): LaidPage[] {
  const [W, H] = dims(size);
  const { body, leading, paraGap, margin } = STYLE;
  const width = W - 2 * margin;
  const bottom = H - margin;
  const out: LaidPage[] = [];

  pages.forEach((pg, scan) => {
    const o: OcrPage | undefined = pg.ocr;
    if (!o || o.words < 4) {
      out.push({ scan, width: W, height: H, lines: [], image: true });
      return;
    }
    let cur: LaidPage = { scan, width: W, height: H, lines: [] };
    let y = margin;
    out.push(cur);
    const newPage = () => {
      cur = { scan, width: W, height: H, lines: [] };
      out.push(cur);
      y = margin;
    };

    const isHead = (l: { h: number; r: number }) =>
      o.medianH > 0 && l.h / o.medianH >= 1.35 && (!o.medianR || !l.r || l.r / o.medianR >= 1.12);

    // split every OCR paragraph into runs of heading lines and body lines
    const blocks: { lines: typeof o.paras[number]['lines']; head: boolean }[] = [];
    for (const p of o.paras) {
      let run: typeof p.lines = [];
      for (const l of p.lines) {
        if (run.length && isHead(l) !== isHead(run[0])) {
          blocks.push({ lines: run, head: isHead(run[0]) });
          run = [];
        }
        run.push(l);
      }
      if (run.length) blocks.push({ lines: run, head: isHead(run[0]) });
    }

    for (const blk of blocks) {
      const text = flow(blk.lines.map((l) => l.text));
      const avgH = blk.lines.reduce((s, l) => s + l.h, 0) / blk.lines.length;
      const ratio = o.medianH ? avgH / o.medianH : 1;
      const heading = blk.head && text.length <= 140 && blk.lines.length <= 3;
      const size2 = heading ? body * (ratio >= 1.8 ? STYLE.h1 : STYLE.h2) : body;
      const font = heading ? fonts.bold : fonts.regular;
      const rows = wrap(text, width, size2, font);
      const lh = size2 * leading;
      // keep a heading together with the first lines that follow it
      const need = heading ? lh * Math.min(rows.length + 2, 3) : lh * Math.min(rows.length, 2);
      if (y + need > bottom && y > margin) newPage();
      if (heading && y > margin) y += paraGap * 0.6;
      for (const r of rows) {
        if (y + lh > bottom) newPage();
        cur.lines.push({ text: r, x: margin, top: y + size2 * 1.05, size: size2, bold: heading });
        y += lh;
      }
      y += paraGap;
    }
  });
  return out;
}

/** Draws a laid-out page on a canvas (used for the in-app preview). */
export function paint(lp: LaidPage, scale = 2): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(lp.width * scale);
  c.height = Math.round(lp.height * scale);
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#111';
  g.textBaseline = 'alphabetic';
  for (const l of lp.lines) {
    g.font = `${l.bold ? '700 ' : ''}${l.size * scale}px Helvetica, Arial, "Liberation Sans", sans-serif`;
    g.fillText(l.text, l.x * scale, l.top * scale);
  }
  return c;
}

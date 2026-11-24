import type { FilterId, Pt } from './cvcore';

export type { FilterId, Pt };
export type OutputMode = 'color' | 'gray' | 'bw';
export type PageSize = 'letter' | 'a4' | 'auto';

export interface Page {
  id: string;
  blob: Blob; // original photo, EXIF orientation baked in, max 3000px
  w: number;
  h: number;
  corners: Pt[]; // normalised TL, TR, BR, BL
  rotation: number; // 0 | 90 | 180 | 270, clockwise
  filter: FilterId;
  fingers: boolean; // remove fingers touching the page edge
  ocr?: OcrPage; // cached text recognition (readable mode)
}

export interface OcrLine {
  text: string;
  h: number; // mean glyph height in px (font-size proxy)
  r: number; // Tesseract row height estimate
}
export interface OcrPara {
  lines: OcrLine[];
}
export interface OcrPage {
  key: string; // identifies the page geometry this was read from
  paras: OcrPara[];
  medianH: number;
  medianR: number;
  words: number;
}

export interface Doc {
  id: string;
  name: string;
  updated: number;
  pages: Page[];
  thumb?: Blob;
  readable?: boolean; // re-typeset all pages as uniform text
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const FILTERS: { id: FilterId; label: string }[] = [
  { id: 'original', label: 'Original' },
  { id: 'document', label: 'Document' },
  { id: 'bw', label: 'Black & White' },
  { id: 'gray', label: 'Grayscale' },
  { id: 'color', label: 'Enhanced Color' },
];

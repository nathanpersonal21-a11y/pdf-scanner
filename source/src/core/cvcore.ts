/* eslint-disable @typescript-eslint/no-explicit-any */
// Pure OpenCV.js image-processing core. No DOM access, so it runs in the browser and in Node tests.
// All functions take/return cv.Mat objects (RGBA, 8-bit) and never leak intermediate Mats.

export type Pt = { x: number; y: number };
export type FilterId = 'original' | 'bw' | 'gray' | 'color' | 'document';

let cv: any;
export function setCV(c: any) {
  cv = c;
}

// ---------- helpers ----------

function tracker() {
  const list: any[] = [];
  const t = <T>(m: T): T => {
    list.push(m);
    return m;
  };
  const free = () => {
    for (const m of list) {
      try {
        if (m && !m.isDeleted()) m.delete();
      } catch {
        /* already freed */
      }
    }
    list.length = 0;
  };
  return { t, free };
}

export function orderCorners(pts: Pt[]): Pt[] {
  // TL, TR, BR, BL
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const tl = bySum[0];
  const br = bySum[3];
  const byDiff = [...pts].sort((a, b) => a.y - a.x - (b.y - b.x));
  const tr = byDiff[0];
  const bl = byDiff[3];
  return [tl, tr, br, bl];
}

function polyArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return Math.abs(a) / 2;
}

function anglesOk(p: Pt[]): boolean {
  for (let i = 0; i < 4; i++) {
    const a = p[(i + 3) % 4];
    const b = p[i];
    const c = p[(i + 1) % 4];
    const v1 = { x: a.x - b.x, y: a.y - b.y };
    const v2 = { x: c.x - b.x, y: c.y - b.y };
    const d = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
    const ang = (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
    if (ang < 45 || ang > 135) return false;
  }
  return true;
}

function dist(a: Pt, b: Pt) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ---------- skin / finger detection ----------

/** Binary mask (8UC1, 255 = skin) of skin-coloured pixels in an RGBA/RGB Mat. */
function skinMaskRaw(rgba: any, T: ReturnType<typeof tracker>): any {
  const rgb = T.t(new cv.Mat());
  cv.cvtColor(rgba, rgb, rgba.channels() === 4 ? cv.COLOR_RGBA2RGB : cv.COLOR_RGB2RGB);
  const ycc = T.t(new cv.Mat());
  cv.cvtColor(rgb, ycc, cv.COLOR_RGB2YCrCb);
  const lo = T.t(new cv.Mat(ycc.rows, ycc.cols, ycc.type(), new cv.Scalar(85, 138, 80, 0)));
  const hi = T.t(new cv.Mat(ycc.rows, ycc.cols, ycc.type(), new cv.Scalar(255, 175, 124, 255)));
  const mask = T.t(new cv.Mat());
  cv.inRange(ycc, lo, hi, mask);
  // also require some warmth in RGB (R > G > B) to cut false positives on grey/blue stuff
  const k = T.t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
  cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k);
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k);
  return mask;
}

/**
 * Keeps only skin blobs that touch the image border (a finger holding the page enters from outside)
 * and are a plausible size. Returns a new 8UC1 mask at the input resolution.
 */
function fingerMaskSmall(small: any, T: ReturnType<typeof tracker>, minFrac = 0.002, maxFrac = 0.3): any {
  const raw = skinMaskRaw(small, T);
  const labels = T.t(new cv.Mat());
  const stats = T.t(new cv.Mat());
  const cent = T.t(new cv.Mat());
  const n = cv.connectedComponentsWithStats(raw, labels, stats, cent, 8, cv.CV_32S);
  const W = raw.cols;
  const H = raw.rows;
  const total = W * H;
  const keep = new Uint8Array(n);
  const m = 3;
  for (let i = 1; i < n; i++) {
    const l = stats.data32S[i * 5];
    const t = stats.data32S[i * 5 + 1];
    const w = stats.data32S[i * 5 + 2];
    const h = stats.data32S[i * 5 + 3];
    const a = stats.data32S[i * 5 + 4];
    const touches = l <= m || t <= m || l + w >= W - m || t + h >= H - m;
    if (touches && a >= total * minFrac && a <= total * maxFrac) keep[i] = 1;
  }
  const out = new Uint8Array(total);
  const lab = labels.data32S;
  for (let p = 0; p < total; p++) if (keep[lab[p]]) out[p] = 255;
  return T.t(cv.matFromArray(H, W, cv.CV_8UC1, Array.from(out)));
}

// ---------- document detection ----------

type Cand = { quad: Pt[]; score: number };

function lineIntersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const d1 = { x: a2.x - a1.x, y: a2.y - a1.y };
  const d2 = { x: b2.x - b1.x, y: b2.y - b1.y };
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < 1e-6 * (Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y))) return null;
  const t = ((b1.x - a1.x) * d2.y - (b1.y - a1.y) * d2.x) / den;
  return { x: a1.x + t * d1.x, y: a1.y + t * d1.y };
}

/** Rebuilds a quad from the 4 longest sides of a polygon (recovers corners hidden under fingers). */
function quadFromLongestEdges(poly: Pt[], W: number, H: number): Pt[] | null {
  const n = poly.length;
  if (n < 4) return null;
  const edges = poly.map((p, i) => ({ i, len: dist(p, poly[(i + 1) % n]) }));
  const top = [...edges].sort((a, b) => b.len - a.len).slice(0, 4).sort((a, b) => a.i - b.i);
  const pts: Pt[] = [];
  for (let k = 0; k < 4; k++) {
    const e1 = top[k];
    const e2 = top[(k + 1) % 4];
    const p = lineIntersect(poly[e1.i], poly[(e1.i + 1) % n], poly[e2.i], poly[(e2.i + 1) % n]);
    if (!p) return null;
    if (p.x < -0.25 * W || p.x > 1.25 * W || p.y < -0.25 * H || p.y > 1.25 * H) return null;
    pts.push(p);
  }
  return orderCorners(pts);
}

function reduceToQuad(hull: any, W: number, H: number, T: ReturnType<typeof tracker>): Pt[] | null {
  const peri = cv.arcLength(hull, true);
  {
    const approx = T.t(new cv.Mat());
    cv.approxPolyDP(hull, approx, 0.012 * peri, true);
    const d = approx.data32S;
    const poly: Pt[] = [];
    for (let i = 0; i < approx.rows; i++) poly.push({ x: d[i * 2], y: d[i * 2 + 1] });
    if (poly.length === 4) return orderCorners(poly);
    if (poly.length > 4 && poly.length <= 12) {
      const q = quadFromLongestEdges(poly, W, H);
      if (q && anglesOk(q)) return q;
    }
  }
  for (const e of [0.02, 0.03, 0.04, 0.05, 0.07, 0.1]) {
    const approx = T.t(new cv.Mat());
    cv.approxPolyDP(hull, approx, e * peri, true);
    if (approx.rows === 4) {
      const d = approx.data32S;
      return orderCorners([0, 1, 2, 3].map((i) => ({ x: d[i * 2], y: d[i * 2 + 1] })));
    }
    if (approx.rows < 4) break;
  }
  try {
    const r = cv.minAreaRect(hull);
    const pts = cv.RotatedRect.points(r) as Pt[];
    return orderCorners(pts.map((p) => ({ x: p.x, y: p.y })));
  } catch {
    return null;
  }
}

function candidatesFromMask(mask: any, W: number, H: number, T: ReturnType<typeof tracker>, mode: number): Cand[] {
  const contours = T.t(new cv.MatVector());
  const hier = T.t(new cv.Mat());
  cv.findContours(mask, contours, hier, mode, cv.CHAIN_APPROX_SIMPLE);
  const imgArea = W * H;
  const list: Cand[] = [];
  for (let i = 0; i < contours.size(); i++) {
    const cnt = T.t(contours.get(i));
    const ca = cv.contourArea(cnt);
    if (ca < imgArea * 0.1) continue;
    const hull = T.t(new cv.Mat());
    cv.convexHull(cnt, hull, false, true);
    const ha = cv.contourArea(hull);
    const quad = reduceToQuad(hull, W, H, T);
    if (!quad) continue;
    const qa = polyArea(quad);
    if (qa < imgArea * 0.1 || !anglesOk(quad)) continue;
    const frac = qa / imgArea;
    const fit = Math.min(ha, qa) / Math.max(ha, qa);
    let score = Math.pow(frac, 0.8) * Math.pow(fit, 4);
    const nearBorder = quad.filter((p) => p.x < 3 || p.y < 3 || p.x > W - 4 || p.y > H - 4).length;
    if (frac > 0.96 || nearBorder >= 3) score *= 0.35;
    list.push({ quad, score });
  }
  return list;
}


// ---------- sub-pixel corner refinement ----------

function median(a: number[]): number {
  const b = [...a].sort((x, y) => x - y);
  return b.length ? b[Math.floor(b.length / 2)] : 0;
}

/** Robust total-least-squares line through points (iteratively drops outliers). */
function fitLineRobust(pts: Pt[]): { p: Pt; d: Pt } | null {
  let use = pts;
  let line: { p: Pt; d: Pt } | null = null;
  for (let it = 0; it < 4; it++) {
    if (use.length < 8) return line;
    const mx = use.reduce((s, q) => s + q.x, 0) / use.length;
    const my = use.reduce((s, q) => s + q.y, 0) / use.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const q of use) {
      sxx += (q.x - mx) ** 2;
      syy += (q.y - my) ** 2;
      sxy += (q.x - mx) * (q.y - my);
    }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const d = { x: Math.cos(ang), y: Math.sin(ang) };
    line = { p: { x: mx, y: my }, d };
    const res = pts.map((q) => Math.abs((q.x - mx) * -d.y + (q.y - my) * d.x));
    const thr = Math.max(1.2, 2.5 * median(res));
    use = pts.filter((_, i) => res[i] <= thr);
  }
  return line;
}

/**
 * Snaps a rough quad (source pixels) onto the true paper edges: for each side, finds the strongest
 * brightness edge along many perpendicular profiles and fits a line, then intersects the 4 lines.
 */
function refineQuad(src: any, quad: Pt[], T: ReturnType<typeof tracker>): Pt[] | null {
  const sc = Math.min(1, 1400 / Math.max(src.cols, src.rows));
  const g = T.t(new cv.Mat());
  cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY);
  if (sc < 1) cv.resize(g, g, new cv.Size(Math.round(src.cols * sc), Math.round(src.rows * sc)), 0, 0, cv.INTER_AREA);
  cv.GaussianBlur(g, g, new cv.Size(5, 5), 1.4, 1.4, cv.BORDER_REPLICATE);
  const W = g.cols;
  const H = g.rows;
  const d8 = g.data as Uint8Array;
  const at = (x: number, y: number) => {
    if (x < 0 || y < 0 || x > W - 1.01 || y > H - 1.01) return -1;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const i = y0 * W + x0;
    return d8[i] * (1 - fx) * (1 - fy) + d8[i + 1] * fx * (1 - fy) + d8[i + W] * (1 - fx) * fy + d8[i + W + 1] * fx * fy;
  };
  const q = quad.map((p) => ({ x: p.x * sc, y: p.y * sc }));
  const lines: ({ p: Pt; d: Pt } | null)[] = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const len = dist(a, b);
    const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const nrm = { x: -dir.y, y: dir.x };
    const band = Math.min(40, Math.max(6, 0.04 * len));
    type S = { pos: Pt; sign: number; mag: number };
    const peaks: S[] = [];
    for (let k = 0; k < 36; k++) {
      const t = 0.08 + (0.84 * k) / 35;
      const base = { x: a.x + dir.x * len * t, y: a.y + dir.y * len * t };
      let best: S | null = null;
      for (let o = -band; o <= band; o += 0.5) {
        const v1 = at(base.x + nrm.x * (o + 2), base.y + nrm.y * (o + 2));
        const v0 = at(base.x + nrm.x * (o - 2), base.y + nrm.y * (o - 2));
        if (v1 < 0 || v0 < 0) continue;
        const gr = v1 - v0;
        if (!best || Math.abs(gr) > best.mag) best = { pos: { x: base.x + nrm.x * o, y: base.y + nrm.y * o }, sign: Math.sign(gr), mag: Math.abs(gr) };
      }
      if (best && best.mag >= 8) peaks.push(best);
    }
    if (peaks.length < 10) {
      lines.push(null);
      continue;
    }
    // all samples of one side must agree on edge polarity (paper bright→desk dark or vice versa)
    const pos = peaks.filter((s) => s.sign > 0).length;
    const sign = pos >= peaks.length / 2 ? 1 : -1;
    const pts = peaks.filter((s) => s.sign === sign).map((s) => s.pos);
    lines.push(fitLineRobust(pts));
  }
  const L = lines.map((l, i) => l ?? { p: q[i], d: { x: q[(i + 1) % 4].x - q[i].x, y: q[(i + 1) % 4].y - q[i].y } });
  if (lines.filter(Boolean).length < 2) return null;
  const out: Pt[] = [];
  const maxMove = 0.07 * Math.max(W, H);
  for (let i = 0; i < 4; i++) {
    const A = L[(i + 3) % 4];
    const B = L[i];
    const c = lineIntersect(A.p, { x: A.p.x + A.d.x, y: A.p.y + A.d.y }, B.p, { x: B.p.x + B.d.x, y: B.p.y + B.d.y });
    if (!c || dist(c, q[i]) > maxMove) return null;
    out.push(c);
  }
  if (!anglesOk(out)) return null;
  return out.map((p) => ({ x: p.x / sc, y: p.y / sc }));
}

export interface DetectResult {
  corners: Pt[]; // normalised 0..1, TL TR BR BL
  found: boolean;
}

/** Finds the paper quadrilateral in an RGBA Mat. */
export function detectQuad(src: any): DetectResult {
  const T = tracker();
  try {
    const scale = Math.min(1, 640 / Math.max(src.cols, src.rows));
    const small = T.t(new cv.Mat());
    cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
    const W = small.cols;
    const H = small.rows;

    const gray = T.t(new cv.Mat());
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    const blur = T.t(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(7, 7), 0, 0, cv.BORDER_DEFAULT);

    const fingers = fingerMaskSmall(small, T);
    const fingersD = T.t(new cv.Mat());
    cv.dilate(fingers, fingersD, T.t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9))));
    const notFinger = T.t(new cv.Mat());
    cv.bitwise_not(fingersD, notFinger);

    const cands: Cand[] = [];

    // A) bright, low-saturation "paper" mask (Otsu on brightness), fingers removed
    {
      const th = T.t(new cv.Mat());
      cv.threshold(blur, th, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      cv.bitwise_and(th, notFinger, th);
      const k = T.t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(11, 11)));
      cv.morphologyEx(th, th, cv.MORPH_OPEN, k);
      cv.morphologyEx(th, th, cv.MORPH_CLOSE, T.t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(21, 21))));
      cands.push(...candidatesFromMask(th, W, H, T, cv.RETR_EXTERNAL));
    }

    // B) adaptive-brightness mask: pixels brighter than a heavily blurred local average
    {
      const bigBlur = T.t(new cv.Mat());
      const kk = Math.max(31, (Math.round(Math.min(W, H) / 3) | 1));
      cv.GaussianBlur(gray, bigBlur, new cv.Size(kk, kk), 0, 0, cv.BORDER_DEFAULT);
      const diff = T.t(new cv.Mat());
      cv.subtract(blur, bigBlur, diff);
      const th = T.t(new cv.Mat());
      cv.threshold(diff, th, 8, 255, cv.THRESH_BINARY);
      cv.bitwise_and(th, notFinger, th);
      cv.morphologyEx(th, th, cv.MORPH_CLOSE, T.t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(21, 21))));
      cv.morphologyEx(th, th, cv.MORPH_OPEN, T.t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9))));
      cands.push(...candidatesFromMask(th, W, H, T, cv.RETR_EXTERNAL));
    }

    // C) edge-based
    {
      const edges = T.t(new cv.Mat());
      const mean = cv.mean(blur)[0];
      cv.Canny(blur, edges, Math.max(10, mean * 0.4), Math.max(40, mean * 0.9));
      cv.bitwise_and(edges, notFinger, edges);
      cv.dilate(edges, edges, T.t(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))), new cv.Point(-1, -1), 2);
      cands.push(...candidatesFromMask(edges, W, H, T, cv.RETR_LIST).map((c) => ({ ...c, score: c.score * 0.85 })));
    }

    cands.sort((a, b) => b.score - a.score);
    const best = cands[0];
    if (best && best.score > 0.15) {
      const rough = best.quad.map((p) => ({ x: (p.x / W) * src.cols, y: (p.y / H) * src.rows }));
      const fine = refineQuad(src, rough, T) ?? rough;
      return {
        corners: fine.map((p) => ({
          x: Math.min(1, Math.max(0, p.x / src.cols)),
          y: Math.min(1, Math.max(0, p.y / src.rows)),
        })),
        found: true,
      };
    }
    const m = 0.06;
    return {
      corners: [
        { x: m, y: m },
        { x: 1 - m, y: m },
        { x: 1 - m, y: 1 - m },
        { x: m, y: 1 - m },
      ],
      found: false,
    };
  } finally {
    T.free();
  }
}

// ---------- perspective correction ----------

/**
 * Estimates the real width/height ratio of a rectangle seen in perspective (Zhang & He, 2007),
 * assuming square pixels and the principal point at the image centre.
 * Returns null when the geometry is degenerate (e.g. a straight-on photo).
 */
export function estimateAspect(p: Pt[], imgW: number, imgH: number): number | null {
  const u0 = imgW / 2;
  const v0 = imgH / 2;
  const m1 = [p[0].x - u0, p[0].y - v0, 1]; // TL
  const m2 = [p[1].x - u0, p[1].y - v0, 1]; // TR
  const m3 = [p[3].x - u0, p[3].y - v0, 1]; // BL
  const m4 = [p[2].x - u0, p[2].y - v0, 1]; // BR
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k2d = dot(cross(m2, m4), m3);
  const k3d = dot(cross(m3, m4), m2);
  if (Math.abs(k2d) < 1e-9 || Math.abs(k3d) < 1e-9) return null;
  const k2 = dot(cross(m1, m4), m3) / k2d;
  const k3 = dot(cross(m1, m4), m2) / k3d;
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  // With the principal point at the origin: f^2 = -(n2x*n3x + n2y*n3y) / (n2z*n3z)
  if (Math.abs(n2[2] * n3[2]) < 1e-9) return null;
  const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
  if (!(f2 > 0) || !isFinite(f2)) return null;
  const q = (n: number[]) => (n[0] * n[0] + n[1] * n[1]) / f2 + n[2] * n[2];
  const r2 = q(n2) / q(n3);
  if (!(r2 > 0) || !isFinite(r2)) return null;
  const r = Math.sqrt(r2);
  return r > 0.2 && r < 5 ? r : null;
}


/** Snaps a width/height ratio to Letter / A4 / Legal (either orientation) when it is within `tol`. */
export function snapPaper(r: number, tol: number): number | null {
  const std = [8.5 / 11, 210 / 297, 8.5 / 14];
  const portrait = r < 1;
  const v = portrait ? r : 1 / r;
  let best: number | null = null;
  let bd = tol;
  for (const s of std) {
    const d = Math.abs(s / v - 1);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  if (best === null) return r > 0.2 && r < 5 ? r : null; // not a standard size: trust the estimate
  return portrait ? best : 1 / best;
}

/** Warps the quad (normalised corners) of `src` into a flat rectangle of the correct proportions. */
export type PageShape = 'auto' | 'letter' | 'a4' | 'free';

export function warpDocument(src: any, cornersN: Pt[], maxSide = 2200, shape: PageShape = 'auto'): any {
  const T = tracker();
  try {
    const p = cornersN.map((c) => ({ x: c.x * src.cols, y: c.y * src.rows }));
    const [tl, tr, br, bl] = p;
    let w = Math.max(dist(tl, tr), dist(bl, br));
    let h = Math.max(dist(tl, bl), dist(tr, br));
    const est = estimateAspect(p, src.cols, src.rows);
    const naive = w / h;
    let ratio: number | null;
    if (shape === 'free') ratio = null;
    else if (shape === 'letter' || shape === 'a4') {
      const std = shape === 'letter' ? 8.5 / 11 : 210 / 297;
      ratio = (est ?? naive) > 1 ? 1 / std : std;
    } else ratio = snapPaper(est ?? naive, est ? 0.075 : 0.04);
    if (ratio) {
      // keep the longer measured side, derive the other from the (snapped) true aspect ratio
      if (w / h > ratio) w = h * ratio;
      else h = w / ratio;
    }
    const s = Math.min(1, maxSide / Math.max(w, h));
    w = Math.max(16, Math.round(w * s));
    h = Math.max(16, Math.round(h * s));
    const srcTri = T.t(cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]));
    const dstTri = T.t(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w - 1, 0, w - 1, h - 1, 0, h - 1]));
    const M = T.t(cv.getPerspectiveTransform(srcTri, dstTri));
    const out = new cv.Mat();
    cv.warpPerspective(src, out, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    return out;
  } finally {
    T.free();
  }
}

// ---------- finger removal on the flattened page ----------

/** Replaces masked pixels (small-scale mask) with inpainted surroundings, feathered. Mutates `mat`. */
function blendInpaint(mat: any, small: any, fm: any, T: ReturnType<typeof tracker>, radius = 6) {
  const rgb = T.t(new cv.Mat());
  cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
  const painted = T.t(new cv.Mat());
  cv.inpaint(rgb, fm, painted, radius, cv.INPAINT_TELEA);
  const paintedA = T.t(new cv.Mat());
  cv.cvtColor(painted, paintedA, cv.COLOR_RGB2RGBA);

  const big = T.t(new cv.Mat());
  cv.resize(paintedA, big, new cv.Size(mat.cols, mat.rows), 0, 0, cv.INTER_LINEAR);
  const maskBig = T.t(new cv.Mat());
  cv.resize(fm, maskBig, new cv.Size(mat.cols, mat.rows), 0, 0, cv.INTER_LINEAR);
  cv.GaussianBlur(maskBig, maskBig, new cv.Size(15, 15), 0, 0, cv.BORDER_DEFAULT);
  const alpha = T.t(new cv.Mat());
  maskBig.convertTo(alpha, cv.CV_32F, 1 / 255);
  const alpha4 = T.t(new cv.Mat());
  const av = T.t(new cv.MatVector());
  for (let i = 0; i < 4; i++) av.push_back(alpha);
  cv.merge(av, alpha4);

  const a32 = T.t(new cv.Mat());
  const b32 = T.t(new cv.Mat());
  mat.convertTo(a32, cv.CV_32F);
  big.convertTo(b32, cv.CV_32F);
  const diff = T.t(new cv.Mat());
  cv.subtract(b32, a32, diff);
  cv.multiply(diff, alpha4, diff);
  cv.add(a32, diff, a32);
  a32.convertTo(mat, cv.CV_8U);
}

function smallOf(mat: any, T: ReturnType<typeof tracker>, side = 500) {
  const scale = Math.min(1, side / Math.max(mat.cols, mat.rows));
  const small = T.t(new cv.Mat());
  cv.resize(mat, small, new cv.Size(Math.max(8, Math.round(mat.cols * scale)), Math.max(8, Math.round(mat.rows * scale))), 0, 0, cv.INTER_AREA);
  return small;
}

/** Paints over finger blobs that overlap the page edges. Mutates and returns `mat`. */
export function removeFingers(mat: any): any {
  const T = tracker();
  try {
    const small = smallOf(mat, T);
    const fm = fingerMaskSmall(small, T, 0.0015, 0.35);
    if (cv.countNonZero(fm) === 0) return mat;
    cv.dilate(fm, fm, T.t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(17, 17))));
    blendInpaint(mat, small, fm, T, 6);
    return mat;
  } finally {
    T.free();
  }
}

// ---------- enhancement ----------

/** Estimates the illumination (paper colour incl. shadows) of a gray image, same size as input. */
function illumination(gray: any, T: ReturnType<typeof tracker>): any {
  const scale = Math.min(1, 560 / Math.max(gray.cols, gray.rows));
  const sw = Math.max(8, Math.round(gray.cols * scale));
  const sh = Math.max(8, Math.round(gray.rows * scale));
  const small = T.t(new cv.Mat());
  cv.resize(gray, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
  // 1) remove dark text with a grey-level closing (dilate then erode keeps shadow edges in place)
  const k = Math.max(7, Math.round(Math.max(sw, sh) / 60)) | 1;
  const ker = T.t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
  cv.morphologyEx(small, small, cv.MORPH_CLOSE, ker);
  // 2) edge-aware smoothing: median removes specks, bilateral keeps hard shadow borders
  cv.medianBlur(small, small, 2 * Math.floor(k / 2) + 1);
  const bi = T.t(new cv.Mat());
  cv.bilateralFilter(small, bi, 9, 18, 9, cv.BORDER_REPLICATE);
  cv.GaussianBlur(bi, bi, new cv.Size(5, 5), 0, 0, cv.BORDER_REPLICATE);
  const bg = T.t(new cv.Mat());
  cv.resize(bi, bg, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_LINEAR);
  return bg;
}

/**
 * Brings back text that glare or hard shadows have washed out. Where a local neighbourhood holds
 * faint-but-real ink (small yet non-zero range), the range is stretched to full contrast; clean
 * regions and blank paper are left alone so noise is not amplified.
 */
function recoverContrast(norm: any, T: ReturnType<typeof tracker>): any {
  const scale = Math.min(1, 700 / Math.max(norm.cols, norm.rows));
  const sw = Math.max(8, Math.round(norm.cols * scale));
  const sh = Math.max(8, Math.round(norm.rows * scale));
  const small = T.t(new cv.Mat());
  cv.resize(norm, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
  const k = Math.max(9, Math.round(Math.max(sw, sh) / 55)) | 1;
  const ker = T.t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
  const lo = T.t(new cv.Mat());
  const hi = T.t(new cv.Mat());
  cv.erode(small, lo, ker);
  cv.dilate(small, hi, ker);
  const g = 2 * k + 1;
  cv.GaussianBlur(lo, lo, new cv.Size(g, g), 0, 0, cv.BORDER_REPLICATE);
  cv.GaussianBlur(hi, hi, new cv.Size(g, g), 0, 0, cv.BORDER_REPLICATE);
  const n = sw * sh;
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  const l8 = lo.data as Uint8Array;
  const h8 = hi.data as Uint8Array;
  for (let i = 0; i < n; i++) {
    const range = Math.max(1, h8[i] - l8[i]);
    // weight: 0 for blank paper (<10) and for healthy contrast (>110), ramping in between
    const up = Math.min(1, Math.max(0, (range - 14) / 10));
    const down = Math.min(1, Math.max(0, (110 - range) / 50));
    const w = up * down;
    const a = 235 / range;
    const b = (-235 * l8[i]) / range + 10;
    // paper (hi) maps to 245, ink (lo) to 10
    A[i] = 1 + w * (a - 1);
    B[i] = w * b;
  }
  const aS = T.t(cv.matFromArray(sh, sw, cv.CV_32F, Array.from(A)));
  const bS = T.t(cv.matFromArray(sh, sw, cv.CV_32F, Array.from(B)));
  const aB = T.t(new cv.Mat());
  const bB = T.t(new cv.Mat());
  cv.resize(aS, aB, new cv.Size(norm.cols, norm.rows), 0, 0, cv.INTER_LINEAR);
  cv.resize(bS, bB, new cv.Size(norm.cols, norm.rows), 0, 0, cv.INTER_LINEAR);
  const v = T.t(new cv.Mat());
  norm.convertTo(v, cv.CV_32F);
  cv.multiply(v, aB, v);
  cv.add(v, bB, v);
  const out = T.t(new cv.Mat());
  v.convertTo(out, cv.CV_8U);
  return out;
}

function normalizedGray(rgba: any, T: ReturnType<typeof tracker>): any {
  const gray = T.t(new cv.Mat());
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  const bg = illumination(gray, T);
  const norm = T.t(new cv.Mat());
  cv.divide(gray, bg, norm, 255, cv.CV_8U);
  return recoverContrast(norm, T);
}

function grayToRGBA(gray: any): any {
  const out = new cv.Mat();
  cv.cvtColor(gray, out, cv.COLOR_GRAY2RGBA);
  return out;
}

/** Applies an enhancement filter. Returns a NEW RGBA Mat; `src` is untouched. */
export function applyFilter(src: any, filter: FilterId): any {
  const T = tracker();
  try {
    switch (filter) {
      case 'original':
        return src.clone();
      case 'gray': {
        const g = T.t(new cv.Mat());
        cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY);
        return grayToRGBA(g);
      }
      case 'color': {
        // divide each channel by the paper illumination, then boost contrast a little
        const gray = T.t(new cv.Mat());
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        const bg = illumination(gray, T);
        const rgb = T.t(new cv.Mat());
        cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
        const bgv = T.t(new cv.MatVector());
        for (let i = 0; i < 3; i++) bgv.push_back(bg);
        const bg3 = T.t(new cv.Mat());
        cv.merge(bgv, bg3);
        const norm = T.t(new cv.Mat());
        cv.divide(rgb, bg3, norm, 245, cv.CV_8U);
        const out = T.t(new cv.Mat());
        cv.convertScaleAbs(norm, out, 1.18, -14);
        const outA = new cv.Mat();
        cv.cvtColor(out, outA, cv.COLOR_RGB2RGBA);
        return outA;
      }
      case 'document': {
        const norm = normalizedGray(src, T);
        const lev = T.t(new cv.Mat());
        const a = 255 / (228 - 70);
        cv.convertScaleAbs(norm, lev, a, -70 * a);
        const blur = T.t(new cv.Mat());
        cv.GaussianBlur(lev, blur, new cv.Size(0, 0), 1.3, 1.3, cv.BORDER_DEFAULT);
        const sharp = T.t(new cv.Mat());
        cv.addWeighted(lev, 1.7, blur, -0.7, 0, sharp);
        return grayToRGBA(sharp);
      }
      case 'bw': {
        const norm = normalizedGray(src, T);
        const sm = T.t(new cv.Mat());
        cv.GaussianBlur(norm, sm, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
        const block = (Math.max(15, Math.round(Math.min(src.cols, src.rows) / 40)) | 1);
        const bw = T.t(new cv.Mat());
        cv.adaptiveThreshold(sm, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 12);
        return grayToRGBA(bw);
      }
    }
    return src.clone();
  } finally {
    T.free();
  }
}

/** Rotates by 0/90/180/270 degrees clockwise. Returns a NEW Mat. */
export function rotateMat(src: any, deg: number): any {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return src.clone();
  const out = new cv.Mat();
  const code = d === 90 ? cv.ROTATE_90_CLOCKWISE : d === 180 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE;
  cv.rotate(src, out, code);
  return out;
}

/** Converts an RGBA Mat to grayscale RGBA (for grayscale export). Mutates and returns it. */
export function toGrayInPlace(mat: any): any {
  const g = new cv.Mat();
  cv.cvtColor(mat, g, cv.COLOR_RGBA2GRAY);
  cv.cvtColor(g, mat, cv.COLOR_GRAY2RGBA);
  g.delete();
  return mat;
}

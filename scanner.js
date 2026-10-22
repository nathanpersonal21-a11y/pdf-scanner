/*
 * scanner.js — pure-JS image engine (no DOM, no dependencies).
 *
 *   detectQuad  find the document's four corners in a photo
 *   warp        perspective-correct a quad into an upright rectangle
 *   applyMode   contrast/white-balance + Color / Gray / Black & White
 *
 * Works on RGBA byte arrays (ImageData.data), so it runs in the browser and in
 * Node (used by the automated tests).
 *
 * Quads are always ordered [top-left, top-right, bottom-right, bottom-left].
 * detectQuad returns normalized (0..1) coordinates; warp takes pixel coordinates.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- helpers

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }

  function convexHull(points) {
    const pts = points.slice().sort((p, q) => p.x - q.x || p.y - q.y);
    if (pts.length < 3) return pts;
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  // Order 4 arbitrary points as TL, TR, BR, BL.
  function orderQuad(p) {
    const s = p.map((q) => q.x + q.y);
    const d = p.map((q) => q.x - q.y);
    const tl = p[s.indexOf(Math.min.apply(null, s))];
    const br = p[s.indexOf(Math.max.apply(null, s))];
    const tr = p[d.indexOf(Math.max.apply(null, d))];
    const bl = p[d.indexOf(Math.min.apply(null, d))];
    return [tl, tr, br, bl];
  }

  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
      if (c === 0) return false;
      const s = c > 0 ? 1 : -1;
      if (sign && s !== sign) return false;
      sign = s;
    }
    return true;
  }

  function cornerAngle(a, b, c) { // angle at b, degrees
    const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
    const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1);
    return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
  }

  // ---------------------------------------------------------- edge detection

  // Box-average the RGBA image down to a small grayscale buffer.
  function toSmallGray(rgba, w, h, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const dw = Math.max(8, Math.round(w * scale));
    const dh = Math.max(8, Math.round(h * scale));
    const gray = new Float32Array(dw * dh);
    const bw = w / dw, bh = h / dh;
    const step = Math.max(1, Math.floor(Math.min(bw, bh) / 3));
    for (let y = 0; y < dh; y++) {
      const y0 = Math.floor(y * bh), y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * bh)));
      for (let x = 0; x < dw; x++) {
        const x0 = Math.floor(x * bw), x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * bw)));
        let sum = 0, n = 0;
        for (let yy = y0; yy < y1; yy += step) {
          let i = (yy * w + x0) * 4;
          for (let xx = x0; xx < x1; xx += step, i += 4 * step) {
            sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
            n++;
          }
        }
        gray[y * dw + x] = n ? sum / n : 0;
      }
    }
    return { gray: gray, w: dw, h: dh };
  }

  function boxBlur3(src, w, h) {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            s += src[yy * w + xx]; n++;
          }
        }
        out[y * w + x] = s / n;
      }
    }
    return out;
  }

  function otsu(gray) {
    const hist = new Float64Array(256);
    for (let i = 0; i < gray.length; i++) hist[Math.max(0, Math.min(255, gray[i] | 0))]++;
    const total = gray.length;
    let sumAll = 0;
    for (let t = 0; t < 256; t++) sumAll += t * hist[t];
    let wB = 0, sumB = 0, best = -1, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sumAll - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  // 3x3 erosion followed by dilation: removes thin bridges (fingers, cables)
  // that would otherwise merge the page with the background.
  function open3(mask, w, h) {
    const er = new Uint8Array(mask.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        er[i] = mask[i] & mask[i - 1] & mask[i + 1] & mask[i - w] & mask[i + w];
      }
    }
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        out[i] = er[i] | (x > 0 ? er[i - 1] : 0) | (x < w - 1 ? er[i + 1] : 0) |
          (y > 0 ? er[i - w] : 0) | (y < h - 1 ? er[i + w] : 0);
      }
    }
    return out;
  }

  // Largest 4-connected component. Returns null if empty.
  function largestComponent(mask, w, h) {
    const label = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    let bestLabel = 0, bestArea = 0, cur = 0;
    for (let s = 0; s < mask.length; s++) {
      if (!mask[s] || label[s]) continue;
      cur++;
      let sp = 0, area = 0;
      stack[sp++] = s; label[s] = cur;
      while (sp) {
        const i = stack[--sp]; area++;
        const x = i % w, y = (i - x) / w;
        if (x > 0 && mask[i - 1] && !label[i - 1]) { label[i - 1] = cur; stack[sp++] = i - 1; }
        if (x < w - 1 && mask[i + 1] && !label[i + 1]) { label[i + 1] = cur; stack[sp++] = i + 1; }
        if (y > 0 && mask[i - w] && !label[i - w]) { label[i - w] = cur; stack[sp++] = i - w; }
        if (y < h - 1 && mask[i + w] && !label[i + w]) { label[i + w] = cur; stack[sp++] = i + w; }
      }
      if (area > bestArea) { bestArea = area; bestLabel = cur; }
    }
    if (!bestLabel) return null;
    return { label: label, id: bestLabel, area: bestArea };
  }

  function evaluateMask(mask, w, h) {
    const comp = largestComponent(open3(mask, w, h), w, h);
    if (!comp) return null;
    const frac = comp.area / (w * h);
    if (frac < 0.12 || frac > 0.985) return null;

    // Boundary pixels + border-contact statistics.
    const boundary = [];
    let borderTouch = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (comp.label[i] !== comp.id) continue;
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
        if (edge) borderTouch++;
        if (edge || comp.label[i - 1] !== comp.id || comp.label[i + 1] !== comp.id ||
          comp.label[i - w] !== comp.id || comp.label[i + w] !== comp.id) {
          boundary.push({ x: x + 0.5, y: y + 0.5 });
        }
      }
    }
    // A component hugging most of the border is the background, not the page.
    if (borderTouch > 0.55 * (2 * (w + h))) return null;

    const hull = convexHull(boundary);
    if (hull.length < 4) return null;

    // Extreme-corner method: robust for rotations up to ~40 degrees.
    let tl = hull[0], br = hull[0], tr = hull[0], bl = hull[0];
    for (const p of hull) {
      if (p.x + p.y < tl.x + tl.y) tl = p;
      if (p.x + p.y > br.x + br.y) br = p;
      if (p.x - p.y > tr.x - tr.y) tr = p;
      if (p.x - p.y < bl.x - bl.y) bl = p;
    }
    const quad = [tl, tr, br, bl];
    if (!isConvex(quad)) return null;

    const quadArea = polyArea(quad), hullArea = polyArea(hull);
    if (!quadArea || !hullArea) return null;
    const fit = quadArea / hullArea;          // 1 when the hull is a clean quad
    const fill = comp.area / quadArea;        // 1 when the quad is full of page
    if (fit < 0.85 || fill < 0.7 || fill > 1.15) return null;

    const minSide = Math.min(w, h);
    for (let i = 0; i < 4; i++) {
      if (dist(quad[i], quad[(i + 1) % 4]) < 0.15 * minSide) return null;
      const ang = cornerAngle(quad[(i + 3) % 4], quad[i], quad[(i + 1) % 4]);
      if (ang < 50 || ang > 130) return null;
    }
    return { quad: quad, score: comp.area * fit * Math.min(1, fill) };
  }

  /**
   * Find the page in an RGBA image. Returns { quad: [{x,y}*4] (normalized), score } or null.
   * Handles light paper on a dark surface and dark paper on a light surface.
   */
  function detectQuad(rgba, w, h, opts) {
    const maxSide = (opts && opts.maxSide) || 320;
    const small = toSmallGray(rgba, w, h, maxSide);
    const g = boxBlur3(small.gray, small.w, small.h);
    const thr = otsu(g);

    const bright = new Uint8Array(g.length), dark = new Uint8Array(g.length);
    for (let i = 0; i < g.length; i++) { bright[i] = g[i] > thr ? 1 : 0; dark[i] = g[i] <= thr ? 1 : 0; }

    const cands = [evaluateMask(bright, small.w, small.h), evaluateMask(dark, small.w, small.h)]
      .filter(Boolean).sort((a, b) => b.score - a.score);
    if (!cands.length) return null;

    // Grow ~1px outward (the mask boundary sits inside the true paper edge).
    const q = cands[0].quad;
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    const norm = q.map((p) => {
      const d = Math.hypot(p.x - cx, p.y - cy) || 1;
      const x = p.x + ((p.x - cx) / d) * 0.7, y = p.y + ((p.y - cy) / d) * 0.7;
      return { x: Math.max(0, Math.min(1, x / small.w)), y: Math.max(0, Math.min(1, y / small.h)) };
    });
    return { quad: norm, score: cands[0].score };
  }

  // --------------------------------------------------------- perspective warp

  // Heckbert's unit-square -> quad projective map. Points in pixels.
  function squareToQuad(q) {
    const x0 = q[0].x, y0 = q[0].y, x1 = q[1].x, y1 = q[1].y, x2 = q[2].x, y2 = q[2].y, x3 = q[3].x, y3 = q[3].y;
    const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
    let a, b, c, d, e, f, g, h;
    if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
      a = x1 - x0; b = x2 - x1; c = x0; d = y1 - y0; e = y2 - y1; f = y0; g = 0; h = 0;
    } else {
      const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
      const det = dx1 * dy2 - dx2 * dy1;
      g = (sx * dy2 - dx2 * sy) / det;
      h = (dx1 * sy - sx * dy1) / det;
      a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
      d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
    }
    return { a: a, b: b, c: c, d: d, e: e, f: f, g: g, h: h };
  }

  function quadSize(q) {
    return {
      w: Math.max(dist(q[0], q[1]), dist(q[3], q[2])),
      h: Math.max(dist(q[0], q[3]), dist(q[1], q[2]))
    };
  }

  /** Output dimensions for a quad, long side capped to maxSide (never upscaled). */
  function outputSize(q, maxSide) {
    const s = quadSize(q);
    const k = Math.min(1, maxSide / Math.max(s.w, s.h));
    return { w: Math.max(1, Math.round(s.w * k)), h: Math.max(1, Math.round(s.h * k)), scale: k };
  }

  /** Resample the quad region of `src` (RGBA, sw x sh) into an ow x oh RGBA buffer. */
  function warp(src, sw, sh, quad, ow, oh) {
    const m = squareToQuad(quad);
    const out = new Uint8ClampedArray(ow * oh * 4);
    const maxX = sw - 1, maxY = sh - 1;
    for (let y = 0; y < oh; y++) {
      const v = (y + 0.5) / oh;
      for (let x = 0; x < ow; x++) {
        const u = (x + 0.5) / ow;
        const den = m.g * u + m.h * v + 1;
        let fx = (m.a * u + m.b * v + m.c) / den - 0.5;
        let fy = (m.d * u + m.e * v + m.f) / den - 0.5;
        fx = fx < 0 ? 0 : fx > maxX ? maxX : fx;
        fy = fy < 0 ? 0 : fy > maxY ? maxY : fy;
        const x0 = fx | 0, y0 = fy | 0;
        const x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
        const tx = fx - x0, ty = fy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
        const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        const o = (y * ow + x) * 4;
        for (let c = 0; c < 3; c++) {
          const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * tx;
          const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * tx;
          out[o + c] = top + (bot - top) * ty;
        }
        out[o + 3] = 255;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ filters

  function percentile(hist, total, p) {
    const target = total * p;
    let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
    return 255;
  }

  // Estimate the paper/background level on a coarse grid (85th percentile per
  // cell, so ink does not pull it down), then smooth it. nc = 1 (gray) or 3 (rgb).
  function backgroundGrid(rgba, w, h, nc) {
    const s = Math.max(6, Math.round(Math.min(w, h) / 24));
    const gw = Math.ceil(w / s), gh = Math.ceil(h / s);
    const grids = [];
    for (let c = 0; c < nc; c++) grids.push(new Float32Array(gw * gh));
    const hist = [new Uint32Array(64), new Uint32Array(64), new Uint32Array(64)];
    const st = Math.max(1, Math.floor(s / 6));
    for (let gy = 0; gy < gh; gy++) {
      const y0 = gy * s, y1 = Math.min(h, y0 + s);
      for (let gx = 0; gx < gw; gx++) {
        const x0 = gx * s, x1 = Math.min(w, x0 + s);
        for (let c = 0; c < nc; c++) hist[c].fill(0);
        let cnt = 0;
        for (let y = y0; y < y1; y += st) {
          for (let x = x0, i = (y * w + x0) * 4; x < x1; x += st, i += 4 * st) {
            if (nc === 1) hist[0][((0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) | 0) >> 2]++;
            else { hist[0][rgba[i] >> 2]++; hist[1][rgba[i + 1] >> 2]++; hist[2][rgba[i + 2] >> 2]++; }
            cnt++;
          }
        }
        for (let c = 0; c < nc; c++) {
          let acc = 0, b = 0; const target = cnt * 0.85;
          while (b < 63 && acc + hist[c][b] < target) { acc += hist[c][b]; b++; }
          grids[c][gy * gw + gx] = b * 4 + 2;
        }
      }
    }
    for (let c = 0; c < nc; c++) {
      let g = grids[c];
      // 3x3 max (cover text-dominated cells) then 3x3 mean (smooth).
      const mx = new Float32Array(g.length);
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < gw && yy < gh) m = Math.max(m, g[yy * gw + xx]);
        }
        mx[y * gw + x] = m;
      }
      g = boxBlur3(mx, gw, gh);
      // Never brighten regions by more than ~1.8x: protects photos / dark pages.
      const sorted = Array.prototype.slice.call(g).sort((a, b) => a - b);
      const floor = 0.55 * sorted[Math.floor(sorted.length * 0.9)];
      for (let i = 0; i < g.length; i++) g[i] = Math.max(g[i], floor, 1);
      grids[c] = g;
    }
    return { grids: grids, s: s, gw: gw, gh: gh };
  }

  // Divide by the local background => paper becomes white everywhere, colour
  // cast and shadows disappear. Then a mild gamma darkens text for legibility.
  function flatten(rgba, w, h, gray) {
    const nc = gray ? 1 : 3;
    const bg = backgroundGrid(rgba, w, h, nc);
    const s = bg.s, gw = bg.gw, gh = bg.gh;
    const lut = new Uint8ClampedArray(256);
    for (let k = 0; k < 256; k++) lut[k] = 255 * Math.pow(k / 255, 1.25);

    const x0s = new Int32Array(w), x1s = new Int32Array(w), fxs = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const f = Math.max(0, Math.min(gw - 1, (x + 0.5) / s - 0.5));
      x0s[x] = f | 0; x1s[x] = Math.min(gw - 1, (f | 0) + 1); fxs[x] = f - (f | 0);
    }
    for (let y = 0; y < h; y++) {
      const f = Math.max(0, Math.min(gh - 1, (y + 0.5) / s - 0.5));
      const r0 = (f | 0) * gw, r1 = Math.min(gh - 1, (f | 0) + 1) * gw, fy = f - (f | 0);
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, a = x0s[x], b = x1s[x], fx = fxs[x];
        if (gray) {
          const g = bg.grids[0];
          const top = g[r0 + a] + (g[r0 + b] - g[r0 + a]) * fx, bot = g[r1 + a] + (g[r1 + b] - g[r1 + a]) * fx;
          const bgv = top + (bot - top) * fy;
          const v = lut[Math.min(255, (((0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * 255) / bgv) | 0)];
          rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
        } else {
          for (let c = 0; c < 3; c++) {
            const g = bg.grids[c];
            const top = g[r0 + a] + (g[r0 + b] - g[r0 + a]) * fx, bot = g[r1 + a] + (g[r1 + b] - g[r1 + a]) * fx;
            rgba[i + c] = lut[Math.min(255, ((rgba[i + c] * 255) / (top + (bot - top) * fy)) | 0)];
          }
        }
      }
    }
  }

  /**
   * In-place enhancement. mode: 'color' | 'gray' | 'bw'.
   *  color: shadow/lighting flattening + per-channel white balance (paper -> white)
   *  gray : the same on luminance
   *  bw   : adaptive (local-mean) threshold, tolerant of shadows and uneven light
   */
  function applyMode(rgba, w, h, mode) {
    if (mode === 'color') return flatten(rgba, w, h, false);
    if (mode === 'gray') return flatten(rgba, w, h, true);

    const n = w * h;
    const Y = new Float32Array(n);
    const hist = new Float64Array(256);
    const stride = Math.max(1, Math.floor(n / 60000));
    let count = 0;
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      Y[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      if (p % stride === 0) { hist[Y[p] | 0]++; count++; }
    }
    const hiL = percentile(hist, count, 0.92);

    // Integral image for O(1) local means.
    const W1 = w + 1;
    const integral = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += Y[y * w + x];
        integral[(y + 1) * W1 + (x + 1)] = integral[y * W1 + (x + 1)] + row;
      }
    }
    const r = Math.max(8, Math.round(Math.min(w, h) / 20));
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const sum = integral[y1 * W1 + x1] - integral[y0 * W1 + x1] - integral[y1 * W1 + x0] + integral[y0 * W1 + x0];
        const mean = sum / ((x1 - x0) * (y1 - y0));
        const t0 = mean * 0.78, t1 = mean * 0.93;
        let v = (Y[y * w + x] - t0) / (t1 - t0);
        if (Y[y * w + x] < 0.3 * hiL) v = 0;       // very dark pixels are always ink
        v = v < 0 ? 0 : v > 1 ? 1 : v;
        const o = (y * w + x) * 4;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v * 255;
      }
    }
  }

  const api = {
    detectQuad: detectQuad, warp: warp, applyMode: applyMode, outputSize: outputSize,
    quadSize: quadSize, orderQuad: orderQuad, squareToQuad: squareToQuad
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scanner = api;
})(typeof self !== 'undefined' ? self : this);

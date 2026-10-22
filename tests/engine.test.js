/* Engine tests: edge detection, perspective warp, filters, PDF writer.
 * Run:  cd tests && npm install && node engine.test.js
 * Needs qpdf + poppler-utils (pdfinfo, pdftoppm) on PATH for the PDF validity checks.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createCanvas } = require('@napi-rs/canvas');
const Scanner = require('../scanner.js');
const PDFWriter = require('../pdf.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

// ---- synthetic "photo" of a page ------------------------------------------
function inv3(m) { // m = [a,b,c, d,e,f, g,h,1]
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

function makePhoto(W, H, quad, opts) {
  opts = opts || {};
  const paper = opts.darkPaper ? [40, 44, 52] : [236, 232, 222];
  const desk = opts.darkPaper ? [210, 190, 160] : [52, 42, 36];
  const ink = opts.darkPaper ? [235, 235, 235] : [35, 35, 40];
  const m = Scanner.squareToQuad(quad);
  const inv = inv3([m.a, m.b, m.c, m.d, m.e, m.f, m.g, m.h, 1]);
  const data = new Uint8ClampedArray(W * H * 4);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const X = inv[0] * x + inv[1] * y + inv[2], Y = inv[3] * x + inv[4] * y + inv[5], Z = inv[6] * x + inv[7] * y + inv[8];
      const u = X / Z, v = Y / Z;
      const o = (y * W + x) * 4;
      let col, shade = 1;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
        col = paper;
        shade = 1 - 0.28 * u;                         // lighting falloff / shadow
        if (isInk(u, v)) col = ink;
      } else col = desk;
      const noise = (rnd() - 0.5) * 8;
      data[o] = col[0] * shade + noise; data[o + 1] = col[1] * shade + noise; data[o + 2] = col[2] * shade + noise;
      data[o + 3] = 255;
    }
  }
  return data;
}

// Text-like bars at fixed page coordinates.
function isInk(u, v) {
  if (v > 0.06 && v < 0.12 && u > 0.1 && u < 0.7) return true;           // title
  for (let line = 0; line < 20; line++) {
    const v0 = 0.2 + line * 0.035;
    if (v > v0 && v < v0 + 0.014 && u > 0.1 && u < 0.9 - ((line * 37) % 11) * 0.02) return true;
  }
  return false;
}

const W = 1600, H = 1200;
const TRUTH = [{ x: 320, y: 170 }, { x: 1290, y: 230 }, { x: 1240, y: 1040 }, { x: 260, y: 990 }];

function cornerErr(found, truth, w, h) {
  const diag = Math.hypot(w, h);
  return Math.max.apply(null, found.map((p, i) => Math.hypot(p.x * w - truth[i].x, p.y * h - truth[i].y)) ) / diag;
}

(async function main() {
  console.log('Scanner engine');

  await test('squareToQuad maps unit-square corners onto the quad', () => {
    const m = Scanner.squareToQuad(TRUTH);
    const map = (u, v) => { const d = m.g * u + m.h * v + 1; return [(m.a * u + m.b * v + m.c) / d, (m.d * u + m.e * v + m.f) / d]; };
    [[0, 0], [1, 0], [1, 1], [0, 1]].forEach((uv, i) => {
      const p = map(uv[0], uv[1]);
      assert(Math.hypot(p[0] - TRUTH[i].x, p[1] - TRUTH[i].y) < 1e-6, 'corner ' + i + ' off: ' + p);
    });
  });

  const photo = makePhoto(W, H, TRUTH);

  await test('detectQuad finds a perspective page on a dark desk', () => {
    const t = Date.now();
    const r = Scanner.detectQuad(photo, W, H);
    assert(r, 'no quad found');
    const err = cornerErr(r.quad, TRUTH, W, H);
    console.log('       corner error ' + (err * 100).toFixed(2) + '% of diagonal, ' + (Date.now() - t) + ' ms');
    assert(err < 0.02, 'corner error too large: ' + err);
  });

  await test('detectQuad finds dark paper on a light surface', () => {
    const p2 = makePhoto(W, H, TRUTH, { darkPaper: true });
    const r = Scanner.detectQuad(p2, W, H);
    assert(r, 'no quad found');
    assert(cornerErr(r.quad, TRUTH, W, H) < 0.02);
  });

  await test('detectQuad returns null for a blank frame', () => {
    const blank = new Uint8ClampedArray(W * H * 4).fill(120);
    assert.strictEqual(Scanner.detectQuad(blank, W, H), null);
  });

  await test('detectQuad is fast enough for live preview (160px)', () => {
    const t = Date.now();
    for (let i = 0; i < 10; i++) Scanner.detectQuad(photo, W, H, { maxSide: 160 });
    const per = (Date.now() - t) / 10;
    console.log('       ' + per.toFixed(1) + ' ms per detection');
    assert(per < 120);
  });

  // warp with the true quad so that page coordinates map to output coordinates
  const sz = Scanner.outputSize(TRUTH, 1000);
  const warped = Scanner.warp(photo, W, H, TRUTH, sz.w, sz.h);
  const at = (buf, w, u, v) => { const x = Math.round(u * (w - 1)), y = Math.round(v * (buf.length / 4 / w - 1)); const i = (y * w + x) * 4; return [buf[i], buf[i + 1], buf[i + 2]]; };

  await test('warp output is upright: ink where the page has ink, paper elsewhere', () => {
    const ink = at(warped, sz.w, 0.3, 0.09), paper = at(warped, sz.w, 0.5, 0.15);
    assert(ink[0] < 90, 'title bar should be dark, got ' + ink);
    assert(paper[0] > 150, 'paper should be bright, got ' + paper);
    // no desk colour should leak into the corners
    [[0.01, 0.01], [0.99, 0.01], [0.99, 0.99], [0.01, 0.99]].forEach((c) => assert(at(warped, sz.w, c[0], c[1])[0] > 120, 'desk leaked at ' + c));
  });

  await test('color mode whitens the paper', () => {
    const buf = new Uint8ClampedArray(warped); Scanner.applyMode(buf, sz.w, sz.h, 'color');
    const p = at(buf, sz.w, 0.5, 0.15); assert(p[0] > 240 && p[1] > 240 && p[2] > 240, 'paper ' + p);
    assert(at(buf, sz.w, 0.3, 0.09)[0] < 90);
  });

  await test('gray mode is neutral and high contrast', () => {
    const buf = new Uint8ClampedArray(warped); Scanner.applyMode(buf, sz.w, sz.h, 'gray');
    const p = at(buf, sz.w, 0.5, 0.15), t = at(buf, sz.w, 0.3, 0.09);
    assert(p[0] === p[1] && p[1] === p[2], 'not neutral');
    assert(p[0] > 225 && t[0] < 80, 'contrast ' + p[0] + '/' + t[0]);
  });

  await test('B&W mode survives uneven lighting (shadow on one side)', () => {
    const buf = new Uint8ClampedArray(warped); Scanner.applyMode(buf, sz.w, sz.h, 'bw');
    const left = at(buf, sz.w, 0.05, 0.9)[0], right = at(buf, sz.w, 0.95, 0.9)[0];
    assert(left > 240 && right > 240, 'paper not white on both sides: ' + left + ' / ' + right);
    assert(at(buf, sz.w, 0.3, 0.09)[0] < 60, 'ink not black');
    // text coverage sanity: some, but not most, pixels are dark
    let dark = 0; for (let i = 0; i < buf.length; i += 4) if (buf[i] < 128) dark++;
    const frac = dark / (buf.length / 4);
    assert(frac > 0.02 && frac < 0.25, 'dark fraction ' + frac);
  });

  console.log('\nPDF writer');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftest-'));
  async function jpeg(w, h, rgb) {
    const c = createCanvas(w, h), g = c.getContext('2d');
    g.fillStyle = 'rgb(' + rgb.join(',') + ')'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; g.fillRect(w * 0.1, h * 0.1, w * 0.3, h * 0.05);
    return { jpeg: new Uint8Array(await c.encode('jpeg', 80)), width: w, height: h };
  }
  const pages = [await jpeg(900, 1200, [220, 30, 30]), await jpeg(1200, 800, [30, 200, 40]), await jpeg(800, 1100, [30, 40, 220])];
  const out = PDFWriter.build(pages, { title: 'Test Scan — ünïcode', date: new Date(Date.UTC(2026, 9, 19, 12, 0, 0)) });
  const pdfPath = path.join(tmp, 't.pdf');
  fs.writeFileSync(pdfPath, Buffer.concat(out.chunks.map((c) => Buffer.from(c))));

  await test('reported size equals bytes written', () => assert.strictEqual(fs.statSync(pdfPath).size, out.size));
  await test('qpdf --check passes', () => { execFileSync('qpdf', ['--check', pdfPath], { stdio: 'pipe' }); });
  await test('pdfinfo: 3 pages, title, A4-fit page sizes, landscape page', () => {
    const info = execFileSync('pdfinfo', ['-f', '1', '-l', '3', pdfPath]).toString();
    assert(/Pages:\s+3/.test(info), info);
    assert(/Title:\s+Test Scan/.test(info), 'title missing');
    const sizes = [...info.matchAll(/Page\s+(\d) size:\s+([\d.]+) x ([\d.]+) pts/g)].map((m) => [+m[2], +m[3]]);
    assert.strictEqual(sizes.length, 3);
    assert(sizes[0][1] > sizes[0][0], 'page 1 should be portrait');
    assert(sizes[1][0] > sizes[1][1], 'page 2 should be landscape');
    sizes.forEach((s) => assert(s[0] <= 842 && s[1] <= 842));
  });
  await test('pages render in the right order with the right colours', () => {
    execFileSync('pdftoppm', ['-r', '20', '-png', pdfPath, path.join(tmp, 'p')]);
    const files = fs.readdirSync(tmp).filter((f) => f.endsWith('.png')).sort();
    assert.strictEqual(files.length, 3);
    const want = ['r', 'g', 'b'];
    files.forEach((f, i) => {
      const { loadImage } = require('@napi-rs/canvas');
      return loadImage(path.join(tmp, f)).then((img) => {
        const c = createCanvas(img.width, img.height), g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const px = g.getImageData(img.width - 3, img.height - 3, 1, 1).data;
        const dom = px[0] > 150 ? 'r' : px[1] > 150 ? 'g' : 'b';
        assert.strictEqual(dom, want[i], 'page ' + (i + 1) + ' colour ' + px);
      });
    });
  });
  await test('rejects empty input', () => assert.throws(() => PDFWriter.build([], {})));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();

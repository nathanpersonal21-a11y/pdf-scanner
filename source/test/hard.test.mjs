import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as core from '../src/core/cvcore.ts';
const require = createRequire(import.meta.url);
let cv = require('../node_modules/@techstark/opencv-js/dist/opencv.js');
if (typeof cv.then === 'function') cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
core.setCV(cv);
const dir = new URL('./samples/', import.meta.url).pathname;
const outDir = new URL('./out/', import.meta.url).pathname; mkdirSync(outDir, { recursive: true });
const truth = JSON.parse(readFileSync(dir + 'truth.json', 'utf8'));
const loadPng = (path) => {
  const raw = execFileSync('python3', ['-c', 'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert("RGBA")\nsys.stdout.buffer.write(im.size[0].to_bytes(4,"little")+im.size[1].to_bytes(4,"little")+im.tobytes())', path], { maxBuffer: 1 << 29 });
  const m = new cv.Mat(raw.readUInt32LE(4), raw.readUInt32LE(0), cv.CV_8UC4); m.data.set(raw.subarray(8)); return m;
};
const savePng = (mat, path) => {
  const p = path + '.rgba';
  writeFileSync(p, Buffer.concat([Buffer.from(new Uint32Array([mat.cols, mat.rows]).buffer), Buffer.from(mat.data)]));
  execFileSync('python3', ['-c', 'import sys\nfrom PIL import Image\nb=open(sys.argv[1],"rb").read()\nw=int.from_bytes(b[:4],"little");h=int.from_bytes(b[4:8],"little")\nImage.frombytes("RGBA",(w,h),b[8:]).convert("RGB").save(sys.argv[2])', p, path]);
};
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${x}`); if (!ok) fails++; };
for (const name of ['sample1','sample2','sample3','hard1','hard2','hard3']) {
  const src = loadPng(dir + name + '.png');
  const det = core.detectQuad(src);
  const gt = truth[name];
  const err = Math.max(...det.corners.map((c, i) => Math.hypot(c.x - gt[i][0], c.y - gt[i][1])));
  check(`${name}: corners`, det.found && err < 0.02, `max err ${(err * 100).toFixed(2)}% of frame`);
  let w = core.warpDocument(src, det.corners, 1700);
  check(`${name}: aspect`, Math.abs(w.cols / w.rows - 850 / 1100) < 0.02, `aspect ${(w.cols / w.rows).toFixed(3)} (true 0.773)`);
  core.removeFingers(w);
  const before = w.clone();
  const out = core.applyFilter(w, 'document');
  savePng(before, outDir + name + '_prefix.png'); savePng(out, outDir + name + '_doc.png');
  savePng(core.applyFilter(w, 'bw'), outDir + name + '_bw2.png');
  before.delete(); out.delete(); w.delete(); src.delete();
}
console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);

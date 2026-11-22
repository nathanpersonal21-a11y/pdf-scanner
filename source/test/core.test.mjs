// Runs the real OpenCV.js pipeline in Node against synthetic photos.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as core from '../src/core/cvcore.ts';

const require = createRequire(import.meta.url);
let cv = require('../node_modules/@techstark/opencv-js/dist/opencv.js');
if (cv instanceof Promise || typeof cv.then === 'function') cv = await cv;
else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
core.setCV(cv);

const dir = new URL('./samples/', import.meta.url).pathname;
const outDir = new URL('./out/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
const truth = JSON.parse(readFileSync(dir + 'truth.json', 'utf8'));

// decode PNG -> raw RGBA via python (keeps the test dependency-free)
function loadPng(path) {
  const raw = execFileSync('python3', ['-c', `
import sys
from PIL import Image
im=Image.open(sys.argv[1]).convert("RGBA")
sys.stdout.buffer.write(im.size[0].to_bytes(4,"little")+im.size[1].to_bytes(4,"little")+im.tobytes())
`, path], { maxBuffer: 1 << 29 });
  const w = raw.readUInt32LE(0), h = raw.readUInt32LE(4);
  const mat = new cv.Mat(h, w, cv.CV_8UC4);
  mat.data.set(raw.subarray(8));
  return mat;
}
function savePng(mat, path) {
  const p = path + '.rgba';
  writeFileSync(p, Buffer.concat([Buffer.from(new Uint32Array([mat.cols, mat.rows]).buffer), Buffer.from(mat.data)]));
  execFileSync('python3', ['-c', `
import sys
from PIL import Image
b=open(sys.argv[1],"rb").read()
w=int.from_bytes(b[:4],"little");h=int.from_bytes(b[4:8],"little")
Image.frombytes("RGBA",(w,h),b[8:]).convert("RGB").save(sys.argv[2])
`, p, path]);
}

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!ok) failures++;
};

for (const name of ['sample1', 'sample2', 'sample3']) {
  const src = loadPng(dir + name + '.png');
  const t0 = Date.now();
  const det = core.detectQuad(src);
  const gt = truth[name];
  const err = det.corners.map((c, i) => Math.hypot(c.x - gt[i][0], c.y - gt[i][1]));
  const maxErr = Math.max(...err);
  check(`${name}: detected paper`, det.found, `(${Date.now() - t0}ms)`);
  check(`${name}: corner error < 2.5% of frame`, maxErr < 0.025, `max=${(maxErr * 100).toFixed(2)}%`);

  let warped = core.warpDocument(src, det.corners, 1800);
  const aspect = warped.cols / warped.rows;
  check(`${name}: warp is flat page-like rectangle`, Math.abs(aspect - 850 / 1100) < 0.06, `aspect=${aspect.toFixed(3)}`);
  if (name === 'sample1') {
    // finger should be painted out of the page edges
    savePng(warped, outDir + name + '_warp_before_fingers.png');
    core.removeFingers(warped);
  }
  savePng(warped, outDir + name + '_warp.png');
  for (const f of ['original', 'bw', 'gray', 'color', 'document']) {
    const out = core.applyFilter(warped, f);
    check(`${name}: filter ${f} keeps size`, out.cols === warped.cols && out.rows === warped.rows);
    savePng(out, outDir + `${name}_${f}.png`);
    out.delete();
  }
  const rot = core.rotateMat(warped, 90);
  check(`${name}: rotate 90 swaps dims`, rot.cols === warped.rows && rot.rows === warped.cols);
  rot.delete(); warped.delete(); src.delete();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL CORE CHECKS PASSED');
process.exit(failures ? 1 : 0);

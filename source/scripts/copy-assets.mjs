// Copies the self-hosted engines (OpenCV.js, Tesseract OCR) from node_modules into public/.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
const nm = new URL('../node_modules/', import.meta.url).pathname;
const pub = new URL('../public/', import.meta.url).pathname;
mkdirSync(pub + 'ocr', { recursive: true });
const cp = (from, to) => {
  if (!existsSync(from)) throw new Error('Missing ' + from + ' - run npm install');
  cpSync(from, to);
};
cp(nm + '@techstark/opencv-js/dist/opencv.js', pub + 'opencv.js');
cp(nm + 'tesseract.js/dist/worker.min.js', pub + 'ocr/worker.min.js');
for (const f of ['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm'])
  cp(nm + `tesseract.js-core/${f}.wasm.js`, pub + `ocr/${f}.wasm.js`);
cp(nm + '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', pub + 'ocr/eng.traineddata.gz');
console.log('engine assets copied');

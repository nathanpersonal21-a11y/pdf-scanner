# DocScan

A document scanner that runs entirely in your browser and installs as a PWA (built for iPhone 13 / iOS Safari, works on Android and desktop too).
No account, no server, no uploads: your scans never leave your device.

## Features

- Scan with the camera (live edge overlay) or upload JPG / PNG
- Automatic paper detection, crop and perspective correction (OpenCV.js, self-hosted)
- Correct aspect ratio recovered from the camera geometry, so pages come out flat and properly proportioned
- Sub-pixel corner refinement on the real paper edges, even at steep angles; page shape can be forced to Letter / A4 / As drawn
- Drag the four corners yourself, with a magnifier loupe
- Automatically removes fingers holding the page
- Filters: Original, Document, Black & White, Grayscale, Enhanced Color (hard-shadow removal, glare/faint-ink contrast recovery, sharpening)
- **Readable text** toggle: reads every page on-device (Tesseract OCR, English) and re-typesets all pages with one font, size, line spacing and margins; headings stay bold; exports as selectable text
- Before/after compare slider
- Multi-page: reorder (long-press drag or arrow buttons), rotate, delete, replace, add pages
- PDF export (pdf-lib): Letter / A4 / Auto, color / grayscale / black & white, custom file name, download or Share → Save to Files
- Recent Scans stored locally in IndexedDB; works offline after first load

## Use it on iPhone

1. Deploy (Settings → Pages → Source: **GitHub Actions**; the included workflow publishes on every push to `main`).
2. Open the Pages URL in Safari, tap Share → **Add to Home Screen**.

HTTPS is required for camera access, which GitHub Pages provides.

## Develop

```bash
npm install
npm run dev          # local dev server
npm run build        # type-check + production build
npm run test:core    # runs the real OpenCV pipeline in Node on synthetic photos
npm run test:hard    # steep angles, hard shadows, glare
python3 test/make_samples.py test/samples   # regenerate test photos
```

`test/e2e.py` (Playwright + Chrome) drives the full workflow: upload, crop, filter, add page, reorder, export PDF. `test/e2e2.py` covers Readable text on angled/shadowed/glare photos and checks the words in the exported PDF.

The engines (OpenCV.js, Tesseract) are copied from `node_modules` into `public/` by `scripts/copy-assets.mjs` (runs automatically on install/build). The reading engine (~7 MB) downloads the first time Readable text is used, then works offline.

## Stack

React + TypeScript, Vite, vite-plugin-pwa, OpenCV.js (`@techstark/opencv-js`), tesseract.js, pdf-lib.

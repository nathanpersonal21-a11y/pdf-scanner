# Offline PDF Scanner

A phone-first document scanner that runs as a Progressive Web App (PWA). Point your camera at a page, capture one or many, review/crop/rotate/reorder them, and save a single PDF to your phone. After the first load it works in airplane mode.

**100% free and private by design**

- No accounts, no servers, no analytics, no ads, no paid services, no API keys.
- **Zero third-party code.** Everything is plain HTML/CSS/JavaScript written for this project (about 2,400 lines). Nothing to `npm install`, nothing to build.
- Photos never leave the device. A strict Content-Security-Policy in `index.html` (`default-src 'none'; connect-src 'self'`) makes the browser itself refuse any request to another server, and the end-to-end test asserts that no request ever leaves the app's own origin.
- Hosting is free too: it's a folder of static files (see **Deploy**).

## What it does

| Step | Features |
|---|---|
| **1 Scan** | Rear camera (`getUserMedia`), live edge outline, multi-page capture, flash/torch where the phone supports it, Color / Gray / B&W mode for new pages, **import photos from your library** (also the fallback if the camera is blocked) |
| **2 Review** | Thumbnails, reorder (◀ ▶), delete, filter for all pages at once. Tap a page to: **auto-detect or manually crop** (4 draggable corners with perspective correction), rotate, change filter, **retake**, delete |
| **3 Export** | Name the file, choose Small / Standard / High quality, **Download PDF**, **Share / Save to Files** (where the browser supports sharing files), file size shown, **Start new scan** |
| **Privacy** (shield icon) | Offline-readiness check, install help, storage use, **Delete all saved scans** |

Unfinished scans are saved in the browser's IndexedDB, so closing the app doesn't lose them. Deleting browser data or uninstalling the app can remove them (downloaded PDFs are separate files and are safe).

## Files and what each one is for

| File | Purpose |
|---|---|
| `index.html`, `styles.css` | Interface (mobile-first, safe-area aware, portrait + landscape, light/dark) and the CSP |
| `app.js` | Camera, screens, page storage (IndexedDB), editor, export flow |
| `scanner.js` | Image engine: edge detection (Otsu threshold → largest region → convex hull → corners), perspective warp, shadow-flattening filters, adaptive black-and-white |
| `pdf.js` | Minimal PDF writer. Wraps each already-compressed JPEG in a PDF page (no re-encoding), so no PDF library is needed |
| `sw.js` | Service worker: caches every app file so the app opens offline |
| `manifest.webmanifest`, `icons/` | Makes it installable (standalone mode, icons incl. maskable) |
| `tests/` | `engine.test.js` (Node) and `e2e/e2e.py` (real Chromium). Not needed to run the app |
| `tools/make_icons.py` | Regenerates the icons (needs Python + Pillow) |

## First-time setup (important)

The camera and the service worker only work on a **secure origin**: `https://…` or `http://localhost`. So:

1. **Put the app on any free HTTPS host once** (see Deploy) and open that address on your phone **while online**. This one visit downloads the app.
2. Allow the camera when asked.
3. **Install it** (below). From then on it opens and scans with no internet. Open the shield screen and wait for "Ready" to confirm all files are saved.

Opening the files straight from storage (`file://`) or via a plain `http://192.168…` address will **not** give camera access. This is a browser rule, not something the app can bypass. Until the first successful online load the app cannot run offline.

## Deploy (free)

The project is a static folder; upload it as-is (the app files are in the folder root).

**GitHub Pages** (free): create a repository, upload these files (exclude `tests/node_modules`), then *Settings → Pages → Deploy from a branch → main / root*. Your app is at `https://<you>.github.io/<repo>/`.

**Cloudflare Pages** or **Netlify** (free tiers): drag the folder into *Pages → Upload assets* / *Netlify Drop*. No build command, output directory is the folder itself.

All paths are relative, so sub-folder hosting (like GitHub Pages) works.

Try it on a computer first: `python3 -m http.server 8080` in this folder, then open `http://localhost:8080`.

### Updating
When you change any app file, edit `VERSION` in `sw.js` (e.g. `1.0.2`). Phones then download the new files and show an "Update" prompt; without the bump, installed copies keep serving the old cached files.

## Install on your phone

- **iPhone / iPad (Safari):** open the https address → **Share** button → **Add to Home Screen** → Add. Launch it from the new icon.
- **Android (Chrome):** open the https address → ⋮ menu → **Install app** (or *Add to Home screen*). Or use the **Install app** button on the shield screen.

## Saving the PDF

- **Android Chrome:** *Download PDF* saves to the Downloads folder. *Share* sends it to another app.
- **iPhone / iPad:** use **Share / Save to Files** and pick *Save to Files*. Plain *Download PDF* also works in Safari tabs (the file lands in Files → Downloads), but Apple's handling of downloads from an installed home-screen app is less consistent, so the share sheet is the reliable route there.
- Desktop browsers: Download PDF saves to the Downloads folder.

## Offline verification checklist

1. On the phone, open the https address while online; allow the camera.
2. Shield screen → wait for **"✓ Ready"**.
3. Optional: install to the home screen.
4. Turn on **airplane mode**. (An "Offline · still works" notice appears; it is informational, not an error.)
5. Fully close the app, then reopen it. It must open.
6. Scan 2–3 pages with the camera. Rotate one, crop one, reorder.
7. Export a PDF and save it (Download or Share → Files). Open it from the Files app and check that all pages are there in order.
8. Close and reopen the app mid-scan: pages should be restored ("Restored N unfinished pages").
9. Shield screen → **Delete all saved scans** → confirm the count goes to 0.

## Tests

```
cd tests && npm install && node engine.test.js     # 14 engine + PDF-writer tests (needs qpdf, poppler)
python3 tests/e2e/e2e.py                           # 40 real-browser checks (needs playwright+Chromium, qpdf, poppler)
```

`npm install` is only for the tests (it pulls a canvas library used to build test images); the app itself has no dependencies.

**What was tested:** the full workflow in headless Chromium with an emulated phone and a fake camera feed: camera → live edge outline → multi-page capture → import → reorder/rotate/crop/filter/retake/delete → persistence across reload → PDF export (validated with `qpdf --check`, page count, one JPEG per page, rendered with poppler) → the same again **with the network switched off** → cold start offline → clearing data → camera-denied fallback → no request ever leaves the origin, no CSP violations or JS errors.

**What was not tested:** real iPhone and Android hardware (not available in the build environment). iOS Safari and Android Chrome specifics (real camera focus/resolution, the iOS share sheet, download placement) rely on standard APIs and fallbacks but should be confirmed with the checklist above on your own phone.

## Known limits

- **Edge detection** is classical image processing (no AI model). It works well for a page on a contrasting surface with decent light; for busy backgrounds or white-on-white, drag the corners by hand (Crop → corners → Apply).
- No OCR: the PDF contains page images, not selectable text.
- Camera resolution comes from the live video stream (up to ~2.5K), which is plenty for readable A4 text at "Standard"/"High" quality.
- iOS can clear a website's storage after long inactivity if the app isn't installed to the Home Screen. Installing it (and exporting promptly) avoids losing unfinished scans.
- Very large scans (dozens of pages at High quality) can run a low-memory phone out of RAM; use *Small* quality or export in batches.

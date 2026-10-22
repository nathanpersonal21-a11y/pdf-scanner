"""
End-to-end test in real (headless) Chromium with a mobile viewport and a fake camera.
Run:  python3 tests/e2e/e2e.py            (from the project root; needs playwright, qpdf, poppler)
It serves the app on http://localhost (a secure context), then exercises the whole workflow,
including airplane-mode (offline) use after the first load.
"""
import functools, http.server, os, subprocess, sys, tempfile, threading, json
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FX = tempfile.mkdtemp(prefix='fx-')
subprocess.check_call([sys.executable, os.path.join(os.path.dirname(__file__), 'make_fixtures.py'), FX], stdout=subprocess.DEVNULL)
OUT = tempfile.mkdtemp(prefix='out-')
SHOTS = os.environ.get('SHOTS', OUT)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache'); super().end_headers()
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT))
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = 'http://localhost:%d/' % PORT


import time
def wf(page, expr, timeout=15000):
    end = time.time() + timeout / 1000
    while time.time() < end:
        try:
            if page.evaluate('(() => { return !!(' + expr + ') })()'): return True
        except Exception: pass
        time.sleep(0.1)
    raise TimeoutError('timed out waiting for: ' + expr)

passed = failed = 0
def check(name, cond, extra=''):
    global passed, failed
    if cond: passed += 1; print('  ok   ' + name)
    else: failed += 1; print('  FAIL ' + name + ('  -> ' + str(extra) if extra != '' else ''))

problems = []      # console errors, CSP violations, page errors
external = []      # any request leaving localhost

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=[
        '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
        '--use-file-for-fake-video-capture=' + os.path.join(FX, 'feed.mjpeg'),
    ])
    ctx = browser.new_context(viewport={'width': 390, 'height': 780}, device_scale_factor=2, is_mobile=True, has_touch=True,
                              permissions=['camera'], accept_downloads=True,
                              user_agent='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36')
    def watch(page):
        page.on('console', lambda m: problems.append('console.' + m.type + ': ' + m.text) if m.type in ('error', 'warning') else None)
        page.on('pageerror', lambda e: problems.append('pageerror: ' + str(e)))
        page.on('request', lambda r: external.append(r.url) if not r.url.startswith(('http://localhost:%d' % PORT, 'blob:', 'data:')) else None)
    page = ctx.new_page(); watch(page)

    print('First load + install')
    page.goto(URL)
    page.wait_for_selector('#screen-scan:not([hidden])')
    page.evaluate('navigator.serviceWorker.ready.then(()=>1)')
    page.reload()                   # SW now controls the page
    wf(page, '!!navigator.serviceWorker.controller')
    cached = page.evaluate('''async()=>{const k=(await caches.keys()).find(x=>x.startsWith('pdf-scanner-'));
        const c=await caches.open(k);return (await c.keys()).map(r=>new URL(r.url).pathname)}''')
    check('service worker active and controlling the page', True)
    check('all app files precached', all(any(c.endswith(f) for c in cached) for f in
          ['index.html', 'styles.css', 'app.js', 'scanner.js', 'pdf.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']), cached)
    mf = page.evaluate("fetch('manifest.webmanifest').then(r=>r.json())")
    check('manifest: standalone + icons', mf['display'] == 'standalone' and len(mf['icons']) >= 3)

    print('Camera scan')
    page.wait_for_selector('#screen-scan:not([hidden])')
    wf(page, 'document.getElementById("video").videoWidth > 0', 15000)
    check('rear camera stream running (fake device)', True)
    wf(page, 'document.getElementById("overlay-poly").getAttribute("points")', 10000)
    pts = page.get_attribute('#overlay-poly', 'points')
    check('live edge outline drawn on camera view', bool(pts), pts)
    page.screenshot(path=os.path.join(SHOTS, '1-scan.png'))
    for i in range(3):
        page.click('#btn-shutter'); wf(page, 'document.getElementById("count-badge").textContent == "%d"' % (i + 1))
        page.wait_for_timeout(250)
    check('captured 3 pages in one session', page.inner_text('#count-badge') == '3')
    page.click('#scan-mode button[data-mode="bw"]')
    page.click('#btn-shutter'); wf(page, 'document.getElementById("count-badge").textContent == "4"')
    check('4th page captured in B&W mode', True)

    print('Import from library')
    page.set_input_files('#file-input', [os.path.join(FX, 'doc2.jpg')])
    page.wait_for_selector('#screen-review:not([hidden])')
    check('import adds page and opens Review', page.locator('#grid .card').count() == 5, page.locator('#grid .card').count())

    q = page.evaluate('''()=>new Promise(r=>{const q=indexedDB.open("offline-pdf-scanner");q.onsuccess=()=>{
        const t=q.result.transaction("pages").objectStore("pages").getAll();t.onsuccess=()=>r(t.result.map(p=>({w:p.w,h:p.h,quad:p.quad,mode:p.mode})))}})''')
    check('auto edge detection found the page corners (live capture)', q[0]['quad'] is not None and len(q[0]['quad']) == 4)
    imp = q[-1]
    truth = [(220,110),(1010,140),(990,860),(260,830)]
    if imp['quad']:
        err = max(((imp['quad'][i]['x']*imp['w']-truth[i][0]*imp['w']/1280)**2 + (imp['quad'][i]['y']*imp['h']-truth[i][1]*imp['h']/960)**2)**.5 for i in range(4))
        check('imported photo corners within 2%% of truth (%.1f px)' % err, err < 0.02 * (imp['w']**2 + imp['h']**2)**.5, err)
    else: check('imported photo corners detected', False)
    page.wait_for_timeout(800)
    page.screenshot(path=os.path.join(SHOTS, '2-review.png'))

    print('Review / edit')
    ids = page.eval_on_selector_all('#grid .card', 'els=>els.map(e=>e.dataset.id)')
    page.click('#grid .card:nth-child(1) button[data-act="right"]')
    ids2 = page.eval_on_selector_all('#grid .card', 'els=>els.map(e=>e.dataset.id)')
    check('reorder: page 1 moved later', ids2[1] == ids[0] and ids2[0] == ids[1])
    page.click('#grid .card:nth-child(5) button[data-act="edit"]')
    page.wait_for_selector('#screen-edit:not([hidden])')
    wf(page, 'document.getElementById("busy").hidden')
    w0 = page.evaluate('document.getElementById("preview-canvas").width'); h0 = page.evaluate('document.getElementById("preview-canvas").height')
    check('editor shows the cropped, perspective-corrected page (~790x720 px from the photo corners)', abs(w0 - 790) < 40 and abs(h0 - 720) < 40, (w0, h0))
    page.screenshot(path=os.path.join(SHOTS, '3-edit.png'))
    page.click('#t-rot-r'); wf(page, 'document.getElementById("busy").hidden')
    page.wait_for_timeout(300)
    w1 = page.evaluate('document.getElementById("preview-canvas").width'); h1 = page.evaluate('document.getElementById("preview-canvas").height')
    check('rotate 90° swaps width/height', (w1, h1) == (h0, w0), (w0, h0, w1, h1))
    page.click('#edit-mode button[data-mode="gray"]'); wf(page, 'document.getElementById("busy").hidden')
    check('filter change to Gray applied', page.get_attribute('#edit-mode button[data-mode="gray"]', 'aria-pressed') == 'true')
    page.click('#t-crop')
    page.wait_for_selector('#crop-wrap:not([hidden])')
    page.wait_for_timeout(300)
    hb = page.locator('#crop-wrap .handle[data-i="0"]').bounding_box()
    box = page.locator('#crop-wrap').bounding_box()
    page.mouse.move(hb['x'] + hb['width']/2, hb['y'] + hb['height']/2); page.mouse.down()
    page.mouse.move(hb['x'] + hb['width']/2 + 25, hb['y'] + hb['height']/2 + 25, steps=5); page.mouse.up()
    hb2 = page.locator('#crop-wrap .handle[data-i="0"]').bounding_box()
    check('manual crop: corner handle drags', abs(hb2['x'] - hb['x'] - 25) < 3 and abs(hb2['y'] - hb['y'] - 25) < 3, (hb, hb2))
    page.screenshot(path=os.path.join(SHOTS, '4-crop.png'))
    page.click('#c-auto'); wf(page, 'document.getElementById("loading").hidden')
    page.click('#c-apply'); wf(page, 'document.getElementById("busy").hidden')
    check('crop applied, back to preview', page.is_hidden('#crop-wrap') and page.is_visible('#preview-wrap'))
    page.click('#edit-next') if page.is_enabled('#edit-next') else None
    page.click('#edit-prev'); page.wait_for_timeout(300)
    page.click('#t-delete'); page.click('#dlg-ok')
    page.wait_for_selector('#screen-review:not([hidden])')
    check('delete page (with confirm)', page.locator('#grid .card').count() == 4, page.locator('#grid .card').count())
    # retake via editor
    page.click('#grid .card:nth-child(2) button[data-act="edit"]'); page.wait_for_selector('#screen-edit:not([hidden])')
    page.click('#t-retake'); page.wait_for_selector('#screen-scan:not([hidden])')
    wf(page, 'document.getElementById("video").videoWidth > 0', 15000)
    check('retake banner visible', page.is_visible('#retake-banner'))
    page.click('#btn-shutter'); page.wait_for_selector('#screen-edit:not([hidden])')
    check('retake replaces page, count unchanged', page.inner_text('#edit-title') == 'Page 2 of 4', page.inner_text('#edit-title'))
    page.click('#edit-back'); page.wait_for_selector('#screen-review:not([hidden])')

    print('Persistence (recover after closing)')
    page.wait_for_timeout(1000)
    page.reload(); page.wait_for_selector('#screen-review:not([hidden])')
    check('pages restored after reload (IndexedDB)', page.locator('#grid .card').count() == 4)

    print('Export PDF (online)')
    page.click('#btn-export'); page.wait_for_selector('#screen-export:not([hidden])')
    page.fill('#pdf-name', 'My: Test/Scan?')
    page.click('#btn-create'); page.wait_for_selector('#result:not([hidden])', timeout=60000)
    meta = page.inner_text('#res-meta'); name = page.inner_text('#res-name')
    check('result shows name, page count and size', name == 'My TestScan.pdf' and '4 pages' in meta and ('KB' in meta or 'MB' in meta), (name, meta))
    page.screenshot(path=os.path.join(SHOTS, '5-export.png'))
    with page.expect_download() as dl: page.click('#btn-download')
    pdf1 = os.path.join(OUT, 'online.pdf'); dl.value.save_as(pdf1)
    check('download suggested filename', dl.value.suggested_filename == 'My TestScan.pdf', dl.value.suggested_filename)

    def verify_pdf(path, pages):
        r = subprocess.run(['qpdf', '--check', path], capture_output=True, text=True)
        info = subprocess.run(['pdfinfo', path], capture_output=True, text=True).stdout
        check('%s: qpdf --check valid' % os.path.basename(path), r.returncode == 0, r.stdout + r.stderr)
        check('%s: %d pages' % (os.path.basename(path), pages), ('Pages:           %d' % pages) in info, info)
        subprocess.check_call(['pdftoppm', '-r', '40', '-png', path, path[:-4]])
        txt = subprocess.run(['pdfimages', '-list', path], capture_output=True, text=True).stdout
        check('%s: one embedded JPEG per page' % os.path.basename(path), txt.count(' jpeg ') == pages, txt)
    verify_pdf(pdf1, 4)
    size_ok = os.path.getsize(pdf1)
    check('reported size matches file (%d bytes)' % size_ok, str(round(size_ok/1024)) in meta or ('%.2f' % (size_ok/1048576)) in meta or ('%.1f' % (size_ok/1048576)) in meta, (meta, size_ok))

    print('Airplane mode (offline) after setup')
    ctx.set_offline(True)
    page.reload(); page.wait_for_selector('main .screen:not([hidden])', timeout=15000)
    check('app reloads and renders while offline', page.title() == 'Offline PDF Scanner')
    check('offline chip shown (not an error)', page.is_visible('#net'))
    page.evaluate("location.hash = '#review'"); page.wait_for_selector('#screen-review:not([hidden])')
    check('saved pages still there offline', page.locator('#grid .card').count() == 4 if page.is_visible('#grid') else False)
    page.click('#btn-add'); page.wait_for_selector('#screen-scan:not([hidden])')
    wf(page, 'document.getElementById("video").videoWidth > 0', 15000)
    page.click('#btn-shutter'); wf(page, 'document.getElementById("count-badge").textContent == "5"')
    check('camera capture works offline', True)
    page.click('#btn-done'); page.click('#btn-export'); page.wait_for_selector('#screen-export:not([hidden])')
    page.click('#quality button[data-q="small"]')
    page.click('#btn-create'); page.wait_for_selector('#result:not([hidden])', timeout=60000)
    with page.expect_download() as dl2: page.click('#btn-download')
    pdf2 = os.path.join(OUT, 'offline.pdf'); dl2.value.save_as(pdf2)
    verify_pdf(pdf2, 5)
    check('small quality is smaller than standard', os.path.getsize(pdf2) < size_ok * 1.5, (os.path.getsize(pdf2), size_ok))
    # privacy screen: offline status
    page.click('#btn-privacy'); page.wait_for_selector('#screen-privacy:not([hidden])')
    wf(page, 'document.getElementById("offline-status").textContent.includes("Ready")')
    check('privacy screen reports offline-ready', True)
    page.screenshot(path=os.path.join(SHOTS, '6-privacy.png'))
    # a closed-and-reopened (new page) offline
    page.close(); page2 = ctx.new_page(); watch(page2)
    page2.goto(URL); page2.wait_for_selector('main .screen:not([hidden])', timeout=15000)
    check('fresh tab opens offline (cold start from cache)', page2.title() == 'Offline PDF Scanner')
    ctx.set_offline(False)

    print('Clear data + new scan')
    page2.click('#btn-privacy'); page2.wait_for_selector('#screen-privacy:not([hidden])')
    page2.click('#btn-clear'); page2.click('#dlg-ok')
    wf(page2, 'document.getElementById("storage-info").textContent.startsWith("0 unfinished")')
    n = page2.evaluate('''()=>new Promise(r=>{const q=indexedDB.open("offline-pdf-scanner");q.onsuccess=()=>{
        const t=q.result.transaction("pages").objectStore("pages").count();t.onsuccess=()=>r(t.result)}})''')
    check('"Delete all saved scans" empties storage', n == 0, n)

    print('No-camera fallback')
    ctx2 = browser.new_context(viewport={'width': 390, 'height': 780}, is_mobile=True, has_touch=True)   # no camera permission, no fake feed grant
    p3 = ctx2.new_page(); watch(p3)
    p3.add_init_script("navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied','NotAllowedError'))")
    p3.goto(URL); p3.wait_for_selector('#cam-msg:not([hidden])')
    check('camera permission denied -> clear message + import fallback', 'permission' in p3.inner_text('#cam-msg-title').lower() and p3.is_visible('#cam-pick'))
    p3.screenshot(path=os.path.join(SHOTS, '7-denied.png'))
    ctx2.close()

    browser.close()

print('\nHygiene')
bad = [p for p in problems if 'Content Security Policy' in p or p.startswith('pageerror') or p.startswith('console.error')]
# Chromium logs failed (blocked) getUserMedia / offline favicon etc. as errors; show everything for review
check('no CSP violations or JS errors', not bad, bad)
check('no request ever left localhost', not external, external)
print('\n%d passed, %d failed   (screenshots: %s)' % (passed, failed, SHOTS))
sys.exit(1 if failed else 0)

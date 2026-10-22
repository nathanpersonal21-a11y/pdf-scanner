/*
 * app.js — UI, camera, storage and export flow.
 * Image processing lives in scanner.js, PDF writing in pdf.js. No network calls anywhere.
 */
(function () {
  'use strict';

  var VERSION = '1.0.1';
  var MAX_CAPTURE = 2800;                       // longest side of the stored original (px)
  var QUALITIES = {
    small: { side: 1400, q: 0.70 },
    standard: { side: 1900, q: 0.80 },
    high: { side: 2600, q: 0.90 }
  };
  var SCREENS = ['scan', 'review', 'edit', 'export', 'privacy'];

  var $ = function (id) { return document.getElementById(id); };
  var els = {};
  [
    'bar', 'net', 'btn-privacy', 'video', 'overlay', 'overlay-poly', 'flash', 'btn-torch', 'btn-photos',
    'retake-banner', 'retake-n', 'retake-cancel', 'cam-msg', 'cam-msg-title', 'cam-msg-text', 'cam-retry', 'cam-pick',
    'scan-mode', 'btn-thumb', 'last-thumb', 'count-badge', 'btn-shutter', 'btn-done',
    'review-sub', 'review-mode', 'grid', 'empty', 'empty-scan', 'btn-add', 'btn-export',
    'edit-back', 'edit-prev', 'edit-next', 'edit-title', 'stage-inner', 'preview-wrap', 'preview-canvas', 'busy',
    'crop-wrap', 'crop-img', 'crop-poly', 'tools-view', 'edit-mode', 't-crop', 't-rot-l', 't-rot-r', 't-retake', 't-delete',
    'tools-crop', 'c-auto', 'c-full', 'c-cancel', 'c-apply',
    'export-summary', 'export-form', 'pdf-name', 'quality', 'btn-create', 'progress', 'prog', 'prog-text', 'export-error',
    'result', 'res-name', 'res-meta', 'btn-download', 'btn-share', 'save-hint', 'btn-edit-again', 'btn-new',
    'offline-status', 'install-status', 'btn-install', 'install-help', 'storage-info', 'btn-clear', 'version', 'privacy-back',
    'loading', 'loading-text', 'toast', 'toast-text', 'toast-action', 'dlg', 'dlg-title', 'dlg-text', 'dlg-cancel', 'dlg-ok',
    'file-input'
  ].forEach(function (id) { els[id] = $(id); });

  var state = {
    pages: [],          // ordered page records (see pageRecord)
    mode: 'color',      // filter applied to newly captured pages
    name: '',
    quality: 'standard',
    retakeId: null,
    editId: null,
    pdf: null,          // { blob, name, size, pages }
    screen: null,
    persistOk: true,
    warned: false,
    lastHash: ''
  };

  // ------------------------------------------------------------------ utils

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function makeCanvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function ctx2d(c, readback) { return c.getContext('2d', readback ? { willReadFrequently: true } : undefined); }
  function freeCanvas(c) { if (c) { c.width = 0; c.height = 0; } }

  function canvasToBlob(c, type, q) {
    return new Promise(function (resolve, reject) {
      if (c.toBlob) {
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('Could not encode image')); }, type, q);
      } else {
        try {
          var d = c.toDataURL(type, q), bin = atob(d.split(',')[1]), arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type: type }));
        } catch (e) { reject(e); }
      }
    });
  }

  function paint() { // let the browser draw a loading state before heavy synchronous work
    return new Promise(function (resolve) {
      var done = false;
      function fin() { if (!done) { done = true; setTimeout(resolve, 0); } }
      requestAnimationFrame(fin); setTimeout(fin, 60);
    });
  }

  function formatSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(n < 10485760 ? 2 : 1) + ' MB';
    return (n / 1073741824).toFixed(1) + ' GB';
  }

  function isIOS() { return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function isAndroid() { return /Android/i.test(navigator.userAgent); }
  function isStandalone() { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; }

  function defaultName() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return 'Scan ' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + p(d.getMinutes());
  }
  function cleanName(s) {
    s = (s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/\.pdf$/i, '').trim();
    return s.slice(0, 80) || defaultName();
  }

  // ------------------------------------------------------------ IndexedDB

  var DB = (function () {
    var dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
        var req = indexedDB.open('offline-pdf-scanner', 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          db.createObjectStore('pages', { keyPath: 'id' });
          db.createObjectStore('meta', { keyPath: 'key' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
      return dbp;
    }
    function run(store, mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(store, mode), s = t.objectStore(store), result;
          var r = fn(s);
          if (r) r.onsuccess = function () { result = r.result; };
          t.oncomplete = function () { resolve(result); };
          t.onerror = function () { reject(t.error); };
          t.onabort = function () { reject(t.error || new Error('Storage transaction aborted')); };
        });
      });
    }
    return {
      open: open,
      put: function (store, v) { return run(store, 'readwrite', function (s) { return s.put(v); }); },
      get: function (store, k) { return run(store, 'readonly', function (s) { return s.get(k); }); },
      del: function (store, k) { return run(store, 'readwrite', function (s) { return s.delete(k); }); },
      all: function (store) { return run(store, 'readonly', function (s) { return s.getAll(); }); },
      clear: function (store) { return run(store, 'readwrite', function (s) { return s.clear(); }); }
    };
  })();

  function storageError(e) {
    if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) {
      toast('Device storage is full. Export your PDF soon, or delete some pages.', 6000);
    } else if (!state.warned) {
      state.warned = true;
      toast("Couldn't save pages for recovery in this browser. Export before closing the app.", 6000);
    }
  }
  function persist(fn) {
    if (!state.persistOk) return Promise.resolve();
    return Promise.resolve().then(fn).catch(storageError);
  }
  function pageRecord(p) {
    return { id: p.id, blob: p.blob, thumb: p.thumb, w: p.w, h: p.h, quad: p.quad, mode: p.mode, rot: p.rot, created: p.created };
  }
  function savePage(p) { return persist(function () { return DB.put('pages', pageRecord(p)); }); }
  function saveMeta() {
    return persist(function () {
      return DB.put('meta', { key: 'session', order: state.pages.map(function (p) { return p.id; }), name: state.name, quality: state.quality, mode: state.mode });
    });
  }

  // ------------------------------------------------------------ UI helpers

  var toastTimer = null;
  function toast(msg, ms, action) {
    clearTimeout(toastTimer);
    els['toast-text'].textContent = msg;
    var btn = els['toast-action'];
    if (action) { btn.textContent = action.label; btn.hidden = false; btn.onclick = function () { els.toast.hidden = true; action.fn(); }; }
    else { btn.hidden = true; btn.onclick = null; }
    els.toast.hidden = false;
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, ms || (action ? 12000 : 3000));
  }
  function showLoading(t) { els['loading-text'].textContent = t || 'Working…'; els.loading.hidden = false; }
  function setLoading(t) { els['loading-text'].textContent = t; }
  function hideLoading() { els.loading.hidden = true; }

  function confirmDialog(title, text, okLabel) {
    return new Promise(function (resolve) {
      var d = els.dlg;
      if (typeof d.showModal !== 'function') { resolve(window.confirm(title + '\n\n' + text)); return; }
      els['dlg-title'].textContent = title;
      els['dlg-text'].textContent = text;
      els['dlg-ok'].textContent = okLabel || 'Delete';
      function done(v) { els['dlg-ok'].onclick = els['dlg-cancel'].onclick = d.oncancel = null; if (d.open) d.close(); resolve(v); }
      els['dlg-ok'].onclick = function () { done(true); };
      els['dlg-cancel'].onclick = function () { done(false); };
      d.oncancel = function () { done(false); };
      d.showModal();
    });
  }

  function syncSeg(container, mode) {
    Array.prototype.forEach.call(container.querySelectorAll('button[data-mode]'), function (b) {
      b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false');
    });
  }

  // ------------------------------------------------------- image pipeline

  function loadBitmap(blob) {
    var viaImg = function () {
      var url = URL.createObjectURL(blob), img = new Image();
      img.src = url;
      return img.decode().then(function () {
        URL.revokeObjectURL(url);
        return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: function () {} };
      }, function (e) { URL.revokeObjectURL(url); throw e; });
    };
    if (window.createImageBitmap) {
      return createImageBitmap(blob).then(function (b) {
        return { source: b, width: b.width, height: b.height, close: function () { try { b.close(); } catch (e) { /* ignore */ } } };
      }).catch(viaImg);
    }
    return viaImg();
  }

  // Detect page corners from any drawable source; returns normalized quad or null.
  function detectFrom(source, sw, sh) {
    var k = Math.min(1, 360 / Math.max(sw, sh));
    var w = Math.max(8, Math.round(sw * k)), h = Math.max(8, Math.round(sh * k));
    var c = makeCanvas(w, h), g = ctx2d(c, true);
    g.imageSmoothingQuality = 'high';
    g.drawImage(source, 0, 0, w, h);
    var d = g.getImageData(0, 0, w, h);
    freeCanvas(c);
    var r = Scanner.detectQuad(d.data, w, h, { maxSide: 360 });
    return r ? r.quad.map(function (p) { return { x: p.x, y: p.y }; }) : null;
  }

  function rotateCanvas(c, rot) {
    if (!rot) return c;
    var swap = rot % 180 !== 0;
    var out = makeCanvas(swap ? c.height : c.width, swap ? c.width : c.height), g = ctx2d(out);
    g.translate(out.width / 2, out.height / 2);
    g.rotate(rot * Math.PI / 180);
    g.drawImage(c, -c.width / 2, -c.height / 2);
    freeCanvas(c);
    return out;
  }

  // Crop + perspective-correct + filter + rotate. Returns a canvas (caller frees it).
  async function renderPage(p, maxSide) {
    var bmp = await loadBitmap(p.blob);
    try {
      var quad = p.quad
        ? p.quad.map(function (q) { return { x: q.x * p.w, y: q.y * p.h }; })
        : [{ x: 0, y: 0 }, { x: p.w, y: 0 }, { x: p.w, y: p.h }, { x: 0, y: p.h }];
      var qs = Scanner.quadSize(quad), longest = Math.max(qs.w, qs.h);
      var k = Math.min(1, maxSide / longest);
      var ow = Math.max(1, Math.round(qs.w * k)), oh = Math.max(1, Math.round(qs.h * k));
      var img;
      if (!p.quad) {
        var c0 = makeCanvas(ow, oh), g0 = ctx2d(c0, true);
        g0.imageSmoothingQuality = 'high';
        g0.drawImage(bmp.source, 0, 0, ow, oh);
        img = g0.getImageData(0, 0, ow, oh);
        freeCanvas(c0);
      } else {
        var sk = Math.min(1, k * 1.5);
        var sw = Math.max(1, Math.round(p.w * sk)), sh = Math.max(1, Math.round(p.h * sk));
        var sc = makeCanvas(sw, sh), sg = ctx2d(sc, true);
        sg.imageSmoothingQuality = 'high';
        sg.drawImage(bmp.source, 0, 0, sw, sh);
        var sd = sg.getImageData(0, 0, sw, sh);
        freeCanvas(sc);
        var sq = quad.map(function (q) { return { x: q.x * sw / p.w, y: q.y * sh / p.h }; });
        img = new ImageData(Scanner.warp(sd.data, sw, sh, sq, ow, oh), ow, oh);
      }
      Scanner.applyMode(img.data, ow, oh, p.mode);
      var out = makeCanvas(ow, oh);
      ctx2d(out).putImageData(img, 0, 0);
      return rotateCanvas(out, p.rot || 0);
    } finally { bmp.close(); }
  }

  // --------------------------------------------------------------- pages

  var thumbUrls = new Map();
  function thumbUrl(p) {
    if (!p.thumb) return null;
    var u = thumbUrls.get(p.id);
    if (!u || u.blob !== p.thumb) {
      if (u) URL.revokeObjectURL(u.url);
      u = { blob: p.thumb, url: URL.createObjectURL(p.thumb) };
      thumbUrls.set(p.id, u);
    }
    return u.url;
  }
  function dropThumb(id) { var u = thumbUrls.get(id); if (u) { URL.revokeObjectURL(u.url); thumbUrls.delete(id); } }

  function getPage(id) { return state.pages.find(function (p) { return p.id === id; }); }
  function indexOfPage(id) { return state.pages.findIndex(function (p) { return p.id === id; }); }
  function touch() { state.pdf = null; }

  async function updateThumb(p) {
    var tok = p._tok = (p._tok || 0) + 1;
    p._busy = true; refreshCard(p.id);
    try {
      var c = await renderPage(p, 360);
      var b = await canvasToBlob(c, 'image/jpeg', 0.72);
      freeCanvas(c);
      if (p._tok !== tok) return;
      p.thumb = b;
    } finally {
      if (p._tok === tok) p._busy = false;
    }
    refreshCard(p.id); updateScanUI();
  }

  async function addCaptured(item) {
    touch();
    if (state.retakeId) {
      var old = getPage(state.retakeId);
      state.retakeId = null; hideRetake();
      if (old) {
        old.blob = item.blob; old.w = item.w; old.h = item.h; old.quad = item.quad; old.rot = 0;
        await updateThumb(old); await savePage(old);
        return old;
      }
    }
    var p = { id: uid(), blob: item.blob, thumb: null, w: item.w, h: item.h, quad: item.quad, mode: state.mode, rot: 0, created: Date.now() };
    state.pages.push(p);
    updateScanUI();
    try { await updateThumb(p); } catch (e) { /* thumbnail is regenerated later */ }
    await savePage(p); await saveMeta();
    return p;
  }

  async function removePage(id) {
    var i = indexOfPage(id);
    if (i < 0) return;
    state.pages.splice(i, 1);
    dropThumb(id); touch();
    await persist(function () { return DB.del('pages', id); });
    await saveMeta();
    updateScanUI();
  }

  function movePage(id, delta) {
    var i = indexOfPage(id), j = i + delta;
    if (i < 0 || j < 0 || j >= state.pages.length) return false;
    var t = state.pages[i]; state.pages[i] = state.pages[j]; state.pages[j] = t;
    touch(); saveMeta();
    return true;
  }

  async function clearAllPages() {
    state.pages.forEach(function (p) { dropThumb(p.id); });
    state.pages = []; state.name = ''; state.pdf = null; state.retakeId = null;
    await persist(function () { return DB.clear('pages'); });
    await persist(function () { return DB.clear('meta'); });
    updateScanUI();
  }

  // -------------------------------------------------------------- camera

  var cam = { stream: null, track: null, tok: 0, timer: null, misses: 0, liveCanvas: null, capturing: false, torch: false };

  function showCamMsg(title, text, noRetry) {
    els['cam-msg-title'].textContent = title;
    els['cam-msg-text'].textContent = text;
    els['cam-retry'].hidden = !!noRetry;
    els['cam-msg'].hidden = false;
  }
  function hideCamMsg() { els['cam-msg'].hidden = true; }

  async function startCamera() {
    if (cam.stream || state.screen !== 'scan') return;
    hideCamMsg();
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCamMsg('Camera not available here',
        'Browsers only allow camera access on secure (https://) pages. Open this app from its https address, or choose photos from your library instead.', true);
      return;
    }
    var tok = ++cam.tok;
    var attempts = [
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } }, audio: false },
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      { video: true, audio: false }
    ];
    var stream = null, err = null;
    for (var i = 0; i < attempts.length && !stream; i++) {
      try { stream = await navigator.mediaDevices.getUserMedia(attempts[i]); }
      catch (e) {
        err = e;
        if (e && /NotAllowed|Security|NotReadable|Abort|PermissionDenied/.test(e.name)) break;
      }
    }
    if (tok !== cam.tok || state.screen !== 'scan') { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); return; }
    if (!stream) { cameraFailed(err); return; }

    cam.stream = stream;
    cam.track = stream.getVideoTracks()[0];
    cam.track.onended = function () { if (cam.stream === stream) { stopCamera(); showCamMsg('Camera stopped', 'The camera was turned off or taken by another app.'); } };
    els.video.srcObject = stream;
    try { await els.video.play(); } catch (e) { /* autoplay is allowed; ignore */ }
    try {
      var caps = cam.track.getCapabilities ? cam.track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) cam.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
      els['btn-torch'].hidden = !caps.torch;
    } catch (e) { els['btn-torch'].hidden = true; }
    startLive();
  }

  function cameraFailed(e) {
    var n = (e && e.name) || '';
    if (/NotAllowed|PermissionDenied|Security/.test(n)) {
      showCamMsg('Camera permission is off',
        'Allow camera access for this site in your browser or phone settings, then tap “Try camera again”. You can also choose photos from your library.');
    } else if (/NotFound|DevicesNotFound|Overconstrained/.test(n)) {
      showCamMsg('No camera found', 'This device has no usable camera. You can still add photos from your library.', true);
    } else if (/NotReadable|TrackStart|Abort/.test(n)) {
      showCamMsg('Camera is busy', 'Another app may be using the camera. Close it and try again.');
    } else {
      showCamMsg('Camera problem', (e && e.message) ? e.message : 'The camera could not be started.');
    }
  }

  function stopCamera() {
    cam.tok++;
    stopLive();
    if (cam.stream) cam.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
    cam.stream = null; cam.track = null; cam.torch = false;
    els.video.srcObject = null;
    els['btn-torch'].hidden = true; els['btn-torch'].setAttribute('aria-pressed', 'false');
    clearOverlay();
  }

  function drawOverlay(quad) {
    var vw = els.video.videoWidth, vh = els.video.videoHeight;
    if (!vw) return;
    els.overlay.setAttribute('viewBox', '0 0 ' + vw + ' ' + vh);
    els['overlay-poly'].setAttribute('points', quad.map(function (p) { return (p.x * vw).toFixed(1) + ',' + (p.y * vh).toFixed(1); }).join(' '));
  }
  function clearOverlay() { els['overlay-poly'].setAttribute('points', ''); }

  function startLive() {
    stopLive();
    cam.timer = setInterval(function () {
      var v = els.video;
      if (document.hidden || !v.videoWidth || cam.capturing || v.readyState < 2) return;
      var k = 160 / Math.max(v.videoWidth, v.videoHeight);
      var w = Math.max(8, Math.round(v.videoWidth * k)), h = Math.max(8, Math.round(v.videoHeight * k));
      if (!cam.liveCanvas) cam.liveCanvas = makeCanvas(w, h);
      if (cam.liveCanvas.width !== w || cam.liveCanvas.height !== h) { cam.liveCanvas.width = w; cam.liveCanvas.height = h; }
      try {
        var g = ctx2d(cam.liveCanvas, true);
        g.drawImage(v, 0, 0, w, h);
        var r = Scanner.detectQuad(g.getImageData(0, 0, w, h).data, w, h, { maxSide: 160 });
        if (r) { cam.misses = 0; drawOverlay(r.quad); }
        else if (++cam.misses > 2) clearOverlay();
      } catch (e) { /* ignore a bad frame */ }
    }, 450);
  }
  function stopLive() { if (cam.timer) { clearInterval(cam.timer); cam.timer = null; } cam.misses = 0; }

  function flash() {
    var f = els.flash;
    f.className = 'flash go';
    requestAnimationFrame(function () { requestAnimationFrame(function () { f.className = 'flash fade'; }); });
  }

  async function onShutter() {
    var v = els.video;
    if (cam.capturing || !cam.stream || !v.videoWidth) return;
    cam.capturing = true;
    flash();
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) { /* ignore */ }
    try {
      var k = Math.min(1, MAX_CAPTURE / Math.max(v.videoWidth, v.videoHeight));
      var w = Math.round(v.videoWidth * k), h = Math.round(v.videoHeight * k);
      var c = makeCanvas(w, h);
      ctx2d(c).drawImage(v, 0, 0, w, h);
      var quad = detectFrom(c, w, h);
      var blob = await canvasToBlob(c, 'image/jpeg', 0.92);
      freeCanvas(c);
      cam.capturing = false;                      // next shot can start while this one is stored
      var wasRetake = !!state.retakeId;
      var p = await addCaptured({ blob: blob, w: w, h: h, quad: quad });
      if (wasRetake && p) go('edit', p.id);
    } catch (e) {
      toast('Capture failed: ' + (e && e.message ? e.message : e), 4000);
    } finally { cam.capturing = false; }
  }

  async function importFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) { return !f.type || /^image\//.test(f.type); });
    els['file-input'].value = '';
    if (!files.length) return;
    var retake = state.retakeId;
    if (retake) files = files.slice(0, 1);
    showLoading('Adding photos…');
    var added = 0, lastId = null;
    try {
      for (var i = 0; i < files.length; i++) {
        setLoading('Adding photo ' + (i + 1) + ' of ' + files.length + '…');
        await paint();
        var url = URL.createObjectURL(files[i]);
        try {
          var img = new Image();
          img.src = url;
          await img.decode();
          var iw = img.naturalWidth, ih = img.naturalHeight;
          if (!iw || !ih) throw new Error('empty image');
          var k = Math.min(1, MAX_CAPTURE / Math.max(iw, ih));
          var w = Math.round(iw * k), h = Math.round(ih * k);
          var c = makeCanvas(w, h), g = ctx2d(c);
          g.imageSmoothingQuality = 'high';
          g.drawImage(img, 0, 0, w, h);
          var quad = detectFrom(c, w, h);
          var blob = await canvasToBlob(c, 'image/jpeg', 0.92);
          freeCanvas(c);
          var p = await addCaptured({ blob: blob, w: w, h: h, quad: quad });
          lastId = p && p.id; added++;
        } catch (e) {
          toast('Could not read “' + files[i].name + '”', 3500);
        } finally { URL.revokeObjectURL(url); }
      }
    } finally { hideLoading(); }
    if (added) { if (retake && lastId) go('edit', lastId); else go('review'); }
  }

  // ------------------------------------------------------------- routing

  function parseHash() {
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    return { name: parts[0] || '', arg: parts[1] || '' };
  }

  function go(name, arg, opts) {
    var h = '#' + name + (arg ? '/' + arg : '');
    if (opts && opts.replace) { history.replaceState(null, '', h); route(); }
    else if (location.hash === h) route();
    else location.hash = h;
  }

  function route() {
    var r = parseHash(), name = r.name, arg = r.arg, n = state.pages.length;
    if (SCREENS.indexOf(name) < 0) name = n ? 'review' : 'scan';
    if (name === 'edit' && !getPage(arg)) name = n ? 'review' : 'scan';
    if (name === 'export' && !n) name = 'review';
    show(name, arg);
  }

  function show(name, arg) {
    var prev = state.screen;
    if (prev === 'scan' && name !== 'scan') {
      stopCamera();
      if (state.retakeId) { state.retakeId = null; hideRetake(); }
    }
    if (prev === 'edit' && name !== 'edit') leaveEditor();
    if (name !== 'privacy' && prev !== 'privacy') state.lastHash = '';
    SCREENS.forEach(function (s) { $('screen-' + s).hidden = s !== name; });
    state.screen = name;
    els.bar.hidden = name === 'edit';
    updateStepsUI();
    if (name === 'scan') enterScan();
    else if (name === 'review') renderReview();
    else if (name === 'edit') openEditor(arg);
    else if (name === 'export') renderExport();
    else if (name === 'privacy') renderPrivacy();
  }

  function updateStepsUI() {
    var active = state.screen === 'scan' ? 'scan' : state.screen === 'export' ? 'export' : (state.screen === 'review' || state.screen === 'edit') ? 'review' : '';
    Array.prototype.forEach.call(document.querySelectorAll('#steps button'), function (b) {
      b.classList.toggle('active', b.dataset.go === active);
      if (b.dataset.go === 'export') b.disabled = !state.pages.length;
    });
  }

  // ---------------------------------------------------------------- scan

  function updateScanUI() {
    var n = state.pages.length;
    els['count-badge'].textContent = n;
    els['btn-thumb'].disabled = els['btn-done'].disabled = !n;
    var last = state.pages[n - 1], u = last && thumbUrl(last);
    if (u) els['last-thumb'].src = u; else els['last-thumb'].removeAttribute('src');
    syncSeg(els['scan-mode'], state.mode);
    updateStepsUI();
  }

  function showRetake(i) { els['retake-n'].textContent = String(i + 1); els['retake-banner'].hidden = false; }
  function hideRetake() { els['retake-banner'].hidden = true; }

  function enterScan() {
    updateScanUI();
    if (state.retakeId) showRetake(indexOfPage(state.retakeId)); else hideRetake();
    startCamera();
  }

  // -------------------------------------------------------------- review

  function renderReview() {
    var n = state.pages.length;
    els['review-sub'].textContent = n ? n + (n === 1 ? ' page' : ' pages') + ' · tap a page to crop, rotate or retake it' : '';
    els.empty.hidden = n > 0;
    els.grid.hidden = !n;
    els['review-mode'].hidden = !n;
    els['review-mode'].previousElementSibling.hidden = !n;
    els['btn-export'].disabled = !n;
    var same = n && state.pages.every(function (p) { return p.mode === state.pages[0].mode; });
    syncSeg(els['review-mode'], same ? state.pages[0].mode : null);

    els.grid.textContent = '';
    state.pages.forEach(function (p, i) {
      var card = document.createElement('div');
      card.className = 'card'; card.dataset.id = p.id;

      var open = document.createElement('button');
      open.type = 'button'; open.className = 'card-img'; open.dataset.act = 'edit';
      open.setAttribute('aria-label', 'Edit page ' + (i + 1));
      var im = document.createElement('img'); im.alt = 'Page ' + (i + 1);
      var u = thumbUrl(p); if (u) im.src = u;
      var num = document.createElement('span'); num.className = 'num'; num.textContent = String(i + 1);
      open.appendChild(im); open.appendChild(num);
      card.appendChild(open);

      var acts = document.createElement('div'); acts.className = 'card-actions';
      [['left', 'Move page ' + (i + 1) + ' earlier', '#i-left', i === 0],
       ['del', 'Delete page ' + (i + 1), '#i-trash', false],
       ['right', 'Move page ' + (i + 1) + ' later', '#i-right', i === n - 1]].forEach(function (d) {
        var b = document.createElement('button');
        b.type = 'button'; b.dataset.act = d[0]; b.className = d[0] === 'del' ? 'del' : ''; b.disabled = d[3];
        b.setAttribute('aria-label', d[1]);
        b.innerHTML = '<svg class="ic"><use href="' + d[2] + '"/></svg>';
        acts.appendChild(b);
      });
      card.appendChild(acts);
      els.grid.appendChild(card);
      if (p._busy || !p.thumb) setCardBusy(card, true);
    });
    state.pages.forEach(function (p) {
      if (!p.thumb && !p._busy) updateThumb(p).then(function () { return savePage(p); }).catch(function () {});
    });
  }

  function setCardBusy(card, on) {
    var open = card.querySelector('.card-img'), b = open.querySelector('.busy');
    if (on && !b) { b = document.createElement('div'); b.className = 'busy'; b.innerHTML = '<div class="spinner"></div>'; open.appendChild(b); }
    if (!on && b) b.remove();
  }

  function refreshCard(id) {
    if (state.screen !== 'review') return;
    var card = els.grid.querySelector('.card[data-id="' + id + '"]');
    var p = getPage(id);
    if (!card || !p) return;
    var u = thumbUrl(p), im = card.querySelector('img');
    if (u && im.getAttribute('src') !== u) im.src = u;
    setCardBusy(card, !!p._busy || !p.thumb);
  }

  async function deleteFlow(id) {
    var i = indexOfPage(id);
    var ok = await confirmDialog('Delete page ' + (i + 1) + '?', 'This page will be removed from this scan.', 'Delete');
    if (!ok) return false;
    await removePage(id);
    return true;
  }

  // -------------------------------------------------------------- editor

  var edit = { mode: 'view', token: 0, quad: null, cropUrl: null, drag: null, ratio: 1 };

  function fitWrap(wrap, ratio) {
    var box = els['stage-inner'], bw = box.clientWidth, bh = box.clientHeight;
    if (!bw || !bh) return;
    var w = bw, h = w / ratio;
    if (h > bh) { h = bh; w = h * ratio; }
    wrap.style.width = Math.floor(w) + 'px';
    wrap.style.height = Math.floor(h) + 'px';
    edit.ratio = ratio;
  }
  function refitEditor() {
    if (state.screen !== 'edit') return;
    fitWrap(edit.mode === 'crop' ? els['crop-wrap'] : els['preview-wrap'], edit.ratio);
  }

  function setEditMode(m) {
    edit.mode = m;
    els['preview-wrap'].hidden = m !== 'view';
    els['crop-wrap'].hidden = m !== 'crop';
    els['tools-view'].hidden = m !== 'view';
    els['tools-crop'].hidden = m !== 'crop';
  }

  async function openEditor(id) {
    var p = getPage(id);
    if (!p) { go('review', null, { replace: true }); return; }
    state.editId = id;
    leaveCropAssets();
    setEditMode('view');
    var i = indexOfPage(id), n = state.pages.length;
    els['edit-title'].textContent = 'Page ' + (i + 1) + ' of ' + n;
    els['edit-prev'].disabled = i === 0;
    els['edit-next'].disabled = i === n - 1;
    syncSeg(els['edit-mode'], p.mode);
    await renderPreview(p);
  }

  async function renderPreview(p) {
    var tok = ++edit.token;
    els.busy.hidden = false;
    await paint();
    try {
      var c = await renderPage(p, 1500);
      if (tok !== edit.token) { freeCanvas(c); return; }
      var pc = els['preview-canvas'];
      pc.width = c.width; pc.height = c.height;
      ctx2d(pc).drawImage(c, 0, 0);
      freeCanvas(c);
      fitWrap(els['preview-wrap'], pc.width / pc.height);
    } catch (e) {
      toast('Could not show this page: ' + (e && e.message ? e.message : e), 4000);
    } finally { if (tok === edit.token) els.busy.hidden = true; }
  }

  function leaveCropAssets() {
    if (edit.cropUrl) { URL.revokeObjectURL(edit.cropUrl); edit.cropUrl = null; }
    els['crop-img'].removeAttribute('src');
    edit.drag = null;
  }
  function leaveEditor() {
    edit.token++;
    leaveCropAssets();
    var pc = els['preview-canvas']; pc.width = 1; pc.height = 1;
    edit.mode = 'view';
  }

  var FULL = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

  function enterCrop() {
    var p = getPage(state.editId);
    if (!p) return;
    setEditMode('crop');
    edit.quad = (p.quad || FULL).map(function (q) { return { x: q.x, y: q.y }; });
    leaveCropAssets();
    edit.cropUrl = URL.createObjectURL(p.blob);
    els['crop-img'].src = edit.cropUrl;
    fitWrap(els['crop-wrap'], p.w / p.h);
    drawCrop();
  }

  function drawCrop() {
    els['crop-poly'].setAttribute('points', edit.quad.map(function (q) { return q.x.toFixed(4) + ',' + q.y.toFixed(4); }).join(' '));
    Array.prototype.forEach.call(els['crop-wrap'].querySelectorAll('.handle'), function (h) {
      var q = edit.quad[+h.dataset.i];
      h.style.left = (q.x * 100) + '%';
      h.style.top = (q.y * 100) + '%';
    });
  }

  function validCropQuad(q) {
    var sign = 0, area = 0, i;
    for (i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      var cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cr) < 1e-6) return false;
      var s = cr > 0 ? 1 : -1;
      if (sign && s !== sign) return false;
      sign = s;
      area += a.x * b.y - b.x * a.y;
      if (Math.hypot(a.x - b.x, a.y - b.y) < 0.05) return false;
    }
    return Math.abs(area) / 2 > 0.04;
  }

  async function applyCrop() {
    var q = edit.quad, p = getPage(state.editId);
    if (!p) return;
    if (!validCropQuad(q)) { toast('The corners cross over. Drag them so they outline the page.', 3500); return; }
    var isFull = q.every(function (pt, i) { return Math.abs(pt.x - FULL[i].x) < 0.003 && Math.abs(pt.y - FULL[i].y) < 0.003; });
    p.quad = isFull ? null : q.map(function (pt) { return { x: pt.x, y: pt.y }; });
    touch();
    leaveCropAssets();
    setEditMode('view');
    savePage(p);
    await renderPreview(p);
    updateThumb(p).then(function () { return savePage(p); }).catch(function () {});
  }

  async function cropAuto() {
    var p = getPage(state.editId);
    if (!p) return;
    showLoading('Finding page edges…');
    await paint();
    try {
      var bmp = await loadBitmap(p.blob);
      var q = detectFrom(bmp.source, bmp.width, bmp.height);
      bmp.close();
      if (q) { edit.quad = q; drawCrop(); }
      else toast("Couldn't find the page edges. Drag the corners by hand.", 3500);
    } catch (e) { toast('Edge detection failed. Drag the corners by hand.', 3500); }
    finally { hideLoading(); }
  }

  async function changeMode(mode) {
    var p = getPage(state.editId);
    if (!p || p.mode === mode) return;
    p.mode = mode; touch(); syncSeg(els['edit-mode'], mode);
    savePage(p);
    await renderPreview(p);
    updateThumb(p).then(function () { return savePage(p); }).catch(function () {});
  }

  async function rotate(delta) {
    var p = getPage(state.editId);
    if (!p) return;
    p.rot = (((p.rot || 0) + delta) % 360 + 360) % 360; touch();
    savePage(p);
    await renderPreview(p);
    updateThumb(p).then(function () { return savePage(p); }).catch(function () {});
  }

  // -------------------------------------------------------------- export

  function renderExport() {
    var n = state.pages.length;
    els['export-summary'].textContent = n + (n === 1 ? ' page' : ' pages') + ' will be combined into one PDF, in the order shown in Review.';
    if (!state.name) state.name = defaultName();
    els['pdf-name'].value = state.name;
    syncQuality();
    els['export-error'].hidden = true;
    els.progress.hidden = true;
    var done = !!state.pdf;
    els.result.hidden = !done;
    els['export-form'].hidden = done;
    if (done) fillResult();
    els['btn-share'].hidden = !canShareFiles();
  }

  function syncQuality() {
    Array.prototype.forEach.call(els.quality.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-checked', b.dataset.q === state.quality ? 'true' : 'false');
    });
  }

  function fillResult() {
    var r = state.pdf;
    els['res-name'].textContent = r.name;
    els['res-meta'].textContent = r.pages + (r.pages === 1 ? ' page' : ' pages') + ' · ' + formatSize(r.size);
    els['save-hint'].textContent = isIOS()
      ? 'On iPhone/iPad, tap “Share / Save to Files” and choose Save to Files. If you tap Download instead, the PDF appears in the Files app under Downloads.'
      : isAndroid()
        ? 'Download saves the PDF to your phone’s Downloads folder (see your Files app or the browser’s downloads list). Share sends it to another app.'
        : 'Download saves the PDF to your Downloads folder.';
  }

  async function createPdf() {
    var n = state.pages.length;
    if (!n) return;
    var q = QUALITIES[state.quality] || QUALITIES.standard;
    state.name = cleanName(els['pdf-name'].value);
    els['pdf-name'].value = state.name;
    saveMeta();
    var name = state.name + '.pdf';

    els['export-error'].hidden = true;
    els.result.hidden = true;
    els['btn-create'].disabled = true;
    els.progress.hidden = false;
    var items = [];
    try {
      for (var i = 0; i < n; i++) {
        els.prog.value = i / (n + 1);
        els['prog-text'].textContent = 'Processing page ' + (i + 1) + ' of ' + n + '…';
        await paint();
        var c = await renderPage(state.pages[i], q.side);
        var blob = await canvasToBlob(c, 'image/jpeg', q.q);
        var buf = new Uint8Array(await blob.arrayBuffer());
        items.push({ jpeg: buf, width: c.width, height: c.height });
        freeCanvas(c);
      }
      els.prog.value = n / (n + 1);
      els['prog-text'].textContent = 'Building PDF…';
      await paint();
      var out = PDFWriter.build(items, { title: state.name, date: new Date() });
      var pdfBlob = new Blob(out.chunks, { type: 'application/pdf' });
      state.pdf = { blob: pdfBlob, name: name, size: pdfBlob.size, pages: n };
      els.progress.hidden = true;
      els['export-form'].hidden = true;
      fillResult();
      els.result.hidden = false;
      els['btn-share'].hidden = !canShareFiles();
    } catch (e) {
      els.progress.hidden = true;
      var m = (e && e.name === 'QuotaExceededError') || /memory|allocation/i.test((e && e.message) || '');
      els['export-error'].textContent = 'Couldn’t create the PDF: ' + ((e && e.message) || e) +
        (m ? ' Try “Small” quality or fewer pages.' : ' Please try again, or try “Small” quality.');
      els['export-error'].hidden = false;
    } finally { els['btn-create'].disabled = false; }
  }

  function downloadPdf() {
    if (!state.pdf) return;
    var url = URL.createObjectURL(state.pdf.blob), a = document.createElement('a');
    a.href = url; a.download = state.pdf.name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
    toast('Saving ' + state.pdf.name + '…', 3500);
  }

  function canShareFiles() {
    try {
      return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [new File([new Uint8Array(1)], 'x.pdf', { type: 'application/pdf' })] }));
    } catch (e) { return false; }
  }

  async function sharePdf() {
    if (!state.pdf) return;
    try {
      var file = new File([state.pdf.blob], state.pdf.name, { type: 'application/pdf' });
      await navigator.share({ files: [file], title: state.pdf.name });
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('Sharing didn’t work here. Use Download PDF instead.', 4000);
    }
  }

  // ------------------------------------------------------------- privacy

  var deferredInstall = null;

  async function checkOffline() {
    if (!('serviceWorker' in navigator)) return { ok: false, text: 'This browser doesn’t support offline mode.' };
    if (!window.isSecureContext) return { ok: false, text: 'Offline mode needs the app to be opened from an https:// address.' };
    try {
      var reg = await navigator.serviceWorker.getRegistration();
      if (!reg || !reg.active) return { ok: false, text: 'Not ready yet. Stay online for a moment while the app files are saved, then reopen this screen.' };
      var names = (await caches.keys()).filter(function (k) { return k.indexOf('pdf-scanner-') === 0; });
      if (!names.length) return { ok: false, text: 'Not ready yet. Stay online for a moment while the app files are saved.' };
      var cache = await caches.open(names[0]);
      var need = ['index.html', 'styles.css', 'app.js', 'scanner.js', 'pdf.js'];
      for (var i = 0; i < need.length; i++) {
        if (!(await cache.match(need[i], { ignoreSearch: true }))) return { ok: false, text: 'Not ready yet. Stay online for a moment while the app files are saved.' };
      }
      return { ok: true, text: 'Ready. All app files are saved on this device, so scanning and PDF export work without internet.' };
    } catch (e) { return { ok: false, text: 'Couldn’t check offline status.' }; }
  }

  async function renderPrivacy() {
    els.version.textContent = 'v' + VERSION;
    els['offline-status'].textContent = 'Checking…';
    checkOffline().then(function (r) { els['offline-status'].textContent = (r.ok ? '✓ ' : '') + r.text; });

    var help = els['install-help'];
    help.textContent = '';
    function addP(t) { var p = document.createElement('p'); p.textContent = t; help.appendChild(p); }
    if (isStandalone()) {
      els['install-status'].textContent = '✓ Installed. You’re running the app from your home screen.';
      els['btn-install'].hidden = true;
    } else {
      els['install-status'].textContent = 'Install it for a full-screen app that opens offline from your home screen.';
      els['btn-install'].hidden = !deferredInstall;
      if (isIOS()) addP('iPhone/iPad: open this page in Safari, tap the Share button, then “Add to Home Screen”.');
      else if (isAndroid()) addP('Android: in Chrome, tap the ⋮ menu, then “Install app” (or “Add to Home screen”).');
      else addP('Desktop: use the install icon in the address bar, or your browser’s menu.');
    }

    var n = state.pages.length, text = n + (n === 1 ? ' unfinished page' : ' unfinished pages') + ' saved on this device.';
    try {
      if (navigator.storage && navigator.storage.estimate) {
        var est = await navigator.storage.estimate();
        if (est && est.usage != null) text += ' The app is using ' + formatSize(est.usage) + ' of storage.';
      }
    } catch (e) { /* ignore */ }
    if (!state.persistOk) text = 'This browser can’t save unfinished scans, so export before closing the app.';
    els['storage-info'].textContent = text;
    els['btn-clear'].disabled = !n && state.persistOk && !state.pdf;
  }

  // ---------------------------------------------------------- wire events

  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll('#steps button'), function (b) {
      b.addEventListener('click', function () { go(b.dataset.go); });
    });
    els['btn-privacy'].addEventListener('click', function () {
      if (state.screen === 'privacy') { privacyBack(); return; }
      state.lastHash = location.hash || '#scan';
      go('privacy');
    });
    els['privacy-back'].addEventListener('click', privacyBack);
    function privacyBack() { var h = (state.lastHash || '').replace(/^#/, ''); var parts = h.split('/'); go(parts[0] || (state.pages.length ? 'review' : 'scan'), parts[1]); }

    // scan
    els['btn-shutter'].addEventListener('click', onShutter);
    els['btn-done'].addEventListener('click', function () { go('review'); });
    els['btn-thumb'].addEventListener('click', function () { go('review'); });
    els['scan-mode'].addEventListener('click', function (e) {
      var b = e.target.closest('button[data-mode]'); if (!b) return;
      state.mode = b.dataset.mode; syncSeg(els['scan-mode'], state.mode); saveMeta();
    });
    els['btn-photos'].addEventListener('click', function () { els['file-input'].click(); });
    els['cam-pick'].addEventListener('click', function () { els['file-input'].click(); });
    els['cam-retry'].addEventListener('click', function () { startCamera(); });
    els['file-input'].addEventListener('change', function () { importFiles(els['file-input'].files); });
    els['retake-cancel'].addEventListener('click', function () { var id = state.retakeId; state.retakeId = null; hideRetake(); go(id ? 'edit' : 'review', id); });
    els['btn-torch'].addEventListener('click', async function () {
      if (!cam.track) return;
      var on = !cam.torch;
      try { await cam.track.applyConstraints({ advanced: [{ torch: on }] }); cam.torch = on; els['btn-torch'].setAttribute('aria-pressed', String(on)); }
      catch (e) { toast('Flash isn’t available on this camera.', 2500); }
    });
    els.video.addEventListener('loadedmetadata', clearOverlay);

    // review
    els['empty-scan'].addEventListener('click', function () { go('scan'); });
    els['btn-add'].addEventListener('click', function () { go('scan'); });
    els['btn-export'].addEventListener('click', function () { go('export'); });
    els['review-mode'].addEventListener('click', async function (e) {
      var b = e.target.closest('button[data-mode]'); if (!b || !state.pages.length) return;
      var mode = b.dataset.mode;
      showLoading('Applying filter…');
      await paint();
      try {
        touch(); state.mode = mode; saveMeta();
        for (var i = 0; i < state.pages.length; i++) {
          var p = state.pages[i];
          setLoading('Applying filter · page ' + (i + 1) + ' of ' + state.pages.length);
          p.mode = mode;
          await updateThumb(p); await savePage(p);
        }
      } catch (err) { toast('Could not apply the filter: ' + (err && err.message ? err.message : err), 4000); }
      finally { hideLoading(); renderReview(); }
    });
    els.grid.addEventListener('click', async function (e) {
      var b = e.target.closest('button[data-act]'); if (!b) return;
      var id = b.closest('.card').dataset.id, act = b.dataset.act;
      if (act === 'edit') go('edit', id);
      else if (act === 'left' || act === 'right') { if (movePage(id, act === 'left' ? -1 : 1)) renderReview(); }
      else if (act === 'del') { if (await deleteFlow(id)) { if (state.pages.length) renderReview(); else go('scan'); } }
    });

    // editor
    els['edit-back'].addEventListener('click', function () { go('review'); });
    function step(d) { var i = indexOfPage(state.editId) + d; if (state.pages[i]) go('edit', state.pages[i].id, { replace: true }); }
    els['edit-prev'].addEventListener('click', function () { step(-1); });
    els['edit-next'].addEventListener('click', function () { step(1); });
    els['edit-mode'].addEventListener('click', function (e) { var b = e.target.closest('button[data-mode]'); if (b) changeMode(b.dataset.mode); });
    els['t-crop'].addEventListener('click', enterCrop);
    els['t-rot-l'].addEventListener('click', function () { rotate(-90); });
    els['t-rot-r'].addEventListener('click', function () { rotate(90); });
    els['t-retake'].addEventListener('click', function () { state.retakeId = state.editId; go('scan'); });
    els['t-delete'].addEventListener('click', async function () {
      var id = state.editId;
      if (await deleteFlow(id)) go(state.pages.length ? 'review' : 'scan', null, { replace: true });
    });
    els['c-auto'].addEventListener('click', cropAuto);
    els['c-full'].addEventListener('click', function () { edit.quad = FULL.map(function (q) { return { x: q.x, y: q.y }; }); drawCrop(); });
    els['c-cancel'].addEventListener('click', function () { leaveCropAssets(); setEditMode('view'); refitEditor(); });
    els['c-apply'].addEventListener('click', applyCrop);

    var cw = els['crop-wrap'];
    cw.addEventListener('pointerdown', function (e) {
      var h = e.target.closest('.handle'); if (!h) return;
      e.preventDefault();
      var i = +h.dataset.i, r = cw.getBoundingClientRect();
      edit.drag = { i: i, id: e.pointerId, dx: r.left + edit.quad[i].x * r.width - e.clientX, dy: r.top + edit.quad[i].y * r.height - e.clientY };
      try { h.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    cw.addEventListener('pointermove', function (e) {
      var d = edit.drag; if (!d || e.pointerId !== d.id) return;
      var r = cw.getBoundingClientRect();
      edit.quad[d.i] = { x: clamp((e.clientX + d.dx - r.left) / r.width, 0, 1), y: clamp((e.clientY + d.dy - r.top) / r.height, 0, 1) };
      drawCrop();
    });
    function endDrag(e) { if (edit.drag && e.pointerId === edit.drag.id) edit.drag = null; }
    cw.addEventListener('pointerup', endDrag);
    cw.addEventListener('pointercancel', endDrag);

    // export
    els['pdf-name'].addEventListener('input', function () { state.name = els['pdf-name'].value; });
    els['pdf-name'].addEventListener('change', saveMeta);
    els.quality.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-q]'); if (!b) return;
      state.quality = b.dataset.q; syncQuality(); saveMeta();
    });
    els['btn-create'].addEventListener('click', createPdf);
    els['btn-download'].addEventListener('click', downloadPdf);
    els['btn-share'].addEventListener('click', sharePdf);
    els['btn-edit-again'].addEventListener('click', function () { state.pdf = null; renderExport(); });
    els['btn-new'].addEventListener('click', async function () {
      var ok = await confirmDialog('Start a new scan?',
        'This removes the ' + state.pages.length + ' scanned page(s) from this device. A PDF you already downloaded is not affected.', 'Start new');
      if (!ok) return;
      await clearAllPages();
      go('scan');
    });

    // privacy
    els['btn-clear'].addEventListener('click', async function () {
      var ok = await confirmDialog('Delete all saved scans?', 'Every unfinished page stored in this browser will be removed. PDFs you downloaded are not affected.', 'Delete all');
      if (!ok) return;
      await clearAllPages();
      toast('All saved scans deleted.', 2500);
      renderPrivacy();
    });
    els['btn-install'].addEventListener('click', async function () {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (e) { /* ignore */ }
      deferredInstall = null; els['btn-install'].hidden = true;
    });

    // global
    window.addEventListener('hashchange', route);
    window.addEventListener('resize', refitEditor);
    window.addEventListener('orientationchange', function () { setTimeout(refitEditor, 250); });
    document.addEventListener('visibilitychange', function () {
      if (state.screen !== 'scan') return;
      if (document.hidden) stopCamera(); else startCamera();
    });
    window.addEventListener('pagehide', stopCamera);
    function net() { els.net.hidden = navigator.onLine !== false; }
    window.addEventListener('online', net); window.addEventListener('offline', net); net();
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; if (state.screen === 'privacy') renderPrivacy(); });
    window.addEventListener('appinstalled', function () { deferredInstall = null; });
  }

  // ------------------------------------------------------ service worker

  function registerWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading || !updateRequested) return;
      reloading = true; location.reload();
    });
    var updateRequested = false;
    function offerUpdate(worker) {
      toast('A new version is ready.', 0, { label: 'Update', fn: function () { updateRequested = true; worker.postMessage('SKIP_WAITING'); } });
    }
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', function () {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
        });
      });
    }).catch(function () { /* app still works online without a worker */ });
  }

  // ----------------------------------------------------------------- boot

  async function boot() {
    bind();
    registerWorker();
    try {
      var res = await Promise.all([DB.all('pages'), DB.get('meta', 'session')]);
      var recs = res[0] || [], meta = res[1] || {};
      var byId = {};
      recs.forEach(function (r) { r.rot = r.rot || 0; byId[r.id] = r; });
      var ordered = [];
      (meta.order || []).forEach(function (id) { if (byId[id]) { ordered.push(byId[id]); delete byId[id]; } });
      Object.keys(byId).map(function (k) { return byId[k]; }).sort(function (a, b) { return a.created - b.created; }).forEach(function (r) { ordered.push(r); });
      state.pages = ordered;
      if (meta.name) state.name = meta.name;
      if (QUALITIES[meta.quality]) state.quality = meta.quality;
      if (meta.mode) state.mode = meta.mode;
    } catch (e) {
      state.persistOk = false;
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    route();
    if (state.pages.length) {
      var n = state.pages.length;
      toast('Restored ' + n + (n === 1 ? ' unfinished page' : ' unfinished pages') + '.', 3500);
    }
  }

  boot();
})();

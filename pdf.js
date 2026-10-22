/*
 * pdf.js — tiny dependency-free PDF writer.
 *
 * Takes already-compressed JPEG images and wraps each one in its own PDF page
 * (DCTDecode passthrough, so no re-encoding and no quality loss). That is all
 * a document scanner needs, which is why no third-party PDF library is bundled.
 *
 * API:  PDFWriter.build(pages, { title, date }) -> { chunks: Uint8Array[], size }
 *       pages = [{ jpeg: Uint8Array, width: px, height: px }, ...]
 */
(function (root) {
  'use strict';

  function ascii(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  function num(n) {
    // Compact, locale-independent number formatting.
    return String(Math.round(n * 100) / 100);
  }

  // PDF text string as UTF-16BE hex with BOM (handles any language in the title).
  function hexUtf16(str) {
    let hex = 'FEFF';
    for (let i = 0; i < str.length; i++) {
      hex += str.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
    }
    return '<' + hex + '>';
  }

  function pdfDate(d) {
    const p = (n, l) => String(n).padStart(l || 2, '0');
    return 'D:' + p(d.getUTCFullYear(), 4) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
      p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
  }

  // Fit the image onto an A4-sized box (portrait or landscape), keeping aspect ratio.
  function pageSize(w, h) {
    const box = w > h ? [841.89, 595.28] : [595.28, 841.89];
    const s = Math.min(box[0] / w, box[1] / h);
    return [w * s, h * s];
  }

  function build(pages, opts) {
    opts = opts || {};
    if (!pages || !pages.length) throw new Error('No pages to export');

    const chunks = [];
    const offsets = [];            // byte offset of object n (index n)
    let size = 0;

    function push(bytes) { chunks.push(bytes); size += bytes.length; }
    function text(s) { push(ascii(s)); }
    function beginObj(n) { offsets[n] = size; text(n + ' 0 obj\n'); }
    function endObj() { text('\nendobj\n'); }

    // Object layout: 1 Catalog, 2 Pages, 3 Info, then (page, content, image) per page.
    const pageObj = (i) => 4 + i * 3;
    const contentObj = (i) => 5 + i * 3;
    const imageObj = (i) => 6 + i * 3;
    const total = 3 + pages.length * 3;

    push(ascii('%PDF-1.4\n'));
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment

    beginObj(1);
    text('<< /Type /Catalog /Pages 2 0 R >>');
    endObj();

    beginObj(2);
    const kids = pages.map((_, i) => pageObj(i) + ' 0 R').join(' ');
    text('<< /Type /Pages /Count ' + pages.length + ' /Kids [' + kids + '] >>');
    endObj();

    beginObj(3);
    const title = (opts.title || 'Scan').toString();
    text('<< /Title ' + hexUtf16(title) + ' /Producer (Offline PDF Scanner) /CreationDate (' +
      pdfDate(opts.date || new Date()) + ') >>');
    endObj();

    pages.forEach((pg, i) => {
      if (!pg.jpeg || !pg.jpeg.length) throw new Error('Page ' + (i + 1) + ' has no image data');
      const [pw, ph] = pageSize(pg.width, pg.height);

      beginObj(pageObj(i));
      text('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + num(pw) + ' ' + num(ph) + '] ' +
        '/Resources << /XObject << /Im0 ' + imageObj(i) + ' 0 R >> /ProcSet [/PDF /ImageC] >> ' +
        '/Contents ' + contentObj(i) + ' 0 R >>');
      endObj();

      const content = 'q ' + num(pw) + ' 0 0 ' + num(ph) + ' 0 0 cm /Im0 Do Q';
      beginObj(contentObj(i));
      text('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
      endObj();

      beginObj(imageObj(i));
      text('<< /Type /XObject /Subtype /Image /Width ' + pg.width + ' /Height ' + pg.height +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
        pg.jpeg.length + ' >>\nstream\n');
      push(pg.jpeg);
      text('\nendstream');
      endObj();
    });

    const xrefPos = size;
    let xref = 'xref\n0 ' + (total + 1) + '\n0000000000 65535 f \n';
    for (let n = 1; n <= total; n++) {
      xref += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
    }
    text(xref);
    text('trailer\n<< /Size ' + (total + 1) + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' +
      xrefPos + '\n%%EOF\n');

    return { chunks: chunks, size: size };
  }

  const api = { build: build, pageSize: pageSize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PDFWriter = api;
})(typeof self !== 'undefined' ? self : this);

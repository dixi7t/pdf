// Builds Statement Studio V8.18 from V8.17: "Recognize Text" (OCR) for scanned / picture-only pages.
//   node studio/build/add-ocr.mjs <V8.17 index.html> <out.html>
// The Edit PDFs tool (PdfCraft, base64 in #pdfcraftSrc) gets build/ocr/ocr.{js,css}, a ribbon button and
// a hook in makeFile that writes an invisible text layer. The OCR itself runs in the main page, with the
// Tesseract engine that is already embedded there (exposed as window.__ssOcrWords and reached by
// postMessage from the frame). Same exact-text patching as add-fill.mjs: every anchor must match once.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: node add-ocr.mjs <in.html> <out.html>'); process.exit(1); }
const read = (f) => readFileSync(join(here, 'ocr', f), 'utf8');

function patcher(label) {
  return function patch(text, name, find, replace) {
    const count = text.split(find).length - 1;
    if (count !== 1) throw new Error(`${label} patch "${name}": anchor found ${count} times (need exactly 1)`);
    console.log(`  ok  ${label}: ${name}`);
    return text.replace(find, () => replace);
  };
}

let html = readFileSync(src, 'utf8');
const P = patcher('page');

// ---- the embedded PdfCraft document ----
const OPEN = '<script type="text/plain" id="pdfcraftSrc">';
const a = html.indexOf(OPEN);
if (a < 0 || html.indexOf(OPEN, a + 1) >= 0) throw new Error('pdfcraftSrc block not found exactly once');
const b = html.indexOf('</script>', a);
let pc = Buffer.from(html.slice(a + OPEN.length, b).trim(), 'base64').toString('utf8');
if (pc.includes('id="ss-ocr"')) throw new Error('Recognize Text is already in this file');
const Q = patcher('editor');

pc = Q(pc, 'styles', '</head>', `<style id="ss-ocr-css">\n${read('ocr.css')}</style>\n</head>`);

// the script goes before the ribbon (the ribbon's button calls it)
pc = Q(pc, 'script', '<script id="ss-ribbon">', `<script id="ss-ocr">\n${read('ocr.js')}</script>\n<script id="ss-ribbon">`);

// write the invisible text layer with the other page edits
pc = Q(pc, 'build hook', 'if (window.SSFill) await SSFill.apply(doc, items, opt);',
  'if (window.SSFill) await SSFill.apply(doc, items, opt);\n    if (window.SSOcr) await SSOcr.apply(doc, items);');

// ribbon: icon + buttons (Home › Tools and Edit › Scans)
pc = Q(pc, 'ribbon icon', "    undo: '<path d=\"M9 14 4 9l5-5\"/>",
  "    ocr: '<path d=\"M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4\"/><path class=\"a\" d=\"M8 15l2.5-6 2.5 6M8.9 13h3.2M15 9v6\"/>',\n    ocrx: '<path d=\"M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4\"/><path class=\"r\" d=\"m9 9 6 6M15 9l-6 6\"/>',\n    undo: '<path d=\"M9 14 4 9l5-5\"/>");
const OCR_TITLE = 'Read scanned or picture-only pages (OCR) and add an invisible text layer, so their text can be searched, selected and copied. The pages look exactly the same.';
pc = Q(pc, 'ribbon home',
  '["text", "Typewriter", "typewriter", () => useTool("text"), { big: 1, tool: "text", title: "Click anywhere and type; matches nearby text" }]]],',
  `["text", "Typewriter", "typewriter", () => useTool("text"), { big: 1, tool: "text", title: "Click anywhere and type; matches nearby text" }],
        ["ocr", "Recognize Text", "ocr", () => window.SSOcr && SSOcr.start(), { big: 1, title: ${JSON.stringify(OCR_TITLE)} }]]],`);
pc = Q(pc, 'ribbon edit',
  '["form", "Fill Form", "form", () => useTool("edit"), { big: 1, title: "Type straight into the form’s boxes" }]]],',
  `["form", "Fill Form", "form", () => useTool("edit"), { big: 1, title: "Type straight into the form’s boxes" }]]],
      ["Scans", [["ocr", "Recognize Text", "ocr", () => window.SSOcr && SSOcr.start(), { big: 1, title: ${JSON.stringify(OCR_TITLE)} }],
        ["ocrx", "Remove Recognized Text", "ocrx", () => window.SSOcr && SSOcr.clear(), { title: "Take the OCR text layer off these pages again" }]]],`);

// landing page: mention it
pc = Q(pc, 'landing list', '<span><b>Edit, annotate &amp; sign</b>Retype text, fill forms, highlight, stamp, sign, move sections</span></li>',
  '<span><b>Edit, annotate &amp; sign</b>Retype text, fill forms, highlight, stamp, sign, move sections</span></li>\n      <li><span class="i" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"/><path d="M8 15l2.5-6 2.5 6M15 9v6"/></svg></span><span><b>Recognize text in scans</b>Make picture-only pages searchable and copyable (OCR)</span></li>');

pc = Q(pc, 'brand', 'const BRAND = "PdfCraft V1.4";', 'const BRAND = "PdfCraft V1.5";');
pc = Q(pc, 'footer version', 'Author “PdfCraft V1.4”', 'Author “PdfCraft V1.5”');
pc = Q(pc, 'logo version', '<span class="ver">v1.4</span>', '<span class="ver">v1.5</span>');

const enc = Buffer.from(pc, 'utf8').toString('base64');
html = html.slice(0, a + OPEN.length) + '\n' + enc + '\n' + html.slice(b);

// ---- main page: expose the Tesseract worker as a small OCR service for the frame ----
html = P(html, 'OCR service',
  "    ocrWorkerPromises[kind].catch(() => { delete ocrWorkerPromises[kind]; });\n    return ocrWorkerPromises[kind];\n  }",
  `    ocrWorkerPromises[kind].catch(() => { delete ocrWorkerPromises[kind]; });
    return ocrWorkerPromises[kind];
  }

  // V8.18: OCR for the Edit PDFs frame ("Recognize Text"). Takes a picture (Blob) and returns its lines of
  // words, each with its baseline (start x0,y0 → end x1,y1) and text size h, in pixels of the picture as
  // given (y down). Sideways or upside-down pictures are read turned upright (the turn with the most
  // confident real words wins) and the positions are mapped back. Uses the most accurate built-in model.
  window.__ssOcrWords = async (blob) => {
    const worker = await getOcrWorker(null, ocrEngineAvailable('tess-best') ? 'best' : 'fast');
    const bmp = await createImageBitmap(blob);
    const W = bmp.width, H = bmp.height;
    const turned = (rot) => {
      const c = document.createElement('canvas');
      const swap = rot === 90 || rot === 270;
      c.width = swap ? H : W; c.height = swap ? W : H;
      const ctx = c.getContext('2d');
      ctx.translate(rot === 90 ? H : rot === 180 ? W : 0, rot === 270 ? W : rot === 180 ? H : 0);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.drawImage(bmp, 0, 0);
      return c;
    };
    // point in the turned picture -> point in the original
    const back = (rot, u, v) => rot === 90 ? [v, H - u] : rot === 180 ? [W - u, H - v] : rot === 270 ? [W - v, u] : [u, v];
    const meanConf = (data) => {
      let n = 0, s = 0;
      for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) { n++; s += w.confidence; }
      return n ? s / n : 0;
    };
    let best = { rot: 0, data: (await worker.recognize(turned(0))).data };
    best.score = ocrOrientationScore(best.data);
    if (meanConf(best.data) < 70 || best.score < 3) {
      for (const rot of [90, 270, 180]) {
        const c = turned(rot);
        const { data } = await worker.recognize(c);
        c.width = c.height = 0;
        const score = ocrOrientationScore(data);
        if (score > best.score * 1.5 + 2) best = { rot, data, score };
      }
    }
    bmp.close && bmp.close();
    const rot = best.rot, lines = [];
    for (const block of best.data.blocks || []) for (const para of block.paragraphs || []) for (const line of para.lines || []) {
      const ws = (line.words || []).filter((w) => w.text && w.text.trim() && w.confidence > 20);
      if (!ws.length) continue;
      const top = Math.min(...ws.map((w) => w.bbox.y0)), bottom = Math.max(...ws.map((w) => w.bbox.y1));
      const bl = line.baseline && line.baseline.x1 > line.baseline.x0 && line.baseline.has_baseline !== false ? line.baseline : null;
      const baseAt = (x) => bl ? bl.y0 + (bl.y1 - bl.y0) * ((x - bl.x0) / (bl.x1 - bl.x0)) : bottom - (bottom - top) * 0.2;
      lines.push({ words: ws.map((w) => {
        const ya = baseAt(w.bbox.x0), yb = baseAt(w.bbox.x1);
        const [x0, y0] = back(rot, w.bbox.x0, ya), [x1, y1] = back(rot, w.bbox.x1, yb);
        return { t: w.text, x0, y0, x1, y1, h: Math.max(4, (Math.max(ya, yb) - top) / 0.75), c: Math.round(w.confidence) };
      }) });
    }
    return lines;
  };`);

html = P(html, 'OCR bridge', '  // "Convert to statements" in PdfCraft: queue the built PDF in the converter',
  `  // "Recognize Text" in PdfCraft: read a page picture with the built-in OCR engine (V8.18)
  window.addEventListener('message', async (e) => {
    if (e.source !== frame.contentWindow || !e.data || e.data.type !== 'ss-ocr') return;
    const reply = (m) => frame.contentWindow.postMessage(Object.assign({ type: 'ss-ocr-result', id: e.data.id }, m), '*');
    try {
      if (typeof window.__ssOcrWords !== 'function') throw new Error('The OCR engine isn’t available.');
      reply({ ok: true, lines: await window.__ssOcrWords(e.data.image) });
    } catch (err) { reply({ ok: false, error: String((err && err.message) || err) }); }
  });

  // "Convert to statements" in PdfCraft: queue the built PDF in the converter`);

// ---- Statement Studio version ----
html = P(html, 'title', '<title>Statement Studio · Offline · V8.17</title>', '<title>Statement Studio · Offline · V8.18</title>');
html = P(html, 'SSX version', "version: '8.17',", "version: '8.18',");

writeFileSync(out, html, 'utf8');
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1048576).toFixed(1)} MB)`);

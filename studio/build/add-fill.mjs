// Builds Statement Studio V8.17 from V8.16: edit existing text, fill forms and add text, in the PDF's own fonts.
//   node studio/build/add-fill.mjs <V8.16 index.html> <out.html>
// The "Edit PDFs" tool (PdfCraft) is stored base64-encoded inside the page; this
// script decodes it, applies exact-text patches (each anchor must match once),
// injects build/fill/*, and encodes it back. The new tool shares the check-mark
// page view, which gets a few small hooks (window.MK) for it.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: node add-fill.mjs <in.html> <out.html>'); process.exit(1); }
const read = (f) => readFileSync(join(here, 'fill', f), 'utf8');

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
if (pc.includes('id="ss-fill"')) throw new Error('form filling is already in this file');
const Q = patcher('editor');

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>';

pc = Q(pc, 'styles', '</head>', `<style id="ss-fill-css">\n${read('fill.css')}\n${read('tools.css')}</style>\n</head>`);

pc = Q(pc, 'landing list', '</ul></div>\n    <div class="ss-block"><div class="ss-label">Then</div>',
  `  <li><span class="i" aria-hidden="true">${ICON}</span><span><b>Edit, annotate &amp; sign</b>Retype text, fill forms, highlight, stamp, sign, move sections</span></li>
    </ul></div>
    <div class="ss-block"><div class="ss-label">Then</div>`);

// ---- protected PDFs: unlock them (ss-decrypt) instead of copying their pages as pictures ----
pc = Q(pc, 'keep the open password', 'else { busy.on("Opening…", file.name); update(p); }', 'else { busy.on("Opening…", file.name); src.password = p; update(p); }');
pc = Q(pc, 'unlock protected files', '  catch { src.lib = null; src.locked = true; }', `  catch {
    src.lib = null; src.locked = true;
    try {
      const r = window.SSDecrypt ? await SSDecrypt(bytes, src.password || "") : null;
      if (r && r.bytes) { src.bytes = r.bytes; src.lib = await PDFDocument.load(r.bytes, { updateMetadata: false }); src.locked = false; src.unlocked = r; }
    } catch (e) { console.warn("couldn't unlock", file.name, e); }
  }`);

// ---- hooks in the check-mark page view (ss-marks) ----
pc = Q(pc, 'expose view', 'const $m = (id) => el.querySelector("#" + id);',
  `const $m = (id) => el.querySelector("#" + id);
  // V8.17: shared with the form-filling / text tool (ss-fill)
  window.MK = { V, el, $m, itemByUid, frac: (e) => frac(e), show: (uid) => show(uid), redraw: () => drawLayer(), refresh: () => V.uid && show(V.uid, true) };`);

// redraw the open page in place (after an edit), keeping the scroll position
pc = Q(pc, 'show in place', 'async function show(uid) {', 'async function show(uid, keep) {');
pc = Q(pc, 'keep scroll', '$m("mk-stage").scrollTo(0, 0);', 'if (!keep) $m("mk-stage").scrollTo(0, 0);');

pc = Q(pc, 'view label', 'el.setAttribute("aria-label", "Add check marks");',
  'el.setAttribute("aria-label", "Edit page: check marks, form fields and text");');

pc = Q(pc, 'layer hook', 'function drawLayer() {\n    const it = itemByUid(V.uid); if (!it) return hide();',
  'function drawLayer() {\n    const it = itemByUid(V.uid); if (!it) return hide();\n    if (window.SSFill) SSFill.layer(it);');

pc = Q(pc, 'press hook', '$m("mk-paper").addEventListener("pointerdown", (e) => {\n    if (e.button !== 0) return;',
  '$m("mk-paper").addEventListener("pointerdown", (e) => {\n    if (window.SSFill && SSFill.claim(e)) return;\n    if (e.button !== 0) return;');

// form widgets are drawn as live inputs, so leave them off the canvas
pc = Q(pc, 'render forms off canvas', 'await V.page.render({ canvasContext: ctx, viewport: vp }).promise;',
  'await V.page.render({ canvasContext: ctx, viewport: vp, annotationMode: window.SSFill && SSFill.formsOn() ? pdfjsLib.AnnotationMode.ENABLE_FORMS : pdfjsLib.AnnotationMode.ENABLE }).promise;');

// typing in a field or text box must not move marks or delete pages
pc = Q(pc, 'keys while typing', 'if (e.target.matches("input[type=number],input[type=text]")) {',
  'if (e.target.matches("input:not([type=radio]):not([type=checkbox]):not([type=range]),textarea,select")) {');

pc = Q(pc, 'draw text into the PDF', 'if (!opt.noMarks) applyMarks(doc, items);',
  'if (!opt.noMarks) applyMarks(doc, items);\n    if (window.SSFill) await SSFill.apply(doc, items, opt);');

pc = Q(pc, 'script', '<script id="ss-compress">',
  `<script id="ss-fill">\n${read('fill.js')}</script>\n<script id="ss-tools">\n${read('tools.js')}</script>\n<script id="ss-ribbon">\n${read('ribbon.js')}</script>\n<script id="ss-compress">`);

// digital signatures: node-forge (BSD-3-Clause) for PKCS#12 / X.509 / PKCS#7, and the signer, which must run
// after compression (a signed file can't change afterwards)
const safeScript = (t) => t.replace(/<\/script/gi, '<\\/script');
pc = Q(pc, 'signing', '<script id="ss-bridge">',
  `<script id="ss-forge">\n${safeScript(read('forge.bundle.js'))}</script>\n<script id="ss-decrypt">\n${read('decrypt.js')}</script>\n<script id="ss-sign">\n${read('sign.js')}</script>\n<script id="ss-bridge">`);

pc = Q(pc, 'brand', 'const BRAND = "PdfCraft V1.3";', 'const BRAND = "PdfCraft V1.4";');
pc = Q(pc, 'footer version', 'Author “PdfCraft V1.3”', 'Author “PdfCraft V1.4”');
pc = Q(pc, 'licences', 'JSZip (MIT).', 'JSZip (MIT), node-forge (BSD-3-Clause).');
pc = Q(pc, 'logo version', '<span class="ver">v1.3</span>', '<span class="ver">v1.4</span>');

const enc = Buffer.from(pc, 'utf8').toString('base64');
html = html.slice(0, a + OPEN.length) + '\n' + enc + '\n' + html.slice(b);

// ---- Statement Studio version ----
html = P(html, 'title', '<title>Statement Studio · Offline · V8.16</title>', '<title>Statement Studio · Offline · V8.17</title>');
html = P(html, 'SSX version', "version: '8.16',", "version: '8.17',");

writeFileSync(out, html, 'utf8');
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1048576).toFixed(1)} MB)`);

// Builds Statement Studio V8.19 from V8.18: "Scan to Word" (pages -> a new, editable .docx).
//   node studio/build/add-docx.mjs <V8.18 index.html> <out.html>
// Injects build/ocr/docx.js into the Edit PDFs tool (after ss-ocr, which it uses) and adds a ribbon button.
// Same exact-text patching as add-fill.mjs / add-ocr.mjs: every anchor must match once.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: node add-docx.mjs <in.html> <out.html>'); process.exit(1); }
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

const OPEN = '<script type="text/plain" id="pdfcraftSrc">';
const a = html.indexOf(OPEN);
if (a < 0 || html.indexOf(OPEN, a + 1) >= 0) throw new Error('pdfcraftSrc block not found exactly once');
const b = html.indexOf('</script>', a);
let pc = Buffer.from(html.slice(a + OPEN.length, b).trim(), 'base64').toString('utf8');
if (!pc.includes('id="ss-ocr"')) throw new Error('build V8.18 first (add-ocr.mjs)');
if (pc.includes('id="ss-docx"')) throw new Error('Scan to Word is already in this file');
const Q = patcher('editor');

pc = Q(pc, 'script', '<script id="ss-ribbon">', `<script id="ss-docx">\n${read('docx.js')}</script>\n<script id="ss-ribbon">`);

pc = Q(pc, 'ribbon icon', "    undo: '<path d=\"M9 14 4 9l5-5\"/>",
  "    word: '<path d=\"M6 3h8l4 4v14H6z\"/><path class=\"a\" d=\"m8.5 11 1.3 6 1.7-4.5 1.7 4.5 1.3-6\"/>',\n    undo: '<path d=\"M9 14 4 9l5-5\"/>");
pc = Q(pc, 'ribbon button', '["ocrx", "Remove Recognized Text",',
  `["word", "Scan to Word", "word", () => window.SSDocx && SSDocx.toWord(), { big: 1, title: "Save the text of these pages as a new, editable Word document (.docx). Scans are read with OCR first." }],
        ["ocrx", "Remove Recognized Text",`);
pc = Q(pc, 'landing list', '<span><b>Recognize text in scans</b>Make picture-only pages searchable and copyable (OCR)</span>',
  '<span><b>Recognize text in scans</b>Make scans searchable, or save their text as an editable Word document</span>');

pc = Q(pc, 'brand', 'const BRAND = "PdfCraft V1.5";', 'const BRAND = "PdfCraft V1.6";');
pc = Q(pc, 'footer version', 'Author “PdfCraft V1.5”', 'Author “PdfCraft V1.6”');
pc = Q(pc, 'logo version', '<span class="ver">v1.5</span>', '<span class="ver">v1.6</span>');

const enc = Buffer.from(pc, 'utf8').toString('base64');
html = html.slice(0, a + OPEN.length) + '\n' + enc + '\n' + html.slice(b);

html = P(html, 'title', '<title>Statement Studio · Offline · V8.18</title>', '<title>Statement Studio · Offline · V8.19</title>');
html = P(html, 'SSX version', "version: '8.18',", "version: '8.19',");

writeFileSync(out, html, 'utf8');
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1048576).toFixed(1)} MB)`);

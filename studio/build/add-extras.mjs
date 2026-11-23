// Builds Statement Studio V8.20 from V8.19: White-out / Black-out, Shapes, Sticky notes,
// Insert image, Export pages as images, Document properties.
//   node studio/build/add-extras.mjs <V8.19 index.html> <out.html>
// Injects build/extras/extras.{js,css} into the Edit PDFs tool (PdfCraft), adds a few small hooks
// to ss-tools (shares its page-view helpers as SSTools._k, lets boxes stretch freely, writes the new
// kinds of objects) and adds the buttons to the ribbon. Same exact-text patching as the other
// build scripts: every anchor must match exactly once, or the build stops.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: node add-extras.mjs <in.html> <out.html>'); process.exit(1); }
const read = (f) => readFileSync(join(here, 'extras', f), 'utf8');

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
if (!pc.includes('id="ss-docx"')) throw new Error('build V8.19 first (add-docx.mjs)');
if (pc.includes('id="ss-x2"')) throw new Error('the V8.20 extras are already in this file');
const Q = patcher('editor');

/* ---------- styles and the module (after ss-docx, before the ribbon that calls it) ---------- */
pc = Q(pc, 'styles', '</head>', `<style id="ss-x2-css">\n${read('extras.css')}</style>\n</head>`);
pc = Q(pc, 'script', '<script id="ss-ribbon">', `<script id="ss-x2">\n${read('extras.js')}</script>\n<script id="ss-ribbon">`);

/* ---------- ss-tools hooks ---------- */
pc = Q(pc, 'tools: own kinds', 'const OWN = { hl: "hl", ink: "ink", stamp: "stamp", sig: "sig" };',
  'const OWN = { hl: "hl", ink: "ink", stamp: "stamp", sig: "sig", wo: "wo", shape: "shape", note: "note", img: "img" };');
pc = Q(pc, 'tools: titles',
  '      n.title = a.type === "hl" ? `${a.kind}: “${(a.text || "").slice(0, 60)}”` : a.type === "stamp" ? `Stamp: ${a.spec.text || "picture"}` : a.type === "sig" ? (a.digital ? "Digital signature (signed when you download)" : "Signature") : "Drawing";',
  '      n.title = a.type === "hl" ? `${a.kind}: “${(a.text || "").slice(0, 60)}”` : a.type === "stamp" ? `Stamp: ${a.spec.text || "picture"}` : a.type === "sig" ? (a.digital ? "Digital signature (signed when you download)" : "Signature") : "Drawing";\n' +
  '      if (window.SSX2) { const t2 = SSX2.title(a); if (t2) n.title = t2; }');
pc = Q(pc, 'tools: resize handles', 'if (a.type === "stamp" || a.type === "sig") {',
  'if (a.type === "stamp" || a.type === "sig" || a.type === "wo" || a.type === "shape" || a.type === "img") {');
pc = Q(pc, 'tools: removed labels', '({ hl: "a highlight", ink: "a drawing", stamp: "a stamp", sig: "a signature" })',
  '({ hl: "a highlight", ink: "a drawing", stamp: "a stamp", sig: "a signature", wo: "a white-out", shape: "a shape", note: "a note", img: "a picture" })');

// white-outs and shapes stretch freely (width and height apart); stamps, signatures and pictures keep their shape
pc = Q(pc, 'tools: free resize',
  `    const start = evPx(e), w0 = n.offsetWidth, h0 = n.offsetHeight;
    drag = { kind: "resize" };
    const move = (ev) => { const p = evPx(ev), k = Math.max(0.2, (w0 + p[0] - start[0]) / w0); n.style.width = w0 * k + "px"; n.style.height = h0 * k + "px"; };
    const up = (ev) => {
      removeEventListener("pointermove", move); removeEventListener("pointerup", up); drag = null;
      const p = evPx(ev), k = Math.max(0.2, (w0 + p[0] - start[0]) / w0);`,
  `    const start = evPx(e), w0 = n.offsetWidth, h0 = n.offsetHeight;
    const free = a.type === "wo" || a.type === "shape", r0 = rectPx(bbox(a));
    drag = { kind: "resize" };
    const move = (ev) => {
      const p = evPx(ev);
      if (free) { n.style.width = Math.max(6, r0.w + p[0] - start[0]) + "px"; n.style.height = Math.max(6, r0.h + p[1] - start[1]) + "px"; return; }
      const k = Math.max(0.2, (w0 + p[0] - start[0]) / w0); n.style.width = w0 * k + "px"; n.style.height = h0 * k + "px";
    };
    const up = (ev) => {
      removeEventListener("pointermove", move); removeEventListener("pointerup", up); drag = null;
      if (free) {
        const p = evPx(ev), cur = itemNow(); if (!cur) return;
        if (Math.hypot(p[0] - start[0], p[1] - start[1]) < 1) return MK.redraw();
        const W = Math.max(a.type === "wo" ? 3 : 0, r0.w + p[0] - start[0]), H = Math.max(a.type === "wo" ? 3 : 0, r0.h + p[1] - start[1]);
        const r = normR([...pxUser([r0.x, r0.y]), ...pxUser(snapPx([r0.x + W, r0.y + H]))]);
        return setAnnots(cur.uid, cur.annots.map((y) => (y.id === a.id ? { ...y, rect: r } : y)), null);
      }
      const p = evPx(ev), k = Math.max(0.2, (w0 + p[0] - start[0]) / w0);`);

pc = Q(pc, 'tools: write new kinds',
  `            paint(doc, page, await sigAP(doc, a, null), a.rect, a.R || 0);
          }
        } catch (e) { console.warn("annotation skipped", a, e); }`,
  `            paint(doc, page, await sigAP(doc, a, null), a.rect, a.R || 0);
          } else if (window.SSX2) await SSX2.write(doc, page, a, it);
        } catch (e) { console.warn("annotation skipped", a, e); }`);

// the page-view helpers, for ss-x2
pc = Q(pc, 'tools: share helpers', 'window.SSTools = { digitalSign, openP12, createId, myIds, writeAnnots,',
  `window.SSTools = { digitalSign, openP12, createId, myIds, writeAnnots,
    _k: { get drag() { return drag; }, set drag(v) { drag = v; }, get TL() { return TL; }, sel, P, saveP, store, author, esc, pane, swatches, css,
      evPx, evUser, pxUser, userPx, rectPx, normR, snapPx, placeAt, pageRot, itemNow, setAnnots, commitItem,
      xobj, baseDict, paint, imageRef, rotM, roundRect, modal, readFile, loadImg },`);

/* ---------- ribbon ---------- */
pc = Q(pc, 'ribbon icons', "    undo: '<path d=\"M9 14 4 9l5-5\"/>",
  `    whiteout: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect class="a" x="6.5" y="9" width="11" height="6" rx="1"/><path class="a" d="M8.5 12h7"/>',
    blackout: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="6.5" y="9" width="11" height="6" fill="currentColor"/>',
    srect: '<rect class="a" x="4" y="6" width="16" height="12" rx="1"/>',
    sellipse: '<ellipse class="a" cx="12" cy="12" rx="9" ry="6.5"/>',
    sline: '<path class="a" d="M4 19 20 5"/>',
    sarrow: '<path class="a" d="M4 20 19 5M11 5h8v8"/>',
    note: '<path d="M4 4h16v12h-6l-4 4v-4H4z"/><path class="a" d="M8 8.5h8M8 12h5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle class="a" cx="8.5" cy="9" r="1.8"/><path class="a" d="m3 17 5-5 4 4 3-3 6 6"/>',
    expimg: '<rect x="3" y="3" width="14" height="12" rx="2"/><path d="m3 12 4-4 3 3 2-2 5 5"/><path class="a" d="M19 12v9M16 18l3 3 3-3"/>',
    props: '<path d="M6 3h8l4 4v14H6z"/><path class="a" d="M9 11h6M9 14.5h6M9 18h4"/>',
    undo: '<path d="M9 14 4 9l5-5"/>`);

const WO = `["wo", "White-out", "whiteout", () => useTool("wo", () => SSX2.setWo("white")), { big: 1, tool: "wo:white", title: "Drag a box to cover part of the page with white (or the page’s own colour); type on top with Typewriter" }]`;
const BO = `["bo", "Black-out", "blackout", () => useTool("wo", () => SSX2.setWo("black")), { big: 1, tool: "wo:black", title: "Drag a black box over text: the text under it is taken out of the file" }]`;
const IMG = `["image", "Image", "image", () => window.SSX2 && SSX2.insertImage(), { big: 1, tool: "img", title: "Put a picture or logo on the page (JPG, PNG…); drag to move, corner to resize" }]`;
const NOTEB = `["note", "Note", "note", () => useTool("note"), { big: 1, tool: "note", title: "Add a sticky note: a comment that opens when clicked" }]`;
const EXP = (big) => `["expimg", "Export Images", "expimg", () => window.SSX2 && SSX2.exportImages(), { ${big ? "big: 1, " : ""}title: "Save pages as PNG or JPG pictures" }]`;
const PROPS = (big) => `["props", "Properties", "props", () => window.SSX2 && SSX2.properties(), { ${big ? "big: 1, " : ""}title: "Title, author, subject and keywords saved in the PDF" }]`;
const SH = (k, label, icon, big) => `["sh-${k}", "${label}", "${icon}", () => useTool("shape", () => SSX2.setShape("${k}")), { ${big ? "big: 1, " : ""}tool: "shape:${k}" }]`;

pc = Q(pc, 'ribbon: Home › Tools', '["text", "Typewriter", "typewriter", () => useTool("text"), { big: 1, tool: "text", title: "Click anywhere and type; matches nearby text" }],',
  `["text", "Typewriter", "typewriter", () => useTool("text"), { big: 1, tool: "text", title: "Click anywhere and type; matches nearby text" }],\n        ${WO},`);
pc = Q(pc, 'ribbon: Home › Save', '["comp", "Compress", "zip", click("[data-cz-open]")]]],',
  `["comp", "Compress", "zip", click("[data-cz-open]")], ${EXP(false)}, ${PROPS(false)}]],`);
pc = Q(pc, 'ribbon: Edit › Objects', '["erase", "Delete Area", "erase", () => useTool("area"), { big: 1, title: "Select a section, then press Delete selection" }]]],',
  `["erase", "Delete Area", "erase", () => useTool("area"), { big: 1, title: "Select a section, then press Delete selection" }],\n        ${WO}, ${IMG}]],`);
pc = Q(pc, 'ribbon: Comment › Note', '["text", "Typewriter", "typewriter", () => useTool("text"), { big: 1, tool: "text" }]]],\n      ["Drawing",',
  `["text", "Typewriter", "typewriter", () => useTool("text"), { big: 1, tool: "text" }], ${NOTEB}]],\n      ["Drawing",`);
pc = Q(pc, 'ribbon: Comment › Shapes', '["eraser", "Eraser", "eraser", () => useTool("ink", () => T.ui.setEraser(true)), { big: 1, tool: "ink:eraser" }]]],',
  `["eraser", "Eraser", "eraser", () => useTool("ink", () => T.ui.setEraser(true)), { big: 1, tool: "ink:eraser" }]]],
      ["Shapes", [${SH("rect", "Rectangle", "srect", 1)}, ${SH("ellipse", "Ellipse", "sellipse", 1)}, ${SH("line", "Line", "sline")}, ${SH("arrow", "Arrow", "sarrow")}]],`);
pc = Q(pc, 'ribbon: Protect › Redact', '["erase", "Remove Area", "erase", () => useTool("area"), { big: 1, title: "Select a section and press Delete selection: it’s taken out of the file" }]]],',
  `${BO},\n        ["erase", "Remove Area", "erase", () => useTool("area"), { big: 1, title: "Select a section and press Delete selection: it’s taken out of the file" }]]],`);
pc = Q(pc, 'ribbon: Organize › Document', '["bmadd", "Add Bookmark", "bmadd", () => T.ui.addBookmark()]]],',
  `["bmadd", "Add Bookmark", "bmadd", () => T.ui.addBookmark()]]],\n      ["Document", [${PROPS(true)}, ${EXP(true)}]],`);
pc = Q(pc, 'ribbon: variants light up', 'on = tt === tool && (!sub || (tt === "hl" ? sub === hk : sub === "eraser" ? er : true))',
  'on = tt === tool && (!sub || (tt === "hl" ? sub === hk : sub === "eraser" ? er : window.SSX2 ? SSX2.sub(tt, sub) : true))');
pc = Q(pc, 'ribbon: follow option changes', `document.addEventListener("change", (e) => { if (e.target.matches('input[name="tlhk"],#tl-eraser')) paintState(); });`,
  `document.addEventListener("change", (e) => { if (e.target.matches('input[name="tlhk"],#tl-eraser,[data-rbsync]')) paintState(); });\n  document.addEventListener("x2-sync", paintState);`);

/* ---------- start screen and versions ---------- */
pc = Q(pc, 'landing list', 'Retype text, fill forms, highlight, stamp, sign, move sections',
  'Retype text, white-out, fill forms, highlight, shapes, notes, pictures, stamp, sign');
pc = Q(pc, 'brand', 'const BRAND = "PdfCraft V1.6";', 'const BRAND = "PdfCraft V1.7";');
pc = Q(pc, 'footer version', 'Author “PdfCraft V1.6”', 'Author “PdfCraft V1.7”');
pc = Q(pc, 'logo version', '<span class="ver">v1.6</span>', '<span class="ver">v1.7</span>');

const enc = Buffer.from(pc, 'utf8').toString('base64');
html = html.slice(0, a + OPEN.length) + '\n' + enc + '\n' + html.slice(b);

html = P(html, 'title', '<title>Statement Studio · Offline · V8.19</title>', '<title>Statement Studio · Offline · V8.20</title>');
html = P(html, 'SSX version', "version: '8.19',", "version: '8.20',");

writeFileSync(out, html, 'utf8');
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1048576).toFixed(1)} MB)`);

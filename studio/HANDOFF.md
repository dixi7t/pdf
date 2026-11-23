# Statement Studio V8.13: handoff for building a Windows .exe

## What this is
Statement Studio is an offline, single-file web app: one HTML file (~43 MB) that converts bank
statements (PDF, scanned PDF, CSV/Excel, QBO/OFX) into QuickBooks `.qbo` and Excel. Everything
runs locally in the page: no server, no network calls. The goal is to wrap it as a Windows desktop
app (`.exe`) **without changing how it works**.

## Files
| Path | What it is |
|---|---|
| `Studio_V8_13.html` | **The finished app.** This is the file to package. |
| `Studio_V8_12_original.html` | Untouched previous version, the input to the build. |
| `build/build.mjs` | Builds V8.13 from V8.12: applies small exact-text patches (it stops if an anchor isn't found exactly once) and injects the files below. |
| `build/theme-pro.css` | Professional neutral theme (overrides the original styles). |
| `build/ssx.js`, `build/ssx.css` | V8.13 features: bank directory, payee cleanup, saved CSV layouts, "show on PDF". |
| `build/prep-banks.mjs` | Converts Intuit's institution list into `data/banks.json`. |
| `data/intuit_fidir_qm2400.txt` | Intuit's public institution list (source data). |
| `data/banks.json` | Compact bank list embedded into the app. |
| `test/make-test-files.mjs` | Makes a fake test PDF and CSV in `test/files/`. |
| `test/serve.mjs` | Tiny local static server for testing (`http://127.0.0.1:8137`). |

### Rebuilding the HTML (Node.js 22+)
```
node build/prep-banks.mjs data/intuit_fidir_qm2400.txt data/banks.json   # only if the bank list changes
node build/build.mjs Studio_V8_12_original.html Studio_V8_13.html
```
To change features or styling, edit the files in `build/` and rebuild. Don't hand-edit
`Studio_V8_13.html`: it's generated, and the build would overwrite the edits.

## Packaging as an .exe: requirements
1. **Load `Studio_V8_13.html` as-is** in a Chromium-based window. It uses WebAssembly
   (Tesseract, ONNX Runtime), Web Workers built from Blob URLs, `localStorage`, the View
   Transitions API, `DataTransfer` and file inputs. Electron, or Tauri on WebView2, both support these.
2. **Stay fully offline.** Don't add analytics, auto-update calls, CDN fonts or remote scripts. The
   app's promise is "nothing leaves this computer".
3. **Keep `localStorage` persistent** between launches. The app stores learned bank formats, payee
   rules, saved CSV layouts, bank picks and conversion history there. Use a fixed app identity
   (Electron: fixed `app.setName` / `userData` path; Tauri: fixed `identifier`) so the data isn't lost.
4. **Downloads must work.** The app saves `.qbo`, `.xlsx`, `.csv` and `.zip` files through
   `<a download>` with Blob URLs. In Electron, handle `will-download` (or let the default
   Save dialog appear). In Tauri, make sure WebView2 downloads are allowed.
5. **File open:** drag-and-drop and the file picker are already handled by the page.
6. **Allow `blob:` and `data:` URLs** in any Content-Security-Policy you add: the app creates
   workers and loads embedded models from them.
7. **Windows on ARM:** the developer's PC is ARM64. Ship an x64 build (it runs under emulation)
   or produce both x64 and arm64 builds.

### Suggested approach
- **Electron** (simplest, most predictable): `BrowserWindow` → `loadFile('Studio_V8_13.html')`,
  `contextIsolation: true`, `nodeIntegration: false`, no preload API needed. Package with
  electron-builder (NSIS installer or portable `.exe`). Expect ~150 MB installed.
- **Tauri 2** (smaller): put the HTML in the frontend dist folder, no Rust commands needed.
  Expect ~10 MB plus the 43 MB HTML; needs the WebView2 runtime (built into Windows 11).

Block navigation away from the app page (open external links in the default browser instead),
and disable devtools in release builds.

## How to check the .exe works
1. Run `node test/make-test-files.mjs`.
2. Launch the .exe and unlock it.
3. Drop in `test/files/test-chase-jan2026.pdf`. Expect 8 transactions, Bank name "Chase",
   Bank ID `10898`, payee names filled in, and totals validated.
4. Click ⌖ on a row. The statement page should open on the right with that line highlighted.
5. Rename a payee, e.g. "Amazon" to "Amazon.com". The other Amazon row should follow.
6. Download `.qbo`. It must contain `<INTU.BID>10898` and `<NAME>Amazon.com`.
7. Drop in `test/files/test-bank-export.csv`, open "Column layout", set Description to the
   "Description" column, then Save layout & re-read. Close and reopen the .exe, drop the CSV again,
   and the saved layout must apply automatically (this proves `localStorage` persists).
8. Try a scanned PDF with OCR on. It must work with the network disconnected.

## Notes and risks
- **The PINs are in the page's JavaScript.** Anyone can read them by opening the file. In an .exe
  the PIN lock deters casual users but is not real security. Don't rely on it to protect data.
- **Third-party components** (all embedded in the HTML): pdf.js (Apache-2.0),
  Tesseract.js (Apache-2.0), PaddleOCR models (Apache-2.0), ONNX Runtime Web (MIT),
  SheetJS (Apache-2.0), JSZip (MIT/GPLv3 dual), and PdfCraft (the embedded PDF editor; check its
  licence). Include their licence notices with the app.
- **Bank list:** `data/intuit_fidir_qm2400.txt` comes from Intuit's public server
  (`ofx-prod-filist.intuit.com`). It's fine for your own use. Check Intuit's terms before
  distributing the app to other people.
- **No code from other commercial converters is included.** The bank list comes from Intuit and
  all feature code was written new.

## V8.16: file compressor
`build/add-compressor.mjs` turns the V8.15 `index.html` into V8.16. It decodes the embedded
PdfCraft editor (`#pdfcraftSrc`), injects `build/compress/compress.{css,html,js}` with exact-text
patches, and encodes it back. Uses only what is already embedded (pdf-lib, PDF.js, JSZip) plus
browser canvas and `DecompressionStream`; no network. PDF hand-off to Convert is never compressed.

## V8.17: edit text, fill forms, add text (PDF's own fonts)
`build/add-fill.mjs` turns the V8.16 `index.html` into V8.17. It decodes `#pdfcraftSrc`, adds small hooks to the
check-mark page view (`window.MK`, incl. `refresh()` to re-render the page in place), injects `build/fill/fill.{css,js}`,
and encodes it back. `fill.js` contains: a PDF font reader (ToUnicode/Encoding/Differences, widths, subset glyph
availability), a content-stream parser and text-state interpreter, the line editor (old show operators are replaced by
pen moves `[-w] TJ`, new text appended in the same font/Tm/CTM/colour), exact form appearances (/DA font from /DR,
comb, quadding, wrap) before pdf-lib's flatten, and added text drawn in a matched page font. Edits and answers live on
each source file (`src.edits`, `src.fill`); added text on each page (`item.texts`, undo-safe). No network, no new libraries.
Also in V8.17: `tools.js` (highlight/underline/strike-out, ink, stamps, signatures, move/delete areas, bookmarks,
grid/rulers, Digital IDs; written as PDF annotations, page content and the outline), `ribbon.js` (the tabbed top bar),
`sign.js` (wraps `makeFile` last, after compression: adds a /Sig field and fills /ByteRange + /Contents with a detached
PKCS#7 made by node-forge, `forge.bundle.js`, BSD-3-Clause — add its licence notice when distributing).

## V8.18: Recognize Text (OCR layer for picture-only pages)
`build/add-ocr.mjs` turns the V8.17 `index.html` into V8.18. In the main page it exposes `window.__ssOcrWords(blob)` next to
`getOcrWorker` (best built-in Tesseract model; tries 0/90/270/180° turns when the upright read is weak, scored with
`ocrOrientationScore`, and maps word baselines back to the picture's own pixels) and answers `ss-ocr` messages from the
PdfCraft frame with `ss-ocr-result`. In the frame, `build/ocr/ocr.js` (`window.SSOcr`) renders each picture-only page
(pdf.js text content under 20 characters, or an image source) at 300 dpi, sends it for OCR, stores words on the source
(`src.ocr`: page index → words in PDF user space, or picture pixels for image sources) and, in `makeFile` after
`SSFill.apply`, writes them as invisible Helvetica text (Tr 3, Tm per word, Tz to fit the word width). Edit Text already
ignores invisible text, so recognized words aren't retypable. No network, no new libraries.

## V8.19: Scan to Word
`build/add-docx.mjs` turns V8.18 into V8.19 by injecting `build/ocr/docx.js` (`window.SSDocx`) after `ss-ocr` and adding a
ribbon button (Edit › Scans). For each page: picture-only pages use the OCR lines stored by `SSOcr.ocrItem` (reading order,
with top/bottom in the upright picture, now also returned by `__ssOcrWords`); text pages are grouped into lines from pdf.js
text content. Lines become paragraphs (gap > 0.8 × median line height starts a new one; otherwise a line break), pages are
separated by page breaks, and a minimal WordprocessingML package is zipped with the embedded JSZip. Text only, no images.

## V8.20: white-out, shapes, notes, pictures, export images, properties
`build/add-extras.mjs` turns V8.19 into V8.20. It injects `build/extras/extras.{js,css}` (`window.SSX2`) before `ss-ribbon`, and
patches `ss-tools` in a few places: `SSTools._k` shares the page-view helpers (geometry, selection, overlay, modal, appearance
streams), `OWN` gets the new kinds (`wo`, `shape`, `note`, `img`, all stored in `item.annots`, so undo, move, Delete and moved areas
already work), white-outs and shapes resize freely (pictures keep their aspect), and `writeAnnots` hands the new kinds to
`SSX2.write`. White-outs are painted in a `buildPdf` wrapper (after edits and moved areas, before page numbers, typed text and
comments). With text removal on, `SSX2.stripText` re-reads the page with `readText`, and every glyph whose centre lies in a box is
replaced by a TJ kern of its exact advance (1- or 2-byte codes re-encoded as hex), so the remaining text keeps its position. Shapes
are Square / Circle / Line annotations, notes are Text + Popup, pictures are form XObjects drawn into the page. Export Images
renders `makeFile` output with PDF.js (no title, so it's never signed or compressed) and zips with JSZip. Document properties are
set in the same `buildPdf` wrapper. The ribbon gets the new buttons; `SSX2.sub()` lights the right variant. No network, no new libraries.

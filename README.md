# Statement Studio · macOS Application

**Statement Studio** has been packaged into a native macOS desktop application (`Statement Studio.app`) for Apple Silicon / Intel MacBooks.

---

## 🚀 How to Run the App

You can launch the app directly:
```bash
open "/Users/dixit/.gemini/antigravity/scratch/statement-studio/Statement Studio.app"
```

### Install to Applications (Recommended)
To make it appear in Launchpad, Spotlight, and your Applications folder, copy it:
```bash
cp -R "/Users/dixit/.gemini/antigravity/scratch/statement-studio/Statement Studio.app" /Applications/
```

Or open the folder in Finder and drag `Statement Studio.app` into `/Applications`:
```bash
open "/Users/dixit/.gemini/antigravity/scratch/statement-studio"
```

---

## 🌟 Key Features of the Native App

1. **Native Performance & Lightweight Footprint**:
   - Built with native Swift and WebKit (`WKWebView`).
   - Uses zero bulky dependencies (no heavy Electron runtime). Instant launch times and low memory footprint.
2. **100% Offline & Private**:
   - The entire 42MB engine (PDF processing, OCR, SheetJS, ONNX runtime) runs strictly locally inside the app bundle with offline file permissions.
3. **Seamless File Uploads & Drag-and-Drop**:
   - Native macOS open panels for selecting statement files.
   - Direct Finder drag-and-drop onto the drop zone.
4. **Native Export / Download Handling**:
   - Exporting statements, Excel spreadsheets, or CSV files triggers native macOS Save sheets (`NSSavePanel`) so you can choose where to save files.
5. **Modern Mac Glass Window & Menu Bar**:
   - Dark titlebar matching the app's dark glass theme.
   - Standard macOS keyboard shortcuts: `Cmd+Q` (Quit), `Cmd+W` (Close), `Cmd+R` (Reload), `Cmd+0/+/-` (Zoom), `Cmd+A/C/V/Z` (Edit).
6. **Retina App Icon**:
   - Custom 1024×1024 Retina squircle application icon bundled into `AppIcon.icns`.

---

## 🛠️ Rebuilding / Updating in the Future

If you ever update the HTML tool with a newer version (e.g., `Studio_V8_13.html`), simply replace `index.html` in this directory and run:
```bash
cd /Users/dixit/.gemini/antigravity/scratch/statement-studio
./build.sh
```

---

## 🆕 V8.16 — File compressor in Edit PDFs

**Edit PDFs → Compress files** (on the start screen, or the button next to *Add files*) shrinks files on this computer, nothing is uploaded:

| File | What happens |
|---|---|
| **PDF** | Pictures and scans inside are resized and re-saved; text stays selectable. *Max* turns pages into pictures for the smallest file. |
| **Photos** (JPG, PNG, WebP, GIF, BMP, HEIC on Mac) | Resized and re-saved; location and camera data removed. Transparent images are kept transparent. |
| **Word, Excel, PowerPoint** (and OpenDocument, EPUB) | Same format; the pictures inside are shrunk and the file is repacked. |
| **Anything else** (CSV, TXT, logs, …) | Packed into a smaller `.zip`. |

Strength: Light · Balanced · Strong · Max. A file is never made bigger: if nothing can be saved, the original is kept.
In the editor itself, **Make PDF smaller** compresses the PDF when you download it.

Rebuild V8.16 from V8.15: `node studio/build/add-compressor.mjs <V8.15 index.html> index.html` (sources in `studio/build/compress/`).

---

## 🆕 V8.17 — A full PDF editor: ribbon, edit text, forms, comments, stamps, digital signatures

**Edit PDFs** now has a ribbon across the top (**Home · Edit · Comment · Protect · Organize · View**) with every feature one click away. It follows you into the page editor (double-click any page).

| Tab | What's there |
|---|---|
| **Home** | Hand, Edit Text, Typewriter · zoom, rotate, undo · Highlight, Underline, Strike-out, Pencil, Stamp · Sign Document · Download, Compress |
| **Edit** | **Edit Text** (retype any line in the PDF's own embedded font, size, colour and position) · Add Text · Fill Form · **Move Area / Delete Area** (select a section and drag it; vector content moves, text stays real text, nothing is whited out) · Page numbers, Watermark, Check marks |
| **Comment** | Highlight / Underline / Strike-out (snap to the letters; real PDF comments) · Typewriter · Pencil & Eraser · **Stamps**: 18 standard (APPROVED, RECEIVED + date, REVIEWED by name/time, PAID, VOID, CONFIDENTIAL, SIGN HERE…) and your own text or picture stamps, saved for reuse |
| **Protect** | **Sign Document** (draw, type or upload a signature) · **Digital IDs**: create a self-signed ID or import a .pfx/.p12; signing adds a real PKCS#7 / SHA-256 digital signature that Acrobat and other viewers verify · Hide SSN/EIN · Remove Area |
| **Organize** | Add files, blank page, duplicate, delete · rotate (saved in the PDF), reverse, save picked, split · **Bookmarks** (add, rename, nest, reorder; existing ones are imported) |
| **View** | Zoom, fit, full screen · **Grid** (⅛″, ¼″, ½″, 5 mm, 1 cm) with **Snap** · **Rulers** (in/cm) · rotate |

Forms are filled in the font and size each field declares (comb boxes, alignment, wrapping). Highlights, drawings and stamps are saved as real PDF comments; signatures are drawn into the page.
Digital signing happens last, after compression, and asks for the Digital ID's password. A self-signed ID shows as "valid, identity not yet trusted" until the reader trusts your certificate (Export certificate in Digital IDs). Digital IDs, signatures and stamps are stored in this browser, the ID locked with your password: use **Export .pfx** to back it up.

**Protected PDFs** (e.g. government forms and Acrobat Sign / DocuSign copies that open without a password but block changes) are unlocked on this computer when added, so their text, forms and typewriter comments can be edited; if the file needs an open password, the one you type is used. Any existing digital signature on such a file is no longer valid in the edited copy (it's kept as a picture only).
**Typewriter comments** already in a PDF (FreeText, e.g. typed in PDF-XChange or Acrobat) can be retyped with Edit Text, in their own font and size; clearing one removes it.

Limits: a character missing from a PDF's embedded font subset is drawn in the closest standard font. Text in Type3 fonts or inside graphics objects can't be retyped (use Typewriter). Pages rebuilt by SSN masking can't keep text edits.

Rebuild V8.17 from V8.16: `node studio/build/add-fill.mjs <V8.16 index.html> index.html` (sources in `studio/build/fill/`; `forge.bundle.js` is node-forge (BSD-3-Clause, see `LICENSE-forge.txt`), rebuilt with `make-forge-bundle.mjs`).

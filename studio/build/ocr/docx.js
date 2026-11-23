/* Scan to Word (V8.19): turn pages into a new, editable Word document (.docx).
   Picture-only pages are read with Recognize Text first (OCR); pages that already have real text are
   read from the PDF. The text goes into a plain document (Calibri, normal paragraphs, one page break
   between pages) that can be edited freely. It's a retyped copy of the words: no pictures, logos,
   signatures or layout of the original are carried over. Made on this computer with JSZip. */
(function () {
  "use strict";
  const O = window.SSOcr, MK = window.MK;
  if (!O) return;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

  /* ---------- lines of a page with real text (pdf.js), in reading order ---------- */
  async function textLines(src, idx) {
    const page = await src.pdfjs.getPage(idx + 1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const bits = [];
    for (const i of tc.items) {
      if (!i.str || !i.str.trim()) continue;
      const [x, y] = vp.convertToViewportPoint(i.transform[4], i.transform[5]);
      const h = Math.max(4, i.height || Math.hypot(i.transform[2], i.transform[3]));
      bits.push({ s: i.str, x, y, h, w: i.width || 0 });
    }
    bits.sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    for (const b of bits) {
      const r = rows.find((r) => Math.abs(r.y - b.y) < Math.min(r.h, b.h) * 0.5);
      if (r) r.items.push(b); else rows.push({ y: b.y, h: b.h, items: [b] });
    }
    rows.sort((a, b) => a.y - b.y);
    return rows.map((r) => {
      r.items.sort((a, b) => a.x - b.x);
      let t = "", end = null;
      for (const b of r.items) {
        if (end != null && b.x - end > b.h * 0.25 && !/\s$/.test(t) && !/^\s/.test(b.s)) t += " ";
        t += b.s; end = b.x + b.w;
      }
      return { t: t.replace(/\s+/g, " ").trim(), top: r.y - r.h, bottom: r.y };
    }).filter((l) => l.t);
  }

  /* ---------- lines -> paragraphs (a bigger gap starts a new paragraph) ---------- */
  function paragraphs(lines) {
    if (!lines.length) return [];
    const hs = lines.map((l) => l.bottom - l.top).filter((h) => h > 0).sort((a, b) => a - b);
    const h = hs.length ? hs[Math.floor(hs.length / 2)] : 10;
    const out = [[lines[0].t]];
    for (let i = 1; i < lines.length; i++) {
      const gap = lines[i].top - lines[i - 1].bottom;
      if (gap > h * 0.8 || gap < -h * 2) out.push([lines[i].t]); else out[out.length - 1].push(lines[i].t);
    }
    return out;
  }

  /* ---------- the .docx ---------- */
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const para = (lines, rpr = "") => `<w:p>${lines.map((t, i) => `${i ? "<w:r><w:br/></w:r>" : ""}<w:r>${rpr}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`).join("")}</w:p>`;
  async function docx(pages, title) {
    let body = para([title], '<w:rPr><w:i/><w:color w:val="808080"/><w:sz w:val="18"/></w:rPr>');
    pages.forEach((ps, k) => {
      if (k) body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      body += ps.length ? ps.map((p) => para(p)).join("") : "<w:p/>";
    });
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`);
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>${esc(BRAND)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`);
    return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", compression: "DEFLATE" });
  }

  /* ---------- run it ---------- */
  async function toWord() {
    const open = MK && MK.V.open;
    let pool = open ? [MK.itemByUid(MK.V.uid)] : B.sel.size ? B.selected() : B.items;
    pool = pool.filter((it) => it && !it.blank && it.src);
    if (!pool.length) return toast(B.items.length ? "There are no pages with text to export." : "Add a PDF or a scan first.", "err");
    await run("Making a Word document…", async () => {
      const pages = []; let read = 0;
      for (let i = 0; i < pool.length; i++) {
        const it = pool[i];
        busy.step(`Page ${i + 1} of ${pool.length}…`);
        let lines;
        if (await O.needsOcr(it)) {
          if (!O.done(it) || !it.src.ocr.get(it.idx).lines) {
            if (!O.available()) throw new Error("reading scans needs Statement Studio (open this from the Edit PDFs tab)");
            busy.step(`Reading page ${i + 1} of ${pool.length}… (first use starts the OCR engine)`);
            await O.ocrItem(it); read++;
          }
          lines = it.src.ocr.get(it.idx).lines || [];
        } else lines = await textLines(it.src, it.idx);
        pages.push(paragraphs(lines));
      }
      const words = pages.flat(2).join(" ").split(/\s+/).filter(Boolean).length;
      if (!words) { busy.off(); return toast("No text was found on these pages.", "err"); }
      const files = [...new Set(pool.map((it) => it.src.name))];
      const title = `Text recognized from ${files.length === 1 ? files[0] : plural(files.length, "file")} (${plural(pool.length, "page")}). Retyped copy: edit freely.`;
      const name = baseName(pdfName($("#outname").value)) + " (text).docx";
      download(await docx(pages, title), name);
      busy.off();
      document.dispatchEvent(new Event("ss-ocr-changed"));
      toast(`Downloaded ${name} · ${plural(words, "word")} from ${plural(pool.length, "page")}. Open it in Word, Pages or Google Docs to edit.`, "ok");
    });
  }

  window.SSDocx = { toWord, paragraphs, textLines };
})();

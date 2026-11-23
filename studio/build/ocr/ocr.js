/* Recognize text (V8.18): OCR for scanned / picture-only pages.
   Reads each page with the OCR engine already built into Statement Studio (Tesseract, run by the
   parent page; the picture goes there by postMessage, nothing leaves this computer) and adds an
   INVISIBLE text layer (text render mode 3) under the page when the PDF is built. The page looks
   exactly the same; its text can now be searched, selected and copied, and read by Convert.
   The layer is not editable text: Edit Text skips invisible text on purpose, so a scan's words
   can't be retyped. Results live on the source file (src.ocr: Map pageIndex -> words), so undo,
   duplicate and reorder keep them. */
(function () {
  "use strict";
  const MK = window.MK;
  const { StandardFonts, pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize,
    setTextRenderingMode, TextRenderingMode, setTextMatrix, setCharacterSqueeze, showText } = PDFLib;

  const OCR_DPI = 300, OCR_MAX_SIDE = 5000, MIN_TEXT_CHARS = 20;

  /* ---------- talk to the OCR engine in Statement Studio ---------- */
  let seq = 0;
  const waiting = new Map();
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || e.data.type !== "ss-ocr-result") return;
    const w = waiting.get(e.data.id); if (!w) return;
    waiting.delete(e.data.id);
    if (e.data.ok) w.resolve(e.data.lines || []); else w.reject(new Error(e.data.error || "OCR failed"));
  });
  const available = () => parent !== window;
  function recognize(blob) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      parent.postMessage({ type: "ss-ocr", id, image: blob }, "*");
    });
  }

  /* ---------- does a page already have real text? ---------- */
  const textCache = new Map();   // "srcId:idx" -> Promise<number of characters>
  function textChars(src, idx) {
    if (src.kind !== "pdf") return Promise.resolve(0);
    const k = src.id + ":" + idx;
    if (!textCache.has(k)) textCache.set(k, (async () => {
      const page = await src.pdfjs.getPage(idx + 1);
      const tc = await page.getTextContent();
      return tc.items.reduce((n, i) => n + (i.str ? i.str.replace(/\s+/g, "").length : 0), 0);
    })().catch(() => 0));
    return textCache.get(k);
  }
  const done = (it) => !!(it && !it.blank && it.src && it.src.ocr && it.src.ocr.has(it.idx));
  async function needsOcr(it) {
    if (!it || it.blank || !it.src) return false;
    if (it.src.kind === "image") return true;
    if (it.src.kind !== "pdf") return false;
    return (await textChars(it.src, it.idx)) < MIN_TEXT_CHARS;
  }

  /* ---------- read one page ---------- */
  async function pageCanvas(it) {
    const c = document.createElement("canvas");
    if (it.src.kind === "image") {
      const s = Math.min(1, OCR_MAX_SIDE / Math.max(it.src.w, it.src.h));
      c.width = Math.round(it.src.w * s); c.height = Math.round(it.src.h * s);
      const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(it.src.bitmap, 0, 0, c.width, c.height);
      return { c, vp: null };
    }
    const page = await it.src.pdfjs.getPage(it.idx + 1);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(OCR_DPI / 72, OCR_MAX_SIDE / Math.max(v1.width, v1.height)) });
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, intent: "print" }).promise;
    return { c, vp };
  }

  // OCR words (baseline x0,y0 -> x1,y1 and size h, in pixels of the picture, y down) -> words on the page.
  //   pdf pages:   PDF user space of the source page (x, y = baseline start, a = angle, w = width, s = size)
  //   image pages: pixels of the original picture, y down (placed when the PDF is built, see apply)
  function place(lines, it, c, vp) {
    const words = [];
    const kx = it.src.kind === "image" ? it.src.w / c.width : 1;
    for (const ln of lines) {
      const ws = (ln.words || []).filter((w) => w.t && w.t.trim());
      ws.forEach((w, j) => {
        const text = w.t.trim() + (j < ws.length - 1 ? " " : "");
        if (!vp) { words.push({ t: text, px: w.x0 * kx, py: w.y0 * kx, px1: w.x1 * kx, py1: w.y1 * kx, sp: w.h * kx }); return; }
        const len = Math.hypot(w.x1 - w.x0, w.y1 - w.y0) || 1;
        const ux = (w.y1 - w.y0) / len, uy = -(w.x1 - w.x0) / len;          // "up" from the baseline, y down
        const p0 = vp.convertToPdfPoint(w.x0, w.y0), p1 = vp.convertToPdfPoint(w.x1, w.y1);
        const pt = vp.convertToPdfPoint(w.x0 + ux * w.h, w.y0 + uy * w.h);
        const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
        words.push({ t: text, x: p0[0], y: p0[1], a: Math.atan2(dy, dx), w: Math.hypot(dx, dy), s: Math.hypot(pt[0] - p0[0], pt[1] - p0[1]) });
      });
    }
    return words;
  }

  async function ocrItem(it) {
    const { c, vp } = await pageCanvas(it);
    try {
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const lines = await recognize(blob);
      const words = place(lines, it, c, vp);
      if (!it.src.ocr) it.src.ocr = new Map();
      it.src.ocr.set(it.idx, { kind: it.src.kind, words, at: Date.now() });
      return words.length;
    } finally { c.width = c.height = 0; }
  }

  /* ---------- write the invisible layer when the PDF is built ---------- */
  const WINANSI_FIX = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "...", "ﬁ": "fi", "ﬂ": "fl" };
  function encode(font, text) {
    let clean = text.normalize("NFKC").replace(/[‘’“”–—…ﬁﬂ]/g, (ch) => WINANSI_FIX[ch]);
    try { return { hex: font.encodeText(clean), text: clean }; }
    catch {
      clean = [...clean].map((ch) => { try { font.encodeText(ch); return ch; } catch { return "?"; } }).join("");
      return { hex: font.encodeText(clean), text: clean };
    }
  }
  function imagePlacement(page, src) {
    const L = imageLayout();                               // same layout buildPdf used
    const { width: W, height: H } = page.getSize();
    const k = Math.min((W - 2 * L.margin) / src.w, (H - 2 * L.margin) / src.h);
    const ox = (W - src.w * k) / 2, oy = (H - src.h * k) / 2;
    return (px, py) => [ox + px * k, oy + (src.h - py) * k, k];
  }
  async function apply(doc, items) {
    const todo = items.map((it, k) => [it, k]).filter(([it]) => done(it) && !(it.src.kind === "pdf" && it.src.locked));
    if (!todo.length) return;
    const pages = doc.getPages();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const [it, k] of todo) {
      const page = pages[k]; if (!page) continue;
      const r = it.src.ocr.get(it.idx); if (!r || !r.words.length) continue;
      const key = page.node.newFontDictionary("SSOcr", font.ref);
      const map = r.kind === "image" ? imagePlacement(page, it.src) : null;
      const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
      for (const w of r.words) {
        let x, y, a, wd, s;
        if (map) {
          const [x0, y0, kk] = map(w.px, w.py), [x1, y1] = map(w.px1, w.py1);
          x = x0; y = y0; a = Math.atan2(y1 - y0, x1 - x0); wd = Math.hypot(x1 - x0, y1 - y0); s = w.sp * kk;
        } else ({ x, y, a, w: wd, s } = w);
        if (!(s > 0.5) || !(wd > 0)) continue;
        const { hex, text } = encode(font, w.t);
        const body = text.replace(/ $/, "");
        const natural = font.widthOfTextAtSize(body || text, s);
        const squeeze = natural > 0 ? Math.min(1000, Math.max(10, (wd / natural) * 100)) : 100;
        const cos = Math.cos(a), sin = Math.sin(a);
        ops.push(setFontAndSize(key, s), setCharacterSqueeze(squeeze), setTextMatrix(cos, sin, -sin, cos, x, y), showText(hex));
      }
      ops.push(endText(), popGraphicsState());
      page.pushOperators(...ops);
    }
  }

  /* ---------- run it ---------- */
  async function start(scope) {
    if (!available()) return toast("Recognize Text needs Statement Studio (open this from the Edit PDFs tab).", "err");
    const open = MK && MK.V.open;
    let pool = open ? [MK.itemByUid(MK.V.uid)] : scope === "picked" || (scope !== "all" && B.sel.size) ? B.selected() : B.items;
    pool = pool.filter((it) => it && !it.blank && it.src);
    if (!pool.length) return toast(B.items.length ? "There are no pages to read." : "Add a PDF or a scan first.", "err");
    await run("Recognizing text…", async () => {
      busy.step("Checking which pages are pictures…");
      const targets = [];
      let had = 0, already = 0;
      for (const it of pool) {
        if (done(it)) { already++; continue; }
        if (await needsOcr(it)) targets.push(it); else had++;
      }
      // the same source page twice (duplicates) is read once
      const uniq = []; const seen = new Set();
      for (const it of targets) { const k = it.src.id + ":" + it.idx; if (!seen.has(k)) { seen.add(k); uniq.push(it); } }
      if (!uniq.length) {
        busy.off();
        if (already) return toast(`Text on ${already === 1 ? "this page was" : "these pages was"} already recognized. Download the PDF to search and copy it.`, "ok");
        return toast(had === 1 ? "This page already has real text, so there’s nothing to recognize." : "These pages already have real text, so there’s nothing to recognize.", "ok");
      }
      let words = 0;
      for (let i = 0; i < uniq.length; i++) {
        busy.step(`Reading page ${i + 1} of ${uniq.length}… (first use starts the OCR engine)`);
        words += await ocrItem(uniq[i]);
      }
      busy.off();
      paintBadges();
      if (open) MK.redraw();
      const extra = had ? ` ${plural(had, "page")} already had text and ${had === 1 ? "was" : "were"} left as is.` : "";
      toast(words
        ? `Recognized ${plural(words, "word")} on ${plural(uniq.length, "page")}. The pages look the same; in the downloaded PDF their text can be searched, selected and copied.${extra}`
        : `No text was found on ${uniq.length === 1 ? "this page" : "these pages"}.${extra}`, words ? "ok" : "err");
    });
  }
  function clear() {
    let n = 0;
    const pool = MK && MK.V.open ? [MK.itemByUid(MK.V.uid)] : B.sel.size ? B.selected() : B.items;
    for (const it of pool) if (done(it)) { it.src.ocr.delete(it.idx); n++; }
    paintBadges();
    toast(n ? `Removed recognized text from ${plural(n, "page")}.` : "No recognized text to remove here.", n ? "ok" : "");
  }

  /* ---------- page tiles: a small "Text recognized" badge ---------- */
  function paintBadges() {
    if (!B.el) return;
    for (const card of B.el.querySelectorAll(".card")) {
      const it = B.items.find((i) => i.uid === card.dataset.uid);
      const on = done(it), box = card.querySelector(".sheetbox"); if (!box) continue;
      let b = box.querySelector(".ocr-badge");
      if (on && !b) { b = document.createElement("span"); b.className = "ocr-badge"; b.textContent = "Aa"; b.title = "Text recognized (OCR): searchable and copyable in the downloaded PDF"; box.appendChild(b); }
      else if (!on && b) b.remove();
    }
  }
  if (B.el) new MutationObserver(() => paintBadges()).observe(B.el, { childList: true });

  /* ---------- Edit Text on a picture-only page: say why nothing is editable ---------- */
  if (MK && window.SSFill) {
    const hint = MK.$m("mk-hint");
    const orig = SSFill.layer;
    let ticket = 0;
    SSFill.layer = function (it) {
      const res = orig.apply(this, arguments);
      const mine = ++ticket;
      if (MK.el.dataset.tool === "edit" && it && !it.blank && it.src) {
        needsOcr(it).then((pic) => {
          if (!pic || mine !== ticket || MK.el.dataset.tool !== "edit") return;
          hint.innerHTML = done(it)
            ? "This page is a picture (a scan or photo). Its text was recognized, so it can be searched and copied in the downloaded PDF, but a picture’s words can’t be retyped. Use <b>Typewriter</b> to add your own text on top."
            : "This page is a picture (a scan or photo), so there’s no text here to retype. <button type=\"button\" class=\"ocr-hint-btn\">Recognize text</button> makes it searchable and copyable · use <b>Typewriter</b> to add your own text on top.";
          const b = hint.querySelector(".ocr-hint-btn"); if (b) b.onclick = () => start();
        });
      }
      return res;
    };
  }

  window.SSOcr = { start, clear, apply, needsOcr, done };
})();

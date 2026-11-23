/* Edit text, fill forms and add text — in the PDF's own fonts (V8.17).
   Lives in the same page view as check marks (window.MK, exposed by ss-marks).

   • Edit text: every line of text on a page can be clicked and retyped. The
     page's content stream is parsed (fonts, sizes, positions, colours); the
     old glyphs are taken out (their advance is kept, so nothing else moves)
     and the new text is written with the SAME embedded font, size, spacing,
     colour and position. Characters the embedded font doesn't contain fall
     back, one by one, to the closest standard font.
   • Forms: text boxes, checkboxes, radios, dropdowns and lists become live
     inputs. Text answers are drawn with the font and size the form itself
     asks for (its /DA and /DR), honouring alignment, comb boxes and
     multi-line wrapping, then the form is flattened.
   • Add text: click anywhere and type. By default the new text copies the
     font, size and colour of the nearest text on the page (and snaps to its
     baseline), so it blends in.
   • The page view is rendered from the real output, so what you see is what
     you download. */
(function () {
  "use strict";
  const MK = window.MK;
  if (!MK) return;
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFNumber, PDFRawStream, StandardFonts, rgb,
    decodePDFRawStream, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = PDFLib;

  const LH = 1.2;
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };
  const N = (k) => PDFName.of(k);
  const f4 = (n) => String(Math.round((+n || 0) * 1e4) / 1e4);
  const nameOf = (o) => (o instanceof PDFName ? o.decodeText() : "");
  const numOf = (o) => (o instanceof PDFNumber ? o.asNumber() : typeof o === "number" ? o : NaN);
  const latin1 = (b) => { let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };
  const enc = new TextEncoder();
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  let idSeq = 0;
  const newId = () => "t" + Date.now().toString(36) + (++idSeq);

  /* ================= standard fonts ================= */
  const STDCSS = {
    Helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
    Times: '"Times New Roman", Times, "Liberation Serif", serif',
    Courier: '"Courier New", Courier, "Liberation Mono", monospace',
  };
  const STD = {};                                 // std name -> PDFFont (metrics only)
  const stdReady = (async () => {
    const d = await PDFDocument.create();
    for (const k of Object.keys(StandardFonts)) if (!/Symbol|Zapf/.test(k)) STD[StandardFonts[k]] = await d.embedFont(StandardFonts[k]);
  })().catch((e) => console.warn("standard fonts", e));
  // the standard font that looks most like a PDF font
  function stdFor(name, flags = 0) {
    const n = name || "";
    const bold = /bold|black|heavy|semibold|demi|,b$/i.test(n) || !!(flags & (1 << 18));
    const ital = /italic|oblique|,i$|bi$/i.test(n) || !!(flags & 64);
    const fam = /courier|mono|consol|typewriter|^cour/i.test(n) || (flags & 1) ? "Courier"
      : (/times|serif|roman|georgia|garamond|cambria|book|minion|caslon|tiro|palatino|century/i.test(n) && !/sans/i.test(n)) || ((flags & 2) && !/sans|arial|helv|calibri|verdana|tahoma/i.test(n)) ? "Times" : "Helvetica";
    const T = { Helvetica: ["Helvetica", "HelveticaBold", "HelveticaOblique", "HelveticaBoldOblique"],
      Times: ["TimesRoman", "TimesRomanBold", "TimesRomanItalic", "TimesRomanBoldItalic"],
      Courier: ["Courier", "CourierBold", "CourierOblique", "CourierBoldOblique"] }[fam];
    return { std: StandardFonts[T[(bold ? 1 : 0) + (ital ? 2 : 0)]], fam, bold, ital };
  }
  // standard-14 font names (and their common aliases) used without embedding
  const STD14 = /^(Helvetica|Arial|ArialMT|Times|TimesNewRoman|Courier|CourierNew|Helv|TiRo|Cour)/i;

  /* ================= fonts inside a PDF ================= */
  function streamBytes(s) {
    if (!s) return new Uint8Array(0);
    if (typeof s.getUnencodedContents === "function") return s.getUnencodedContents();
    if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
    return s.getContents();
  }
  const utf16 = (h) => { h = h.padEnd(Math.ceil(h.length / 4) * 4, "0"); let s = ""; for (let i = 0; i < h.length; i += 4) s += String.fromCharCode(parseInt(h.substr(i, 4), 16)); return s; };
  function parseCMap(txt, map) {
    let m;
    const reC = /beginbfchar([\s\S]*?)endbfchar/g;
    while ((m = reC.exec(txt))) for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(p[1], 16), utf16(p[2]));
    const reR = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = reR.exec(txt))) for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(p[1], 16), hi = parseInt(p[2], 16);
      if (!(hi >= lo) || hi - lo > 65535) continue;
      if (p[3] !== undefined) {
        const base = utf16(p[3]);
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + c - lo));
      } else [...p[4].matchAll(/<([0-9a-fA-F]*)>/g)].forEach((x, i) => map.set(lo + i, utf16(x[1])));
    }
  }
  // glyph names -> characters (enough for Latin text)
  const GLYPH = (() => {
    const g = new Map();
    "space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at"
      .split(" ").forEach((n, i) => g.set(n, String.fromCharCode(32 + i)));
    for (let i = 0; i < 26; i++) { g.set(String.fromCharCode(65 + i), String.fromCharCode(65 + i)); g.set(String.fromCharCode(97 + i), String.fromCharCode(97 + i)); }
    "bracketleft backslash bracketright asciicircum underscore grave".split(" ").forEach((n, i) => g.set(n, String.fromCharCode(91 + i)));
    "braceleft bar braceright asciitilde".split(" ").forEach((n, i) => g.set(n, String.fromCharCode(123 + i)));
    ("nbspace exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot sfthyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown " +
      "Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls " +
      "agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis")
      .split(" ").forEach((n, i) => g.set(n, String.fromCharCode(0xa0 + i)));
    Object.entries({ quoteright: "’", quoteleft: "‘", quotedblleft: "“", quotedblright: "”", quotesinglbase: "‚", quotedblbase: "„", endash: "–", emdash: "—", bullet: "•", ellipsis: "…", Euro: "€", trademark: "™", dagger: "†", daggerdbl: "‡", perthousand: "‰", minus: "−", fi: "ﬁ", fl: "ﬂ", florin: "ƒ", circumflex: "ˆ", tilde: "˜", Scaron: "Š", scaron: "š", Zcaron: "Ž", zcaron: "ž", OE: "Œ", oe: "œ", Ydieresis: "Ÿ", guilsinglleft: "‹", guilsinglright: "›", dotlessi: "ı", hyphen: "-", space: " " })
      .forEach(([k, v]) => g.set(k, v));
    return g;
  })();
  const glyphChar = (n) => GLYPH.get(n) || (/^uni([0-9A-F]{4})$/i.test(n) ? String.fromCharCode(parseInt(n.slice(3), 16)) : /^u([0-9A-F]{4,6})$/i.test(n) ? String.fromCodePoint(parseInt(n.slice(1), 16)) : /^[a-zA-Z]$/.test(n) ? n : undefined);
  const DEC = {};
  const decoder = (label) => DEC[label] || (DEC[label] = safe(() => new TextDecoder(label), null));
  function baseEncoding(name) {
    const out = new Map();
    if (name === "WinAnsiEncoding" || name === "MacRomanEncoding") {
      const d = decoder(name === "WinAnsiEncoding" ? "windows-1252" : "macintosh");
      for (let c = 32; c < 256; c++) { if (c === 127) continue; const ch = d ? d.decode(Uint8Array.of(c)) : c < 127 ? String.fromCharCode(c) : ""; if (ch && ch !== "�") out.set(c, ch); }
      if (name === "WinAnsiEncoding") out.set(0xa0, " ");
    } else if (name === "StandardEncoding") {
      for (let c = 32; c < 127; c++) out.set(c, String.fromCharCode(c));
      out.set(0x27, "’"); out.set(0x60, "‘");
    }
    return out;
  }

  // everything needed to read and write text in one PDF font
  const fontMemo = new WeakMap();
  function fontInfo(dict) {
    if (!(dict instanceof PDFDict)) return null;
    if (fontMemo.has(dict)) return fontMemo.get(dict);
    const L = (d, k) => (d instanceof PDFDict ? d.lookup(N(k)) : undefined);
    const subtype = nameOf(L(dict, "Subtype"));
    const base = nameOf(L(dict, "BaseFont"));
    const clean = base.replace(/^[A-Z]{6}\+/, "");
    const subset = clean !== base;
    let kind = "simple", bytes = 1, desc = L(dict, "FontDescriptor"), cid = null;
    if (subtype === "Type0") {
      const df = L(dict, "DescendantFonts");
      cid = df instanceof PDFArray ? df.lookup(0) : null;
      desc = L(cid, "FontDescriptor");
      bytes = 2;
      kind = nameOf(L(dict, "Encoding")) === "Identity-H" && cid instanceof PDFDict ? "cid" : "unknown";
    } else if (subtype === "Type3") kind = "type3";
    const flags = numOf(L(desc, "Flags")) || 0;
    const embedded = !!(desc && (L(desc, "FontFile") || L(desc, "FontFile2") || L(desc, "FontFile3")));
    const asc = Math.abs(numOf(L(desc, "Ascent"))) / 1000 || 0.8, dsc = -Math.abs(numOf(L(desc, "Descent"))) / 1000 || -0.2;
    const capH = Math.abs(numOf(L(desc, "CapHeight"))) / 1000 || 0;
    const look = stdFor(clean, flags);

    // code -> text
    const toUni = new Map();
    const tu = L(dict, "ToUnicode");
    let hasTU = false;
    if (tu instanceof PDFStream) { safe(() => parseCMap(latin1(streamBytes(tu)), toUni)); hasTU = toUni.size > 0; }
    if (kind === "simple") {
      const e = L(dict, "Encoding");
      let baseName = e instanceof PDFName ? nameOf(e) : nameOf(L(e, "BaseEncoding"));
      const symbolic = (flags & 4) && !(flags & 32);
      if (!baseName && !symbolic) baseName = subtype === "TrueType" ? "WinAnsiEncoding" : "StandardEncoding";
      if (!baseName && STD14.test(clean)) baseName = "StandardEncoding";
      const table = baseEncoding(baseName);
      const diffs = L(e, "Differences");
      if (diffs instanceof PDFArray) {
        let code = 0;
        for (const o of diffs.asArray()) {
          if (o instanceof PDFNumber) code = o.asNumber();
          else if (o instanceof PDFName) { const ch = glyphChar(nameOf(o)); if (ch) table.set(code, ch); else table.delete(code); code++; }
        }
      }
      for (const [c, ch] of table) if (!toUni.has(c)) toUni.set(c, ch);
    }

    // widths, in 1/1000 em
    const W = new Map();
    let dw = 1000, stdMetrics = null;
    if (kind === "simple") {
      const first = numOf(L(dict, "FirstChar")), ws = L(dict, "Widths");
      dw = numOf(L(desc, "MissingWidth")) || 0;
      if (ws instanceof PDFArray && first >= 0) ws.asArray().forEach((w, i) => W.set(first + i, numOf(w instanceof PDFRef ? dict.context.lookup(w) : w) || 0));
      else stdMetrics = look.std;
    } else if (kind === "cid") {
      dw = numOf(L(cid, "DW")); if (!(dw >= 0)) dw = 1000;
      const wa = L(cid, "W");
      if (wa instanceof PDFArray) {
        const a = wa.asArray().map((o) => (o instanceof PDFRef ? cid.context.lookup(o) : o));
        for (let i = 0; i < a.length;) {
          const c0 = numOf(a[i]);
          if (a[i + 1] instanceof PDFArray) { a[i + 1].asArray().forEach((w, k) => W.set(c0 + k, numOf(w))); i += 2; }
          else { const c1 = numOf(a[i + 1]), w = numOf(a[i + 2]); for (let c = c0; c <= c1 && c - c0 < 65536; c++) W.set(c, w); i += 3; }
        }
      }
    }
    const width = (code) => {
      if (W.has(code)) return W.get(code);
      if (stdMetrics && STD[stdMetrics]) { const ch = toUni.get(code); if (ch) return safe(() => STD[stdMetrics].widthOfTextAtSize(ch, 1000), 500); }
      return dw || (kind === "cid" ? 1000 : 500);
    };

    // which codes have a glyph we can safely reuse
    let avail;
    if (!embedded && kind === "simple") avail = (c) => toUni.has(c);
    else if (kind === "cid") avail = (c) => toUni.has(c);
    else if (!subset) avail = (c) => toUni.has(c);
    else if (hasTU) avail = (c) => toUni.has(c) && (!W.size || W.get(c) > 0 || toUni.get(c) === " ");
    else avail = (c) => toUni.has(c) && W.get(c) > 0;

    const fromUni = new Map();
    for (const [c, ch] of [...toUni].sort((x, y) => x[0] - y[0])) if (ch.length === 1 && !fromUni.has(ch) && avail(c)) fromUni.set(ch, c);
    const fam = clean.replace(/[-,].*$/, "").replace(/(PSMT|PS|MT)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
    const info = {
      dict, name: clean, kind, bytes, toUni, fromUni, width, asc, dsc, capH, flags, std: look.std,
      editable: (kind === "simple" || kind === "cid") && toUni.size > 0,
      css: { family: `"${fam}", "${clean}", ${STDCSS[look.fam]}`, weight: look.bold ? 700 : 400, style: look.ital ? "italic" : "normal" },
    };
    fontMemo.set(dict, info);
    return info;
  }
  // codes of a shown string, and the text they stand for
  function decodeShow(info, bytes) {
    const codes = [];
    if (info && info.bytes === 2) for (let i = 0; i + 1 < bytes.length; i += 2) codes.push(bytes[i] * 256 + bytes[i + 1]);
    else for (const b of bytes) codes.push(b);
    return codes;
  }
  // split new text into runs: in the PDF's own font where it has the glyph, else a standard font
  function encodeRuns(info, text) {
    const runs = [];
    for (const ch of text) {
      const code = info && info.fromUni.get(ch);
      const own = code != null;
      const last = runs[runs.length - 1];
      if (!own && ch === " " && info) { runs.push({ gap: true }); continue; }   // a subset without a space glyph: move the pen instead
      if (last && last.own === own && !last.gap) last.items.push(own ? code : ch);
      else runs.push({ own, items: [own ? code : ch] });
    }
    return runs;
  }
  const codeHex = (info, codes) => "<" + codes.map((c) => c.toString(16).padStart(info.bytes * 2, "0")).join("") + ">";
  function textWidth(info, text, size) {            // in points, at this size
    let w = 0;
    for (const r of encodeRuns(info, text)) {
      if (r.gap) w += 0.25 * size;
      else if (r.own) for (const c of r.items) w += info.width(c) / 1000 * size;
      else { const f = STD[info ? info.std : StandardFonts.Helvetica]; for (const ch of r.items) w += safe(() => f.widthOfTextAtSize(ch, size), size * 0.5); }
    }
    return w;
  }

  /* ================= content streams ================= */
  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
  function skipString(b, i) {                        // b[i] === "("; returns index after the closing ")"
    let depth = 0;
    for (; i < b.length; i++) {
      const c = b[i];
      if (c === 92) { i++; continue; }
      if (c === 40) depth++;
      else if (c === 41 && --depth === 0) return i + 1;
    }
    return i;
  }
  // operators with their operands and byte ranges
  function parseOps(b) {
    const ops = [], stack = [];
    let args = [], argStart = -1, i = 0;
    const n = b.length;
    const push = (v, start) => { if (stack.length) stack[stack.length - 1].push(v); else { if (argStart < 0) argStart = start; args.push(v); } };
    while (i < n) {
      const c = b[i];
      if (WS.has(c)) { i++; continue; }
      if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
      const start = i;
      if (c === 40) {
        const out = []; let depth = 1; i++;
        while (i < n && depth) {
          const ch = b[i++];
          if (ch === 92) {
            const nx = b[i++];
            if (nx === 110) out.push(10); else if (nx === 114) out.push(13); else if (nx === 116) out.push(9);
            else if (nx === 98) out.push(8); else if (nx === 102) out.push(12);
            else if (nx >= 48 && nx <= 55) { let v = nx - 48; for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + (b[i++] - 48); out.push(v & 255); }
            else if (nx === 13) { if (b[i] === 10) i++; }
            else if (nx !== 10) out.push(nx);
          } else if (ch === 40) { depth++; out.push(ch); }
          else if (ch === 41) { if (--depth) out.push(ch); }
          else out.push(ch);
        }
        push(Uint8Array.from(out), start); continue;
      }
      if (c === 60) {
        if (b[i + 1] === 60) {                         // dictionary (marked content properties): skipped
          let depth = 0;
          while (i < n) {
            if (b[i] === 60 && b[i + 1] === 60) { depth++; i += 2; }
            else if (b[i] === 62 && b[i + 1] === 62) { depth--; i += 2; if (!depth) break; }
            else if (b[i] === 40) i = skipString(b, i);
            else i++;
          }
          push({ dict: true }, start); continue;
        }
        i++; let h = "";
        while (i < n && b[i] !== 62) { const ch = b[i++]; if (!WS.has(ch)) h += String.fromCharCode(ch); }
        i++; if (h.length % 2) h += "0";
        const out = new Uint8Array(h.length / 2);
        for (let k = 0; k < out.length; k++) out[k] = parseInt(h.substr(k * 2, 2), 16) || 0;
        push(out, start); continue;
      }
      if (c === 91) { if (!stack.length && argStart < 0) argStart = start; stack.push([]); i++; continue; }
      if (c === 93) { i++; const arr = stack.pop() || []; if (stack.length) stack[stack.length - 1].push(arr); else args.push(arr); continue; }
      if (c === 47) {
        i++; let s = "";
        while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) s += String.fromCharCode(b[i++]);
        push({ name: s.replace(/#([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))) }, start); continue;
      }
      let s = "";
      while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) s += String.fromCharCode(b[i++]);
      if (!s) { i++; continue; }
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) { push(parseFloat(s), start); continue; }
      if (s === "true" || s === "false" || s === "null") { push(s === "true", start); continue; }
      ops.push({ op: s, args, s: argStart < 0 ? start : argStart, e: i });
      args = []; argStart = -1; stack.length = 0;
      if (s === "ID") {                                // inline image: skip its data up to EI
        i++;
        while (i < n && !(b[i] === 69 && b[i + 1] === 73 && WS.has(b[i - 1]) && (i + 2 >= n || WS.has(b[i + 2])))) i++;
      }
    }
    return ops;
  }
  const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
  const pt = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
  const ID = [1, 0, 0, 1, 0, 0];

  function pageContent(page) {
    const c = page.node.Contents();
    const list = c instanceof PDFArray ? c.asArray().map((r) => page.doc.context.lookup(r)) : c ? [c] : [];
    const parts = list.filter((s) => s instanceof PDFStream).map((s) => safe(() => streamBytes(s), new Uint8Array(0)));
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length + 1, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 10; }
    return out;
  }
  function pageFonts(page) {
    const res = safe(() => page.node.Resources(), null);
    const fd = res && safe(() => res.lookup(N("Font"), PDFDict), null);
    const memo = new Map();
    return (name) => {
      if (!memo.has(name)) memo.set(name, fd ? fontInfo(safe(() => fd.lookup(N(name)), null)) : null);
      return memo.get(name);
    };
  }
  // run the page's content, collecting every text-showing operator
  function readText(page, bytes) {
    bytes = bytes || pageContent(page);
    const font = pageFonts(page), ops = parseOps(bytes), segs = [];
    let gs = { ctm: ID, font: null, fs: 0, tc: 0, tw: 0, th: 1, tl: 0, ts: 0, tr: 0, fill: "0 g", fillCS: "" };
    const st = [];
    let tm = ID, tlm = ID;
    const raw = (o) => latin1(bytes.subarray(o.s, o.e));
    const show = (o, strs) => {
      const info = font(gs.font);
      let adv = 0; const codes = [], rawParts = [], gx = [];
      for (const s of strs) {
        if (typeof s === "number") { adv -= s / 1000 * gs.fs * gs.th; codes.push(null); continue; }
        if (!(s instanceof Uint8Array)) continue;
        rawParts.push(hex(s));
        for (const c of decodeShow(info, s)) {
          const w = info ? info.width(c) / 1000 : 0.5;
          gx.push(adv);
          adv += (w * gs.fs + gs.tc + ((!info || info.bytes === 1) && c === 32 ? gs.tw : 0)) * gs.th;
          codes.push(c);
        }
      }
      const M = mul(tm, gs.ctm);
      const seg = { s: o.s, e: o.e, op: o.op, font: gs.font, info, fs: gs.fs, tc: gs.tc, tw: gs.tw, th: gs.th, ts: gs.ts, tr: gs.tr,
        fill: gs.fill, fillCS: gs.fillCS, tm, ctm: gs.ctm, adv, codes, M,
        key: [gs.font, f4(gs.fs), tm.map(f4).join(","), gs.ctm.map(f4).join(","), rawParts.join(".")].join("|") };
      seg.p0 = pt(M, 0, 0); seg.p1 = pt(M, adv, 0);
      seg.gx = gx.map((a) => pt(M, a, 0)[0]).concat(seg.p1[0]);
      const up = pt(M, 0, gs.fs);
      seg.size = Math.hypot(up[0] - seg.p0[0], up[1] - seg.p0[1]);
      seg.flat = Math.abs(up[0] - seg.p0[0]) < 0.02 * seg.size && up[1] > seg.p0[1] && seg.p1[0] >= seg.p0[0] - 0.01 && Math.abs(seg.p1[1] - seg.p0[1]) < 0.02 * seg.size + 0.01;
      seg.text = codes.map((c) => (c === null ? "" : info && info.toUni.has(c) ? info.toUni.get(c) : "�")).join("");
      // TJ gaps that look like word spaces
      if (strs.some((s) => typeof s === "number" && -s > 180)) {
        let t = ""; for (const s of strs) {
          if (typeof s === "number") { if (-s > 180 && t && !/\s$/.test(t)) t += " "; continue; }
          if (s instanceof Uint8Array) t += decodeShow(info, s).map((c) => (info && info.toUni.has(c) ? info.toUni.get(c) : "�")).join("");
        }
        seg.text = t;
      }
      segs.push(seg);
      tm = mul([1, 0, 0, 1, adv, 0], tm);
    };
    for (const o of ops) {
      const a = o.args;
      switch (o.op) {
        case "q": st.push(gs); gs = { ...gs }; break;
        case "Q": if (st.length) gs = st.pop(); break;
        case "cm": if (a.length >= 6) gs.ctm = mul(a.slice(0, 6), gs.ctm); break;
        case "BT": tm = tlm = ID; break;
        case "Tf": gs.font = a[0] && a[0].name; gs.fs = +a[1] || 0; break;
        case "Tc": gs.tc = +a[0] || 0; break;
        case "Tw": gs.tw = +a[0] || 0; break;
        case "Tz": gs.th = (+a[0] || 100) / 100; break;
        case "TL": gs.tl = +a[0] || 0; break;
        case "Ts": gs.ts = +a[0] || 0; break;
        case "Tr": gs.tr = +a[0] || 0; break;
        case "Td": tlm = mul([1, 0, 0, 1, +a[0] || 0, +a[1] || 0], tlm); tm = tlm; break;
        case "TD": gs.tl = -(+a[1] || 0); tlm = mul([1, 0, 0, 1, +a[0] || 0, +a[1] || 0], tlm); tm = tlm; break;
        case "Tm": if (a.length >= 6) tm = tlm = a.slice(0, 6).map(Number); break;
        case "T*": tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm; break;
        case "Tj": show(o, [a[0]]); break;
        case "TJ": show(o, Array.isArray(a[0]) ? a[0] : []); break;
        case "'": tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm; show(o, [a[0]]); break;
        case '"': gs.tw = +a[0] || 0; gs.tc = +a[1] || 0; tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm; { const sg = segs.length; show(o, [a[2]]); if (segs[sg]) { segs[sg].aw = a[0]; segs[sg].ac = a[1]; } } break;
        case "g": case "rg": case "k": gs.fill = raw(o); gs.fillCS = ""; break;
        case "cs": gs.fillCS = raw(o); gs.fill = ""; break;
        case "sc": case "scn": gs.fill = raw(o); break;
      }
    }
    return segs;
  }
  // consecutive pieces of text on one baseline, same font and size, become one editable line
  function groupLines(segs) {
    const lines = [], seen = new Map();
    let cur = null;
    for (const s of segs) {
      if (s.tr === 3 || s.tr === 7) continue;                         // invisible (OCR layer)
      const blank = !s.text.trim();
      const join = cur && s.flat && cur.flat && s.font === cur.font && Math.abs(s.size - cur.size) < 0.01 && s.fill === cur.fill &&
        Math.abs(s.p0[1] - cur.y) < 0.2 * cur.size && s.p0[0] - cur.x1 > -0.3 * cur.size && s.p0[0] - cur.x1 < 0.6 * cur.size;
      if (join) {
        const gap = s.p0[0] - cur.x1;
        if (gap > 0.15 * cur.size && !/\s$/.test(cur.text) && !/^\s/.test(s.text)) cur.text += " ";
        cur.text += s.text; cur.segs.push(s); cur.x1 = Math.max(cur.x1, s.p1[0]);
        continue;
      }
      if (blank && !cur) continue;
      cur = { segs: [s], text: s.text, x0: s.p0[0], x1: s.p1[0], y: s.p0[1], size: s.size, font: s.font, info: s.info, fill: s.fill, fillCS: s.fillCS, flat: s.flat };
      lines.push(cur);
    }
    return lines.filter((l) => l.text.trim()).map((l) => {
      l.text = l.text.replace(/\s+$/, "");
      const k = l.segs[0].key, n = (seen.get(k) || 0) + 1; seen.set(k, n);
      l.id = k + "#" + n;
      l.editable = l.flat && !!(l.info && l.info.editable) && !l.text.includes("�");
      return l;
    });
  }

  // write the content of a page back (one stream)
  function setContent(doc, page, bytes) {
    page.node.set(N("Contents"), doc.context.register(doc.context.flateStream(bytes)));
  }
  function appendContent(doc, page, text) {
    const ctx = doc.context, c = page.node.get(N("Contents"));
    const old = c instanceof PDFArray ? c.asArray() : c ? [c] : [];
    const q = ctx.register(ctx.flateStream(enc.encode("q\n"))), Q = ctx.register(ctx.flateStream(enc.encode("\nQ\n")));
    page.node.set(N("Contents"), ctx.obj([q, ...old, Q, ctx.register(ctx.flateStream(enc.encode(text)))]));
  }
  // a standard font for characters the PDF's font lacks, registered on the page (or a form XObject)
  async function fallbackName(doc, resHolder, info, cache) {
    const std = info ? info.std : StandardFonts.Helvetica;
    const key = std;
    if (cache.has(key)) return cache.get(key);
    doc._flStd = doc._flStd || new Map();
    if (!doc._flStd.has(std)) doc._flStd.set(std, await doc.embedFont(std));
    const font = doc._flStd.get(std);
    let name;
    if (resHolder.node) name = resHolder.node.newFontDictionary("FlFb", font.ref).toString();
    else { name = "/FlFb" + cache.size; resHolder.fonts[name.slice(1)] = font.ref; }
    const v = { name, font };
    cache.set(key, v);
    return v;
  }
  // operators that show `text` in the PDF font `res`, starting at the current text position
  async function showOps(doc, resHolder, res, info, size, text, cache) {
    const out = [];
    let curFont = null;
    for (const r of encodeRuns(info, text)) {
      if (r.gap) { out.push(`[${f4(-250)}] TJ`); continue; }
      if (r.own) {
        if (curFont !== res) { out.push(`${N(res).toString()} ${f4(size)} Tf`); curFont = res; }
        out.push(`${codeHex(info, r.items)} Tj`);
      } else {
        const fb = await fallbackName(doc, resHolder, info, cache);
        // borrowed letters: sized to the same capital height as the PDF's font
        const cap = { Helvetica: 0.718, Times: 0.662, Courier: 0.571 }[/^Times/.test(fb.font.name) ? "Times" : /^Courier/.test(fb.font.name) ? "Courier" : "Helvetica"];
        const fsz = size * (info && info.capH > 0.3 ? Math.min(1.15, Math.max(0.8, info.capH / cap)) : 1);
        if (curFont !== fb.name) { out.push(`${fb.name} ${f4(fsz)} Tf`); curFont = fb.name; }
        const s = r.items.join("");
        let enc2; try { enc2 = fb.font.encodeText(s); } catch { enc2 = fb.font.encodeText([...s].map((ch) => safe(() => (fb.font.encodeText(ch), ch), "?")).join("")); }
        out.push(`${enc2.toString()} Tj`);
      }
    }
    return out.join("\n");
  }

  /* ---------- edits to existing text ---------- */
  function pageModel(src, idx) {
    src._pm = src._pm || new Map();
    if (src._pm.has(idx)) return src._pm.get(idx);
    let m = { lines: [], fonts: [] };
    try {
      const page = src.lib.getPage(idx);
      const lines = groupLines(readText(page));
      const fonts = new Map();
      for (const l of lines) if (l.info && l.editable && !fonts.has(l.info.name)) fonts.set(l.info.name, { res: l.font, info: l.info, size: l.size, fill: l.fill, fillCS: l.fillCS });
      m = { lines, fonts: [...fonts.values()] };
    } catch (e) { console.warn("couldn't read the page text", e); }
    src._pm.set(idx, m);
    return m;
  }
  const editKey = (idx, id) => idx + "|" + id;
  async function applyEdits(doc, page, edits) {
    const bytes = pageContent(page), segs = readText(page, bytes);
    const byKey = new Map();
    for (const s of segs) { if (!byKey.has(s.key)) byKey.set(s.key, []); byKey.get(s.key).push(s); }
    const cuts = [], blocks = [], cache = new Map(), font = pageFonts(page);
    let missed = 0;
    for (const ed of edits) {
      if (!ed.keys.every((k) => byKey.has(k))) { missed++; continue; }
      for (const k of ed.keys) for (const s of byKey.get(k)) {
        // keep the pen moving exactly as before, without drawing anything
        const k2 = s.fs * s.th ? -s.adv / (s.fs * s.th) * 1000 : 0;
        const tj = `[${f4(k2)}] TJ`;
        cuts.push({ s: s.s, e: s.e, t: s.op === "'" ? "T* " + tj : s.op === '"' ? `${f4(s.aw)} Tw ${f4(s.ac)} Tc T* ${tj}` : tj });
      }
      if (!ed.text.trim()) continue;
      const info = font(ed.font);
      const holder = { node: page.node };
      blocks.push(`q ${ed.ctm.map(f4).join(" ")} cm BT\n${ed.fillCS}\n${ed.fill}\n${f4(ed.tr)} Tr ${f4(ed.tc)} Tc ${f4(ed.tw)} Tw ${f4(ed.th * 100)} Tz ${f4(ed.ts)} Ts\n${ed.tm.map(f4).join(" ")} Tm\n` +
        (await showOps(doc, holder, ed.font, info, ed.fs, ed.text, cache)) + "\nET Q");
    }
    if (!cuts.length && !blocks.length) return missed;
    cuts.sort((a, b) => a.s - b.s);
    const parts = [enc.encode("q\n")];
    let at = 0;
    for (const c of cuts) { if (c.s < at) continue; parts.push(bytes.subarray(at, c.s), enc.encode(c.t)); at = c.e; }
    parts.push(bytes.subarray(at), enc.encode("\nQ\n" + blocks.join("\n") + "\n"));
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    setContent(doc, page, out);
    return missed;
  }

  /* ---------- typewriter / free-text comments already in the PDF ---------- */
  const apOf = (a) => { const ap = a.lookup(N("AP")); const n = ap instanceof PDFDict ? ap.lookup(N("N")) : null; return n instanceof PDFStream ? n : null; };
  const apShim = (doc, st) => ({ doc, node: { Contents: () => st, Resources: () => safe(() => st.dict.lookup(N("Resources"), PDFDict), null) } });
  const rectOf = (a) => { const r = a.lookup(N("Rect")); const v = r instanceof PDFArray ? r.asArray().map(numOf) : [0, 0, 0, 0]; return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])]; };
  const ftKey = (rect, text) => rect.map((v) => Math.round(v)).join(",") + "|" + text;
  function freeTexts(src, idx) {
    src._ft = src._ft || new Map();
    if (src._ft.has(idx)) return src._ft.get(idx);
    const out = [];
    try {
      const page = src.lib.getPage(idx), annots = page.node.Annots();
      if (annots) for (const ref of annots.asArray()) {
        const a = src.lib.context.lookup(ref);
        if (!(a instanceof PDFDict) || nameOf(a.lookup(N("Subtype"))) !== "FreeText") continue;
        const rect = rectOf(a), text = nameText(a.lookup(N("Contents"))), ap = apOf(a);
        const lines = ap ? groupLines(readText(apShim(src.lib, ap))) : [];
        const ln = lines[0];
        out.push({ key: ftKey(rect, text), rect, text, lines, info: ln && ln.info, size: ln ? ln.size : 12, fill: ln ? ln.fill : "0 g",
          editable: !!(ln && ln.info && ln.info.editable) });
      }
    } catch (e) { console.warn("comments skipped", e); }
    src._ft.set(idx, out);
    return out;
  }
  async function rewriteFreeTexts(doc, page, eds) {
    const annots = page.node.Annots(); if (!annots) return 0;
    const ctx = doc.context, byKey = new Map(eds.map((e) => [e.key, e]));
    let done = 0;
    for (const ref of [...annots.asArray()]) {
      const a = ctx.lookup(ref);
      if (!(a instanceof PDFDict) || nameOf(a.lookup(N("Subtype"))) !== "FreeText") continue;
      const ed = byKey.get(ftKey(rectOf(a), nameText(a.lookup(N("Contents")))));
      if (!ed) continue;
      done++;
      if (!ed.text.trim()) { const i = annots.asArray().indexOf(ref); if (i >= 0) annots.remove(i); continue; }
      const ap = apOf(a); if (!ap) continue;
      const shim = apShim(doc, ap), bytes = pageContent(shim), segs = readText(shim, bytes), lines = groupLines(segs);
      if (!lines.length) continue;
      const first = lines[0].segs[0], info = lines[0].info;
      const lead = lines.length > 1 ? (lines[0].y - lines[1].y) : first.size * 1.17;
      const cuts = segs.map((g) => { const k2 = g.fs * g.th ? -g.adv / (g.fs * g.th) * 1000 : 0, tj = `[${f4(k2)}] TJ`; return { s: g.s, e: g.e, t: g.op === "'" ? "T* " + tj : g.op === '"' ? `${f4(g.aw)} Tw ${f4(g.ac)} Tc T* ${tj}` : tj }; });
      const parts = [enc.encode("q\n")]; let at = 0;
      for (const c of cuts) { if (c.s < at) continue; parts.push(bytes.subarray(at, c.s), enc.encode(c.t)); at = c.e; }
      parts.push(bytes.subarray(at), enc.encode("\nQ\n"));
      const holder = { fonts: {} }, cache = new Map(), out = [];
      const newLines = ed.text.split(/\r\n|\r|\n/);
      let maxW = 0;
      for (let i = 0; i < newLines.length; i++) {
        const src0 = lines[i] ? lines[i].segs[0] : first;
        const tm = lines[i] ? src0.tm : [first.tm[0], first.tm[1], first.tm[2], first.tm[3], first.tm[4], first.tm[5] - (i * lead) / (Math.abs(first.ctm[3]) || 1)];
        out.push(`q ${src0.ctm.map(f4).join(" ")} cm BT\n${src0.fillCS}\n${src0.fill}\n${f4(src0.tr)} Tr ${f4(src0.tc)} Tc ${f4(src0.tw)} Tw ${f4(src0.th * 100)} Tz ${f4(src0.ts)} Ts\n${tm.map(f4).join(" ")} Tm\n` +
          (await showOps(doc, holder, first.font, info, first.fs, newLines[i], cache)) + "\nET Q");
        maxW = Math.max(maxW, first.p0[0] + textWidth(info, newLines[i], first.size));
      }
      parts.push(enc.encode(out.join("\n")));
      const content = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); { let o = 0; for (const x of parts) { content.set(x, o); o += x.length; } }
      const st = ctx.flateStream(content, {});
      for (const [k, v] of ap.dict.entries()) if (!["Length", "Filter", "DecodeParms"].includes(k.decodeText())) st.dict.set(k, v);
      // fonts borrowed for missing letters
      if (Object.keys(holder.fonts).length) {
        const res0 = st.dict.lookup(N("Resources")), res = res0 instanceof PDFDict ? res0.clone(ctx) : ctx.obj({});
        const fd0 = res.lookup(N("Font")), fd = fd0 instanceof PDFDict ? fd0.clone(ctx) : ctx.obj({});
        for (const [k, v] of Object.entries(holder.fonts)) fd.set(N(k), v);
        res.set(N("Font"), fd); st.dict.set(N("Resources"), res);
      }
      // a longer answer gets a wider box
      const bb = st.dict.lookup(N("BBox")), mx = st.dict.lookup(N("Matrix"));
      if (bb instanceof PDFArray && !(mx instanceof PDFArray && numOf(mx.lookup(1)))) {
        const b = bb.asArray().map(numOf), r = rectOf(a), extra = maxW + 2 - Math.max(b[0], b[2]);
        if (extra > 0) { st.dict.set(N("BBox"), ctx.obj([b[0], b[1], Math.max(b[0], b[2]) + extra, b[3]])); a.set(N("Rect"), ctx.obj([r[0], r[1], r[2] + extra, r[3]])); }
      }
      a.set(N("AP"), ctx.obj({ N: ctx.register(st) }));
      a.set(N("Contents"), PDFLib.PDFHexString.fromText(newLines.join("\r")));
      a.delete(N("RC"));
      a.set(N("M"), PDFLib.PDFString.of("D:" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z"));
    }
    return done;
  }

  /* ================= form fields ================= */
  const fieldType = (f) => f instanceof PDFTextField ? "text" : f instanceof PDFCheckBox ? "check" : f instanceof PDFRadioGroup ? "radio"
    : f instanceof PDFDropdown ? "drop" : f instanceof PDFOptionList ? "list" : null;
  const nameText = (o) => (o && typeof o.decodeText === "function" ? safe(() => o.decodeText(), "") : "");
  // the font, size and colour a field asks for (/DA, looked up in /DR)
  function fieldLook(form, f) {
    let da = safe(() => f.acroField.getDefaultAppearance(), "") || "";
    if (!da) da = nameText(form.acroForm.dict.lookup(N("DA")));
    const ops = parseOps(enc.encode(da));
    const tf = ops.find((o) => o.op === "Tf");
    const color = ops.filter((o) => /^(g|rg|k)$/.test(o.op)).map((o) => o.args.map(f4).join(" ") + " " + o.op).pop() || "0 g";
    const res = tf && tf.args[0] && tf.args[0].name;
    const size = tf ? +tf.args[1] || 0 : 0;
    const dr = safe(() => form.acroForm.dict.lookup(N("DR"), PDFDict), null);
    const fonts = dr && safe(() => dr.lookup(N("Font"), PDFDict), null);
    const fontObj = fonts && res ? fonts.get(N(res)) : null;
    const info = fontObj ? fontInfo(fonts.lookup(N(res))) : null;
    const css = colorCss(color);
    return { res, size, color, css, fontObj, info };
  }
  function colorCss(raw) {
    const m = (raw || "").trim().split(/\s+/), op = m.pop(), v = m.map(Number);
    const c = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255);
    if (op === "g" && v.length >= 1) return `rgb(${c(v[0])},${c(v[0])},${c(v[0])})`;
    if (op === "rg" && v.length >= 3) return `rgb(${c(v[0])},${c(v[1])},${c(v[2])})`;
    if (op === "k" && v.length >= 4) return `rgb(${c((1 - v[0]) * (1 - v[3]))},${c((1 - v[1]) * (1 - v[3]))},${c((1 - v[2]) * (1 - v[3]))})`;
    if ((op === "sc" || op === "scn") && v.length === 3) return `rgb(${c(v[0])},${c(v[1])},${c(v[2])})`;
    if ((op === "sc" || op === "scn") && v.length === 1) return `rgb(${c(v[0])},${c(v[0])},${c(v[0])})`;
    return "#111";
  }
  const widgetBorder = (w) => {
    const bs = safe(() => w.dict.lookup(N("BS"), PDFDict), null);
    const bw = bs ? numOf(bs.lookup(N("W"))) : NaN;
    if (bw >= 0) return bw;
    const b = safe(() => w.dict.lookup(N("Border"), PDFArray), null);
    return b && b.size() >= 3 ? numOf(b.lookup(2)) || 0 : 1;
  };
  // the size and lines a text answer is drawn with (shared by the view and the PDF)
  function layoutText(look, opts, text, W, H, bw) {
    const info = look.info, pad = Math.max(2, bw + 1);
    const asc = info ? info.asc : 0.8, dsc = info ? info.dsc : -0.2;
    const tw = (s, size) => textWidth(info, s, size);
    let size = look.size;
    // a declared size that can't fit one line in the box is a broken form: fit it instead
    if (size && (asc - dsc) * size > H - 2 * bw + 1) size = 0;
    if (opts.comb && opts.maxLen) {
      const cell = W / opts.maxLen;
      if (!size) { size = Math.min(12, (H - 2 * bw) / 1.16); const mw = Math.max(...[...(text || "0")].map((ch) => tw(ch, 1)), 0.5); size = Math.min(size, (cell * 0.9) / mw); }
      return { size, comb: [...text].slice(0, opts.maxLen).map((ch, i) => ({ ch, x: i * cell + (cell - tw(ch, size)) / 2 })), y: (H - (asc - dsc) * size) / 2 - dsc * size };
    }
    if (opts.multiline) {
      const wrap = (s) => {
        const out = [];
        for (const para of text.split(/\r?\n/)) {
          let line = "";
          for (const word of para.split(/(\s+)/)) {
            const t = line + word;
            if (line && tw(t.replace(/\s+$/, ""), s) > W - 2 * pad) { out.push(line.replace(/\s+$/, "")); line = word.replace(/^\s+/, ""); }
            else line = t;
          }
          out.push(line.replace(/\s+$/, ""));
        }
        return out;
      };
      // auto size, or a declared size that would push the answer out of the box: shrink until it fits
      const over = (z) => wrap(z).length * (asc - dsc) * z > H - 2 * pad;
      if (!size || over(size)) { size = Math.min(size || 12, 12); while (size > 4 && over(size)) size -= 0.5; }
      const lines = wrap(size), lead = (asc - dsc) * size;
      return { size, lines: lines.map((t, i) => ({ t, x: alignX(opts.align, tw(t, size), W, pad), y: H - pad - asc * size - i * lead })) };
    }
    const one = text.replace(/\r?\n/g, " ");
    if (!size) size = Math.max(4, (H - 2 * bw - 2) / 1.16);
    { const w = tw(one, size); if (w > W - 2 * pad && w > 0) size = Math.max(4, size * (W - 2 * pad) / w); }
    return { size, lines: [{ t: one, x: alignX(opts.align, tw(one, size), W, pad), y: (H - (asc - dsc) * size) / 2 - dsc * size }] };
  }
  const alignX = (q, w, W, pad) => (q === 1 ? (W - w) / 2 : q === 2 ? W - pad - w : pad);
  const colorOp = (arr, stroke) => {
    if (!(arr instanceof PDFArray)) return null;
    const v = arr.asArray().map(numOf);
    return v.length === 1 ? `${f4(v[0])} ${stroke ? "G" : "g"}` : v.length === 3 ? `${v.map(f4).join(" ")} ${stroke ? "RG" : "rg"}` : v.length === 4 ? `${v.map(f4).join(" ")} ${stroke ? "K" : "k"}` : null;
  };
  // draw a text answer into the widget's appearance, in the form's own font
  async function exactAppearance(doc, form, f, text) {
    let look = fieldLook(form, f);
    if (!look.info || !look.info.editable || !look.fontObj) {
      // the form names a font it doesn't define: use the standard font it stands for
      const ctx = doc.context, ref = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: stdFor(look.res || "Helvetica").std, Encoding: "WinAnsiEncoding" }));
      look = { ...look, res: (look.res || "Helv").replace(/[^A-Za-z0-9_-]/g, "") || "Helv", fontObj: ref, info: fontInfo(ctx.lookup(ref)) };
      if (!look.info || !look.info.editable) return false;
    }
    const opts = {
      multiline: f instanceof PDFTextField && safe(() => f.isMultiline(), false),
      comb: f instanceof PDFTextField && safe(() => f.isCombed(), false),
      maxLen: f instanceof PDFTextField ? safe(() => f.getMaxLength(), undefined) : undefined,
      align: safe(() => f.acroField.getQuadding(), 0) || 0,
    };
    for (const w of f.acroField.getWidgets()) {
      const r = w.getRectangle(), W = Math.abs(r.width), H = Math.abs(r.height);
      const mk = safe(() => w.dict.lookup(N("MK"), PDFDict), null);
      const rot = mk ? numOf(mk.lookup(N("R"))) || 0 : 0;
      if (rot % 360) return false;                       // rotated boxes: let pdf-lib draw them
      const bw = widgetBorder(w);
      const res = { fonts: { [look.res]: look.fontObj } }, cache = new Map();
      const L = layoutText(look, opts, text, W, H, bw);
      const parts = [];
      const bg = mk && colorOp(mk.lookup(N("BG")), false), bc = mk && colorOp(mk.lookup(N("BC")), true);
      if (bg) parts.push(`q ${bg} 0 0 ${f4(W)} ${f4(H)} re f Q`);
      if (bc && bw > 0) parts.push(`q ${bc} ${f4(bw)} w ${f4(bw / 2)} ${f4(bw / 2)} ${f4(W - bw)} ${f4(H - bw)} re S Q`);
      parts.push(`/Tx BMC q ${f4(bw)} ${f4(bw)} ${f4(W - 2 * bw)} ${f4(H - 2 * bw)} re W n BT ${look.color}`);
      if (L.comb) for (const c of L.comb) parts.push(`1 0 0 1 ${f4(c.x)} ${f4(L.y)} Tm ` + (await showOps(doc, res, look.res, look.info, L.size, c.ch, cache)));
      else for (const ln of L.lines) if (ln.t) parts.push(`1 0 0 1 ${f4(ln.x)} ${f4(ln.y)} Tm ` + (await showOps(doc, res, look.res, look.info, L.size, ln.t, cache)));
      parts.push("ET Q EMC");
      const ctx = doc.context;
      const fontDict = ctx.obj({});
      for (const [k, v] of Object.entries(res.fonts)) fontDict.set(N(k), v);
      const xo = ctx.flateStream(enc.encode(parts.join("\n")), { Type: "XObject", Subtype: "Form", BBox: [0, 0, W, H], Resources: { Font: fontDict } });
      w.setNormalAppearance(ctx.register(xo));
    }
    return true;
  }

  // every fillable widget of a source PDF: { name, type, page, rect, … }
  function fieldsOf(src) {
    if (src._fields) return src._fields;
    src._fields = [];
    if (!src || src.kind !== "pdf" || !src.lib) return src._fields;
    try {
      if (!src.lib.catalog.get(N("AcroForm"))) return src._fields;
      const form = src.lib.getForm(), ctx = src.lib.context, pages = src.lib.getPages();
      const pageOf = new Map();
      pages.forEach((p, i) => { const a = p.node.Annots(); if (a) for (const r of a.asArray()) pageOf.set(String(r), i); });
      for (const f of form.getFields()) {
        const type = fieldType(f); if (!type) continue;
        const widgets = safe(() => f.acroField.getWidgets(), []);
        const options = type === "radio" || type === "drop" || type === "list" ? safe(() => f.getOptions(), []) : [];
        const look = type === "text" || type === "drop" ? safe(() => fieldLook(form, f), null) : null;
        const info = {
          name: f.getName(), type, options, look,
          tip: nameText(f.acroField.dict.lookup(N("TU"))),
          readOnly: safe(() => f.isReadOnly(), false),
          multiline: type === "text" && safe(() => f.isMultiline(), false),
          comb: type === "text" && safe(() => f.isCombed(), false),
          maxLen: type === "text" ? safe(() => f.getMaxLength(), undefined) : undefined,
          align: safe(() => f.acroField.getQuadding(), 0) || 0,
          editable: type === "drop" && safe(() => f.isEditable(), false),
          multi: type === "list" && safe(() => f.isMultiselect(), false),
        };
        widgets.forEach((w, k) => {
          const flags = safe(() => w.dict.lookup(N("F")).asNumber(), 0);
          if (flags & 2) return;
          const ref = ctx.getObjectRef(w.dict);
          let page = ref ? pageOf.get(String(ref)) : undefined;
          if (page === undefined) { const P = safe(() => w.P(), null); if (P) page = pages.findIndex((p) => String(p.ref) === String(P)); }
          if (page === undefined || page < 0) return;
          const r = safe(() => w.getRectangle(), null);
          if (!r || !(Math.abs(r.width) > 2 && Math.abs(r.height) > 2)) return;
          let option;
          if (type === "radio") option = options.length === widgets.length ? options[k] : nameText(safe(() => w.getOnValue(), null)) || undefined;
          src._fields.push({ ...info, page, option, k, bw: widgetBorder(w), rect: [r.x, r.y, r.x + r.width, r.y + r.height] });
        });
      }
    } catch (e) { console.warn("form fields skipped", e); src._fields = []; }
    return src._fields;
  }
  const pageHasFields = (it) => !!(it && !it.blank && it.src && fieldsOf(it.src).some((f) => f.page === it.idx));
  const fieldNames = (src) => new Set(fieldsOf(src).map((f) => f.name));
  function getVal(src, fd) {
    if (src.fill && src.fill.has(fd.name)) return src.fill.get(fd.name);
    const f = safe(() => src.lib.getForm().getField(fd.name), null);
    if (!f) return fd.type === "check" ? false : fd.type === "list" ? [] : "";
    switch (fd.type) {
      case "text": return safe(() => f.getText(), "") || "";
      case "check": return safe(() => f.isChecked(), false);
      case "radio": return safe(() => f.getSelected(), "") || "";
      case "drop": return safe(() => f.getSelected()[0], "") || "";
      case "list": return safe(() => f.getSelected(), []) || [];
    }
    return "";
  }
  const bump = (src) => { src._ver = (src._ver || 0) + 1; };
  function setVal(src, name, v) { if (!src.fill) src.fill = new Map(); src.fill.set(name, v); }
  const answers = () => fileList().reduce((n, s) => n + (s.fill ? s.fill.size : 0), 0);
  const editCount = () => fileList().reduce((n, s) => n + (s.edits ? s.edits.size : 0) + (s.ftEdits ? s.ftEdits.size : 0), 0);

  // a copy of the source with the answers filled in (in the form's own fonts) and flattened
  async function filledSource(src) {
    const key = JSON.stringify([...src.fill]);
    if (src._shadow && src._shadow.key === key) return src._shadow.src;
    await stdReady;
    const doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
    const form = doc.getForm();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const done = new Set();
    const plain = (s) => [...String(s || "")].map((ch) => (ch === "\n" ? ch : safe(() => (helv.encodeText(ch), ch), "?"))).join("");
    for (const [name, v] of src.fill) {
      const f = safe(() => form.getField(name), null); if (!f) continue;
      try {
        if (f instanceof PDFTextField) {
          let t = String(v ?? "");
          if (!f.isMultiline()) t = t.replace(/\r?\n/g, " ");
          const ml = f.getMaxLength(); if (ml !== undefined && t.length > ml) t = t.slice(0, ml);
          f.setText(plain(t));                            // the stored value (what other apps read back)
          if (await exactAppearance(doc, form, f, t).catch((e) => { console.warn("exact look failed for", name, e); return false; })) done.add(name);
        } else if (f instanceof PDFCheckBox) { if (v) f.check(); else f.uncheck(); done.add(name); }
        else if (f instanceof PDFRadioGroup) { if (v) f.select(v); else f.clear(); done.add(name); }
        else if (f instanceof PDFDropdown) {
          if (v) f.select(plain(v)); else f.clear();
          if (v && (await exactAppearance(doc, form, f, String(v)).catch((e) => { console.warn("exact look failed for", name, e); return false; }))) done.add(name);
        } else if (f instanceof PDFOptionList) { const a = (Array.isArray(v) ? v : [v]).filter(Boolean); if (a.length) f.select(a); else f.clear(); }
      } catch (e) { console.warn("couldn't fill", name, e); }
    }
    // anything still without a look gets pdf-lib's (Helvetica)
    for (const f of form.getFields()) {
      if (done.has(f.getName())) continue;
      try { if (f.needsAppearancesUpdate && f.needsAppearancesUpdate()) f.defaultUpdateAppearances(helv); } catch (e) { console.warn("appearance", f.getName(), e); }
    }
    try { form.flatten({ updateFieldAppearances: false }); } catch (e) { console.warn("flatten skipped", e); }
    // pdf-lib's flatten can leave references to deleted widgets behind
    const ANNOTS = N("Annots");
    for (const pg of doc.getPages()) {
      const arr = safe(() => pg.node.Annots(), null); if (!arr) continue;
      const live = arr.asArray().filter((r) => !(r instanceof PDFRef) || doc.context.lookup(r) !== undefined);
      if (live.length === arr.size()) continue;
      if (live.length) pg.node.set(ANNOTS, doc.context.obj(live)); else pg.node.delete(ANNOTS);
    }
    const bytes = await doc.save({ updateFieldAppearances: false });
    const lib = await PDFDocument.load(bytes, { updateMetadata: false });
    const pdfjs = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    if (src._shadow) try { src._shadow.src.pdfjs.destroy(); } catch { /* gone */ }
    const shadow = { ...src, lib, pdfjs, bytes, locked: false, thumbs: new Map() };
    src._shadow = { key, src: shadow };
    return shadow;
  }

  /* ================= building the PDF ================= */
  let missedNote = 0;
  const build0 = buildPdf;
  buildPdf = async function (items, opt = {}) {
    await stdReady;
    const need = new Set(items.filter((it) => !it.blank && it.src && it.src.lib && it.src.fill && it.src.fill.size).map((it) => it.src));
    const map = new Map();
    for (const s of need) { if (opt.progress) opt.progress(`Filling in ${s.name}`); map.set(s, await filledSource(s)); }
    const out = await build0(map.size ? items.map((it) => (!it.blank && map.has(it.src) ? { ...it, src: map.get(it.src) } : it)) : items, opt);
    // edited text, page by page (before numbers and watermarks are stamped)
    const pages = out.getPages();
    let missed = 0;
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (it.blank || !it.src || !it.src.edits || !it.src.edits.size || !pages[k]) continue;
      const eds = [...it.src.edits.values()].filter((e) => e.idx === it.idx);
      if (!eds.length) continue;
      if (opt.progress) opt.progress(`Rewriting text on page ${k + 1}`);
      try { missed += await applyEdits(out, pages[k], eds); } catch (e) { console.warn("edit failed", e); missed += eds.length; }
    }
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (it.blank || !it.src || !it.src.ftEdits || !it.src.ftEdits.size || !pages[k]) continue;
      const eds = [...it.src.ftEdits.values()].filter((e) => e.idx === it.idx);
      if (eds.length) try { await rewriteFreeTexts(out, pages[k], eds); } catch (e) { console.warn("comment edit failed", e); }
    }
    if (missed && !opt.noMarks && Date.now() - missedNote > 5000) {
      missedNote = Date.now();
      setTimeout(() => toast(`${plural(missed, "text edit")} couldn’t be applied (the page was rebuilt, e.g. by masking or a locked file). Use Add text there instead.`, "err"), 400);
    }
    return out;
  };

  /* ---------- added text boxes ---------- */
  function placed(t, itemRot) {
    const d = norm((itemRot || 0) - (t.r || 0));
    let u = t.u, v = t.v;
    for (let k = 0; k < d / 90; k++) [u, v] = [1 - v, u];
    return { u, v, turn: d };
  }
  function unplace(u, v, turn) { for (let k = 0; k < turn / 90; k++) [u, v] = [v, 1 - u]; return { u, v }; }
  const BASIC = {
    sans: { pdf: StandardFonts.Helvetica, css: STDCSS.Helvetica, label: "Sans (Helvetica)" },
    serif: { pdf: StandardFonts.TimesRoman, css: STDCSS.Times, label: "Serif (Times)" },
    mono: { pdf: StandardFonts.Courier, css: STDCSS.Courier, label: "Mono (Courier)" },
  };
  const COLORS = {
    black: { css: "#111111", pdf: [0.07, 0.07, 0.07], label: "Black" },
    blue: { css: "#1A3FB0", pdf: [0.102, 0.247, 0.69], label: "Blue" },
    red: { css: "#D0142C", pdf: [0.816, 0.078, 0.173], label: "Red" },
  };
  const baseCache = {};
  function cssBaseline(css) {
    if (baseCache[css]) return baseCache[css];
    let b = 0.95;
    try {
      const c = document.createElement("canvas").getContext("2d"); c.font = `100px ${css}`;
      const m = c.measureText("Hg");
      if (m.fontBoundingBoxAscent) b = (LH - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) / 100) / 2 + m.fontBoundingBoxAscent / 100;
    } catch { /* default */ }
    return (baseCache[css] = b);
  }
  // baseline below the box's top, in font sizes
  const boxBaseline = (t) => (t.doc ? (LH - (t.doc.asc - t.doc.dsc)) / 2 + t.doc.asc : cssBaseline((BASIC[t.font] || BASIC.sans).css));
  async function apply(doc, items, opt = {}) {
    const pages = doc.getPages(), fonts = {};
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (!it.texts || !it.texts.length || !pages[k]) continue;
      const page = pages[k], f = frame(page), font = pageFonts(page), cache = new Map(), blocks = [];
      for (const t of it.texts) {
        if (!t.text || !t.text.trim()) continue;
        const p = placed(t, it.rot), base = boxBaseline(t) * t.s;
        const ax = p.u * f.VW, ay = (1 - p.v) * f.VH, a = -p.turn * Math.PI / 180;
        const lines = t.text.split(/\r?\n/);
        // in the PDF's own font, if this page still has it
        const info = t.doc ? font(t.doc.res) : null;
        if (info && info.editable && info.name === t.doc.name) {
          const th = (f.rot - p.turn) * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
          for (let i = 0; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            const off = base + i * LH * t.s, q = f.map(ax + off * Math.sin(a), ay - off * Math.cos(a));
            blocks.push(`BT ${t.doc.fillCS || ""} ${t.doc.fill || "0 g"} ${f4(c)} ${f4(s)} ${f4(-s)} ${f4(c)} ${f4(q.x)} ${f4(q.y)} Tm\n` +
              (await showOps(doc, { node: page.node }, t.doc.res, info, t.s, lines[i], cache)) + "\nET");
          }
          continue;
        }
        const pdfFont = t.doc ? stdFor(t.doc.name, t.doc.flags).std : (BASIC[t.font] || BASIC.sans).pdf;
        const pf = fonts[pdfFont] || (fonts[pdfFont] = await doc.embedFont(pdfFont));
        const color = t.doc ? rgb(...cssToRgb(t.doc.css)) : rgb(...(COLORS[t.color] || COLORS.black).pdf);
        lines.forEach((line, i) => {
          if (!line.trim()) return;
          const off = base + i * LH * t.s;
          const clean = [...line].map((ch) => safe(() => (pf.encodeText(ch), ch), "?")).join("");
          drawVisualText(page, clean, { vx: ax + off * Math.sin(a), vy: ay - off * Math.cos(a), angle: -p.turn, font: pf, size: t.s, color });
        });
      }
      if (blocks.length) appendContent(doc, page, blocks.join("\n"));
    }
    for (const h of after) await h(doc, items, opt);
  }
  const after = [];
  const cssToRgb = (css) => { const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(css || ""); return m ? [m[1] / 255, m[2] / 255, m[3] / 255] : [0.07, 0.07, 0.07]; };

  /* ================= the page view ================= */
  const el = MK.el, $m = MK.$m;
  const S = { tool: "mark", sel: null };
  const CUSTOM = new Map();                        // tools added by other scripts (SSFill.addTool)
  const PREF_KEY = "pdfcraft.text.prefs";
  const prefs = (() => {
    const d = { font: "match", size: 11, color: "black" };
    try { return Object.assign(d, JSON.parse(localStorage.getItem(PREF_KEY) || "{}")); } catch { return d; }
  })();
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* storage off */ } };
  const clampSize = (s) => Math.max(4, Math.min(96, Math.round((Number(s) || 11) * 100) / 100));
  const itemNow = () => MK.itemByUid(MK.V.uid);

  // what the canvas was drawn from; when it changes, draw again
  const ids = new WeakMap(); let idN = 0;
  const idOf = (o) => (o ? (ids.has(o) || ids.set(o, ++idN), ids.get(o)) : 0);
  const sigOf = (it) => [idOf(it.texts), idOf(it.annots), idOf(it.areas), it.src ? it.src._ver || 0 : 0, it.rot].join("|");
  let drawn = { page: null, sig: "" }, refreshT = 0;
  const refresh = () => { clearTimeout(refreshT); refreshT = setTimeout(() => { if (MK.V.open) MK.refresh(); }, 30); };

  function setTexts(uid, texts, label) { B.commit(B.items.map((i) => (i.uid === uid ? { ...i, texts } : i)), label); }
  function patchText(uid, id, patch, label) {
    const it = MK.itemByUid(uid); if (!it || !it.texts) return;
    const t = it.texts.find((x) => x.id === id); if (!t) return;
    if (Object.keys(patch).every((k) => JSON.stringify(t[k]) === JSON.stringify(patch[k]))) return;
    setTexts(uid, it.texts.map((x) => (x.id === id ? { ...x, ...patch } : x)), label);
  }
  function removeText(uid, id) {
    const it = MK.itemByUid(uid); if (!it || !it.texts) return;
    const t = it.texts.find((x) => x.id === id);
    if (S.sel === id) S.sel = null;
    setTexts(uid, it.texts.filter((x) => x.id !== id), t && t.text.trim() ? "Removed a text box" : null);
  }

  let L = null;
  function ensureLayer() {
    if (!L || !L.isConnected) { L = document.createElement("div"); L.className = "fl-layer"; L.id = "fl-layer"; $m("mk-paper").appendChild(L); }
    return L;
  }
  const viewport = () => MK.V.page.getViewport({ scale: MK.V.scale });
  function rectPx(vp, r) {
    const [a, b, c, d] = vp.convertToViewportRectangle(r);
    return { x: Math.min(a, c), y: Math.min(b, d), w: Math.abs(c - a), h: Math.abs(d - b) };
  }
  // called by the marks view whenever it redraws
  function layer(it) {
    const V = MK.V, Lr = ensureLayer();
    if (!V.page || !V.w) return;
    el.classList.toggle("fl-tmode", S.tool === "text");
    el.classList.toggle("fl-emode", S.tool === "edit");
    if (drawn.page !== V.page) drawn = { page: V.page, sig: sigOf(it) };
    else if (drawn.sig !== sigOf(it)) { drawn.sig = sigOf(it); refresh(); }
    const key = [it.uid, V.scale, S.tool].join("|");
    if (Lr._page !== V.page || Lr._key !== key) {
      // remember where the user was typing, to put them back after the redraw
      const a = document.activeElement, fkey = a && Lr.contains(a) && a.closest(".fl-field") ? a.closest(".fl-field").dataset.fkey : null;
      const selS = fkey && a.selectionStart, selE = fkey && a.selectionEnd;
      if (Lr._page !== V.page || Lr._uid !== it.uid) { Lr._uid = it.uid; paintTextControls(it); }
      Lr._page = V.page; Lr._key = key;
      Lr.querySelectorAll(".fl-field,.fl-line").forEach((n) => n.remove());
      const vp = viewport(), frag = document.createDocumentFragment();
      if (!it.blank && it.src && it.src.kind === "pdf" && it.src.lib) {
        if (S.tool === "edit") for (const ln of pageModel(it.src, it.idx).lines) { try { frag.appendChild(lineEl(it, ln, vp)); } catch (e) { console.warn("line", e); } }
        if (S.tool === "edit") for (const ft of freeTexts(it.src, it.idx)) { try { frag.appendChild(ftEl(it, ft, vp)); } catch (e) { console.warn("comment", e); } }
        for (const fd of fieldsOf(it.src)) if (fd.page === it.idx) { try { frag.appendChild(fieldEl(it.src, fd, vp)); } catch (e) { console.warn("field", fd.name, e); } }
      }
      Lr.prepend(frag);
      if (fkey) {
        const n = Lr.querySelector(`.fl-field[data-fkey="${CSS.escape(fkey)}"] :is(input,textarea,select)`);
        if (n) { n.focus({ preventScroll: true }); if (selS != null && n.setSelectionRange) safe(() => n.setSelectionRange(selS, selE)); }
      }
    }
    for (const def of CUSTOM.values()) if (def.layer) { try { def.layer(it, Lr, viewport(), S.tool); } catch (e) { console.warn(def.id, e); } }
    const want = new Map((it.texts || []).map((t) => [it.uid + ":" + t.id, t]));
    for (const n of [...Lr.querySelectorAll(".fl-text")]) if (!want.has(n.dataset.key)) n.remove();
    for (const [k, t] of want) {
      let n = Lr.querySelector(`.fl-text[data-key="${CSS.escape(k)}"]`);
      if (!n) { n = textEl(it.uid, t); n.dataset.key = k; Lr.appendChild(n); }
      placeText(n, t, it);
    }
  }

  /* ---------- editing existing lines ---------- */
  function lineEl(it, ln, vp) {
    const src = it.src, ed = src.edits && src.edits.get(editKey(it.idx, ln.id));
    const text = ed ? ed.text : ln.text;
    const w = ed ? Math.max(textWidth(ln.info, ed.text, ln.size), 4) : ln.x1 - ln.x0;
    const [ox, oy] = window.SSFill && SSFill.lineOffset ? SSFill.lineOffset(it, ln.x0 + 1, ln.y + 0.3 * ln.size) : [0, 0];
    const r = rectPx(vp, [ln.x0 + ox, ln.y - 0.25 * ln.size + oy, ln.x0 + w + ox, ln.y + 0.85 * ln.size + oy]);
    const n = document.createElement("div");
    n.className = "fl-item fl-line" + (ed ? " fl-edited" : "") + (ln.editable ? "" : " fl-locked");
    n.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
    n.title = ln.editable ? `${ln.info.name} · ${+ln.size.toFixed(2)} pt — click to edit` : "This text uses a font that can’t be retyped. Use Add text instead.";
    n.tabIndex = ln.editable ? 0 : -1;
    const open = () => ln.editable && openLineEditor(it, ln, n, text);
    n.addEventListener("click", open);
    n.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); open(); } });
    return n;
  }
  function openLineEditor(it, ln, box, text) {
    const Lr = ensureLayer(), V = MK.V, src = it.src, k = editKey(it.idx, ln.id);
    Lr.querySelectorAll(".fl-editor").forEach((x) => x.remove());
    const ed = document.createElement("div"); ed.className = "fl-item fl-editor";
    const scale = V.scale, size = ln.size * scale;
    ed.style.cssText = `left:${box.offsetLeft}px;top:${box.offsetTop}px;height:${box.offsetHeight}px`;
    const ta = document.createElement("input"); ta.type = "text"; ta.value = text; ta.spellcheck = true;
    Object.assign(ta.style, { fontSize: size + "px", fontFamily: ln.info.css.family, fontWeight: ln.info.css.weight, fontStyle: ln.info.css.style, color: colorCss(ln.fill), height: box.offsetHeight + "px", minWidth: Math.max(box.offsetWidth, 30) + "px" });
    const fit = () => { ta.style.width = "0px"; ta.style.width = Math.max(box.offsetWidth, ta.scrollWidth + 4) + "px"; };
    const bar = document.createElement("div"); bar.className = "fl-edbar";
    bar.innerHTML = `<span>${ln.info.name.replace(/[<&]/g, "")} · ${+ln.size.toFixed(2)} pt</span><button type="button" data-a="revert" title="Put the original text back">Original</button><button type="button" data-a="ok" title="Apply (Enter)">✓</button>`;
    ed.append(ta, bar); Lr.appendChild(ed); fit();
    let closed = false;
    const close = (save) => {
      if (closed) return; closed = true;
      const v = ta.value.replace(/\s+$/, "");
      ed.remove();
      if (!save) return;
      if (!src.edits) src.edits = new Map();
      if (v === ln.text) src.edits.delete(k);
      else src.edits.set(k, { idx: it.idx, id: ln.id, keys: [...new Set(ln.segs.map((s) => s.key))], text: v, font: ln.font,
        fs: ln.segs[0].fs, tc: ln.segs[0].tc, tw: ln.segs[0].tw, th: ln.segs[0].th, ts: ln.segs[0].ts, tr: ln.segs[0].tr,
        fill: ln.fill, fillCS: ln.fillCS, tm: ln.segs[0].tm, ctm: ln.segs[0].ctm });
      bump(src); ensureLayer()._key = null; B.render(); changed();
    };
    ta.addEventListener("input", fit);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); close(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
    });
    ta.addEventListener("blur", () => setTimeout(() => { if (!ed.contains(document.activeElement)) close(true); }, 0));
    bar.addEventListener("pointerdown", (e) => e.preventDefault());
    bar.addEventListener("click", (e) => {
      const a = e.target.closest("button"); if (!a) return;
      if (a.dataset.a === "revert") ta.value = ln.text;
      close(true);
    });
    ta.focus(); ta.select();
  }

  // a typewriter comment: retyped in its own font, multi-line
  function ftEl(it, ft, vp) {
    const src = it.src, k = it.idx + "|" + ft.key, ed = src.ftEdits && src.ftEdits.get(k);
    const r = rectPx(vp, ft.rect);
    const n = document.createElement("div");
    n.className = "fl-item fl-line fl-ft" + (ed ? " fl-edited" : "") + (ft.editable ? "" : " fl-locked");
    n.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
    n.title = ft.editable ? `Typewriter comment · ${ft.info.name} ${+ft.size.toFixed(2)} pt — click to edit` : "This comment’s font can’t be retyped.";
    n.tabIndex = ft.editable ? 0 : -1;
    const open = () => {
      if (!ft.editable) return;
      const Lr = ensureLayer(); Lr.querySelectorAll(".fl-editor").forEach((x) => x.remove());
      const box = document.createElement("div"); box.className = "fl-item fl-editor";
      box.style.cssText = `left:${r.x}px;top:${r.y}px`;
      const ta = document.createElement("textarea"); ta.className = "fl-ft-ta"; ta.wrap = "off"; ta.spellcheck = true;
      ta.value = (ed ? ed.text : ft.text).replace(/\r\n|\r/g, "\n");
      Object.assign(ta.style, { fontSize: ft.size * MK.V.scale + "px", fontFamily: ft.info.css.family, fontWeight: ft.info.css.weight, fontStyle: ft.info.css.style, color: colorCss(ft.fill), minWidth: r.w + "px", minHeight: r.h + "px" });
      const fit = () => { ta.style.width = "0px"; ta.style.height = "0px"; ta.style.width = Math.max(r.w, ta.scrollWidth + 4) + "px"; ta.style.height = Math.max(r.h, ta.scrollHeight) + "px"; };
      const bar = document.createElement("div"); bar.className = "fl-edbar";
      bar.innerHTML = `<span>${ft.info.name.replace(/[<&]/g, "")} · ${+ft.size.toFixed(2)} pt · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line</span><button type="button" data-a="del" title="Remove this comment">Delete</button><button type="button" data-a="revert">Original</button><button type="button" data-a="ok">✓</button>`;
      box.append(ta, bar); Lr.appendChild(box); fit();
      let closed = false;
      const close = (save, value) => {
        if (closed) return; closed = true; box.remove();
        if (!save) return;
        const v = (value != null ? value : ta.value).replace(/\s+$/, "");
        if (!src.ftEdits) src.ftEdits = new Map();
        if (v === ft.text.replace(/\r\n|\r/g, "\n")) src.ftEdits.delete(k); else src.ftEdits.set(k, { idx: it.idx, key: ft.key, text: v });
        bump(src); ensureLayer()._key = null; B.render(); changed();
      };
      ta.addEventListener("input", fit);
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); close(true); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
      });
      ta.addEventListener("blur", () => setTimeout(() => { if (!box.contains(document.activeElement)) close(true); }, 0));
      bar.addEventListener("pointerdown", (e) => e.preventDefault());
      bar.addEventListener("click", (e) => {
        const b = e.target.closest("button"); if (!b) return;
        close(true, b.dataset.a === "del" ? "" : b.dataset.a === "revert" ? ft.text.replace(/\r\n|\r/g, "\n") : null);
      });
      ta.focus(); ta.select();
    };
    n.addEventListener("click", open);
    n.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); open(); } });
    return n;
  }

  /* ---------- form inputs ---------- */
  function fieldEl(src, fd, vp) {
    const r = rectPx(vp, fd.rect), V = MK.V;
    const wrap = document.createElement("div");
    wrap.className = "fl-item fl-field fl-f-" + fd.type;
    wrap.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
    wrap.dataset.name = fd.name; wrap.dataset.fkey = fd.name + "#" + fd.k;
    const val = getVal(src, fd);
    let ctl;
    const done = () => wrap.classList.toggle("fl-done", !!(src.fill && src.fill.has(fd.name)));
    const commit = () => { bump(src); done(); B.render(); changed(); };
    const look = fd.look;
    const styleText = (c, text) => {
      if (!look) return;
      const W = Math.abs(fd.rect[2] - fd.rect[0]), H = Math.abs(fd.rect[3] - fd.rect[1]);
      const lay = layoutText(look, fd, String(text || "") || "Mg", W, H, fd.bw);
      c.style.fontSize = lay.size * V.scale + "px";
      const st = stdFor(look.res || "Helvetica");
      const css = look.info ? look.info.css : { family: STDCSS[st.fam], weight: st.bold ? 700 : 400, style: st.ital ? "italic" : "normal" };
      c.style.fontFamily = css.family; c.style.fontWeight = css.weight; c.style.fontStyle = css.style;
      c.style.setProperty("--ink", look.css);
      if (fd.comb && fd.maxLen) c.style.letterSpacing = Math.max(0, r.w / fd.maxLen - lay.size * V.scale * 0.6) + "px";
    };
    if (fd.type === "text") {
      ctl = document.createElement(fd.multiline ? "textarea" : "input");
      if (!fd.multiline) ctl.type = "text";
      ctl.value = val;
      if (fd.maxLen !== undefined) ctl.maxLength = fd.maxLen;
      ctl.style.textAlign = ["left", "center", "right"][fd.align] || "left";
      styleText(ctl, val);
      ctl.addEventListener("input", () => { setVal(src, fd.name, ctl.value); done(); styleText(ctl, ctl.value); syncName(src, fd.name, ctl); });
      ctl.addEventListener("change", commit);
    } else if (fd.type === "check") {
      ctl = document.createElement("input"); ctl.type = "checkbox"; ctl.checked = !!val;
      ctl.addEventListener("change", () => { setVal(src, fd.name, ctl.checked); commit(); });
    } else if (fd.type === "radio") {
      ctl = document.createElement("input"); ctl.type = "radio";
      ctl.name = "fl-r-" + src.id + "-" + fd.name; ctl.value = fd.option || "";
      ctl.checked = fd.option !== undefined && val === fd.option;
      if (fd.option === undefined) ctl.disabled = true;
      ctl.addEventListener("pointerdown", () => { ctl._was = ctl.checked; });
      ctl.addEventListener("click", () => {
        if (ctl._was) { ctl.checked = false; setVal(src, fd.name, ""); } else setVal(src, fd.name, fd.option);
        ctl._was = false; commit();
      });
    } else if (fd.type === "drop" && fd.editable) {
      ctl = document.createElement("input"); ctl.type = "text"; ctl.value = val;
      const dl = document.createElement("datalist"); dl.id = "fl-dl-" + src.id + "-" + Math.random().toString(36).slice(2);
      fd.options.forEach((o) => dl.appendChild(new Option(o, o)));
      wrap.appendChild(dl); ctl.setAttribute("list", dl.id);
      styleText(ctl, val);
      ctl.addEventListener("input", () => { setVal(src, fd.name, ctl.value); done(); });
      ctl.addEventListener("change", commit);
    } else {
      ctl = document.createElement("select");
      if (fd.type === "list" && fd.multi) ctl.multiple = true;
      if (!ctl.multiple) ctl.appendChild(new Option("", ""));
      fd.options.forEach((o) => ctl.appendChild(new Option(o, o)));
      const sel = new Set(Array.isArray(val) ? val : [val]);
      [...ctl.options].forEach((o) => (o.selected = sel.has(o.value) && o.value !== ""));
      if (look) styleText(ctl, val);
      ctl.addEventListener("change", () => {
        const v = [...ctl.selectedOptions].map((o) => o.value).filter(Boolean);
        setVal(src, fd.name, fd.type === "list" ? v : v[0] || ""); commit();
      });
    }
    ctl.disabled = ctl.disabled || fd.readOnly;
    const label = fd.tip || fd.name;
    ctl.title = (fd.readOnly ? "Read-only: " : "") + label + (look && look.info ? ` — ${look.info.name}${look.size ? " " + look.size + " pt" : ", auto size"}` : "");
    ctl.setAttribute("aria-label", label);
    wrap.appendChild(ctl); done();
    return wrap;
  }
  function syncName(src, name, from) {
    if (!L) return;
    for (const w of L.querySelectorAll(".fl-field")) {
      if (w.dataset.name !== name) continue;
      const c = w.querySelector("input,textarea,select"); if (!c || c === from) continue;
      const v = src.fill && src.fill.has(name) ? src.fill.get(name) : null;
      if (v === null) continue;
      if (c.type === "checkbox") c.checked = !!v;
      else if (c.type === "radio") c.checked = c.value === v && v !== "";
      else if (c.tagName === "SELECT") { const s = new Set(Array.isArray(v) ? v : [v]); [...c.options].forEach((o) => (o.selected = s.has(o.value) && o.value !== "")); }
      else c.value = v;
      w.classList.add("fl-done");
    }
  }

  /* ---------- added text boxes ---------- */
  function autosize(ta) { ta.style.width = "0px"; ta.style.height = "0px"; ta.style.width = ta.scrollWidth + 2 + "px"; ta.style.height = ta.scrollHeight + "px"; }
  function textEl(uid, t) {
    const box = document.createElement("div"); box.className = "fl-item fl-text";
    const ta = document.createElement("textarea");
    ta.wrap = "off"; ta.rows = 1; ta.placeholder = "Type…"; ta.spellcheck = true; ta.value = t.text;
    ta.setAttribute("aria-label", "Text on the page");
    const grip = document.createElement("span"); grip.className = "fl-grip"; grip.textContent = "⠿"; grip.title = "Drag to move";
    const x = document.createElement("button"); x.type = "button"; x.className = "fl-x"; x.textContent = "✕"; x.title = "Remove this text";
    box.append(grip, ta, x);
    box._id = t.id;
    ta.addEventListener("input", () => autosize(ta));
    ta.addEventListener("focus", () => { S.sel = t.id; markSel(); paintTextControls(MK.itemByUid(uid)); });
    ta.addEventListener("blur", () => {
      const it = MK.itemByUid(uid); if (!it) return;
      const cur = (it.texts || []).find((y) => y.id === box._id); if (!cur) return;
      if (!ta.value.trim()) removeText(uid, box._id);
      else patchText(uid, box._id, { text: ta.value.replace(/\s+$/, "") }, null);
    });
    x.addEventListener("pointerdown", (e) => e.preventDefault());
    x.addEventListener("click", () => removeText(uid, box._id));
    let drag = null;
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      S.sel = box._id; markSel();
      const r = $m("mk-paper").getBoundingClientRect();
      drag = { sx: e.clientX, sy: e.clientY, l: box.offsetLeft, t: box.offsetTop, W: r.width, H: r.height, moved: false };
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener("pointermove", (e) => {
      if (!drag) return;
      box.style.left = drag.l + e.clientX - drag.sx + "px"; box.style.top = drag.t + e.clientY - drag.sy + "px"; drag.moved = true;
    });
    grip.addEventListener("pointerup", () => {
      if (!drag) return;
      const d = drag; drag = null; if (!d.moved) return;
      const it = MK.itemByUid(uid); if (!it) return;
      const cur = it.texts.find((y) => y.id === box._id); if (!cur) return;
      const u = Math.min(1, Math.max(0, box.offsetLeft / d.W)), v = Math.min(1, Math.max(0, box.offsetTop / d.H));
      patchText(uid, box._id, unplace(u, v, placed(cur, it.rot).turn), null);
    });
    return box;
  }
  function placeText(n, t, it) {
    const V = MK.V, p = placed(t, it.rot), ta = n.querySelector("textarea");
    n.style.left = p.u * V.w + "px"; n.style.top = p.v * V.h + "px";
    n.style.transform = p.turn ? `rotate(${p.turn}deg)` : "";
    ta.style.fontSize = t.s * V.scale + "px";
    const css = t.doc ? t.doc.cssFont : { family: (BASIC[t.font] || BASIC.sans).css, weight: 400, style: "normal" };
    ta.style.fontFamily = css.family; ta.style.fontWeight = css.weight; ta.style.fontStyle = css.style;
    ta.style.setProperty("--ink", t.doc ? t.doc.css : (COLORS[t.color] || COLORS.black).css);
    if (document.activeElement !== ta && ta.value !== t.text) ta.value = t.text;
    n.classList.toggle("on", S.sel === t.id);
    autosize(ta);
  }
  function markSel() { if (L) L.querySelectorAll(".fl-text").forEach((n) => n.classList.toggle("on", n._id === S.sel)); }

  // the text line nearest a point on the page (PDF coordinates)
  function nearestLine(it, x, y) {
    if (it.blank || !it.src || !it.src.lib) return null;
    let best = null, bd = Infinity;
    for (const l of pageModel(it.src, it.idx).lines) {
      if (!l.editable) continue;
      const dx = x < l.x0 ? l.x0 - x : x > l.x1 ? x - l.x1 : 0, dy = Math.abs(y - (l.y + 0.3 * l.size));
      const d = Math.hypot(dx * 0.35, dy);
      if (d < bd) { bd = d; best = l; }
    }
    return best;
  }
  const docLook = (l) => ({ res: l.font, name: l.info.name, flags: l.info.flags, asc: l.info.asc, dsc: l.info.dsc, fill: l.fill, fillCS: l.fillCS, css: colorCss(l.fill), cssFont: l.info.css });

  // MK asks first: is this press ours?
  function claim(e) {
    if (e.target.closest(".fl-item")) return true;
    if (S.tool === "edit") return true;                      // clicks between lines do nothing
    if (CUSTOM.has(S.tool)) { const it0 = itemNow(); return it0 ? !!CUSTOM.get(S.tool).claim(e, it0) : true; }
    if (S.tool !== "text") return false;
    if (e.button !== 0) return true;
    const it = itemNow(); if (!it) return true;
    e.preventDefault();
    const V = MK.V, f = MK.frac(e);
    let t = { id: newId(), r: it.rot || 0, text: "", color: prefs.color, font: "sans", s: prefs.size };
    const pdfPt = V.page.getViewport({ scale: 1 }).convertToPdfPoint(f.u * V.base.width, f.v * V.base.height);
    let line = null;
    if (prefs.font === "match") line = nearestLine(it, pdfPt[0], pdfPt[1]);
    else if (prefs.font.startsWith("doc:")) {
      const m = pageModel(it.src, it.idx).fonts.find((x) => x.res === prefs.font.slice(4));
      if (m) line = { font: m.res, info: m.info, size: prefs.size, fill: m.fill, fillCS: m.fillCS, y: null };
    } else t.font = BASIC[prefs.font] ? prefs.font : "sans";
    if (line) { t.doc = docLook(line); t.s = prefs.font === "match" ? +line.size.toFixed(2) : prefs.size; }
    // top-left of the box: put the baseline on the matched line when the click is close to it, else on the click
    const bl = boxBaseline(t);
    let baseV = f.v + (t.s * 0.3) / (V.h / V.scale);
    if (line && line.y != null && !(it.rot % 360)) {
      const ly = V.page.getViewport({ scale: 1 }).convertToViewportPoint(line.x0, line.y)[1] / V.base.height;
      if (Math.abs(ly - baseV) * (V.h / V.scale) < line.size * 0.9) baseV = ly;
    }
    t.u = Math.min(0.98, Math.max(0, f.u));
    t.v = Math.min(0.98, Math.max(0, baseV - (bl * t.s) / (V.h / V.scale)));
    S.sel = t.id;
    setTexts(it.uid, [...(it.texts || []), t], null);
    setTimeout(() => { const n = L && [...L.querySelectorAll(".fl-text")].find((x) => x._id === t.id); if (n) n.querySelector("textarea").focus(); }, 0);
    return true;
  }

  /* ---------- toolbar ---------- */
  const tools = el.querySelector(".mk-tools");
  const mode = document.createElement("div");
  mode.className = "seg fl-mode"; mode.setAttribute("role", "radiogroup"); mode.setAttribute("aria-label", "Tool");
  mode.innerHTML = `<label title="Click a line of text to retype it, in the PDF's own font"><input type="radio" name="fltool" value="edit">✎ Edit text</label><label title="Click anywhere on the page to type"><input type="radio" name="fltool" value="text">T Add text</label><label title="Click to drop a check mark"><input type="radio" name="fltool" value="mark">✓ Marks</label>`;
  const ttools = document.createElement("div");
  ttools.className = "fl-tools";
  ttools.innerHTML = `
    <label class="mk-size fl-size">Font <select id="fl-font"></select></label>
    <label class="mk-size fl-size" title="Text size in points">Size <input type="number" id="fl-size" min="4" max="96" step="0.25"><span>pt</span></label>
    <div class="mk-colors fl-colors" role="radiogroup" aria-label="Text colour">
      ${Object.entries(COLORS).map(([k, c]) => `<label title="${c.label}"><input type="radio" name="flcolor" value="${k}"><i style="background:${c.css}"></i></label>`).join("")}
    </div>`;
  tools.prepend(mode);
  tools.appendChild(ttools);
  const optbar = document.createElement("div");
  optbar.className = "fl-optbar"; optbar.hidden = true;
  el.querySelector(".mk-bar").after(optbar);
  function addTool(def) {
    CUSTOM.set(def.id, def);
    const lab = document.createElement("label");
    lab.title = def.title || ""; lab.innerHTML = `<input type="radio" name="fltool" value="${def.id}">${def.label}`;
    const before = mode.querySelector('input[value="mark"]');
    mode.insertBefore(lab, before ? before.parentNode : null);
    lab.querySelector("input").addEventListener("change", () => setTool(def.id));
    if (def.opts) { def.opts.dataset.opts = def.id; def.opts.hidden = true; optbar.appendChild(def.opts); }
  }
  const hint = $m("mk-hint"), hint0 = hint.innerHTML;
  const HINTS = {
    text: "Click anywhere to type — <b>Match page text</b> copies the font, size and colour of the nearest line · drag <b>⠿</b> to move · <kbd>Esc</kbd> finishes typing",
    edit: "Click any line to retype it in the PDF’s own font and size · <kbd>Enter</kbd> applies · <kbd>Esc</kbd> cancels · type straight into form boxes",
  };
  function setTool(t) {
    const prev = S.tool;
    S.tool = t === "text" || t === "edit" || CUSTOM.has(t) ? t : "mark";
    if (prev !== S.tool && CUSTOM.has(prev) && CUSTOM.get(prev).leave) CUSTOM.get(prev).leave();
    el.dataset.tool = S.tool;
    optbar.querySelectorAll("[data-opts]").forEach((n) => (n.hidden = n.dataset.opts !== S.tool));
    optbar.hidden = !optbar.querySelector(`[data-opts="${CSS.escape(S.tool)}"]`) && !optbar.querySelector(".fl-viewopts");
    mode.querySelectorAll("input").forEach((r) => (r.checked = r.value === S.tool));
    el.classList.toggle("fl-tmode", S.tool === "text");
    el.classList.toggle("fl-emode", S.tool === "edit");
    hint.innerHTML = HINTS[S.tool] || (CUSTOM.has(S.tool) ? CUSTOM.get(S.tool).hint : "") || hint0;
    if (CUSTOM.has(S.tool) && CUSTOM.get(S.tool).enter) CUSTOM.get(S.tool).enter();
    paintTextControls();
    const it = itemNow(); if (it && MK.V.page) { ensureLayer()._key = null; layer(it); }
  }
  mode.querySelectorAll("input").forEach((r) => r.addEventListener("change", () => setTool(r.value)));
  function fontOptions(it) {
    const sel = $m("fl-font"), cur = prefs.font;
    const docFonts = it && !it.blank && it.src && it.src.lib ? pageModel(it.src, it.idx).fonts : [];
    sel.replaceChildren(new Option("Match page text (auto)", "match"));
    if (docFonts.length) {
      const g = document.createElement("optgroup"); g.label = "Fonts in this PDF";
      docFonts.forEach((d) => g.appendChild(new Option(d.info.name, "doc:" + d.res)));
      sel.appendChild(g);
    }
    const g2 = document.createElement("optgroup"); g2.label = "Standard";
    Object.entries(BASIC).forEach(([k, b]) => g2.appendChild(new Option(b.label, k)));
    sel.appendChild(g2);
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "match";
  }
  function selectedText(it) { it = it || itemNow(); return it && it.texts ? it.texts.find((t) => t.id === S.sel) : null; }
  function paintTextControls(it) {
    it = it || itemNow();
    fontOptions(it);
    const t = selectedText(it);
    $m("fl-size").value = t ? t.s : prefs.size;
    el.querySelectorAll('input[name="flcolor"]').forEach((r) => (r.checked = r.value === (t && !t.doc ? t.color : prefs.color)));
  }
  function onStyle(patch) {
    if (patch.font !== undefined) prefs.font = patch.font;
    if (patch.s !== undefined) prefs.size = patch.s;
    if (patch.color !== undefined) prefs.color = patch.color;
    savePrefs();
    const it = itemNow(), t = selectedText(it);
    if (t) {
      const n = L && [...L.querySelectorAll(".fl-text")].find((x) => x._id === t.id);
      const next = { text: n ? n.querySelector("textarea").value : t.text };
      if (patch.s !== undefined) next.s = patch.s;
      if (patch.color !== undefined) {
        next.color = patch.color;
        // keep the matched font, only change its colour
        if (t.doc) next.doc = { ...t.doc, fill: `${COLORS[patch.color].pdf.map(f4).join(" ")} rg`, fillCS: "", css: COLORS[patch.color].css };
      }
      if (patch.font !== undefined) {
        if (BASIC[patch.font]) { next.font = patch.font; next.doc = null; }
        else {
          const ms = pageModel(it.src, it.idx);
          const m = patch.font === "match" ? (() => { const tl = placed(t, it.rot); const pp = MK.V.page.getViewport({ scale: 1 }).convertToPdfPoint(tl.u * MK.V.base.width, tl.v * MK.V.base.height); return nearestLine(it, pp[0], pp[1] - t.s); })()
            : ms.fonts.find((x) => x.res === patch.font.slice(4));
          if (m) { next.doc = docLook({ font: m.res || m.font, info: m.info, fill: m.fill, fillCS: m.fillCS }); if (patch.font === "match" && m.size) next.s = +m.size.toFixed(2); }
        }
      }
      patchText(it.uid, t.id, next, null);
    }
    paintTextControls();
  }
  $m("fl-font").addEventListener("change", (e) => onStyle({ font: e.target.value }));
  $m("fl-size").addEventListener("change", (e) => { const s = clampSize(e.target.value); e.target.value = s; onStyle({ s }); });
  el.querySelectorAll('input[name="flcolor"]').forEach((r) => r.addEventListener("change", () => onStyle({ color: r.value })));

  const clear0 = $m("mk-clear").onclick;
  $m("mk-clear").onclick = () => {
    const it = itemNow(); if (!it) return;
    if (S.tool === "text") {
      if (!it.texts || !it.texts.length) return;
      S.sel = null; return setTexts(it.uid, [], `Removed ${plural(it.texts.length, "text box")} from this page`);
    }
    if (S.tool === "edit") {
      const src = it.src; if (!src || (!src.edits && !src.ftEdits)) return; src.edits = src.edits || new Map();
      let n = 0; for (const [k, e] of [...src.edits]) if (e.idx === it.idx) { src.edits.delete(k); n++; }
      if (src.ftEdits) for (const [k, e] of [...src.ftEdits]) if (e.idx === it.idx) { src.ftEdits.delete(k); n++; }
      if (!n) return;
      bump(src); ensureLayer()._key = null; B.render(); return changed(`Put back the original text of ${plural(n, "line")}`);
    }
    return clear0 && clear0();
  };
  $m("mk-clear").title = "Undo everything the current tool did on this page";
  const mkOpen = document.getElementById("mk-open");
  if (mkOpen) mkOpen.addEventListener("click", () => setTool("mark"), true);

  /* ---------- dock panel ---------- */
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>';
  const dock = document.createElement("details");
  dock.className = "tool"; dock.id = "d-fill"; dock.setAttribute("name", "tools");
  dock.innerHTML = `
    <summary><span class="ic" style="background:#E3EAFF;color:#1A3FB0">${ICON}</span><span>Edit text &amp; fill forms<small>In the PDF’s own fonts and sizes</small></span><em class="on-tag" id="filltag" hidden>0</em></summary>
    <div class="tbody">
      <p class="hint" id="fl-found"></p>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn go" id="fl-open">Edit this page</button>
        <button class="btn" id="fl-open-add">Add text</button>
      </div>
      <p class="hint"><b>Edit text</b>: click any line and retype it; it keeps the PDF’s font, size and colour. <b>Forms</b>: type straight into the boxes; answers use the form’s own font. <b>Add text</b>: click anywhere; it matches the nearest text.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn ghost" id="fl-clear">Undo all edits, answers &amp; text</button></div>
      <p class="hint" id="fl-count"></p>
      <p class="hint">If a character isn’t in the PDF’s font (fonts are often stored with only the letters used), the closest standard font is used for that character.</p>
    </div>`;
  const marksDock = document.getElementById("d-marks");
  if (marksDock) marksDock.before(dock); else document.querySelector(".dock").appendChild(dock);
  const openWith = (tool) => {
    const sel = B.selected();
    const it = sel[0] || B.items.find(pageHasFields) || B.items[0];
    if (!it) return toast("Add a PDF first.", "err");
    setTool(tool); MK.show(it.uid);
  };
  document.getElementById("fl-open").onclick = () => openWith("edit");
  document.getElementById("fl-open-add").onclick = () => openWith("text");
  document.getElementById("fl-clear").onclick = () => {
    const n = answers() + editCount(), t = B.items.reduce((a, i) => a + (i.texts ? i.texts.length : 0), 0);
    if (!n && !t) return toast("Nothing to undo yet.");
    if (!confirm("Undo every text edit, form answer and added text?")) return;
    for (const s of fileList()) { s.fill = null; s.edits = null; s.ftEdits = null; bump(s); }
    if (L) L._key = null;
    B.commit(B.items.map((i) => (i.texts && i.texts.length ? { ...i, texts: [] } : i)), "Back to the original text and form");
  };

  /* ---------- tiles, tags, counts ---------- */
  const render0 = B.render;
  B.render = function () {
    render0.call(this);
    for (const c of $$(".card", this.el)) {
      const it = MK.itemByUid(c.dataset.uid); if (!it) continue;
      const nt = (it.texts || []).filter((t) => t.text && t.text.trim()).length;
      const ne = it.src ? [...(it.src.edits ? it.src.edits.values() : []), ...(it.src.ftEdits ? it.src.ftEdits.values() : [])].filter((e) => e.idx === it.idx).length : 0;
      const form = pageHasFields(it);
      if (!nt && !form && !ne) continue;
      let filled = false;
      if (form && it.src.fill && it.src.fill.size) { const here = new Set(fieldsOf(it.src).filter((f) => f.page === it.idx).map((f) => f.name)); filled = [...it.src.fill.keys()].some((k) => here.has(k)); }
      const b = document.createElement("span"); b.className = "flbadge" + (filled || nt || ne ? " ok" : "");
      b.textContent = [form && (filled ? "Form ✓" : "Form"), ne && `✎ ${ne}`, nt && `T ${nt}`].filter(Boolean).join(" · ");
      b.title = "Double-click to edit this page.";
      c.querySelector(".sheetbox").appendChild(b);
    }
  };
  const changed0 = changed;
  changed = function (label) {
    changed0(label);
    const nt = B.items.reduce((a, i) => a + (i.texts ? i.texts.filter((t) => t.text && t.text.trim()).length : 0), 0);
    const na = answers(), ne = editCount();
    const tag = document.getElementById("filltag");
    if (tag) { tag.hidden = !(nt || na || ne); tag.textContent = nt + na + ne; }
    const parts = [ne && plural(ne, "edited line"), na && plural(na, "form answer"), nt && plural(nt, "added text")].filter(Boolean);
    const cnt = document.getElementById("fl-count");
    if (cnt) cnt.textContent = parts.length ? `${parts.join(", ")}. Written into the PDF when you download.` : "";
    if (ne) $("#stamptags").append(Object.assign(document.createElement("span"), { textContent: `+ ${plural(ne, "edited line")}` }));
    if (na) $("#stamptags").append(Object.assign(document.createElement("span"), { textContent: "+ form filled" }));
    if (nt) $("#stamptags").append(Object.assign(document.createElement("span"), { textContent: `+ ${plural(nt, "added text")}` }));
    const found = [];
    for (const s of fileList()) {
      const n = fieldNames(s).size; if (n) found.push(`${s.name}: ${plural(n, "form field")}`);
      if (s._told) continue; s._told = true;
      if (n) {
        setTimeout(() => toast(`${s.name} is a form with ${plural(n, "field")}. Double-click a page to fill it in.`, "ok"), 900);
        if (!document.querySelector(".dock details[open]")) dock.open = true;
      }
    }
    const fe = document.getElementById("fl-found");
    if (fe) fe.textContent = found.length ? found.join(" · ") : "No form boxes in these files. You can still edit any text or add your own.";
  };

  window.SSFill = {
    layer, claim, apply, addTool, after, setTool, itemNow, refresh: () => refresh(),
    util: { pageContent, setContent, appendContent, readText, groupLines, pageModel, fontInfo, f4, stdReady, STD, colorCss, rectPx, viewport, latin1, enc, newId },
    lineOffset: null,
    formsOn: () => false,
    get tool() { return S.tool; },
    _test: { fontInfo, readText, groupLines, pageModel, parseOps, filledSource, fieldLook, exactAppearance },
  };
  setTool("mark");
  B.render(); changed();
})();

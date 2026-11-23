/* Unlock protected PDFs for editing (V8.17).
   Many PDFs (government forms, e-signed documents) are encrypted with an
   empty open password and an owner password that only restricts editing.
   They open fine in any viewer, but pdf-lib can't read them, so the editor
   used to copy their pages as pictures. SSDecrypt(bytes, password) returns
   the same PDF decrypted (Standard security handler: RC4 40/128-bit,
   AES-128, AES-256 R5/R6), using the open password, or the owner password,
   or none. Everything happens on this computer. Needs node-forge (ss-forge). */
(function () {
  "use strict";
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream, PDFNumber } = PDFLib;
  const N = (k) => PDFName.of(k);
  const latin1 = (b) => { let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };
  const bytesOf = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
  const PAD = bytesOf("\x28\xbf\x4e\x5e\x4e\x75\x8a\x41\x64\x00\x4e\x56\xff\xfa\x01\x08\x2e\x2e\x00\xb6\xd0\x68\x3e\x80\x2f\x0c\xa9\xfe\x64\x53\x69\x7a");
  const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
  const eq = (a, b, n) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };
  const md5 = (b) => { const m = forge.md.md5.create(); m.update(latin1(b)); return bytesOf(m.digest().getBytes()); };
  const sha = (bits, b) => { const m = (bits === 256 ? forge.md.sha256 : bits === 384 ? forge.md.sha384 : forge.md.sha512).create(); m.update(latin1(b)); return bytesOf(m.digest().getBytes()); };
  function rc4(key, data) {
    const s = new Uint8Array(256); for (let i = 0; i < 256; i++) s[i] = i;
    for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
    const out = new Uint8Array(data.length);
    for (let k = 0, i = 0, j = 0; k < data.length; k++) { i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]]; out[k] = data[k] ^ s[(s[i] + s[j]) & 255]; }
    return out;
  }
  function aes(dec, key, iv, data, padding) {
    const c = (dec ? forge.cipher.createDecipher : forge.cipher.createCipher)("AES-CBC", forge.util.createBuffer(latin1(key)));
    c.start({ iv: forge.util.createBuffer(latin1(iv)) });
    c.update(forge.util.createBuffer(latin1(data)));
    const ok = padding ? c.finish() : c.finish(() => true);
    if (!ok && padding) return null;
    return bytesOf(c.output.getBytes());
  }
  const aesDecrypt = (key, data) => {                         // first 16 bytes are the IV, PKCS#7 padded
    if (data.length < 32) return new Uint8Array(0);
    return aes(true, key, data.subarray(0, 16), data.subarray(16), true) || aes(true, key, data.subarray(0, 16), data.subarray(16), false);
  };
  const padPw = (pw) => cat(pw.subarray(0, 32), PAD.subarray(0, Math.max(0, 32 - pw.length)));
  const le32 = (n) => Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);

  /* ---------- keys (ISO 32000 7.6.4) ---------- */
  function keyR4(E, pw) {
    let k = md5(cat(padPw(pw), E.O.subarray(0, 32), le32(E.P), E.id, E.R >= 4 && !E.encMeta ? Uint8Array.of(255, 255, 255, 255) : new Uint8Array(0)));
    if (E.R >= 3) for (let i = 0; i < 50; i++) k = md5(k.subarray(0, E.n));
    return k.subarray(0, E.n);
  }
  function userOk(E, key) {
    if (E.R === 2) return eq(rc4(key, PAD), E.U, 32);
    let x = rc4(key, md5(cat(PAD, E.id)));
    for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
    return eq(x, E.U, 16);
  }
  function ownerToUser(E, pw) {
    let k = md5(padPw(pw));
    if (E.R >= 3) for (let i = 0; i < 50; i++) k = md5(k);
    k = k.subarray(0, E.n);
    let d = E.O.subarray(0, 32);
    if (E.R === 2) d = rc4(k, d); else for (let i = 19; i >= 0; i--) d = rc4(k.map((b) => b ^ i), d);
    return d;
  }
  function hash6(E, pw, salt, udata) {
    let K = sha(256, cat(pw, salt, udata));
    if (E.R === 5) return K;
    for (let i = 0; ; i++) {
      const one = cat(pw, K, udata), K1 = new Uint8Array(one.length * 64);
      for (let r = 0; r < 64; r++) K1.set(one, r * one.length);
      const Ev = aes(false, K.subarray(0, 16), K.subarray(16, 32), K1, false);
      let m = 0; for (let j = 0; j < 16; j++) m += Ev[j];
      K = sha([256, 384, 512][m % 3], Ev);
      if (i >= 63 && Ev[Ev.length - 1] <= i - 31) break;
    }
    return K.subarray(0, 32);
  }
  function fileKey(E, password) {
    const enc = new TextEncoder();
    if (E.V === 5) {
      const pw = enc.encode((password || "").normalize("NFKC")).subarray(0, 127);
      const U = E.U, O = E.O;
      if (eq(hash6(E, pw, U.subarray(32, 40), new Uint8Array(0)), U, 32))
        return aes(true, hash6(E, pw, U.subarray(40, 48), new Uint8Array(0)), new Uint8Array(16), E.UE, false);
      if (eq(hash6(E, pw, O.subarray(32, 40), U.subarray(0, 48)), O, 32))
        return aes(true, hash6(E, pw, O.subarray(40, 48), U.subarray(0, 48)), new Uint8Array(16), E.OE, false);
      return null;
    }
    const pw = bytesOf(unescape(encodeURIComponent(password || ""))).subarray(0, 32);
    let k = keyR4(E, pw); if (userOk(E, k)) return k;
    k = keyR4(E, ownerToUser(E, pw)); if (userOk(E, k)) return k;     // they typed the owner password
    return null;
  }
  function objKey(E, num, gen, aesMode) {
    if (E.V === 5) return E.key;
    const k = md5(cat(E.key, Uint8Array.of(num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255), aesMode ? bytesOf("sAlT") : new Uint8Array(0)));
    return k.subarray(0, Math.min(E.n + 5, 16));
  }
  const decryptData = (E, mode, num, gen, data) =>
    mode === "none" ? data : mode === "aes" ? aesDecrypt(objKey(E, num, gen, true), data) : rc4(objKey(E, num, gen, false), data);

  /* ---------- read the /Encrypt dictionary with pdf-lib (it can parse the trailer, not the objects) ---------- */
  function cfMode(enc, name) {
    if (!name || name === "Identity") return "none";
    const cf = enc.lookup(N("CF")), f = cf instanceof PDFDict ? cf.lookup(N(name)) : null;
    const m = f instanceof PDFDict ? f.lookup(N("CFM")) : null;
    const s = m instanceof PDFName ? m.decodeText() : "V2";
    return s === "AESV2" || s === "AESV3" ? "aes" : s === "None" ? "none" : "rc4";
  }
  const strBytes = (o) => (o instanceof PDFString || o instanceof PDFHexString ? o.asBytes() : new Uint8Array(0));
  function readEncrypt(s) {
    // the trailer (or the cross-reference stream dictionary) names /Encrypt and /ID
    const enc = /\/Encrypt\s+(\d+)\s+(\d+)\s+R/.exec(s.slice(s.lastIndexOf("/Encrypt") - 2));
    if (!enc) return null;
    const re = new RegExp(`(?:^|[\\r\\n\\s])${enc[1]}\\s+${enc[2]}\\s+obj\\b`, "g");
    let m, at = -1; while ((m = re.exec(s))) at = m.index;
    if (at < 0) return null;
    const end = s.indexOf("endobj", at);
    let idm = null; for (const x of s.matchAll(/\/ID\s*\[\s*(<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\)])*\))/g)) idm = x;
    return { num: +enc[1], text: s.slice(at, end) + "\nendobj\n", idText: idm ? idm[1] : "<>" };
  }

  async function SSDecrypt(bytes, password) {
    if (!window.forge) return null;
    const s = latin1(bytes);
    const info = readEncrypt(s);
    if (!info) return null;
    // parse the Encrypt dict and the ID with pdf-lib's object parser, from a tiny PDF
    const tiny = bytesOf(`%PDF-1.7\n1 0 obj\n${info.text.replace(/^[\s\S]*?obj/, "").replace(/endobj[\s\S]*$/, "")}\nendobj\n2 0 obj\n${info.idText}\nendobj\ntrailer\n<< /Size 3 >>\n%%EOF`);
    const t = await PDFDocument.load(tiny, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    const enc = t.context.lookup(PDFLib.PDFRef.of(1, 0)), idObj = t.context.lookup(PDFLib.PDFRef.of(2, 0));
    if (!(enc instanceof PDFDict)) return null;
    const filt = enc.lookup(N("Filter"));
    if (!(filt instanceof PDFName) || filt.decodeText() !== "Standard") throw new Error("This PDF uses certificate security, which only its recipients can open.");
    const num = (k, d) => { const v = enc.lookup(N(k)); return v instanceof PDFNumber ? v.asNumber() : d; };
    const em = enc.lookup(N("EncryptMetadata"));
    const E = { V: num("V", 0), R: num("R", 2), P: num("P", 0) | 0, O: strBytes(enc.lookup(N("O"))), U: strBytes(enc.lookup(N("U"))),
      OE: strBytes(enc.lookup(N("OE"))), UE: strBytes(enc.lookup(N("UE"))), id: strBytes(idObj), encMeta: !(em && em.toString() === "false") };
    E.n = E.V === 1 ? 5 : Math.round(num("Length", 40) / 8) || 5;
    if (E.R === 2) E.n = 5;
    const stmF = E.V >= 4 ? cfMode(enc, (enc.lookup(N("StmF")) || { decodeText: () => "Identity" }).decodeText()) : "rc4";
    const strF = E.V >= 4 ? cfMode(enc, (enc.lookup(N("StrF")) || { decodeText: () => "Identity" }).decodeText()) : "rc4";
    E.key = fileKey(E, password);
    if (!E.key) return { needPassword: true };

    /* 1. streams, at the byte level (so pdf-lib can then read object streams) */
    const parts = [], top = new Set();
    const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
    let pos = 0, last = 0, m2;
    objRe.lastIndex = 0;
    const indirectLen = (n, g) => { const r = new RegExp(`(?:^|\\s)${n}\\s+${g}\\s+obj\\s*(\\d+)\\s*endobj`, "g"); let x, v = null; while ((x = r.exec(s))) v = +x[1]; return v; };
    while ((m2 = objRe.exec(s))) {
      const n = +m2[1], g = +m2[2], st = m2.index;
      const endObj = s.indexOf("endobj", objRe.lastIndex);
      const sm = /\bstream(\r\n|\n|\r)/g; sm.lastIndex = objRe.lastIndex;
      const sx = sm.exec(s);
      top.add(n + " " + g);
      if (!sx || (endObj >= 0 && sx.index > endObj)) { objRe.lastIndex = endObj > 0 ? endObj + 6 : objRe.lastIndex; continue; }
      const dict = s.slice(st, sx.index), dataStart = sx.index + sx[0].length;
      let len = null;
      const lm = /\/Length(?![A-Za-z0-9])\s+(\d+)(?:\s+(\d+)\s+R)?/.exec(dict);
      if (lm) len = lm[2] !== undefined ? indirectLen(lm[1], lm[2]) : +lm[1];
      if (len == null || !/^\s*endstream/.test(s.slice(dataStart + len, dataStart + len + 20))) {
        const es = s.indexOf("endstream", dataStart); if (es < 0) break;
        len = es - dataStart; if (s[dataStart + len - 1] === "\n") len--; if (s[dataStart + len - 1] === "\r") len--;
      }
      const data = bytes.subarray(dataStart, dataStart + len);
      const skip = n === info.num || /\/Type\s*\/XRef/.test(dict) || (!E.encMeta && /\/Type\s*\/Metadata/.test(dict)) || /\/Filter\s*\[?\s*\/Crypt/.test(dict);
      const out = skip ? data : decryptData(E, stmF, n, g, data);
      const newDict = lm ? dict.replace(lm[0], `/Length ${out.length}`) : dict.replace(/>>\s*$/, `/Length ${out.length}>>`);
      parts.push(bytes.subarray(last, st), bytesOf(newDict + "stream\n"), out, bytesOf("\nendstream"));
      const es2 = s.indexOf("endstream", dataStart + len);
      last = es2 + 9; objRe.lastIndex = last;
    }
    parts.push(bytes.subarray(last));
    const plain1 = cat(...parts);

    /* 2. strings, object by object (strings inside object streams aren't encrypted) */
    const doc = await PDFDocument.load(plain1, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    const ctx = doc.context;
    const dec = (o, n, g) => PDFHexString.of(Array.from(decryptData(E, strF, n, g, o.asBytes()), (b) => b.toString(16).padStart(2, "0")).join(""));
    const walk = (o, n, g) => {
      if (o instanceof PDFRawStream) return walk(o.dict, n, g);
      if (o instanceof PDFDict) {
        const sig = o.has(N("ByteRange"));
        for (const [k, v] of o.entries()) {
          if (sig && k.decodeText() === "Contents") continue;
          if (v instanceof PDFString || v instanceof PDFHexString) o.set(k, dec(v, n, g)); else walk(v, n, g);
        }
      } else if (o instanceof PDFArray) {
        for (let i = 0; i < o.size(); i++) { const v = o.get(i); if (v instanceof PDFString || v instanceof PDFHexString) o.set(i, dec(v, n, g)); else walk(v, n, g); }
      }
    };
    if (strF !== "none") for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (ref.objectNumber === info.num || !top.has(ref.objectNumber + " " + ref.generationNumber)) continue;
      walk(obj, ref.objectNumber, ref.generationNumber);
    }
    ctx.trailerInfo.Encrypt = undefined;
    // its own signatures can't survive an edit: keep how they look, drop the signature values
    const af = doc.catalog.lookup(N("AcroForm"));
    if (af instanceof PDFDict) af.delete(N("SigFlags"));
    doc.catalog.delete(N("Perms"));
    let signed = false;
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict && obj.lookup(N("FT")) instanceof PDFName && obj.lookup(N("FT")).decodeText() === "Sig" && obj.has(N("V"))) { obj.delete(N("V")); obj.set(N("Ff"), ctx.obj(1)); signed = true; }
    }
    const out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
    return { bytes: out, signed, restricted: (E.P & 0b100111000) !== 0b100111000 };
  }
  window.SSDecrypt = SSDecrypt;
  // say so once, after the file is on the board
  if (typeof changed === "function") {
    const changed0 = changed;
    changed = function (label) {
      changed0(label);
      for (const src of fileList()) {
        if (!src.unlocked || src._unlockTold) continue;
        src._unlockTold = true;
        setTimeout(() => toast(`${src.name} was protected against editing. It’s unlocked on this computer so you can edit it.` +
          (src.unlocked.signed ? " Its existing digital signature won’t be valid in your edited copy." : ""), "ok"), 1300);
      }
    };
  }
})();

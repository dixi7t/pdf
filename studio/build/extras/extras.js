/* V8.20 extras: White-out / Black-out, Shapes, Sticky notes, Insert image,
   Export pages as images, Document properties.
   Plugs into the page view like the V8.17 tools: everything is stored per page
   in item.annots (so undo/redo, move, resize and Delete already work) through
   the helpers ss-tools shares as SSTools._k.
   - White-outs are painted into the page itself right after the page is built
     (before page numbers, typed text, stamps…), so Typewriter text goes on top.
     With "Remove the text underneath", every letter whose middle is inside the
     box is taken out of the page content (the pen still moves the same, so the
     rest of the line doesn't shift).
   - Shapes and notes are real PDF comments (Square, Circle, Line, Text + Popup).
   - Pictures are drawn into the page.
   Nothing is uploaded. */
(function () {
  "use strict";
  const F = window.SSFill, MK = window.MK, T = window.SSTools;
  if (!F || !MK || !T || !T._k) return;
  const K = T._k, U = F.util, f4 = U.f4;
  const { PDFHexString, PDFName } = PDFLib;
  const N = (k) => PDFName.of(k);
  const $m = MK.$m, esc = K.esc, css = K.css;

  /* ---------- settings kept on this computer ---------- */
  const X = Object.assign({ wo: "white", woLast: "white", woColor: "#ffffff", woStrip: true, shape: "rect", shStroke: "red", shFill: "none", shW: 2, noteColor: "yellow" },
    K.store.get("pdfcraft.x2", {}));
  const saveX = () => K.store.set("pdfcraft.x2", X);

  const STROKE = { black: [0.07, 0.07, 0.07], blue: [0.1, 0.25, 0.69], red: [0.82, 0.08, 0.17], green: [0.08, 0.52, 0.24], orange: [0.93, 0.47, 0.05] };
  const FILL = { none: ["No fill", null], white: ["White", [1, 1, 1]], yellow: ["Yellow", [1, 0.95, 0.55]], blue: ["Light blue", [0.8, 0.9, 1]],
    pink: ["Pink", [1, 0.85, 0.9]], green: ["Light green", [0.85, 0.95, 0.8]], gray: ["Gray", [0.85, 0.85, 0.85]], same: ["Same as line", "same"] };
  const NOTE = { yellow: [1, 0.82, 0.1], blue: [0.35, 0.65, 1], green: [0.4, 0.8, 0.35], pink: [1, 0.5, 0.7], orange: [1, 0.6, 0.2] };
  const SHAPES = { rect: "Rectangle", ellipse: "Ellipse", line: "Line", arrow: "Arrow" };
  const hexRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ""); const n = m ? parseInt(m[1], 16) : 0xffffff; return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
  const fillOp = (c) => `${c.map(f4).join(" ")} rg`;
  const strokeOp = (c) => `${c.map(f4).join(" ")} RG`;
  const inR = (p, r) => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];
  const ptM = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
  const syncRibbon = () => document.dispatchEvent(new Event("x2-sync"));

  // the picked object, if it is of this type
  function picked(type) {
    const it = K.itemNow(); if (!it || !K.sel.id) return null;
    const a = (it.annots || []).find((x) => x.id === K.sel.id && x.type === type);
    return a ? { it, a } : null;
  }
  const patchAnnot = (it, id, patch, label) => K.setAnnots(it.uid, it.annots.map((x) => (x.id === id ? { ...x, ...patch } : x)), label);

  /* ================= White-out ================= */
  // the colour of the page just around a box (most common colour on its edge)
  function sampleBg(rect) {
    const c = $m("mk-paper").querySelector("#mk-canvas"); if (!c) return [1, 1, 1];
    const r = K.rectPx(rect), k = c.width / MK.V.w;
    const x0 = Math.max(0, Math.floor((r.x - 3) * k)), y0 = Math.max(0, Math.floor((r.y - 3) * k));
    const x1 = Math.min(c.width - 1, Math.ceil((r.x + r.w + 3) * k)), y1 = Math.min(c.height - 1, Math.ceil((r.y + r.h + 3) * k));
    if (x1 <= x0 || y1 <= y0) return [1, 1, 1];
    let data;
    try { data = c.getContext("2d").getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1); } catch { return [1, 1, 1]; }
    const W = data.width, H = data.height, bins = new Map(), ring = Math.max(1, Math.round(2 * k));
    const add = (x, y) => {
      const i = (y * W + x) * 4, d = data.data;
      const key = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | d[i + 2] >> 4;
      const b = bins.get(key) || [0, 0, 0, 0]; b[0] += d[i]; b[1] += d[i + 1]; b[2] += d[i + 2]; b[3]++; bins.set(key, b);
    };
    for (let x = 0; x < W; x++) for (let t = 0; t < ring; t++) { add(x, t); add(x, H - 1 - t); }
    for (let y = ring; y < H - ring; y++) for (let t = 0; t < ring; t++) { add(t, y); add(W - 1 - t, y); }
    let best = null; for (const b of bins.values()) if (!best || b[3] > best[3]) best = b;
    return best ? [best[0] / best[3] / 255, best[1] / best[3] / 255, best[2] / best[3] / 255] : [1, 1, 1];
  }
  function woColor(mode, rect) {
    if (mode === "black") return [0, 0, 0];
    if (mode === "custom") return hexRgb(X.woColor);
    if (mode === "match") return sampleBg(rect);
    return [1, 1, 1];
  }
  const woOpts = K.pane(`
    <div class="seg" role="radiogroup" aria-label="Cover with">
      <label><input type="radio" name="x2wo" value="white" data-rbsync>White</label>
      <label title="Uses the colour of the page around the box, so it blends in on tinted paper"><input type="radio" name="x2wo" value="match" data-rbsync>Match background</label>
      <label title="A black box, as for a redaction"><input type="radio" name="x2wo" value="black" data-rbsync>Black</label>
      <label title="The colour picked on the right"><input type="radio" name="x2wo" value="custom" data-rbsync>Colour</label>
    </div>
    <input type="color" id="x2-woc" title="Pick a colour for the box">
    <label class="check" title="Every letter under the box is taken out of the PDF, so it can't be selected, copied or searched. Pictures under it are only covered."><input type="checkbox" id="x2-strip">Remove the text underneath</label>`);
  const woC = woOpts.querySelector("#x2-woc"), woStrip = woOpts.querySelector("#x2-strip");
  function paintWo() {
    woOpts.querySelectorAll('input[name="x2wo"]').forEach((r) => (r.checked = r.value === X.wo));
    woC.value = X.woColor; woStrip.checked = !!X.woStrip;
  }
  function setWoMode(mode, fromUi) {
    X.wo = mode; if (mode !== "black") X.woLast = mode; else X.woStrip = true;
    saveX(); if (!fromUi) paintWo();
    const p = picked("wo");
    if (p) patchAnnot(p.it, p.a.id, { mode, color: woColor(mode, p.a.rect), strip: mode === "black" ? true : p.a.strip }, null);
    syncRibbon();
  }
  woOpts.querySelectorAll('input[name="x2wo"]').forEach((r) => (r.onchange = () => setWoMode(r.value, true)));
  woC.oninput = () => { X.woColor = woC.value; saveX(); };
  woC.onchange = () => { X.woColor = woC.value; setWoMode("custom"); };
  woStrip.onchange = () => {
    X.woStrip = woStrip.checked; saveX();
    const p = picked("wo"); if (p) patchAnnot(p.it, p.a.id, { strip: X.woStrip }, null);
  };
  paintWo();
  F.addTool({
    id: "wo", label: "▭ White-out", title: "Cover part of the page with white (or any colour)", opts: woOpts,
    hint: "Drag a box over what you want to hide · click a box to pick it, drag to move, drag the corner to resize, <kbd>Del</kbd> removes · then use <b>Typewriter</b> to type on top",
    enter: paintWo,
    claim(e, it) {
      if (e.button !== 0) return true;
      e.preventDefault(); K.sel.id = null;
      const TL = K.TL; if (!TL) return true;
      const a = K.evPx(e), box = document.createElement("div");
      const look = X.wo === "match" ? "background:rgba(255,255,255,.35)" : `background:${css(woColor(X.wo))}`;
      box.className = "x2-live"; TL.appendChild(box);
      K.drag = { kind: "wo" };
      let b = a;
      const move = (ev) => {
        b = K.snapPx(K.evPx(ev));
        const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
        box.style.cssText = `left:${x}px;top:${y}px;width:${Math.abs(b[0] - a[0])}px;height:${Math.abs(b[1] - a[1])}px;${look}`;
      };
      const up = () => {
        removeEventListener("pointermove", move); removeEventListener("pointerup", up); K.drag = null; box.remove();
        if (Math.abs(b[0] - a[0]) < 3 || Math.abs(b[1] - a[1]) < 3) return MK.redraw();
        const rect = K.normR([...K.pxUser(K.snapPx(a)), ...K.pxUser(b)]);
        const annot = { id: U.newId(), type: "wo", rect, mode: X.wo, color: woColor(X.wo, rect), strip: X.wo === "black" ? true : !!X.woStrip };
        K.sel.id = annot.id;
        const cur = K.itemNow() || it;
        K.setAnnots(cur.uid, [...(cur.annots || []), annot], X.wo === "black" ? "Blacked out an area" : "Whited out an area");
      };
      addEventListener("pointermove", move); addEventListener("pointerup", up);
      return true;
    },
  });

  // take every letter whose middle is inside one of the rects out of the page content
  function stripText(doc, page, rects) {
    const bytes = U.pageContent(page), segs = U.readText(page, bytes), cuts = [];
    let removed = 0;
    for (const g of segs) {
      if (!g.codes || !g.codes.some((c) => c !== null) || !g.fs) continue;
      const pad = g.size * 1.2;
      const lo = [Math.min(g.p0[0], g.p1[0]) - pad, Math.min(g.p0[1], g.p1[1]) - pad], hi = [Math.max(g.p0[0], g.p1[0]) + pad, Math.max(g.p0[1], g.p1[1]) + pad];
      if (!rects.some((r) => r[0] <= hi[0] && r[2] >= lo[0] && r[1] <= hi[1] && r[3] >= lo[1])) continue;
      let nums = [];
      try {
        const op = F._test.parseOps(bytes.subarray(g.s, g.e)).pop();
        const arg = op && op.args[op.args.length - 1];
        nums = Array.isArray(arg) ? arg.filter((x) => typeof x === "number") : [];
      } catch { continue; }
      const info = g.info, one = !info || info.bytes !== 2, th = g.th || 1, out = [];
      let adv = 0, ni = 0, cut = 0;
      for (const c of g.codes) {
        if (c === null) { const n = nums[ni++] || 0; out.push(n); adv += (-n / 1000) * g.fs * th; continue; }
        const w = info ? info.width(c) / 1000 : 0.5;
        const dx = (w * g.fs + g.tc + (one && c === 32 ? g.tw : 0)) * th;
        const mid = ptM(g.M, adv + dx / 2, 0.35 * g.fs);
        adv += dx;
        if (rects.some((r) => inR(mid, r))) { out.push((-(dx / th) * 1000) / g.fs); cut++; }
        else out.push({ c });
      }
      if (!cut) continue;
      removed += cut;
      let tj = "[", run = "";
      const flush = () => { if (run) { tj += "<" + run + ">"; run = ""; } };
      for (const x of out) {
        if (typeof x === "number") { flush(); tj += " " + f4(x) + " "; }
        else run += x.c.toString(16).padStart(one ? 2 : 4, "0");
      }
      flush(); tj += "] TJ";
      cuts.push({ s: g.s, e: g.e, t: g.op === "'" ? "T* " + tj : g.op === '"' ? `${f4(g.aw)} Tw ${f4(g.ac)} Tc T* ${tj}` : tj });
    }
    if (!cuts.length) return 0;
    cuts.sort((a, b) => a.s - b.s);
    const enc = new TextEncoder(), parts = [];
    let at = 0;
    for (const c of cuts) { if (c.s < at) continue; parts.push(bytes.subarray(at, c.s), enc.encode(c.t)); at = c.e; }
    parts.push(bytes.subarray(at));
    const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0;
    for (const p of parts) { o.set(p, i); i += p.length; }
    U.setContent(doc, page, o);
    return removed;
  }

  /* ================= Shapes ================= */
  const shOpts = K.pane(`
    <div class="seg" role="radiogroup" aria-label="Shape">${Object.entries(SHAPES).map(([k, v]) => `<label><input type="radio" name="x2sh" value="${k}" data-rbsync>${v}</label>`).join("")}</div>
    ${K.swatches("x2sc", STROKE, X.shStroke)}
    <label class="mk-size">Width <input type="range" id="x2-shw" min="0.5" max="12" step="0.5"><b id="x2-shwv"></b></label>
    <label class="mk-size" id="x2-shfl">Fill <select id="x2-shf">${Object.entries(FILL).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join("")}</select></label>`);
  const shW = shOpts.querySelector("#x2-shw"), shWv = shOpts.querySelector("#x2-shwv"), shF = shOpts.querySelector("#x2-shf");
  const fillOf = (key, stroke) => { const f = (FILL[key] || FILL.none)[1]; return f === "same" ? stroke : f; };
  function paintSh() {
    shOpts.querySelectorAll('input[name="x2sh"]').forEach((r) => (r.checked = r.value === X.shape));
    shOpts.querySelectorAll('input[name="x2sc"]').forEach((r) => (r.checked = r.value === X.shStroke));
    shW.value = X.shW; shWv.textContent = X.shW + " pt"; shF.value = X.shFill;
    shOpts.querySelector("#x2-shfl").hidden = X.shape === "line" || X.shape === "arrow";
  }
  const restyle = (patch) => { const p = picked("shape"); if (p) patchAnnot(p.it, p.a.id, patch, null); };
  shOpts.querySelectorAll('input[name="x2sh"]').forEach((r) => (r.onchange = () => { X.shape = r.value; saveX(); paintSh(); syncRibbon(); }));
  shOpts.querySelectorAll('input[name="x2sc"]').forEach((r) => (r.onchange = () => {
    X.shStroke = r.value; saveX();
    const p = picked("shape"); if (p) patchAnnot(p.it, p.a.id, { color: STROKE[r.value], fill: p.a.fillKey === "same" ? STROKE[r.value] : p.a.fill }, null);
  }));
  shW.oninput = () => { X.shW = +shW.value; shWv.textContent = X.shW + " pt"; saveX(); };
  shW.onchange = () => restyle({ w: X.shW });
  shF.onchange = () => { X.shFill = shF.value; saveX(); const p = picked("shape"); if (p) patchAnnot(p.it, p.a.id, { fillKey: X.shFill, fill: fillOf(X.shFill, p.a.color) }, null); };
  paintSh();

  // the two ends of a line, from its box and which way it was drawn
  const lineEnds = (a) => { const r = a.rect; return [[a.fx ? r[2] : r[0], a.fy ? r[3] : r[1]], [a.fx ? r[0] : r[2], a.fy ? r[1] : r[3]]]; };
  const arrowLen = (w) => Math.max(7, w * 3.5);
  F.addTool({
    id: "shape", label: "◻ Shapes", title: "Draw a rectangle, ellipse, line or arrow", opts: shOpts,
    hint: "Drag to draw · hold <kbd>Shift</kbd> for a square, circle or straight 45° line · click a shape to pick it, drag to move, corner to resize, <kbd>Del</kbd> removes",
    enter: paintSh,
    claim(e, it) {
      if (e.button !== 0) return true;
      e.preventDefault(); K.sel.id = null;
      const TL = K.TL; if (!TL) return true;
      const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "x2-svg"); svg.setAttribute("width", MK.V.w); svg.setAttribute("height", MK.V.h);
      TL.appendChild(svg);
      const kind = X.shape, col = STROKE[X.shStroke], fill = kind === "rect" || kind === "ellipse" ? fillOf(X.shFill, col) : null, w = X.shW, s = MK.V.scale;
      const a = K.snapPx(K.evPx(e)); let b = a;
      K.drag = { kind: "shape" };
      const constrain = (p, shift) => {
        if (!shift) return p;
        const dx = p[0] - a[0], dy = p[1] - a[1];
        if (kind === "line" || kind === "arrow") {
          const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
          return [a[0] + Math.cos(ang) * len, a[1] + Math.sin(ang) * len];
        }
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        return [a[0] + Math.sign(dx || 1) * m, a[1] + Math.sign(dy || 1) * m];
      };
      const draw = () => {
        const st = `stroke="${css(col)}" stroke-width="${w * s}" stroke-linejoin="round" stroke-linecap="round" fill="${fill ? css(fill) : "none"}"`;
        const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), W = Math.abs(b[0] - a[0]), H = Math.abs(b[1] - a[1]);
        if (kind === "rect") svg.innerHTML = `<rect x="${x}" y="${y}" width="${W}" height="${H}" ${st}/>`;
        else if (kind === "ellipse") svg.innerHTML = `<ellipse cx="${x + W / 2}" cy="${y + H / 2}" rx="${W / 2}" ry="${H / 2}" ${st}/>`;
        else {
          let head = "";
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (kind === "arrow" && len > 1) {
            const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], L = arrowLen(w) * s, hw = L * 0.45;
            const bx = b[0] - u[0] * L, by = b[1] - u[1] * L;
            head = `<path d="M${bx + u[1] * hw} ${by - u[0] * hw}L${b[0]} ${b[1]}L${bx - u[1] * hw} ${by + u[0] * hw}Z" fill="${css(col)}" stroke="none"/>`;
          }
          svg.innerHTML = `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" ${st}/>${head}`;
        }
      };
      const move = (ev) => { b = constrain(K.snapPx(K.evPx(ev)), ev.shiftKey); draw(); };
      const up = () => {
        removeEventListener("pointermove", move); removeEventListener("pointerup", up); K.drag = null; svg.remove();
        const line = kind === "line" || kind === "arrow";
        if (line ? Math.hypot(b[0] - a[0], b[1] - a[1]) < 4 : Math.abs(b[0] - a[0]) < 3 || Math.abs(b[1] - a[1]) < 3) return MK.redraw();
        const pa = K.pxUser(a), pb = K.pxUser(b);
        const annot = { id: U.newId(), type: "shape", kind, rect: K.normR([...pa, ...pb]), fx: pb[0] < pa[0], fy: pb[1] < pa[1], color: col, w,
          fillKey: line ? "none" : X.shFill, fill };
        K.sel.id = annot.id;
        const cur = K.itemNow() || it;
        K.setAnnots(cur.uid, [...(cur.annots || []), annot], null);
      };
      addEventListener("pointermove", move); addEventListener("pointerup", up);
      return true;
    },
  });
  function ellipsePath(x, y, w, h) {
    const k = 0.5523, rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry, ox = rx * k, oy = ry * k;
    return `${f4(cx - rx)} ${f4(cy)} m ${f4(cx - rx)} ${f4(cy + oy)} ${f4(cx - ox)} ${f4(cy + ry)} ${f4(cx)} ${f4(cy + ry)} c ` +
      `${f4(cx + ox)} ${f4(cy + ry)} ${f4(cx + rx)} ${f4(cy + oy)} ${f4(cx + rx)} ${f4(cy)} c ` +
      `${f4(cx + rx)} ${f4(cy - oy)} ${f4(cx + ox)} ${f4(cy - ry)} ${f4(cx)} ${f4(cy - ry)} c ` +
      `${f4(cx - ox)} ${f4(cy - ry)} ${f4(cx - rx)} ${f4(cy - oy)} ${f4(cx - rx)} ${f4(cy)} c h`;
  }
  function writeShape(doc, page, a) {
    const ctx = doc.context, r = a.rect, w = a.w, line = a.kind === "line" || a.kind === "arrow";
    const pad = w / 2 + (a.kind === "arrow" ? arrowLen(w) * 0.5 : 0) + 1;
    const box = [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
    const ops = [`${strokeOp(a.color)} ${f4(w)} w 1 j 1 J`];
    if (a.fill) ops.push(fillOp(a.fill));
    const extra = {};
    if (a.kind === "rect") ops.push(`${f4(r[0])} ${f4(r[1])} ${f4(r[2] - r[0])} ${f4(r[3] - r[1])} re ${a.fill ? "B" : "S"}`);
    else if (a.kind === "ellipse") ops.push(`${ellipsePath(r[0], r[1], r[2] - r[0], r[3] - r[1])} ${a.fill ? "B" : "S"}`);
    else {
      let [p, q] = lineEnds(a);
      extra.L = [p[0], p[1], q[0], q[1]].map((v) => +f4(v));
      extra.LE = ["None", a.kind === "arrow" ? "ClosedArrow" : "None"];
      if (a.kind === "arrow") {
        extra.IC = a.color;
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, u = [(q[0] - p[0]) / len, (q[1] - p[1]) / len], L = arrowLen(w), hw = L * 0.45;
        const bx = q[0] - u[0] * L, by = q[1] - u[1] * L;
        ops.push(`${f4(p[0])} ${f4(p[1])} m ${f4(q[0] - u[0] * L * 0.7)} ${f4(q[1] - u[1] * L * 0.7)} l S`);
        ops.push(`${fillOp(a.color)} ${f4(bx - u[1] * hw)} ${f4(by + u[0] * hw)} m ${f4(q[0])} ${f4(q[1])} l ${f4(bx + u[1] * hw)} ${f4(by - u[0] * hw)} l h f`);
      } else ops.push(`${f4(p[0])} ${f4(p[1])} m ${f4(q[0])} ${f4(q[1])} l S`);
    }
    if (!line && a.fill) extra.IC = a.fill;
    const ap = K.xobj(doc, ops.join("\n"), box, {});
    const sub = a.kind === "rect" ? "Square" : a.kind === "ellipse" ? "Circle" : "Line";
    page.node.addAnnot(ctx.register(ctx.obj({ ...K.baseDict(a, sub, box), C: a.color, BS: { W: w }, ...extra,
      Contents: PDFHexString.fromText(SHAPES[a.kind] || "Shape"), AP: { N: ap } })));
  }

  /* ================= Sticky notes ================= */
  const noteOpts = K.pane(`${K.swatches("x2nc", NOTE, X.noteColor)}
    <button class="btn ghost tl-sm" type="button" id="x2-nedit" disabled>Edit note text…</button>
    <span class="tl-note">Notes show as comment icons; click one in Acrobat or Preview to read it.</span>`);
  const nEdit = noteOpts.querySelector("#x2-nedit");
  noteOpts.querySelectorAll('input[name="x2nc"]').forEach((r) => (r.onchange = () => {
    X.noteColor = r.value; saveX();
    const p = picked("note"); if (p) patchAnnot(p.it, p.a.id, { color: NOTE[r.value] }, null);
  }));
  async function noteDialog(text, title) {
    const body = document.createElement("div");
    body.innerHTML = `<label class="f"><span>Note</span><textarea id="x2-ntext" rows="6" placeholder="Type your comment…"></textarea></label>
      <label class="f"><span>Author</span><input type="text" id="x2-nauth" placeholder="Your name (optional)"></label>`;
    const ta = body.querySelector("#x2-ntext"), au = body.querySelector("#x2-nauth");
    ta.value = text || ""; au.value = K.author();
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) body.closest(".tl-modal")?.querySelector(".btn.go")?.click(); });
    const ok = await K.modal(title || "Add a note", body, [{ label: "Cancel", cancel: true, value: false }, { label: "Save note", primary: true, value: true }]);
    if (!ok) return null;
    if (au.value.trim() !== K.author()) { K.P.author = au.value.trim(); K.saveP(); const da = document.getElementById("an-author"); if (da) da.value = K.P.author; }
    return ta.value.trim();
  }
  async function editNote() {
    const p = picked("note"); if (!p) return toast("Click a note first to pick it.", "err");
    const t = await noteDialog(p.a.text, "Edit note"); if (t == null) return;
    const cur = K.itemNow(); if (!cur) return;
    if (!t) return K.setAnnots(cur.uid, cur.annots.filter((x) => x.id !== p.a.id), "Removed an empty note");
    patchAnnot(cur, p.a.id, { text: t, author: K.author() }, "Note updated");
  }
  nEdit.onclick = editNote;
  const NOTE_SZ = 22;
  F.addTool({
    id: "note", label: "🗨 Note", title: "Add a sticky note (a comment)", opts: noteOpts,
    hint: "Click where the note goes and type · click a note to pick it, drag to move, double-click to edit, <kbd>Del</kbd> removes",
    // runs on every redraw: notes open on double-click, and the Edit button follows the selection
    layer(it, L, vp, tool) {
      nEdit.disabled = !picked("note");
      if (tool !== "note") return;
      const TL = K.TL; if (!TL) return;
      TL.querySelectorAll(".tl-obj.tl-note").forEach((n) => { n.ondblclick = (e) => { e.stopPropagation(); K.sel.id = n.dataset.id; editNote(); }; });
    },
    claim(e, it) {
      if (e.button !== 0) return true;
      e.preventDefault(); K.sel.id = null;
      const c = K.evUser(e), uid = it.uid, R = K.pageRot();
      (async () => {
        const text = await noteDialog("");
        if (!text) return;
        const cur = MK.itemByUid(uid); if (!cur) return;
        const annot = { id: U.newId(), type: "note", rect: [c[0] - NOTE_SZ / 2, c[1] - NOTE_SZ / 2, c[0] + NOTE_SZ / 2, c[1] + NOTE_SZ / 2], R, color: NOTE[X.noteColor], text, author: K.author() };
        K.sel.id = annot.id;
        K.setAnnots(cur.uid, [...(cur.annots || []), annot], "Note added");
      })();
      return true;
    },
  });
  function writeNote(doc, page, a) {
    const ctx = doc.context, r = a.rect, S = r[2] - r[0], c = a.color, dk = c.map((v) => v * 0.55);
    const ops = [`${fillOp(c)} ${strokeOp(dk)} 1 w 1 j`, `${K.roundRect(1, 4, S - 2, S - 5, 3)} B`,
      `${f4(S * 0.3)} 4.5 m ${f4(S * 0.3)} 0.5 l ${f4(S * 0.55)} 4.5 l f`,
      `${strokeOp(dk)} 1.2 w ${f4(S * 0.22)} ${f4(S * 0.68)} m ${f4(S * 0.78)} ${f4(S * 0.68)} l S ${f4(S * 0.22)} ${f4(S * 0.48)} m ${f4(S * 0.66)} ${f4(S * 0.48)} l S`];
    const ap = K.xobj(doc, ops.join("\n"), [0, 0, S, S], {}, K.rotM(a.R || 0));
    const popup = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Popup", Rect: [r[2], r[3] - 120, r[2] + 220, r[3]].map((v) => +f4(v)), Open: false, F: 28 }));
    const dict = { ...K.baseDict(a, "Text", r), Name: "Comment", Contents: PDFHexString.fromText(a.text || ""), C: c, Open: false, Popup: popup, AP: { N: ap } };
    if (a.author) dict.T = PDFHexString.fromText(a.author);
    const note = ctx.register(ctx.obj(dict));
    ctx.lookup(popup).set(N("Parent"), note);
    page.node.addAnnot(note); page.node.addAnnot(popup);
  }

  /* ================= Insert image ================= */
  let curImg = null;                                       // { url, w, h, name }
  const imgOpts = K.pane(`
    <button class="btn ghost tl-sm" type="button" id="x2-ipick">Choose picture…</button>
    <span class="tl-note" id="x2-iname">No picture chosen yet</span>`);
  const iName = imgOpts.querySelector("#x2-iname");
  const pickFile = () => new Promise((res) => {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml";
    inp.onchange = () => res(inp.files[0] || null);
    inp.addEventListener("cancel", () => res(null));
    inp.click();
  });
  // any picture the browser can show → a PNG (keeps transparency) or JPEG data URL, at most 2400 px
  async function loadPicture(file) {
    const url = await K.readFile(file), img = await K.loadImg(url);
    const w0 = img.naturalWidth || img.width || 300, h0 = img.naturalHeight || img.height || 300;
    const k = Math.min(1, 2400 / Math.max(w0, h0));
    const jpg = /jpe?g/i.test(file.type);
    if (jpg && k === 1) return { url, w: w0, h: h0, name: file.name };
    const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
    const g = c.getContext("2d");
    if (jpg) { g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); }
    g.drawImage(img, 0, 0, c.width, c.height);
    return { url: jpg ? c.toDataURL("image/jpeg", 0.92) : c.toDataURL("image/png"), w: c.width, h: c.height, name: file.name };
  }
  async function choosePicture() {
    const f = await pickFile(); if (!f) return false;
    try { curImg = await loadPicture(f); } catch (e) { console.warn(e); toast("That picture couldn’t be opened. Try a JPG or PNG.", "err"); return false; }
    iName.textContent = curImg.name;
    return true;
  }
  imgOpts.querySelector("#x2-ipick").onclick = async () => { if (await choosePicture()) toast("Click on the page to place the picture.", "ok"); };
  // a picture box centred on c (user space), sized to fit in 45% of the page
  function placeImage(it, c) {
    if (!curImg) return;
    const vp = MK.V.page.getViewport({ scale: 1 });
    const ptW = curImg.w * 0.75, ptH = curImg.h * 0.75;                  // 96 dpi → points
    const k = Math.min(1, (vp.width * 0.45) / ptW, (vp.height * 0.45) / ptH);
    const pl = K.placeAt(c, ptW * k, ptH * k);
    const annot = { id: U.newId(), type: "img", url: curImg.url, s: 1, ...pl };
    K.sel.id = annot.id;
    K.setAnnots(it.uid, [...(it.annots || []), annot], "Picture added · drag to move, corner to resize");
  }
  F.addTool({
    id: "img", label: "🖼 Image", title: "Put a picture on the page", opts: imgOpts,
    hint: "Click to place the picture · click it to pick it, drag to move, drag the corner to resize, <kbd>Del</kbd> removes · <b>Choose picture…</b> for another one",
    claim(e, it) {
      if (e.button !== 0) return true;
      e.preventDefault(); K.sel.id = null;
      const c = K.evUser(e), uid = it.uid;
      if (curImg) { placeImage(it, c); return true; }
      choosePicture().then((ok) => { const cur = MK.itemByUid(uid); if (ok && cur) placeImage(cur, c); });
      return true;
    },
  });
  async function insertImage() {
    if (!B.items.length) return toast("Add a PDF first.", "err");
    if (!(await choosePicture())) return;
    if (!MK.V.open) { const it = B.selected()[0] || B.items[0]; F.setTool("img"); await MK.show(it.uid); }
    else F.setTool("img");
    const it = K.itemNow(); if (!it || !MK.V.page) return;
    const vp = MK.V.page.getViewport({ scale: 1 });
    placeImage(it, vp.convertToPdfPoint(vp.width / 2, vp.height / 2));
  }
  async function writeImage(doc, page, a) {
    const im = await K.imageRef(doc, a.url), R = a.R || 0, r = a.rect;
    const W = R % 180 ? r[3] - r[1] : r[2] - r[0], H = R % 180 ? r[2] - r[0] : r[3] - r[1];
    const ap = { ref: K.xobj(doc, `q ${f4(W)} 0 0 ${f4(H)} 0 0 cm /Im0 Do Q`, [0, 0, W, H], { XObject: { Im0: im } }, K.rotM(R)), W, H };
    K.paint(doc, page, ap, r, R);
  }

  /* ================= writing into the PDF ================= */
  // white-outs: right after each page is built, before numbers, typed text and comments go on top
  const META = { title: "", author: "", subject: "", keywords: "" };
  const build1 = buildPdf;
  buildPdf = async function (items, opt = {}) {
    const out = await build1(items, opt);
    const pages = out.getPages();
    for (let k = 0; k < items.length; k++) {
      const wos = (items[k].annots || []).filter((a) => a.type === "wo");
      if (!wos.length || !pages[k]) continue;
      try {
        const strip = wos.filter((a) => a.strip).map((a) => a.rect);
        if (strip.length) stripText(out, pages[k], strip);
        U.appendContent(out, pages[k], "q\n" + wos.map((a) => `${fillOp(a.color)} ${f4(a.rect[0])} ${f4(a.rect[1])} ${f4(a.rect[2] - a.rect[0])} ${f4(a.rect[3] - a.rect[1])} re f`).join("\n") + "\nQ");
      } catch (e) { console.warn("white-out skipped", e); }
    }
    if (META.title) out.setTitle(META.title);
    if (META.author) out.setAuthor(META.author);
    if (META.subject) out.setSubject(META.subject);
    if (META.keywords) out.setKeywords(META.keywords.split(/[,;]/).map((s) => s.trim()).filter(Boolean));
    return out;
  };
  async function write(doc, page, a) {
    if (a.type === "shape") writeShape(doc, page, a);
    else if (a.type === "note") writeNote(doc, page, a);
    else if (a.type === "img") await writeImage(doc, page, a);
  }

  /* ================= Export pages as images ================= */
  async function exportImages() {
    if (!B.items.length) return toast("Add a PDF first.", "err");
    const sel = B.selected(), cur = MK.V.open ? MK.itemByUid(MK.V.uid) : null;
    const body = document.createElement("div");
    body.className = "x2-exp";
    body.innerHTML = `
      <label class="f"><span>Pages</span><select id="x2-escope">
        <option value="all">All ${B.items.length} pages</option>
        ${sel.length ? `<option value="sel">Picked pages (${sel.length})</option>` : ""}
        ${cur ? `<option value="cur">This page (${B.items.indexOf(cur) + 1})</option>` : ""}
      </select></label>
      <div class="two">
        <label class="f"><span>Format</span><select id="x2-efmt"><option value="png">PNG (sharp, larger)</option><option value="jpg">JPG (smaller)</option></select></label>
        <label class="f"><span>Resolution</span><select id="x2-edpi"><option value="72">72 dpi (screen)</option><option value="150" selected>150 dpi</option><option value="200">200 dpi</option><option value="300">300 dpi (print)</option></select></label>
      </div>
      <p class="hint">Each page becomes one picture, with your edits, comments and stamps. More than one page is saved as a .zip.</p>`;
    body.querySelector("#x2-escope").value = cur ? "cur" : sel.length ? "sel" : "all";
    const ok = await K.modal("Export pages as images", body, [{ label: "Cancel", cancel: true, value: false }, { label: "Export", primary: true, value: true }]);
    if (!ok) return;
    const scope = body.querySelector("#x2-escope").value, fmt = body.querySelector("#x2-efmt").value, dpi = +body.querySelector("#x2-edpi").value;
    const items = scope === "cur" ? [cur] : scope === "sel" ? sel : B.items.slice();
    const stem = baseName(pdfName($("#outname") ? $("#outname").value : "Document"));
    await run("Exporting pages as pictures…", async () => {
      const bytes = await makeFile(items, items.map((i) => B.items.indexOf(i)), B.items.length, { compress: false, progress: busy.step });
      const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
      const files = [], type = fmt === "jpg" ? "image/jpeg" : "image/png";
      try {
        for (let n = 1; n <= pdf.numPages; n++) {
          busy.step(`Page ${n} of ${pdf.numPages}`);
          const page = await pdf.getPage(n), v1 = page.getViewport({ scale: 1 });
          let sc = dpi / 72;
          sc = Math.min(sc, 12000 / Math.max(v1.width, v1.height), Math.sqrt(60e6 / (v1.width * v1.height)));
          const vp = page.getViewport({ scale: sc }), c = document.createElement("canvas");
          c.width = Math.max(1, Math.floor(vp.width)); c.height = Math.max(1, Math.floor(vp.height));
          const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: g, viewport: vp, intent: "print" }).promise;
          const blob = await new Promise((r) => c.toBlob(r, type, 0.92));
          const no = B.items.indexOf(items[n - 1]) + 1;
          files.push({ name: `${stem} - page ${String(no).padStart(String(B.items.length).length, "0")}.${fmt}`, blob });
          c.width = c.height = 0;
        }
      } finally { pdf.destroy(); }
      if (files.length === 1) download(files[0].blob, files[0].name, type);
      else {
        busy.step("Zipping…");
        const zip = new JSZip(); for (const f of files) zip.file(f.name, f.blob);
        download(await zip.generateAsync({ type: "blob" }), `${stem} (images).zip`, "application/zip");
      }
      toast(`Saved ${plural(files.length, fmt.toUpperCase() + " picture")} at ${dpi} dpi`, "ok");
    });
  }

  /* ================= Document properties ================= */
  async function properties() {
    const body = document.createElement("div");
    body.innerHTML = `
      <label class="f"><span>Title</span><input type="text" id="x2-mt" placeholder="(uses the file name)"></label>
      <label class="f"><span>Author</span><input type="text" id="x2-ma" placeholder="PdfCraft"></label>
      <label class="f"><span>Subject</span><input type="text" id="x2-ms"></label>
      <label class="f"><span>Keywords</span><input type="text" id="x2-mk" placeholder="comma, separated"></label>
      <p class="hint">Saved into the PDF when you download (shown in File › Properties in Acrobat or Preview). Kept until you close this window.</p>`;
    const f = { title: "#x2-mt", author: "#x2-ma", subject: "#x2-ms", keywords: "#x2-mk" };
    for (const [k, s] of Object.entries(f)) body.querySelector(s).value = META[k];
    const ok = await K.modal("Document properties", body, [{ label: "Cancel", cancel: true, value: false }, { label: "Save", primary: true, value: true }]);
    if (!ok) return;
    for (const [k, s] of Object.entries(f)) META[k] = body.querySelector(s).value.trim();
    toast(Object.values(META).some(Boolean) ? "Properties saved: they’re written into the PDF when you download." : "Properties cleared.", "ok");
  }

  /* ---------- shared ---------- */
  const NAMES = { rect: "Rectangle", ellipse: "Ellipse", line: "Line", arrow: "Arrow" };
  function title(a) {
    if (a.type === "wo") return (a.mode === "black" ? "Black-out" : "White-out") + (a.strip ? " · text under it is removed" : "");
    if (a.type === "shape") return NAMES[a.kind] || "Shape";
    if (a.type === "note") return `Note${a.author ? " by " + a.author : ""}: “${(a.text || "").slice(0, 80)}”`;
    if (a.type === "img") return "Picture";
    return "";
  }
  window.SSX2 = {
    write, title, insertImage, exportImages, properties, stripText,
    setWo(kind) {
      if (kind === "black") { if (X.wo !== "black") setWoMode("black"); }
      else if (X.wo === "black") setWoMode(X.woLast && X.woLast !== "black" ? X.woLast : "white");
    },
    setShape(kind) { if (SHAPES[kind]) { X.shape = kind; saveX(); paintSh(); syncRibbon(); } },
    // ribbon: is this button's variant the one in use?
    sub(tool, sub) {
      if (tool === "shape") return X.shape === sub;
      if (tool === "wo") return sub === "black" ? X.wo === "black" : X.wo !== "black";
      return true;
    },
  };
})();

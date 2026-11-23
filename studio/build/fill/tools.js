/* Annotate, stamp, sign, move areas, bookmarks, rotate, grid & rulers (V8.17).
   Plugs into the page view through SSFill.addTool (fill.js). Everything a user
   adds is stored per page (item.annots, item.areas: replaced through B.commit,
   so undo/redo covers it) in the page's own PDF coordinates, and written into
   the PDF as real annotations (highlight, underline, strike-out, ink, stamp)
   or page content (signatures, moved/deleted areas). Bookmarks become the PDF
   outline. Digital signatures (PKCS#7, SHA-256) are added by ss-sign after the
   file is finished; SSTools.digitalSign does the work. */
(function () {
  "use strict";
  const F = window.SSFill, MK = window.MK;
  if (!F || !MK) return;
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFHexString, PDFString, StandardFonts } = PDFLib;
  const U = F.util, f4 = U.f4, N = (k) => PDFName.of(k);
  const el = MK.el, $m = MK.$m;
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const enc = new TextEncoder();

  /* ---------- settings kept on this computer ---------- */
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { toast("Couldn’t save on this computer (browser storage is full or off).", "err"); return false; } },
  };
  const P = Object.assign({ author: "", hlKind: "highlight", hlColor: "yellow", inkColor: "blue", inkW: 2, inkOp: 100, stamp: "approved", stampScale: 100,
    sig: "", sigId: "", reason: "", location: "", grid: "", snap: false, rulers: false, units: "in" }, store.get("pdfcraft.tools", {}));
  const saveP = () => store.set("pdfcraft.tools", P);
  const author = () => P.author || "";

  const HL = { yellow: [1, 0.91, 0.2], green: [0.5, 0.88, 0.35], pink: [1, 0.55, 0.75], blue: [0.45, 0.75, 1], orange: [1, 0.68, 0.25] };
  const INK = { black: [0.07, 0.07, 0.07], blue: [0.1, 0.25, 0.69], red: [0.82, 0.08, 0.17], green: [0.08, 0.52, 0.24], yellow: [1, 0.85, 0.1] };
  const STC = { red: [0.78, 0.09, 0.12], green: [0.08, 0.5, 0.2], blue: [0.1, 0.25, 0.65], black: [0.1, 0.1, 0.1], purple: [0.42, 0.18, 0.62] };
  const css = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
  const rgbOp = (c, stroke) => `${c.map(f4).join(" ")} ${stroke ? "RG" : "rg"}`;

  // standard stamps; {date} {time} {name} are filled in when the stamp is placed
  const STAMPS = [
    ["approved", "APPROVED", "", "green"], ["approved-by", "APPROVED", "By {name} at {time}, {date}", "green"],
    ["not-approved", "NOT APPROVED", "", "red"], ["received", "RECEIVED", "{date}", "blue"],
    ["reviewed", "REVIEWED", "By {name} at {time}, {date}", "blue"], ["paid", "PAID", "{date}", "green"],
    ["draft", "DRAFT", "", "blue"], ["final", "FINAL", "", "green"], ["completed", "COMPLETED", "", "green"],
    ["confidential", "CONFIDENTIAL", "", "red"], ["void", "VOID", "", "red"], ["expired", "EXPIRED", "", "red"],
    ["copy", "COPY", "", "blue"], ["for-review", "FOR REVIEW", "", "blue"], ["information-only", "INFORMATION ONLY", "", "blue"],
    ["not-for-release", "NOT FOR PUBLIC RELEASE", "", "red"], ["sign-here", "SIGN HERE", "", "red", "arrow"], ["initial-here", "INITIAL HERE", "", "red", "arrow"],
  ].map(([id, text, sub, color, style]) => ({ id, text, sub, color, style: style || "box", std: true }));
  const customStamps = () => store.get("pdfcraft.stamps", []);
  const allStamps = () => [...STAMPS, ...customStamps()];
  const mySigs = () => store.get("pdfcraft.sigs", []);
  const myIds = () => store.get("pdfcraft.ids", []);

  const pad2 = (n) => String(n).padStart(2, "0");
  function fillTokens(s) {
    const d = new Date();
    return String(s || "")
      .replace(/\{date\}/g, d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }))
      .replace(/\{time\}/g, d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }))
      .replace(/\{name\}/g, author() || "me");
  }
  const pdfDate = (d = new Date()) => {
    const o = -d.getTimezoneOffset(), sg = o >= 0 ? "+" : "-", a = Math.abs(o);
    return `D:${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}${sg}${pad2(Math.floor(a / 60))}'${pad2(a % 60)}'`;
  };
  const niceDate = (d = new Date()) => {
    const o = -d.getTimezoneOffset(), sg = o >= 0 ? "+" : "-", a = Math.abs(o);
    return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${sg}${pad2(Math.floor(a / 60))}'${pad2(a % 60)}'`;
  };

  /* ---------- geometry: the page's own coordinates <-> the view ---------- */
  const vpNow = () => MK.V.page.getViewport({ scale: MK.V.scale });
  const vp1 = () => MK.V.page.getViewport({ scale: 1 });
  function evPx(e) { const r = $m("mk-paper").getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  const pxUser = (p) => vpNow().convertToPdfPoint(p[0], p[1]);
  const userPx = (p) => vpNow().convertToViewportPoint(p[0], p[1]);
  const rectPx = (r) => U.rectPx(vpNow(), r);
  const normR = (r) => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  const pageRot = () => { const v = MK.V.page; return v ? ((v.rotate % 360) + 360) % 360 : 0; };
  const GRID = { "": 0, q: 18, e: 9, h: 36, cm: 72 / 2.54, hcm: 36 / 2.54 };
  function snapPx(p) {
    const step = GRID[P.grid] || 0;
    if (!P.snap || !step) return p;
    const s = step * MK.V.scale;
    return [Math.round(p[0] / s) * s, Math.round(p[1] / s) * s];
  }
  const evUser = (e, snap = true) => pxUser(snap ? snapPx(evPx(e)) : evPx(e));

  /* ---------- page data (undo-safe) ---------- */
  const itemNow = () => MK.itemByUid(MK.V.uid);
  const commitItem = (uid, patch, label) => B.commit(B.items.map((i) => (i.uid === uid ? { ...i, ...patch } : i)), label);
  const setAnnots = (uid, annots, label) => commitItem(uid, { annots }, label);
  const sel = { id: null };
  function removeAnnot(id) {
    const it = itemNow(); if (!it || !it.annots) return;
    const a = it.annots.find((x) => x.id === id); if (!a) return;
    sel.id = null;
    setAnnots(it.uid, it.annots.filter((x) => x.id !== id), `Removed ${({ hl: "a highlight", ink: "a drawing", stamp: "a stamp", sig: "a signature" })[a.type] || "it"}`);
  }

  /* ---------- text under a drag (for highlights) ---------- */
  function glyphs(line) {
    const out = [];
    for (const s of line.segs) {
      let k = 0;
      for (const c of s.codes) {
        if (c === null) continue;
        const x0 = s.gx && s.gx[k], x1 = s.gx && s.gx[k + 1]; k++;
        if (x0 == null || x1 == null) continue;
        out.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), ch: (s.info && s.info.toUni.get(c)) || "" });
      }
    }
    return out;
  }
  function textUnder(it, a, b) {
    if (it.blank || !it.src || !it.src.lib) return null;
    const lines = U.pageModel(it.src, it.idx).lines;
    const top = Math.max(a[1], b[1]), bot = Math.min(a[1], b[1]), minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]);
    const cand = lines.filter((l) => l.flat && l.y + 0.8 * l.size >= bot && l.y - 0.2 * l.size <= top && l.x1 >= minX && l.x0 <= maxX);
    if (!cand.length) return null;
    cand.sort((p, q) => q.y - p.y || p.x0 - q.x0);
    const rows = [];
    for (const l of cand) { const r = rows.find((r) => Math.abs(r.y - l.y) < 0.3 * l.size); if (r) r.lines.push(l); else rows.push({ y: l.y, lines: [l] }); }
    const start = a[1] >= b[1] ? a : b, end = start === a ? b : a;
    const quads = [], text = [];
    rows.forEach((row, i) => {
      const from = rows.length === 1 ? minX : i === 0 ? start[0] : -Infinity;
      const to = rows.length === 1 ? maxX : i === rows.length - 1 ? end[0] : Infinity;
      for (const l of row.lines) {
        const g = glyphs(l).filter((x) => (x.x0 + x.x1) / 2 >= from && (x.x0 + x.x1) / 2 <= to);
        while (g.length && !g[g.length - 1].ch.trim()) g.pop();
        while (g.length && !g[0].ch.trim()) g.shift();
        if (!g.length) continue;
        quads.push([g[0].x0, l.y - 0.22 * l.size, g[g.length - 1].x1, l.y + 0.8 * l.size]);
        text.push(g.map((x) => x.ch).join(""));
      }
    });
    return quads.length ? { quads, text: text.join(" ") } : null;
  }

  /* ---------- the overlay inside the page view ---------- */
  let TL = null, drag = null;
  function tlLayer(L) {
    if (!TL || !TL.isConnected) { TL = document.createElement("div"); TL.className = "tl-layer"; L.appendChild(TL); }
    return TL;
  }
  const OWN = { hl: "hl", ink: "ink", stamp: "stamp", sig: "sig" };     // which tool may pick which kind
  function bbox(a) {
    if (a.rect) return a.rect;
    const pts = a.type === "hl" ? a.quads.flatMap((q) => [[q[0], q[1]], [q[2], q[3]]]) : a.paths.flatMap((p) => { const o = []; for (let i = 0; i < p.length; i += 2) o.push([p[i], p[i + 1]]); return o; });
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), m = a.type === "ink" ? a.w / 2 + 1 : 0;
    return [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m];
  }
  function drawOverlay(it, L, vp, tool) {
    const T = tlLayer(L);
    if (drag) return;                                             // don't rebuild under the pointer
    T.replaceChildren();
    T.dataset.tool = tool;
    for (const a of it.annots || []) {
      const r = rectPx(bbox(a));
      const n = document.createElement("div");
      n.className = `tl-obj tl-${a.type}` + (sel.id === a.id ? " on" : "") + (OWN[a.type] === tool ? " fl-item live" : "");
      n.style.cssText = `left:${r.x}px;top:${r.y}px;width:${Math.max(r.w, 6)}px;height:${Math.max(r.h, 6)}px`;
      n.dataset.id = a.id;
      n.title = a.type === "hl" ? `${a.kind}: “${(a.text || "").slice(0, 60)}”` : a.type === "stamp" ? `Stamp: ${a.spec.text || "picture"}` : a.type === "sig" ? (a.digital ? "Digital signature (signed when you download)" : "Signature") : "Drawing";
      if (OWN[a.type] === tool && a.type !== "ink") {
        n.addEventListener("pointerdown", (e) => objDown(e, it, a, n));
        if (sel.id === a.id) {
          const x = document.createElement("button"); x.type = "button"; x.className = "tl-x"; x.textContent = "✕"; x.title = "Remove (Del)";
          x.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); });
          x.addEventListener("click", (e) => { e.stopPropagation(); removeAnnot(a.id); });
          n.appendChild(x);
          if (a.type === "stamp" || a.type === "sig") {
            const h = document.createElement("span"); h.className = "tl-resize"; h.title = "Drag to resize";
            h.addEventListener("pointerdown", (e) => resizeDown(e, it, a, n));
            n.appendChild(h);
          }
        }
      }
      T.appendChild(n);
    }
    // moved / deleted areas: outline where they are now
    if (tool === "area") for (const ar of it.areas || []) {
      const r = rectPx(ar.del ? ar.r : [ar.r[0] + ar.dx, ar.r[1] + ar.dy, ar.r[2] + ar.dx, ar.r[3] + ar.dy]);
      const n = document.createElement("div");
      n.className = "tl-area fl-item" + (ar.del ? " del" : "");
      n.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
      n.title = ar.del ? "Deleted area" : "Moved area";
      const x = document.createElement("button"); x.type = "button"; x.className = "tl-x"; x.textContent = "↺"; x.title = ar.del ? "Bring this area back" : "Put this area back where it was";
      x.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); });
      x.addEventListener("click", () => commitItem(it.uid, { areas: (it.areas || []).filter((y) => y.id !== ar.id) }, ar.del ? "Area brought back" : "Area put back"));
      n.appendChild(x);
      T.appendChild(n);
    }
    if (areaSel && areaSel.uid === it.uid) drawAreaSel(T);
    paintGrid(); paintRulers();
  }
  // a picture of part of the rendered page, to drag around before it is committed
  function snapshot(r) {
    const c = $m("mk-paper").querySelector("#mk-canvas"); if (!c) return null;
    const k = c.width / MK.V.w, out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(r.w * k)); out.height = Math.max(1, Math.round(r.h * k));
    out.getContext("2d").drawImage(c, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, out.width, out.height);
    out.style.cssText = "width:100%;height:100%;display:block";
    return out;
  }
  function objDown(e, it, a, n) {
    if (e.button !== 0 || e.target.closest(".tl-x,.tl-resize")) return;
    e.preventDefault(); e.stopPropagation();
    if (sel.id !== a.id) { sel.id = a.id; MK.redraw(); return; }
    if (a.type === "hl") return;
    const start = evPx(e), r0 = { x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight };
    const snap = snapshot(r0); if (snap) { n.classList.add("ghost"); n.prepend(snap); }
    drag = { kind: "move" };
    const move = (ev) => { const p = evPx(ev); n.style.left = r0.x + p[0] - start[0] + "px"; n.style.top = r0.y + p[1] - start[1] + "px"; };
    const up = (ev) => {
      removeEventListener("pointermove", move); removeEventListener("pointerup", up); drag = null;
      const p = evPx(ev);
      if (Math.hypot(p[0] - start[0], p[1] - start[1]) < 2) return MK.redraw();
      const p0 = pxUser([r0.x, r0.y]), p1 = pxUser(snapPx([r0.x + p[0] - start[0], r0.y + p[1] - start[1]]));
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
      const cur = itemNow(); if (!cur) return;
      setAnnots(cur.uid, cur.annots.map((x) => (x.id === a.id ? { ...x, rect: [x.rect[0] + dx, x.rect[1] + dy, x.rect[2] + dx, x.rect[3] + dy] } : x)), null);
    };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  }
  function resizeDown(e, it, a, n) {
    e.preventDefault(); e.stopPropagation();
    const start = evPx(e), w0 = n.offsetWidth, h0 = n.offsetHeight;
    drag = { kind: "resize" };
    const move = (ev) => { const p = evPx(ev), k = Math.max(0.2, (w0 + p[0] - start[0]) / w0); n.style.width = w0 * k + "px"; n.style.height = h0 * k + "px"; };
    const up = (ev) => {
      removeEventListener("pointermove", move); removeEventListener("pointerup", up); drag = null;
      const p = evPx(ev), k = Math.max(0.2, (w0 + p[0] - start[0]) / w0);
      if (Math.abs(k - 1) < 0.01) return MK.redraw();
      const cur = itemNow(); if (!cur) return;
      // keep the top-left corner where it is on screen
      const tl = pxUser([n.offsetLeft, n.offsetTop]), x = cur.annots.find((y) => y.id === a.id); if (!x) return;
      const W = (x.rect[2] - x.rect[0]) * k, H = (x.rect[3] - x.rect[1]) * k;
      const c0 = userPx([x.rect[0], x.rect[3]]), c1 = userPx([x.rect[2], x.rect[1]]);
      const left = Math.min(c0[0], c1[0]), topY = Math.min(c0[1], c1[1]);
      const anchor = pxUser([left, topY]);
      const xs = [anchor[0], anchor[0] + (tl[0] >= anchor[0] ? W : -W)], ys = [anchor[1], anchor[1] + (tl[1] >= anchor[1] ? H : -H)];
      const r = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      setAnnots(cur.uid, cur.annots.map((y) => (y.id === a.id ? { ...y, rect: r, s: (y.s || 1) * k } : y)), null);
    };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  }

  /* ---------- keyboard: Delete removes the picked object ---------- */
  addEventListener("keydown", (e) => {
    if (document.querySelector(".tl-modal")) {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); document.querySelector(".tl-modal [data-cancel]")?.click(); }
      else if (!e.target.closest(".tl-modal")) e.stopImmediatePropagation();
      return;
    }
    if (!MK.V.open || e.target.matches("input,textarea,select,[contenteditable]")) return;
    if ((e.key === "Delete" || e.key === "Backspace") && sel.id) { e.preventDefault(); e.stopImmediatePropagation(); removeAnnot(sel.id); }
    else if (e.key === "Escape" && (sel.id || areaSel)) { e.preventDefault(); e.stopImmediatePropagation(); sel.id = null; areaSel = null; MK.redraw(); }
  }, true);

  /* ================= tools ================= */
  const pane = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d; };
  const swatches = (name, colors, cur) => `<div class="mk-colors tl-sw" role="radiogroup">${Object.entries(colors).map(([k, c]) => `<label title="${k}"><input type="radio" name="${name}" value="${k}"${k === cur ? " checked" : ""}><i style="background:${css(c)}"></i></label>`).join("")}</div>`;

  /* ----- highlight / underline / strike-out ----- */
  const hlOpts = pane(`
    <div class="seg" role="radiogroup" aria-label="Kind">
      <label><input type="radio" name="tlhk" value="highlight">Highlight</label>
      <label><input type="radio" name="tlhk" value="underline">Underline</label>
      <label><input type="radio" name="tlhk" value="strikeout">Strike-out</label>
    </div>${swatches("tlhc", HL, P.hlColor)}`);
  hlOpts.querySelectorAll('input[name="tlhk"]').forEach((r) => { r.checked = r.value === P.hlKind; r.onchange = () => { P.hlKind = r.value; saveP(); }; });
  hlOpts.querySelectorAll('input[name="tlhc"]').forEach((r) => (r.onchange = () => {
    P.hlColor = r.value; saveP();
    const it = itemNow(), a = it && (it.annots || []).find((x) => x.id === sel.id && x.type === "hl");
    if (a) setAnnots(it.uid, it.annots.map((x) => (x === a ? { ...x, color: HL[r.value] } : x)), null);
  }));
  F.addTool({
    id: "hl", label: "▍Highlight", title: "Drag across text to highlight, underline or strike it out", opts: hlOpts,
    hint: "Drag across text — it snaps to the letters · on a scan, drag a box · click a highlight to pick it, <kbd>Del</kbd> removes it",
    layer: drawOverlay,
    claim(e, it) {
      if (e.button !== 0) return true;
      e.preventDefault(); sel.id = null;
      const a = evUser(e, false), T = TL; const prev = document.createElement("div"); prev.className = "tl-prev"; T.appendChild(prev);
      drag = { kind: "hl" };
      let res = null, b = a;
      const show = () => {
        prev.replaceChildren();
        const qs = res ? res.quads : P.hlKind === "highlight" ? [[a[0], a[1], b[0], b[1]]] : [];
        for (const q of qs) { const r = rectPx(normR(q)); const d = document.createElement("i"); d.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${css(HL[P.hlColor])}`; prev.appendChild(d); }
      };
      const move = (ev) => { b = evUser(ev, false); res = textUnder(it, a, b); show(); };
      const up = () => {
        removeEventListener("pointermove", move); removeEventListener("pointerup", up); drag = null; prev.remove();
        const small = Math.abs(a[0] - b[0]) < 3 && Math.abs(a[1] - b[1]) < 3;
        if (small && !res) return MK.redraw();
        const quads = res ? res.quads : P.hlKind === "highlight" ? [normR([a[0], a[1], b[0], b[1]])] : null;
        if (!quads) return toast("No text there to underline or strike out.");
        const annot = { id: U.newId(), type: "hl", kind: P.hlKind, color: HL[P.hlColor], quads, text: res ? res.text : "" };
        setAnnots(it.uid, [...(it.annots || []), annot], null);
      };
      addEventListener("pointermove", move); addEventListener("pointerup", up);
      return true;
    },
  });

  /* ----- pencil ----- */
  const inkOpts = pane(`${swatches("tlic", INK, P.inkColor)}
    <label class="mk-size">Width <input type="range" id="tl-inkw" min="0.5" max="12" step="0.5"><b id="tl-inkwv"></b></label>
    <label class="mk-size">Opacity <select id="tl-inkop"><option value="100">100%</option><option value="70">70%</option><option value="40">40% (marker)</option></select></label>
    <label class="check tl-er"><input type="checkbox" id="tl-eraser">Eraser</label>`);
  inkOpts.querySelectorAll('input[name="tlic"]').forEach((r) => (r.onchange = () => { P.inkColor = r.value; saveP(); }));
  const inkw = inkOpts.querySelector("#tl-inkw"), inkwv = inkOpts.querySelector("#tl-inkwv");
  inkw.value = P.inkW; inkwv.textContent = P.inkW + " pt";
  inkw.oninput = () => { P.inkW = +inkw.value; inkwv.textContent = P.inkW + " pt"; saveP(); };
  inkOpts.querySelector("#tl-inkop").value = String(P.inkOp);
  inkOpts.querySelector("#tl-inkop").onchange = (e) => { P.inkOp = +e.target.value; saveP(); };
  const eraser = inkOpts.querySelector("#tl-eraser");
  const distSeg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy; const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0; return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
  function simplify(pts, eps) {                     // Ramer–Douglas–Peucker on [x,y] pairs
    if (pts.length < 3) return pts;
    let dmax = 0, idx = 0;
    for (let i = 1; i < pts.length - 1; i++) { const d = distSeg(pts[i], pts[0], pts[pts.length - 1]); if (d > dmax) { dmax = d; idx = i; } }
    if (dmax <= eps) return [pts[0], pts[pts.length - 1]];
    return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
  }
  F.addTool({
    id: "ink", label: "✎ Pencil", title: "Draw freehand", opts: inkOpts,
    hint: "Draw with the mouse or a pen · tick <b>Eraser</b> and click a line to remove it",
    layer: drawOverlay,
    claim(e, it) {
      if (e.button !== 0) return true;
      e.preventDefault();
      if (eraser.checked) {
        const p = evUser(e, false), tol = 6 / MK.V.scale;
        const hit = [...(it.annots || [])].reverse().find((a) => a.type === "ink" && a.paths.some((pa) => { for (let i = 0; i + 3 < pa.length; i += 2) if (distSeg(p, [pa[i], pa[i + 1]], [pa[i + 2], pa[i + 3]]) < a.w / 2 + tol) return true; return pa.length === 2 && Math.hypot(p[0] - pa[0], p[1] - pa[1]) < a.w / 2 + tol; }));
        if (hit) setAnnots(it.uid, it.annots.filter((a) => a !== hit), "Erased a line");
        return true;
      }
      const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), path = document.createElementNS(NS, "path");
      svg.setAttribute("class", "tl-ink-live"); svg.setAttribute("width", MK.V.w); svg.setAttribute("height", MK.V.h);
      path.setAttribute("fill", "none"); path.setAttribute("stroke", css(INK[P.inkColor])); path.setAttribute("stroke-width", P.inkW * MK.V.scale);
      path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round"); path.setAttribute("opacity", P.inkOp / 100);
      svg.appendChild(path); TL.appendChild(svg);
      const px = [evPx(e)]; drag = { kind: "ink" };
      const d = () => "M" + px.map((p) => p.map((v) => v.toFixed(1)).join(" ")).join("L");
      path.setAttribute("d", d() + "l0.01 0");
      const move = (ev) => { const p = evPx(ev), l = px[px.length - 1]; if (Math.hypot(p[0] - l[0], p[1] - l[1]) >= 1) { px.push(p); path.setAttribute("d", d()); } };
      const up = () => {
        removeEventListener("pointermove", move); removeEventListener("pointerup", up); drag = null;
        const pts = simplify(px.map(pxUser), 0.25);
        svg.remove();
        const annot = { id: U.newId(), type: "ink", color: INK[P.inkColor], w: P.inkW, op: P.inkOp / 100, paths: [pts.flat()] };
        setAnnots(it.uid, [...(it.annots || []), annot], null);
      };
      addEventListener("pointermove", move); addEventListener("pointerup", up);
      return true;
    },
  });

  /* ----- stamps ----- */
  const stampOpts = pane(`
    <label class="mk-size">Stamp <select id="tl-stamp"></select></label>
    <button class="btn ghost tl-sm" type="button" id="tl-newstamp">New stamp…</button>
    <button class="btn ghost tl-sm" type="button" id="tl-delstamp" hidden>Delete this stamp</button>
    <label class="mk-size">Size <input type="range" id="tl-sscale" min="40" max="250" step="5"><b id="tl-sscalev"></b></label>`);
  const stampSel = stampOpts.querySelector("#tl-stamp"), sscale = stampOpts.querySelector("#tl-sscale");
  function paintStampList() {
    const cs = customStamps();
    stampSel.innerHTML = `<optgroup label="Standard">${STAMPS.map((s) => `<option value="${s.id}">${esc(s.text)}${s.sub ? " · " + esc(s.sub.replace(/[{}]/g, "")) : ""}</option>`).join("")}</optgroup>` +
      (cs.length ? `<optgroup label="My stamps">${cs.map((s) => `<option value="${s.id}">${esc(s.name || s.text || "Picture stamp")}</option>`).join("")}</optgroup>` : "");
    if (!allStamps().some((s) => s.id === P.stamp)) P.stamp = "approved";
    stampSel.value = P.stamp;
    stampOpts.querySelector("#tl-delstamp").hidden = !cs.some((s) => s.id === P.stamp);
  }
  stampSel.onchange = () => { P.stamp = stampSel.value; saveP(); paintStampList(); };
  sscale.value = P.stampScale; stampOpts.querySelector("#tl-sscalev").textContent = P.stampScale + "%";
  sscale.oninput = () => { P.stampScale = +sscale.value; stampOpts.querySelector("#tl-sscalev").textContent = P.stampScale + "%"; saveP(); };
  stampOpts.querySelector("#tl-newstamp").onclick = newStampDialog;
  stampOpts.querySelector("#tl-delstamp").onclick = () => {
    if (!confirm("Delete this stamp from your list? Stamps already on pages stay.")) return;
    store.set("pdfcraft.stamps", customStamps().filter((s) => s.id !== P.stamp)); P.stamp = "approved"; saveP(); paintStampList();
  };
  paintStampList();

  // the size of a stamp, in points, before scaling
  function stampSize(spec) {
    if (spec.img) { const k = Math.min(1, 180 / spec.w, 120 / spec.h); return { W: spec.w * k, H: spec.h * k }; }
    const B = U.STD[StandardFonts.HelveticaBold], R = U.STD[StandardFonts.Helvetica];
    const mw = B ? B.widthOfTextAtSize(spec.text || " ", 18) : (spec.text || " ").length * 11;
    const sw = spec.sub ? (R ? R.widthOfTextAtSize(spec.sub, 7.5) : spec.sub.length * 4.2) : 0;
    const arrow = spec.style === "arrow" ? 16 : 0;
    return { W: Math.max(mw, sw) + 20 + arrow, H: 12 + 13 + (spec.sub ? 11 : 0) };
  }
  function placeAt(c, W, H) {                            // a box of W×H points centred on c, upright on screen
    const R = pageRot(), sw = R % 180 ? H : W, sh = R % 180 ? W : H;
    return { rect: [c[0] - sw / 2, c[1] - sh / 2, c[0] + sw / 2, c[1] + sh / 2], R };
  }
  let ghost = null;
  function ghostAt(e, W, H, html) {
    if (!ghost) { ghost = document.createElement("div"); ghost.className = "tl-ghost"; TL && TL.appendChild(ghost); }
    if (!ghost.isConnected && TL) TL.appendChild(ghost);
    const s = MK.V.scale, p = snapPx(evPx(e));
    ghost.style.cssText = `left:${p[0] - (W * s) / 2}px;top:${p[1] - (H * s) / 2}px;width:${W * s}px;height:${H * s}px;font-size:${s}px`;
    if (ghost._html !== html) { ghost.innerHTML = html; ghost._html = html; }
  }
  const dropGhost = () => { if (ghost) { ghost.remove(); ghost = null; } };
  function stampHtml(spec) {
    if (spec.img) return `<img src="${spec.img}" alt="">`;
    const c = css(STC[spec.color] || STC.red);
    return `<div class="tl-stamp-prev ${spec.style}" style="color:${c};border-color:${c}${spec.style === "arrow" ? ";background:" + c : ""}"><b>${esc(fillTokens(spec.text))}</b>${spec.sub ? `<small>${esc(fillTokens(spec.sub))}</small>` : ""}</div>`;
  }
  $m("mk-paper").addEventListener("pointermove", (e) => {
    if (drag || !MK.V.page) return;
    const tool = F.tool;
    if (tool === "stamp" && !e.target.closest(".tl-obj")) {
      const spec = allStamps().find((s) => s.id === P.stamp); if (!spec) return;
      const { W, H } = stampSize(spec), k = P.stampScale / 100;
      ghostAt(e, W * k, H * k, stampHtml(spec));
    } else if (tool === "sig" && !e.target.closest(".tl-obj")) {
      const g = sigGeom(); ghostAt(e, g.W, g.H, sigHtml(g));
    } else dropGhost();
  });
  $m("mk-paper").addEventListener("pointerleave", dropGhost);
  F.addTool({
    id: "stamp", label: "⬚ Stamp", title: "Put a stamp on the page", opts: stampOpts,
    hint: "Click to stamp · click a stamp to pick it, then drag to move, drag the corner to resize, <kbd>Del</kbd> to remove",
    layer: drawOverlay, leave: dropGhost, enter: paintStampList,
    claim(e, it) {
      if (e.button !== 0) return true;
      e.preventDefault();
      sel.id = null;
      const spec0 = allStamps().find((s) => s.id === P.stamp); if (!spec0) return true;
      const spec = { ...spec0, text: fillTokens(spec0.text), sub: fillTokens(spec0.sub) };
      const k = P.stampScale / 100, { W, H } = stampSize(spec);
      const pl = placeAt(evUser(e), W * k, H * k);
      const annot = { id: U.newId(), type: "stamp", spec, s: k, ...pl };
      dropGhost(); sel.id = annot.id;
      setAnnots(it.uid, [...(it.annots || []), annot], null);
      return true;
    },
  });

  /* ----- signatures ----- */
  const sigOpts = pane(`
    <label class="mk-size">Signature <select id="tl-sig"></select></label>
    <button class="btn ghost tl-sm" type="button" id="tl-newsig">New signature…</button>
    <label class="mk-size" title="A Digital ID adds a cryptographic signature: anyone can check the document wasn’t changed after you signed">Digital ID <select id="tl-sigid"></select></label>
    <button class="btn ghost tl-sm" type="button" id="tl-ids">Digital IDs…</button>
    <label class="mk-size tl-reason">Reason <input type="text" id="tl-reason" placeholder="optional"></label>`);
  const sigSel = sigOpts.querySelector("#tl-sig"), sigIdSel = sigOpts.querySelector("#tl-sigid");
  function paintSigLists() {
    const ss = mySigs(), ids = myIds();
    sigSel.innerHTML = (ss.length ? "" : `<option value="">— none yet —</option>`) + ss.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("") + `<option value="none">No picture (Digital ID text only)</option>`;
    if (P.sig !== "none" && !ss.some((s) => s.id === P.sig)) P.sig = ss[0] ? ss[0].id : "";
    sigSel.value = P.sig;
    sigIdSel.innerHTML = `<option value="">None — just the picture</option>` + ids.map((d) => `<option value="${d.id}">${esc(d.name)}${d.self ? " (self-signed)" : ""}</option>`).join("");
    if (!ids.some((d) => d.id === P.sigId)) P.sigId = "";
    sigIdSel.value = P.sigId;
    sigOpts.querySelector("#tl-reason").value = P.reason;
    sigOpts.querySelector(".tl-reason").hidden = !P.sigId;
  }
  sigSel.onchange = () => { P.sig = sigSel.value; saveP(); };
  sigIdSel.onchange = () => { P.sigId = sigIdSel.value; saveP(); paintSigLists(); };
  sigOpts.querySelector("#tl-reason").oninput = (e) => { P.reason = e.target.value; saveP(); };
  sigOpts.querySelector("#tl-newsig").onclick = newSigDialog;
  sigOpts.querySelector("#tl-ids").onclick = idsDialog;
  function sigGeomFor(s, dig) {
    if (!s) return { W: 170, H: 46 };
    const k = Math.min(150 / s.w, 50 / s.h), W = s.w * k, H = s.h * k;
    return dig ? { W: W + 120, H: Math.max(H, 46) } : { W, H };
  }
  function sigGeom() { const s = mySigs().find((x) => x.id === P.sig) || null, dig = !!P.sigId; return { ...sigGeomFor(s, dig), s, dig }; }
  function sigHtml(g) {
    return `<div class="tl-sig-prev">${g.s ? `<img src="${g.s.img}" alt="">` : ""}${g.dig ? `<small>Digitally signed by<br><b>${esc(idById(P.sigId)?.name || "")}</b><br>Date: when you download</small>` : ""}</div>`;
  }
  const idById = (id) => myIds().find((d) => d.id === id);
  F.addTool({
    id: "sig", label: "✍ Sign", title: "Sign the page — a picture of your signature, with or without a Digital ID", opts: sigOpts,
    hint: "Click where you sign · with a Digital ID the file is signed cryptographically when you download · drag to move, corner to resize, <kbd>Del</kbd> removes",
    layer: drawOverlay, leave: dropGhost, enter: paintSigLists,
    claim(e, it) {
      if (e.button !== 0) return true;
      e.preventDefault();
      sel.id = null;
      const s = mySigs().find((x) => x.id === P.sig) || null;
      let digital = P.sigId;
      if (digital && B.items.some((i) => (i.annots || []).some((a) => a.type === "sig" && a.digital))) {
        toast("This PDF already has a digital signature, so this one is added as a picture only.", "err"); digital = "";
      }
      if (!s && !digital) { newSigDialog(); return true; }
      const g = sigGeomFor(s, !!digital);
      const pl = placeAt(evUser(e), g.W, g.H);
      const id = digital ? idById(digital) : null;
      const annot = { id: U.newId(), type: "sig", img: s ? s.img : null, iw: s ? s.w : 0, ih: s ? s.h : 0, ...pl,
        digital: digital || "", signer: id ? id.name : author(), reason: digital ? P.reason : "", location: P.location };
      dropGhost(); sel.id = annot.id;
      setAnnots(it.uid, [...(it.annots || []), annot], digital ? "Digital signature placed — it’s applied when you download" : null);
      return true;
    },
  });

  /* ----- move / delete an area ----- */
  let areaSel = null;                                     // { uid, r: user rect }
  const areaOpts = pane(`
    <span class="tl-note">Drag a box around a section, then drag the box to move it. Text stays real text.</span>
    <button class="btn ghost tl-sm" type="button" id="tl-adel" disabled>Delete selection</button>
    <button class="btn ghost tl-sm" type="button" id="tl-acancel" disabled>Cancel</button>`);
  const aDel = areaOpts.querySelector("#tl-adel"), aCancel = areaOpts.querySelector("#tl-acancel");
  const paintAreaBtns = () => { aDel.disabled = aCancel.disabled = !areaSel; };
  aCancel.onclick = () => { areaSel = null; paintAreaBtns(); MK.redraw(); };
  aDel.onclick = () => {
    const it = itemNow(); if (!it || !areaSel) return;
    const ar = { id: U.newId(), r: areaSel.r, dx: 0, dy: 0, del: true };
    areaSel = null; paintAreaBtns();
    commitItem(it.uid, { areas: [...(it.areas || []), ar] }, "Deleted an area");
  };
  function drawAreaSel(T) {
    const r = rectPx(areaSel.r), n = document.createElement("div");
    n.className = "tl-asel fl-item"; n.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
    n.title = "Drag to move this section";
    n.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const start = evPx(e), snap = snapshot(r);
      if (snap) { n.classList.add("ghost"); n.appendChild(snap); }
      drag = { kind: "area" };
      const move = (ev) => { const p = evPx(ev); n.style.left = r.x + p[0] - start[0] + "px"; n.style.top = r.y + p[1] - start[1] + "px"; };
      const up = (ev) => {
        removeEventListener("pointermove", move); removeEventListener("pointerup", up); drag = null;
        const p = evPx(ev);
        if (Math.hypot(p[0] - start[0], p[1] - start[1]) < 2) return MK.redraw();
        const p0 = pxUser([r.x, r.y]), p1 = pxUser(snapPx([r.x + p[0] - start[0], r.y + p[1] - start[1]]));
        const it = itemNow(); if (!it || !areaSel) return;
        const ar = { id: U.newId(), r: areaSel.r, dx: p1[0] - p0[0], dy: p1[1] - p0[1], del: false };
        areaSel = null; paintAreaBtns();
        commitItem(it.uid, { areas: [...(it.areas || []), ar], annots: shiftAnnots(it.annots, ar) }, "Moved a section");
      };
      addEventListener("pointermove", move); addEventListener("pointerup", up);
    });
    T.appendChild(n);
  }
  F.addTool({
    id: "area", label: "⤧ Move area", title: "Select a section of the page and move it, or delete it", opts: areaOpts,
    hint: "Drag a box around a section · drag the box to move it · <b>Delete selection</b> removes it cleanly (no white box) · ↺ puts an area back",
    layer: drawOverlay, leave: () => { areaSel = null; paintAreaBtns(); },
    claim(e, it) {
      if (e.button !== 0) return true;
      e.preventDefault();
      const a = evPx(e), T = TL, box = document.createElement("div");
      box.className = "tl-marquee"; T.appendChild(box);
      drag = { kind: "marquee" }; areaSel = null; paintAreaBtns();
      let b = a;
      const move = (ev) => { b = evPx(ev); const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]); box.style.cssText = `left:${x}px;top:${y}px;width:${Math.abs(b[0] - a[0])}px;height:${Math.abs(b[1] - a[1])}px`; };
      const up = () => {
        removeEventListener("pointermove", move); removeEventListener("pointerup", up); drag = null; box.remove();
        if (Math.abs(b[0] - a[0]) < 5 || Math.abs(b[1] - a[1]) < 5) return MK.redraw();
        areaSel = { uid: it.uid, r: normR([...pxUser(snapPx(a)), ...pxUser(snapPx(b))]) };
        paintAreaBtns(); MK.redraw();
      };
      addEventListener("pointermove", move); addEventListener("pointerup", up);
      return true;
    },
  });
  function shiftAnnots(list, ar) {
    if (!list) return list;
    const r = ar.r, dx = ar.dx, dy = ar.dy;
    return list.map((a) => {
      const b = bbox(a), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
      if (!(cx >= r[0] && cx <= r[2] && cy >= r[1] && cy <= r[3])) return a;
      if (a.type === "hl") return { ...a, quads: a.quads.map((q) => [q[0] + dx, q[1] + dy, q[2] + dx, q[3] + dy]) };
      if (a.type === "ink") return { ...a, paths: a.paths.map((p) => p.map((v, i) => v + (i % 2 ? dy : dx))) };
      return { ...a, rect: [a.rect[0] + dx, a.rect[1] + dy, a.rect[2] + dx, a.rect[3] + dy] };
    });
  }
  // lines inside a moved area show their edit boxes where the area went
  F.lineOffset = (it, x, y) => {
    for (const ar of [...(it.areas || [])].reverse()) {
      const r = ar.r;
      if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) return ar.del ? [1e5, 1e5] : [ar.dx, ar.dy];
    }
    return [0, 0];
  };

  /* ================= writing it into the PDF ================= */
  const stdFontRef = (doc, name) => {
    doc._tlFonts = doc._tlFonts || new Map();
    if (!doc._tlFonts.has(name)) doc._tlFonts.set(name, doc.context.register(doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: name, Encoding: "WinAnsiEncoding" })));
    return doc._tlFonts.get(name);
  };
  const winHex = (name, s) => { const f = U.STD[name]; const t = [...String(s)].map((ch) => safe(() => (f.encodeText(ch), ch), "?")).join(""); return f.encodeText(t).toString(); };
  function dataBytes(url) { const b = atob(url.split(",")[1] || ""); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  async function imageRef(doc, url) {
    doc._tlImg = doc._tlImg || new Map();
    if (!doc._tlImg.has(url)) {
      const bytes = dataBytes(url);
      const img = /^data:image\/png/.test(url) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      await img.embed(); doc._tlImg.set(url, img.ref);
    }
    return doc._tlImg.get(url);
  }
  function xobj(doc, ops, bbox, resources, matrix) {
    const d = { Type: "XObject", Subtype: "Form", BBox: bbox, Resources: resources || {} };
    if (matrix) d.Matrix = matrix;
    return doc.context.register(doc.context.flateStream(enc.encode(ops), d));
  }
  const rotM = (R) => { const t = (R * Math.PI) / 180, c = Math.round(Math.cos(t) * 1e6) / 1e6, s = Math.round(Math.sin(t) * 1e6) / 1e6; return [c, s, -s, c, 0, 0]; };
  const baseDict = (a, subtype, rect) => ({ Type: "Annot", Subtype: subtype, Rect: rect.map((v) => +f4(v)), F: 4, NM: PDFHexString.fromText(a.id), M: PDFString.of(pdfDate()), T: PDFHexString.fromText(author() || "PdfCraft") });
  function roundRect(x, y, w, h, r) {
    const k = 0.5523 * r;
    return `${f4(x + r)} ${f4(y)} m ${f4(x + w - r)} ${f4(y)} l ${f4(x + w - r + k)} ${f4(y)} ${f4(x + w)} ${f4(y + r - k)} ${f4(x + w)} ${f4(y + r)} c ` +
      `${f4(x + w)} ${f4(y + h - r)} l ${f4(x + w)} ${f4(y + h - r + k)} ${f4(x + w - r + k)} ${f4(y + h)} ${f4(x + w - r)} ${f4(y + h)} c ` +
      `${f4(x + r)} ${f4(y + h)} l ${f4(x + r - k)} ${f4(y + h)} ${f4(x)} ${f4(y + h - r + k)} ${f4(x)} ${f4(y + h - r)} c ` +
      `${f4(x)} ${f4(y + r)} l ${f4(x)} ${f4(y + r - k)} ${f4(x + r - k)} ${f4(y)} ${f4(x + r)} ${f4(y)} c h`;
  }
  // the look of a stamp, W×H points (unrotated)
  async function stampAP(doc, a) {
    const spec = a.spec, k = a.s || 1, { W: w0, H: h0 } = stampSize(spec), W = w0 * k, H = h0 * k;
    if (spec.img) {
      const im = await imageRef(doc, spec.img);
      return { ref: xobj(doc, `q ${f4(W)} 0 0 ${f4(H)} 0 0 cm /Im0 Do Q`, [0, 0, W, H], { XObject: { Im0: im } }, rotM(a.R)), W, H };
    }
    const col = STC[spec.color] || STC.red, bw = 2.2 * k;
    const res = { Font: { FB: stdFontRef(doc, "Helvetica-Bold"), FR: stdFontRef(doc, "Helvetica") }, ExtGState: { G0: doc.context.obj({ CA: 0.9, ca: 0.9 }) } };
    const ops = ["q /G0 gs", rgbOp(col, true), rgbOp(col, false)];
    const arrow = spec.style === "arrow" ? 16 * k : 0;
    if (spec.style === "arrow") {
      ops.push(`0 0 m ${f4(W - arrow)} 0 l ${f4(W)} ${f4(H / 2)} l ${f4(W - arrow)} ${f4(H)} l 0 ${f4(H)} l h f`, "1 g");
    } else if (spec.style !== "plain") {
      ops.push(`${f4(bw)} w ${roundRect(bw / 2, bw / 2, W - bw, H - bw, 5 * k)} S`);
      if (spec.style === "double") ops.push(`${f4(0.8 * k)} w ${roundRect(bw + 2.2 * k, bw + 2.2 * k, W - 2 * bw - 4.4 * k, H - 2 * bw - 4.4 * k, 3.5 * k)} S`);
    }
    const BF = U.STD[StandardFonts.HelveticaBold], RF = U.STD[StandardFonts.Helvetica];
    const mw = BF.widthOfTextAtSize(spec.text || " ", 18 * k), sw = spec.sub ? RF.widthOfTextAtSize(spec.sub, 7.5 * k) : 0;
    const room = W - arrow;
    ops.push(`BT /FB ${f4(18 * k)} Tf ${f4((room - mw) / 2)} ${f4(H - 6 * k - 13 * k)} Td ${winHex(StandardFonts.HelveticaBold, spec.text || "")} Tj ET`);
    if (spec.sub) ops.push(`BT /FR ${f4(7.5 * k)} Tf ${f4((room - sw) / 2)} ${f4(6 * k + 1.6 * k)} Td ${winHex(StandardFonts.Helvetica, spec.sub)} Tj ET`);
    ops.push("Q");
    return { ref: xobj(doc, ops.join("\n"), [0, 0, W, H], res, rotM(a.R)), W, H };
  }
  // the look of a signature; `signed` = { name, date } once a Digital ID has signed
  async function sigAP(doc, a, signed) {
    const r = a.rect, R = a.R || 0, W = R % 180 ? r[3] - r[1] : r[2] - r[0], H = R % 180 ? r[2] - r[0] : r[3] - r[1];
    const ops = [], res = { Font: { FR: stdFontRef(doc, "Helvetica"), FB: stdFontRef(doc, "Helvetica-Bold") }, XObject: {} };
    let imgW = W;
    if (a.digital) imgW = a.img ? W * 0.55 : 0;
    if (a.img) {
      const im = await imageRef(doc, a.img); res.XObject.Im0 = im;
      const k = Math.min(imgW / a.iw, H / a.ih), w = a.iw * k, h = a.ih * k;
      ops.push(`q ${f4(w)} 0 0 ${f4(h)} ${f4((imgW - w) / 2)} ${f4((H - h) / 2)} cm /Im0 Do Q`);
    }
    if (a.digital) {
      const x = imgW + 4, room = W - x - 2;
      const lines = [["FR", "Digitally signed by"], ["FB", (signed && signed.name) || a.signer || ""], ["FR", "Date: " + (signed ? signed.date : "applied when you download")]];
      if (a.reason) lines.push(["FR", "Reason: " + a.reason]);
      let size = Math.min(H / (lines.length * 1.18), 10);
      for (const [f, t] of lines) { const fnt = U.STD[f === "FB" ? StandardFonts.HelveticaBold : StandardFonts.Helvetica]; const w = fnt.widthOfTextAtSize(t, size); if (w > room) size = Math.max(4, (size * room) / w); }
      ops.push("0.1 0.1 0.1 rg");
      let y = H / 2 + (lines.length * size * 1.18) / 2 - size;
      for (const [f, t] of lines) { ops.push(`BT /${f} ${f4(size)} Tf ${f4(x)} ${f4(y)} Td ${winHex(f === "FB" ? StandardFonts.HelveticaBold : StandardFonts.Helvetica, t)} Tj ET`); y -= size * 1.18; }
    }
    return { ref: xobj(doc, ops.join("\n"), [0, 0, W, H], res, rotM(R)), W, H };
  }
  // draw an appearance into the page itself (so it can't be moved off)
  function paint(doc, page, ap, rect, R) {
    const cx = (rect[0] + rect[2]) / 2, cy = (rect[1] + rect[3]) / 2, m = rotM(R);
    const ox = -ap.W / 2, oy = -ap.H / 2;
    const e = cx + ox * m[0] + oy * m[2], f = cy + ox * m[1] + oy * m[3];
    const name = page.node.newXObject("FlSig", ap.ref).toString();
    U.appendContent(doc, page, `q ${[m[0], m[1], m[2], m[3], e, f].map(f4).join(" ")} cm ${name} Do Q`);
  }
  async function writeAnnots(doc, items, opt) {
    await U.stdReady;
    const pages = doc.getPages(), ctx = doc.context;
    const real = !!opt.title && !opt.noMarks && opt.compress !== false;
    for (let k = 0; k < items.length; k++) {
      const it = items[k], page = pages[k];
      if (!page || !it.annots || !it.annots.length) continue;
      for (const a of it.annots) {
        try {
          if (a.type === "hl") {
            const r = normR(a.quads.reduce((m, q) => [Math.min(m[0], q[0]), Math.min(m[1], q[1]), Math.max(m[2], q[2]), Math.max(m[3], q[3])], [Infinity, Infinity, -Infinity, -Infinity]));
            const sub = { highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut" }[a.kind];
            const qp = a.quads.flatMap((q) => [q[0], q[3], q[2], q[3], q[0], q[1], q[2], q[1]]).map((v) => +f4(v));
            const ops = [rgbOp(a.color, false)];
            if (a.kind === "highlight") ops.unshift("/G0 gs");
            for (const q of a.quads) {
              const h = q[3] - q[1];
              if (a.kind === "highlight") ops.push(`${f4(q[0])} ${f4(q[1])} ${f4(q[2] - q[0])} ${f4(h)} re f`);
              else { const t = Math.max(0.6, h * 0.07), y = a.kind === "underline" ? q[1] + h * 0.12 : q[1] + h * 0.42; ops.push(`${f4(q[0])} ${f4(y)} ${f4(q[2] - q[0])} ${f4(t)} re f`); }
            }
            const ap = xobj(doc, ops.join("\n"), r, a.kind === "highlight" ? { ExtGState: { G0: ctx.obj({ BM: "Multiply", CA: 1, ca: 1 }) } } : {});
            page.node.addAnnot(ctx.register(ctx.obj({ ...baseDict(a, sub, r), QuadPoints: qp, C: a.color, Contents: PDFHexString.fromText(a.text || ""), AP: { N: ap } })));
          } else if (a.type === "ink") {
            const r = bbox(a), ops = [`/G0 gs ${rgbOp(a.color, true)} ${f4(a.w)} w 1 J 1 j`];
            for (const p of a.paths) {
              const pts = []; for (let i = 0; i < p.length; i += 2) pts.push([p[i], p[i + 1]]);
              if (pts.length === 1) { ops.push(`${f4(pts[0][0])} ${f4(pts[0][1])} m ${f4(pts[0][0] + 0.01)} ${f4(pts[0][1])} l S`); continue; }
              let s = `${f4(pts[0][0])} ${f4(pts[0][1])} m`, cur = pts[0];
              for (let i = 1; i < pts.length - 1; i++) {             // smooth: quadratic through midpoints, as cubic
                const q = pts[i], m = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
                const c1 = [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])], c2 = [m[0] + (2 / 3) * (q[0] - m[0]), m[1] + (2 / 3) * (q[1] - m[1])];
                s += ` ${f4(c1[0])} ${f4(c1[1])} ${f4(c2[0])} ${f4(c2[1])} ${f4(m[0])} ${f4(m[1])} c`; cur = m;
              }
              const l = pts[pts.length - 1]; s += ` ${f4(l[0])} ${f4(l[1])} l S`; ops.push(s);
            }
            const ap = xobj(doc, ops.join("\n"), r, { ExtGState: { G0: ctx.obj({ CA: a.op, ca: a.op }) } });
            page.node.addAnnot(ctx.register(ctx.obj({ ...baseDict(a, "Ink", r), InkList: a.paths.map((p) => p.map((v) => +f4(v))), C: a.color, CA: a.op, BS: { W: a.w }, AP: { N: ap } })));
          } else if (a.type === "stamp") {
            const ap = await stampAP(doc, a);
            page.node.addAnnot(ctx.register(ctx.obj({ ...baseDict(a, "Stamp", a.rect), Name: a.spec.std ? (a.spec.text || "").replace(/[^A-Za-z]/g, "") || "Draft" : "Custom",
              Contents: PDFHexString.fromText([a.spec.text, a.spec.sub].filter(Boolean).join(" — ") || "Stamp"), AP: { N: ap.ref } })));
          } else if (a.type === "sig") {
            if (a.digital && real) continue;                    // ss-sign writes this one, with the real signature
            paint(doc, page, await sigAP(doc, a, null), a.rect, a.R || 0);
          }
        } catch (e) { console.warn("annotation skipped", a, e); }
      }
    }
  }
  F.after.push(writeAnnots);

  // moved / deleted areas: the page is drawn once without the areas, and once per moved area, shifted
  const build1 = buildPdf;
  buildPdf = async function (items, opt = {}) {
    const out = await build1(items, opt);
    const pages = out.getPages(), ctx = out.context;
    for (let k = 0; k < items.length; k++) {
      const it = items[k], areas = it.areas || [], page = pages[k];
      if (!areas.length || !page) continue;
      try {
        const bytes = U.pageContent(page), mb = page.getMediaBox();
        const res = page.node.Resources() || ctx.obj({});
        const box = [mb.x, mb.y, mb.x + mb.width, mb.y + mb.height];
        // every piece of text must exist once: each copy of the page keeps only the text that shows in it
        const segs = U.readText(page, bytes).map((g) => ({ g, c: [(g.p0[0] + g.p1[0]) / 2, (g.p0[1] + g.p1[1]) / 2 + 0.3 * g.size] }));
        const inR = (c, r) => c[0] >= r[0] && c[0] <= r[2] && c[1] >= r[1] && c[1] <= r[3];
        const variant = (keep) => {
          const parts = []; let at = 0;
          for (const { g, c } of segs) {
            if (keep(c) || g.s < at) continue;
            const k2 = g.fs * g.th ? -g.adv / (g.fs * g.th) * 1000 : 0, tj = `[${f4(k2)}] TJ`;
            parts.push(bytes.subarray(at, g.s), enc.encode(g.op === "'" ? "T* " + tj : g.op === '"' ? `${f4(g.aw)} Tw ${f4(g.ac)} Tc T* ${tj}` : tj));
            at = g.e;
          }
          parts.push(bytes.subarray(at));
          const o = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of parts) { o.set(x, i); i += x.length; }
          return o;
        };
        const mk = (b) => ctx.register(ctx.flateStream(b, { Type: "XObject", Subtype: "Form", BBox: box, Resources: res }));
        const nres = res.clone(ctx), xd0 = nres.lookup(N("XObject"));
        const xd = xd0 instanceof PDFDict ? xd0.clone(ctx) : ctx.obj({});
        xd.set(N("FlPage"), mk(variant((c) => !areas.some((a) => inR(c, a.r)))));
        const rr = (r) => `${f4(r[0])} ${f4(r[1])} ${f4(r[2] - r[0])} ${f4(r[3] - r[1])} re`;
        const ops = [`q ${rr(box)} ${areas.map((a) => rr(a.r)).join(" ")} W* n /FlPage Do Q`];
        areas.forEach((a, i) => {
          if (a.del) return;
          xd.set(N("FlArea" + i), mk(variant((c) => inR(c, a.r) && !areas.slice(i + 1).some((b) => inR(c, b.r)))));
          ops.push(`q 1 0 0 1 ${f4(a.dx)} ${f4(a.dy)} cm ${rr(a.r)} W n /FlArea${i} Do Q`);
        });
        nres.set(N("XObject"), xd); page.node.set(N("Resources"), nres);
        U.setContent(out, page, enc.encode(ops.join("\n")));
      } catch (e) { console.warn("area move skipped", e); }
    }
    return out;
  };

  /* ================= bookmarks ================= */
  let BM = [];                                            // { id, title, uid, level }
  const bmDock = document.createElement("details");
  bmDock.className = "tool"; bmDock.id = "d-bm"; bmDock.setAttribute("name", "tools");
  bmDock.innerHTML = `
    <summary><span class="ic" style="background:#FFF3D6;color:#B26A00"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4z"/></svg></span><span>Bookmarks<small>The PDF’s table of contents</small></span><em class="on-tag" id="bmtag" hidden>0</em></summary>
    <div class="tbody">
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn go" id="bm-add">Add for picked page</button>
        <button class="btn ghost" id="bm-files">One per file</button>
        <button class="btn ghost" id="bm-clear">Clear</button>
      </div>
      <div class="bm-list" id="bm-list"></div>
      <p class="hint">Click a title to go to its page, double-click to rename. Bookmarks follow their page when you move it. Bookmarks already in your PDFs are brought in.</p>
    </div>`;
  const pageNo = (uid) => B.items.findIndex((i) => i.uid === uid) + 1;
  function paintBM() {
    BM = BM.filter((b) => pageNo(b.uid) > 0);
    const list = bmDock.querySelector("#bm-list");
    list.replaceChildren(...BM.map((b, i) => {
      const row = document.createElement("div"); row.className = "bm-row"; row.style.paddingLeft = 4 + b.level * 16 + "px";
      row.innerHTML = `<span class="bm-t" tabindex="0"></span><em>p.${pageNo(b.uid)}</em><span class="bm-b"><button title="Up" data-a="up">↑</button><button title="Down" data-a="down">↓</button><button title="Out" data-a="out">←</button><button title="In (child of the one above)" data-a="in">→</button><button title="Remove" data-a="del">✕</button></span>`;
      const t = row.querySelector(".bm-t"); t.textContent = b.title;
      t.onclick = () => { B.setSel([b.uid]); const c = B.el.querySelector(`.card[data-uid="${CSS.escape(b.uid)}"]`); c && c.scrollIntoView({ block: "center", behavior: "smooth" }); };
      t.ondblclick = () => {
        const inp = document.createElement("input"); inp.value = b.title; inp.className = "bm-edit"; t.replaceWith(inp); inp.focus(); inp.select();
        const done = (ok) => { if (ok && inp.value.trim()) b.title = inp.value.trim(); paintBM(); };
        inp.onkeydown = (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); e.stopPropagation(); };
        inp.onblur = () => done(true);
      };
      row.querySelector(".bm-b").onclick = (e) => {
        const a = e.target.dataset.a; if (!a) return;
        if (a === "del") BM.splice(i, 1);
        else if (a === "up" && i > 0) [BM[i - 1], BM[i]] = [BM[i], BM[i - 1]];
        else if (a === "down" && i < BM.length - 1) [BM[i + 1], BM[i]] = [BM[i], BM[i + 1]];
        else if (a === "in" && i > 0 && b.level <= BM[i - 1].level) b.level++;
        else if (a === "out" && b.level > 0) b.level--;
        fixLevels(); paintBM();
      };
      return row;
    }));
    if (!BM.length) list.innerHTML = `<p class="hint">No bookmarks yet.</p>`;
    const tag = document.getElementById("bmtag"); if (tag) { tag.hidden = !BM.length; tag.textContent = BM.length; }
  }
  function fixLevels() { let prev = -1; for (const b of BM) { b.level = Math.max(0, Math.min(b.level, prev + 1)); prev = b.level; } }
  bmDock.querySelector("#bm-add").onclick = () => {
    const it = B.selected()[0] || B.items[0]; if (!it) return toast("Add a PDF first.", "err");
    const t = prompt("Bookmark title:", `Page ${pageNo(it.uid)}`); if (!t || !t.trim()) return;
    const at = BM.findIndex((b) => pageNo(b.uid) > pageNo(it.uid));
    const bm = { id: U.newId(), title: t.trim(), uid: it.uid, level: 0 };
    if (at < 0) BM.push(bm); else BM.splice(at, 0, bm);
    paintBM(); bmDock.open = true;
  };
  bmDock.querySelector("#bm-files").onclick = () => {
    const seen = new Set();
    for (const it of B.items) if (!it.blank && !seen.has(it.src)) { seen.add(it.src); if (!BM.some((b) => b.uid === it.uid && b.level === 0)) BM.push({ id: U.newId(), title: baseName(it.src.name), uid: it.uid, level: 0 }); }
    BM.sort((a, b) => pageNo(a.uid) - pageNo(b.uid)); fixLevels(); paintBM();
  };
  bmDock.querySelector("#bm-clear").onclick = () => { if (BM.length && confirm("Remove every bookmark?")) { BM = []; paintBM(); } };
  // bring in a source's own bookmarks
  async function importOutline(src) {
    if (src.kind !== "pdf" || !src.pdfjs) return;
    const ol = await src.pdfjs.getOutline().catch(() => null); if (!ol || !ol.length) return;
    const add = [];
    const walk = async (nodes, level) => {
      for (const n of nodes) {
        let dest = n.dest;
        try {
          if (typeof dest === "string") dest = await src.pdfjs.getDestination(dest);
          if (Array.isArray(dest) && dest[0]) {
            const idx = typeof dest[0] === "number" ? dest[0] : await src.pdfjs.getPageIndex(dest[0]);
            const it = B.items.find((i) => i.src === src && i.idx === idx);
            if (it) add.push({ id: U.newId(), title: (n.title || "").trim() || `Page ${idx + 1}`, uid: it.uid, level });
          }
        } catch { /* broken link: skip */ }
        if (n.items && n.items.length) await walk(n.items, level + 1);
      }
    };
    await walk(ol, 0);
    if (!add.length) return;
    BM.push(...add); fixLevels(); paintBM();
  }
  function writeOutline(doc, items, opt) {
    if (opt.noMarks || !opt.title) return;
    const pos = new Map(items.map((it, k) => [it.uid, k])), pages = doc.getPages();
    const list = BM.filter((b) => pos.has(b.uid));
    if (!list.length) return;
    const ctx = doc.context, rootRef = ctx.nextRef();
    const nodes = list.map((b) => ({ b, ref: ctx.nextRef(), kids: [] })), top = [], stack = [];
    for (const n of nodes) {
      while (stack.length && stack[stack.length - 1].b.level >= n.b.level) stack.pop();
      (stack.length ? stack[stack.length - 1].kids : top).push(n); stack.push(n);
    }
    const count = (n) => n.kids.reduce((s, k) => s + 1 + count(k), 0);
    const emit = (list2, parent) => list2.forEach((n, i) => {
      const d = { Title: PDFHexString.fromText(n.b.title), Parent: parent, Dest: [pages[pos.get(n.b.uid)].ref, "XYZ", null, null, null] };
      if (i > 0) d.Prev = list2[i - 1].ref;
      if (i < list2.length - 1) d.Next = list2[i + 1].ref;
      if (n.kids.length) { d.First = n.kids[0].ref; d.Last = n.kids[n.kids.length - 1].ref; d.Count = count(n); emit(n.kids, n.ref); }
      ctx.assign(n.ref, ctx.obj(d));
    });
    emit(top, rootRef);
    ctx.assign(rootRef, ctx.obj({ Type: "Outlines", First: top[0].ref, Last: top[top.length - 1].ref, Count: top.reduce((s, n) => s + 1 + count(n), 0) }));
    doc.catalog.set(N("Outlines"), rootRef);
    doc.catalog.set(N("PageMode"), N("UseOutlines"));
  }
  F.after.push(writeOutline);

  /* ================= view: rotate, grid, rulers ================= */
  const vbar = document.createElement("div");
  vbar.className = "tl-view"; vbar.setAttribute("role", "group"); vbar.setAttribute("aria-label", "Page view");
  vbar.innerHTML = `
    <button class="btn ghost" id="tl-rl" title="Rotate this page left (saved in the PDF)">⟲</button>
    <button class="btn ghost" id="tl-rr" title="Rotate this page right (saved in the PDF)">⟳</button>
    <select id="tl-grid" title="Grid"><option value="">No grid</option><option value="e">Grid ⅛ in</option><option value="q">Grid ¼ in</option><option value="h">Grid ½ in</option><option value="hcm">Grid 5 mm</option><option value="cm">Grid 1 cm</option></select>
    <label class="check" title="Snap stamps, signatures, text and areas to the grid"><input type="checkbox" id="tl-snap">Snap</label>
    <button class="btn ghost" id="tl-rul" title="Rulers">Rulers</button>
    <select id="tl-units" title="Ruler units"><option value="in">in</option><option value="cm">cm</option></select>`;
  el.querySelector(".mk-zoom").before(vbar);
  const rotateNow = (d) => { const it = itemNow(); if (!it) return; commitItem(it.uid, { rot: norm((it.rot || 0) + d) }, d > 0 ? "Rotated right" : "Rotated left"); };
  vbar.querySelector("#tl-rl").onclick = () => rotateNow(-90);
  vbar.querySelector("#tl-rr").onclick = () => rotateNow(90);
  const gridSel = vbar.querySelector("#tl-grid"), snapCb = vbar.querySelector("#tl-snap"), rulBtn = vbar.querySelector("#tl-rul"), unitSel = vbar.querySelector("#tl-units");
  gridSel.value = P.grid; snapCb.checked = P.snap; unitSel.value = P.units; rulBtn.classList.toggle("on", P.rulers);
  gridSel.onchange = () => { P.grid = gridSel.value; if (!P.grid) { P.snap = false; snapCb.checked = false; } saveP(); paintGrid(); };
  snapCb.onchange = () => { P.snap = snapCb.checked; if (P.snap && !P.grid) { P.grid = "q"; gridSel.value = "q"; } saveP(); paintGrid(); };
  rulBtn.onclick = () => { P.rulers = !P.rulers; rulBtn.classList.toggle("on", P.rulers); saveP(); paintRulers(); };
  unitSel.onchange = () => { P.units = unitSel.value; saveP(); paintRulers(); };
  function paintGrid() {
    const paper = $m("mk-paper"); let g = paper.querySelector(".tl-grid");
    const step = GRID[P.grid] || 0;
    if (!step || !MK.V.page) { if (g) g.remove(); return; }
    if (!g) { g = document.createElement("div"); g.className = "tl-grid"; paper.appendChild(g); }
    const s = step * MK.V.scale, big = (P.grid === "cm" || P.grid === "hcm" ? 72 / 2.54 * (P.grid === "hcm" ? 2 : 1) * 1 : 72) * MK.V.scale;
    g.style.backgroundSize = `${s}px ${s}px, ${s}px ${s}px, ${big}px ${big}px, ${big}px ${big}px`;
  }
  let rulT = null, rulL = null, guide = null;
  function paintRulers() {
    const paper = $m("mk-paper");
    if (!P.rulers || !MK.V.page) { rulT && rulT.remove(); rulL && rulL.remove(); rulT = rulL = null; return; }
    if (!rulT || !rulT.isConnected) { rulT = document.createElement("canvas"); rulT.className = "tl-rul tl-rul-top"; paper.appendChild(rulT); }
    if (!rulL || !rulL.isConnected) { rulL = document.createElement("canvas"); rulL.className = "tl-rul tl-rul-left"; paper.appendChild(rulL); }
    const dpr = Math.min(2, devicePixelRatio || 1), W = MK.V.w, H = MK.V.h, S = 18;
    const unit = P.units === "cm" ? 72 / 2.54 : 72, sub = P.units === "cm" ? 10 : 8, px = unit * MK.V.scale;
    const draw = (c, len, horiz) => {
      c.width = (horiz ? len : S) * dpr; c.height = (horiz ? S : len) * dpr;
      c.style.width = (horiz ? len : S) + "px"; c.style.height = (horiz ? S : len) + "px";
      const g = c.getContext("2d"); g.scale(dpr, dpr);
      const dark = document.documentElement.dataset.theme !== "light";
      g.fillStyle = dark ? "#1b1630" : "#f3f0fb"; g.fillRect(0, 0, horiz ? len : S, horiz ? S : len);
      g.strokeStyle = dark ? "#8f86b5" : "#6b6290"; g.fillStyle = g.strokeStyle; g.font = "9px system-ui,sans-serif"; g.lineWidth = 1;
      const n = Math.ceil(len / (px / sub));
      for (let i = 0; i <= n; i++) {
        const p = Math.round((i * px) / sub) + 0.5, major = i % sub === 0, half = i % (sub / 2) === 0, t = major ? S * 0.6 : half ? S * 0.4 : S * 0.22;
        g.beginPath();
        if (horiz) { g.moveTo(p, S); g.lineTo(p, S - t); } else { g.moveTo(S, p); g.lineTo(S - t, p); }
        g.stroke();
        if (major && i) { if (horiz) g.fillText(String(i / sub), p + 2, 9); else { g.save(); g.translate(9, p + 2); g.rotate(Math.PI / 2); g.fillText(String(i / sub), 0, 0); g.restore(); } }
      }
    };
    draw(rulT, W, true); draw(rulL, H, false);
  }
  $m("mk-paper").addEventListener("pointermove", (e) => {
    if (!P.rulers || !rulT) return;
    if (!guide) { guide = document.createElement("div"); guide.className = "tl-guide"; }
    const p = evPx(e);
    rulT.style.setProperty("--gx", p[0] + "px"); rulL.style.setProperty("--gy", p[1] + "px");
    rulT.parentNode.style.setProperty("--gx", p[0] + "px"); rulT.parentNode.style.setProperty("--gy", p[1] + "px");
  });

  /* ================= dialogs ================= */
  function modal(title, body, buttons) {
    return new Promise((resolve) => {
      const w = document.createElement("div"); w.className = "tl-modal";
      w.innerHTML = `<div class="tl-dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3><div class="tl-body"></div><div class="tl-actions"></div></div>`;
      w.querySelector(".tl-body").append(body);
      const acts = w.querySelector(".tl-actions");
      const close = (v) => { w.remove(); resolve(v); };
      for (const b of buttons) {
        const btn = document.createElement("button"); btn.type = "button"; btn.className = "btn" + (b.primary ? " go" : " ghost"); btn.textContent = b.label;
        if (b.cancel) btn.dataset.cancel = "";
        btn.onclick = async () => { if (b.check) { const ok = await b.check(); if (!ok) return; } close(b.value); };
        acts.appendChild(btn);
      }
      document.body.appendChild(w);
      const f = w.querySelector("input,textarea,select"); f && f.focus();
    });
  }
  const readFile = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const loadImg = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  // trim empty borders, optionally turn near-white into transparent; returns { img, w, h }
  function cleanImage(src, { whiteToClear = false, maxW = 900, tint = null } = {}) {
    const k = Math.min(1, maxW / src.width), c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
    const g = c.getContext("2d"); g.drawImage(src, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height), p = d.data;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (whiteToClear) { const l = Math.min(p[i], p[i + 1], p[i + 2]); if (l > 225) p[i + 3] = 0; else if (l > 180) p[i + 3] = Math.round(p[i + 3] * (225 - l) / 45); }
      if (tint && p[i + 3]) { p[i] = tint[0]; p[i + 1] = tint[1]; p[i + 2] = tint[2]; }
      if (p[i + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    g.putImageData(d, 0, 0);
    const o = document.createElement("canvas"), m = 4;
    o.width = x1 - x0 + 1 + 2 * m; o.height = y1 - y0 + 1 + 2 * m;
    o.getContext("2d").drawImage(c, x0, y0, x1 - x0 + 1, y1 - y0 + 1, m, m, x1 - x0 + 1, y1 - y0 + 1);
    return { img: o.toDataURL("image/png"), w: o.width, h: o.height };
  }

  async function newStampDialog() {
    const body = document.createElement("div");
    body.innerHTML = `
      <div class="seg tl-tabs"><label><input type="radio" name="tlst" value="text" checked>Text stamp</label><label><input type="radio" name="tlst" value="img">Picture stamp</label></div>
      <div data-tab="text">
        <label class="f"><span>Text</span><input type="text" id="ns-text" value="APPROVED" maxlength="40"></label>
        <label class="f"><span>Second line (optional) — {date} {time} {name} are filled in when stamped</span><input type="text" id="ns-sub" placeholder="e.g. By {name}, {date}" maxlength="80"></label>
        <div class="two"><label class="f"><span>Colour</span><select id="ns-color">${Object.keys(STC).map((k) => `<option value="${k}">${k[0].toUpperCase() + k.slice(1)}</option>`).join("")}</select></label>
        <label class="f"><span>Style</span><select id="ns-style"><option value="box">Rounded box</option><option value="double">Double border</option><option value="plain">Text only</option><option value="arrow">Arrow tag</option></select></label></div>
      </div>
      <div data-tab="img" hidden>
        <label class="f"><span>Picture (PNG or JPG: a seal, a logo, a scanned stamp)</span><input type="file" id="ns-file" accept="image/png,image/jpeg"></label>
        <label class="check"><input type="checkbox" id="ns-white" checked>Make the white background see-through</label>
      </div>
      <label class="f"><span>Name in your list</span><input type="text" id="ns-name" placeholder="optional"></label>
      <div class="tl-preview" id="ns-prev"></div>`;
    let img = null;
    const tab = () => body.querySelector('input[name="tlst"]:checked').value;
    const prev = () => {
      body.querySelectorAll("[data-tab]").forEach((d) => (d.hidden = d.dataset.tab !== tab()));
      const pv = body.querySelector("#ns-prev");
      if (tab() === "img") { pv.innerHTML = img ? `<img src="${img.img}" alt="" style="max-height:110px">` : "<small>Choose a picture.</small>"; return; }
      const spec = { text: body.querySelector("#ns-text").value, sub: body.querySelector("#ns-sub").value, color: body.querySelector("#ns-color").value, style: body.querySelector("#ns-style").value };
      pv.innerHTML = `<div class="tl-ghost static" style="font-size:1.4px">${stampHtml(spec)}</div>`;
    };
    body.addEventListener("input", prev); body.addEventListener("change", prev);
    body.querySelector("#ns-file").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      img = cleanImage(await loadImg(await readFile(f)), { whiteToClear: body.querySelector("#ns-white").checked, maxW: 700 });
      prev();
    };
    body.querySelector("#ns-white").onchange = () => body.querySelector("#ns-file").dispatchEvent(new Event("change"));
    prev();
    const ok = await modal("New stamp", body, [{ label: "Cancel", value: false, cancel: true }, { label: "Save stamp", value: true, primary: true,
      check: () => (tab() === "img" ? !!img || (toast("Choose a picture first.", "err"), false) : !!body.querySelector("#ns-text").value.trim() || (toast("Type the stamp text.", "err"), false)) }]);
    if (!ok) return;
    const s = tab() === "img"
      ? { id: "c" + U.newId(), name: body.querySelector("#ns-name").value.trim() || "Picture stamp", img: img.img, w: img.w, h: img.h }
      : { id: "c" + U.newId(), name: body.querySelector("#ns-name").value.trim() || body.querySelector("#ns-text").value.trim(), text: body.querySelector("#ns-text").value.trim().toUpperCase(),
        sub: body.querySelector("#ns-sub").value.trim(), color: body.querySelector("#ns-color").value, style: body.querySelector("#ns-style").value };
    if (store.set("pdfcraft.stamps", [...customStamps(), s])) { P.stamp = s.id; saveP(); paintStampList(); toast("Stamp saved. Click the page to use it.", "ok"); }
  }

  const SCRIPTS = ['"Segoe Script"', '"Brush Script MT"', '"Lucida Handwriting"', '"Snell Roundhand"', '"Apple Chancery"', '"Comic Sans MS"', "cursive"];
  async function newSigDialog() {
    const body = document.createElement("div");
    body.innerHTML = `
      <div class="seg tl-tabs"><label><input type="radio" name="tlsg" value="draw" checked>Draw</label><label><input type="radio" name="tlsg" value="type">Type</label><label><input type="radio" name="tlsg" value="img">Picture</label></div>
      <div data-tab="draw"><canvas class="tl-pad" id="sg-pad" width="560" height="190"></canvas><div class="row" style="gap:8px"><button type="button" class="btn ghost tl-sm" id="sg-clear">Clear</button>
        <span class="mk-colors">${["#111111", "#1A3FB0"].map((c, i) => `<label><input type="radio" name="sgc" value="${c}"${i ? "" : " checked"}><i style="background:${c}"></i></label>`).join("")}</span></div></div>
      <div data-tab="type" hidden><label class="f"><span>Your name</span><input type="text" id="sg-name" value="${esc(author())}"></label>
        <div class="tl-fonts" id="sg-fonts"></div></div>
      <div data-tab="img" hidden><label class="f"><span>Photo or scan of your signature</span><input type="file" id="sg-file" accept="image/*"></label><div class="tl-preview" id="sg-ipv"></div></div>
      <label class="f"><span>Save as</span><input type="text" id="sg-label" placeholder="e.g. Full signature, Initials"></label>`;
    const tab = () => body.querySelector('input[name="tlsg"]:checked').value;
    body.querySelectorAll('input[name="tlsg"]').forEach((r) => (r.onchange = () => body.querySelectorAll("[data-tab]").forEach((d) => (d.hidden = d.dataset.tab !== tab()))));
    // draw pad
    const pad = body.querySelector("#sg-pad"), g = pad.getContext("2d"); let strokes = 0, last = null;
    g.lineCap = g.lineJoin = "round";
    const pos = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height)]; };
    pad.onpointerdown = (e) => { pad.setPointerCapture(e.pointerId); last = pos(e); strokes++; g.strokeStyle = body.querySelector('input[name="sgc"]:checked').value; };
    pad.onpointermove = (e) => {
      if (!last) return; const p = pos(e), v = Math.hypot(p[0] - last[0], p[1] - last[1]);
      g.lineWidth = Math.max(1.6, 4.2 - v * 0.08) * (e.pressure && e.pointerType === "pen" ? 0.6 + e.pressure : 1);
      g.beginPath(); g.moveTo(...last); g.lineTo(...p); g.stroke(); last = p;
    };
    pad.onpointerup = () => (last = null);
    body.querySelector("#sg-clear").onclick = () => { g.clearRect(0, 0, pad.width, pad.height); strokes = 0; };
    // typed
    const fonts = body.querySelector("#sg-fonts");
    const paintFonts = () => {
      const n = body.querySelector("#sg-name").value || "Your Name";
      fonts.innerHTML = SCRIPTS.map((f, i) => `<label><input type="radio" name="sgf" value="${i}"${i === 0 ? " checked" : ""}><span style="font-family:${f}">${esc(n)}</span></label>`).join("");
    };
    body.querySelector("#sg-name").oninput = paintFonts; paintFonts();
    // picture
    let pic = null;
    body.querySelector("#sg-file").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      pic = cleanImage(await loadImg(await readFile(f)), { whiteToClear: true, maxW: 900 });
      body.querySelector("#sg-ipv").innerHTML = pic ? `<img src="${pic.img}" alt="" style="max-height:100px">` : "<small>Couldn’t find a signature in that picture.</small>";
    };
    const make = () => {
      if (tab() === "draw") return strokes ? cleanImage(pad) : null;
      if (tab() === "img") return pic;
      const n = body.querySelector("#sg-name").value.trim(); if (!n) return null;
      const f = SCRIPTS[+body.querySelector('input[name="sgf"]:checked').value];
      const c = document.createElement("canvas"); c.width = 1200; c.height = 300;
      const x = c.getContext("2d"); x.font = `130px ${f}`; x.fillStyle = "#111"; x.textBaseline = "middle";
      const w = x.measureText(n).width; if (w > 1160) { x.font = `${Math.floor(130 * 1160 / w)}px ${f}`; }
      x.fillText(n, 20, 150);
      return cleanImage(c);
    };
    const res = await modal("New signature", body, [{ label: "Cancel", value: null, cancel: true }, { label: "Save signature", value: "ok", primary: true,
      check: () => { const r = make(); if (!r) { toast("Draw, type or choose your signature first.", "err"); return false; } body._r = r; return true; } }]);
    if (!res) return;
    const r = body._r, label = body.querySelector("#sg-label").value.trim() || (mySigs().length ? `Signature ${mySigs().length + 1}` : "My signature");
    if (tab() === "type" && !P.author) { P.author = body.querySelector("#sg-name").value.trim(); saveP(); }
    const s = { id: "s" + U.newId(), name: label, ...r };
    if (store.set("pdfcraft.sigs", [...mySigs(), s])) { P.sig = s.id; saveP(); paintSigLists(); toast("Signature saved. Click where you want to sign.", "ok"); }
  }

  /* ================= Digital IDs ================= */
  const forgeOk = () => !!window.forge && !!forge.pkcs12;
  const binToB64 = (s) => btoa(s);
  async function createId({ name, email, org, password }) {
    const pki = forge.pki;
    let keys;
    if (crypto && crypto.subtle) {
      const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
      const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
      const priv = pki.privateKeyFromAsn1(forge.asn1.fromDer(forge.util.binary.raw.encode(der)));
      keys = { privateKey: priv, publicKey: pki.setRsaPublicKey(priv.n, priv.e) };
    } else keys = pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
    const cert = pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01" + forge.util.bytesToHex(forge.random.getBytesSync(15));
    cert.validity.notBefore = new Date(Date.now() - 60000);
    cert.validity.notAfter = new Date(); cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 5);
    const attrs = [{ name: "commonName", value: name }];
    if (org) attrs.push({ name: "organizationName", value: org });
    if (email) attrs.push({ name: "emailAddress", value: email });
    cert.setSubject(attrs); cert.setIssuer(attrs);
    cert.setExtensions([{ name: "basicConstraints", cA: false }, { name: "keyUsage", digitalSignature: true, nonRepudiation: true, critical: true },
      { name: "extKeyUsage", emailProtection: true }, ...(email ? [{ name: "subjectAltName", altNames: [{ type: 1, value: email }] }] : [])]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: "3des", friendlyName: name });
    return { p12: binToB64(forge.asn1.toDer(p12).getBytes()), cert };
  }
  function openP12(b64, password) {
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(b64)), password);
    const O = forge.pki.oids;
    const keyBags = [...(p12.getBags({ bagType: O.pkcs8ShroudedKeyBag })[O.pkcs8ShroudedKeyBag] || []), ...(p12.getBags({ bagType: O.keyBag })[O.keyBag] || [])];
    const certs = (p12.getBags({ bagType: O.certBag })[O.certBag] || []).map((b) => b.cert).filter(Boolean);
    const key = keyBags.map((b) => b.key).find(Boolean);
    if (!key) throw new Error("There’s no private key in this file.");
    const cert = certs.find((c) => c.publicKey && c.publicKey.n && c.publicKey.n.equals(key.n)) || certs[0];
    if (!cert) throw new Error("There’s no certificate in this file.");
    return { key, cert, chain: certs.filter((c) => c !== cert) };
  }
  const certInfo = (cert) => {
    const g = (n) => (cert.subject.getField(n) || {}).value || "";
    return { name: g("CN") || g("O") || "Unnamed", email: g("E") || ((cert.subject.attributes.find((a) => a.name === "emailAddress") || {}).value || ""),
      issuer: (cert.issuer.getField("CN") || {}).value || "", self: cert.isIssuer(cert), until: cert.validity.notAfter.toISOString().slice(0, 10) };
  };
  function download2(bytes, name, type) { download(new Blob([bytes], { type }), name, type); }
  async function idsDialog() {
    if (!forgeOk()) return toast("Digital signing isn’t available in this copy of the app.", "err");
    const body = document.createElement("div");
    const paint = () => {
      const ids = myIds();
      body.innerHTML = `
        <p class="hint">A Digital ID is a certificate and private key. Signing with it lets anyone check who signed and that nothing changed afterwards. Your IDs stay on this computer, locked with your password.</p>
        <div class="tl-ids">${ids.length ? ids.map((d) => `<div class="tl-id"><b>${esc(d.name)}</b><small>${esc(d.email || "")} ${d.self ? "· self-signed" : "· issued by " + esc(d.issuer)} · valid until ${esc(d.until)}</small>
          <span><button class="btn ghost tl-sm" data-x="pfx" data-id="${d.id}" title="Back up, or use it in Acrobat">Export .pfx</button><button class="btn ghost tl-sm" data-x="cer" data-id="${d.id}" title="Give this to people so they can trust your signature">Export certificate</button><button class="btn ghost tl-sm" data-x="del" data-id="${d.id}">Delete</button></span></div>`).join("") : `<p class="hint">No Digital IDs yet.</p>`}</div>
        <details class="tl-sub"><summary>Create a new self-signed Digital ID</summary>
          <label class="f"><span>Your name</span><input type="text" id="id-name" value="${esc(author())}"></label>
          <div class="two"><label class="f"><span>Email (optional)</span><input type="email" id="id-email"></label><label class="f"><span>Organisation (optional)</span><input type="text" id="id-org"></label></div>
          <div class="two"><label class="f"><span>Password</span><input type="password" id="id-pw" autocomplete="new-password"></label><label class="f"><span>Password again</span><input type="password" id="id-pw2" autocomplete="new-password"></label></div>
          <button type="button" class="btn go" id="id-create">Create Digital ID</button></details>
        <details class="tl-sub"><summary>Import a Digital ID (.pfx or .p12) from your bank, CA or Acrobat</summary>
          <label class="f"><span>File</span><input type="file" id="id-file" accept=".pfx,.p12,application/x-pkcs12"></label>
          <label class="f"><span>Its password</span><input type="password" id="id-ipw" autocomplete="off"></label>
          <button type="button" class="btn go" id="id-import">Import</button></details>`;
      body.querySelectorAll("[data-x]").forEach((b) => (b.onclick = async () => {
        const d = myIds().find((x) => x.id === b.dataset.id); if (!d) return;
        if (b.dataset.x === "del") { if (confirm(`Delete the Digital ID “${d.name}” from this computer? Files you already signed stay signed.`)) { store.set("pdfcraft.ids", myIds().filter((x) => x.id !== d.id)); if (P.sigId === d.id) { P.sigId = ""; saveP(); } paint(); paintSigLists(); } }
        else if (b.dataset.x === "pfx") download2(forge.util.binary.raw.decode(forge.util.decode64(d.p12)), `${d.name}.pfx`, "application/x-pkcs12");
        else download2(new TextEncoder().encode(d.certPem), `${d.name}.cer`, "application/x-x509-ca-cert");
      }));
      body.querySelector("#id-create").onclick = async () => {
        const name = body.querySelector("#id-name").value.trim(), pw = body.querySelector("#id-pw").value;
        if (!name) return toast("Type your name.", "err");
        if (pw.length < 6) return toast("Use a password of at least 6 characters.", "err");
        if (pw !== body.querySelector("#id-pw2").value) return toast("The two passwords don’t match.", "err");
        busy.on("Creating your Digital ID…", "Making a 2048-bit key");
        try {
          const r = await createId({ name, email: body.querySelector("#id-email").value.trim(), org: body.querySelector("#id-org").value.trim(), password: pw });
          const info = certInfo(r.cert);
          const d = { id: "i" + U.newId(), ...info, p12: r.p12, certPem: forge.pki.certificateToPem(r.cert) };
          if (store.set("pdfcraft.ids", [...myIds(), d])) { P.sigId = d.id; if (!P.author) P.author = name; saveP(); toast("Digital ID created.", "ok"); }
        } catch (e) { console.error(e); toast("Couldn’t create the ID: " + (e.message || e), "err"); }
        finally { busy.off(); }
        paint(); paintSigLists();
      };
      body.querySelector("#id-import").onclick = async () => {
        const f = body.querySelector("#id-file").files[0]; if (!f) return toast("Choose the .pfx or .p12 file.", "err");
        const b64 = binToB64(forge.util.binary.raw.encode(new Uint8Array(await f.arrayBuffer())));
        try {
          const r = openP12(b64, body.querySelector("#id-ipw").value);
          const info = certInfo(r.cert);
          if (r.cert.validity.notAfter < new Date()) toast("Note: this certificate has expired.", "err");
          const d = { id: "i" + U.newId(), ...info, p12: b64, certPem: forge.pki.certificateToPem(r.cert) };
          if (store.set("pdfcraft.ids", [...myIds(), d])) { P.sigId = d.id; saveP(); toast(`Imported “${info.name}”.`, "ok"); }
        } catch (e) { toast(/MAC|password|Invalid/i.test(e.message || "") ? "Wrong password for that file." : "Couldn’t read that file: " + (e.message || e), "err"); }
        paint(); paintSigLists();
      };
    };
    paint();
    await modal("Digital IDs", body, [{ label: "Close", value: true, primary: true, cancel: true }]);
  }
  async function askPassword(d) {
    const body = document.createElement("div");
    body.innerHTML = `<p class="hint">Sign as <b>${esc(d.name)}</b>. Type the password of this Digital ID.</p><label class="f"><span>Password</span><input type="password" id="pw" autocomplete="off"></label>`;
    body.querySelector("#pw").addEventListener("keydown", (e) => { if (e.key === "Enter") body.closest(".tl-dialog").querySelector(".btn.go").click(); });
    let opened = null;
    const v = await modal("Sign the PDF", body, [{ label: "Don’t sign", value: null, cancel: true }, { label: "Sign", value: "ok", primary: true,
      check: () => { try { opened = openP12(d.p12, body.querySelector("#pw").value); return true; } catch (e) { toast(/MAC|password|Invalid/i.test(e.message || "") ? "Wrong password." : e.message, "err"); return false; } } }]);
    return v ? opened : null;
  }

  /* ---------- the digital signature itself (called by ss-sign, last) ---------- */
  const SIG_BYTES = 16384;
  async function digitalSign(bytes, items) {
    const k = items.findIndex((it) => (it.annots || []).some((a) => a.type === "sig" && a.digital));
    if (k < 0) return bytes;
    const a = items[k].annots.find((x) => x.type === "sig" && x.digital);
    const d = idById(a.digital);
    if (!d || !forgeOk()) { toast("The Digital ID for the signature isn’t on this computer any more, so the file wasn’t signed.", "err"); return bytes; }
    busy.off();
    const id = await askPassword(d);
    if (!id) { toast("Saved without the digital signature.", "err"); return bytes; }
    busy.on("Signing…", d.name);
    await U.stdReady;
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const ctx = doc.context, page = doc.getPage(k), now = new Date();
    const info = certInfo(id.cert);
    const ap = await sigAP(doc, a, { name: info.name, date: niceDate(now) });
    const sig = ctx.obj({ Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached", ByteRange: [0, 9999999999, 9999999999, 9999999999],
      Contents: PDFHexString.of("0".repeat(SIG_BYTES * 2)), M: PDFString.of(pdfDate(now)), Name: PDFHexString.fromText(info.name),
      ...(a.reason ? { Reason: PDFHexString.fromText(a.reason) } : {}), ...(a.location ? { Location: PDFHexString.fromText(a.location) } : {}),
      ...(info.email ? { ContactInfo: PDFHexString.fromText(info.email) } : {}) });
    const sigRef = ctx.register(sig);
    let n = 1; const names = new Set();
    const af0 = doc.catalog.lookup(N("AcroForm"));
    const af = af0 instanceof PDFDict ? af0 : ctx.obj({ Fields: [] });
    let fields = af.lookup(N("Fields")); if (!(fields instanceof PDFArray)) { fields = ctx.obj([]); af.set(N("Fields"), fields); }
    for (const r of fields.asArray()) { const t = ctx.lookup(r); const nm = t && t.lookup && t.lookup(N("T")); if (nm && nm.decodeText) names.add(nm.decodeText()); }
    while (names.has("Signature" + n)) n++;
    const widget = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", Rect: a.rect.map((v) => +f4(v)), V: sigRef, T: PDFString.of("Signature" + n),
      F: 132, P: page.ref, AP: { N: ap.ref } }));
    page.node.addAnnot(widget);
    fields.push(widget);
    af.set(N("SigFlags"), ctx.obj(3));
    if (!(af0 instanceof PDFDict)) doc.catalog.set(N("AcroForm"), ctx.register(af));
    const out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
    // fill in /ByteRange and /Contents
    const s = U.latin1(out);
    const ph = "<" + "0".repeat(SIG_BYTES * 2) + ">";
    const c0 = s.indexOf(ph), c1 = c0 + ph.length;
    const brTxt = "[ 0 9999999999 9999999999 9999999999 ]", b0 = s.indexOf(brTxt);
    if (c0 < 0 || b0 < 0 || s.indexOf(ph, c1) >= 0) throw new Error("couldn’t prepare the signature");
    const br = `[0 ${c0} ${c1} ${out.length - c1}]`.padEnd(brTxt.length, " ");
    for (let i = 0; i < br.length; i++) out[b0 + i] = br.charCodeAt(i);
    const signed = s.slice(0, b0) + br + s.slice(b0 + br.length, c0) + s.slice(c1);
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(signed);
    p7.addCertificate(id.cert); id.chain.forEach((c) => p7.addCertificate(c));
    p7.addSigner({ key: id.key, certificate: id.cert, digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [{ type: forge.pki.oids.contentType, value: forge.pki.oids.data }, { type: forge.pki.oids.messageDigest }, { type: forge.pki.oids.signingTime, value: now }] });
    p7.sign({ detached: true });
    const hex = forge.util.bytesToHex(forge.asn1.toDer(p7.toAsn1()).getBytes());
    if (hex.length > SIG_BYTES * 2) throw new Error("the signature is too large");
    for (let i = 0; i < hex.length; i++) out[c0 + 1 + i] = hex.charCodeAt(i);
    toast(`Digitally signed by ${info.name}${info.self ? " (self-signed ID: others see it as valid once they trust your certificate)" : ""}.`, "ok");
    return out;
  }

  /* ================= dock panel, badges, counts ================= */
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3-1 5-3 7-6l7-7a2.1 2.1 0 0 0-3-3l-7 7c-3 2-5 4-6 7z"/><path d="M14 21h7"/></svg>';
  const dock = document.createElement("details");
  dock.className = "tool"; dock.id = "d-annot"; dock.setAttribute("name", "tools");
  dock.innerHTML = `
    <summary><span class="ic" style="background:#FFF1C9;color:#9A6B00">${ICON}</span><span>Annotate, stamp &amp; sign<small>Highlight, pencil, stamps, signatures, move areas</small></span><em class="on-tag" id="antag" hidden>0</em></summary>
    <div class="tbody">
      <div class="tl-grid-btns">
        <button class="btn" data-open="hl">▍Highlight</button><button class="btn" data-open="ink">✎ Pencil</button>
        <button class="btn" data-open="stamp">⬚ Stamp</button><button class="btn" data-open="sig">✍ Sign</button>
        <button class="btn" data-open="area">⤧ Move area</button><button class="btn" id="an-ids">Digital IDs…</button>
      </div>
      <label class="f"><span>Your name (on stamps, signatures and comments)</span><input type="text" id="an-author" autocomplete="name"></label>
      <p class="hint" id="an-count"></p>
      <p class="hint">Highlights, drawings and stamps are saved as real PDF comments, so Acrobat and other viewers can show, move or remove them. Signatures are drawn into the page.</p>
    </div>`;
  const fillDock = document.getElementById("d-fill");
  if (fillDock) fillDock.after(dock); else document.querySelector(".dock").appendChild(dock);
  dock.after(bmDock);
  dock.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => {
    const it = B.selected()[0] || B.items[0]; if (!it) return toast("Add a PDF first.", "err");
    F.setTool(b.dataset.open); MK.show(it.uid);
  }));
  dock.querySelector("#an-ids").onclick = idsDialog;
  const au = dock.querySelector("#an-author"); au.value = P.author;
  au.oninput = () => { P.author = au.value.trim(); saveP(); };

  const render0 = B.render;
  B.render = function () {
    render0.call(this);
    for (const c of $$(".card", this.el)) {
      const it = MK.itemByUid(c.dataset.uid); if (!it) continue;
      const n = (it.annots || []).length, m = (it.areas || []).length;
      if (!n && !m) continue;
      const b = document.createElement("span"); b.className = "tlbadge";
      const sg = (it.annots || []).filter((a) => a.type === "sig").length;
      b.textContent = [sg && `✍ ${sg}`, n - sg && `★ ${n - sg}`, m && `⤧ ${m}`].filter(Boolean).join(" · ");
      b.title = "Comments, stamps, signatures or moved areas on this page. Double-click to edit.";
      c.querySelector(".sheetbox").appendChild(b);
    }
  };
  const changed0 = changed;
  changed = function (label) {
    changed0(label);
    const all = B.items.flatMap((i) => i.annots || []), areas = B.items.reduce((s, i) => s + (i.areas || []).length, 0);
    const sigs = all.filter((a) => a.type === "sig"), dig = sigs.some((a) => a.digital);
    const tag = document.getElementById("antag"); if (tag) { tag.hidden = !(all.length || areas); tag.textContent = all.length + areas; }
    const parts = [all.length - sigs.length && plural(all.length - sigs.length, "comment/stamp"), sigs.length && plural(sigs.length, "signature"), areas && plural(areas, "moved area")].filter(Boolean);
    const cnt = document.getElementById("an-count"); if (cnt) cnt.textContent = parts.length ? parts.join(", ") + "." : "";
    if (all.length - sigs.length) $("#stamptags").append(Object.assign(document.createElement("span"), { textContent: `+ ${plural(all.length - sigs.length, "comment")}` }));
    if (sigs.length) $("#stamptags").append(Object.assign(document.createElement("span"), { textContent: dig ? "+ digitally signed" : "+ signature" }));
    for (const s of fileList()) if (!s._bmDone) { s._bmDone = true; importOutline(s).catch(() => {}); }
    paintBM();
  };

  // hand: drag to scroll the page
  F.addTool({
    id: "hand", label: "✋ Hand", title: "Drag to scroll the page", hint: "Drag to scroll · pick another tool to edit",
    claim(e) {
      if (e.button !== 0) return true;
      e.preventDefault();
      const st = $m("mk-stage"), x0 = e.clientX, y0 = e.clientY, sl = st.scrollLeft, stp = st.scrollTop;
      $m("mk-paper").style.cursor = "grabbing";
      const move = (ev) => { st.scrollLeft = sl - (ev.clientX - x0); st.scrollTop = stp - (ev.clientY - y0); };
      const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); $m("mk-paper").style.cursor = ""; };
      addEventListener("pointermove", move); addEventListener("pointerup", up);
      return true;
    },
  });
  window.SSTools = { digitalSign, openP12, createId, myIds, writeAnnots,
    ui: {
      setHl(kind) { P.hlKind = kind; saveP(); hlOpts.querySelectorAll('input[name="tlhk"]').forEach((r) => (r.checked = r.value === kind)); },
      setEraser(on) { eraser.checked = !!on; },
      newStamp: newStampDialog, newSig: newSigDialog, ids: idsDialog, rotate: rotateNow,
      addBookmark: () => { bmDock.open = true; bmDock.querySelector("#bm-add").click(); },
      deleteSelection: () => aDel.click(),
    } };
  B.render(); changed();
})();

/* Ribbon (V8.17): every feature in one top bar, grouped in tabs like a desktop PDF editor.
   It sits under the workspace header, and moves into the page editor while that is open.
   Buttons only call what already exists (tools in the page view, board actions, dock panels). */
(function () {
  "use strict";
  const F = window.SSFill, MK = window.MK, T = window.SSTools;
  if (!F || !MK || !T) return;
  const ws = document.getElementById("ws"), head = ws && ws.querySelector("header.top");
  if (!head) return;

  /* ---------- icons (24×24 line drawings, two colours) ---------- */
  const I = {
    hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12m0-1V4.5a1.5 1.5 0 0 1 3 0V11m0-.5V6.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 7-6.5 7-2.8 0-4.3-1.3-5.8-3.6L3.4 14.6a1.5 1.5 0 0 1 2.5-1.6L8 15"/>',
    edit: '<path d="M4 6V4h12v2M10 4v14M7 18h6" /><path class="a" d="m15.5 19.5 5-5 2 2-5 5H15.5z"/>',
    typewriter: '<path d="M5 5h14M12 5v14M9 19h6"/><path class="a" d="M3 21h18"/>',
    area: '<rect x="3" y="3" width="12" height="9" rx="1" stroke-dasharray="2.5 2"/><path class="a" d="M14 14h7v7h-7zM17.5 9v5M15 11.5l2.5-2.5 2.5 2.5"/>',
    erase: '<rect x="4" y="5" width="16" height="11" rx="1" stroke-dasharray="2.5 2"/><path class="r" d="m9 8 6 5M15 8l-6 5"/>',
    form: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h4M7 14h4"/><rect class="a" x="13" y="7.5" width="5" height="3"/><rect class="a" x="13" y="12.5" width="5" height="3"/>',
    hl: '<path class="y" d="M3 16h18v5H3z" fill="currentColor" stroke="none" opacity=".45"/><path d="M7 15 12 3l5 12M9 11h6"/>',
    ul: '<path d="M7 4v7a5 5 0 0 0 10 0V4"/><path class="a" d="M5 20h14"/>',
    st: '<path d="M16 6c-1-1.5-2.5-2-4-2-2.5 0-4 1.3-4 3 0 4 8 2.5 8 7 0 2-1.8 3.5-4.2 3.5-1.8 0-3.3-.8-4.3-2.2"/><path class="r" d="M3 12h18"/>',
    pencil: '<path d="m4 20 1-4L16 5l3 3L8 19z"/><path class="a" d="m14 7 3 3"/><path class="r" d="M3 21c3-1 5 0 7-1"/>',
    eraser: '<path d="m7 20-4-4L14 5l6 6-9 9z"/><path class="r" d="M7 20h13M9 10l6 6"/>',
    stamp: '<path d="M9 13V9a3 3 0 1 1 6 0v4"/><path class="r" d="M5 13h14v4H5zM4 20h16"/>',
    newstamp: '<path class="r" d="M5 13h14v4H5zM4 20h16"/><path d="M12 3v7M8.5 6.5h7"/>',
    check: '<path class="r" d="m4 12 5 5L20 6"/>',
    sign: '<path d="M3 17c2-4 4-9 6-9 2.5 0 0 8 2 8 1.5 0 2.5-4 4-4 1 0 1 3 2 3s2-1 3-2"/><path class="a" d="M3 21h18"/>',
    newsig: '<path d="M3 15c2-4 4-8 6-8 2.5 0 0 7 2 7 1.5 0 2-3 3.5-3"/><path class="a" d="M18 13v8M14 17h8"/>',
    id: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle class="a" cx="9" cy="11" r="2.5"/><path class="a" d="M5.5 17c.6-2 2-3 3.5-3s2.9 1 3.5 3M14.5 9.5h4M14.5 13h4"/>',
    mask: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/><path class="a" d="M8 12h8"/>',
    zin: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/><path class="a" d="M10.5 7.5v6M7.5 10.5h6"/>',
    zout: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/><path class="a" d="M7.5 10.5h6"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><path class="a" d="M8 12h8"/>',
    rl: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path class="a" d="M4 4v4h4"/>',
    rr: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path class="a" d="M20 4v4h-4"/>',
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    save: '<path d="M5 3h11l3 3v15H5z"/><path class="a" d="M8 3v5h7V3M8 21v-7h8v7"/>',
    zip: '<path d="M4 14h6v6M20 10h-6V4"/><path class="a" d="m14 10 7-7M3 21l7-7"/>',
    add: '<path d="M6 3h8l4 4v14H6z"/><path class="a" d="M12 10v7M8.5 13.5h7"/>',
    del: '<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13"/><path class="r" d="M10 11v6M14 11v6"/>',
    dup: '<rect x="8" y="8" width="12" height="13" rx="1"/><path class="a" d="M16 8V4H4v13h4"/>',
    extract: '<path d="M6 3h8l4 4v14H6z"/><path class="a" d="M12 18v-7M9 14l3 3 3-3"/>',
    blank: '<path d="M6 3h8l4 4v14H6z"/><path class="a" d="M14 3v4h4"/>',
    reverse: '<path d="M7 4v16M4 17l3 3 3-3"/><path class="a" d="M17 20V4M14 7l3-3 3 3"/>',
    split: '<path d="M6 3v18M18 3v18"/><path class="a" d="M10 12h4M12 9v6"/>',
    num: '<path d="M5 4h14v16H5z"/><path class="a" d="M10 16h4M12 13v3"/>',
    wm: '<path d="M4 20 20 4M8 20l12-12M4 16 16 4"/>',
    bm: '<path d="M6 3h12v18l-6-4-6 4z"/>',
    bmadd: '<path d="M6 3h9v18l-4.5-3L6 21z"/><path class="a" d="M19 6v6M16 9h6"/>',
    grid: '<path d="M3 3h18v18H3zM9 3v18M15 3v18M3 9h18M3 15h18"/>',
    ruler: '<path d="M3 15 15 3l6 6L9 21z"/><path class="a" d="m7 11 2 2M10 8l2 2M13 5l2 2"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path class="a" d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path class="a" d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k] || ""}</svg>`;

  /* ---------- actions ---------- */
  const viewOpen = () => MK.V.open;
  function useTool(tool, prep) {
    if (prep) prep();
    if (viewOpen()) return F.setTool(tool);
    const it = B.selected()[0] || B.items[0];
    if (!it) return toast("Add a PDF first.", "err");
    F.setTool(tool); MK.show(it.uid);
  }
  const click = (sel) => () => { const n = document.querySelector(sel); if (n && !n.disabled) n.click(); else if (n && n.disabled) toast("Pick some pages first.", "err"); };
  const openDock = (id) => () => {
    if (viewOpen()) document.getElementById("mk-done").click();
    const d = document.getElementById(id); if (!d) return;
    d.open = true; d.scrollIntoView({ block: "nearest", behavior: "smooth" });
    d.classList.remove("rb-flash"); void d.offsetWidth; d.classList.add("rb-flash");
  };
  const rotate = (deg) => () => {
    if (viewOpen()) return T.ui.rotate(deg);
    if (!B.sel.size) B.setSel(B.items.map((i) => i.uid));
    document.getElementById(deg > 0 ? "rr" : "rl").click();
  };
  const zoom = (id) => () => { if (!viewOpen()) return toast("Open a page first (double-click it).", "err"); document.getElementById(id).click(); };

  // [key, label, icon, action, { big, tool, title, viewOnly }]
  const TABS = {
    Home: [
      ["Tools", [["hand", "Hand", "hand", () => useTool("hand"), { big: 1, tool: "hand", title: "Scroll the page by dragging" }],
        ["edit", "Edit Text", "edit", () => useTool("edit"), { big: 1, tool: "edit", title: "Click any line to retype it in the PDF’s own font" }],
        ["text", "Typewriter", "typewriter", () => useTool("text"), { big: 1, tool: "text", title: "Click anywhere and type; matches nearby text" }]]],
      ["View", [["zout", "Zoom out", "zout", zoom("mk-zout"), { viewOnly: 1 }], ["zin", "Zoom in", "zin", zoom("mk-zin"), { viewOnly: 1 }], ["fit", "Fit width", "fit", zoom("mk-zfit"), { viewOnly: 1 }],
        ["rl", "Rotate left", "rl", rotate(-90)], ["rr", "Rotate right", "rr", rotate(90)], ["undo", "Undo", "undo", () => B.undo()]]],
      ["Comment", [["hl", "Highlight", "hl", () => useTool("hl", () => T.ui.setHl("highlight")), { big: 1, tool: "hl:highlight" }],
        ["ul", "Underline", "ul", () => useTool("hl", () => T.ui.setHl("underline")), { tool: "hl:underline" }],
        ["so", "Strike-out", "st", () => useTool("hl", () => T.ui.setHl("strikeout")), { tool: "hl:strikeout" }],
        ["pencil", "Pencil", "pencil", () => useTool("ink", () => T.ui.setEraser(false)), { tool: "ink" }],
        ["stamp", "Stamp", "stamp", () => useTool("stamp"), { big: 1, tool: "stamp" }]]],
      ["Protect", [["sign", "Sign Document", "sign", () => useTool("sig"), { big: 1, tool: "sig" }]]],
      ["Save", [["save", "Download PDF", "save", click("#save"), { big: 1, title: "Build and download the PDF (Ctrl+S)" }], ["comp", "Compress", "zip", click("[data-cz-open]")]]],
    ],
    Edit: [
      ["Text", [["edit", "Edit Text", "edit", () => useTool("edit"), { big: 1, tool: "edit" }], ["text", "Add Text", "typewriter", () => useTool("text"), { big: 1, tool: "text" }],
        ["form", "Fill Form", "form", () => useTool("edit"), { big: 1, title: "Type straight into the form’s boxes" }]]],
      ["Objects", [["area", "Move Area", "area", () => useTool("area"), { big: 1, tool: "area", title: "Select a section and drag it somewhere else" }],
        ["erase", "Delete Area", "erase", () => useTool("area"), { big: 1, title: "Select a section, then press Delete selection" }]]],
      ["Page marks", [["num", "Page Numbers", "num", openDock("d-num")], ["wm", "Watermark", "wm", openDock("d-wm")], ["check", "Check Marks", "check", () => useTool("mark"), { tool: "mark" }]]],
    ],
    Comment: [
      ["Text markup", [["hl", "Highlight", "hl", () => useTool("hl", () => T.ui.setHl("highlight")), { big: 1, tool: "hl:highlight" }],
        ["ul", "Underline", "ul", () => useTool("hl", () => T.ui.setHl("underline")), { big: 1, tool: "hl:underline" }],
        ["so", "Strike-out", "st", () => useTool("hl", () => T.ui.setHl("strikeout")), { big: 1, tool: "hl:strikeout" }],
        ["text", "Typewriter", "typewriter", () => useTool("text"), { big: 1, tool: "text" }]]],
      ["Drawing", [["pencil", "Pencil", "pencil", () => useTool("ink", () => T.ui.setEraser(false)), { big: 1, tool: "ink" }],
        ["eraser", "Eraser", "eraser", () => useTool("ink", () => T.ui.setEraser(true)), { big: 1, tool: "ink:eraser" }]]],
      ["Stamps", [["stamp", "Stamp", "stamp", () => useTool("stamp"), { big: 1, tool: "stamp" }], ["newstamp", "New Stamp…", "newstamp", () => T.ui.newStamp()],
        ["check", "Check Marks", "check", () => useTool("mark"), { tool: "mark" }]]],
    ],
    Protect: [
      ["Signatures", [["sign", "Sign Document", "sign", () => useTool("sig"), { big: 1, tool: "sig" }], ["newsig", "New Signature…", "newsig", () => T.ui.newSig()],
        ["ids", "Digital IDs…", "id", () => T.ui.ids()]]],
      ["Redact", [["mask", "Hide SSN / EIN", "mask", openDock("d-mask"), { big: 1, title: "Find and remove Social Security, ITIN and EIN numbers" }],
        ["erase", "Remove Area", "erase", () => useTool("area"), { big: 1, title: "Select a section and press Delete selection: it’s taken out of the file" }]]],
    ],
    Organize: [
      ["Pages", [["add", "Add Files", "add", click("[data-pick]"), { big: 1 }], ["blank", "Insert Blank", "blank", click("#blank")],
        ["dup", "Duplicate", "dup", click("#dup")], ["del", "Delete", "del", click("#del")]]],
      ["Arrange", [["rl", "Rotate Left", "rl", rotate(-90), { big: 1 }], ["rr", "Rotate Right", "rr", rotate(90), { big: 1 }],
        ["reverse", "Reverse", "reverse", click("#reverse")], ["extract", "Save Picked", "extract", click("#extract")], ["split", "Split…", "split", openDock("d-split")]]],
      ["Bookmarks", [["bm", "Bookmarks", "bm", openDock("d-bm"), { big: 1 }], ["bmadd", "Add Bookmark", "bmadd", () => T.ui.addBookmark()]]],
    ],
    View: [
      ["Zoom", [["zout", "Zoom out", "zout", zoom("mk-zout"), { big: 1, viewOnly: 1 }], ["zin", "Zoom in", "zin", zoom("mk-zin"), { big: 1, viewOnly: 1 }],
        ["fit", "Fit width", "fit", zoom("mk-zfit"), { big: 1, viewOnly: 1 }], ["full", "Full screen", "full", zoom("mk-fs"), { viewOnly: 1 }]]],
      ["Layout aids", [], "tl-view"],
      ["Rotate", [["rl", "Rotate left", "rl", rotate(-90), { big: 1 }], ["rr", "Rotate right", "rr", rotate(90), { big: 1 }]]],
    ],
  };

  /* ---------- build ---------- */
  const rb = document.createElement("div");
  rb.className = "rb"; rb.setAttribute("role", "toolbar"); rb.setAttribute("aria-label", "PDF tools");
  const tabs = document.createElement("div"); tabs.className = "rb-tabs"; tabs.setAttribute("role", "tablist");
  const body = document.createElement("div"); body.className = "rb-body";
  rb.append(tabs, body);
  const buttons = [];
  let cur = "Home";
  try { cur = localStorage.getItem("pdfcraft.ribbon") || "Home"; } catch { /* default */ }
  if (!TABS[cur]) cur = "Home";
  function mkBtn([key, label, icon, act, o = {}]) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "rb-btn" + (o.big ? " big" : ""); b.dataset.key = key;
    if (o.tool) b.dataset.tool = o.tool;
    if (o.viewOnly) b.dataset.viewOnly = "";
    b.title = o.title || label;
    b.innerHTML = `${svg(icon)}<span>${label}</span>`;
    b.onclick = act;
    buttons.push(b);
    return b;
  }
  function paintTab() {
    tabs.querySelectorAll("button").forEach((t) => t.setAttribute("aria-selected", t.dataset.tab === cur));
    body.replaceChildren();
    for (const [gname, items, special] of TABS[cur]) {
      const g = document.createElement("div"); g.className = "rb-group";
      const row = document.createElement("div"); row.className = "rb-items";
      if (special === "tl-view") { const tv = MK.el.querySelector(".tl-view"); if (tv) row.appendChild(tv); }
      let col = null;
      for (const it of items) {
        const b = mkBtn(it);
        if (it[4] && it[4].big) { row.appendChild(b); col = null; }
        else { if (!col || col.children.length >= 3) { col = document.createElement("div"); col.className = "rb-col"; row.appendChild(col); } col.appendChild(b); }
      }
      const lab = document.createElement("div"); lab.className = "rb-glabel"; lab.textContent = gname;
      g.append(row, lab); body.appendChild(g);
    }
    paintState();
  }
  for (const name of Object.keys(TABS)) {
    const t = document.createElement("button"); t.type = "button"; t.textContent = name; t.dataset.tab = name; t.setAttribute("role", "tab");
    t.onclick = () => { cur = name; try { localStorage.setItem("pdfcraft.ribbon", name); } catch { /* fine */ } buttons.length = 0; paintTab(); };
    tabs.appendChild(t);
  }
  // which tool is on, and what can be used right now
  function paintState() {
    const open = viewOpen(), tool = MK.el.dataset.tool || "";
    const hk = (document.querySelector('input[name="tlhk"]:checked') || {}).value;
    const er = (document.getElementById("tl-eraser") || {}).checked;
    for (const b of buttons) {
      const t = b.dataset.tool;
      let on = false;
      if (open && t) {
        const [tt, sub] = t.split(":");
        on = tt === tool && (!sub || (tt === "hl" ? sub === hk : sub === "eraser" ? er : true)) && !(tt === "ink" && !sub && er);
      }
      b.classList.toggle("on", on);
      b.classList.toggle("dim", b.dataset.viewOnly !== undefined && !open);
    }
    rb.classList.toggle("in-view", open);
  }
  paintTab();
  head.after(rb);

  // follow the page editor: the ribbon moves in while it's open
  const place = () => {
    if (viewOpen()) { if (rb.parentNode !== MK.el) MK.el.prepend(rb); MK.el.classList.add("has-rb"); }
    else if (rb.parentNode !== ws) head.after(rb);
    paintState();
  };
  new MutationObserver(place).observe(MK.el, { attributes: true, attributeFilter: ["hidden", "data-tool"] });
  document.addEventListener("change", (e) => { if (e.target.matches('input[name="tlhk"],#tl-eraser')) paintState(); });
  place();
})();

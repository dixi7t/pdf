/* Digital signature (V8.17): runs last, after compression, because a signed
   file must not change afterwards. Only real downloads are signed (not the
   page view, the stamp preview or the hand-off to Convert). */
(function () {
  "use strict";
  if (!window.SSTools || typeof makeFile !== "function") return;
  const inner = makeFile;
  makeFile = async function (items, globalIdx, total, opt = {}) {
    const bytes = await inner(items, globalIdx, total, opt);
    if (!opt.title || opt.noMarks || opt.compress === false) return bytes;
    try { return await SSTools.digitalSign(bytes, items, opt); }
    catch (e) { console.error(e); toast("The PDF was saved without the digital signature: " + (e.message || e), "err"); return bytes; }
  };
})();

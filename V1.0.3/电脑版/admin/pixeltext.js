/* ============================================================
 * 像素字：文字 → 方块像素画
 *  - 输入文字、字号、字体、前景方块、每像素方块数
 *  - 前端用 Canvas 渲染文字 → 二值矩阵 → 复用 /api/pixelart/prepare
 * ============================================================ */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  const COLORS = {
    white_concrete: ["minecraft:white_concrete", "#cfd5d6"],
    black_concrete: ["minecraft:black_concrete", "#0a0c10"],
    yellow_concrete: ["minecraft:yellow_concrete", "#f1af15"],
    red_concrete: ["minecraft:red_concrete", "#8e2020"],
    light_blue_concrete: ["minecraft:light_blue_concrete", "#2488c6"],
    lime_concrete: ["minecraft:lime_concrete", "#5ea818"],
  };
  const FONTS = {
    yahei: '"Microsoft YaHei","PingFang SC",sans-serif',
    simhei: '"SimHei",sans-serif',
    simsun: '"SimSun","Songti SC",serif',
    mono: 'ui-monospace,Consolas,"Courier New",monospace',
    impact: 'Impact,"Arial Black",sans-serif',
  };

  const st = { rows: null, size: null, prepared: false };

  function toast(msg, bad) {
    const el = $("sl-toast");
    if (!el) { console.log(msg); return; }
    el.textContent = msg;
    el.style.borderColor = bad ? "#c05656" : "var(--accent)";
    el.style.color = bad ? "#f2b8b8" : "var(--fg)";
    el.style.opacity = "1";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.style.opacity = "0"; }, 2800);
  }

  function buildRows() {
    const text = ($("px-t-text").value || "").trim();
    if (!text) { toast("请先输入要生成的文字", true); return; }
    const size = Number($("px-t-size").value) || 16;
    const fontKey = $("px-t-font").value || "yahei";
    const bold = $("px-t-bold").checked;
    const scale = Number($("px-t-scale").value) || 1;
    const colorKey = $("px-t-color").value || "white_concrete";
    const blockName = COLORS[colorKey] ? COLORS[colorKey][0] : "minecraft:white_concrete";

    const font = `${bold ? "bold " : ""}${size}px ${FONTS[fontKey] || FONTS.yahei}`;
    const measure = document.createElement("canvas").getContext("2d");
    measure.font = font;
    const lines = text.split("\n");
    let maxW = 0;
    for (const ln of lines) maxW = Math.max(maxW, measure.measureText(ln).width);
    const pad = Math.max(2, Math.round(size * 0.25));
    const lineH = Math.round(size * 1.28);
    const cw = Math.max(1, Math.ceil(maxW) + pad * 2);
    const ch = Math.max(1, lineH * lines.length + pad * 2);

    const cv = document.createElement("canvas");
    cv.width = cw; cv.height = ch;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cw, ch);
    ctx.font = font; ctx.fillStyle = "#fff"; ctx.textBaseline = "top";
    lines.forEach((ln, i) => ctx.fillText(ln, pad, pad + i * lineH));

    const data = ctx.getImageData(0, 0, cw, ch).data;
    const rows = [];
    for (let y = 0; y < ch; y++) {
      const row = [];
      for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4;
        const on = data[i] > 110; // 白色文字
        if (!on) { for (let s = 0; s < scale; s++) row.push(null); continue; }
        for (let s = 0; s < scale; s++) row.push(blockName);
      }
      for (let s = 0; s < scale; s++) rows.push(row.slice());
    }
    st.rows = rows;
    st.size = { x: rows[0].length, y: rows.length };
    st.prepared = false;
    renderPreview(colorKey);
  }

  function renderPreview(colorKey) {
    const wrap = $("px-t-wrap");
    const canvas = $("px-t-preview");
    if (!canvas || !st.rows) return;
    const h = st.rows.length, w = st.rows[0].length;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    const rgb = (COLORS[colorKey] || COLORS.white_concrete)[1];
    ctx.clearRect(0, 0, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!st.rows[y][x]) continue;
        ctx.fillStyle = rgb;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    wrap.style.display = "block";
    const total = st.rows.reduce((s, r) => s + r.filter(Boolean).length, 0);
    $("px-t-stat").textContent = `${w} × ${h} 方块 · ${total} 个方块`;
  }

  async function post(url, body) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return await r.json().catch(() => ({ ok: false, error: "响应解析失败" }));
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  async function generate() {
    if (!st.rows) return toast("请先生成预览", true);
    const name = ($("px-t-name").value || "").trim() || "text-" + Date.now().toString().slice(-5);
    const r = await post("/api/pixelart/prepare", { name, rows: st.rows });
    if (!r.ok) return toast("生成失败：" + (r.error || "未知错误"), true);
    st.prepared = true;
    const s = r.structure;
    $("px-t-info").textContent = `已生成：${s.name} · ${s.size.x}×${s.size.y} · ${s.total} 方块`;
    toast("像素字已生成，点「导入到游戏」即可");
  }

  async function build() {
    if (!st.prepared) return toast("请先点「生成像素字」", true);
    const offsetY = Number($("px-t-offset").value || 0) || 0;
    const r = await post("/api/structure/build", { offsetY });
    if (!r.ok) return toast("导入失败：" + (r.error || "未知错误"), true);
    const o = r.origin || {};
    toast(`开始导入：${r.name}，原点 ${o.x},${o.y},${o.z}`);
    $("px-t-info").textContent = `导入中：${r.name}`;
    const tick = async () => {
      try {
        const s = await (await fetch("/api/status")).json();
        const b = s && s.structure && s.structure.build;
        if (!b) return;
        const pct = b.total ? Math.floor((b.placed / b.total) * 100) : 0;
        $("px-t-info").textContent = `导入中：${b.name} · ${b.placed}/${b.total}（${pct}%）`;
        if (!b.done && !b.cancelled) setTimeout(tick, 1200);
        else $("px-t-info").textContent = b.verified ? `完成：${b.name} · ${b.total} 方块` : `结束：失败 ${b.failed} 条`;
      } catch {}
    };
    setTimeout(tick, 1200);
  }

  function init() {
    if (!$("px-t-text")) return;
    $("px-t-build-preview").onclick = buildRows;
    $("px-t-generate").onclick = generate;
    $("px-t-build").onclick = build;
    ["px-t-size", "px-t-font", "px-t-scale", "px-t-bold", "px-t-color"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("change", () => { if (st.rows) buildRows(); });
    });
    const ta = $("px-t-text");
    if (ta) ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); buildRows(); }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

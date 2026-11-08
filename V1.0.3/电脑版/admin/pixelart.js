/* ============================================================
 * 像素化导入：图片 → 方块画（像素画）
 *  - 自动按比例计算高度
 *  - 三种方块调色板：混凝土 / 羊毛 / 陶瓦
 *  - 预览：原图 vs 方块还原
 *  - 生成后可直接调用现有「三步导入」流程
 * ============================================================ */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const PALETTES = {
    concrete: {
      label: "混凝土（色准）",
      colors: [
        ["minecraft:white_concrete", 207, 213, 214],
        ["minecraft:orange_concrete", 224, 97, 1],
        ["minecraft:magenta_concrete", 169, 48, 159],
        ["minecraft:light_blue_concrete", 36, 136, 198],
        ["minecraft:yellow_concrete", 241, 175, 21],
        ["minecraft:lime_concrete", 94, 168, 24],
        ["minecraft:pink_concrete", 213, 101, 142],
        ["minecraft:gray_concrete", 54, 57, 61],
        ["minecraft:light_gray_concrete", 126, 126, 115],
        ["minecraft:cyan_concrete", 21, 119, 136],
        ["minecraft:purple_concrete", 100, 32, 156],
        ["minecraft:blue_concrete", 45, 47, 143],
        ["minecraft:brown_concrete", 96, 59, 31],
        ["minecraft:green_concrete", 73, 91, 36],
        ["minecraft:red_concrete", 142, 32, 32],
        ["minecraft:black_concrete", 8, 10, 15],
      ],
    },
    wool: {
      label: "羊毛（柔和）",
      colors: [
        ["minecraft:white_wool", 233, 236, 236],
        ["minecraft:orange_wool", 240, 118, 19],
        ["minecraft:magenta_wool", 189, 68, 179],
        ["minecraft:light_blue_wool", 58, 175, 217],
        ["minecraft:yellow_wool", 248, 198, 39],
        ["minecraft:lime_wool", 112, 185, 25],
        ["minecraft:pink_wool", 237, 141, 172],
        ["minecraft:gray_wool", 62, 68, 71],
        ["minecraft:light_gray_wool", 142, 142, 134],
        ["minecraft:cyan_wool", 21, 137, 145],
        ["minecraft:purple_wool", 121, 42, 172],
        ["minecraft:blue_wool", 53, 57, 157],
        ["minecraft:brown_wool", 114, 71, 40],
        ["minecraft:green_wool", 84, 109, 27],
        ["minecraft:red_wool", 161, 39, 34],
        ["minecraft:black_wool", 20, 21, 25],
      ],
    },
    terracotta: {
      label: "陶瓦（复古）",
      colors: [
        ["minecraft:white_terracotta", 209, 177, 161],
        ["minecraft:orange_terracotta", 161, 83, 37],
        ["minecraft:magenta_terracotta", 150, 104, 107],
        ["minecraft:light_blue_terracotta", 113, 109, 138],
        ["minecraft:yellow_terracotta", 186, 133, 35],
        ["minecraft:lime_terracotta", 105, 117, 50],
        ["minecraft:pink_terracotta", 163, 78, 79],
        ["minecraft:gray_terracotta", 58, 42, 35],
        ["minecraft:light_gray_terracotta", 135, 106, 95],
        ["minecraft:cyan_terracotta", 86, 91, 92],
        ["minecraft:purple_terracotta", 118, 70, 86],
        ["minecraft:blue_terracotta", 74, 58, 87],
        ["minecraft:brown_terracotta", 77, 51, 35],
        ["minecraft:green_terracotta", 76, 83, 41],
        ["minecraft:red_terracotta", 142, 63, 51],
        ["minecraft:black_terracotta", 37, 22, 16],
      ],
    },
  };

  const state = {
    img: null,
    rows: null,
    size: null,
    prepared: false,
  };

  function toast(msg, bad) {
    const el = $("sl-toast");
    if (!el) { console.log(msg); return; }
    el.textContent = msg;
    el.style.borderColor = bad ? "#c05656" : "var(--sl-accent)";
    el.style.color = bad ? "#f2b8b8" : "var(--sl-fg)";
    el.style.opacity = "1";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.style.opacity = "0"; }, 3000);
  }

  function nearest(rgb, palette) {
    let best = null;
    let bestD = Infinity;
    for (const [name, r, g, b] of palette) {
      const dr = (rgb[0] - r) * 0.30;
      const dg = (rgb[1] - g) * 0.59;
      const db = (rgb[2] - b) * 0.11;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = name; }
    }
    return best;
  }

  function renderPreview() {
    const wrap = $("px-preview-wrap");
    const canvas = $("px-preview");
    if (!canvas || !state.rows) return;
    const h = state.rows.length;
    const w = state.size.x;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const lookup = {};
    const pal = PALETTES[$("px-palette").value].colors;
    for (const [name, r, g, b] of pal) lookup[name] = [r, g, b];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const name = state.rows[y][x];
        if (!name) continue;
        const c = lookup[name] || [0, 0, 0];
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    wrap.style.display = "block";
    // 统计
    const total = state.rows.reduce((s, r) => s + r.filter(Boolean).length, 0);
    const colors = new Set(state.rows.flat().filter(Boolean)).size;
    $("px-stat").textContent = `${w} × ${h} 方块 · ${total} 个方块 · ${colors} 种颜色`;
  }

  async function convert() {
    if (!state.img) return toast("请先选择图片", true);
    const targetW = Number($("px-width").value) || 64;
    const img = state.img;
    const ratio = img.naturalHeight / img.naturalWidth;
    const w = targetW;
    const h = Math.max(1, Math.round(targetW * ratio));

    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    const palette = PALETTES[$("px-palette").value].colors;
    const rows = [];
    for (let y = 0; y < h; y++) {
      const row = [];
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const a = data[i + 3];
        if (a < 96) { row.push(null); continue; }
        row.push(nearest([data[i], data[i + 1], data[i + 2]], palette));
      }
      rows.push(row);
    }
    state.rows = rows;
    state.size = { x: w, y: h };
    state.prepared = false;
    renderPreview();
    $("px-name").textContent = "";
  }

  async function post(url, body) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return await r.json().catch(() => ({ ok: false, error: "响应解析失败" }));
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  async function prepare() {
    if (!state.rows) return toast("请先生成像素预览", true);
    const name = ($("px-name-input").value || "").trim() || "pixelart-" + Date.now().toString().slice(-5);
    const r = await post("/api/pixelart/prepare", { name, rows: state.rows });
    if (!r.ok) return toast("生成失败：" + (r.error || "未知错误"), true);
    state.prepared = true;
    const s = r.structure;
    $("px-name").textContent = `已生成：${s.name} · ${s.size.x}×${s.size.y} · ${s.total} 方块 · ${s.paletteSize} 种`;
    toast("像素画已生成，点「开始导入」即可放进游戏");
  }


  /* 一键：生成方块画 → 立刻导入 */
  async function buildNow() {
    if (!state.rows) return toast("请先上传图片并生成预览", true);
    await prepare();
    if (!state.prepared) return;
    await build();
  }

  async function build() {
    if (!state.prepared) return toast("请先点「生成像素画」", true);
    const offsetY = Number($("px-offset").value || 0) || 0;
    const r = await post("/api/structure/build", { offsetY });
    if (!r.ok) return toast("导入失败：" + (r.error || "未知错误"), true);
    const o = r.origin || {};
    toast(`开始导入：${r.name}，原点 ${o.x},${o.y},${o.z}`);
    $("px-name").textContent = `导入中：${r.name} · ${r.total} 方块`;

    // 轮询状态直到完成
    const tick = async () => {
      try {
        const s = await (await fetch("/api/status")).json();
        const b = s && s.structure && s.structure.build;
        if (!b) return;
        const pct = b.total ? Math.floor((b.placed / b.total) * 100) : 0;
        $("px-name").textContent = `导入中：${b.name} · ${b.placed}/${b.total}（${pct}%）· ${b.stepLabel || ""}`;
        if (!b.done && !b.cancelled) setTimeout(tick, 1200);
        else $("px-name").textContent = b.verified
          ? `完成：${b.name} · ${b.total} 方块`
          : `结束：失败 ${b.failed} 条 / ${b.failedBlocks} 方块`;
      } catch {}
    };
    setTimeout(tick, 1200);
  }

  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) return toast("请选择图片文件", true);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      state.img = img;
      URL.revokeObjectURL(url);
      $("px-file-name").textContent = `${file.name}（${img.naturalWidth}×${img.naturalHeight}）`;
      convert();
    };
    img.onerror = () => toast("图片读取失败", true);
    img.src = url;
  }

  function init() {
    const panel = $("panel-pixelart");
    if (!panel) return;
    // 填充调色板选项
    const sel = $("px-palette");
    sel.innerHTML = "";
    for (const [k, v] of Object.entries(PALETTES)) {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = v.label;
      sel.appendChild(o);
    }
    $("px-file").onchange = (e) => loadFile(e.target.files && e.target.files[0]);
    $("px-convert").onclick = convert;
    $("px-prepare").onclick = prepare;
    $("px-build").onclick = build;
    if ($("px-build-now")) $("px-build-now").onclick = buildNow;
    $("px-width").onchange = convert;
    $("px-palette").onchange = convert;
    const drop = $("px-drop");
    if (drop) {
      ["dragover", "dragenter"].forEach((ev) =>
        drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); })
      );
      ["dragleave", "drop"].forEach((ev) =>
        drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); })
      );
      drop.addEventListener("drop", (e) => {
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) loadFile(f);
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

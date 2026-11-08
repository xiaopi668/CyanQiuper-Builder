/**
 * CyanQiuper 控制台 · 音乐盒（v2）
 * 导入 MIDI → 时间轴可视化 → /playsound 游戏内播放 + /titleraw 歌词
 * 纯前端，解析 / 试听 / 调度全部在浏览器完成
 */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };

  // ================= MIDI 解析 =================
  function parseMidi(buf) {
    var dv = new DataView(buf), pos = 0;
    function u8() { return dv.getUint8(pos++); }
    function u16() { var v = dv.getUint16(pos); pos += 2; return v; }
    function u32() { var v = dv.getUint32(pos); pos += 4; return v; }
    function str4() { var s = ""; for (var i = 0; i < 4; i++) s += String.fromCharCode(dv.getUint8(pos++)); return s; }
    function vlq() { var v = 0, b; do { b = dv.getUint8(pos++); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; }

    var ppq = 480, fmt = 0, ntrks = 1, raw = [], tempos = [], programs = [], lyricRaw = [];
    while (pos < dv.byteLength) {
      var id = str4(), len = u32(), end = pos + len;
      if (id === "MThd") {
        fmt = u16(); ntrks = u16(); var div = u16();
        if (div & 0x8000) throw new Error("不支持 SMPTE 时间格式");
        ppq = div & 0x7fff;
      } else if (id === "MTrk") {
        var tick = 0, running = 0;
        while (pos < end) {
          tick += vlq();
          var st = dv.getUint8(pos);
          if (st < 0x80) st = running; else { pos++; running = st; }
          var hi = st & 0xf0, ch = st & 0x0f;
          if (st === 0xff) {
            var meta = u8(), mlen = vlq(), ms = pos;
            if (meta === 0x51 && mlen === 3) {
              tempos.push({ tick: tick, us: (dv.getUint8(pos) << 16) | (dv.getUint8(pos + 1) << 8) | dv.getUint8(pos + 2) });
            } else if (meta === 0x05 || meta === 0x01) {
              try {
                var bytes = new Uint8Array(buf, ms, mlen);
                var txt = new TextDecoder("utf-8").decode(bytes);
                if (txt && txt.trim()) lyricRaw.push({ tick: tick, text: txt });
              } catch (e) {}
            } else if (meta === 0x2f) { pos = end; break; }
            pos = ms + mlen;
          } else if (st === 0xf0 || st === 0xf7) { pos += vlq(); }
          else if (hi === 0x90 || hi === 0x80) {
            var nn = u8(), vv = u8();
            if (hi === 0x90 && vv > 0) raw.push({ tick: tick, ch: ch, kind: "on", note: nn, vel: vv });
            else raw.push({ tick: tick, ch: ch, kind: "off", note: nn });
          } else if (hi === 0xa0 || hi === 0xb0 || hi === 0xe0) { u8(); u8(); }
          else if (hi === 0xc0) { programs.push({ tick: tick, ch: ch, prog: u8() }); }
          else if (hi === 0xd0) { u8(); }
          else { pos = end; }
          if (pos > end) pos = end;
        }
      } else pos = end;
      pos = end;
    }
    if (!raw.length) throw new Error("MIDI 里没有音符");

    tempos.sort(function (a, b) { return a.tick - b.tick; });
    if (!tempos.length) tempos.push({ tick: 0, us: 500000 });
    if (tempos[0].tick > 0) tempos.unshift({ tick: 0, us: 500000 });
    var segs = [], last = tempos[0].tick;
    for (var i = 1; i < tempos.length; i++) {
      segs.push({ from: last, to: tempos[i].tick, sec: tempos[i - 1].us / 1e6 / ppq });
      last = tempos[i].tick;
    }
    segs.push({ from: last, to: Infinity, sec: tempos[tempos.length - 1].us / 1e6 / ppq });
    function tickToSec(tk) {
      var s = 0;
      for (var i = 0; i < segs.length; i++) {
        var sg = segs[i];
        if (tk <= sg.from) break;
        s += (Math.min(tk, sg.to) - sg.from) * sg.sec;
        if (tk <= sg.to) break;
      }
      return s;
    }
    programs.sort(function (a, b) { return a.tick - b.tick; });
    function progFor(ch, tk) {
      var pr = 0;
      for (var i = 0; i < programs.length; i++) {
        var q = programs[i];
        if (q.ch === ch && q.tick <= tk) pr = q.prog;
      }
      return pr;
    }
    raw.sort(function (a, b) { return a.tick - b.tick; });
    var open = {}, notes = [], maxTick = 0;
    for (var r = 0; r < raw.length; r++) {
      var e = raw[r], key = e.ch + ":" + e.note;
      if (e.kind === "on") { (open[key] = open[key] || []).push(e); }
      else {
        var arr = open[key];
        if (arr && arr.length) {
          var st2 = arr.shift();
          var t0 = tickToSec(st2.tick), t1 = tickToSec(e.tick);
          notes.push({ t: t0, dur: Math.max(0.03, t1 - t0), note: st2.note, vel: st2.vel, ch: st2.ch, prog: progFor(st2.ch, st2.tick) });
          maxTick = Math.max(maxTick, e.tick);
        }
      }
    }
    for (var k in open) {
      for (var j = 0; j < open[k].length; j++) {
        var q2 = open[k][j];
        notes.push({ t: tickToSec(q2.tick), dur: 0.25, note: q2.note, vel: q2.vel, ch: q2.ch, prog: progFor(q2.ch, q2.tick) });
      }
    }
    notes.sort(function (a, b) { return a.t - b.t; });
    var dur = notes.length ? notes[notes.length - 1].t + notes[notes.length - 1].dur : 1;
    lyricRaw.sort(function (a, b) { return a.tick - b.tick; });
    var lyrics = lyricRaw.map(function (l) { return { t: tickToSec(l.tick), text: l.text }; });
    return {
      ppq: ppq, format: fmt, tracks: ntrks, notes: notes, count: notes.length,
      duration: Math.max(dur, tickToSec(maxTick + 1)),
      channels: Array.from(new Set(notes.map(function (n) { return n.ch; }))).sort(function (a, b) { return a - b; }),
      lyrics: lyrics,
    };
  }

  // ================= 乐器映射 =================
  var PROG_MAP = [
    [0, 7, "note.harp", "钢琴"], [8, 15, "note.xylophone", "色彩打击"],
    [16, 23, "note.chime", "风琴/钟"], [24, 31, "note.guitar", "吉他"],
    [32, 39, "note.bass", "贝斯"], [40, 55, "note.harp", "弦乐/合奏"],
    [56, 63, "note.iron_xylophone", "铜管"], [64, 71, "note.didgeridoo", "簧管"],
    [72, 79, "note.flute", "管乐"], [80, 87, "note.pling", "合成主音"],
    [88, 95, "note.bell", "合成铺底"], [96, 103, "note.bit", "合成特效"],
    [104, 111, "note.banjo", "民族"], [112, 119, "note.snare", "打击"],
    [120, 127, "note.cow_bell", "音效"],
  ];
  var COLORS = {
    "note.harp": "#4ea8f5", "note.xylophone": "#f5c542", "note.chime": "#b48cf2",
    "note.guitar": "#f28c5a", "note.bass": "#3fd0c9", "note.iron_xylophone": "#f5a3d0",
    "note.didgeridoo": "#a9c94a", "note.flute": "#7ee0a3", "note.pling": "#62d0ff",
    "note.bell": "#9fb8ff", "note.bit": "#ff7a7a", "note.banjo": "#e0a75e",
    "note.snare": "#ff9f5a", "note.cow_bell": "#c8c8a8", "drums": "#8fd66a",
  };
  function soundFor(prog) {
    for (var i = 0; i < PROG_MAP.length; i++) if (prog >= PROG_MAP[i][0] && prog <= PROG_MAP[i][1]) return PROG_MAP[i][2];
    return "note.harp";
  }
  var DRUM_MAP = {
    35: "note.bassattack", 36: "note.bassattack", 38: "note.snare", 40: "note.snare",
    42: "note.hat", 44: "note.hat", 46: "note.hat", 49: "note.hat", 51: "note.hat",
    57: "note.hat", 37: "note.snare", 39: "note.snare", 41: "note.snare",
    54: "note.hat", 56: "note.hat", 59: "note.hat",
  };
  function drumSound(note) {
    if (DRUM_MAP[note]) return DRUM_MAP[note];
    if (note <= 40) return "note.bassattack";
    if (note <= 50) return "note.snare";
    return "note.hat";
  }
  function pitchFor(note) {
    var n = note, p = Math.pow(2, (n - 54) / 12);
    while (p < 0.5) { n += 12; p = Math.pow(2, (n - 54) / 12); }
    while (p > 2.0) { n -= 12; p = Math.pow(2, (n - 54) / 12); }
    return Math.max(0.5, Math.min(2.0, p));
  }
  function commandFor(note, volume) {
    var sound = note.ch === 9 ? drumSound(note.note) : soundFor(note.prog);
    var pitch = note.ch === 9 ? 1.0 : pitchFor(note.note);
    var vol = Math.max(0.1, Math.min(1.0, (note.vel / 127) * (volume / 100)));
    return '/playsound ' + sound + ' @a ~ ~ ~ ' + vol.toFixed(2) + ' ' + pitch.toFixed(3);
  }
  function esc(text) {
    return String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ").slice(0, 60);
  }
  function titleCommand(text, kind) {
    var k = kind === "title" || kind === "subtitle" ? kind : "actionbar";
    return "/titleraw @a " + k + ' {"rawtext":[{"text":"' + esc(text) + '"}]}';
  }

  // ================= 本地试听 =================
  var mctx = null, master = null, noiseBuf = null;
  function ensureCtx() {
    if (!mctx) {
      mctx = new (window.AudioContext || window.webkitAudioContext)();
      master = mctx.createGain();
      master.gain.value = 0.5;
      master.connect(mctx.destination);
      noiseBuf = mctx.createBuffer(1, mctx.sampleRate * 0.4, mctx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (mctx.state === "suspended") mctx.resume();
    return mctx;
  }
  function freq(n) { return 440 * Math.pow(2, (n - 69) / 12); }
  function playLocal(note, when) {
    var ac = ensureCtx();
    var dur = Math.max(0.06, Math.min(note.dur, 2.5));
    if (note.ch === 9) {
      var s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      s.buffer = noiseBuf;
      var kick = /bassattack/.test(drumSound(note.note));
      f.type = kick ? "lowpass" : "bandpass";
      f.frequency.value = kick ? 200 : 2400;
      g.gain.setValueAtTime(kick ? 0.3 : 0.14, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + (kick ? 0.22 : 0.1));
      s.connect(f).connect(g).connect(master);
      s.start(when); s.stop(when + 0.3);
      return;
    }
    var o = ac.createOscillator(), gn = ac.createGain();
    var wave = "triangle", snd = soundFor(note.prog);
    if (/flute|pling|bit|chime/.test(snd)) wave = "sine";
    else if (/guitar|banjo|xylophone/.test(snd)) wave = "square";
    else if (/bass/.test(snd)) wave = "sawtooth";
    o.type = wave;
    o.frequency.setValueAtTime(freq(note.note), when);
    var vol = Math.max(0.03, (note.vel / 127) * 0.16);
    var a = Math.min(0.015, dur * 0.2), r = Math.min(0.1, dur * 0.5);
    gn.gain.setValueAtTime(0.0001, when);
    gn.gain.exponentialRampToValueAtTime(vol, when + a);
    gn.gain.setValueAtTime(vol, when + Math.max(a, dur - r));
    gn.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(gn).connect(master);
    o.start(when); o.stop(when + dur + 0.02);
  }

  // ================= 状态 =================
  var ui = {
    midi: null, fileName: "", playing: false, timer: null,
    idx: 0, startAt: 0, startAtMs: 0, elapsed: 0,
    loop: true, local: true, sendGame: true, showTitle: true,
    volume: 80, rate: 1.0,
    sent: 0, errors: 0, lastError: "", lastBar: 0, lyricIdx: 0,
    playhead: 0, raf: null,
  };

  function log(msg) {
    var el = $("mu-log");
    if (!el) return;
    var div = document.createElement("div");
    div.textContent = "[" + new Date().toTimeString().slice(0, 8) + "] " + msg;
    el.insertBefore(div, el.firstChild);
    while (el.childNodes.length > 8) el.removeChild(el.lastChild);
  }

  // ================= 统计 / 时间轴 =================
  function instrumentOf(n) { return n.ch === 9 ? "drums" : soundFor(n.prog); }

  function renderStats() {
    var m = ui.midi;
    if ($("mu-s-notes")) $("mu-s-notes").textContent = m ? m.count : 0;
    if ($("mu-s-dur")) $("mu-s-dur").textContent = m ? m.duration.toFixed(1) + "s" : "0.0s";
    if ($("mu-s-lyrics")) $("mu-s-lyrics").textContent = m ? (m.lyrics ? m.lyrics.length : 0) : 0;
    if ($("mu-s-sent")) $("mu-s-sent").textContent = ui.sent;
    if ($("mu-s-errors")) $("mu-s-errors").textContent = ui.errors;
  }

  function drawTimeline() {
    var cv = $("mu-timeline");
    if (!cv) return;
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || 900, h = cv.clientHeight || 132;
    if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) {
      cv.width = Math.floor(w * dpr);
      cv.height = Math.floor(h * dpr);
    }
    var ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0b0f17";
    ctx.fillRect(0, 0, w, h);
    var m = ui.midi;
    var left = 62, right = w - 10;
    if (!m) {
      ctx.fillStyle = "#3b4a5e";
      ctx.font = "12px 'Microsoft YaHei'";
      ctx.fillText("导入 MIDI（或 MP3 转换）后，这里会显示彩色音轨时间轴", 14, h / 2 + 4);
      return;
    }
    var insts = {};
    m.notes.forEach(function (n) { insts[instrumentOf(n)] = true; });
    var rows = Object.keys(insts);
    var rowH = Math.max(9, Math.min(30, (h - 26) / Math.max(1, rows.length)));
    var top = Math.max(6, (h - 20 - rows.length * rowH) / 2 + 4);
    var dur = Math.max(0.001, m.duration);
    rows.forEach(function (name, i) {
      ctx.fillStyle = "rgba(255,255,255,.035)";
      ctx.fillRect(0, top + i * rowH, w, rowH - 2);
      ctx.fillStyle = COLORS[name] || "#4ea8f5";
      ctx.globalAlpha = 0.22;
      ctx.fillRect(0, top + i * rowH, 3, rowH - 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#5c7086";
      ctx.font = "10px 'Microsoft YaHei'";
      ctx.fillText(name.replace("note.", "").slice(0, 9), 4, top + i * rowH + rowH - 5);
    });
    m.notes.forEach(function (n) {
      var name = instrumentOf(n);
      var ri = rows.indexOf(name);
      var x = left + (n.t / dur) * (right - left);
      var ww = Math.max(1.5, (n.dur / dur) * (right - left));
      var y = top + ri * rowH + 2;
      ctx.fillStyle = COLORS[name] || "#4ea8f5";
      ctx.globalAlpha = 0.45 + 0.55 * (n.vel / 127);
      ctx.fillRect(x, y, ww, rowH - 5);
      ctx.globalAlpha = 1;
    });
    ctx.fillStyle = "#3a4a60";
    ctx.font = "10px 'Microsoft YaHei'";
    var steps = Math.min(8, Math.max(2, Math.floor(dur / 5)));
    for (var s = 0; s <= steps; s++) {
      var x2 = left + (s / steps) * (right - left);
      ctx.fillRect(x2, h - 13, 1, 7);
      ctx.fillText((dur * s / steps).toFixed(1) + "s", Math.min(x2, w - 28), h - 2);
    }
    if (ui.playing || ui.playhead > 0) {
      var px = left + (Math.min(ui.playhead, dur) / dur) * (right - left);
      ctx.fillStyle = "#ffd166";
      ctx.fillRect(px - 1, 4, 2, h - 16);
    }
  }

  function updateProgress() {
    var el = $("mu-progress"), bar = $("mu-bar");
    var m = ui.midi;
    if (!el) return;
    if (!m) { el.textContent = "0.0 / 0.0s（0%）"; if (bar) bar.style.width = "0%"; return; }
    var pct = Math.min(100, (ui.elapsed / m.duration) * 100);
    el.textContent = (ui.playing ? "播放中 " : "已停止 ") + ui.elapsed.toFixed(1) + " / " + m.duration.toFixed(1) + "s（" + pct.toFixed(0) + "%）" +
      " · 已发送 " + ui.sent + " 条命令" + (ui.errors ? " · 失败 " + ui.errors : "");
    if (bar) bar.style.width = pct.toFixed(1) + "%";
    renderStats();
  }

  function updateInfo() {
    var m = ui.midi;
    if (!m) { if ($("mu-info")) $("mu-info").textContent = "—"; if ($("mu-name")) $("mu-name").textContent = "未选择文件 · 支持 MIDI / MP3（MP3 自动转换）"; return; }
    if ($("mu-name")) $("mu-name").textContent = ui.fileName || "已加载";
    if ($("mu-info")) $("mu-info").textContent = "音符 " + m.count + " · 时长 " + m.duration.toFixed(2) + "s · 轨道 " + m.tracks +
      " · 通道 " + m.channels.join(",") + " · 歌词 " + ((m.lyrics && m.lyrics.length) || 0) + " 行";
  }

  // ================= 发送 =================
  function sendCommand(cmd) {
    if (!ui.sendGame) return;
    return fetch("/api/send", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: cmd }),
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r && r.ok) { ui.sent++; }
      else {
        ui.errors++;
        ui.lastError = (r && r.error) || "发送失败";
        if (ui.errors === 1) log("游戏发送失败：" + ui.lastError + "（本地试听继续）");
      }
      renderStats();
    }).catch(function (e) {
      ui.errors++;
      if (ui.errors === 1) log("游戏发送失败：" + String(e && e.message ? e.message : e));
    });
  }
  function sendTitle(text, kind) {
    if (!ui.showTitle || !ui.sendGame) return;
    sendCommand(titleCommand(text, kind));
  }

  // ================= 调度 =================
  function tickLoop() {
    drawTimeline();
    ui.raf = requestAnimationFrame(tickLoop);
  }

  function scheduler() {
    if (!ui.playing || !ui.midi) return;
    var ac = ui.local ? ensureCtx() : null;
    var nowLocal = ac ? ac.currentTime : 0;
    var elapsed = (ac ? nowLocal - ui.startAt : (performance.now() - ui.startAtMs) / 1000);
    var horizon = elapsed + 0.16;
    while (ui.idx < ui.midi.notes.length && ui.midi.notes[ui.idx].t <= horizon) {
      var n = ui.midi.notes[ui.idx];
      var t = n.t / ui.rate;
      if (ui.local) {
        var when = ui.startAt + t;
        if (when >= nowLocal - 0.05) playLocal(n, Math.max(nowLocal, when));
      }
      if (ui.sendGame) {
        (function (cmd, delay) {
          setTimeout(function () { sendCommand(cmd); }, delay);
        })(commandFor(n, ui.volume), Math.max(0, (ui.startAtMs + t * 1000) - performance.now()));
      }
      ui.idx++;
    }
    var lyr = ui.midi.lyrics || [];
    if (lyr.length) {
      while (ui.lyricIdx < lyr.length && lyr[ui.lyricIdx].t / ui.rate <= horizon) {
        (function (txt, delay) {
          setTimeout(function () { sendTitle("♪ " + txt, "actionbar"); }, delay);
        })(lyr[ui.lyricIdx].text, Math.max(0, (ui.startAtMs + (lyr[ui.lyricIdx].t / ui.rate) * 1000) - performance.now()));
        ui.lyricIdx++;
      }
    } else if (Math.floor(elapsed / 2) !== ui.lastBar) {
      ui.lastBar = Math.floor(elapsed / 2);
      sendTitle("♪ " + (ui.fileName || "音乐") + " · " + Math.round(elapsed) + "s", "actionbar");
    }

    ui.elapsed = Math.min(ui.midi.duration, elapsed * ui.rate);
    ui.playhead = ui.elapsed;
    updateProgress();
    if (ui.idx >= ui.midi.notes.length && elapsed >= ui.midi.duration / ui.rate) {
      if (ui.loop) {
        ui.idx = 0; ui.elapsed = 0; ui.playhead = 0; ui.lyricIdx = 0; ui.lastBar = 0;
        ui.startAt = mctx ? mctx.currentTime + 0.05 : 0;
        ui.startAtMs = performance.now() + 50;
      } else stop();
    }
  }

  function play() {
    if (!ui.midi) { log("请先上传 MIDI 或先转换 MP3"); return; }
    if (ui.playing) return;
    ensureCtx();
    ui.playing = true;
    ui.idx = 0; ui.sent = 0; ui.errors = 0;
    ui.lyricIdx = 0; ui.lastBar = 0; ui.playhead = 0;
    ui.startAt = mctx.currentTime + 0.12;
    ui.startAtMs = performance.now() + 120;
    ui.elapsed = 0;
    ui.timer = setInterval(scheduler, 25);
    if (!ui.raf) ui.raf = requestAnimationFrame(tickLoop);
    scheduler();
    sendTitle("♪ " + (ui.fileName || "音乐"), "title");
    if ($("mu-play")) $("mu-play").textContent = "暂停";
    log("开始播放（" + (ui.sendGame ? "发送到游戏" : "仅本地试听") + "）");
    updateProgress();
  }

  function stop() {
    ui.playing = false;
    if (ui.timer) { clearInterval(ui.timer); ui.timer = null; }
    ui.idx = 0; ui.elapsed = 0; ui.playhead = 0;
    if ($("mu-play")) $("mu-play").textContent = "播放";
    updateProgress();
    drawTimeline();
  }

  // ================= 载入 =================
  function loadArrayBuffer(ab, fileName) {
    ui.midi = parseMidi(ab);
    ui.fileName = fileName;
    stop();
    ui.sent = 0; ui.errors = 0;
    updateInfo();
    updateProgress();
    drawTimeline();
    if (!ui.raf) ui.raf = requestAnimationFrame(tickLoop);
    log("已加载 " + fileName + "：" + ui.midi.count + " 个音符 · " + ui.midi.duration.toFixed(1) + "s");
    window.CQMusic_INFO = {
      notes: ui.midi.count, duration: ui.midi.duration, channels: ui.midi.channels,
      tracks: ui.midi.tracks, ppq: ui.midi.ppq, lyrics: ui.midi.lyrics ? ui.midi.lyrics.length : 0,
    };
    return window.CQMusic_INFO;
  }
  function loadBase64(b64, fileName) {
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return loadArrayBuffer(bytes.buffer, fileName || "midi");
  }
  function clear() {
    stop();
    ui.midi = null; ui.fileName = "";
    updateInfo(); updateProgress(); drawTimeline();
    renderStats();
  }

  // ================= UI 绑定 =================
  function bind() {
    var file = $("mu-file");
    if ($("mu-import") && file) {
      $("mu-import").addEventListener("click", function () { file.click(); });
      file.addEventListener("change", function () {
        var f = file.files && file.files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () {
          if (/\.mp3$/i.test(f.name) || /mpeg|mp3/i.test(f.type || "")) {
            log("检测到 MP3，先转换：" + f.name);
            if (window.CQ_MP3) window.CQ_MP3.convertArrayBuffer(fr.result, f.name);
            return;
          }
          try { loadArrayBuffer(fr.result, f.name); } catch (e) { log("解析失败：" + e.message); alert("MIDI 解析失败：" + e.message); }
        };
        fr.readAsArrayBuffer(f);
      });
    }
    if ($("mu-clear")) $("mu-clear").addEventListener("click", clear);
    if ($("mu-play")) $("mu-play").addEventListener("click", function () { if (ui.playing) stop(); else play(); });
    if ($("mu-stop")) $("mu-stop").addEventListener("click", stop);
    if ($("mu-loop")) $("mu-loop").addEventListener("change", function (e) { ui.loop = e.target.checked; });
    if ($("mu-local")) $("mu-local").addEventListener("change", function (e) { ui.local = e.target.checked; });
    if ($("mu-sendgame")) $("mu-sendgame").addEventListener("change", function (e) { ui.sendGame = e.target.checked; });
    if ($("mu-showtitle")) {
      $("mu-showtitle").checked = ui.showTitle;
      $("mu-showtitle").addEventListener("change", function (e) { ui.showTitle = e.target.checked; });
    }
    if ($("mu-volume")) $("mu-volume").addEventListener("input", function (e) {
      ui.volume = Number(e.target.value);
      if (master) master.gain.value = (ui.volume / 100) * 0.7;
    });
    if ($("mu-rate")) $("mu-rate").addEventListener("change", function (e) { ui.rate = Number(e.target.value) || 1.0; });

    window.addEventListener("dragover", function (e) { e.preventDefault(); });
    window.addEventListener("drop", function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (!/\.(midi?|mp3)$/i.test(f.name)) return;
      e.preventDefault();
      var fr = new FileReader();
      fr.onload = function () {
        if (/\.mp3$/i.test(f.name)) { if (window.CQ_MP3) window.CQ_MP3.convertArrayBuffer(fr.result, f.name); return; }
        try { loadArrayBuffer(fr.result, f.name); } catch (err) { alert("MIDI 解析失败：" + err.message); }
      };
      fr.readAsArrayBuffer(f);
    });
    window.addEventListener("resize", drawTimeline);
    if (!ui.raf) ui.raf = requestAnimationFrame(tickLoop);
  }

  window.CQMusic = {
    parse: parseMidi, loadBase64: loadBase64, loadArrayBuffer: loadArrayBuffer,
    play: play, stop: stop, clear: clear,
    commandFor: commandFor, soundFor: soundFor, pitchFor: pitchFor, titleCommand: titleCommand,
    info: function () { return window.CQMusic_INFO || null; },
    state: function () {
      return { loaded: !!ui.midi, playing: ui.playing, sent: ui.sent, errors: ui.errors, notes: ui.midi ? ui.midi.count : 0, elapsed: ui.elapsed };
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();

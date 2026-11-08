/**
 * CyanQiuper 控制台 · 音乐盒
 * 内置 MP3 → MIDI 转换器（纯前端，无外部依赖）
 *
 * 原理：
 *   1. WebAudio decodeAudioData 解码 MP3 → 单声道 11025Hz
 *   2. 逐帧（1024/256）算 RMS 与自相关基频 → 音高轨迹
 *   3. 用能量上升沿检测音符起点，按段取中位音高 → 单音旋律
 *   4. 由音符间隔估算 BPM，量化到 1/16 网格
 *   5. 写出标准 MIDI（SMF format 0，乐器=钢琴）
 *
 * 局限：单音旋律效果最好；和弦/复杂混音会变成一个粗略的主旋律。
 */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };

  var SR = 11025;          // 分析采样率
  var FRAME = 1024;        // 帧长
  var HOP = 256;           // 帧移

  var state = {
    status: "idle",
    fileName: "",
    notes: [],
    bpm: 120,
    duration: 0,
    midiBytes: null,
    progress: 0,
  };

  function setStatus(text) {
    if ($("mp3-status")) $("mp3-status").textContent = text;
  }
  function setProgress(pct) {
    state.progress = pct;
    if ($("mp3-bar")) $("mp3-bar").style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + "%";
  }
  function setStats() {
    if ($("mp3-notes")) $("mp3-notes").textContent = state.notes.length;
    if ($("mp3-bpm")) $("mp3-bpm").textContent = Math.round(state.bpm);
    if ($("mp3-dur")) $("mp3-dur").textContent = state.duration.toFixed(1) + "s";
  }

  // ---------- 解码 + 重采样 ----------
  function decodeToMono(ab) {
    var AC = window.AudioContext || window.webkitAudioContext;
    var ac = new AC();
    return ac.decodeAudioData(ab.slice(0)).then(function (buf) {
      var chs = buf.numberOfChannels;
      var len = buf.length;
      var mono = new Float32Array(len);
      for (var c = 0; c < chs; c++) {
        var data = buf.getChannelData(c);
        for (var i = 0; i < len; i++) mono[i] += data[i] / chs;
      }
      // 简单重采样到 11025
      var ratio = buf.sampleRate / SR;
      var outLen = Math.floor(len / ratio);
      var out = new Float32Array(outLen);
      for (var j = 0; j < outLen; j++) {
        var src = j * ratio;
        var i0 = Math.floor(src), i1 = Math.min(len - 1, i0 + 1);
        var f = src - i0;
        out[j] = mono[i0] * (1 - f) + mono[i1] * f;
      }
      state.duration = outLen / SR;
      try { ac.close(); } catch (e) {}
      return out;
    });
  }

  // ---------- 逐帧分析 ----------
  function rms(buf, start) {
    var s = 0;
    for (var i = 0; i < FRAME; i++) { var v = buf[start + i] || 0; s += v * v; }
    return Math.sqrt(s / FRAME);
  }

  function detectPitch(buf, start) {
    var minLag = Math.floor(SR / 1000);   // 最高 1000Hz
    var maxLag = Math.floor(SR / 70);     // 最低 70Hz
    var W = FRAME - maxLag;
    if (W < 128) return 0;
    var e1 = 0;
    for (var i = 0; i < W; i++) { var v = buf[start + i] || 0; e1 += v * v; }
    if (e1 < 1e-7) return 0;
    function corrAt(lag) {
      var corr = 0, e2 = 0;
      for (var k = 0; k < W; k++) {
        var a = buf[start + k] || 0, b = buf[start + k + lag] || 0;
        corr += a * b;
        e2 += b * b;
      }
      return e2 > 1e-9 ? corr / Math.sqrt(e1 * e2) : 0;
    }
    var corrs = new Float32Array(maxLag - minLag + 1);
    var bestCorr = 0;
    for (var lag = minLag; lag <= maxLag; lag++) {
      var c = corrAt(lag);
      corrs[lag - minLag] = c;
      if (c > bestCorr) bestCorr = c;
    }
    if (bestCorr < 0.35) return 0;
    // 取「第一个足够强的峰」，避免八度错误（滞后 2T 的相关系数也很高）
    var thresh = Math.max(0.35, bestCorr * 0.92);
    var best = -1;
    for (var j = 1; j < corrs.length - 1; j++) {
      if (corrs[j] >= thresh && corrs[j] >= corrs[j - 1] && corrs[j] >= corrs[j + 1]) {
        best = j + minLag;
        break;
      }
    }
    if (best < 0) {
      for (var j2 = 0; j2 < corrs.length; j2++) if (corrs[j2] === bestCorr) { best = j2 + minLag; break; }
    }
    if (best < 0) return 0;
    var c0 = corrAt(best - 1), c1 = corrAt(best), c2 = corrAt(best + 1);
    var denom = c0 - 2 * c1 + c2;
    var shift = denom !== 0 ? (0.5 * (c0 - c2)) / denom : 0;
    var lagF = best + Math.max(-0.5, Math.min(0.5, shift));
    return SR / lagF;
  }

  function freqToNote(f) {
    return Math.round(69 + 12 * Math.log2(f / 440));
  }

  // ---------- 主分析（分块让 UI 不卡） ----------
  function analyze(mono) {
    return new Promise(function (resolve) {
      var frames = Math.floor((mono.length - FRAME) / HOP);
      var pitches = new Float32Array(frames);
      var rmsArr = new Float32Array(frames);
      var fi = 0;
      function step() {
        var end = Math.min(frames, fi + 40);
        for (; fi < end; fi++) {
          var st = fi * HOP;
          var e = rms(mono, st);
          rmsArr[fi] = e;
          pitches[fi] = e > 0.012 ? detectPitch(mono, st) : 0;
        }
        setProgress((fi / frames) * 100);
        setStatus("分析音高… " + Math.round((fi / frames) * 100) + "%");
        if (fi < frames) setTimeout(step, 0);
        else resolve({ pitches: pitches, rms: rmsArr, frames: frames });
      }
      step();
    });
  }

  // ---------- 音符切分（按音高连续段） ----------
  function segmentNotes(pitches, rmsArr, frames) {
    var hopSec = HOP / SR;
    var segs = [], cur = null, silence = 0;
    for (var i = 0; i < frames; i++) {
      var f = pitches[i];
      if (!(f > 50 && f < 1500)) {
        silence += hopSec;
        if (silence > 0.12 && cur) { segs.push(cur); cur = null; }
        continue;
      }
      silence = 0;
      var semi = Math.round(69 + 12 * Math.log2(f / 440));
      if (!cur || Math.abs(semi - cur.semi) >= 1) {
        if (cur) segs.push(cur);
        cur = { semi: semi, start: i * hopSec, end: i * hopSec, vals: [f], e: [rmsArr[i]] };
      } else {
        cur.end = i * hopSec;
        cur.vals.push(f);
        cur.e.push(rmsArr[i]);
      }
    }
    if (cur) segs.push(cur);

    // 合并过短的碎片
    var merged = [];
    for (var s = 0; s < segs.length; s++) {
      var sg = segs[s];
      var dur = sg.end - sg.start;
      if (dur < 0.05 && merged.length) {
        merged[merged.length - 1].end = sg.end;
        continue;
      }
      if (dur < 0.05) continue;
      merged.push({ semi: sg.semi, start: sg.start, end: sg.end, vals: sg.vals, e: sg.e });
    }

    var notes = [];
    merged.forEach(function (sg) {
      var vals = sg.vals.slice().sort(function (a, b) { return a - b; });
      var med = vals[Math.floor(vals.length / 2)];
      var note = Math.round(69 + 12 * Math.log2(med / 440));
      if (note < 28 || note > 100) return;
      var eAvg = sg.e.reduce(function (a, b) { return a + b; }, 0) / sg.e.length;
      var vel = Math.max(40, Math.min(120, Math.round(eAvg * 700)));
      var last = notes[notes.length - 1];
      if (last && last.note === note && sg.start - (last.t + last.dur) < 0.05) {
        last.dur = sg.end - last.t;
        return;
      }
      notes.push({ t: sg.start, dur: Math.max(0.08, sg.end - sg.start), note: note, vel: vel });
    });
    state.debug = { segs: segs.length, merged: merged.length, notes: notes.length };
    return notes;
  }

  // ---------- BPM 估算 ----------
  function estimateBpm(notes) {
    if (notes.length < 3) return 120;
    var iois = [];
    for (var i = 1; i < notes.length; i++) {
      var d = notes[i].t - notes[i - 1].t;
      if (d > 0.08 && d < 2.0) iois.push(d);
    }
    if (!iois.length) return 120;
    iois.sort(function (a, b) { return a - b; });
    var med = iois[Math.floor(iois.length / 2)];
    var bpm = 60 / med;
    while (bpm < 50) bpm *= 2;
    while (bpm > 200) bpm /= 2;
    return Math.round(bpm);
  }

  // ---------- 写 MIDI ----------
  function vlq(v) {
    var out = [v & 0x7f];
    v >>= 7;
    while (v) { out.unshift((v & 0x7f) | 0x80); v >>= 7; }
    return out;
  }
  function writeMidi(notes, bpm, name) {
    var TPQ = 480;
    var ticksPerSec = (TPQ * bpm) / 60;
    var evs = [];
    evs.push({ t: 0, d: [0xff, 0x51, 0x03, (Math.round(60e6 / bpm) >> 16) & 0xff, (Math.round(60e6 / bpm) >> 8) & 0xff, Math.round(60e6 / bpm) & 0xff] });
    var nm = (name || "converted").slice(0, 40);
    var nb = [];
    for (var i = 0; i < nm.length; i++) {
      var code = nm.charCodeAt(i);
      if (code < 128) nb.push(code);
      else { var enc = encodeURIComponent(nm.charAt(i)); nb.push(0x3f); }
    }
    evs.push({ t: 0, d: [0xff, 0x03].concat(vlq(nb.length)).concat(nb) });
    notes.forEach(function (n) {
      var st = Math.round(n.t * ticksPerSec);
      var dur = Math.max(1, Math.round(n.dur * ticksPerSec));
      evs.push({ t: st, d: [0x90, n.note, n.vel], off: true });
      evs.push({ t: st + dur, d: [0x80, n.note, 0x40] });
    });
    evs.sort(function (a, b) { return a.t - b.t; });
    var track = [];
    var last = 0;
    evs.forEach(function (e) {
      track = track.concat(vlq(Math.max(0, e.t - last)));
      track = track.concat(e.d);
      last = e.t;
    });
    track = track.concat([0x00, 0xff, 0x2f, 0x00]);
    var header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (TPQ >> 8) & 0xff, TPQ & 0xff];
    var len = track.length;
    var mtrk = [0x4d, 0x54, 0x72, 0x6b, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff];
    return new Uint8Array(header.concat(mtrk, track));
  }

  // ---------- 对外流程 ----------
  function convertArrayBuffer(ab, fileName) {
    state.fileName = fileName || "audio";
    setStatus("解码音频…");
    setProgress(0);
    return decodeToMono(ab).then(function (mono) {
      setStatus("分析音高与节拍…");
      return analyze(mono).then(function (res) {
        setStatus("生成音符…");
        var notes = segmentNotes(res.pitches, res.rms, res.frames);
        var bpm = estimateBpm(notes);
        state.notes = notes;
        state.bpm = bpm;
        setStats();
        setStatus("写出 MIDI…");
        var bytes = writeMidi(notes, bpm, state.fileName.replace(/\.[^.]+$/, ""));
        state.midiBytes = bytes;
        setProgress(100);
        setStatus("转换完成：" + notes.length + " 个音符 · " +
          Math.round(bpm) + " BPM · " + state.duration.toFixed(1) + "s" +
          "（单音旋律效果最好，和弦会简化为主旋律）");
        if ($("mp3-save")) $("mp3-save").disabled = false;
        if ($("mp3-load")) $("mp3-load").disabled = false;
        // 自动载入音乐盒
        if (window.CQMusic) {
          try { window.CQMusic.loadArrayBuffer(bytes.buffer, state.fileName.replace(/\.[^.]+$/, "") + ".mid"); } catch (e) {}
        }
        window.CQ_MP3_RESULT = {
          notes: notes.length, bpm: bpm, duration: state.duration,
          pitches: notes.slice(0, 40).map(function (n) { return n.note; }),
          debug: state.debug || null,
        };
        return window.CQ_MP3_RESULT;
      });
    });
  }

  function convertBase64(b64, fileName) {
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return convertArrayBuffer(bytes.buffer, fileName || "audio.mp3");
  }

  function download() {
    if (!state.midiBytes) return;
    var blob = new Blob([state.midiBytes], { type: "audio/midi" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.fileName.replace(/\.[^.]+$/, "") || "converted") + ".mid";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  function bind() {
    var file = $("mp3-file");
    if ($("mp3-convert") && file) {
      $("mp3-convert").addEventListener("click", function () { file.click(); });
      file.addEventListener("change", function () {
        var f = file.files && file.files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () { convertArrayBuffer(fr.result, f.name); };
        fr.readAsArrayBuffer(f);
      });
    }
    if ($("mp3-save")) { $("mp3-save").disabled = true; $("mp3-save").addEventListener("click", download); }
    if ($("mp3-load")) {
      $("mp3-load").disabled = true;
      $("mp3-load").addEventListener("click", function () {
        if (!state.midiBytes || !window.CQMusic) return;
        window.CQMusic.loadArrayBuffer(state.midiBytes.buffer.slice(0), state.fileName.replace(/\.[^.]+$/, "") + ".mid");
      });
    }
    if ($("mp3-bar")) $("mp3-bar").style.width = "0%";
  }

  window.CQ_MP3 = {
    // 调试：对纯正弦检测音高
    debugDetect: function (freqHz) {
      var buf = new Float32Array(FRAME + 2000);
      for (var i = 0; i < buf.length; i++) buf[i] = Math.sin(2 * Math.PI * freqHz * i / SR);
      return detectPitch(buf, 0);
    },
    convertArrayBuffer: convertArrayBuffer,
    convertBase64: convertBase64,
    download: download,
    state: function () {
      return { notes: state.notes.length, bpm: state.bpm, duration: state.duration, hasMidi: !!state.midiBytes, progress: state.progress };
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();

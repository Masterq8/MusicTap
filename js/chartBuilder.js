/**
 * chartBuilder.js — 离线铺面引擎（全曲分析 → 谱面生成）
 * ====================================================
 * 纯 ES5，挂 window.ChartBuilder。「先缓存再铺面」流程的分析核心：
 * 完整 AudioBuffer → 降采样单声道 → 分帧 FFT → 三频段 spectral flux onset
 * → BPM/相位估计（IOI 直方图 + 梳状对齐）→ 16 分网格量化 → 按难度生成谱面。
 *
 * 算法体系与 beatGrid.js 同源（Bello et al. spectral flux + 自适应阈值），
 * 区别是离线一次性扫全曲，可以做全局统计（分位强度阈值、全曲步位分布）。
 *
 * 接口：
 *   ChartBuilder.analyze(audioBuffer, opts, onProgress) → Promise<chart|null>
 *     opts: { minBpm:70, maxBpm:180, startAt:0 }
 *     onProgress(0..1) 分片回调（不阻塞 UI）
 *   chart = {
 *     v: 2, bpm, offset, dur,
 *     notes: { easy:[], normal:[], hard:[] },   // note: { t, zone(0-3), s }
 *     meta: { onsets, frames, sr }
 *   }
 *   ChartBuilder.loadCached(songId) / saveCached(songId, chart)
 *   ChartBuilder.synthTestBuffer(bpm, duration)  // 测试专用：合成节拍缓冲
 */
(function (global) {
  'use strict';

  var MIN_BPM = 70;
  var MAX_BPM = 180;
  var TARGET_SR = 22050;   // 分析采样率：30Hz 低频分辨率够用，帧数减半
  var FRAME = 1024;        // FFT 帧（46ms @ 22050，低频 bin 21.5Hz）
  var CHUNK_FRAMES = 220;  // 每片处理的帧数（间或让出主线程）
  // 三频段（Hz）：低=kick / 中=军鼓人声 / 高=镲片
  var BANDS = [
    { lo: 30, hi: 160 },
    { lo: 160, hi: 2000 },
    { lo: 2000, hi: 8000 }
  ];

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ---------------- 迭代 radix-2 FFT（实输入） ---------------- */

  function makeFFT(n) {
    var cos = new Float32Array(n / 2);
    var sin = new Float32Array(n / 2);
    for (var i = 0; i < n / 2; i++) {
      cos[i] = Math.cos(-2 * Math.PI * i / n);
      sin[i] = Math.sin(-2 * Math.PI * i / n);
    }
    var rev = new Uint16Array(n);
    var bits = 0;
    while ((1 << bits) < n) bits++;
    for (var j = 0; j < n; j++) {
      var r = 0;
      for (var b = 0; b < bits; b++) if (j & (1 << b)) r |= 1 << (bits - 1 - b);
      rev[j] = r;
    }
    return function (re, im) {
      var i, j2, t;
      for (i = 0; i < n; i++) {
        j2 = rev[i];
        if (j2 > i) {
          t = re[i]; re[i] = re[j2]; re[j2] = t;
          t = im[i]; im[i] = im[j2]; im[j2] = t;
        }
      }
      for (var size = 2; size <= n; size <<= 1) {
        var half = size >> 1, step = n / size;
        for (i = 0; i < n; i += size) {
          for (j2 = 0; j2 < half; j2++) {
            var k = j2 * step;
            var wr = cos[k], wi = sin[k];
            var xr = re[i + j2 + half] * wr - im[i + j2 + half] * wi;
            var xi = re[i + j2 + half] * wi + im[i + j2 + half] * wr;
            re[i + j2 + half] = re[i + j2] - xr;
            im[i + j2 + half] = im[i + j2] - xi;
            re[i + j2] += xr;
            im[i + j2] += xi;
          }
        }
      }
    };
  }

  /* ---------------- 降采样单声道 ---------------- */

  function downmixMono(buffer) {
    var sr = buffer.sampleRate;
    var stride = Math.max(1, Math.round(sr / TARGET_SR));
    var outSr = sr / stride;
    var chans = buffer.numberOfChannels;
    var len = Math.floor(buffer.length / stride);
    var out = new Float32Array(len);
    var c, i, j, s;
    if (chans === 1) {
      var d0 = buffer.getChannelData(0);
      for (i = 0, j = 0; i < len; i++, j += stride) {
        s = 0;
        for (var k = 0; k < stride; k++) s += d0[j + k];
        out[i] = s / stride;
      }
    } else {
      var datas = [];
      for (c = 0; c < chans; c++) datas.push(buffer.getChannelData(c));
      for (i = 0, j = 0; i < len; i++, j += stride) {
        s = 0;
        for (c = 0; c < chans; c++) {
          for (var k2 = 0; k2 < stride; k2++) s += datas[c][j + k2];
        }
        out[i] = s / (stride * chans);
      }
    }
    return { data: out, sr: outSr };
  }

  /* ---------------- 谱面生成器 ---------------- */

  function ChartBuilderCtor() {}

  /**
   * 全曲分析。返回 Promise<chart|null>；找不到稳定节拍时 resolve(null)。
   */
  ChartBuilderCtor.prototype.analyze = function (audioBuffer, opts, onProgress) {
    opts = opts || {};
    var minBpm = opts.minBpm || MIN_BPM;
    var maxBpm = opts.maxBpm || MAX_BPM;
    var self = this;

    return new Promise(function (resolve) {
      var mono = downmixMono(audioBuffer);
      var data = mono.data, sr = mono.sr;
      try {
        console.info('[Chart] 开始全曲分析 时长=' + audioBuffer.duration.toFixed(1)
          + 's 采样率=' + audioBuffer.sampleRate + '→' + sr);
      } catch (e) {}
      var hop = 512;                       // 23.2ms @ 22050
      var total = Math.max(0, Math.floor((data.length - FRAME) / hop) + 1);
      if (total < 40) { console.warn('[Chart] 放弃：音频太短 frames=' + total); resolve(null); return; }   // 音频太短

      var fft = makeFFT(FRAME);
      var re = new Float32Array(FRAME);
      var im = new Float32Array(FRAME);
      var hann = new Float32Array(FRAME);
      for (var h = 0; h < FRAME; h++) hann[h] = 0.5 * (1 - Math.cos(2 * Math.PI * h / (FRAME - 1)));

      // 频段 bin 范围
      var binHz = sr / FRAME;
      var bandBins = BANDS.map(function (b) {
        return {
          lo: clamp(Math.floor(b.lo / binHz), 1, FRAME / 2 - 1),
          hi: clamp(Math.ceil(b.hi / binHz), 2, FRAME / 2)
        };
      });

      var nBands = BANDS.length;
      var energies = [];                   // energies[frame] = [e0,e1,e2]
      var frame = 0;

      function step() {
        var end = Math.min(total, frame + CHUNK_FRAMES);
        for (; frame < end; frame++) {
          var off = frame * hop;
          for (var i = 0; i < FRAME; i++) {
            re[i] = (off + i < data.length ? data[off + i] : 0) * hann[i];
            im[i] = 0;
          }
          fft(re, im);
          var row = [0, 0, 0];
          for (var b = 0; b < nBands; b++) {
            var e = 0, n = 0;
            for (var k = bandBins[b].lo; k < bandBins[b].hi; k++) {
              e += re[k] * re[k] + im[k] * im[k];
              n++;
            }
            row[b] = n ? e / n : 0;
          }
          energies.push(row);
        }
        if (onProgress) { try { onProgress(0.15 + 0.7 * frame / total); } catch (e) {} }
        if (frame < total) {
          global.setTimeout(step, 0);
        } else {
          try { resolve(self._build(energies, hop / sr, audioBuffer, minBpm, maxBpm, onProgress)); }
          catch (e) { resolve(null); }
        }
      }
      if (onProgress) { try { onProgress(0.05); } catch (e) {} }
      global.setTimeout(step, 0);
    });
  };

  /** onset 拾取 → BPM/相位 → 网格量化 → 三档谱面 */
  ChartBuilderCtor.prototype._build = function (energies, hopSec, audioBuffer, minBpm, maxBpm, onProgress) {
    var n = energies.length;

    /* --- ① 各频段 spectral flux + 自适应阈值 onset 拾取 --- */
    var onsets = [];                        // { t, band, s }
    var localMax = 2;                       // ±2 帧（约 ±46ms）局部极大
    var win = 8;                            // ±8 帧统计窗（约 ±186ms）
    for (var b = 0; b < 3; b++) {
      var flux = new Float32Array(n);
      for (var f = 1; f < n; f++) {
        var d = energies[f][b] - energies[f - 1][b];
        flux[f] = d > 0 ? d : 0;
      }
      var lastT = -1;
      for (f = 1; f < n; f++) {
        if (flux[f] <= 0) continue;
        // 局部极大
        var isMax = true;
        for (var m = -localMax; m <= localMax; m++) {
          var fi = f + m;
          if (m !== 0 && fi >= 0 && fi < n && flux[fi] > flux[f]) { isMax = false; break; }
        }
        if (!isMax) continue;
        // 自适应阈值：mean + 1.5σ（窗内）
        var lo = Math.max(0, f - win), hi = Math.min(n, f + win + 1);
        var mean = 0, cnt = hi - lo;
        for (var w = lo; w < hi; w++) mean += flux[w];
        mean /= cnt;
        var varr = 0;
        for (w = lo; w < hi; w++) { var dv = flux[w] - mean; varr += dv * dv; }
        var thr = mean + 1.5 * Math.sqrt(varr / cnt);
        if (flux[f] < thr || flux[f] <= 0) continue;
        var t = f * hopSec;
        if (t - lastT < 0.05) continue;     // 每频段最小间隔 50ms
        lastT = t;
        onsets.push({ t: t, band: b, s: flux[f] / (thr || 1e-12) });
      }
    }
    onsets.sort(function (a, c) { return a.t - c.t; });
    if (onsets.length < 8) { console.warn('[Chart] 放弃：onset 太少 n=' + onsets.length); return null; }
    if (onProgress) { try { onProgress(0.9); } catch (e) {} }

    /* --- ② BPM：低+中频 onset 的 IOI 直方图（折叠到 [minBpm, maxBpm]） --- */
    var lowMid = onsets.filter(function (o) { return o.band <= 1; });
    var iois = [];
    for (var i = 1; i < lowMid.length; i++) {
      var d2 = lowMid[i].t - lowMid[i - 1].t;
      if (d2 >= 0.12 && d2 <= 1.6) iois.push(d2);
    }
    if (iois.length < 4) { console.warn('[Chart] 放弃：有效间隔样本不足 n=' + iois.length); return null; }
    var hist = {};
    var bestBpm = 0, bestW = 0;
    for (i = 0; i < iois.length; i++) {
      var bpm = 60 / iois[i];
      while (bpm > maxBpm) bpm /= 2;
      while (bpm < minBpm) bpm *= 2;
      var key = Math.round(bpm * 2) / 2;    // 0.5 BPM 栅格
      hist[key] = (hist[key] || 0) + 1;
      var kLo = Math.round((key - 1) * 2) / 2, kHi = Math.round((key + 1) * 2) / 2;
      hist[kLo] = (hist[kLo] || 0) + 0.5;
      hist[kHi] = (hist[kHi] || 0) + 0.5;
    }
    for (var hk in hist) {
      if (hist.hasOwnProperty(hk) && hist[hk] > bestW) { bestW = hist[hk]; bestBpm = parseFloat(hk); }
    }
    if (!bestBpm) { console.warn('[Chart] 放弃：BPM 直方图无主峰'); return null; }

    // 半/双倍纠偏：优先靠近 120 的八度（流行乐先验，cascade-rhythm 同款做法）
    var oct = bestBpm;
    while (oct * 2 <= maxBpm && Math.abs(oct * 2 - 120) < Math.abs(oct - 120)) oct *= 2;
    while (oct / 2 >= minBpm && Math.abs(oct / 2 - 120) < Math.abs(oct - 120)) oct /= 2;
    bestBpm = oct;

    /* --- ③ BPM 精化 + 相位：梳状对齐（先粗相位，再 ±5% 搜 BPM，消除累计漂移） --- */
    function combScore(bpmC) {
      var beatC = 60 / bpmC;
      var bestOffC = 0, bestSc = -1;
      for (var offC = 0; offC < beatC; offC += 0.005) {
        var sc = 0;
        for (var i2 = 0; i2 < lowMid.length; i2++) {
          var ph = ((lowMid[i2].t - offC) % beatC + beatC) % beatC;
          var err = Math.min(ph, beatC - ph);  // 距最近拍点
          if (err < 0.05) sc += lowMid[i2].s * (1 - err / 0.05);
        }
        if (sc > bestSc) { bestSc = sc; bestOffC = offC; }
      }
      return { score: bestSc, off: bestOffC };
    }
    var ref = combScore(bestBpm);
    var refinedBpm = bestBpm, refinedOff = ref.off, refinedScore = ref.score;
    for (var cand = bestBpm * 0.95; cand <= bestBpm * 1.051; cand += bestBpm * 0.002) {
      var rc = combScore(cand);
      if (rc.score > refinedScore * 1.02) { refinedScore = rc.score; refinedBpm = cand; refinedOff = rc.off; }
    }
    bestBpm = Math.round(refinedBpm * 10) / 10;
    var beat = 60 / bestBpm;
    var step = beat / 4;
    var bestOff = refinedOff;
    if (refinedScore <= 0) { console.warn('[Chart] 放弃：相位梳状对齐得分 0'); return null; }

    /* --- ④ 网格量化：onset 吸附到 16 分槽，取各槽各频段最大强度 --- */
    var dur = audioBuffer.duration;
    var nSlots = Math.min(20000, Math.ceil((dur + beat) / step) + 4);
    var slotS = new Float32Array(nSlots);   // 综合强度
    var slotBand = new Int8Array(nSlots);   // 主导频段
    var slotBandS = [new Float32Array(nSlots), new Float32Array(nSlots), new Float32Array(nSlots)];
    for (i = 0; i < onsets.length; i++) {
      var o = onsets[i];
      var si = Math.round((o.t - bestOff) / step);
      if (si < 0 || si >= nSlots) continue;
      if (Math.abs(o.t - (bestOff + si * step)) > step * 0.42) continue;  // 离网格太远：自由节奏，不吸附
      slotBandS[o.band][si] = Math.max(slotBandS[o.band][si], o.s);
      if (o.s > slotS[si]) { slotS[si] = o.s; slotBand[si] = o.band; }
    }

    /* --- ⑤ 强度阈值（分位）--- */
    var present = [];
    for (i = 0; i < nSlots; i++) if (slotS[i] > 0) present.push(slotS[i]);
    if (present.length < 6) { console.warn('[Chart] 放弃：网格能量槽过少 n=' + present.length); return null; }
    present.sort(function (a, c) { return a - c; });
    var q = function (p) { return present[Math.floor(p * (present.length - 1))]; };
    var thrEasy = q(0.60), thrNorm = q(0.35), thrHard = q(0.12);

    var notes = {
      easy: this._pick(slotS, slotBand, slotBandS, thrEasy, 0.40, step, bestOff, nSlots, false),
      normal: this._pick(slotS, slotBand, slotBandS, thrNorm, 0.20, step, bestOff, nSlots, false),
      hard: this._pick(slotS, slotBand, slotBandS, thrHard, 0.12, step, bestOff, nSlots, true)
    };
    if (!notes.normal.length) { console.warn('[Chart] 放弃：标准难度无音符'); return null; }
    if (onProgress) { try { onProgress(1); } catch (e) {} }

    try {
      console.info('[Chart] 全曲分析完成 bpm=' + (Math.round(bestBpm * 10) / 10)
        + ' offset=' + bestOff.toFixed(3) + 's onsets=' + onsets.length
        + ' notes(e/n/h)=' + notes.easy.length + '/' + notes.normal.length + '/' + notes.hard.length);
    } catch (e) {}

    return {
      v: 2,
      bpm: Math.round(bestBpm * 10) / 10,
      offset: Math.round(bestOff * 1000) / 1000,
      dur: Math.round(dur * 10) / 10,
      notes: notes,
      meta: { onsets: onsets.length, frames: n, sr: audioBuffer.sampleRate }
    };
  };

  /**
   * 从量化槽选 note（zone 版，v2 谱面）。
   * zone 布局（与 gridLayer.zoneRect 一致）：0=Q左上 1=W右上 2=E左下 3=R右下。
   * 高频→上排、低频→下排、中频交替上下（借鉴 osu!mania 频段→轨道映射），
   * 同排内按步位奇偶分左右，并防同 zone 连发；双押必落不同 zone。
   * thr: 强度阈值；minGap: 最小间隔（秒）；chord: 高难度双押。
   */
  ChartBuilderCtor.prototype._pick = function (slotS, slotBand, slotBandS, thr, minGap, step, off, nSlots, chord) {
    var picked = [];
    var lastT = -99, lastZone = -1, lastTop = false;
    for (var si = 0; si < nSlots; si++) {
      var s = slotS[si];
      if (s < thr) continue;
      var t = off + si * step;
      if (t < 0.4) continue;                       // 跳过前奏空白
      if (t - lastT < minGap) continue;            // 密度上限
      var band = slotBand[si];
      var top;
      if (band === 2) top = true;                  // 高频 → 上排（Q/W）
      else if (band === 0) top = false;            // 低频 → 下排（E/R）
      else { lastTop = !lastTop; top = lastTop; }  // 中频交替上下，走出走向
      var zone = (top ? 0 : 2) + (si % 2 ? 1 : 0); // 步位奇偶分左右
      if (zone === lastZone) zone = (top ? 0 : 2) + (si % 2 ? 0 : 1);
      picked.push({ t: Math.round(t * 1000) / 1000, zone: zone, s: Math.round(s * 100) / 100 });
      lastT = t; lastZone = zone;
      // 双押：次强频段 ≥ 主导 50% 时，另一排加一颗（仅激烈；必不同 zone）
      if (chord) {
        var b2 = -1, s2 = 0;
        for (var b = 0; b < 3; b++) {
          if (b !== band && slotBandS[b][si] > s2) { s2 = slotBandS[b][si]; b2 = b; }
        }
        if (b2 >= 0 && s2 >= s * 0.5 && s2 >= thr) {
          var zone2 = top ? 2 + (si % 2 ? 0 : 1) : (si % 2 ? 0 : 1);
          if (zone2 !== zone) {
            picked.push({ t: Math.round(t * 1000) / 1000, zone: zone2, s: Math.round(s2 * 100) / 100 });
          }
        }
      }
    }
    picked.sort(function (a, c) { return a.t - c.t; });
    return picked;
  };

  /* ---------------- 谱面缓存（localStorage，key: uta.chart.<id>） ---------------- */

  ChartBuilderCtor.prototype.saveCached = function (songId, chart) {
    if (!songId || !chart) return false;
    try {
      var slim = {
        v: chart.v, bpm: chart.bpm, offset: chart.offset, dur: chart.dur,
        notes: chart.notes, meta: { onsets: chart.meta.onsets }
      };
      global.localStorage.setItem('uta.chart.' + songId, JSON.stringify(slim));
      return true;
    } catch (e) { return false; }
  };

  ChartBuilderCtor.prototype.loadCached = function (songId) {
    if (!songId) return null;
    try {
      var raw = global.localStorage.getItem('uta.chart.' + songId);
      if (!raw) return null;
      var chart = JSON.parse(raw);
      if (!chart || chart.v !== 2 || !chart.notes || !chart.notes.normal || !chart.notes.normal.length) return null;
      return chart;
    } catch (e) { return null; }
  };

  /* ---------------- 测试辅助：合成节拍 AudioBuffer ---------------- */
  // 生成 44100Hz 单声道 buffer：kick（60Hz 衰减正弦）每拍 + snare（噪声）2/4 拍 + hihat 每 8 分
  ChartBuilderCtor.prototype.synthTestBuffer = function (bpm, duration, ctx) {
    bpm = bpm || 120;
    duration = duration || 24;
    var sr = 44100;
    var len = Math.floor(sr * duration);
    // 直接构造 AudioBuffer：走 OfflineAudioContext 避免 Safari 差异
    var OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    var oc = new OAC(1, len, sr);
    var out = oc.createBuffer(1, len, sr);
    var d = out.getChannelData(0);
    var beat = 60 / bpm;
    var t = 0, idx = 0;
    function kick(at) {
      var s0 = Math.floor(at * sr);
      for (var i = 0; i < Math.floor(0.16 * sr); i++) {
        var p = (s0 + i) < len ? (s0 + i) : len - 1;
        d[p] += Math.sin(2 * Math.PI * 58 * i / sr) * Math.exp(-i / (sr * 0.035)) * 0.9;
      }
    }
    function snare(at) {
      var s0 = Math.floor(at * sr);
      for (var i = 0; i < Math.floor(0.1 * sr); i++) {
        var p = (s0 + i) < len ? (s0 + i) : len - 1;
        d[p] += (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.02)) * 0.45;
      }
    }
    function hat(at) {
      var s0 = Math.floor(at * sr);
      for (var i = 0; i < Math.floor(0.03 * sr); i++) {
        var p = (s0 + i) < len ? (s0 + i) : len - 1;
        d[p] += (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.006)) * 0.25;
      }
    }
    while (t < duration - 0.5) {
      kick(t);
      if (idx % 2 === 1) snare(t);
      for (var e = 0; e < 2; e++) {
        var ht = t + e * beat / 2;
        if (ht < duration - 0.5) hat(ht);
      }
      t += beat; idx++;
    }
    return out;
  };

  global.ChartBuilder = new ChartBuilderCtor();
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * beatGrid.js — 歌曲 / BGM 的 16 分音符节拍网格
 * ============================================================
 * 纯 ES5，挂 window.BeatGrid。
 * - 在已有音频图上取 30–160Hz 能量做 spectral flux onset 检测
 * - 最近 8 秒 onset 做间隔直方图 + 自相关，折叠到 70–180 BPM
 * - PLL 用 onset 误差 × 0.12 修正 anchor
 * - 输出 { bpm, anchor, stepDur }，置信不足时 bpm = null
 *
 * 时间基准由调用方注入（歌曲用 audio.currentTime，BGM 用 ctx.currentTime），
 * 这样暂停 / 恢复不会让相位漂移。
 */
(function (global) {
  'use strict';

  var MIN_BPM = 70;
  var MAX_BPM = 180;
  var WINDOW_SEC = 8;
  var ONSET_COOLDOWN = 0.12;
  var MIN_ONSETS = 6;
  var MIN_CONFIDENCE = 0.24;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function BeatGrid(opts) {
    opts = opts || {};
    this._ctx = null;
    this._analyser = null;
    this._data = null;
    this._timeSource = null;

    this._binHz = 1;
    this._lowBin = 1;
    this._highBin = 8;

    this._prevEnergy = 0;
    this._flux = [];
    this._winSize = 43; // 约 1 秒（60fps）
    this._lastOnset = -999;
    this._onsets = [];

    this._bpm = null;
    this._anchor = 0;
    this._stepDur = 0;
    this._confident = false;
    this._cached = false;
    this._pendingBpm = null;
    this._pendingCount = 0;
    this._lastNotifyBpm = null;

    this._running = false;
    this._raf = 0;

    this._onTempo = opts.onTempo || null;
  }

  /**
   * 绑定音频图。analyser 为 null 时只作为纯相位网格使用（BGM 模式）。
   */
  BeatGrid.prototype.attach = function (ctx, analyser, timeSource) {
    this._ctx = ctx || null;
    this._analyser = analyser || null;
    this._timeSource = timeSource || null;
    if (this._ctx && this._analyser) {
      this._analyser.fftSize = 2048;
      this._analyser.smoothingTimeConstant = 0.15;
      this._data = new Float32Array(this._analyser.frequencyBinCount);
      this._binHz = this._ctx.sampleRate / this._analyser.fftSize;
      this._lowBin = Math.max(1, Math.floor(30 / this._binHz));
      this._highBin = Math.min(this._analyser.frequencyBinCount - 1, Math.ceil(160 / this._binHz));
    }
  };

  BeatGrid.prototype._now = function () {
    if (this._timeSource) return this._timeSource();
    return this._ctx ? this._ctx.currentTime : 0;
  };

  BeatGrid.prototype.start = function () {
    if (this._running || !this._analyser || !this._ctx) return;
    this._running = true;
    var self = this;
    function loop() {
      if (!self._running) return;
      self._analyse();
      self._raf = global.requestAnimationFrame(loop);
    }
    this._raf = global.requestAnimationFrame(loop);
  };

  BeatGrid.prototype.stop = function () {
    this._running = false;
    if (this._raf) global.cancelAnimationFrame(this._raf);
    this._raf = 0;
  };

  BeatGrid.prototype.isRunning = function () { return this._running; };
  BeatGrid.prototype.isConfident = function () { return !!(this._confident && this._bpm); };
  BeatGrid.prototype.isCached = function () { return !!this._cached; };

  BeatGrid.prototype.setCached = function (cached) {
    this._cached = !!cached;
    // 缓存命中只跳过 BPM 估计；相位校正仍需持续运行（不 stop）
  };

  BeatGrid.prototype._analyse = function () {
    if (!this._ctx || !this._analyser || !this._data) return;
    if (this._ctx.state !== 'running') return;

    this._analyser.getFloatFrequencyData(this._data);
    var energy = 0;
    var count = 0;
    for (var i = this._lowBin; i <= this._highBin; i++) {
      var db = this._data[i];
      if (!isFinite(db)) continue;
      energy += Math.pow(10, db / 20);
      count++;
    }
    if (count) energy /= count;

    var flux = energy - this._prevEnergy;
    if (flux < 0) flux = 0;
    this._prevEnergy = energy;

    this._flux.push(flux);
    if (this._flux.length > this._winSize) this._flux.shift();

    var n = this._flux.length;
    var mean = 0;
    var j;
    for (j = 0; j < n; j++) mean += this._flux[j];
    mean /= n;
    var variance = 0;
    for (j = 0; j < n; j++) {
      var diff = this._flux[j] - mean;
      variance += diff * diff;
    }
    variance /= n;
    var threshold = mean + 1.5 * Math.sqrt(variance);

    var now = this._now();
    if (n > 8 && flux > threshold && flux > 1e-7 && (now - this._lastOnset) > ONSET_COOLDOWN) {
      this._registerOnset(now, flux);
    }
  };

  BeatGrid.prototype._prune = function (now) {
    while (this._onsets.length && now - this._onsets[0].t > WINDOW_SEC) this._onsets.shift();
  };

  BeatGrid.prototype._registerOnset = function (t, strength) {
    this._lastOnset = t;
    this._onsets.push({ t: t, s: strength });
    this._prune(t);

    // 缓存命中：跳过 BPM 估计，仅做相位校正，让 PLL 继续收敛
    if (this._cached) {
      if (this._confident) this._correctPhase(t);
      return;
    }

    var info = this._estimate();
    if (info) {
      if (!this._confident) {
        this._bpm = info.bpm;
        this._stepDur = 60 / this._bpm / 4;
        this._anchor = t;
        this._confident = true;
      } else if (Math.abs(info.bpm - this._bpm) <= 3) {
        this._pendingBpm = null;
        this._pendingCount = 0;
        this._bpm = this._bpm * 0.85 + info.bpm * 0.15;
        this._stepDur = 60 / this._bpm / 4;
      } else {
        if (this._pendingBpm && Math.abs(info.bpm - this._pendingBpm) < 3) this._pendingCount++;
        else { this._pendingBpm = info.bpm; this._pendingCount = 1; }
        if (this._pendingCount >= 3) {
          this._bpm = info.bpm;
          this._stepDur = 60 / info.bpm / 4;
          this._pendingBpm = null;
          this._pendingCount = 0;
          this._confident = true;
        }
      }
    }

    if (this._confident) {
      this._correctPhase(t);
      this._notifyTempo();
    }
  };

  /** PLL：把检测到的 onset 与预测拍点的误差收回 12% */
  BeatGrid.prototype._correctPhase = function (onset) {
    var beatDur = this._stepDur * 4;
    if (!beatDur) return;
    var n = Math.round((onset - this._anchor) / beatDur);
    var err = onset - (this._anchor + n * beatDur);
    this._anchor += err * 0.12;
  };

  BeatGrid.prototype._estimate = function () {
    if (this._onsets.length < MIN_ONSETS) return null;

    var i;
    var iois = [];
    for (i = 1; i < this._onsets.length; i++) {
      var d = this._onsets[i].t - this._onsets[i - 1].t;
      if (d >= 0.12 && d <= 1.6) iois.push(d);
    }
    if (iois.length < 4) return null;

    // 1) 间隔直方图（折叠到 70–180）
    var hist = [];
    for (i = 0; i <= MAX_BPM; i++) hist.push(0);
    var total = 0;
    for (i = 0; i < iois.length; i++) {
      var bpm = 60 / iois[i];
      while (bpm > MAX_BPM) bpm /= 2;
      while (bpm < MIN_BPM) bpm *= 2;
      var idx = Math.round(bpm);
      if (idx < MIN_BPM || idx > MAX_BPM) continue;
      hist[idx] += 1;
      if (idx > MIN_BPM) hist[idx - 1] += 0.5;
      if (idx < MAX_BPM) hist[idx + 1] += 0.5;
      total += 1;
    }
    var bestBpm = 0;
    var bestW = 0;
    for (i = MIN_BPM; i <= MAX_BPM; i++) {
      if (hist[i] > bestW) { bestW = hist[i]; bestBpm = i; }
    }
    var confH = total ? bestW / (total * 2) : 0;

    // 2) onset 对自相关：只统计落在 lag±50ms 窗口内的成对脉冲，
    //    避免稀疏脉冲串在长 lag 上产生虚高分数。
    var bestBpmA = 0;
    var bestScoreA = 0;
    var tolerance = 0.03;
    var onsets = this._onsets;
    for (var lag = 0.2; lag <= 1.2; lag += 0.01) {
      var matches = 0;
      var possible = 0;
      var matchSum = 0;
      for (i = 0; i < onsets.length; i++) {
        for (var j = i + 1; j < onsets.length; j++) {
          var diff = onsets[j].t - onsets[i].t;
          if (diff < lag - 0.05) continue;
          if (diff > lag + 0.05) break;
          possible++;
          if (Math.abs(diff - lag) <= tolerance) {
            matches++;
            matchSum += diff;
          }
        }
      }
      if (possible >= 4 && matches >= 3) {
        var score = matches / possible;
        if (score > bestScoreA) {
          bestScoreA = score;
          // 用匹配对的实际间隔均值，避免 10ms 栅格带来的 BPM 误差
          bestBpmA = 60 / (matchSum / matches);
        }
      }
    }
    if (bestBpmA) {
      while (bestBpmA > MAX_BPM) bestBpmA /= 2;
      while (bestBpmA < MIN_BPM) bestBpmA *= 2;
    }

    var bpmOut = bestBpm;
    var conf = confH;
    if (bestBpmA && bestScoreA > confH) {
      bpmOut = bestBpmA;
      conf = bestScoreA;
    }
    // 两种方法接近时提高置信度
    if (bestBpmA && Math.abs(bestBpmA - bestBpm) <= 4) {
      conf = Math.min(1, conf + 0.1);
    }
    if (!bpmOut || conf < MIN_CONFIDENCE) return null;
    return { bpm: bpmOut, confidence: conf };
  };

  BeatGrid.prototype._notifyTempo = function () {
    if (!this._onTempo || !this._bpm) return;
    if (this._lastNotifyBpm != null && Math.abs(this._bpm - this._lastNotifyBpm) < 0.6) return;
    this._lastNotifyBpm = this._bpm;
    try { this._onTempo(this._bpm, this._anchor); } catch (e) {}
  };

  /** 直接设定网格（BGM 模式 / 缓存命中） */
  BeatGrid.prototype.setTempo = function (bpm, anchor, confident) {
    if (!bpm || bpm <= 0) return;
    this._bpm = clamp(bpm, MIN_BPM, MAX_BPM);
    this._stepDur = 60 / this._bpm / 4;
    this._anchor = anchor || 0;
    this._confident = confident !== false;
  };

  BeatGrid.prototype.getAnchor = function () { return this._anchor; };

  /** 最近 8 秒 onset 列表副本（音游模式在线预判的步位学习用） */
  BeatGrid.prototype.getOnsets = function () {
    return this._onsets.slice();
  };

  /** 清空分析状态（换歌） */
  BeatGrid.prototype.reset = function () {
    this.stop();
    this._prevEnergy = 0;
    this._flux.length = 0;
    this._onsets.length = 0;
    this._lastOnset = -999;
    this._bpm = null;
    this._anchor = 0;
    this._stepDur = 0;
    this._confident = false;
    this._cached = false;
    this._pendingBpm = null;
    this._pendingCount = 0;
    this._lastNotifyBpm = null;
  };

  /** 跳转后重置检测；缓存网格保持原来的相位基准 */
  BeatGrid.prototype.reanchor = function (t) {
    if (this._cached) {
      this._onsets.length = 0;
      this._flux.length = 0;
      this._prevEnergy = 0;
      this._lastOnset = t - 1;
      return;
    }
    this._anchor = t;
    this._onsets.length = 0;
    this._flux.length = 0;
    this._prevEnergy = 0;
    this._lastOnset = t - 1;
    this._confident = false;
  };

  /**
   * 到下一个 16 分音符还有多久（永远为正，向前吸附，不往回拉）。
   * 下一格太远（> maxWait）时返回 null，让调用方立即响，保证触感。
   */
  BeatGrid.prototype.getStepDelay = function (maxWait) {
    if (!this.isConfident() || !this._stepDur) return null;
    var now = this._now();
    var phase = ((now - this._anchor) % this._stepDur + this._stepDur) % this._stepDur;
    var toNext = this._stepDur - phase; // 0 < toNext <= stepDur
    var limit = maxWait == null ? 0.07 : maxWait;
    if (toNext > limit) return null;
    return toNext;
  };

  BeatGrid.prototype.getState = function () {
    var now = this._now();
    var st = this._state;
    if (!st) st = this._state = {};
    var phase = 0;
    var stepIndex = 0;
    var sinceStep = 0;
    if (this._stepDur) {
      phase = ((now - this._anchor) % this._stepDur + this._stepDur) % this._stepDur;
      stepIndex = Math.floor((now - this._anchor) / this._stepDur);
      sinceStep = now - (this._anchor + stepIndex * this._stepDur);
    }
    st.bpm = this._bpm;
    st.anchor = this._anchor;
    st.stepDur = this._stepDur;
    st.confident = this.isConfident();
    st.cached = this._cached;
    st.phase = phase;
    st.stepIndex = stepIndex;
    st.sinceStep = sinceStep;
    return st;
  };

  global.BeatGrid = BeatGrid;
})(typeof window !== 'undefined' ? window : globalThis);

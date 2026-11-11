/**
 * rhythmGame.js — 音游模式（节奏挑战）引擎与「先缓存再铺面」编排
 * ====================================================================
 * 纯 ES5，挂 window.RhythmGame（单例）。
 *
 * 状态机：
 *   idle ──(音游模式+选歌)──> caching ──> charting ──> active（完整谱面）
 *                              │  失败/离线/超时
 *                              └──────> online（实时预判降级）
 *   任意 ──(切回自由)──> idle
 *
 * 「先缓存再铺面」流程（handleTrack）：
 *   1. 谱面缓存命中（uta.chart.<id>）→ 直接播放，秒进 active；
 *   2. 否则完整缓存歌曲音频（Cache API 持久 + 进度回调）→「正在铺面中」
 *      → decodeAudioData → ChartBuilder.analyze 全曲分析 → 保存谱面 →
 *      用缓存的 blob 直接开播（不重复下载）；
 *   3. 任一环节失败（离线 / CORS / 解码失败 / 分析无果 / 超时 25s）→
 *      自动降级 online：正常流播放 + BeatGrid 步位直方图实时预判。
 *
 * 判定：媒体时钟（audio.currentTime + performance.now 外推；预卷期为负值外推），
 *   PERFECT/GREAT/GOOD/MISS 四档，难度分档毫秒窗，偏移可调（默认 -20ms）。
 * 音符只落在中心 2×2 四分区（Q/W/E/R），同屏最多 2 个提示；
 * 过期未显示的 note 直接丢弃不计 MISS，过期显示过的当帧判 MISS 出队（不积压）。
 */
(function (global) {
  'use strict';

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ---------------- 常量 ---------------- */

  // 判定窗口（ms）：tap 时刻相对 note.t 的误差绝对值
  var WINDOWS = {
    easy: { perfect: 70, great: 120, good: 180 },
    normal: { perfect: 50, great: 90, good: 140 },
    hard: { perfect: 35, great: 70, good: 110 }
  };
  var DIFF_NAME = { easy: '轻松', normal: '标准', hard: '激烈' };
  // 在线预判：16 步位直方图保留的最强步位类数（1/4 拍 = 4 步一类）
  var ONLINE_TOPK = { easy: 2, normal: 4, hard: 6 };
  var ONLINE_MIN_GAP = { easy: 0.40, normal: 0.20, hard: 0.12 };  // 秒
  var FETCH_TIMEOUT = 25000;   // 缓存+铺面总超时
  var STALL_TIMEOUT = 8000;    // 下载停滞超时

  var JUDGE_TEXT = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', miss: 'MISS' };
  var JUDGE_COLOR = { perfect: 0xffd75e, great: 0x7fe8ff, good: 0x9ad1ff, miss: 0x8a8a96 };
  // 同屏未判定提示上限（新手反馈：上一拍还没敲完就派下一个会很乱）：
  // 轻松/标准 = 同一时刻只有 1 个待敲 note，激烈 = 最多 2（osu!mania 和弦共识内）
  var MAX_SHOWN = { easy: 1, normal: 1, hard: 2 };

  /* ---------------- 日志 ----------------
   * 统一前缀 [Rhythm]，一眼看出走的是哪条路径：
   *   路径=离线铺面（完整缓存 + 全曲分析）
   *   路径=离线·谱面缓存（二次播放，秒开）
   *   路径=实时预判（降级，含原因）
   * 同时写进环形缓冲，RhythmGame.logs() 可取最近 100 条。 */
  var LOG_BUF = [];
  function rlog(tag, msg, extra) {
    var line = '[Rhythm] ' + tag + ' ' + msg;
    if (extra !== undefined) {
      try { line += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch (e) {}
    }
    LOG_BUF.push(line);
    if (LOG_BUF.length > 100) LOG_BUF.shift();
    try { console.info(line); } catch (e) {}
  }

  /* ---------------- 引擎 ---------------- */

  function RhythmGameCtor() {
    this.mode = 'free';            // free | rhythm
    this.difficulty = 'normal';    // easy | normal | hard
    this.offsetMs = -20;           // 判定偏移（负=整体提前）
    this.lenient = false;          // 宽松判定：任意格子算命中
    this.beatAssist = true;        // 判定辅助：中心节拍脉冲（默认开，可在设置里关）
    this.phase = 'idle';           // idle | caching | charting | active | online
    this.degradeReason = '';

    this._deps = null;             // { netease, grid, playerCard, onStatus }
    this._clock = null;
    this._token = 0;               // 换歌令牌（与 playerCard._trackToken 对齐用自增）
    this._playBlobUrl = null;      // 缓存音频的 blob URL（复用播放，换歌后延迟释放）

    // 当前谱面
    this.chart = null;
    this.songId = null;
    this.notes = [];               // 当前难度的 note 列表（已排序，{t, zone, s}）
    this._nextIdx = 0;
    this._active = [];             // { note, judged }

    // 预卷（Audio Lead-In）：修开场提前点亮——视觉时钟从 -gap 起跑
    this._preRoll = null;          // { gap, t0 }
    this._preRollTimer = null;
    this._prerollGap = 0;
    this._firstNotePending = false;  // 在线模式：首个 note 必须在未来 ≥0.35s
    this._lastTop = false;

    // 在线预判状态
    this._stepHist = null;         // Float32Array(16) 步位权重
    this._bandHist = null;         // [3]Float32Array(16) 步位×频段权重
    this._histCount = 0;
    this._lastStepIdx = -1;
    this._lastNoteT = -99;
    this._schedFrom = 0;           // 已调度到的媒体时刻

    // 成绩
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.judgeCounts = { perfect: 0, great: 0, good: 0, miss: 0 };
    this.dropped = 0;              // 因同屏上限被丢弃的 note（从未显示，不计 MISS）
    this._resultShown = false;
    this._lastHud = '';

    this._loadPrefs();
  }

  /* ---------------- 偏好持久化 ---------------- */

  RhythmGameCtor.prototype._loadPrefs = function () {
    // 注意：演奏模式（free/rhythm）不持久化 —— 每次进入页面都默认「自由演奏」，
    // 只有难度 / 偏移 / 宽松判定这三项跟手偏好被记住。
    try {
      var d = global.localStorage.getItem('uta.rhythm.diff');
      if (WINDOWS[d]) this.difficulty = d;
      var o = parseFloat(global.localStorage.getItem('uta.rhythm.offset'));
      if (isFinite(o)) this.offsetMs = clamp(o, -200, 200);
      var l = global.localStorage.getItem('uta.rhythm.lenient');
      if (l === '1') this.lenient = true;
      var b = global.localStorage.getItem('uta.rhythm.beatpulse');
      if (b === '0') this.beatAssist = false;   // 未设置过 = 默认开
    } catch (e) {}
  };

  RhythmGameCtor.prototype._savePrefs = function () {
    try {
      global.localStorage.setItem('uta.rhythm.diff', this.difficulty);
      global.localStorage.setItem('uta.rhythm.offset', String(this.offsetMs));
      global.localStorage.setItem('uta.rhythm.lenient', this.lenient ? '1' : '0');
      global.localStorage.setItem('uta.rhythm.beatpulse', this.beatAssist ? '1' : '0');
    } catch (e) {}
  };

  /* ---------------- 状态与文案 ---------------- */

  RhythmGameCtor.prototype._status = function (text, sticky) {
    if (this._deps && this._deps.onStatus) {
      try { this._deps.onStatus(text, !!sticky); } catch (e) {}
    }
  };

  RhythmGameCtor.prototype.isActive = function () {
    return this.mode === 'rhythm' && (this.phase === 'active' || this.phase === 'online');
  };

  RhythmGameCtor.prototype.isRhythm = function () { return this.mode === 'rhythm'; };

  RhythmGameCtor.prototype.setMode = function (m) {
    if (m !== 'free' && m !== 'rhythm') m = 'free';
    if (m === this.mode) return;
    this.mode = m;
    this._savePrefs();
    if (m === 'free') {
      this._resetRound();
      this.phase = 'idle';
      this._status('');
    }
    // 切到 rhythm：若当前有歌在播，由 main.setTapMode 决定是否立即实时铺面
  };

  RhythmGameCtor.prototype.setDifficulty = function (d) {
    if (!WINDOWS[d]) d = 'normal';
    if (d === this.difficulty) return;
    this.difficulty = d;
    this._savePrefs();
    this._applyDifficulty();
  };

  RhythmGameCtor.prototype.setOffset = function (ms) {
    this.offsetMs = clamp(ms, -200, 200);
    this._savePrefs();
  };

  RhythmGameCtor.prototype.setLenient = function (v) {
    this.lenient = !!v;
    this._savePrefs();
  };

  /** 判定辅助（中心节拍脉冲）开关 */
  RhythmGameCtor.prototype.setBeatAssist = function (v) {
    this.beatAssist = !!v;
    this._savePrefs();
    if (!this.beatAssist) {
      var grid = this._deps && this._deps.grid;
      if (grid && grid.clearBeat) grid.clearBeat();
    }
  };

  /** 难度切换：active 状态下从新难度列表重建未判定部分 */
  RhythmGameCtor.prototype._applyDifficulty = function () {
    if (this.phase === 'active' && this.chart) {
      this._setNotes(this.chart.notes[this.difficulty] || []);
    }
  };

  /* ---------------- 初始化 ---------------- */

  RhythmGameCtor.prototype.init = function (deps) {
    this._deps = deps || {};
    var audio = this._deps.netease && this._deps.netease.audio;
    if (audio) {
      var self = this;
      audio.addEventListener('ended', function () { self._finish(); });
      // 新歌真正开播：此前旧歌可能还在播（铺面期间），旧时钟不能参与调度/判定。
      // 预卷也在此收尾：视觉时钟无缝切回媒体钟（note 锚定音频时间，判定精度不受损）。
      audio.addEventListener('play', function () {
        self._playStarted = true;
        if (self._preRoll) self._preRoll = null;
      });
    }
  };

  /** 媒体时钟：currentTime 阶梯更新 → performance.now 线性外推 */
  RhythmGameCtor.prototype._makeClock = function () {
    var audio = this._deps.netease.audio;
    var last = -1, ref = 0, tRef = 0;
    var self = this;
    return function () {
      var m = audio.currentTime;
      var t = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
      if (m !== last) { last = m; ref = m; tRef = t; return m; }
      if (audio.paused) return ref;
      return ref + (t - tRef) / 1000;
    };
  };

  /** 游戏时钟：预卷期为负值（performance 外推），开播后切媒体钟 */
  RhythmGameCtor.prototype.now = function () {
    if (this._preRoll) {
      var t = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
      return (t - this._preRoll.t0) / 1000 - this._preRoll.gap;
    }
    if (!this._deps || !this._deps.netease) return 0;
    if (!this._clock) this._clock = this._makeClock();
    return this._clock();
  };

  /* ================= 「先缓存再铺面」编排 ================= */

  /**
   * playerCard 选歌入口。返回 true 表示已接管（延迟开播）；
   * startPlayback(blobUrl|null) 由引擎在合适时机回调（blobUrl 为缓存命中时直接播）。
   */
  RhythmGameCtor.prototype.handleTrack = function (song, startPlayback) {
    if (this.mode !== 'rhythm') return false;
    var netease = this._deps && this._deps.netease;
    var CB = global.ChartBuilder;
    if (!netease || !CB) return false;

    var token = ++this._token;
    var self = this;
    var stale = function () { return token !== self._token; };
    var started = false;
    var t0 = Date.now();
    var blobUrl = null;                    // 缓存音频的 blob URL（铺面完成后直接播它）
    this.songId = song && song.id;         // 提前占位：期间重复的 onTrackChange 被忽略

    rlog('选歌', 'id=' + (song && song.id) + ' 「' + ((song && song.name) || '') + '」', { 难度: this.difficulty });

    function safeStart(blobUrl) {
      if (started || stale()) return;
      started = true;
      rlog('开播', blobUrl ? '源=本地 blob（缓存复用）' : '源=在线流', { phase: self.phase });
      try { startPlayback(blobUrl || null); } catch (e) {}
    }

    // 超时兜底：无论卡在哪一步，超时后降级在线模式开播
    var timeoutId = global.setTimeout(function () {
      if (stale() || started) return;
      rlog('超时', '缓存+铺面超过 ' + (FETCH_TIMEOUT / 1000) + 's');
      self._degrade('缓存超时');
      safeStart(null);
    }, FETCH_TIMEOUT);

    // ① 谱面缓存命中 → 秒进
    var cached = CB.loadCached(song.id);
    if (cached) {
      global.clearTimeout(timeoutId);
      this._beginChart(song, cached, null);
      this._status('谱面已就绪', false);
      rlog('路径=离线·谱面缓存命中', '秒开', {
        bpm: cached.bpm, notes: (cached.notes[this.difficulty] || []).length, onsets: cached.meta && cached.meta.onsets
      });
      var hideT = global.setTimeout(function () { if (!stale()) self._status(''); }, 1800);
      this._startWithPreroll(function () { safeStart(null); });
      return true;
    }

    rlog('路径=离线铺面', '谱面未缓存 → 完整缓存 + 全曲分析');

    // ② 完整缓存 → 离线铺面
    this.phase = 'caching';
    this._status('正在缓存歌曲… 0%');
    netease.fetchSongAudio(song, function (pct) {
      if (stale()) return;
      self._status('正在缓存歌曲… ' + pct + '%');
    }).then(function (res) {
      if (stale()) return;
      if (Date.now() - t0 > FETCH_TIMEOUT) throw new Error('timeout');
      rlog('缓存完成', '音频已完整下载', {
        MB: res && res.arrayBuffer ? +(res.arrayBuffer.byteLength / 1048576).toFixed(2) : 0,
        来源: res && res.fromCache ? 'Cache API 命中' : '网络下载',
        耗时: (Date.now() - t0) + 'ms'
      });
      // decodeAudioData 可能 detach ArrayBuffer，blob 必须在解码前建好（同步拷贝进 Blob）
      try {
        if (res.arrayBuffer && global.Blob && global.URL && global.URL.createObjectURL) {
          blobUrl = global.URL.createObjectURL(new Blob([res.arrayBuffer], { type: 'audio/mpeg' }));
        }
      } catch (e) { blobUrl = null; }
      self.phase = 'charting';
      self._status('正在铺面中… 0%');
      return netease.decodeArrayBuffer(res.arrayBuffer).then(function (audioBuffer) {
        if (stale()) return;
        rlog('解码完成', '时长=' + audioBuffer.duration.toFixed(1) + 's 采样率=' + audioBuffer.sampleRate);
        return CB.analyze(audioBuffer, null, function (p) {
          if (stale()) return;
          self._status('正在铺面中… ' + Math.round(p * 100) + '%');
        });
      });
    }).then(function (chart) {
      if (stale()) return;
      global.clearTimeout(timeoutId);
      if (!chart) throw new Error('no-chart');
      CB.saveCached(song.id, chart);
      var tAnalyze = Date.now() - t0;
      self._beginChart(song, chart, null);
      self._status('铺面完成！', false);
      rlog('路径=离线铺面 完成', '全曲谱面已生成并缓存', {
        bpm: chart.bpm, offset: chart.offset,
        notes: (chart.notes[self.difficulty] || []).length,
        onsets: chart.meta && chart.meta.onsets,
        总耗时: tAnalyze + 'ms'
      });
      global.setTimeout(function () { if (!stale()) self._status(''); }, 1500);
      // 用缓存音频的 blob 开播：不再二次下载，且缓存期内断网也能播
      var prevBlob = self._playBlobUrl;
      if (blobUrl) self._playBlobUrl = blobUrl;
      if (prevBlob && prevBlob !== blobUrl) {
        global.setTimeout(function () { try { global.URL.revokeObjectURL(prevBlob); } catch (e) {} }, 30000);
      }
      self._startWithPreroll(function () { safeStart(blobUrl); });
    }).catch(function (err) {
      if (blobUrl) { try { global.URL.revokeObjectURL(blobUrl); } catch (e) {} }
      if (stale() || started) { global.clearTimeout(timeoutId); return; }
      global.clearTimeout(timeoutId);
      rlog('路径=实时预判', '离线失败 → 降级', { 原因: String((err && err.message) || err) });
      self._degrade(String((err && err.message) || err));
      safeStart(null);
    });

    // 本地文件：audio 本地就有，直接读文件分析（不走网络）
    return true;
  };

  /** 本地文件版编排：file 已在本地，直接铺面（必然成功或降级） */
  RhythmGameCtor.prototype.handleLocalTrack = function (song, file, startPlayback) {
    if (this.mode !== 'rhythm') return false;
    var CB = global.ChartBuilder;
    var netease = this._deps && this._deps.netease;
    if (!CB || !netease) return false;
    var token = ++this._token;
    var self = this;
    var started = false;
    function safeStart() {
      if (started || token !== self._token) return;
      started = true;
      try { startPlayback(); } catch (e) {}
    }
    var cached = CB.loadCached(song.id);
    if (cached) {
      this._beginChart(song, cached, null);
      this._status('谱面已就绪');
      rlog('路径=离线·谱面缓存命中', '本地文件，秒开', { bpm: cached.bpm, notes: (cached.notes[this.difficulty] || []).length });
      global.setTimeout(function () { if (token === self._token) self._status(''); }, 1500);
      this._startWithPreroll(safeStart);
      return true;
    }
    this.phase = 'charting';
    this._status('正在铺面中… 0%');
    rlog('路径=离线铺面', '本地文件 → 直接全曲分析');
    file.arrayBuffer().then(function (ab) {
      if (token !== self._token) return;
      return netease.decodeArrayBuffer(ab).then(function (audioBuffer) {
        if (token !== self._token) return;
        return CB.analyze(audioBuffer, null, function (p) {
          if (token !== self._token) return;
          self._status('正在铺面中… ' + Math.round(p * 100) + '%');
        });
      });
    }).then(function (chart) {
      if (token !== self._token) return;
      if (!chart) throw new Error('no-chart');
      CB.saveCached(song.id, chart);
      self._beginChart(song, chart, null);
      self._status('铺面完成！');
      rlog('路径=离线铺面 完成', '本地文件谱面已生成', { bpm: chart.bpm, notes: (chart.notes[self.difficulty] || []).length });
      global.setTimeout(function () { if (token === self._token) self._status(''); }, 1500);
      self._startWithPreroll(safeStart);
    }).catch(function (err) {
      if (token !== self._token || started) return;
      rlog('路径=实时预判', '本地分析失败 → 降级', { 原因: String((err && err.message) || err) });
      self._degrade('本地分析失败');
      safeStart();
    });
    return true;
  };

  RhythmGameCtor.prototype._degrade = function (reason) {
    this.phase = 'online';
    this.degradeReason = reason;
    this._beginOnline();
    this._status('无法完整缓存（' + reason + '），已切换实时铺面', false);
    rlog('路径=实时预判 生效', '在线流 + BeatGrid 步位直方图', { 原因: reason });
    var self = this;
    global.setTimeout(function () { if (self.phase === 'online') self._status(''); }, 3500);
  };

  /* ---------------- 诊断 ----------------
   * 控制台：RhythmGame.debugInfo() 看当前走哪条路径
   *         RhythmGame.logs()      看整条流程日志 */
  RhythmGameCtor.prototype.debugInfo = function () {
    return {
      模式: this.mode,
      阶段: this.phase,                     // active=离线铺面 / online=实时预判
      路径: this.phase === 'active' ? '离线铺面（全曲谱面）'
        : this.phase === 'online' ? '实时预判（在线降级）'
          : this.phase === 'caching' ? '缓存中'
            : this.phase === 'charting' ? '铺面中' : '空闲',
      降级原因: this.degradeReason || null,
      曲目: this.songId,
      谱面: this.chart ? {
        bpm: this.chart.bpm, offset: this.chart.offset, dur: this.chart.dur,
        notes: (this.chart.notes[this.difficulty] || []).length,
        onsets: this.chart.meta && this.chart.meta.onsets
      } : null,
      当前音符: this.notes.length,
      同屏提示: this._active.filter(function (a) { return !a.judged; }).length,
      丢弃: this.dropped,
      分数: this.score, 连击: this.combo, 判定: this.judgeCounts
    };
  };
  RhythmGameCtor.prototype.logs = function () { return LOG_BUF.slice(); };

  /* ================= 局开始 / 结束 ================= */

  /**
   * 预卷开播（Audio Lead-In，osu! 同款思想）：视觉时钟从 -gap 起跑，
   * 光框从完整尺寸正常收缩；gap 秒后才让音频开播，note 与音乐的锚定不变。
   * 在线降级（流已在播，无法插静音）不做预卷，改用首个 note ≥0.35s 的调度约束。
   */
  RhythmGameCtor.prototype._startWithPreroll = function (startAudio) {
    var self = this;
    if (this._prerollGap > 0.05) {
      var gap = this._prerollGap;
      this._preRoll = {
        gap: gap,
        t0: (global.performance && global.performance.now) ? global.performance.now() : Date.now()
      };
      rlog('预卷', '开场前卷 ' + Math.round(gap * 1000) + 'ms（首 note 拿满 approach，修开场提前点亮）');
      this._preRollTimer = global.setTimeout(function () {
        self._preRollTimer = null;
        startAudio();               // _preRoll 由 audio 'play' 事件清除，时钟无缝切媒体钟
      }, gap * 1000);
    } else {
      startAudio();
    }
  };

  RhythmGameCtor.prototype._beginChart = function (song, chart, extra) {
    this.chart = chart;
    this.songId = song && song.id;
    this.phase = 'active';
    this._playStarted = false;               // 等 audio 'play' 事件确认新歌开播
    this.notes = (chart.notes[this.difficulty] || chart.notes.normal || []).slice();
    this._nextIdx = 0;
    this._active = [];
    this._resetRoundStats();
    // 预卷量：首 note 比 approach 早多少就前卷多少（+50ms 裕量），封顶 2s。
    // 首 note 晚于 approach 时几乎不需要预卷（note 本来就在开播后完整收缩）。
    var first = this.notes[0];
    this._prerollGap = first ? clamp(this._approach() - first.t + 0.05, 0, 2) : 0;
    this._setZoneGuides(true);
  };

  RhythmGameCtor.prototype._beginOnline = function () {
    this.chart = null;
    this.phase = 'online';
    this._playStarted = false;
    this._prerollGap = 0;                    // 流已在播：无法预卷，靠首 note ≥0.35s 约束
    this._stepHist = new Float32Array(16);
    this._bandHist = [new Float32Array(16), new Float32Array(16), new Float32Array(16)];
    this._histCount = 0;
    this._lastStepIdx = -1;
    this._lastNoteT = -99;
    this._schedFrom = -1;                    // 首次 tick 从当前时刻起调度
    this._active = [];
    this._firstNotePending = true;
    this._lastTop = false;
    this._resetRoundStats();
    this._setZoneGuides(true);
  };

  RhythmGameCtor.prototype._setNotes = function (notes) {
    var now = this.now();
    this.notes = notes.filter(function (n) { return n.t > now - 0.2; });
    this._nextIdx = 0;
    this._active = [];
  };

  RhythmGameCtor.prototype._resetRound = function () {
    if (this._preRollTimer) { global.clearTimeout(this._preRollTimer); this._preRollTimer = null; }
    this._preRoll = null;
    this._active = [];
    this.notes = [];
    this._nextIdx = 0;
    this._clearGridPreview();
    this._resetRoundStats();
  };

  RhythmGameCtor.prototype._resetRoundStats = function () {
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.judgeCounts = { perfect: 0, great: 0, good: 0, miss: 0 };
    this.dropped = 0;
    this._resultShown = false;
  };

  RhythmGameCtor.prototype._clearGridPreview = function () {
    var grid = this._deps && this._deps.grid;
    if (!grid) return;
    // 首选：一次性清空全部节奏视觉（含 glow 最后一帧——切回自由后 tick 停跑，
    // 不主动 clear 的话四分区框会永远滞留在画面上）
    if (grid.clearRhythmVisuals) { grid.clearRhythmVisuals(); return; }
    if (grid.clearPreview) grid.clearPreview();
    if (grid.clearZonePreview) grid.clearZonePreview();
    if (grid.setZoneGuides) grid.setZoneGuides(false);
  };

  RhythmGameCtor.prototype._setZoneGuides = function (on) {
    var grid = this._deps && this._deps.grid;
    if (grid && grid.setZoneGuides) grid.setZoneGuides(on);
  };

  /* ================= 每帧调度 ================= */

  RhythmGameCtor.prototype.tick = function () {
    if (this.mode !== 'rhythm') return;
    var now = this.now();
    var grid = this._deps && this._deps.grid;

    if (this.phase === 'active') this._tickChart(now);
    else if (this.phase === 'online') this._tickOnline(now);

    // 判定辅助：把当前拍位喂给视觉层（预卷期 now<0 不闪，避免无声拍点误导）
    if (grid && grid.setBeat) {
      var bi = (this.beatAssist && now >= 0) ? this._beatInfo(now) : null;
      if (bi) grid.setBeat(bi.phase, bi.down, this._accent());
      else if (grid.clearBeat) grid.clearBeat();
    }

    if (grid && grid.updatePreview) grid.updatePreview(now);

    // 结束检测（loop 关闭时走 ended 事件；loop 开着时靠进度）
    var audio = this._deps && this._deps.netease && this._deps.netease.audio;
    if (audio && audio.duration > 0 && !audio.paused && now >= audio.duration - 0.35) {
      this._finish();
    }
  };

  RhythmGameCtor.prototype._tickChart = function (now) {
    // 预卷期（时钟为负）照常调度：光框从完整尺寸收缩；
    // 旧歌未停且无预卷时（!_playStarted）不作数，防旧时钟污染。
    if (!this._playStarted && !this._preRoll) return;
    var win = WINDOWS[this.difficulty];
    var off = this.offsetMs / 1000;
    var goodSec = win.good / 1000;
    var approach = this._approach();

    // ① 先清过期：显示过的判 MISS 当帧出队（绝不积压延迟释放）
    this._expire(now, goodSec, off);

    // ② 再激活：同屏未判定 ≤ 上限（轻松/标准=1，激烈=2）；
    //    因上限被跳过且已过判定线的 note 直接丢弃（从未显示，不计 MISS）
    var maxShown = MAX_SHOWN[this.difficulty];
    var pending = 0, i;
    for (i = 0; i < this._active.length; i++) if (!this._active[i].judged) pending++;
    while (this._nextIdx < this.notes.length) {
      var n = this.notes[this._nextIdx];
      var nt = n.t + off;
      if (now > nt + goodSec) {
        this._nextIdx++;
        this.dropped++;
        continue;
      }
      if (pending >= maxShown) break;          // 显示上限：留在队列，宁丢不积压
      if (n.t - now <= approach) {
        this._active.push({ note: n, judged: false });
        pending++;
        this._nextIdx++;
        continue;
      }
      break;
    }

    // ③ 刷新提示光框（只画 approach 窗口内的）
    this._drawPreviews(now, approach, off);
  };

  RhythmGameCtor.prototype._tickOnline = function (now) {
    if (!this._playStarted) return;          // 新歌未开播：不学习不调度
    var netease = this._deps.netease;
    var grid = netease && netease.beatGrid;
    if (!grid || !grid.isConfident()) return;   // 网格未置信：挂起（不惩罚）
    var st = grid.getState();
    if (!st.stepDur) return;

    // ① 步位直方图学习：新 onset 落入哪个 16 分步位
    var onsets = grid.getOnsets ? grid.getOnsets() : [];
    for (var i = 0; i < onsets.length; i++) {
      var o = onsets[i];
      if (o._seen) continue;
      o._seen = true;
      var si = Math.round((o.t - st.anchor) / st.stepDur);
      var cls = ((si % 16) + 16) % 16;
      this._stepHist[cls] += (o.s || 1);
      if (o.band !== undefined) this._bandHist[clamp(o.band, 0, 2)][cls] += (o.s || 1);
      else this._bandHist[1][cls] += (o.s || 1) * 0.5;   // BeatGrid 只测低频：算中频半票
      this._histCount++;
    }

    if (this._histCount < 6) return;            // 学习样本不足：先不出 note

    var win = WINDOWS[this.difficulty];
    var goodSec = win.good / 1000;
    var off = this.offsetMs / 1000;

    // ② 先清过期（与离线路径同款：当帧出队，不积压）
    this._expire(now, goodSec, off);
    var pending = 0;
    for (i = 0; i < this._active.length; i++) if (!this._active[i].judged) pending++;

    // ③ 取最强 K 个步位类
    var order = [];
    for (var c = 0; c < 16; c++) order.push([c, this._stepHist[c]]);
    order.sort(function (a, b) { return b[1] - a[1]; });
    var topK = ONLINE_TOPK[this.difficulty];
    var okClass = {};
    var maxW = order[0][1] || 1;
    for (c = 0; c < 16; c++) okClass[c] = false;
    for (c = 0; c < Math.min(topK, order.length); c++) okClass[order[c][0]] = true;

    // ④ 前瞻调度：schedFrom → now+approach 内，符合步位类的网格点出 note
    var approachSec = this._approach();
    var horizon = now + approachSec;
    var stepDur = st.stepDur;
    var minGap = ONLINE_MIN_GAP[this.difficulty];
    var step = Math.max(this._schedFrom, now - 0.1);
    var k = Math.ceil((step - st.anchor) / stepDur);
    var t = st.anchor + k * stepDur;
    var guard = 0;
    while (t <= horizon && guard++ < 128) {
      if (t > this._schedFrom && t - this._lastNoteT >= minGap) {
        var cls2 = ((k % 16) + 16) % 16;
        if (okClass[cls2] && this._stepHist[cls2] >= maxW * 0.25) {
          // 无预卷：首个 note 必须在未来 ≥0.35s，避免开场半路弹出
          if (!(this._firstNotePending && t - now < 0.35) && pending < MAX_SHOWN[this.difficulty]) {
            var band = 0;
            var bs = -1;
            for (var b = 0; b < 3; b++) {
              if (this._bandHist[b][cls2] > bs) { bs = this._bandHist[b][cls2]; band = b; }
            }
            var top;
            if (band === 2) top = true;                // 高频 → 上排（Q/W）
            else if (band === 0) top = false;           // 低频 → 下排（E/R）
            else { this._lastTop = !this._lastTop; top = this._lastTop; }
            var zone = (top ? 0 : 2) + (cls2 % 2 ? 1 : 0);
            this._active.push({ note: { t: t, zone: zone, s: 1 }, judged: false });
            this._lastNoteT = t;
            this._firstNotePending = false;
            pending++;
          }
        }
      }
      k++; t += stepDur;
    }
    this._schedFrom = horizon;
    this._drawPreviews(now, approachSec, off);
  };

  /** 过期清理：显示过而未敲的判 MISS 并当帧出队；已判定的直接移除（不保留尸体） */
  RhythmGameCtor.prototype._expire = function (now, goodSec, off) {
    for (var i = this._active.length - 1; i >= 0; i--) {
      var a = this._active[i];
      if (a.judged) { this._active.splice(i, 1); continue; }
      if (now > a.note.t + off + goodSec) {
        this._record('miss', a.note);
        this._active.splice(i, 1);
      }
    }
  };

  /** 提示光框刷新：只画 approach 窗口内、未判定的 note（≤ MAX_SHOWN 个） */
  RhythmGameCtor.prototype._drawPreviews = function (now, approach, off) {
    var grid = this._deps && this._deps.grid;
    if (!grid || !grid.zonePreview) return;
    var accent = (this._deps && this._deps.getAccent) ? this._accent() : 0x7fe8ff;
    for (var i = 0; i < this._active.length; i++) {
      var a = this._active[i];
      if (a.judged) continue;
      var nt = a.note.t + off;
      if (nt - now > approach) continue;      // 未进入 approach 窗口：不显示
      var progress = clamp(1 - (nt - now) / approach, 0, 1);
      grid.zonePreview(a.note.zone, progress, accent);
    }
  };

  /** approach（光框收缩时长）：轻松档比标准/激烈慢约 35%，给新手更多反应时间 */
  RhythmGameCtor.prototype._approach = function () {
    var bpm = (this.phase === 'active' && this.chart) ? this.chart.bpm : 120;
    var beat = 60 / clamp(bpm, 60, 200);
    var base = beat * 2;
    if (this.difficulty === 'easy') return clamp(base * 1.35, 0.8, 1.4);
    return clamp(base, 0.55, 1.1);
  };

  /**
   * 当前拍位（判定辅助的数据源）：phase 0~1（0 = 拍点），down = 小节首拍（每 4 拍一次）。
   * 离线谱面用 chart.bpm / chart.offset；在线降级用 BeatGrid 的锚点与 16 分步长（4 步 = 1 拍）。
   */
  RhythmGameCtor.prototype._beatInfo = function (now) {
    if (this.phase === 'active' && this.chart) {
      var beat = 60 / clamp(this.chart.bpm || 120, 40, 240);
      var t = now - (this.chart.offset || 0);
      var i = Math.floor(t / beat);
      return { phase: t / beat - i, down: ((i % 4) + 4) % 4 === 0 };
    }
    if (this.phase === 'online') {
      var bg = this._deps && this._deps.netease && this._deps.netease.beatGrid;
      if (!bg || !bg.isConfident || !bg.isConfident()) return null;
      var st = bg.getState();
      if (!st || !st.stepDur) return null;
      var beat2 = st.stepDur * 4;
      var t2 = now - st.anchor;
      var i2 = Math.floor(t2 / beat2);
      return { phase: t2 / beat2 - i2, down: ((i2 % 4) + 4) % 4 === 0 };
    }
    return null;
  };

  RhythmGameCtor.prototype._accent = function () {    if (this._deps && this._deps.getAccent) {
      try { return this._deps.getAccent(); } catch (e) {}
    }
    return 0x7fe8ff;
  };

  /* ================= 敲击判定 ================= */

  /**
   * 分区敲击（点击与 Q/W/E/R 键统一入口）。
   * zone: 0=Q左上 1=W右上 2=E左下 3=R右下。
   * 时间最近且同分区的 note 参与判定；窗口内没有任何 note → null（自由敲，不判）；
   * 敲错分区 → 该 note 判 MISS（声音照常，沙盒保留）。
   */
  RhythmGameCtor.prototype.tapZone = function (zone) {
    if (!this.isActive()) return null;
    // 每次按下都让上一条判定文字快速淡出（防重叠糊屏；新判定会立即替换它）
    var grid0 = this._deps && this._deps.grid;
    if (grid0 && grid0.fadeJudge) grid0.fadeJudge();
    var now = this.now();
    var win = WINDOWS[this.difficulty];
    var off = this.offsetMs / 1000;
    var goodSec = win.good / 1000;

    var best = null, bestAbs = Infinity, match = null, matchAbs = Infinity;
    for (var i = 0; i < this._active.length; i++) {
      var a = this._active[i];
      if (a.judged) continue;
      var d = Math.abs(now - (a.note.t + off));
      if (d > goodSec) continue;
      if (d < bestAbs) { bestAbs = d; best = a; }
      if (a.note.zone === zone && d < matchAbs) { matchAbs = d; match = a; }
    }
    var tgt = this.lenient ? (best || match) : (match || best);
    if (!tgt) return null;                          // 窗口内没有 note：自由敲

    var judge;
    if (!this.lenient && !match) {
      judge = 'miss';                               // 敲错分区：note 判 MISS
    } else {
      var abs = this.lenient ? bestAbs : matchAbs;
      if (abs <= win.perfect / 1000) judge = 'perfect';
      else if (abs <= win.great / 1000) judge = 'great';
      else judge = 'good';
    }
    tgt.judged = true;
    this._record(judge, tgt.note, now - (tgt.note.t + off));
    return { judge: judge, delta: Math.round((now - (tgt.note.t + off)) * 1000), zone: tgt.note.zone };
  };

  /** 画布坐标入口：命中四分区才算敲击（四区之外不判定，保沙盒自由） */
  RhythmGameCtor.prototype.onTap = function (x, y) {
    if (!this.isActive()) return null;
    var grid = this._deps && this._deps.grid;
    if (!grid || !grid.zoneAt) return null;
    var z = grid.zoneAt(x, y);
    if (z < 0) return null;
    return this.tapZone(z);
  };

  RhythmGameCtor.prototype._record = function (judge, note, delta) {
    this.judgeCounts[judge]++;
    if (judge === 'miss') {
      this.combo = 0;
    } else {
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
      var mult = Math.min(8, 1 + Math.floor(this.combo / 8));
      this.score += (judge === 'perfect' ? 300 : judge === 'great' ? 200 : 100) * mult;
      this._checkMilestone(this.combo);
    }
    var grid = this._deps && this._deps.grid;
    if (grid) {
      if (grid.clearZonePreview) grid.clearZonePreview(note.zone);
      if (grid.zoneJudge) grid.zoneJudge(note.zone, JUDGE_TEXT[judge], JUDGE_COLOR[judge], judge === 'miss');
      // 命中反馈：分区边框单圈外扩淡出（替代星海爆裂，不遮挡视野）
      if (judge !== 'miss' && grid.zoneHit) grid.zoneHit(note.zone, JUDGE_COLOR[judge]);
    }
    if (this._deps && this._deps.onJudge) {
      try { this._deps.onJudge(judge, delta); } catch (e) {}
    }
  };

  /**
   * 连击里程碑演出（参考 osu! combo milestone：30/60/100 后每 50）。
   * 这里按新手更密的节奏取值：10 / 25 / 50，之后每 50 —— 前三次鼓励来得快，
   * 之后靠「每 50」维持长连击的成就感。
   * level：0=10连（轻）1=25连 2=50连 3=50 的倍数（最重）
   */
  RhythmGameCtor.prototype._checkMilestone = function (combo) {
    var level;
    if (combo === 10) level = 0;
    else if (combo === 25) level = 1;
    else if (combo === 50) level = 2;
    else if (combo > 50 && combo % 50 === 0) level = 3;
    else return;
    var grid = this._deps && this._deps.grid;
    if (grid && grid.milestone) grid.milestone(combo, level);
    if (this._deps && this._deps.onMilestone) {
      try { this._deps.onMilestone(combo, level); } catch (e) {}
    }
  };

  /* ================= 成绩 / 结算 ================= */

  RhythmGameCtor.prototype.accuracy = function () {
    var j = this.judgeCounts;
    var total = j.perfect + j.great + j.good + j.miss;
    if (!total) return 0;
    return (j.perfect + j.great * 0.7 + j.good * 0.4) / total;
  };

  RhythmGameCtor.prototype.rank = function () {
    var a = this.accuracy();
    return a >= 0.95 ? 'S' : a >= 0.9 ? 'A' : a >= 0.8 ? 'B' : a >= 0.7 ? 'C' : 'D';
  };

  RhythmGameCtor.prototype.getResult = function () {
    return {
      score: this.score,
      maxCombo: this.maxCombo,
      accuracy: Math.round(this.accuracy() * 1000) / 10,
      rank: this.rank(),
      judges: { perfect: this.judgeCounts.perfect, great: this.judgeCounts.great, good: this.judgeCounts.good, miss: this.judgeCounts.miss },
      dropped: this.dropped,
      total: this.judgeCounts.perfect + this.judgeCounts.great + this.judgeCounts.good + this.judgeCounts.miss
    };
  };

  RhythmGameCtor.prototype._finish = function () {
    if (!this.isActive() || this._resultShown) return;
    this._resultShown = true;
    this._clearGridPreview();
    if (this._deps && this._deps.onFinish) {
      try { this._deps.onFinish(this.getResult()); } catch (e) {}
    }
  };

  /* ================= 换歌 / seek / 暂停 ================= */

  /** 换歌或 seek 后重置（由 main 在 onTrackChange / seeked 时调用） */
  RhythmGameCtor.prototype.onTrackChanged = function (song) {
    var id = song && song.id;
    // 同一首歌的重复通知必须忽略：player 在补全封面/主题后会对同一首歌再通知一次，
    // 若在此重置，会把「铺面完成 → 开播 → 封面就绪」这一瞬间的 active 打回 idle，
    // 表现为 HUD 消失、整首歌不出提示（日志可复现）。
    if (id != null && this.songId != null && String(id) === String(this.songId) &&
      (this.phase === 'caching' || this.phase === 'charting' ||
        this.phase === 'active' || this.phase === 'online')) {
      rlog('忽略重复换歌通知', '同一首歌不重置本局 id=' + id + ' phase=' + this.phase);
      return;
    }
    this._token++;                       // 作废进行中的缓存/铺面回调
    this._resetRound();
    this.phase = 'idle';
    this.chart = null;
    this.songId = id;
  };

  RhythmGameCtor.prototype.onSeeked = function () {
    if (!this.isActive()) return;
    var now = this.now();
    if (this.phase === 'active' && this.chart) {
      this._setNotes(this.chart.notes[this.difficulty] || []);
    } else if (this.phase === 'online') {
      this._active = [];
      this._schedFrom = now;
      this._lastNoteT = now;
    }
  };

  global.RhythmGame = new RhythmGameCtor();
})(typeof window !== 'undefined' ? window : globalThis);

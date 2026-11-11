/**
 * djFxEngine.js — 星海共振 · DJ 化音频引擎
 * ===========================================
 * 纯 Web Audio 程序化合成，零音频文件、断网可用、无构建依赖。
 *
 * 功能：
 *  1) BGM 音序器（Lookahead Scheduler）：Kick / Hi-hat / Bass / Pad 四轨循环，
 *     随主题切换 BPM、调式、音色参数（5 套主题与 themes.js 的 themeId 一一对应）。
 *  2) 4 行 = 4 个 DJ 乐器组（点击音）：
 *       row 0 → 旋律合成器（detune saw + 滤波扫频，音高=Y 轴、声像=X 轴）
 *       row 1 → 打击乐（snare / clap / rim 轮换）
 *       row 2 → 鼓点（kick + hat 组合）
 *       row 3 → 特效音（riser / impact / laser / scratch 轮换）
 *     每个点击在鼓组之上还叠一层旋律音（_melody）：真实连续音高（Y 轴）、
 *     声像（X 轴）、波形由 setWaveform 控制（设置面板六种音色真实生效）。
 *  3) FX 总线：Delay(0.375s 反馈) + Reverb（程序化生成的噪声 IR），音色空间化。
 *  4) AnalyserNode 频谱输出（getSpectrumData 兼容原 spectrumVisualizer 调用）。
 *  5) 连击彩蛋：4 连击（<800ms 间隔）自动触发 impact（DJ drop 感），
 *     旋律合成器 detune 随连击微升。
 *
 * 浏览器自动播放策略：AudioContext 懒创建，首次用户手势必须调用 resume()。
 *
 * 用法（main.js 接入点）：
 *   const dj = new DjFxEngine();
 *   // 首次点击 / 欢迎页"开始"按钮：
 *   dj.resume(); dj.startBgm();
 *   // 点击时（替代原 audioEngine.playNote(note, pan)）：
 *   dj.playNote(midi, pan, row);      // row = 0..3，见上
 *   // 主题切换：
 *   dj.setTheme(themeId);             // 'nebula' | 'aurora' | 'ember' | 'cyberpunk' | 'deepocean'
 *   // 频谱可视化：
 *   dj.getSpectrumData();             // Uint8Array，长度 = frequencyBinCount
 *   // 音量：
 *   dj.setMasterVolume(v);            // 0..1
 *
 * （可保留原 audioEngine.js 不删，逐步替换调用即可。）
 */
(function (global) {
  'use strict';

  // ---------- 主题音乐参数（与 themes.js 的 themeId 一一对应）----------
  // key = 调式根音（MIDI），scale = 调式音级（半音），bassPat / chordProg 用 scale 索引
  var THEMES = {
    nebula:    { bpm: 120, key: 69, scale: [0, 3, 5, 7, 8, 10, 12], hatOpen: 0, bgmLevel: 0.22 },
    aurora:    { bpm: 128, key: 60, scale: [0, 2, 4, 5, 7, 9, 11],  hatOpen: 0, bgmLevel: 0.20 },
    ember:     { bpm: 100, key: 64, scale: [0, 2, 3, 5, 7, 8, 10],  hatOpen: 0, bgmLevel: 0.24 },
    cyberpunk: { bpm: 132, key: 62, scale: [0, 2, 3, 6, 7, 9, 10],  hatOpen: 1, bgmLevel: 0.22 },
    deepocean: { bpm: 110, key: 65, scale: [0, 2, 4, 6, 7, 9, 10],  hatOpen: 0, bgmLevel: 0.20 }
  };
  var DEFAULT_THEME = 'nebula';
  var SEQ_STEPS = 16;

  // 贝斯音型（scale 索引，8 槽循环，每槽 = 2 个 16 分音符）
  var BASS_PAT = [0, 0, 0, 2, 0, 0, 4, 2];
  // 和弦走向（每个 = 3 个 scale 索引，4 小节循环，每 8 步换一个）
  var CHORD_PROG = [[0, 2, 4], [5, 7, 9], [3, 5, 7], [0, 2, 4]];

  /**
   * 节拍音色参数表（_kit）。集中管理点击音与 BGM 的 gain / frequency / decay，
   * 运行时可经 setKit(patch) 局部修改，立即生效。
   * 设计原则：瞬态优先（attack ≤5ms）、低频优先（40–250Hz）、不出现 ≥800Hz 且衰减 >0.3s 的持续高频。
   */
  var DEFAULT_KIT = {
    kick: {
      startHz: 160, endHz: 40, sweep: 0.09,
      attack: 0.002, decay: 0.22, peak: 0.55,
      clickHz: 3000, clickDecay: 0.01, clickPeak: 0.15, wet: 0.1
    },
    kick808: {
      startHz: 55, endHz: 32, sweep: 0.2,
      attack: 0.002, decay: 0.6, peak: 0.65, wet: 0.05, drive: 0.35
    },
    snare: {
      noiseHz: 1800, q: 0.9, noiseDecay: 0.16, noisePeak: 0.34,
      bodyStart: 200, bodyEnd: 150, bodySweep: 0.08, bodyDecay: 0.1, bodyPeak: 0.24, wet: 0.18
    },
    clap: {
      hz: 1350, q: 1.3, delays: [0, 0.014, 0.028], peaks: [0.42, 0.38, 0.3],
      bodyHz: 160, bodyDecay: 0.12, bodyPeak: 0.2, wet: 0.15
    },
    tom: {
      startHz: 260, endHz: 90, sweep: 0.25, decay: 0.3, peak: 0.4,
      lowHz: 220, highHz: 300, wet: 0.2
    },
    bassTap: { cutoff: 250, q: 1.5, decay: 0.15, peak: 0.25, octave: -24, wet: 0.05, enabled: true },
    // 旋律层：点击声的"音高 + 音色"担当（设置面板六波形作用于此）。
    // 叠在鼓组之上，峰值远低于鼓组，只做厚度不做主音。
    melody: {
      peak: 0.18, attack: 0.006, decay: 0.18, wet: 0.12,
      noiseQ: 9,          // 噪声波形：带通 Q 值（保留音高感）
      rows: [0, 1, 2, 3], // 生效行（row 4 特效行恒不叠加）
      enabled: false      // 默认关闭：叠加层改变点击听感，用户要求保持原鼓组声音（20261109e 回退）
    }
  };

  function cloneKit(src) {
    return JSON.parse(JSON.stringify(src));
  }

  function DjFxEngine() {
    this._ctx = null;
    this._master = null;
    this._bgmGain = null;
    this._analyser = null;
    this._freqData = null;
    this._noiseBuf = null;
    this._irBuf = null;
    this._delay = null;
    this._wet = null;
    this._reverb = null;

    this._theme = DEFAULT_THEME;
    this._params = Object.assign({}, THEMES[DEFAULT_THEME]);

    this._bgm = { running: false, timer: null, step: 0, count: 0, nextTime: 0 };
    this._combo = 0;
    this._lastTap = 0;
    this._fxIdx = 0;
    this._songPlaying = false; // 歌曲播放时压低 BGM
    // 节拍网格：无歌用 BGM 网格，有歌切换到外部（歌曲）网格
    this._bgmGrid = (typeof global.BeatGrid === 'function') ? new global.BeatGrid() : null;
    this._externalGrid = null;
    // 节拍音色参数 + 行状态
    this._kit = cloneKit(DEFAULT_KIT);
    this._tapCount = 0;       // 点击计数（调试用）
    this._driveCurve = null;  // 808 饱和曲线缓存
    this._melodyWave = 'harmonic'; // 旋律层波形（设置面板音色，与 audioEngine 同一套六种）
  }

  /* ---------------- 工具 ---------------- */

  DjFxEngine.midiToFreq = function (midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  };

  DjFxEngine.prototype._midiToFreq = function (midi) {
    return DjFxEngine.midiToFreq(midi);
  };

  // 通用包络：快 Attack + 指数衰减 Release
  DjFxEngine.prototype._env = function (g, t, attack, decay, peak) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setTargetAtTime(0.0001, t + attack, decay);
  };

  // 输出路由：node → dry → 声像 → master；node → send(wetAmt) → delay/reverb
  DjFxEngine.prototype._connectOut = function (node, wetAmt, pan) {
    var ctx = this._ctx;
    var dry = ctx.createGain();
    dry.gain.value = 1;
    var p = ctx.createStereoPanner();
    p.pan.value = pan == null ? 0 : Math.max(-1, Math.min(1, pan));
    var send = ctx.createGain();
    send.gain.value = wetAmt;
    node.connect(dry);
    dry.connect(p);
    p.connect(this._master);
    if (wetAmt > 0.001) {
      node.connect(send);
      send.connect(this._delay);
      send.connect(this._reverb);
    }
  };

  // BGM 乐器统一走 BGM bus（避免背景盖过点击音，且支持整体渐入）
  DjFxEngine.prototype._bgmOut = function (node, wetAmt) {
    var ctx = this._ctx;
    var dry = ctx.createGain();
    dry.gain.value = 1;
    var send = ctx.createGain();
    send.gain.value = wetAmt;
    node.connect(dry);
    dry.connect(this._bgmGain);
    node.connect(send);
    send.connect(this._delay);
  };

  /* ---------------- 音频图构建 ---------------- */

  DjFxEngine.prototype._ensure = function () {
    if (this._ctx) return;
    var Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio API not supported');
    var ctx = this._ctx = new Ctx();

    // 主总线
    this._master = ctx.createGain();
    this._master.gain.value = 0.9;

    // BGM 总线（点击音直达 master，BGM 走此总线方便整体控制）
    this._bgmGain = ctx.createGain();
    this._bgmGain.gain.value = 0;
    this._bgmGain.connect(this._master);

    // FX 发送链：delay(0.375s + 反馈) / reverb → wet → master
    this._delay = ctx.createDelay(1.0);
    this._delay.delayTime.value = 0.375;
    var fb = ctx.createGain();
    fb.gain.value = 0.35;
    this._delay.connect(fb);
    fb.connect(this._delay);
    this._wet = ctx.createGain();
    this._wet.gain.value = 0.9;
    this._delay.connect(this._wet);

    this._reverb = ctx.createConvolver();
    this._reverb.buffer = this._makeImpulse(1.6, 2.5);
    var revGain = ctx.createGain();
    revGain.gain.value = 1;
    this._reverb.connect(revGain);
    revGain.connect(this._wet);
    this._wet.connect(this._master);

    // 频谱分析（BGM + 点击音全部汇入 master，数据完整）
    this._analyser = ctx.createAnalyser();
    this._analyser.fftSize = 256;
    this._analyser.smoothingTimeConstant = 0.8;
    this._master.connect(this._analyser);
    this._analyser.connect(ctx.destination);

    this._freqData = new Uint8Array(this._analyser.frequencyBinCount);
    this._noiseBuf = this._makeNoise(2);
  };

  // 白噪声缓冲（缓存复用）
  DjFxEngine.prototype._makeNoise = function (dur) {
    var ctx = this._ctx;
    var len = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  };

  // 程序化混响 IR：指数衰减立体声噪声
  DjFxEngine.prototype._makeImpulse = function (dur, decay) {
    var ctx = this._ctx;
    var len = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (var ch = 0; ch < 2; ch++) {
      var data = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  };

  /* ---------------- 点击音：4 行鼓组 + 1 个特效行 ---------------- */

  DjFxEngine.prototype.playNote = function (midi, pan, row, vel) {
    this._ensure();
    var ctx = this._ctx;
    if (ctx.state !== 'running') {
      if (ctx.resume) ctx.resume();
      return 0; // 等待下一次手势（resume 异步完成）
    }
    var now = ctx.currentTime;
    var r = row | 0;
    var v = vel == null ? 1 : vel;
    this._tapCount++;
    this._comboUpdate(now);

    if (r < 0) r = 0;

    // 量化：有可靠网格时把音高层排到最近 16 分音符（负偏移立即响）
    var d = this.beatDelay();
    var when = now;
    if (d != null) {
      when = now + d;
      if (when < now) when = now;
    }

    // 先发 8ms 干声瞬态，保证触感（鼓组与 FX 行都适用）
    if (when > now + 0.006) this._tapClick(pan, v);

    // 行 4：特效（噪音类，无音高；也按网格排程，保持路径一致）
    if (r === 4) { this._fx(pan, when); return when - now; }

    // 行 0 底排 = Kick + Bass（最低、最沉，抖腿锚点）
    // 行 1 = Snare（打鼓）  行 2 = Clap（拍手）  行 3 顶排 = Tom（桶鼓）
    switch (r % 4) {
      case 0: this._kickRow(pan, midi, v, when); break;
      case 1: this._snare(pan, v, when); break;
      case 2: this._clap(pan, v, when); break;
      default: this._tom(pan, when); break;
    }

    // 旋律层：纵向连续音高 + 设置面板波形音色，叠在鼓组之上（特效行 r===4 已提前 return）
    var mk = this._kit.melody;
    if (mk && mk.enabled !== false && mk.rows.indexOf(r) >= 0) {
      this._melody(midi, pan, v, when);
    }
    return when - now;
  };

  /**
   * 旋律层：每个点击声叠加一个带真实音高的持续音。
   * - 波形：与 audioEngine 共享 WaveformOsc 工厂（六种），设置面板切换真实生效；
   * - 噪声波形：走带通滤波（中心频率 = 点击音高），保留音高感；
   * - 包络：attack 6ms → 指数衰减（τ=180ms），峰值 0.18×vel，只做厚度不做主音；
   * - 排程用 when（已量化），与鼓组同格落拍。
   */
  DjFxEngine.prototype._melody = function (midi, pan, vel, when) {
    var ctx = this._ctx;
    var t = when == null ? ctx.currentTime : when;
    var k = this._kit.melody;
    var v = vel == null ? 1 : vel;
    var f = this._midiToFreq(midi);
    var wave = this._melodyWave || 'harmonic';
    var outs = [];
    var sources = [];

    if (wave === 'noise') {
      // 噪声自身无音高：带通中心频率钉在点击音高上，横向拖动仍能听到声像、纵向仍是音阶
      var src = ctx.createBufferSource();
      src.buffer = this._noiseBuf;
      src.loop = true;
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = k.noiseQ;
      src.connect(bp);
      outs.push(bp);
      sources.push(src);
      src.start(t);
    } else if (global.WaveformOsc) {
      var b = global.WaveformOsc(ctx, f, wave, t);
      outs = b.outs;
      sources = b.sources;
    }
    if (!outs.length) return;

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(k.peak * v, t + k.attack);
    g.gain.setTargetAtTime(0.0001, t + k.attack, k.decay);
    for (var i = 0; i < outs.length; i++) outs[i].connect(g);
    this._connectOut(g, k.wet, pan);

    // 尾音衰减到约 -35dB 后回收振荡器（不 stop 会永久泄漏）
    var stopAt = t + k.attack + k.decay * 3.2 + 0.15;
    for (var j = 0; j < sources.length; j++) {
      try { sources[j].stop(stopAt); } catch (e) {}
    }
  };

  /** 8ms 干声瞬态：只走干路，不进程 delay / reverb */
  DjFxEngine.prototype._tapClick = function (pan, vel) {
    var ctx = this._ctx;
    if (!ctx) return;
    var t = ctx.currentTime;
    var v = vel == null ? 1 : vel;
    var src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2600;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.12 * v, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.009);
    src.connect(hp);
    hp.connect(g);
    g.connect(this._master);
    src.start(t, Math.random() * 0.4, 0.02);
    src.stop(t + 0.012);
  };

  // 底排：底鼓 + 短贝斯（固定主题根音，保证不跑调），连击第 4/8 下追加 808
  DjFxEngine.prototype._kickRow = function (pan, midi, vel, when) {
    var ctx = this._ctx;
    var t = when == null ? ctx.currentTime : when;
    var k = this._kit;
    var v = vel == null ? 1 : vel;
    // 点击路径使用短瞬态包络，避免长尾落在反拍上
    this._kick(t, k.kick.peak * v, true);
    if (this._combo > 0 && this._combo % 4 === 0) this._kick808(t + 0.015, k.kick808.peak, true);
    if (k.bassTap.enabled) {
      // 用调式根音而不是点击音高，避免低音跟着鼠标乱走
      var root = (this._params.key || 60) - 12;
      var quant = midi == null ? 0 : (midi - (this._params.key || 60));
      var octave = Math.round(quant / 12);
      this._bassTap(root + octave * 12, pan, 0.7 * v, t);
    }
  };

  /* ---------- 节拍对齐（键盘/触屏自动打拍） ---------- */

  /**
   * 距离最近 16 分音符网格的带符号偏移（秒）。
   * 负值 = 往回吸（立即响），null = 没有可靠网格 / 等待超过 maxWait。
   * 不再读取 _bgm.nextTime，统一由 BeatGrid 的 anchor 相位计算。
   */
  DjFxEngine.prototype.beatDelay = function (maxWait) {
    if (!this._ctx || this._ctx.state !== 'running') return null;
    var limit = maxWait == null ? 0.07 : maxWait;
    var grid = this._externalGrid;
    if (grid && grid.isConfident()) return grid.getStepDelay(limit);
    if (this._bgm.running && this._bgmGrid && this._bgmGrid.isConfident()) {
      return this._bgmGrid.getStepDelay(limit);
    }
    return null;
  };

  DjFxEngine.prototype.setExternalGrid = function (grid) {
    this._externalGrid = grid || null;
  };

  DjFxEngine.prototype.getBeatInfo = function () {
    var grid = this._externalGrid || this._bgmGrid;
    if (!grid) {
      if (!this._emptyBeatInfo) {
        this._emptyBeatInfo = {
          bpm: null, anchor: 0, stepDur: 0, phase: 0,
          stepIndex: 0, sinceStep: 0, confident: false, cached: false
        };
      }
      return this._emptyBeatInfo;
    }
    return grid.getState();
  };

  // 按拍点演奏指定行（自动对齐节拍网格）
  DjFxEngine.prototype.playBeat = function (pan, row) {
    this._ensure();
    if (this._ctx.state !== 'running') {
      if (this._ctx.resume) this._ctx.resume();
      return 0;
    }
    // playNote 内部完成量化，返回值即排程延迟（when - now）
    return this.playNote(60, pan, row);
  };

  /**
   * 自动连招：单键也能打出稳定 groove。
   * 8 步型：底-鼓-底-拍-底-鼓-桶-鼓，每步有 25% 概率随机替换，
   * 既像"随机打拍子"，又始终落在拍点上。
   */
  DjFxEngine.prototype.playAutoBeat = function (pan) {
    var PATTERN = [0, 1, 0, 2, 0, 1, 3, 1];
    this._autoIdx = ((this._autoIdx || 0) + 1) % PATTERN.length;
    var row = PATTERN[this._autoIdx];
    if (Math.random() < 0.25) row = Math.floor(Math.random() * 4);
    return this.playBeat(pan, row);
  };

  /**
   * 音游命中音效：判定结算后的打击层（不量化、立即发声——判定反馈必须瞬时）。
   * perfect → 808 底鼓 + 底鼓 + 高频 snap；great → 底鼓 + snap；good → 软底鼓；
   * miss → 闷 thud（提示失误但不刺耳）。峰值整体高于 kit 常规打击（0.55 → 0.85 档），
   * 叠在点击乐器音之上，保证「打得响、打得脆」。
   */
  DjFxEngine.prototype.playHit = function (judge, pan, vel) {
    this._ensure();
    var ctx = this._ctx;
    if (!ctx || ctx.state !== 'running') return;
    var t = ctx.currentTime;
    var v = vel == null ? 1 : vel;
    if (judge === 'perfect') {
      this._kick808(t, 0.85 * v, true);
      this._kick(t, 0.5 * v, true);
      this._hitSnap(t, pan, 0.22 * v, 5200);
    } else if (judge === 'great') {
      this._kick(t, 0.78 * v, true);
      this._hitSnap(t, pan, 0.15 * v, 4200);
    } else if (judge === 'good') {
      this._kick(t, 0.5 * v, true);
      this._hitSnap(t, pan, 0.07 * v, 3200);
    } else if (judge === 'miss') {
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(60, t + 0.09);
      var g = ctx.createGain();
      this._env(g, t, 0.002, 0.06, 0.22 * v);
      o.connect(g);
      this._connectOut(g, 0, pan);
      o.start(t);
      o.stop(t + 0.15);
    }
  };

  /**
   * 连击里程碑音效（上扬琶音）：level 越高音数越多、越亮。
   * 做法参考 osu! 的 comboburst 音效与常见的「里程碑 riser」——
   * 音高整体上行（大调琶音 + 八度泛音）制造「往上冲」的听感，
   * 50 连以上再叠一层带通噪声 riser 与一击底鼓，把成就感顶起来。
   * 音量刻意低于命中音（0.16 档），只做奖励不抢判定反馈。
   */
  DjFxEngine.prototype.playMilestone = function (combo, level) {
    this._ensure();
    var ctx = this._ctx;
    if (!ctx || ctx.state !== 'running') return;
    level = level | 0;
    var t = ctx.currentTime;
    var scale;
    if (level <= 0) scale = [880.0, 1174.66];                                     // 10 连：两个音（轻）
    else if (level === 1) scale = [880.0, 1108.73, 1318.51];                      // 25 连：三音上行
    else if (level === 2) scale = [659.25, 830.61, 987.77, 1318.51];              // 50 连：四音 E 大调
    else scale = [659.25, 830.61, 987.77, 1318.51, 1975.53];                      // 每 50：五音到高八度

    var gap = level >= 2 ? 0.062 : 0.075;
    for (var i = 0; i < scale.length; i++) {
      var tn = t + i * gap;
      var o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(scale[i], tn);
      var g = ctx.createGain();
      this._env(g, tn, 0.004, 0.2 + level * 0.04, 0.16);
      o.connect(g);
      this._connectOut(g, 0.3, 0);
      o.start(tn);
      o.stop(tn + 0.45);
      // 八度泛音：让琶音更「亮」，穿透背景乐
      var o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.setValueAtTime(scale[i] * 2, tn);
      var g2 = ctx.createGain();
      this._env(g2, tn, 0.003, 0.12, 0.07);
      o2.connect(g2);
      this._connectOut(g2, 0.22, 0);
      o2.start(tn);
      o2.stop(tn + 0.3);
    }

    if (level >= 2) {
      // 低频冲击：给「大里程碑」一个落地的重量
      this._kick(t, 0.42, true);
      // 带通噪声 riser：1.2k → 7k，0.25s
      var src = ctx.createBufferSource();
      src.buffer = this._noiseBuf;
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1200, t);
      bp.frequency.exponentialRampToValueAtTime(7000, t + 0.25);
      bp.Q.value = 1.2;
      var gn = ctx.createGain();
      this._env(gn, t, 0.02, 0.18, 0.09);
      src.connect(bp);
      bp.connect(gn);
      this._connectOut(gn, 0.22, 0);
      src.start(t, Math.random() * 0.4, 0.32);
      src.stop(t + 0.4);
    }
  };

  // 命中 snap：极短高频噪声瞬态（「啪」的打击感），直连干路不进 delay/reverb
  DjFxEngine.prototype._hitSnap = function (t, pan, peak, hz) {
    var ctx = this._ctx;
    var src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = hz;
    bp.Q.value = 0.8;
    var g = ctx.createGain();
    this._env(g, t, 0.001, 0.03, peak);
    src.connect(bp);
    bp.connect(g);
    g.connect(this._master);
    src.start(t, Math.random() * 0.5, 0.05);
    src.stop(t + 0.06);
  };

  DjFxEngine.prototype._comboUpdate = function (now) {
    if (now - this._lastTap < 0.8) {
      this._combo = Math.min(8, this._combo + 1);
    } else {
      this._combo = 1;
    }
    this._lastTap = now;
    return this._combo;
  };

  // Snare：噪声层（带通 1800Hz）+ 三角波身体音
  DjFxEngine.prototype._snare = function (pan, vel, when) {
    var ctx = this._ctx;
    var t = when == null ? ctx.currentTime : when;
    var k = this._kit.snare;
    var v = vel == null ? 1 : vel;
    var noiseDecay = Math.min(k.noiseDecay, 0.1);
    var src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.playbackRate.value = 1.2;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = k.noiseHz;
    bp.Q.value = k.q;
    var g = ctx.createGain();
    this._env(g, t, 0.001, noiseDecay, k.noisePeak * v);
    src.connect(bp);
    bp.connect(g);
    this._connectOut(g, Math.min(k.wet, 0.06), pan);
    src.start(t, Math.random() * 0.5, 0.2);
    src.stop(t + 0.18);
    // 鼓身音
    var o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(k.bodyStart, t);
    o.frequency.exponentialRampToValueAtTime(k.bodyEnd, t + k.bodySweep);
    var og = ctx.createGain();
    this._env(og, t, 0.001, Math.min(k.bodyDecay, 0.08), k.bodyPeak * v);
    o.connect(og);
    this._connectOut(og, 0.04, pan);
    o.start(t);
    o.stop(t + 0.12);
  };

  // Clap：3 层噪声 burst + 160Hz 身体音（让拍手更"实"）
  DjFxEngine.prototype._clap = function (pan, vel, when) {
    var ctx = this._ctx;
    var t = when == null ? ctx.currentTime : when;
    var k = this._kit.clap;
    var v = vel == null ? 1 : vel;
    var g = ctx.createGain();
    g.gain.value = 1;
    var that = this;
    for (var i = 0; i < k.delays.length; i++) {
      (function (dt, peak) {
        var s = ctx.createBufferSource();
        s.buffer = that._noiseBuf;
        s.playbackRate.value = 0.9;
        var b2 = ctx.createBiquadFilter();
        b2.type = 'bandpass';
        b2.frequency.value = k.hz;
        b2.Q.value = k.q;
        var gg = ctx.createGain();
        gg.gain.setValueAtTime(0.0001, t + dt);
        gg.gain.linearRampToValueAtTime(peak * v, t + dt + 0.002);
        gg.gain.setTargetAtTime(0.0001, t + dt + 0.002, 0.04);
        s.connect(b2);
        b2.connect(gg);
        gg.connect(g);
        s.start(t + dt, Math.random() * 0.4, 0.12);
        s.stop(t + dt + 0.12);
      })(k.delays[i], k.peaks[i] || 0.3);
    }
    // 身体音
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = k.bodyHz;
    var og = ctx.createGain();
    this._env(og, t, 0.002, Math.min(k.bodyDecay, 0.08), k.bodyPeak * v);
    o.connect(og);
    og.connect(g);
    o.start(t);
    o.stop(t + 0.16);
    this._connectOut(g, Math.min(k.wet, 0.06), pan);
  };

  // 标准 Kick：160→40Hz 扫频 + 高通 click 瞬态（让鼓点更"透"）
  // tap=true 时用短包络（≤0.12s）与小 send，避免点击长尾落到反拍
  DjFxEngine.prototype._kick = function (t, peak, tap) {
    var ctx = this._ctx;
    var k = this._kit.kick;
    var decay = tap ? Math.min(k.decay, 0.12) : k.decay;
    var wet = tap ? Math.min(k.wet, 0.05) : k.wet;
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(k.startHz, t);
    o.frequency.exponentialRampToValueAtTime(k.endHz, t + k.sweep);
    var g = ctx.createGain();
    this._env(g, t, k.attack, decay, peak);
    o.connect(g);
    this._connectOut(g, wet, 0);
    o.start(t);
    o.stop(t + decay * 2 + 0.1);

    // click 瞬态：极短、极轻的高频，只为目的"咬拍"
    if (k.clickPeak > 0) {
      var src = ctx.createBufferSource();
      src.buffer = this._noiseBuf;
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = k.clickHz;
      var cg = ctx.createGain();
      this._env(cg, t, 0.001, k.clickDecay, k.clickPeak);
      src.connect(hp);
      hp.connect(cg);
      this._connectOut(cg, 0, 0);
      src.start(t, Math.random() * 0.5, 0.03);
      src.stop(t + 0.05);
    }
  };

  // 808 Kick：更肥的低频长衰减，可选 WaveShaper 轻饱和
  DjFxEngine.prototype._kick808 = function (t, peak, tap) {
    var ctx = this._ctx;
    var k = this._kit.kick808;
    var decay = tap ? Math.min(k.decay, 0.12) : k.decay;
    var wet = tap ? Math.min(k.wet, 0.02) : k.wet;
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(k.startHz, t);
    o.frequency.exponentialRampToValueAtTime(k.endHz, t + k.sweep);
    var g = ctx.createGain();
    this._env(g, t, k.attack, decay, peak);

    var node = o;
    try {
      if (ctx.createWaveShaper) {
        var ws = ctx.createWaveShaper();
        ws.curve = this._getDriveCurve();
        ws.oversample = '2x';
        o.connect(ws);
        node = ws;
      }
    } catch (e) {
      // 饱和不可用时跳过（不报错），仍保持纯正弦 808
    }
    node.connect(g);
    this._connectOut(g, wet, 0);
    o.start(t);
    o.stop(t + decay * 1.6 + 0.2);
  };

  // 808 轻饱和曲线（程序化生成，缓存）
  DjFxEngine.prototype._getDriveCurve = function () {
    if (this._driveCurve) return this._driveCurve;
    var n = 1024;
    var curve = new Float32Array(n);
    var drive = 1 + this._kit.kick808.drive * 12;
    var norm = Math.tanh(drive);
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * drive) / norm;
    }
    this._driveCurve = curve;
    return curve;
  };

  // Tom：三角波 260→90Hz；pan<0 低音桶鼓，pan≥0 高音桶鼓
  DjFxEngine.prototype._tom = function (pan, when) {
    var ctx = this._ctx;
    var t = when == null ? ctx.currentTime : when;
    var k = this._kit.tom;
    var decay = Math.min(k.decay, 0.12);
    var start = (pan != null && pan < 0) ? k.lowHz : k.highHz;
    var end = Math.max(45, start * (k.endHz / k.startHz));
    var o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(start, t);
    o.frequency.exponentialRampToValueAtTime(end, t + k.sweep);
    var g = ctx.createGain();
    this._env(g, t, 0.002, decay, k.peak);
    o.connect(g);
    this._connectOut(g, Math.min(k.wet, 0.05), pan);
    o.start(t);
    o.stop(t + decay * 2 + 0.1);
  };

  // Bass 短音：给点击加推动力（底排与 Kick 叠加，取调式根音）
  DjFxEngine.prototype._bassTap = function (midi, pan, vel, when) {
    var ctx = this._ctx;
    var t = when == null ? ctx.currentTime : when;
    var k = this._kit.bassTap;
    var v = vel == null ? 1 : vel;
    var f = this._midiToFreq(midi + k.octave);
    var o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = k.cutoff;
    lp.Q.value = k.q;
    var g = ctx.createGain();
    this._env(g, t, 0.002, Math.min(k.decay, 0.1), k.peak * v);
    o.connect(lp);
    lp.connect(g);
    this._connectOut(g, Math.min(k.wet, 0.03), pan);
    o.start(t);
    o.stop(t + 0.18);
  };

  DjFxEngine.prototype._hat = function (t, peak, decay, open) {
    var ctx = this._ctx;
    var src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6500;
    var g = ctx.createGain();
    this._env(g, t, 0.001, open ? 0.16 : decay, peak);
    src.connect(hp);
    hp.connect(g);
    this._connectOut(g, 0.05, Math.random() * 0.2 - 0.1);
    src.start(t);
    src.stop(t + (open ? 0.3 : 0.12));
  };

  // 行 4：特效音（riser / impact / scratch；激光已移出，避免空爆高频）
  DjFxEngine.prototype._fx = function (pan, when) {
    var pick = this._fxIdx++ % 3;
    var ctx = this._ctx;
    var t = when == null ? ctx.currentTime : when;
    if (pick === 0) this._riser(pan, t);
    else if (pick === 1) this._impact(t, pan);
    else this._scratch(pan, t);
  };

  DjFxEngine.prototype._riser = function (pan, when) {
    var ctx = this._ctx;
    var t = when == null ? ctx.currentTime : when;
    var src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(250, t);
    hp.frequency.exponentialRampToValueAtTime(7500, t + 0.22);
    var g = ctx.createGain();
    this._env(g, t, 0.02, 0.12, 0.3);
    src.connect(hp);
    hp.connect(g);
    this._connectOut(g, 0.08, pan);
    src.start(t);
    src.stop(t + 0.3);
  };

  DjFxEngine.prototype._impact = function (t, pan) {
    var ctx = this._ctx;
    if (t == null) t = ctx.currentTime;
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(85, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.25);
    var g = ctx.createGain();
    this._env(g, t, 0.002, 0.12, 0.6);
    o.connect(g);
    var src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1200;
    var g2 = ctx.createGain();
    this._env(g2, t, 0.001, 0.1, 0.5);
    src.connect(lp);
    lp.connect(g2);
    g2.connect(g);
    this._connectOut(g, 0.08, pan);
    o.start(t);
    o.stop(t + 0.3);
    src.start(t, 0, 0.2);
    src.stop(t + 0.22);
  };

  DjFxEngine.prototype._laser = function (pan) {
    var ctx = this._ctx, t = ctx.currentTime;
    var o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(1400, t);
    o.frequency.exponentialRampToValueAtTime(180, t + 0.2);
    var g = ctx.createGain();
    this._env(g, t, 0.001, 0.16, 0.4);
    o.connect(g);
    this._connectOut(g, 0.45, pan);
    o.start(t);
    o.stop(t + 0.3);
  };

  DjFxEngine.prototype._scratch = function (pan, when) {
    var ctx = this._ctx;
    var t = when == null ? ctx.currentTime : when;
    var src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    var dir = (this._fxIdx++ % 2 === 0) ? 1 : -1; // 正反向刮擦
    var off = 0.2 + Math.random() * 0.5;
    src.playbackRate.setValueAtTime(2.2 * dir, t);
    src.playbackRate.exponentialRampToValueAtTime(0.3 * dir, t + 0.12);
    src.playbackRate.setValueAtTime(0.3 * dir, t + 0.12);
    src.playbackRate.exponentialRampToValueAtTime(2.0 * dir, t + 0.28);
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    var g = ctx.createGain();
    this._env(g, t, 0.005, 0.09, 0.28);
    src.connect(hp);
    hp.connect(g);
    this._connectOut(g, 0.08, pan);
    src.start(t, off, 0.4);
    src.stop(t + 0.28);
  };

  /* ---------------- BGM 音序器（Lookahead Scheduler）---------------- */

  DjFxEngine.prototype.startBgm = function () {
    this._ensure();
    if (this._bgm.running) return;
    this._bgm.running = true;
    this._bgm.step = 0;
    this._bgm.count = 0;
    var t = this._ctx.currentTime + 0.08;
    this._bgm.nextTime = t;
    // 无歌时也走同一个 BeatGrid，anchor = BGM 起始时间
    if (this._bgmGrid) {
      var self = this;
      this._bgmGrid.attach(this._ctx, null, function () { return self._ctx.currentTime; });
      this._bgmGrid.setTempo(this._params.bpm, t, true);
    }
    // BGM 总线渐入，避免爆音；歌曲在播时保持压低
    this._bgmGain.gain.setValueAtTime(0.0001, t);
    this._bgmGain.gain.setTargetAtTime(this._songPlaying ? 0.0001 : this._params.bgmLevel, t + 0.05, 1.2);
    this._tick();
  };

  /**
   * 歌曲播放状态：有歌时把 BGM 总线压到 0（约 300ms），停歌恢复。
   * 只改增益，不启停音序器，避免影响既有播放逻辑。
   */
  DjFxEngine.prototype.setSongPlaying = function (playing) {
    this._songPlaying = !!playing;
    if (!this._bgmGain || !this._ctx) return;
    var gain = this._bgmGain.gain;
    var now = this._ctx.currentTime;
    var target = this._songPlaying ? 0.0001 : (this._params.bgmLevel || 0);
    try { gain.cancelScheduledValues(now); } catch (e) {}
    gain.setTargetAtTime(target, now, 0.1); // 时间常数 0.1s ≈ 300ms 完成
  };

  DjFxEngine.prototype.stopBgm = function () {
    this._bgm.running = false;
    if (this._bgm.timer) {
      clearTimeout(this._bgm.timer);
      this._bgm.timer = null;
    }
  };

  DjFxEngine.prototype._tick = function () {
    var self = this;
    if (!self._bgm.running) return;
    var ctx = self._ctx;
    var stepDur = 60 / self._params.bpm / 4; // 16 分音符时长（秒）
    var horizon = ctx.currentTime + 0.12;     // 提前 120ms 调度
    while (self._bgm.nextTime < horizon) {
      self._scheduleStep(self._bgm.step, self._bgm.nextTime);
      self._bgm.nextTime += stepDur;
      self._bgm.step = (self._bgm.step + 1) % SEQ_STEPS;
      self._bgm.count++;
    }
    self._bgm.timer = setTimeout(function () { self._tick(); }, 25);
  };

  DjFxEngine.prototype._scheduleStep = function (step, t) {
    var P = this._params, s = P.scale, key = P.key;
    // Kick：每拍正拍；每小节第一拍换 808（周期性变化）
    if (step % 4 === 0) {
      if (step === 0 && this._bgm.count % 16 === 0) this._kick808(t, this._kit.kick808.peak);
      else this._kick(t, this._kit.kick.peak);
    }
    // Hi-hat：反拍 + 尾部 swing（轻推）
    if (step % 2 === 1) {
      var hatT = t + (step % 4 === 3 ? 0.014 : 0); // 第 4 反拍 swing 后移
      this._hat(hatT, 0.12, 0.05, P.hatOpen);
    }
    // Bass：偶数步，8 槽音型循环
    if (step % 2 === 0) {
      var bi = Math.floor(step / 2) % 8;
      this._bass(t, key - 12 + s[BASS_PAT[bi]], 0.24);
    }
    // Pad：每 8 步换和弦（4 和弦循环）
    if (step % 8 === 0) {
      var ch = CHORD_PROG[Math.floor(this._bgm.count / 8) % 4];
      var voices = [];
      for (var i = 0; i < ch.length; i++) {
        // CHORD_PROG 里的索引可能超过 scale 长度（7），按八度换算，
        // 否则会得到 undefined → NaN 频率 → AudioParam 赋值抛错
        var raw = ch[i];
        var oct = Math.floor(raw / s.length);
        var idx = raw % s.length;
        voices.push(key + oct * 12 + s[idx]);
      }
      this._pad(t, voices, 0.07);
    }
  };

  DjFxEngine.prototype._bass = function (t, midi, peak) {
    var ctx = this._ctx;
    var f = this._midiToFreq(midi);
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    lp.Q.value = 2;
    var g = ctx.createGain();
    this._env(g, t, 0.004, 0.24, peak);
    var o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    o1.frequency.value = f;
    var o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.value = f;
    o1.connect(lp);
    o2.connect(lp);
    lp.connect(g);
    this._bgmOut(g, 0.1);
    o1.start(t);
    o2.start(t);
    o1.stop(t + 0.5);
    o2.stop(t + 0.5);
  };

  DjFxEngine.prototype._pad = function (t, midis, peak) {
    var ctx = this._ctx;
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.Q.value = 0.8;
    var g = ctx.createGain();
    this._env(g, t, 0.5, 1.4, peak);
    for (var i = 0; i < midis.length; i++) {
      var m = this._midiToFreq(midis[i]);
      [-10, 10].forEach(function (det) {
        var o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = m;
        o.detune.value = det;
        o.connect(lp);
        o.start(t);
        o.stop(t + 2.4);
      });
    }
    lp.connect(g);
    this._bgmOut(g, 0.3);
  };

  /* ---------------- 对外接口 ---------------- */

  DjFxEngine.prototype.resume = function () {
    this._ensure();
    if (this._ctx.state === 'suspended' && this._ctx.resume) this._ctx.resume();
  };

  DjFxEngine.prototype.setTheme = function (id) {
    if (!THEMES[id]) id = DEFAULT_THEME;
    this._theme = id;
    this._params = Object.assign({}, THEMES[id]);
    // 切主题只更新 BPM，保留当前 anchor，避免网格相位丢失
    if (this._bgmGrid && this._bgmGrid.isConfident()) {
      this._bgmGrid.setTempo(this._params.bpm, this._bgmGrid.getAnchor(), true);
    }
  };

  DjFxEngine.prototype.getTheme = function () {
    return this._theme;
  };

  /**
   * 旋律层波形（设置面板「音色」六选一）。
   * 与 audioEngine 共用同一套取值：sine / square / triangle / sawtooth / harmonic / noise。
   * 切换后下一次点击即生效；非法值回落 harmonic。
   */
  DjFxEngine.prototype.setWaveform = function (type) {
    var WAVEFORMS = ['sine', 'square', 'triangle', 'sawtooth', 'harmonic', 'noise'];
    this._melodyWave = WAVEFORMS.indexOf(type) >= 0 ? type : 'harmonic';
    return this._melodyWave;
  };

  DjFxEngine.prototype.getWaveform = function () {
    return this._melodyWave;
  };

  // 频谱数据（供 spectrumVisualizer 使用）
  DjFxEngine.prototype.getSpectrumData = function () {
    if (!this._analyser) return null;
    this._analyser.getByteFrequencyData(this._freqData);
    return this._freqData;
  };

  DjFxEngine.prototype.setMasterVolume = function (v) {
    if (this._master) this._master.gain.value = Math.max(0, Math.min(1, v));
  };

  /* ---------------- 节拍音色参数接口 ---------------- */

  // 只读快照（深拷贝，外部改动不影响引擎）
  DjFxEngine.prototype.getKit = function () {
    return cloneKit(this._kit);
  };

  // 局部修改：setKit({ kick: { peak: 0.6 }, doubleTapClap: false })
  DjFxEngine.prototype.setKit = function (patch) {
    if (!patch) return this.getKit();
    var self = this;
    Object.keys(patch).forEach(function (key) {
      var value = patch[key];
      var target = self._kit[key];
      if (value && typeof value === 'object' && !Array.isArray(value)
        && target && typeof target === 'object' && !Array.isArray(target)) {
        Object.keys(value).forEach(function (k) { target[k] = value[k]; });
      } else {
        self._kit[key] = value;
      }
    });
    // 808 的饱和曲线随 drive 变化，改动后重算
    this._driveCurve = null;
    return this.getKit();
  };

  DjFxEngine.prototype.dispose = function () {
    this.stopBgm();
    if (this._ctx && this._ctx.close) this._ctx.close();
    this._ctx = null;
  };

  // Node 导出（冒烟测试用）+ 浏览器全局
  if (typeof module !== 'undefined' && module.exports) module.exports = DjFxEngine;
  global.DjFxEngine = DjFxEngine;

})(typeof window !== 'undefined' ? window : globalThis);
//（注：内容由AI生成）

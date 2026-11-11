/**
 * lyricStage.js — 主舞台歌词演出层（PIXI v6）
 * ============================================================
 * 三种歌词演出模式（可扩展）：
 *   off      关闭（只保留播放器面板歌词）
 *   classic  经典单行：整行渐入渐出（原 lyric-overlay 行为）
 *   karaoke  逐字点亮：逐字着色 + 轻微放大，翻译/下一句跟随
 *
 * 数据来自 LyricTiming.normalize()，每帧只做颜色/透明度更新；
 * 只有换行、设置变化、窗口尺寸变化时才重建文字对象。
 */
var LyricStage = (function () {
  'use strict';

  var STORAGE_KEY = 'uta.lyricStageMode';
  var DEFAULT_MODE = 'karaoke';          // 默认逐字点亮
  var LEGACY_DEFAULT = 'folia-stream';   // 2026-11 前的旧默认（流光），自动写入的需迁移
  var FONT = 'PingFang SC, Microsoft YaHei, sans-serif';

  function clamp(v, a, b) {
    return v < a ? a : (v > b ? b : v);
  }

  function lerpColor(from, to, t) {
    t = clamp(t, 0, 1);
    var fr = (from >> 16) & 255;
    var fg = (from >> 8) & 255;
    var fb = from & 255;
    var tr = (to >> 16) & 255;
    var tg = (to >> 8) & 255;
    var tb = to & 255;
    var r = Math.round(fr + (tr - fr) * t);
    var g = Math.round(fg + (tg - fg) * t);
    var b = Math.round(fb + (tb - fb) * t);
    return (r << 16) | (g << 8) | b;
  }

  function loadMode() {
    try {
      var v = window.localStorage.getItem(STORAGE_KEY);
      if (v === LEGACY_DEFAULT) {
        // 旧默认值会在首次进入时被自动写入，并非用户主动选择：
        // 清掉，让新默认（逐字点亮）生效；用户之后仍可手动切回流光
        window.localStorage.removeItem(STORAGE_KEY);
      } else if (v) {
        return v;
      }
    } catch (e) { /* 隐私模式忽略 */ }
    return DEFAULT_MODE;
  }

  function saveMode(id) {
    try { window.localStorage.setItem(STORAGE_KEY, id); } catch (e) { /* ignore */ }
  }

  function ensureChars(line) {
    if (line.chars && line.chars.length) return line.chars;
    var chars = Array.from(line.text || '');
    var n = chars.length || 1;
    var span = Math.max(0.3, (line.timingEnd || line.t + 2) - line.t);
    var out = [];
    for (var i = 0; i < chars.length; i++) {
      out.push({
        text: chars[i],
        start: line.t + span * i / n,
        end: line.t + span * (i + 1) / n
      });
    }
    return out;
  }

  function accentOf(theme) {
    if (!theme) return 0x00f0ff;
    if (theme.accent != null) return theme.accent;
    if (theme.particles && theme.particles.length) return theme.particles[0];
    return 0x00f0ff;
  }

  function commonTunings() {
    return (typeof LyricTunings !== 'undefined') ? LyricTunings.getCommon() : null;
  }

  /* ================= off ================= */

  function OffRenderer() {
    this.root = new PIXI.Container();
  }
  OffRenderer.prototype.mount = function (host) { host.addChild(this.root); };
  OffRenderer.prototype.update = function () {};
  OffRenderer.prototype.resize = function () {};
  OffRenderer.prototype.dispose = function () {
    if (this.root.parent) this.root.parent.removeChild(this.root);
    this.root.destroy({ children: true });
  };

  /* ================= classic ================= */

  function ClassicRenderer(opts) {
    this.getTheme = opts && opts.getTheme;
    this.root = new PIXI.Container();
    this.text = new PIXI.Text('', new PIXI.TextStyle({
      fontFamily: FONT,
      fontSize: 30,
      fill: 0xffffff,
      fontWeight: '300',
      letterSpacing: 2
    }));
    this.text.anchor.set(0.5);
    this.text.alpha = 0;
    this.text.resolution = Math.min(2, window.devicePixelRatio || 1);
    this.root.addChild(this.text);
    this.line = null;
    this.width = 0;
    this.height = 0;
    this.commonKey = '';
  }
  ClassicRenderer.prototype.mount = function (host) { host.addChild(this.root); };
  ClassicRenderer.prototype.resize = function (w, h) {
    this.width = w;
    this.height = h;
    this.text.x = w / 2;
    this.text.y = h * 0.80;
  };
  ClassicRenderer.prototype.update = function (dt, s) {
    this.width = s.width || this.width;
    this.height = s.height || this.height;
    this.text.x = this.width / 2;
    this.text.y = this.height * 0.80;

    var common = commonTunings();
    if (common) {
      var key = common.font + '|' + common.fontScale;
      if (key !== this.commonKey) {
        this.commonKey = key;
        this.text.style.fontFamily = LyricTunings.fontStack();
        this.text.style.fontSize = 30 * common.fontScale;
      }
    }
    var opacity = common ? common.opacity : 1;

    var show = !!(s.visible && s.line);
    if (s.line && s.line !== this.line) {
      this.line = s.line;
      this.text.text = s.line.text;
      this.text.alpha = 0; // 换行重新渐入
    }
    var target = show ? 0.9 * opacity : 0;
    this.text.alpha += (target - this.text.alpha) * (1 - Math.exp(-9 * Math.min(dt || 0, 0.05)));
  };
  ClassicRenderer.prototype.dispose = function () {
    if (this.root.parent) this.root.parent.removeChild(this.root);
    this.root.destroy({ children: true });
  };

  /* ================= karaoke ================= */

  function KaraokeRenderer(opts) {
    this.getTheme = opts && opts.getTheme;
    this.root = new PIXI.Container();
    this.lineRoot = new PIXI.Container();
    this.root.addChild(this.lineRoot);

    this.chars = [];
    this.line = null;
    this.next = null;
    this.translation = null;
    this.nextText = null;
    this.optsKey = '';
    this.enterT = 1;
    this.visAlpha = 0;
    this.width = 0;
    this.height = 0;
    this.baseY = 0;
    this.fontSize = 32;
    this.accent = 0x00f0ff;
    this.commonKey = '';
  }

  KaraokeRenderer.prototype.mount = function (host) { host.addChild(this.root); };

  KaraokeRenderer.prototype._optsKey = function (opts) {
    opts = opts || {};
    return (opts.word !== false ? 1 : 0) + '|' + (opts.translation !== false ? 1 : 0) + '|' + (opts.nextLine !== false ? 1 : 0);
  };

  KaraokeRenderer.prototype._clear = function () {
    var kids = this.lineRoot.removeChildren();
    for (var i = 0; i < kids.length; i++) kids[i].destroy({ children: true });
    if (this.translation) { this.translation.destroy({ children: true }); this.translation = null; }
    if (this.nextText) { this.nextText.destroy({ children: true }); this.nextText = null; }
    this.chars.length = 0;
  };

  KaraokeRenderer.prototype._build = function (s) {
    this._clear();
    this.line = s.line;
    this.next = s.next;
    this.opts = s.opts || {};
    this.width = s.width;
    this.height = s.height;
    this.optsKey = this._optsKey(this.opts);
    this.enterT = 0;
    this.baseY = this.height * 0.74;

    var common = commonTunings();
    var fontScale = common ? common.fontScale : 1;
    var fontFamily = common ? LyricTunings.fontStack() : FONT;
    this.commonKey = common ? (common.font + '|' + common.fontScale) : '';
    var fs = Math.max(24, Math.min(44, Math.round(this.height * 0.054))) * fontScale;
    this.fontSize = fs;
    var style = new PIXI.TextStyle({
      fontFamily: fontFamily,
      fontSize: fs,
      fill: 0xffffff,
      fontWeight: '300',
      letterSpacing: 0
    });
    var spacing = Math.max(1, Math.round(fs * 0.035));
    var resolution = Math.min(2, window.devicePixelRatio || 1);
    var x = 0;
    var chars = ensureChars(s.line);

    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      if (!ch.text || /^\s$/.test(ch.text)) { x += fs * 0.3; continue; }
      var text = new PIXI.Text(ch.text, style);
      text.anchor.set(0.5);
      text.resolution = resolution;
      var w = text.width || fs * 0.5;
      text.x = x + w / 2;
      text.y = 0;
      this.lineRoot.addChild(text);
      this.chars.push({ obj: text, start: ch.start, end: ch.end });
      x += w + spacing;
    }

    var total = Math.max(1, x - spacing);
    var maxW = this.width * 0.88;
    var scale = total > maxW ? maxW / total : 1;
    this.lineRoot.scale.set(scale);
    this.lineRoot.x = -(total * scale) / 2;
    this.lineRoot.y = 0;

    this.root.x = this.width / 2;
    this.root.y = this.baseY + 14;

    var y = fs * 0.92;

    if (s.opts.translation !== false && s.line.tr) {
      var tr = new PIXI.Text(s.line.tr, new PIXI.TextStyle({
        fontFamily: fontFamily,
        fontSize: Math.round(fs * 0.5),
        fill: 0xffffff,
        fontWeight: '300',
        letterSpacing: 1
      }));
      tr.anchor.set(0.5);
      tr.resolution = resolution;
      tr.y = y;
      tr.alpha = 0.55;
      if (tr.width > maxW) tr.scale.set(maxW / tr.width);
      this.root.addChild(tr);
      this.translation = tr;
      y += fs * 0.62;
    }

    if (s.opts.nextLine !== false && s.next && s.next.text) {
      var nx = new PIXI.Text(s.next.text, new PIXI.TextStyle({
        fontFamily: FONT,
        fontSize: Math.round(fs * 0.46),
        fill: 0xffffff,
        fontWeight: '300',
        letterSpacing: 1
      }));
      nx.anchor.set(0.5);
      nx.resolution = resolution;
      nx.y = y;
      nx.alpha = 0.3;
      if (nx.width > maxW) nx.scale.set(maxW / nx.width);
      this.root.addChild(nx);
      this.nextText = nx;
    }
  };

  KaraokeRenderer.prototype.update = function (dt, s) {
    dt = Math.min(dt || 0, 0.05);
    var theme = this.getTheme ? this.getTheme() : null;
    if (theme) this.accent = accentOf(theme);

    var common = commonTunings();
    var ckey = common ? (common.font + '|' + common.fontScale) : '';
    if (ckey !== this.commonKey) {
      this.commonKey = ckey;
      this.optsKey = ''; // 强制下一帧重建文字
    }
    var opacity = common ? common.opacity : 1;

    var optsKey = this._optsKey(s.opts);
    if (s.line && (s.line !== this.line || s.width !== this.width || s.height !== this.height || optsKey !== this.optsKey)) {
      this._build(s);
    }

    var show = !!(s.visible && s.line && this.line);
    var target = show ? 1 : 0;
    // 最后一句唱完后淡出；中间的间奏保留当前句
    if (show && !this.next && s.time > this.line.end + 2.5) target = 0;
    this.visAlpha += (target - this.visAlpha) * (1 - Math.exp(-9 * dt));

    if (!this.line) {
      this.root.alpha = this.visAlpha * opacity;
      return;
    }

    if (show) this.enterT = Math.min(1, this.enterT + dt / 0.25);
    var enter = LyricTiming.easeOutCubic(this.enterT);
    var idleDim = (show && this.next && s.time > this.line.end + 0.2) ? 0.72 : 1;
    this.root.alpha = enter * this.visAlpha * idleDim * opacity;
    this.root.x = this.width / 2;
    this.root.y = this.baseY + (1 - enter) * 14;

    var wordOn = !s.opts || s.opts.word !== false;
    var lineP = wordOn ? 0 : LyricTiming.lineProgress(this.line, s.time);

    for (var i = 0; i < this.chars.length; i++) {
      var c = this.chars[i];
      var p = wordOn ? LyricTiming.charProgress(c, s.time) : lineP;
      c.obj.tint = lerpColor(0xffffff, this.accent, p);
      c.obj.alpha = 0.3 + 0.7 * p;
      c.obj.scale.set(1 + 0.07 * Math.sin(Math.PI * p));
    }
  };

  KaraokeRenderer.prototype.resize = function (w, h) {
    this.width = w;
    this.height = h;
    if (this.line) this._build({ line: this.line, next: this.next, opts: this.opts, width: w, height: h });
  };

  KaraokeRenderer.prototype.dispose = function () {
    this._clear();
    if (this.root.parent) this.root.parent.removeChild(this.root);
    this.root.destroy({ children: true });
  };

  /* ================= 注册内置模式 ================= */

  function registerBuiltins() {
    if (typeof VisualizerRegistry === 'undefined' || VisualizerRegistry.has('karaoke')) return;
    VisualizerRegistry.register({
      id: 'off',
      label: '关闭',
      order: 10,
      scope: 'lyric',
      create: function () { return new OffRenderer(); }
    });
    VisualizerRegistry.register({
      id: 'classic',
      label: '经典单行',
      order: 20,
      scope: 'lyric',
      create: function (opts) { return new ClassicRenderer(opts); }
    });
    VisualizerRegistry.register({
      id: 'karaoke',
      label: '逐字点亮',
      order: 30,
      scope: 'lyric',
      create: function (opts) { return new KaraokeRenderer(opts); }
    });
  }
  registerBuiltins();

  /* ================= 宿主 ================= */

  function LyricStage(container, opts) {
    opts = opts || {};
    this.opts = opts;
    this.root = new PIXI.Container();
    this.host = new PIXI.Container();
    this.root.addChild(this.host);
    container.addChild(this.root);

    this.width = 0;
    this.height = 0;
    this.mode = null;
    this.active = null;
    this._linesRef = null;
    this._duration = 0;
    this._norm = [];

    this.setMode(loadMode());
  }

  LyricStage.prototype.setMode = function (id) {
    var requested = id;
    var def = (typeof VisualizerRegistry !== 'undefined' && VisualizerRegistry.get(id)) || null;
    if (!def && typeof VisualizerRegistry !== 'undefined') def = VisualizerRegistry.get(DEFAULT_MODE);
    if (!def) return;
    if (this.active && this.mode === def.id) return;

    if (this.active) {
      this.active.dispose();
      this.active = null;
    }
    this.active = def.create({ getTheme: this.opts.getTheme, lines: this._norm || [] });
    this.mode = def.id;
    this._mountedWithLines = !!(this._norm && this._norm.length);
    this.active.mount(this.host);
    if (this.active.resize) this.active.resize(this.width, this.height);
    // 请求的模式尚不可用（例如模组还没启用）时，不要覆盖用户已保存的选择
    if (def.id === requested) saveMode(def.id);
  };

  LyricStage.prototype.resize = function (w, h) {
    this.width = w;
    this.height = h;
    if (this.active && this.active.resize) this.active.resize(w, h);
  };

  LyricStage.prototype.update = function (dt, state) {
    dt = Math.min(dt || 0, 0.05);
    state = state || {};
    var lines = state.lines || null;
    var duration = +state.duration || 0;

    // 换歌/换歌词数组，或歌曲时长从未知变为已知时，重新规范化
    if (lines !== this._linesRef || (duration > 0 && !this._duration)) {
      this._linesRef = lines;
      this._duration = duration;
      this._norm = (lines && lines.length && typeof LyricTiming !== 'undefined')
        ? LyricTiming.normalize(lines, duration)
        : [];
    }

    // 部分模组（如 cinerama）只在 mount 时读取并编译歌词；挂载时若还没有歌词，
    // 等首帧拿到规范化歌词后重新挂载一次
    if (this.active && !this._mountedWithLines && this._norm.length) {
      var keepMode = this.mode;
      this.mode = null;
      this.setMode(keepMode);
      return;
    }

    var time = +state.time || 0;
    var idx = this._norm.length ? LyricTiming.activeIndex(this._norm, time) : -1;
    if (idx === -1 && this._norm.length) idx = 0; // 前奏期间主舞台先亮第一句
    var line = idx >= 0 ? this._norm[idx] : null;
    var next = (idx >= 0 && idx + 1 < this._norm.length) ? this._norm[idx + 1] : null;

    if (!this.active) return;
    this.active.update(dt, {
      visible: !!state.visible,
      time: time,
      paused: !!state.paused,
      line: line,
      next: next,
      opts: state.opts || {},
      width: this.width,
      height: this.height,
      // 供模组视觉器使用（内置渲染器会忽略）
      lines: this._norm,
      index: idx,
      duration: this._duration,
      theme: state.theme || null,
      audio: state.audio || null,
      coverUrl: state.coverUrl || '',
      song: state.song || null
    });
  };

  /** 模组视觉器注册完成后，恢复上次选择的演出模式 */
  LyricStage.prototype.restoreMode = function () {
    this.setMode(loadMode());
  };

  LyricStage.prototype.dispose = function () {
    if (this.active) {
      this.active.dispose();
      this.active = null;
    }
    if (this.root.parent) this.root.parent.removeChild(this.root);
    this.root.destroy({ children: true });
  };

  return LyricStage;
})();

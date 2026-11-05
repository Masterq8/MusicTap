/**
 * builtinLyricModes.js — Folia 风格内置歌词演出模式
 * ============================================================
 * 按 Folia（AGPL-3.0）内置模式的源码规格逐个重写：构图、字号/颜色、
 * 时间线与动效参数对齐其实现，渲染层换成 uta-tap 自己的 DOM/Canvas。
 * 如果对外分发，请一并遵守 Folia 的 AGPL-3.0 许可。
 *
 * 歌词演出（只覆盖文字层）：
 *   静止 still / 流光 stream / 心象 cadenza / 云阶 partita / 群唱 cappella / 倾诉 tilt
 * 沉浸式听歌（全屏覆盖）：
 *   浮名 fume / 莫奈 monet / 回环 claddagh / 镜台 diorama / 时计 pendolo / 商籁 sonnet / 凝彩 tempera
 */
var BuiltinLyricModes = (function () {
  'use strict';

  var FONT = 'PingFang SC, Microsoft YaHei, sans-serif';
  var SERIF = 'Georgia, "Songti SC", "SimSun", serif';

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function el(tag, css, parent) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (parent) parent.appendChild(e);
    return e;
  }

  function setText(e, text) {
    text = text || '';
    if (e.textContent !== text) e.textContent = text;
  }

  function hex(n) {
    return '#' + ('000000' + ((n || 0) >>> 0).toString(16)).slice(-6);
  }

  function rgbOf(n) {
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function cssRgba(n, a) {
    var c = rgbOf(n);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }

  function mixNumeric(a, b, t) {
    t = clamp(t, 0, 1);
    var ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    var br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    var r = Math.round(ar + (br - ar) * t);
    var g = Math.round(ag + (bg - ag) * t);
    var bl = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | bl;
  }

  function themeColors(theme) {
    var p = (theme && theme.particles) || [];
    var accent = theme && theme.accent != null ? theme.accent : (p[0] != null ? p[0] : 0x00f0ff);
    return {
      accent: accent,
      accentCss: hex(accent),
      primary: p[0] != null ? p[0] : accent,
      secondary: p[1] != null ? p[1] : accent,
      bg: theme && theme.background != null ? theme.background : 0x0a0420
    };
  }

  function rand(i, salt) {
    var v = Math.sin((i + 1) * 127.1 + salt * 311.7) * 43758.5453;
    return v - Math.floor(v);
  }

  function fallbackChars(line) {
    var chars = Array.from(line.text || '');
    var span = Math.max(0.3, (line.timingEnd || line.t + 2) - line.t);
    var n = chars.length || 1;
    return chars.map(function (ch, i) {
      return { text: ch, start: line.t + span * i / n, end: line.t + span * (i + 1) / n };
    });
  }

  function currentText(s) {
    return s.line ? s.line.text : ((s.song && s.song.title) || '');
  }

  function currentTr(s) {
    return s.line && (!s.opts || s.opts.translation !== false) ? (s.line.tr || '') : '';
  }

  function nextText(s) {
    return (!s.opts || s.opts.nextLine !== false) && s.next ? s.next.text : '';
  }

  function prevLine(s) {
    if (!s.lines || s.index <= 0) return null;
    return s.lines[s.index - 1] || null;
  }

  function powerOf(s) {
    return s.audio ? clamp(+s.audio.power || 0, 0, 1) : 0;
  }

  function inherit(child, parent) {
    child.prototype = Object.create(parent.prototype);
    child.prototype.constructor = child;
  }

  /* ---------------- 逐字行 ---------------- */

  function CharLine(box, css, fontSize, weight, letterSpacing) {
    this.el = el('div', 'line-height:1.24;white-space:pre-wrap;font-family:inherit;' + (css || ''), box);
    this.el.style.fontSize = (fontSize || 40) + 'px';
    this.el.style.fontWeight = weight || '600';
    this.el.style.letterSpacing = (letterSpacing || 0) + 'px';
    this.el.style.color = '#ffffff';
    this.items = [];
    this.line = null;
  }

  CharLine.prototype.setFontSize = function (px) {
    this.el.style.fontSize = Math.max(10, Math.round(px)) + 'px';
  };

  CharLine.prototype.setLine = function (line, options) {
    options = options || {};
    this.line = line;
    this.el.textContent = '';
    this.items = [];
    if (!line || !line.text) return;
    var chars = (line.chars && line.chars.length) ? line.chars : fallbackChars(line);
    var breakAt = options.breakIndex != null ? options.breakIndex : -1;
    var italicChance = options.italicChance || 0;
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      if (i === breakAt) this.el.appendChild(document.createElement('br'));
      var sp = document.createElement('span');
      sp.textContent = ch.text;
      sp.style.display = 'inline-block';
      sp.style.whiteSpace = 'pre';
      sp.style.willChange = 'transform,opacity,color';
      if (italicChance > 0 && rand(i, 7) < italicChance) sp.style.fontStyle = 'italic';
      this.el.appendChild(sp);
      this.items.push({ el: sp, start: ch.start, end: ch.end });
    }
  };

  CharLine.prototype.update = function (time, accent, opts, transformFn) {
    if (!this.line) return;
    var wordOn = !opts || opts.word !== false;
    var lineP = wordOn ? 0 : LyricTiming.lineProgress(this.line, time);
    for (var i = 0; i < this.items.length; i++) {
      var it = this.items[i];
      var p = wordOn ? LyricTiming.charProgress(it, time) : lineP;
      it.el.style.color = hex(mixNumeric(0xffffff, accent, 0.85 * p));
      it.el.style.opacity = String(0.25 + 0.75 * p);
      if (transformFn) it.el.style.transform = transformFn(p, i, it);
    }
  };

  /* ---------------- 场景基类 ---------------- */

  function Scene(box) {
    this.box = box;
    this.width = window.innerWidth || 800;
    this.height = window.innerHeight || 600;
    this.elapsed = 0;
    this.line = null;
    this.index = -1;
    this.optKey = '';
    this.theme = null;
    this.colors = themeColors(null);
    this.ready = false;
    this.modeId = null;
    this._tuneVer = -1;
    this.common = (typeof LyricTunings !== 'undefined')
      ? LyricTunings.getCommon()
      : { font: 'sans', fontScale: 1, opacity: 1 };
    this.fontScale = this.common.fontScale;
    this.box.style.opacity = this.common.opacity;
    this.box.style.fontFamily = (typeof LyricTunings !== 'undefined') ? LyricTunings.fontStack() : FONT;
  }

  Scene.prototype.optKeyOf = function (opts) {
    opts = opts || {};
    return (opts.word !== false ? 1 : 0) + '|' + (opts.translation !== false ? 1 : 0) + '|' + (opts.nextLine !== false ? 1 : 0);
  };

  Scene.prototype.fs = function (base) {
    var scale = this.noCommonFontScale ? 1 : (this.fontScale || 1);
    return Math.max(10, Math.round(base * scale));
  };

  Scene.prototype.tun = function (key, fallback) {
    if (typeof LyricTunings === 'undefined' || !this.modeId) return fallback;
    var p = LyricTunings.get(this.modeId);
    return p && p[key] != null ? p[key] : fallback;
  };

  Scene.prototype.update = function (dt, s) {
    this.elapsed += Math.min(dt || 0, 0.05);
    this.width = s.width || this.width;
    this.height = s.height || this.height;
    if (typeof LyricTunings !== 'undefined') {
      var common = LyricTunings.getCommon();
      if (common.font !== this.common.font || common.fontScale !== this.common.fontScale || common.opacity !== this.common.opacity) {
        var scaleChanged = common.fontScale !== this.common.fontScale;
        this.common = common;
        this.fontScale = common.fontScale;
        this.box.style.opacity = common.opacity;
        this.box.style.fontFamily = LyricTunings.fontStack();
        if (scaleChanged) this.ready = false;
      }
      if (this.modeId) {
        var ver = LyricTunings.version(this.modeId);
        if (ver !== this._tuneVer) {
          this._tuneVer = ver;
          this.ready = false;
        }
      }
    }
    var themeChanged = !!(s.theme && s.theme !== this.theme);
    if (themeChanged) {
      this.theme = s.theme;
      this.colors = themeColors(s.theme);
    }
    var key = this.optKeyOf(s.opts);
    if (!this.ready || s.line !== this.line || key !== this.optKey) {
      this.ready = true;
      this.line = s.line;
      this.index = s.index;
      this.optKey = key;
      this.onLine(s);
      if (this.applyTheme) this.applyTheme(this.colors);
    } else if (themeChanged && this.applyTheme) {
      this.applyTheme(this.colors);
    }
    this.onFrame(dt, s);
  };

  Scene.prototype.onLine = function () {};
  Scene.prototype.onFrame = function () {};
  Scene.prototype.resize = function (w, h) {
    this.width = w;
    this.height = h;
    if (this.layout) this.layout();
  };
  Scene.prototype.dispose = function () {
    this.box.innerHTML = '';
  };

  /* ================= 静止（对齐 Folia VisualizerStill） ================= */

  function StillScene(box) { Scene.call(this, box); }
  inherit(StillScene, Scene);

  StillScene.prototype.mount = function () {
    // Folia：不渲染背景，只在最上层压一层中心透明的径向暗角
    this.vignette = el('div', 'position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center, transparent 0%, #000 100%);opacity:.65;', this.box);
    this.wrap = el('div', 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:32px;padding:0 48px 64px;pointer-events:none;text-align:center;', this.box);
    this.slots = [];
    for (var i = 0; i < 3; i++) {
      var slot = el('div', 'width:100%;max-width:896px;display:flex;flex-direction:column;align-items:center;', this.wrap);
      var text = el('div', 'line-height:1.25;letter-spacing:.02em;white-space:pre-wrap;', slot);
      var tr = el('div', 'letter-spacing:.02em;white-space:pre-wrap;', slot);
      this.slots.push({ slot: slot, text: text, tr: tr });
    }
  };

  StillScene.prototype.onLine = function (s) {
    if (!this.wrap) this.mount();
    var lines = s.lines || [];
    // Folia 在 currentLineIndex === -1 时沿用上一个有效句
    if (s.index >= 0) this.effIndex = s.index;
    else if (this.effIndex == null) this.effIndex = Math.max(0, s.index);
    var idx = this.effIndex;
    var showTr = !s.opts || s.opts.translation !== false;
    var base = this.noCommonFontScale ? 1 : (this.fontScale || 1);

    for (var k = 0; k < 3; k++) {
      var offset = k - 1;
      var line = lines[idx + offset];
      var view = this.slots[k];
      var isCurrent = offset === 0;
      if (!line) {
        view.slot.style.height = Math.round(80 * base) + 'px';
        setText(view.text, '');
        setText(view.tr, '');
        view.tr.style.display = 'none';
        continue;
      }
      view.slot.style.height = '';
      setText(view.text, line.text || '');
      view.text.style.fontSize = Math.round((isCurrent ? 40 : 30) * base) + 'px';
      view.text.style.fontWeight = isCurrent ? '700' : '600';
      view.text.style.opacity = isCurrent ? '1' : '0.3';
      view.text.style.color = hex(this.colors.primary);
      var trText = showTr ? (line.tr || '') : '';
      setText(view.tr, trText);
      view.tr.style.display = trText ? '' : 'none';
      view.tr.style.fontSize = Math.round((isCurrent ? 24 : 20) * base) + 'px';
      view.tr.style.fontWeight = isCurrent ? '500' : '400';
      view.tr.style.opacity = isCurrent ? '0.8' : '0.3';
      view.tr.style.marginTop = (isCurrent ? 12 : 8) + 'px';
      view.tr.style.color = hex(this.colors.secondary);
    }
  };

  StillScene.prototype.applyTheme = function (c) {
    if (!this.slots || !this.line) return;
    for (var k = 0; k < 3; k++) {
      this.slots[k].text.style.color = hex(c.primary);
      this.slots[k].tr.style.color = hex(c.secondary);
    }
  };

  StillScene.prototype.dispose = function () {
    this.slots = null;
    this.wrap = null;
    Scene.prototype.dispose.call(this);
  };

  /* ================= 流光 ================= */

  function StreamScene(box) { Scene.call(this, box); }
  inherit(StreamScene, Scene);

  /** 流光的分词：中文两字一组，虚词单独成词，西文按空格 */
  function lumiereWords(line) {
    if (!line) return [];
    if (line.words && line.words.length) {
      var list = [];
      for (var i = 0; i < line.words.length; i++) {
        var w = line.words[i];
        if (!w.text || /^\s+$/.test(w.text)) continue;
        list.push({ text: w.text, start: w.start, end: w.end });
      }
      if (list.length > 1) return list;
    }
    var chars = line.chars && line.chars.length ? line.chars : fallbackChars(line);
    var out = [];
    var buffer = '';
    var start = null;
    var end = null;
    var flush = function () {
      if (buffer) out.push({ text: buffer, start: start, end: end });
      buffer = '';
      start = null;
    };
    for (var c = 0; c < chars.length; c++) {
      var ch = chars[c].text || '';
      if (/^\s+$/.test(ch)) { flush(); continue; }
      if (/[，。；！？、…·]/.test(ch)) {
        flush();
        out.push({ text: ch, start: chars[c].start, end: chars[c].end });
        continue;
      }
      if (buffer.length >= 2) flush();
      if (!start) start = chars[c].start;
      buffer += ch;
      end = chars[c].end;
    }
    flush();
    return out;
  }

  var LUMIERE_FUNCTION = '的了在是我你他她它们和与就都也而不很太把被让给对向从到于之其';

  StreamScene.prototype.mount = function () {
    this.dark = el('div', 'position:absolute;inset:0;pointer-events:none;', this.box);
    this.cv = el('canvas', 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;', this.box);
    this.g = this.cv.getContext('2d');
    this.stage = el('div', 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 6%;pointer-events:none;', this.box);
    this.prevEl = el('div', 'position:absolute;left:50%;top:32%;transform:translate(-50%,-50%);white-space:nowrap;opacity:.4;filter:blur(.6px);', this.stage);
    this.curEl = el('div', 'position:relative;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;max-width:78%;', this.stage);
    this.nextEl = el('div', 'position:absolute;left:50%;top:62%;transform:translate(-50%,-50%);white-space:nowrap;opacity:.45;filter:blur(.6px);', this.stage);
    this.sub = el('div', 'position:absolute;left:0;right:0;bottom:8%;text-align:center;padding:0 16px;pointer-events:none;opacity:0;transition:opacity .24s ease-out;', this.box);
    this.subText = el('div', 'font-weight:500;line-height:1.35;', this.sub);
    this.subNext = el('div', 'font-weight:400;line-height:1.35;margin-top:8px;filter:blur(1px);', this.sub);
    this.dust = null;
    this.layout();
  };

  StreamScene.prototype.onLine = function (s) {
    if (!this.cv) this.mount();
    var base = this.noCommonFontScale ? 1 : (this.fontScale || 1);
    var heroPx = Math.round(this.height * 0.085 * base);
    var gap = this.tun('wordGap', 2);
    var seed = (s.line && s.line.t || 0) + 1;
    var rnd = function () { var x = Math.sin(seed++) * 10000; return x - Math.floor(x); };

    this.curEl.textContent = '';
    this.words = [];
    var words = lumiereWords(s.line);
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var single = Array.from(w.text.replace(/\s+/g, '')).length === 1;
      var isFunction = single && LUMIERE_FUNCTION.indexOf(w.text) >= 0;
      var isPunct = /^[，。；！？、…·]+$/.test(w.text);
      var size = isPunct ? 0.62 : (isFunction ? 0.62 : (w.text.length >= 3 ? 1.45 : 0.85 + rnd() * 0.35));
      var span = el('span', 'display:inline-block;white-space:pre;transition:color .25s linear,text-shadow .3s linear,opacity .3s linear;', this.curEl);
      span.textContent = w.text;
      span.style.fontSize = (heroPx * size) + 'px';
      span.style.fontWeight = size >= 1.45 ? '700' : '500';
      span.style.letterSpacing = gap + 'px';
      span.style.margin = '0 0.06em';
      span.style.transform = 'translateY(' + ((rnd() - 0.5) * 0.4 * heroPx).toFixed(1) + 'px)' + (this.tun('wordRotate', false) ? ' rotate(' + ((rnd() - 0.5) * 8).toFixed(1) + 'deg)' : '');
      span.style.color = 'rgba(186,198,220,.22)';
      this.words.push({ el: span, start: w.start, end: w.end, lit: false });
    }

    var basePx = Math.round(heroPx * 0.52);
    if (this.prevEl) {
      this.prevEl.textContent = (prevLine(s) || {}).text || '';
      this.prevEl.style.fontSize = basePx + 'px';
      this.prevEl.style.color = 'rgba(255,255,255,.5)';
    }
    if (this.nextEl) {
      this.nextEl.textContent = nextText(s);
      this.nextEl.style.fontSize = basePx + 'px';
      this.nextEl.style.color = 'rgba(255,255,255,.55)';
    }

    var tr = currentTr(s);
    var nx = nextText(s);
    setText(this.subText, tr);
    setText(this.subNext, nx);
    this.subNext.style.display = nx ? '' : 'none';
    this.sub.style.opacity = (tr || nx) ? '0.6' : '0';
    this.applyTheme(this.colors);
  };

  StreamScene.prototype.layout = function () {
    if (!this.cv) return;
    this.cv.width = Math.max(1, this.width);
    this.cv.height = Math.max(1, this.height);
    this.dark.style.background = 'radial-gradient(120% 90% at 50% 0%, rgba(16,20,34,.72) 0%, rgba(4,6,12,.9) 60%, rgba(1,2,5,.96) 100%)';
  };

  StreamScene.prototype.resize = function (w, h) {
    Scene.prototype.resize.call(this, w, h);
    this.layout();
  };

  StreamScene.prototype.onFrame = function (dt, s) {
    if (!this.g) return;
    var w = this.cv.width, h = this.cv.height;
    var g = this.g;
    var c = this.colors;
    var power = powerOf(s);
    var camSpeed = this.tun('cameraSpeed', 1);
    var lightIntensity = this.tun('lightIntensity', 1);
    var showFrame = this.tun('frame', true);
    var glowMix = mixNumeric(0xffd9a0, c.accent, 0.18);

    if (!this.dust) {
      this.dust = [];
      for (var i = 0; i < 120; i++) {
        this.dust.push({ x: rand(i, 1), y: rand(i, 2), s: 0.4 + rand(i, 3) * 1.4, v: 0.004 + rand(i, 4) * 0.012 });
      }
    }

    g.clearRect(0, 0, w, h);
    var cx = w * 0.5, topY = -h * 0.04;

    // 顶光光束
    g.save();
    g.globalCompositeOperation = 'lighter';
    var beamW = w * 0.34;
    var beam = g.createLinearGradient(0, topY, 0, h * 0.95);
    beam.addColorStop(0, cssRgba(glowMix, 0.3 * lightIntensity * (0.9 + 0.1 * power)));
    beam.addColorStop(0.55, cssRgba(glowMix, 0.09 * lightIntensity));
    beam.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = beam;
    g.beginPath();
    g.moveTo(cx - w * 0.02, topY);
    g.lineTo(cx + w * 0.02, topY);
    g.lineTo(cx + beamW, h * 0.95);
    g.lineTo(cx - beamW, h * 0.95);
    g.closePath();
    g.fill();
    var core = g.createLinearGradient(0, topY, 0, h * 0.8);
    core.addColorStop(0, cssRgba(glowMix, 0.22 * lightIntensity));
    core.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = core;
    g.beginPath();
    g.moveTo(cx - w * 0.004, topY);
    g.lineTo(cx + w * 0.004, topY);
    g.lineTo(cx + w * 0.05, h * 0.85);
    g.lineTo(cx - w * 0.05, h * 0.85);
    g.closePath();
    g.fill();

    // 顶部眩光
    var glare = g.createRadialGradient(cx, topY + h * 0.02, 0, cx, topY + h * 0.02, h * 0.3);
    glare.addColorStop(0, cssRgba(0xfff2d8, 0.55 * lightIntensity));
    glare.addColorStop(0.25, cssRgba(glowMix, 0.22 * lightIntensity));
    glare.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = glare;
    g.beginPath();
    g.arc(cx, topY + h * 0.02, h * 0.3, 0, Math.PI * 2);
    g.fill();
    g.restore();

    // 量角器弧线
    g.strokeStyle = cssRgba(c.accent, 0.1);
    g.lineWidth = 1;
    g.beginPath();
    g.arc(cx, -h * 0.15, h * 0.62, Math.PI * 0.12, Math.PI * 0.88);
    g.stroke();
    for (var t = 0; t < 36; t++) {
      var ta = Math.PI * 0.13 + (t / 35) * Math.PI * 0.74;
      var r1 = h * 0.62;
      var r2 = r1 + (t % 5 === 0 ? 14 : 7);
      g.strokeStyle = cssRgba(c.accent, t % 5 === 0 ? 0.2 : 0.09);
      g.beginPath();
      g.moveTo(cx + Math.cos(ta) * r1, -h * 0.15 + Math.sin(ta) * r1);
      g.lineTo(cx + Math.cos(ta) * r2, -h * 0.15 + Math.sin(ta) * r2);
      g.stroke();
    }

    // 浮尘
    g.globalCompositeOperation = 'lighter';
    for (var d = 0; d < this.dust.length; d++) {
      var p = this.dust[d];
      p.y -= p.v * (0.5 + 0.5 * camSpeed) * (dt || 0.016) * 8;
      if (p.y < -0.05) { p.y = 1.05; p.x = Math.random(); }
      var px = p.x * w + Math.sin(this.elapsed * 0.4 + d) * 8;
      var py = p.y * h;
      var rr = p.s * (0.7 + 0.5 * power);
      g.fillStyle = cssRgba(glowMix, 0.1 + 0.25 * p.s * (0.6 + 0.4 * power));
      g.beginPath();
      g.arc(px, py, rr, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';

    // 取景框
    if (showFrame) {
      var u = Math.min(w, h);
      var arm = u * 0.045;
      var pad = u * 0.035;
      g.strokeStyle = 'rgba(255,255,255,.35)';
      g.lineWidth = Math.max(1.2, u / 600);
      var corners = [[pad, pad, 1, 1], [w - pad, pad, -1, 1], [pad, h - pad, 1, -1], [w - pad, h - pad, -1, -1]];
      for (var ci = 0; ci < 4; ci++) {
        var o = corners[ci];
        g.beginPath();
        g.moveTo(o[0] + arm * o[2], o[1]);
        g.lineTo(o[0], o[1]);
        g.lineTo(o[0], o[1] + arm * o[3]);
        g.stroke();
      }
    }

    // 文字：唱到的词点亮成香槟金
    var litColor = hex(mixNumeric(0xfff0d6, c.accent, 0.2));
    for (var wi = 0; wi < this.words.length; wi++) {
      var it = this.words[wi];
      var lit = s.time >= it.start;
      if (lit !== it.lit) {
        it.lit = lit;
        it.el.style.color = lit ? litColor : 'rgba(186,198,220,.22)';
        it.el.style.textShadow = lit
          ? '0 0 18px ' + cssRgba(glowMix, 0.55) + ', 0 0 48px ' + cssRgba(c.accent, 0.35)
          : 'none';
        it.el.style.opacity = lit ? '1' : '0.9';
      }
    }
    var breath = this.tun('breath', 6);
    this.curEl.style.transform = 'translateY(' + (Math.sin(this.elapsed * 0.9) * breath * 0.5).toFixed(2) + 'px) scale(' + (1 + 0.012 * power).toFixed(3) + ')';
  };

  StreamScene.prototype.applyTheme = function (c) {
    if (this.subText) {
      this.subText.style.color = hex(c.secondary);
      this.subText.style.fontSize = Math.round(clamp(0.022 * this.width, 17, 21) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    }
    if (this.subNext) {
      this.subNext.style.color = hex(c.secondary);
      this.subNext.style.fontSize = Math.round(clamp(0.018 * this.width, 14, 17) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    }
  };

  StreamScene.prototype.dispose = function () {
    this.words = null;
    this.dust = null;
    Scene.prototype.dispose.call(this);
  };

  /* ================= 心象（对齐 Folia Cadenza） ================= */

  function CadenzaScene(box) { Scene.call(this, box); }
  inherit(CadenzaScene, Scene);

  /** 有逐词时序用词，没有就把中文按字、西文按空格切 */
  function cadenzaWords(line) {
    if (!line) return [];
    var out = [];
    if (line.words && line.words.length > 1) {
      for (var i = 0; i < line.words.length; i++) {
        var w = line.words[i];
        if (!w.text || /^\s+$/.test(w.text)) continue;
        out.push({ text: w.text, start: w.start, end: w.end });
      }
      if (out.length) return out;
    }
    var chars = line.chars && line.chars.length ? line.chars : fallbackChars(line);
    var buffer = '';
    var bufferStart = null;
    var bufferEnd = null;
    var flush = function () {
      if (buffer) out.push({ text: buffer, start: bufferStart, end: bufferEnd });
      buffer = '';
      bufferStart = null;
    };
    for (var c = 0; c < chars.length; c++) {
      var ch = chars[c].text || '';
      if (/^\s+$/.test(ch)) {
        flush();
        continue;
      }
      if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(ch) || /[，。；！？、…·]/.test(ch)) {
        flush();
        out.push({ text: ch, start: chars[c].start, end: chars[c].end });
      } else {
        if (!buffer) bufferStart = chars[c].start;
        buffer += ch;
        bufferEnd = chars[c].end;
      }
    }
    flush();
    return out;
  }

  CadenzaScene.prototype.mount = function () {
    this.stage = el('div', 'position:absolute;inset:0;overflow:hidden;pointer-events:none;', this.box);
    this.layer = el('div', 'position:absolute;left:0;top:42%;width:100%;height:0;', this.stage);
    this.heroRing = el('div', 'position:absolute;left:50%;top:0;border-radius:50%;border:1.2px solid transparent;opacity:0;pointer-events:none;', this.layer);
    this.sub = el('div', 'position:absolute;left:0;right:0;bottom:9%;text-align:center;padding:0 16px;pointer-events:none;opacity:0;transition:opacity .24s ease-out;', this.box);
    this.subText = el('div', 'font-weight:500;line-height:1.35;', this.sub);
    this.subNext = el('div', 'font-weight:400;line-height:1.35;margin-top:8px;filter:blur(1px);', this.sub);
  };

  CadenzaScene.prototype.onLine = function (s) {
    if (!this.stage) this.mount();
    this.build(s);
    var tr = currentTr(s);
    var nx = nextText(s);
    setText(this.subText, tr);
    setText(this.subNext, nx);
    this.subNext.style.display = nx ? '' : 'none';
    this.sub.style.opacity = (tr || nx) ? '0.6' : '0';
    this.applyTheme(this.colors);
  };

  CadenzaScene.prototype.build = function (s) {
    var line = s.line;
    var old = this.lineEl;
    if (old && old.parentNode) {
      old.style.transition = 'opacity .3s ease, transform .3s ease, filter .3s ease';
      old.style.opacity = '0';
      old.style.transform = 'scale(1.1)';
      old.style.filter = 'blur(20px)';
      setTimeout(function () { if (old.parentNode) old.parentNode.removeChild(old); }, 320);
    }
    this.items = null;
    this.heroRing.style.opacity = '0';
    if (!line || !line.text) return;

    var base = this.noCommonFontScale ? 1 : (this.fontScale || 1);
    var words = cadenzaWords(line);
    if (!words.length) return;
    var graphemes = Array.from(String(line.text).replace(/\s+/g, '')).length;
    var penalty = Math.min(34, Math.max(0, graphemes - 12) * 1.8) + Math.min(18, Math.max(0, words.length - 7) * 1.5);
    var fontPx = Math.round(clamp(clamp(this.width * 0.086, 34, 94) - penalty, 28, 104) * 1.12 * base);

    var seed = (line.t || 0) + 1;
    var rnd = function () {
      var x = Math.sin(seed++) * 10000;
      return x - Math.floor(x);
    };

    // 主体词：最长的词（同样长取靠中间的），放大并带光环
    var n = words.length;
    var heroIndex = 0;
    var heroLen = 0;
    for (var h = 0; h < n; h++) {
      var len = Array.from(words[h].text.replace(/\s+/g, '')).length;
      if (len > heroLen || (len === heroLen && Math.abs(h - (n - 1) / 2) < Math.abs(heroIndex - (n - 1) / 2))) {
        heroLen = len;
        heroIndex = h;
      }
    }
    var heroScore = clamp(heroLen / Math.max(1, words.length) - 0.48, 0, 0.52);
    var heroScale = 1.46 * (1 + heroScore);
    this.heroIndex = heroIndex;
    this.heroScale = heroScale;

    var layer = el('div', 'position:absolute;left:0;top:0;width:100%;height:0;opacity:0;transform:scale(.9);filter:blur(10px);transition:opacity .42s ease-out,transform .42s ease-out,filter .42s ease-out;', this.layer);
    this.lineEl = layer;
    this.layer.appendChild(this.heroRing);

    this.items = [];
    for (var i = 0; i < n; i++) {
      var t = (i + 1) / n;
      var angle = i * 2.39996 + seed * 0.35;
      var radius = 0.16 + 0.55 * Math.sqrt(t);
      var x = Math.cos(angle) * radius * this.width * 0.34;
      var y = Math.sin(angle) * radius * this.height * 0.3;
      if (i === heroIndex) { x *= 0.35; y *= 0.35; }
      var rot = (rnd() - 0.5) * 12;
      var dirLen = Math.max(1, Math.sqrt(x * x + y * y));
      var node = document.createElement('span');
      node.textContent = words[i].text;
      node.style.cssText = 'position:absolute;left:50%;top:0;display:inline-block;white-space:pre;transform-origin:center;opacity:0;will-change:transform,opacity,filter;transition:opacity .35s ease,color .3s linear,filter .3s linear;';
      node.style.fontSize = fontPx + 'px';
      node.style.fontWeight = '500';
      node.style.color = 'rgba(255,255,255,.9)';
      layer.appendChild(node);
      this.items.push({
        el: node,
        start: words[i].start,
        end: words[i].end,
        x: x,
        y: y,
        rot: rot,
        driftRot: (rnd() - 0.5) * 12,
        dirX: x / dirLen,
        dirY: y / dirLen,
        drift: 5 + rnd() * 6,
        scale: i === heroIndex ? heroScale : 1,
        isHero: i === heroIndex,
        state: ''
      });
    }

    requestAnimationFrame(function () {
      if (!layer.parentNode) return;
      layer.style.opacity = '1';
      layer.style.transform = 'scale(1)';
      layer.style.filter = 'blur(0px)';
    });
  };

  CadenzaScene.prototype.onFrame = function (dt, s) {
    if (!this.items || !this.items.length) return;
    var time = s.time;
    var power = powerOf(s);
    var energy = power;
    var breathe = Math.sin(this.elapsed * 2.3) * (3 + 8 * energy);
    this.layer.style.transform = 'translateY(' + breathe.toFixed(2) + 'px)';

    for (var i = 0; i < this.items.length; i++) {
      var it = this.items[i];
      var state = time > it.end ? 'passed' : (time >= it.start - 0.18 ? 'active' : 'waiting');
      var dx = 0;
      var dy = 0;
      var scale = it.scale;
      var rot = it.rot;
      var opacity = 0;
      var blur = 0;

      if (state === 'waiting') {
        scale = it.scale * 1.05 * 0.5;
        rot = it.rot + 20;
        blur = 10;
      } else if (state === 'active') {
        scale = it.scale * (it.isHero ? 1.3 : 1.18) * (1 + 0.04 * Math.sin(time * 10 + it.start * 5));
        opacity = 1;
      } else {
        var driftP = Math.min(1, (time - it.end) / 5);
        var ease = driftP < 0.5 ? 2 * driftP * driftP : 1 - Math.pow(-2 * driftP + 2, 2) / 2;
        dx = it.dirX * it.drift * ease;
        dy = it.dirY * it.drift * ease;
        rot = it.rot + it.driftRot * ease;
        opacity = 0.82;
      }
      // 词级漂浮
      dx += Math.sin(this.elapsed * 1.2 + i * 0.6) * energy * 4;
      dy += Math.cos(this.elapsed * 1.5 + i * 0.4) * energy * 2.5;

      it.el.style.opacity = opacity.toFixed(2);
      it.el.style.filter = blur > 0.3 ? 'blur(' + blur.toFixed(1) + 'px)' : 'none';
      it.el.style.transform = 'translate(-50%,-50%) translate3d(' + (it.x + dx).toFixed(1) + 'px,' + (it.y + dy).toFixed(1) + 'px,0) rotate(' + rot.toFixed(1) + 'deg) scale(' + scale.toFixed(3) + ')';

      if (state !== it.state) {
        it.state = state;
        if (state === 'active') {
          it.el.style.color = this.colors.accentCss;
          it.el.style.textShadow = '0 0 12px ' + cssRgba(this.colors.accent, 0.9) + ', 0 0 40px ' + cssRgba(this.colors.accent, 0.7) + ', 0 0 80px ' + cssRgba(this.colors.accent, 0.35);
        } else if (state === 'passed') {
          it.el.style.color = 'rgba(255,255,255,.9)';
          it.el.style.textShadow = '0 0 10px ' + cssRgba(this.colors.primary, 0.25);
        } else {
          it.el.style.color = 'rgba(255,255,255,.9)';
          it.el.style.textShadow = 'none';
        }
      }
    }

    // 主体词的扩散描边
    var hero = this.items[this.heroIndex];
    if (hero && hero.state === 'active') {
      var p = clamp((time - hero.start) / Math.max(0.4, hero.end - hero.start), 0, 1);
      var radius = 46 * this.heroScale * (0.55 + 0.45 * p);
      this.heroRing.style.width = radius * 2 + 'px';
      this.heroRing.style.height = radius * 2 + 'px';
      this.heroRing.style.borderColor = this.colors.accentCss;
      this.heroRing.style.opacity = (0.45 * (1 - p)).toFixed(2);
      this.heroRing.style.transform = 'translate(-50%,-50%) translate3d(' + (hero.x + Math.sin(this.elapsed * 1.2 + this.heroIndex * 0.6) * energy * 4).toFixed(1) + 'px,' + (hero.y + Math.cos(this.elapsed * 1.5 + this.heroIndex * 0.4) * energy * 2.5).toFixed(1) + 'px,0)';
    } else {
      this.heroRing.style.opacity = '0';
    }
  };

  CadenzaScene.prototype.resize = function (w, h) {
    Scene.prototype.resize.call(this, w, h);
    this.ready = false;
  };

  CadenzaScene.prototype.applyTheme = function (c) {
    if (this.items) {
      for (var i = 0; i < this.items.length; i++) {
        var it = this.items[i];
        if (it.state === 'active') it.el.style.color = c.accentCss;
        else it.el.style.color = 'rgba(255,255,255,.9)';
      }
    }
    if (this.subText) {
      this.subText.style.color = hex(c.secondary);
      this.subText.style.fontSize = Math.round(clamp(0.02 * this.width, 18, 21) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    }
    if (this.subNext) {
      this.subNext.style.color = hex(c.secondary);
      this.subNext.style.fontSize = Math.round(clamp(0.016 * this.width, 14, 17) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    }
  };

  CadenzaScene.prototype.dispose = function () {
    this.items = null;
    Scene.prototype.dispose.call(this);
  };

  /* ================= 云阶（对齐 Folia VisualizerPartita） ================= */

  function PartitaScene(box) { Scene.call(this, box); }
  inherit(PartitaScene, Scene);

  /**
   * Folia 的布局单位：有逐词时序就用词，没有就按两个字符一组切。
   * 每个单位在画面里是一个“词块”，若干词块组成一行阶梯。
   */
  function partitaUnits(line) {
    if (!line) return [];
    var out = [];
    if (line.words && line.words.length) {
      for (var i = 0; i < line.words.length; i++) {
        var w = line.words[i];
        if (!w.text) continue;
        out.push({ text: w.text, start: w.start, end: w.end });
      }
      if (out.length) return out;
    }
    var chars = line.chars && line.chars.length ? line.chars : fallbackChars(line);
    for (var c = 0; c < chars.length; c += 2) {
      var b = chars[c + 1];
      out.push({
        text: (chars[c].text || '') + (b ? (b.text || '') : ''),
        start: chars[c].start,
        end: b ? b.end : chars[c].end
      });
    }
    return out;
  }

  PartitaScene.prototype.mount = function () {
    this.stage = el('div', 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:32px;pointer-events:none;', this.box);
    this.floatEl = el('div', 'position:relative;display:flex;align-items:center;justify-content:center;width:100%;max-width:1024px;gap:2rem;transform-origin:center;', this.stage);
    this.sub = el('div', 'position:absolute;left:0;right:0;bottom:9%;text-align:center;padding:0 16px;pointer-events:none;opacity:0;transition:opacity .24s ease-out;', this.box);
    this.subText = el('div', 'font-weight:500;line-height:1.35;', this.sub);
    this.subNext = el('div', 'font-weight:400;line-height:1.35;margin-top:8px;filter:blur(1px);', this.sub);
  };

  PartitaScene.prototype.onLine = function (s) {
    if (!this.stage) this.mount();
    this.build(s);
    var tr = currentTr(s);
    var nx = nextText(s);
    setText(this.subText, tr);
    setText(this.subNext, nx);
    this.subNext.style.display = nx ? '' : 'none';
    this.sub.style.opacity = (tr || nx) ? '0.6' : '0';
    this.applyTheme(this.colors);
  };

  PartitaScene.prototype.build = function (s) {
    var line = s.line;
    var self = this;
    var base = this.noCommonFontScale ? 1 : (this.fontScale || 1);
    var old = this.lineEl;
    if (old && old.parentNode) {
      old.style.transition = 'opacity .3s ease-out';
      old.style.opacity = '0';
      setTimeout(function () { if (old.parentNode) old.parentNode.removeChild(old); }, 320);
    }
    this.lineEl = null;
    this.rows = [];
    if (!line || !line.text) return;

    var units = partitaUnits(line);
    if (!units.length) return;
    var totalGraphemes = Math.max(Array.from((line.text || '').replace(/\s+/g, '')).length, units.length, 1);
    var density = totalGraphemes > 40 ? 0.8 : 1;
    var px = Math.round(clamp(0.055 * this.width, 40, 72) * density * base);
    this.mainPx = px;

    var maxRows = Math.max(1, Math.floor(this.height * 0.65 / 100));
    var rowCount = Math.min(units.length, maxRows);
    var seed = (line.t || 0) + 1;
    var rnd = function () {
      var x = Math.sin(seed++) * 10000;
      return x - Math.floor(x);
    };

    // 与 Folia 一样故意切得不均匀：整整齐齐的等分会显得机械，失去手写谱面的感觉。
    var chunks = [];
    var remainingUnits = units.length;
    var remainingChunks = rowCount;
    var unitIndex = 0;
    for (var c = 0; c < rowCount; c++) {
      var isLast = c === rowCount - 1;
      var avg = remainingUnits / remainingChunks;
      var len = 1;
      if (isLast) {
        len = remainingUnits;
      } else {
        var maxLen = Math.ceil(avg * 1.5);
        len = Math.max(1, Math.min(maxLen, Math.round(avg + (rnd() - 0.5) * avg)));
      }
      len = Math.max(1, Math.min(len, remainingUnits - (remainingChunks - 1)));
      chunks.push(units.slice(unitIndex, unitIndex + len));
      unitIndex += len;
      remainingUnits -= len;
      remainingChunks--;
    }

    var column = el('div', 'position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:384px;min-width:61px;padding:0 12px;', this.floatEl);
    this.lineEl = column;

    var minOff = this.tun('offsetMin', 4);
    var maxOff = Math.max(minOff, this.tun('offsetMax', 14));
    var showGuides = this.tun('guide', true) !== false;

    for (var r = 0; r < chunks.length; r++) {
      var words = chunks[r];
      if (!words.length) continue;
      var rowBias = r - (chunks.length - 1) / 2;
      var staggeredLeft = r % 2 === 0;
      var magnitude = minOff + rnd() * (maxOff - minOff);
      var cfg = {
        x: staggeredLeft ? -magnitude : magnitude,
        y: rowBias * 2.5,
        rotate: 0,
        scale: 0.85 + rnd() * 0.55,
        passedRotate: (r % 2 === 0 ? 1 : -1) * 3
      };

      var rowEl = el('div', 'position:relative;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;line-height:1;padding:.2rem .5rem;transform-origin:center;will-change:transform,opacity;opacity:0;', column);
      // 行高跟着这一行的缩放走，避免放大后的字压到上一行
      rowEl.style.height = Math.round(px * cfg.scale * 1.08) + 'px';
      rowEl.style.marginBottom = Math.round(px * 0.14) + 'px';
      var guideV = null;
      var guideH = null;
      if (showGuides) {
        guideV = el('span', 'position:absolute;width:1px;height:32px;bottom:-16px;background:rgba(255,255,255,.14);pointer-events:none;transform-origin:bottom;transition:background .3s,box-shadow .3s,transform .4s ease-out,opacity .4s ease-out;' + (staggeredLeft ? 'left:-8px;' : 'right:-8px;'), rowEl);
        guideH = el('span', 'position:absolute;height:1px;bottom:-8px;width:calc(100% + 36px);background:rgba(255,255,255,.14);pointer-events:none;transition:background .3s,box-shadow .3s,transform .4s ease-out,opacity .4s ease-out;' + (staggeredLeft ? 'left:-16px;transform-origin:left;' : 'right:-16px;transform-origin:right;'), rowEl);
        guideV.style.transform = 'scaleY(0)';
        guideV.style.opacity = '0';
        guideH.style.transform = 'scaleX(0)';
        guideH.style.opacity = '0';
      }

      var wordEls = [];
      for (var w = 0; w < words.length; w++) {
        var word = words[w];
        var wSeed = (words[0].start || 0) + w * 7.13;
        var wr = function (offset) {
          var x = Math.sin(wSeed + offset) * 10000;
          return x - Math.floor(x);
        };
        var sp = document.createElement('span');
        sp.textContent = word.text;
        sp.style.cssText = 'display:inline-block;white-space:pre;margin-inline-end:.8rem;transform-origin:center;will-change:transform,opacity,color,filter;transition:opacity .35s ease,transform .45s cubic-bezier(.2,.9,.25,1.1),color .25s linear,filter .25s linear;';
        sp.style.fontSize = px + 'px';
        sp.style.fontWeight = '700';
        sp.style.color = '#ffffff';
        rowEl.appendChild(sp);
        wordEls.push({
          el: sp,
          start: word.start,
          end: word.end,
          x: (wr(1) - 0.5) * 12,
          y: (wr(2) - 0.5) * 12,
          r: (wr(3) - 0.5) * 6,
          pr: (wr(8) - 0.5) * 20,
          state: ''
        });
      }

      this.rows.push({
        el: rowEl,
        guideV: guideV,
        guideH: guideH,
        words: wordEls,
        cfg: cfg,
        left: staggeredLeft,
        start: words[0].start,
        end: words[words.length - 1].end,
        state: ''
      });
    }
  };

  PartitaScene.prototype.onFrame = function (dt, s) {
    if (!this.rows || !this.rows.length) return;
    var time = s.time;
    var accent = this.colors.accentCss;
    for (var i = 0; i < this.rows.length; i++) {
      var row = this.rows[i];
      var status = time > row.end + 0.05 ? 'passed' : (time >= row.start - 0.12 ? 'active' : 'waiting');
      if (status !== row.state) {
        row.state = status;
        row.el.style.transition = status === 'active'
          ? 'transform .5s cubic-bezier(.2,.9,.25,1.1),opacity .1s linear'
          : 'transform .4s ease-out,opacity .4s ease-out';
        row.el.style.opacity = status === 'waiting' ? '0' : '1';
        row.el.style.transform = 'translate3d(' + (row.cfg.x + (status === 'waiting' ? (row.left ? -40 : 40) : 0)).toFixed(1) + 'px,' + row.cfg.y.toFixed(1) + 'px,0) rotate(' + row.cfg.rotate + 'deg) scale(' + (status === 'waiting' ? 0.85 : 1) + ')';
        if (row.guideV) {
          var gcol = status === 'active' ? 'rgba(255,255,255,.55)' : (status === 'passed' ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.14)');
          row.guideV.style.background = gcol;
          row.guideH.style.background = gcol;
          row.guideV.style.boxShadow = status === 'active' ? '0 0 10px ' + cssRgba(this.colors.accent, 0.35) : 'none';
          row.guideH.style.boxShadow = status === 'active' ? '0 0 10px ' + cssRgba(this.colors.accent, 0.28) : 'none';
          row.guideV.style.opacity = status === 'waiting' ? '0' : '1';
          row.guideH.style.opacity = status === 'waiting' ? '0' : '1';
          row.guideV.style.transform = status === 'waiting' ? 'scaleY(0)' : 'scaleY(1)';
          row.guideH.style.transform = status === 'waiting' ? 'scaleX(0)' : 'scaleX(1)';
        }
      }
      for (var w = 0; w < row.words.length; w++) {
        var it = row.words[w];
        var st = time > it.end ? 'passed' : (time >= it.start - 0.12 ? 'active' : 'waiting');
        if (st === it.state) continue;
        it.state = st;
        if (st === 'waiting') {
          it.el.style.opacity = '0';
          it.el.style.filter = 'blur(10px)';
          it.el.style.color = '#ffffff';
          it.el.style.textShadow = 'none';
          it.el.style.transform = 'translate3d(' + (it.x + Math.sin(it.y) * 100).toFixed(1) + 'px,' + (it.y + Math.cos(it.x) * 50).toFixed(1) + 'px,0) rotate(' + (it.r + 20).toFixed(1) + 'deg) scale(.5)';
        } else if (st === 'active') {
          it.el.style.opacity = '1';
          it.el.style.filter = 'none';
          it.el.style.color = accent;
          it.el.style.textShadow = '0 0 18px ' + cssRgba(this.colors.accent, 0.35);
          it.el.style.transform = 'translate3d(' + it.x.toFixed(1) + 'px,' + it.y.toFixed(1) + 'px,0) rotate(' + it.r.toFixed(1) + 'deg) scale(' + (row.cfg.scale * 1.4).toFixed(3) + ')';
        } else {
          it.el.style.opacity = '0.82';
          it.el.style.filter = 'none';
          it.el.style.color = '#ffffff';
          it.el.style.textShadow = 'none';
          it.el.style.transform = 'translate3d(' + it.x.toFixed(1) + 'px,' + it.y.toFixed(1) + 'px,0) rotate(' + (it.r + it.pr).toFixed(1) + 'deg) scale(' + row.cfg.scale.toFixed(3) + ')';
        }
      }
    }

    // 整行缓慢浮动：14px / 7s，像悬在云层上
    var loop = 7;
    var p = (this.elapsed % loop) / loop;
    var sn = Math.sin(p * Math.PI * 2);
    var dist = sn >= 0 ? 14 : 14 * 0.45;
    var scale = 1 + (sn >= 0 ? 0.01 * sn : 0.005 * sn);
    if (this.floatEl) this.floatEl.style.transform = 'translateY(' + (-sn * dist).toFixed(2) + 'px) scale(' + scale.toFixed(4) + ')';
  };

  // 字号按视口宽算，窗口尺寸变了要重建一次
  PartitaScene.prototype.resize = function (w, h) {
    Scene.prototype.resize.call(this, w, h);
    this.ready = false;
  };

  PartitaScene.prototype.applyTheme = function (c) {
    if (!this.rows) return;
    for (var i = 0; i < this.rows.length; i++) {
      var words = this.rows[i].words;
      for (var w = 0; w < words.length; w++) {
        var it = words[w];
        it.el.style.color = it.state === 'active' ? c.accentCss : '#ffffff';
      }
    }
    if (this.subText) this.subText.style.color = hex(c.secondary);
    if (this.subNext) this.subNext.style.color = hex(c.secondary);
    if (this.subText) this.subText.style.fontSize = Math.round(clamp(0.022 * this.width, 17, 19) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    if (this.subNext) this.subNext.style.fontSize = Math.round(clamp(0.018 * this.width, 14, 16) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
  };

  PartitaScene.prototype.dispose = function () {
    this.rows = null;
    this.floatEl = null;
    Scene.prototype.dispose.call(this);
  };

  /* ================= 群唱 ================= */

  function CappellaScene(box) { Scene.call(this, box); }
  inherit(CappellaScene, Scene);

  function cappellaTime(sec) {
    var s = Math.max(0, Math.round(sec || 0));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  CappellaScene.prototype.mount = function () {
    this.stage = el('div', 'position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;padding:48px 24px 21%;pointer-events:none;overflow:hidden;', this.box);
    this.feed = el('div', 'position:relative;width:100%;max-width:896px;display:flex;flex-direction:column;justify-content:flex-end;gap:12px;', this.stage);
    this.sub = el('div', 'position:absolute;left:0;right:0;bottom:7%;text-align:center;padding:0 16px;pointer-events:none;opacity:0;transition:opacity .24s ease-out;', this.box);
    this.subText = el('div', 'font-weight:500;line-height:1.35;', this.sub);
    this.subNext = el('div', 'font-weight:400;line-height:1.35;margin-top:8px;filter:blur(1px);', this.sub);
  };

  CappellaScene.prototype.onLine = function (s) {
    if (!this.stage) this.mount();
    this.build(s);
    var tr = currentTr(s);
    var nx = nextText(s);
    setText(this.subText, tr);
    setText(this.subNext, nx);
    this.subNext.style.display = nx ? '' : 'none';
    this.sub.style.opacity = (tr || nx) ? '0.6' : '0';
    this.applyTheme(this.colors);
  };

  CappellaScene.prototype.build = function (s) {
    var lines = s.lines || [];
    this.feed.textContent = '';
    this.activeBubble = null;
    this.activeChars = [];
    this.emojiEl = null;
    if (s.index < 0 || !lines.length) return;

    var base = this.noCommonFontScale ? 1 : (this.fontScale || 1);
    var baseFont = clamp(18 * base, 15, 26);
    var avatarSource = this.tun('avatarSource', 'builtin');
    var avatarSrc = this.tun('customAvatar', '');
    var from = Math.max(0, s.index - 5);

    for (var i = from; i <= s.index; i++) {
      var line = lines[i];
      if (!line || !line.text) continue;
      var isActive = i === s.index;
      var right = i % 2 === 1;
      var bubbleMix = right
        ? mixNumeric(this.colors.accent, this.colors.primary, 0.18)
        : mixNumeric(this.colors.secondary, this.colors.accent, 0.2 + (i % 9) / 8 * 0.6);
      var bubbleBg = right ? bubbleMix : mixNumeric(bubbleMix, this.colors.bg, 0.25);
      var bubbleBorder = mixNumeric(bubbleBg, 0xffffff, 0.22);
      var bubbleFg = right ? hex(this.colors.bg) : '#ffffff';

      var row = el('div', 'display:flex;align-items:flex-end;gap:12px;width:100%;justify-content:' + (right ? 'flex-end' : 'flex-start') + ';', this.feed);
      var group = el('div', 'display:flex;align-items:flex-end;gap:12px;max-width:68%;transform-origin:' + (right ? 'right bottom' : 'left bottom') + ';transition:transform .3s cubic-bezier(.2,.9,.25,1.1),opacity .3s ease;', row);

      var bubble = el('div', 'position:relative;display:flex;align-items:flex-start;', group);
      bubble.style.background = hex(bubbleBg);
      bubble.style.border = '1px solid ' + cssRgba(bubbleBorder, 0.3);
      bubble.style.color = bubbleFg;
      bubble.style.boxShadow = isActive
        ? '0 18px 48px ' + cssRgba(mixNumeric(this.colors.bg, this.colors.accent, 0.2), 0.34)
        : '0 8px 24px rgba(0,0,0,.28)';
      bubble.style.borderRadius = '24px';
      bubble.style.borderBottomLeftRadius = right ? '24px' : '6px';
      bubble.style.borderBottomRightRadius = right ? '6px' : '24px';
      bubble.style.padding = isActive ? '16px 20px' : '12px 16px';
      bubble.style.minHeight = (isActive ? 64 : 44) + 'px';
      bubble.style.minWidth = isActive ? '72px' : '0';
      bubble.style.maxWidth = Math.max(96, Math.floor(Math.min(this.width - 32, 896) * (this.width >= 640 ? 0.68 : 0.78) - 56)) + 'px';

      var text = el('div', 'line-height:1.45;word-break:break-word;', bubble);
      text.style.fontSize = Math.round(baseFont * (isActive ? 1.34 : 0.94)) + 'px';
      text.style.fontWeight = '500';

      if (isActive) {
        var chars = line.chars && line.chars.length ? line.chars : fallbackChars(line);
        for (var c = 0; c < chars.length; c++) {
          if (chars[c].text === undefined) continue;
          var chSpan = document.createElement('span');
          chSpan.textContent = chars[c].text;
          if (chars[c].text === '') continue;
          chSpan.style.cssText = 'opacity:0;transition:opacity .22s ease-out;';
          text.appendChild(chSpan);
          this.activeChars.push({ el: chSpan, start: chars[c].start });
        }
        this.activeBubble = group;
      } else {
        text.textContent = line.text;
      }

      // 时间戳贴在气泡外侧
      var stamp = el('div', 'position:absolute;bottom:4px;font-size:11px;font-weight:500;color:rgba(255,255,255,.62);white-space:nowrap;', group);
      stamp.textContent = cappellaTime(line.t);
      stamp.style[right ? 'right' : 'left'] = 'calc(100% + 8px)';

      // 头像
      var avatar = el('div', 'width:40px;height:40px;border-radius:50%;flex:0 0 40px;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:#fff;border:1px solid rgba(255,255,255,.24);box-shadow:0 8px 24px rgba(0,0,0,.35);background-size:cover;background-position:center;overflow:hidden;', group);
      if (right) bubble.parentNode.insertBefore(avatar, bubble.nextSibling);
      if (avatarSource === 'custom' && avatarSrc) {
        avatar.style.backgroundImage = 'url(' + avatarSrc + ')';
      } else if (avatarSource === 'cover' && s.coverUrl) {
        avatar.style.backgroundImage = 'url(' + s.coverUrl + ')';
      } else {
        avatar.textContent = Array.from(line.text)[0] || '♪';
        avatar.style.background = avatarSource === 'theme'
          ? 'linear-gradient(135deg, ' + hex(this.colors.accent) + ', ' + hex(this.colors.secondary) + ')'
          : 'linear-gradient(135deg, ' + hex(this.colors.primary) + ', ' + hex(this.colors.secondary) + ')';
      }

      if (isActive) {
        group.style.transform = 'scale(1.12)';
        if (this.tun('showEmoji', true)) {
          this.emojiEl = el('div', 'position:absolute;top:-14px;' + (right ? 'right:-8px;' : 'left:-8px;') + 'font-size:20px;opacity:.9;pointer-events:none;', bubble);
          var emojiSrc = this.tun('customEmoji', '');
          if (this.tun('emojiSource', 'builtin') === 'custom' && emojiSrc) {
            var im = el('img', 'width:26px;height:26px;object-fit:contain;display:block;', this.emojiEl);
            im.src = emojiSrc;
          } else {
            this.emojiEl.textContent = '✨';
          }
        }
      } else {
        group.style.transform = 'scale(.92)';
        group.style.opacity = '0.82';
      }

      // 新的一条从上往下浮入
      if (i === s.index) {
        row.style.opacity = '0';
        row.style.transform = 'translateY(22px)';
        row.style.transition = 'opacity .32s ease-out,transform .32s ease-out';
        requestAnimationFrame(function (target) {
          return function () {
            if (!target.parentNode) return;
            target.style.opacity = '1';
            target.style.transform = 'translateY(0px)';
          };
        }(row));
      }
    }
  };

  CappellaScene.prototype.onFrame = function (dt, s) {
    var power = powerOf(s);
    if (this.activeBubble) {
      this.activeBubble.style.transform = 'scale(' + (1.12 + 0.012 * power).toFixed(3) + ')';
    }
    for (var i = 0; i < this.activeChars.length; i++) {
      var c = this.activeChars[i];
      if (c.el.style.opacity !== '1' && s.time >= c.start) c.el.style.opacity = '1';
    }
    if (this.emojiEl) this.emojiEl.style.opacity = (0.35 + 0.65 * power).toFixed(2);
  };

  CappellaScene.prototype.resize = function (w, h) {
    Scene.prototype.resize.call(this, w, h);
    this.ready = false;
  };

  CappellaScene.prototype.applyTheme = function (c) {
    if (this.subText) {
      this.subText.style.color = hex(c.secondary);
      this.subText.style.fontSize = Math.round(clamp(0.02 * this.width, 18, 21) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    }
    if (this.subNext) {
      this.subNext.style.color = hex(c.secondary);
      this.subNext.style.fontSize = Math.round(clamp(0.016 * this.width, 14, 17) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    }
  };

  CappellaScene.prototype.dispose = function () {
    this.activeChars = [];
    this.activeBubble = null;
    Scene.prototype.dispose.call(this);
  };

  /* ================= 倾诉（对齐 Folia VisualizerTilt） ================= */

  function TiltScene(box) { Scene.call(this, box); }
  inherit(TiltScene, Scene);

  function tiltRandom(seed, offset) {
    var x = Math.sin(seed * 1000 + offset) * 10000;
    return x - Math.floor(x);
  }

  /** Folia 的行数判定：字数取对数 × 种子抖动 × 分行概率，落到四档阈值 */
  function tiltLineCount(charCount, seed, splitProbability) {
    var normalized = Math.log(charCount + 4) / Math.log(24);
    var jitter = tiltRandom(seed, 1) * 0.6 + 0.7;
    var score = normalized * jitter * splitProbability;
    if (score < 0.45) return 1;
    if (score < 1.05) return 2;
    if (score < 1.7) return 3;
    return 4;
  }

  /** 先按标点切句，不够目标行数时再对最长的一段二分 */
  function tiltSegments(text, target) {
    var re = /[，。；！？、…·\.\,\;\!\?]+/g;
    var segs = [];
    var last = 0;
    var m;
    while ((m = re.exec(text))) {
      var end = m.index + m[0].length;
      var tail = text.slice(end).match(/^\s+/);
      var spaces = tail ? tail[0] : '';
      var before = text.slice(last, m.index);
      if (before.length) segs.push(before + m[0] + spaces);
      else if (segs.length) segs[segs.length - 1] += m[0] + spaces;
      else segs.push(m[0] + spaces);
      last = end + spaces.length;
    }
    if (last < text.length) segs.push(text.slice(last));
    segs = segs.map(function (s) { return s.trim(); }).filter(Boolean);
    if (!segs.length) segs = [text];

    var guard = 0;
    while (segs.length < target && guard++ < 8) {
      var longest = 0;
      var at = -1;
      for (var i = 0; i < segs.length; i++) {
        if (segs[i].length > longest) { longest = segs[i].length; at = i; }
      }
      if (at < 0 || longest < 2) break;
      var s = segs[at];
      var cut = Math.ceil(s.length / 2);
      segs.splice(at, 1, s.slice(0, cut), s.slice(cut));
    }
    return segs;
  }

  function measureTextWidth(text, px, weight, italic) {
    if (!TiltScene._ctx) {
      var cv = document.createElement('canvas');
      TiltScene._ctx = cv.getContext('2d');
    }
    var stack = (typeof LyricTunings !== 'undefined') ? LyricTunings.fontStack() : FONT;
    TiltScene._ctx.font = (italic ? 'italic ' : '') + weight + ' ' + px + 'px ' + stack;
    return TiltScene._ctx.measureText(text).width;
  }

  TiltScene.prototype.mount = function () {
    this.stage = el('div', 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:32px;pointer-events:none;', this.box);
    this.sub = el('div', 'position:absolute;left:0;right:0;bottom:9%;text-align:center;padding:0 16px;pointer-events:none;opacity:0;transition:opacity .24s ease-out;', this.box);
    this.subText = el('div', 'font-weight:500;line-height:1.35;', this.sub);
    this.subNext = el('div', 'font-weight:400;line-height:1.35;margin-top:8px;filter:blur(1px);', this.sub);
  };

  TiltScene.prototype.onLine = function (s) {
    if (!this.stage) this.mount();
    this.build(s);
    var tr = currentTr(s);
    var nx = nextText(s);
    setText(this.subText, tr);
    setText(this.subNext, nx);
    this.subNext.style.display = nx ? '' : 'none';
    this.sub.style.opacity = (tr || nx) ? '0.6' : '0';
    this.applyTheme(this.colors);
  };

  TiltScene.prototype.build = function (s) {
    var line = s.line;
    var old = this.lineEl;
    if (old && old.parentNode) {
      old.style.opacity = '0';
      setTimeout(function () { if (old.parentNode) old.parentNode.removeChild(old); }, 460);
    }
    this.lineEl = null;
    this.segments = [];
    if (!line || !line.text) return;

    var base = this.noCommonFontScale ? 1 : (this.fontScale || 1);
    var seed = line.t || 0;
    var splitProbability = this.tun('splitProbability', this.tun('breakChance', 0.75));
    var tiltProbability = this.tun('tiltStyleProbability', this.tun('italicChance', 0.35));
    var colorMode = this.tun('colorMode', 'duo');

    var target = tiltLineCount(line.text.length, seed, splitProbability);
    var texts = tiltSegments(line.text, target);
    var tiltIndex = -1;
    var candidates = [];
    for (var i = 0; i < texts.length; i++) {
      if (tiltRandom(seed, 100 + i) < tiltProbability) candidates.push(i);
    }
    if (candidates.length) tiltIndex = candidates[Math.floor(tiltRandom(seed, 200) * candidates.length)];

    // 末尾很短的一行稍微放大，避免视觉上塌下去
    var shortLast = false;
    if (texts.length > 1 && tiltIndex !== texts.length - 1) {
      var lastText = texts[texts.length - 1];
      var prevText = texts[texts.length - 2];
      if (lastText.length <= 2 && lastText.length * 2 <= prevText.length) shortLast = true;
    }

    var basePx = Math.min(this.width * 0.06875, 90) * base;
    var available = Math.max(320, this.width * 0.85);
    var widest = 0;
    for (var w = 0; w < texts.length; w++) {
      var isTilt = w === tiltIndex;
      var width = measureTextWidth(texts[w], basePx, isTilt ? 300 : 400, isTilt);
      if (width > widest) widest = width;
    }
    var scaleMul = widest > available ? Math.max(0.5, available / widest) : 1;

    // 把行内逐字时序按顺序分给各段
    var chars = line.chars && line.chars.length ? line.chars : fallbackChars(line);
    var cursor = 0;
    var timings = texts.map(function (text) {
      var need = Array.from(text.replace(/\s+/g, '')).length;
      var first = null;
      var lastCh = null;
      var taken = 0;
      while (cursor < chars.length && taken < need) {
        var ch = chars[cursor++];
        if (/^\s+$/.test(ch.text)) continue;
        if (!first) first = ch;
        lastCh = ch;
        taken++;
      }
      return {
        start: first ? first.start : line.t,
        end: lastCh ? lastCh.end : line.timingEnd
      };
    });

    var col = el('div', 'position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;opacity:0;transition:opacity .45s ease-in-out;', this.stage);
    this.lineEl = col;
    requestAnimationFrame(function () { if (col.parentNode) col.style.opacity = '1'; });

    for (var k = 0; k < texts.length; k++) {
      var isTiltLine = k === tiltIndex;
      var boost = (!isTiltLine && shortLast && k === texts.length - 1) ? 1.18 : 1;
      var px = basePx * scaleMul * boost;
      var tiltPx = Math.min(this.width * 0.06875 * scaleMul, 90 * base * scaleMul);
      var yOffset = tiltPx / 6;
      var lineEl = el('div', 'white-space:nowrap;text-align:center;opacity:0;transform:translateY(' + (isTiltLine ? 24 : 20) + 'px)' + (isTiltLine ? ' scale(.92)' : '') + ';transition:opacity .55s cubic-bezier(.25,.46,.45,.94),transform .55s cubic-bezier(.25,.46,.45,.94);', col);
      lineEl.style.fontSize = px + 'px';
      lineEl.style.fontWeight = isTiltLine ? '300' : '400';
      lineEl.style.letterSpacing = isTiltLine ? '0.15em' : '0.08em';
      lineEl.style.lineHeight = isTiltLine ? '1.25' : '1.35';
      lineEl.style.fontStyle = isTiltLine ? 'italic' : 'normal';
      lineEl.style.color = getTiltColor(isTiltLine, colorMode, this.colors);

      var graphemes = Array.from(texts[k]);
      var charsView = [];
      var visualIndex = 0;
      for (var g = 0; g < graphemes.length; g++) {
        var isSpace = /^\s+$/.test(graphemes[g]);
        var stagger = visualIndex % 2 === 0 ? -1 : 1;
        var ci = visualIndex;
        if (!isSpace) visualIndex++;
        var span = document.createElement('span');
        span.textContent = isSpace ? '\u00A0' : graphemes[g];
        span.style.cssText = 'display:inline-block;opacity:0;transition:opacity .5s cubic-bezier(.25,.46,.45,.94),transform .06s ease-out;';
        span.style.transitionDelay = (!isSpace ? (ci * (isTiltLine ? 0.05 : 0.04)) : 0) + 's,0s';
        if (isSpace) span.style.minWidth = isTiltLine ? '0.35em' : '0.25em';
        if (isTiltLine) span.style.transform = 'translateY(' + (isSpace ? 0 : stagger * yOffset * 2).toFixed(1) + 'px)';
        lineEl.appendChild(span);
        charsView.push({
          el: span,
          isSpace: isSpace,
          tiltY: isTiltLine && !isSpace ? stagger * yOffset : 0,
          charTiming: null,
          scale: 1
        });
      }
      this.segments.push({
        el: lineEl,
        tilt: isTiltLine,
        start: timings[k].start,
        end: timings[k].end,
        chars: charsView,
        visible: false
      });
    }

    // 逐字时序：按段内字符顺序对齐到该段的原始字符窗口
    var charCursor = 0;
    for (var si = 0; si < this.segments.length; si++) {
      var seg = this.segments[si];
      for (var c = 0; c < seg.chars.length; c++) {
        var view = seg.chars[c];
        if (view.isSpace) continue;
        while (charCursor < chars.length && /^\s+$/.test(chars[charCursor].text)) charCursor++;
        view.charTiming = chars[charCursor] || null;
        charCursor++;
      }
    }
  };

  function getTiltColor(isTilt, mode, c) {
    if (mode === 'gradient') return c.accentCss;
    if (mode === 'mono') return '#ffffff';
    return isTilt ? c.accentCss : '#ffffff';
  }

  TiltScene.prototype.onFrame = function (dt, s) {
    if (!this.segments || !this.segments.length) return;
    var time = s.time;
    var line = this.line;
    var visibleUntil = -1;
    for (var i = 0; i < this.segments.length; i++) {
      if (time >= this.segments[i].start - 0.25) visibleUntil = i;
    }
    if (line && (time < line.t - 0.1 || time > (line.end || line.timingEnd))) visibleUntil = -1;

    for (var k = 0; k < this.segments.length; k++) {
      var seg = this.segments[k];
      var shouldShow = k <= visibleUntil;
      if (shouldShow !== seg.visible) {
        seg.visible = shouldShow;
        seg.el.style.opacity = shouldShow ? '1' : '0';
        seg.el.style.transform = shouldShow ? 'translateY(0px) scale(1)' : ('translateY(' + (seg.tilt ? 24 : 20) + 'px)' + (seg.tilt ? ' scale(.92)' : ''));
        for (var c = 0; c < seg.chars.length; c++) {
          seg.chars[c].el.style.opacity = shouldShow ? '1' : '0';
        }
      }
      if (!shouldShow) continue;
      for (var m = 0; m < seg.chars.length; m++) {
        var ch = seg.chars[m];
        if (ch.isSpace || !ch.charTiming) continue;
        var pulse = tiltPulse(time, ch.charTiming);
        var scale = Math.round((1 + pulse * (seg.tilt ? 0.18 : 0.15)) * 1000) / 1000;
        if (scale === ch.scale) continue;
        ch.scale = scale;
        ch.el.style.transform = 'translateY(' + ch.tiltY.toFixed(1) + 'px) scale(' + scale + ')';
      }
    }
  };

  /** 单字脉冲：唱到时正弦鼓起，之后衰减到一点余晖 */
  function tiltPulse(time, timing) {
    var start = timing.start;
    var end = timing.end;
    var duration = Math.min(Math.max(Math.max(end - start, 0.05), 0.2), 0.9);
    var elapsed = time - start;
    if (elapsed < 0) return 0;
    if (elapsed <= duration) return Math.sin((elapsed / duration) * Math.PI);
    var after = elapsed - duration;
    var ramp = duration * 1.2;
    if (after >= ramp) return 0;
    return 0.25 * (after / ramp);
  }

  TiltScene.prototype.resize = function (w, h) {
    Scene.prototype.resize.call(this, w, h);
    this.ready = false;
  };

  TiltScene.prototype.applyTheme = function (c) {
    if (this.segments) {
      var mode = this.tun('colorMode', 'duo');
      for (var i = 0; i < this.segments.length; i++) {
        this.segments[i].el.style.color = getTiltColor(this.segments[i].tilt, mode, c);
      }
    }
    if (this.subText) {
      this.subText.style.color = hex(c.secondary);
      this.subText.style.fontSize = Math.round(clamp(0.022 * this.width, 17, 19) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    }
    if (this.subNext) {
      this.subNext.style.color = hex(c.secondary);
      this.subNext.style.fontSize = Math.round(clamp(0.018 * this.width, 14, 16) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    }
  };

  TiltScene.prototype.dispose = function () {
    this.segments = null;
    Scene.prototype.dispose.call(this);
  };

  /* ================= 浮名（沉浸） ================= */

  function FumeScene(box) { Scene.call(this, box); }
  inherit(FumeScene, Scene);

  FumeScene.prototype.mount = function () {
    this.cv = el('canvas', 'position:absolute;inset:0;width:100%;height:100%;', this.box);
    this.g = this.cv.getContext('2d');
    this.sub = el('div', 'position:absolute;left:0;right:0;bottom:9%;text-align:center;padding:0 16px;pointer-events:none;opacity:0;transition:opacity .24s ease-out;', this.box);
    this.subText = el('div', 'font-weight:500;line-height:1.35;', this.sub);
    this.subNext = el('div', 'font-weight:400;line-height:1.35;margin-top:8px;filter:blur(1px);', this.sub);
    this.layout();
  };

  FumeScene.prototype.onLine = function (s) {
    if (!this.cv) this.mount();
    if (s.index >= 0) this.feedIndex = s.index;
    var tr = currentTr(s);
    var nx = nextText(s);
    setText(this.subText, tr);
    setText(this.subNext, nx);
    this.subNext.style.display = nx ? '' : 'none';
    this.sub.style.opacity = (tr || nx) ? '0.6' : '0';
  };

  FumeScene.prototype.layout = function () {
    if (!this.cv) return;
    this.cv.width = Math.max(1, this.width);
    this.cv.height = Math.max(1, this.height);
  };

  /** 把一行拆成字符并测量位置，超出最大宽度就折行（Folia 的“文章”排版） */
  function fumeWrap(ctx, text, maxWidth, fontPx) {
    var chars = Array.from(text || '');
    var rows = [];
    var row = [];
    var width = 0;
    var advance = fontPx * 0.06;
    for (var i = 0; i < chars.length; i++) {
      var w = ctx.measureText(chars[i]).width + advance;
      if (row.length && width + w > maxWidth) {
        rows.push({ chars: row, width: width });
        row = [];
        width = 0;
      }
      row.push({ ch: chars[i], w: w });
      width += w;
    }
    if (row.length) rows.push({ chars: row, width: width });
    return rows;
  }

  FumeScene.prototype.applyTheme = function (c) {
    if (this.subText) {
      this.subText.style.color = hex(c.secondary);
      this.subText.style.fontSize = Math.round(clamp(0.022 * this.width, 17, 21) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    }
    if (this.subNext) {
      this.subNext.style.color = hex(c.secondary);
      this.subNext.style.fontSize = Math.round(clamp(0.018 * this.width, 14, 17) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    }
  };

  FumeScene.prototype.dispose = function () {
    Scene.prototype.dispose.call(this);
  };

  FumeScene.prototype.onFrame = function (dt, s) {
    if (!this.g) return;
    var w = this.cv.width, h = this.cv.height;
    var power = powerOf(s);
    var c = this.colors;
    var showGeometry = this.tun('showGeometry', true);
    var hideBoxes = this.tun('hideBoxes', false);
    var objOpacity = this.tun('objectOpacity', 0.6);
    var camSpeed = this.tun('cameraSpeed', 1);
    var glow = this.tun('glow', 0.7);
    var titleScale = this.tun('titleScale', 1);
    var base = this.noCommonFontScale ? 1 : (this.fontScale || 1);
    var fontPx = Math.round(clamp(Math.min(w, h) * 0.1, 36, 96) * titleScale * base);
    var maxWidth = Math.min(w * 0.72, 860);

    var g = this.g;
    g.clearRect(0, 0, w, h);
    var grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hex(c.bg));
    grad.addColorStop(1, '#02030a');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);

    if (showGeometry) {
      var count = hideBoxes ? 8 : 14;
      if (!hideBoxes) {
        for (var b = 0; b < 5; b++) {
          var sx = rand(b, 31) * w - 40;
          var sy = rand(b, 32) * h - 40;
          var ss = 60 + rand(b, 33) * 120;
          g.fillStyle = cssRgba(c.accent, 0.025 + 0.02 * power);
          g.fillRect(sx, sy, ss, ss * 0.55);
        }
      }
      for (var i = 0; i < count; i++) {
        var cx = rand(i, 1) * w;
        var cy = rand(i, 2) * h;
        var r = 40 + rand(i, 3) * 160;
        var rot = (this.elapsed * camSpeed) * (0.04 + rand(i, 4) * 0.08) + i;
        g.strokeStyle = cssRgba(i % 2 ? c.accent : c.secondary, (0.06 + 0.05 * power) * objOpacity * 2);
        g.lineWidth = 1;
        g.beginPath();
        if (i % 3 === 0) {
          g.arc(cx, cy, r * 0.6, rot, rot + Math.PI * 1.2);
        } else if (i % 3 === 1) {
          var half = r * 0.3;
          g.moveTo(cx - half, cy);
          g.lineTo(cx + half, cy);
          g.moveTo(cx, cy - half);
          g.lineTo(cx, cy + half);
        } else {
          g.rect(cx - r * 0.35, cy - r * 0.3, r * 0.7, r * 0.6);
        }
        g.stroke();
      }
    }

    var lines = s.lines || [];
    var idx = s.index >= 0 ? s.index : (this.feedIndex || 0);
    this.feedIndex = idx;
    if (!lines.length) return;

    var lineHeight = Math.round(fontPx * 1.5);
    var breathe = Math.sin(this.elapsed * 2.3 / Math.max(0.4, camSpeed)) * (4 + 8 * power);
    g.textBaseline = 'middle';
    g.font = '700 ' + fontPx + 'px ' + ((typeof LyricTunings !== 'undefined') ? LyricTunings.fontStack() : FONT);

    for (var li = idx - 4; li <= idx + 4; li++) {
      var line = lines[li];
      if (!line || !line.text) continue;
      var dist = li - idx;
      var isCurrent = dist === 0;
      var rows = fumeWrap(g, line.text, maxWidth, fontPx);
      var blockH = rows.length * lineHeight;
      var top = h * 0.5 + dist * (blockH + lineHeight * 0.9) + breathe - blockH / 2;

      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        var y = top + r * lineHeight + lineHeight / 2;
        var x = w * 0.5 - row.width / 2;
        var charIndex = 0;
        for (var cch = 0; cch < row.chars.length; cch++) {
          var item = row.chars[cch];
          if (!item.ch) continue;
          var printed = false;
          var charTiming = null;
          if (isCurrent && line.chars) {
            while (charIndex < line.chars.length && (line.chars[charIndex].text || '') !== item.ch) charIndex++;
            charTiming = line.chars[charIndex] || null;
            if (!charTiming) charTiming = line.chars[Math.min(charIndex, line.chars.length - 1)];
            printed = !!charTiming && s.time >= charTiming.start;
            charIndex++;
          }
          if (isCurrent) {
            if (printed) {
              var trail = clamp((s.time - charTiming.start) / 1.2, 0, 1);
              g.globalAlpha = 0.96 - 0.24 * trail;
              g.fillStyle = hex(mixNumeric(c.accent, c.primary, trail * 0.85));
              g.shadowColor = cssRgba(c.accent, 0.55 * glow);
              g.shadowBlur = (4 + fontPx * 0.22) * (1 - trail * 0.6) * glow;
            } else {
              g.globalAlpha = 0.06;
              g.fillStyle = hex(c.primary);
              g.shadowBlur = 0;
            }
          } else {
            g.globalAlpha = dist === -1 || dist === 1 ? 0.07 : 0.045;
            g.fillStyle = hex(c.primary);
            g.shadowBlur = 0;
          }
          g.fillText(item.ch, x, y);
          x += item.w;
        }
      }
    }
    g.globalAlpha = 1;
    g.shadowBlur = 0;

    // 底部字幕
    if (this.sub) this.sub.style.opacity = (currentTr(s) || nextText(s)) ? '0.6' : '0';
  };

  /* ================= 莫奈（沉浸） ================= */

  function MonetScene(box) { Scene.call(this, box); }
  inherit(MonetScene, Scene);

  MonetScene.prototype.mount = function () {
    this.bgImg = el('img', 'position:absolute;left:-6%;top:-6%;width:112%;height:112%;object-fit:cover;', this.box);
    this.bgImg.crossOrigin = 'anonymous';
    this.overlay = el('div', 'position:absolute;inset:0;', this.box);
    this.wrap = el('div', 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:40px 56px;pointer-events:none;', this.box);
    this.inner = el('div', 'position:relative;display:flex;align-items:center;gap:48px;width:100%;max-width:1520px;height:100%;', this.wrap);
    this.left = el('div', 'position:relative;display:flex;flex-direction:column;justify-content:center;flex:1;min-width:0;height:100%;padding:24px 0;', this.inner);
    this.artistEl = el('div', 'font-style:italic;line-height:1.2;', this.left);
    this.divider = el('div', 'width:1px;height:56px;margin:14px 0;', this.left);
    this.titleEl = el('div', 'font-weight:600;line-height:1.06;letter-spacing:-.01em;', this.left);
    this.albumEl = el('div', 'text-transform:uppercase;letter-spacing:.08em;margin-top:6px;', this.left);
    this.rail = el('div', 'position:relative;flex:1;min-height:0;overflow:hidden;margin-top:12px;', this.left);
    this.rail.style.webkitMaskImage = 'linear-gradient(to bottom, transparent 0%, #000 12%, #000 86%, transparent 100%)';
    this.rail.style.maskImage = 'linear-gradient(to bottom, transparent 0%, #000 12%, #000 86%, transparent 100%)';
    this.descEl = el('div', 'display:inline-flex;align-items:center;gap:8px;align-self:flex-start;margin-top:14px;padding:8px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.16);backdrop-filter:blur(10px);', this.left);
    this.descDot = el('span', 'width:10px;height:10px;border-radius:50%;', this.descEl);
    this.descText = el('span', '', this.descEl);
    this.right = el('div', 'flex:0 0 clamp(220px,28vw,430px);display:flex;align-items:center;justify-content:center;', this.inner);
    this.portrait = el('div', 'width:100%;border-radius:32px;overflow:hidden;position:relative;background:rgba(255,255,255,.06);pointer-events:none;', this.right);
    this.portrait.style.boxShadow = '0 36px 80px rgba(0,0,0,.45), 0 20px 42px rgba(0,0,0,.22), 0 0 0 1px rgba(255,255,255,.06)';
    this.portraitImg = el('img', 'width:100%;height:100%;object-fit:cover;display:block;', this.portrait);
    this.portraitImg.crossOrigin = 'anonymous';
  };

  MonetScene.prototype.onLine = function (s) {
    if (!this.wrap) this.mount();
    var base = this.noCommonFontScale ? 1 : (this.fontScale || 1);
    var tuneScale = this.tun('fontScale', 1);
    var lyricPx = clamp(0.0275 * this.width, 21, 37) * tuneScale * 1.2 * base;
    this.lyricPx = lyricPx;

    var song = s.song || {};
    setText(this.artistEl, song.artist || '');
    setText(this.titleEl, song.title || '');
    setText(this.albumEl, song.album || '');

    var desc = this.tun('showDesc', false) ? (song.desc || song.description || '') : '';
    this.descEl.style.display = desc ? '' : 'none';
    setText(this.descText, desc);

    var portraitUrl = this.tun('portraitSource', 'cover') === 'custom'
      ? this.tun('customPortrait', '') : (s.coverUrl || '');
    if (portraitUrl && portraitUrl !== this._portraitUrl) {
      this._portraitUrl = portraitUrl;
      this.portraitImg.src = portraitUrl;
    }
    var square = this.tun('coverShape', 'tall') === 'square';
    this.portrait.style.aspectRatio = square ? '1 / 1' : '0.74 / 1';
    this.portrait.style.borderRadius = square ? '32px' : '34px';
    this.portrait.style.pointerEvents = this.tun('portraitDragOn', false) ? 'auto' : 'none';

    this.buildRail(s);
    this.applyTheme(this.colors);
  };

  MonetScene.prototype.buildRail = function (s) {
    this.rail.textContent = '';
    this.railItems = [];
    this.activeChars = null;
    var lines = s.lines || [];
    if (s.index < 0 || !lines.length) return;
    var px = this.lyricPx;
    var railH = this.rail.clientHeight || this.height * 0.52;
    var blockH = px * 1.35 + (s.opts && s.opts.translation === false ? 0 : px * 0.86);
    var gap = Math.max(18, px * 0.49);
    var centerY = railH * 0.46;
    var offsets = { 0: 0 };
    var acc = 0;
    for (var d = 1; d <= 2; d++) { acc += blockH + gap; offsets[d] = acc; offsets[-d] = -acc; }

    for (var i = s.index - 2; i <= s.index + 2; i++) {
      var line = lines[i];
      if (!line || !line.text) continue;
      var dist = i - s.index;
      var block = el('div', 'position:absolute;left:0;right:0;will-change:transform,opacity,filter;', this.rail);
      block.style.top = (centerY + offsets[dist]) + 'px';
      block.style.transform = 'translateY(-50%)';
      block.style.transition = 'transform .5s cubic-bezier(.32,.72,0,1), opacity .35s ease, filter .35s ease';

      var text = el('div', 'line-height:1.3;', block);
      text.style.fontSize = px + 'px';
      text.style.fontWeight = '600';

      if (dist === 0) {
        var chars = line.chars && line.chars.length ? line.chars : fallbackChars(line);
        var charViews = [];
        for (var c = 0; c < chars.length; c++) {
          var span = document.createElement('span');
          span.textContent = chars[c].text;
          span.style.cssText = 'color:rgba(255,255,255,.4);transition:color .2s linear,text-shadow .3s linear;';
          text.appendChild(span);
          charViews.push({ el: span, start: chars[c].start });
        }
        this.activeChars = charViews;
      } else {
        text.textContent = line.text;
        text.style.color = dist < 0 ? 'rgba(255,255,255,.52)' : 'rgba(255,255,255,.72)';
      }

      if (!s.opts || s.opts.translation !== false) {
        var tr = el('div', 'line-height:1.4;margin-top:' + Math.round(px * 0.14) + 'px;', block);
        tr.style.fontSize = Math.round(px * 0.46) + 'px';
        tr.style.color = 'rgba(255,255,255,.42)';
        tr.style.fontWeight = '500';
        tr.textContent = line.tr || '';
        tr.style.display = line.tr ? '' : 'none';
        if (dist === 0) this.activeTr = tr;
      }

      var scale = dist === 0 ? 1 : (Math.abs(dist) === 1 ? 0.95 : 0.9);
      var opacity = dist === 0 ? 1 : (dist < 0 ? (Math.abs(dist) === 1 ? 0.52 : 0.4) : (dist === 1 ? 0.72 : 0.54));
      var blur = dist === 0 ? 0 : (dist < 0 ? 1.1 + 0.7 * (Math.abs(dist) - 1) : 0.7 + 0.9 * (dist - 1));
      block.style.opacity = opacity;
      block.style.filter = blur > 0.1 ? 'blur(' + blur.toFixed(1) + 'px)' : 'none';
      block.style.transform = 'translateY(-50%) scale(' + scale + ')';
      block.style.transformOrigin = 'left center';

      if (dist === 0) {
        block.style.opacity = '0';
        block.style.transform = 'translateY(calc(-50% + 24px))';
        requestAnimationFrame(function (target) {
          return function () {
            if (!target.parentNode) return;
            target.style.opacity = '1';
            target.style.transform = 'translateY(-50%) scale(1)';
          };
        }(block));
      }

      this.railItems.push(block);
    }
  };

  MonetScene.prototype.onFrame = function (dt, s) {
    var power = powerOf(s);
    var keyword = this.tun('keyword', true);
    var accent = this.colors.accentCss;
    if (this.activeChars) {
      for (var i = 0; i < this.activeChars.length; i++) {
        var c = this.activeChars[i];
        var lit = s.time >= c.start;
        if (lit) {
          c.el.style.color = keyword ? accent : '#ffffff';
          c.el.style.textShadow = '0 0 18px ' + cssRgba(this.colors.accent, 0.45);
        } else {
          c.el.style.color = 'rgba(255,255,255,.4)';
          c.el.style.textShadow = 'none';
        }
      }
    }
    if (this.bgImg) {
      this.bgImg.style.transform = 'scale(' + (1.04 + 0.015 * Math.sin(this.elapsed * 0.14) + 0.015 * power).toFixed(3) + ')';
      this.bgImg.style.filter = 'blur(26px) saturate(1.05) brightness(.42)';
    }
    if (this.portrait) {
      this.portrait.style.transform = 'translateY(' + (-5 * Math.sin(this.elapsed * 0.22)).toFixed(2) + 'px) rotate(' + (0.6 * Math.sin(this.elapsed * 0.18)).toFixed(2) + 'deg)';
    }
  };

  MonetScene.prototype.resize = function (w, h) {
    Scene.prototype.resize.call(this, w, h);
    this.ready = false;
  };

  MonetScene.prototype.applyTheme = function (c) {
    if (!this.overlay) return;
    this.box.style.background = hex(c.bg);
    this.overlay.style.background = 'linear-gradient(100deg, ' + cssRgba(c.bg, 0.95) + ' 0%, ' + cssRgba(c.bg, 0.82) + ' 46%, ' + cssRgba(c.bg, 0.45) + ' 100%)';
    this.overlay.style.boxShadow = 'inset 0 0 180px ' + cssRgba(c.accent, 0.14);
    if (this.artistEl) {
      this.artistEl.style.color = cssRgba(c.primary, 0.96);
      this.artistEl.style.fontSize = Math.round(clamp(0.018 * this.width, 16, 29) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    }
    if (this.titleEl) {
      this.titleEl.style.color = hex(c.primary);
      this.titleEl.style.fontSize = Math.round(clamp(0.033 * this.width, 24, 45) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    }
    if (this.albumEl) {
      this.albumEl.style.color = cssRgba(c.secondary, 0.84);
      this.albumEl.style.fontSize = '14px';
    }
    if (this.divider) this.divider.style.background = 'linear-gradient(to bottom, ' + cssRgba(c.primary, 0.72) + ', transparent)';
    if (this.descEl) {
      this.descEl.style.color = cssRgba(c.primary, 0.9);
      this.descEl.style.borderColor = cssRgba(c.primary, 0.16);
      this.descEl.style.background = cssRgba(c.bg, 0.18);
      this.descEl.style.fontSize = '12px';
    }
    if (this.descDot) this.descDot.style.background = c.accentCss;
  };

  MonetScene.prototype.dispose = function () {
    this.railItems = null;
    this.activeChars = null;
    Scene.prototype.dispose.call(this);
  };

  /* ================= 回环（对齐 Folia Claddagh） ================= */

  function CladdaghScene(box) { Scene.call(this, box); }
  inherit(CladdaghScene, Scene);

  function claddaghCharWidth(ch, fontPx) {
    if (!ch) return fontPx * 0.62;
    if (/^\s+$/.test(ch)) return fontPx * 0.36;
    if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(ch)) return fontPx;
    return fontPx * 0.62;
  }

  function claddaghReadableAngle(deg) {
    var a = deg;
    while (a > 90) a -= 180;
    while (a < -90) a += 180;
    return a;
  }

  CladdaghScene.prototype.mount = function () {
    this.stage = el('div', 'position:absolute;inset:0;overflow:hidden;pointer-events:none;', this.box);
    this.axis = el('div', 'position:absolute;left:50%;top:50%;width:300px;height:4px;margin:-2px 0 0 -150px;border-radius:2px;', this.stage);
    this.ring = el('div', 'position:absolute;left:50%;top:46%;width:0;height:0;font-weight:700;letter-spacing:.04em;', this.stage);
    this.ring.style.fontFamily = (typeof LyricTunings !== 'undefined') ? LyricTunings.fontStack() : FONT;
    this.sub = el('div', 'position:absolute;left:0;right:0;bottom:9%;text-align:center;padding:0 16px;pointer-events:none;opacity:0;transition:opacity .24s ease-out;', this.box);
    this.subText = el('div', 'font-weight:500;line-height:1.35;', this.sub);
    this.subNext = el('div', 'font-weight:400;line-height:1.35;margin-top:8px;filter:blur(1px);', this.sub);
  };

  CladdaghScene.prototype.onLine = function (s) {
    if (!this.stage) this.mount();
    this.build(s);
    var tr = currentTr(s);
    var nx = nextText(s);
    setText(this.subText, tr);
    setText(this.subNext, nx);
    this.subNext.style.display = nx ? '' : 'none';
    this.sub.style.opacity = (tr || nx) ? '0.6' : '0';
    this.applyTheme(this.colors);
  };

  CladdaghScene.prototype.build = function (s) {
    var line = s.line;
    this.items = null;
    this.ring.innerHTML = '';
    if (!line || !line.text) return;

    var base = this.noCommonFontScale ? 1 : (this.fontScale || 1);
    var fontPx = Math.round(72 * base);
    var gap = this.tun('letterGap', 0);
    var rx = Math.min(this.width * 0.44, 560) * (this.tun('radius', 0.42) / 0.42);
    var tracking = fontPx * 0.26;
    this.rx = rx;
    this.fontPx = fontPx;
    this.ring.style.fontSize = fontPx + 'px';

    var chars = line.chars && line.chars.length ? line.chars : fallbackChars(line);
    var totalWidth = 0;
    var advances = [];
    for (var i = 0; i < chars.length; i++) {
      var w = claddaghCharWidth(chars[i].text, fontPx) + tracking + gap;
      advances.push(w);
      totalWidth += w;
    }
    var totalSpan = totalWidth / Math.max(rx, fontPx * 2, 1);
    var scaleFactor = totalSpan > 4.25 ? 4.25 / totalSpan : 1;

    this.items = [];
    var center = 0;
    for (var c = 0; c < chars.length; c++) {
      var nominal = ((center + advances[c] / 2) / Math.max(rx, fontPx * 2, 1) - totalSpan / 2) * scaleFactor;
      center += advances[c];
      var node = document.createElement('span');
      node.textContent = chars[c].text;
      node.style.cssText = 'position:absolute;left:0;top:0;display:inline-block;white-space:pre;will-change:transform,opacity,filter;';
      this.ring.appendChild(node);
      this.items.push({ el: node, nominal: nominal, start: chars[c].start, end: chars[c].end });
    }
    this.spinAt = this.elapsed;
  };

  CladdaghScene.prototype.onFrame = function (dt, s) {
    if (!this.items || !this.items.length) return;
    var time = s.time;
    var rx = this.rx || 400;
    var ry = rx * 0.09;
    var tiltDeg = this.tun('tilt', 45);
    var tiltRad = -tiltDeg * Math.PI / 180;
    var cosT = Math.cos(tiltRad);
    var sinT = Math.sin(tiltRad);
    var focusRatio = this.tun('focusScale', 1.25) * 0.3;

    // 唱到第几个字（带小数）：让已唱的字滑到环的正面
    var fractional = 0;
    var items = this.items;
    var last = items.length - 1;
    if (time >= items[last].start) {
      var prevStart = last > 0 ? items[last - 1].start : items[last].start;
      var step = Math.max(0.2, items[last].start - prevStart);
      fractional = last + Math.min(1.8, (time - items[last].start) / step);
    } else {
      for (var i = 0; i < items.length - 1; i++) {
        if (time >= items[i].start && time < items[i + 1].start) {
          var span = Math.max(0.001, items[i + 1].start - items[i].start);
          fractional = i + (time - items[i].start) / span;
          break;
        }
      }
    }
    var lo = Math.floor(fractional);
    var fr = fractional - lo;
    var angleA = items[Math.min(Math.max(lo, 0), last)].nominal;
    var angleB = items[Math.min(lo + 1, last)].nominal;
    var off = angleA + (angleB - angleA) * fr;

    // 换行时从背后转进来
    var spinP = Math.min(1, Math.max(0, (this.elapsed - (this.spinAt || 0)) / 1));
    var spin = Math.PI * (1 - (1 - Math.pow(1 - spinP, 3)));
    var power = powerOf(s);

    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      var psi = it.nominal - off + spin;
      var depth = (Math.cos(psi) + 1) / 2;
      var spacing = 0.35 + 0.65 * Math.pow(depth, 1.2);
      var rawX = Math.sin(psi) * rx * spacing;
      var rawY = Math.cos(psi) * ry;
      var x = rawX * cosT - rawY * sinT;
      var y = rawX * sinT + rawY * cosT;

      var focus = Math.pow(Math.max(0, 1 - Math.abs(psi) / 0.48), 1.8);
      var opacity = (0.35 + 0.65 * Math.pow(depth, 1.5) * (0.35 + 0.65 * focus)) * (0.68 + 0.32 * Math.pow(depth, 1.9));
      var scale = (0.22 + 0.8 * Math.pow(depth, 1.5)) * (1 + focusRatio * focus);
      var blur = 8 * (1 - depth) * (1 - 0.5 * focus);

      var tangentX = Math.cos(psi) * rx;
      var tangentY = -Math.sin(psi) * ry;
      var rtx = tangentX * cosT - tangentY * sinT;
      var rty = tangentX * sinT + tangentY * cosT;
      var tangentDeg = claddaghReadableAngle(Math.atan2(rty, rtx) * 180 / Math.PI);
      var rot = clamp(tangentDeg * (0.4 + 0.6 * depth), -38, 38);

      it.el.style.opacity = opacity.toFixed(3);
      it.el.style.transform = 'translate3d(calc(-50% + ' + x.toFixed(1) + 'px), calc(-50% + ' + y.toFixed(1) + 'px), 0) rotate(' + rot.toFixed(2) + 'deg) scale(' + scale.toFixed(3) + ')';
      it.el.style.filter = blur < 0.2 ? '' : 'blur(' + blur.toFixed(2) + 'px)';
      it.el.style.zIndex = String(Math.round(depth * 100));
      var sung = time >= it.start;
      it.el.style.color = sung ? this.colors.accentCss : cssRgba(this.colors.primary, 0.55);
      var glow = 24 * focus * focus * (0.5 + 0.5 * power);
      it.el.style.textShadow = glow > 0.6 ? '0 0 ' + glow.toFixed(1) + 'px ' + cssRgba(this.colors.accent, 0.5) : 'none';
    }

    if (this.axis) {
      var showAxis = this.tun('axis', true);
      this.axis.style.opacity = showAxis ? String(0.45 + 0.3 * power) : '0';
      this.axis.style.transform = 'rotate(' + (90 - tiltDeg) + 'deg) scaleX(' + (1 + 1.5 * power * power).toFixed(3) + ') scaleY(' + (1 + 0.5 * power * power).toFixed(3) + ')';
      this.axis.style.background = 'linear-gradient(90deg, transparent, ' + cssRgba(this.colors.accent, 0.2) + ' 25%, ' + cssRgba(this.colors.accent, 0.8) + ' 50%, ' + cssRgba(this.colors.accent, 0.2) + ' 75%, transparent)';
      this.axis.style.boxShadow = '0 0 ' + (4 + 12 * power).toFixed(1) + 'px ' + cssRgba(this.colors.accent, 0.5);
    }
  };

  CladdaghScene.prototype.resize = function (w, h) {
    Scene.prototype.resize.call(this, w, h);
    this.ready = false;
  };

  CladdaghScene.prototype.applyTheme = function (c) {
    if (this.subText) {
      this.subText.style.color = hex(c.secondary);
      this.subText.style.fontSize = Math.round(clamp(0.022 * this.width, 18, 23) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    }
    if (this.subNext) {
      this.subNext.style.color = hex(c.secondary);
      this.subNext.style.fontSize = Math.round(clamp(0.018 * this.width, 15, 19) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    }
  };

  CladdaghScene.prototype.dispose = function () {
    this.items = null;
    Scene.prototype.dispose.call(this);
  };

  /* ================= 镜台（沉浸） ================= */

  function DioramaScene(box) { Scene.call(this, box); }
  inherit(DioramaScene, Scene);

  DioramaScene.prototype.mount = function () {
    this.cv = el('canvas', 'position:absolute;inset:0;width:100%;height:100%;', this.box);
    this.g = this.cv.getContext('2d');
    this.sub = el('div', 'position:absolute;left:0;right:0;bottom:8%;text-align:center;padding:0 16px;pointer-events:none;opacity:0;transition:opacity .24s ease-out;', this.box);
    this.subText = el('div', 'font-weight:500;line-height:1.35;', this.sub);
    this.subNext = el('div', 'font-weight:400;line-height:1.35;margin-top:8px;filter:blur(1px);', this.sub);
    this.dust = null;
    this.layout();
  };

  DioramaScene.prototype.onLine = function (s) {
    if (!this.cv) this.mount();
    if (s.index >= 0) this.lineIndex = s.index;
    var tr = currentTr(s);
    var nx = nextText(s);
    setText(this.subText, tr);
    setText(this.subNext, nx);
    this.subNext.style.display = nx ? '' : 'none';
    this.sub.style.opacity = (tr || nx) ? '0.6' : '0';
    this.applyTheme(this.colors);
  };

  DioramaScene.prototype.layout = function () {
    if (!this.cv) return;
    this.cv.width = Math.max(1, this.width);
    this.cv.height = Math.max(1, this.height);
  };

  DioramaScene.prototype.resize = function (w, h) {
    Scene.prototype.resize.call(this, w, h);
    this.layout();
  };

  DioramaScene.prototype.applyTheme = function (c) {
    if (this.subText) {
      this.subText.style.color = hex(c.secondary);
      this.subText.style.fontSize = Math.round(clamp(0.022 * this.width, 18, 22) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    }
    if (this.subNext) {
      this.subNext.style.color = hex(c.secondary);
      this.subNext.style.fontSize = Math.round(clamp(0.017 * this.width, 14, 18) * (this.noCommonFontScale ? 1 : (this.fontScale || 1))) + 'px';
    }
  };

  DioramaScene.prototype.initDust = function () {
    this.dust = [];
    for (var i = 0; i < 150; i++) {
      this.dust.push({
        x: (rand(i, 1) - 0.5) * 14,
        y: (rand(i, 2) - 0.5) * 9,
        z: 0.8 + rand(i, 3) * 22,
        s: 0.4 + rand(i, 4) * 1.2,
        tint: i % 6 === 0
      });
    }
  };

  DioramaScene.prototype.onFrame = function (dt, s) {
    if (!this.g) return;
    if (!this.dust) this.initDust();
    var w = this.cv.width, h = this.cv.height;
    var g = this.g;
    var c = this.colors;
    var power = powerOf(s);
    var base = this.noCommonFontScale ? 1 : (this.fontScale || 1);
    var motion = this.tun('motion', 1);
    var camSpeed = this.tun('cameraSpeed', 1);
    var showParticles = this.tun('geometry', 'points') !== 'none';
    var glowOn = this.tun('glow', true);
    var glowMul = this.tun('glowStrength', 0.8);
    var keyword = this.tun('keyword', true);
    var minSide = Math.min(w, h);
    var focal = minSide * 0.9;
    var cx = w * 0.5 + Math.sin(this.elapsed * 0.13) * 0.4 * minSide * 0.03 * motion;
    var cy = h * 0.52 + Math.sin(this.elapsed * 0.19) * 0.4 * minSide * 0.02 * motion;
    this.camDrift = (this.camDrift || 0) + (dt || 0.016) * camSpeed;

    g.clearRect(0, 0, w, h);
    var bg = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.85);
    bg.addColorStop(0, hex(mixNumeric(c.bg, c.accent, 0.06)));
    bg.addColorStop(1, '#010207');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    var lines = s.lines || [];
    var idx = s.index >= 0 ? s.index : (this.lineIndex || 0);
    this.lineIndex = idx;

    // 尘埃与点云：沿走廊向镜头飘来
    if (showParticles) {
      for (var i = 0; i < this.dust.length; i++) {
        var d = this.dust[i];
        d.z -= (dt || 0.016) * (1.1 * camSpeed + power * 0.8);
        if (d.z < 0.5) {
          d.z += 22;
          d.x = (rand(i + this.elapsed, 7) - 0.5) * 14;
          d.y = (rand(i + this.elapsed, 8) - 0.5) * 9;
        }
        var scale = focal / d.z;
        var px = cx + d.x * scale * 0.1;
        var py = cy + d.y * scale * 0.1 + Math.sin(this.elapsed * 0.8 + i) * 2;
        if (px < -20 || px > w + 20 || py < -20 || py > h + 20) continue;
        var rr = clamp(d.s * scale * 0.012, 0.6, 4.5);
        var alpha = clamp(0.06 + (1 - d.z / 22) * 0.32, 0.04, 0.5);
        g.fillStyle = cssRgba(d.tint ? c.secondary : c.accent, alpha);
        if (glowOn) {
          g.shadowColor = cssRgba(c.accent, 0.35 * glowMul);
          g.shadowBlur = 8 * glowMul;
        }
        g.beginPath();
        g.arc(px, py, rr, 0, Math.PI * 2);
        g.fill();
      }
      g.shadowBlur = 0;
    }

    // 歌词平面：当前行最近最大，前后行向远处收缩并变淡
    var fontPx = clamp(minSide * 0.086, 26, 82) * base;
    var drawn = [];
    for (var li = idx - 2; li <= idx + 2; li++) drawn.push(li);
    for (var di = 0; di < drawn.length; di++) {
      var lineIdx = drawn[di];
      var line = lines[lineIdx];
      if (!line || !line.text) continue;
      var dist = lineIdx - idx;
      var depthScale = dist === 0 ? 1 : 1 / (1 + Math.abs(dist) * 1.35);
      var pxSize = fontPx * depthScale * (dist === 0 ? (0.95 + 0.05 * Math.sin(this.elapsed * 1.9)) : 1);
      var alpha = dist === 0 ? 1 : (dist === -1 ? 0.3 : (dist === -2 ? 0.1 : (dist === 1 ? 0.34 : 0.16)));
      var baseY = cy + dist * (fontPx * 0.95) - (dist === 0 ? 0 : 0);
      var baseX = cx + (dist === 0 ? -w * 0.06 : w * 0.02) * motion;
      var roll = dist === 0 ? -0.05 : (dist < 0 ? 0.1 : -0.09);

      g.save();
      g.translate(baseX, baseY);
      g.rotate(roll * motion);
      g.font = (dist === 0 ? '700 ' : '600 ') + Math.round(pxSize) + 'px ' + ((typeof LyricTunings !== 'undefined') ? LyricTunings.fontStack() : FONT);
      g.textBaseline = 'middle';
      g.textAlign = 'left';

      var chars = line.chars && line.chars.length ? line.chars : fallbackChars(line);
      var widths = [];
      var total = 0;
      for (var cw = 0; cw < chars.length; cw++) {
        var ww = g.measureText(chars[cw].text).width;
        widths.push(ww);
        total += ww;
      }
      var startX = -total / 2;
      for (var ci = 0; ci < chars.length; ci++) {
        var ch = chars[ci];
        var jitterY = dist === 0 ? (rand(ci, 5) - 0.5) * 10 * motion : 0;
        var charRoll = dist === 0 ? (rand(ci, 6) - 0.5) * 0.2 * motion : 0;
        var isSung = s.time >= ch.start;
        var p = LyricTiming.charProgress(ch, s.time);
        g.save();
        g.translate(startX + widths[ci] / 2, jitterY);
        g.rotate(charRoll);
        g.globalAlpha = dist === 0 ? (isSung ? 0.92 : 0.55) : alpha;
        g.fillStyle = dist === 0
          ? hex(mixNumeric(0xffffff, keyword ? c.accent : 0xffffff, isSung ? 0.3 + 0.45 * p : 0))
          : '#ffffff';
        if (dist === 0 && isSung && glowOn) {
          g.shadowColor = cssRgba(c.accent, 0.6 * glowMul);
          g.shadowBlur = pxSize * 0.16 * glowMul;
        } else {
          g.shadowBlur = 0;
        }
        g.fillText(ch.text, 0, 0);
        g.restore();
        startX += widths[ci];
      }
      g.restore();
    }
    g.globalAlpha = 1;
    g.shadowBlur = 0;
  };

  DioramaScene.prototype.dispose = function () {
    this.dust = null;
    Scene.prototype.dispose.call(this);
  };

  /* ================= 时计（沉浸） ================= */

  function PendoloScene(box) { Scene.call(this, box); }
  inherit(PendoloScene, Scene);

  function pendoloGear(g, radius, teeth, angle, color, width) {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    var steps = teeth * 2;
    for (var i = 0; i < steps; i++) {
      var rr = i % 2 === 0 ? radius : radius * 0.9;
      var a = angle + (i / steps) * Math.PI * 2;
      var x = Math.cos(a) * rr;
      var y = Math.sin(a) * rr;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.stroke();
  }

  PendoloScene.prototype.mount = function () {
    this.cv = el('canvas', 'position:absolute;inset:0;width:100%;height:100%;', this.box);
    this.g = this.cv.getContext('2d');
    this.wheelAngle = 0;
    this.layout();
  };

  PendoloScene.prototype.onLine = function (s) {
    if (!this.cv) this.mount();
    if (s.index >= 0) this.lineIndex = s.index;
  };

  PendoloScene.prototype.layout = function () {
    if (!this.cv) return;
    this.cv.width = Math.max(1, this.width);
    this.cv.height = Math.max(1, this.height);
  };

  PendoloScene.prototype.onFrame = function (dt, s) {
    if (!this.g) return;
    var w = this.cv.width, h = this.cv.height;
    var c = this.colors;
    var g = this.g;
    var minSide = Math.min(w, h);
    var power = powerOf(s);
    var wheelX = this.tun('wheelX', 0) / 100;
    var R = minSide * this.tun('wheelR', 0.3);
    var arcDeg = Math.min(160, this.tun('arc', 100));
    var focusScale = this.tun('focusScale', 1.25);
    var gearStyle = this.tun('gearStyle', 'half');
    var cx = w * wheelX;
    var cy = h * 0.5;
    var base = this.noCommonFontScale ? 1 : (this.fontScale || 1);
    var focusPx = 28 * base * focusScale;
    var otherPx = 22 * base;

    var lines = s.lines || [];
    var idx = s.index >= 0 ? s.index : (this.lineIndex || 0);
    this.lineIndex = idx;
    var step = Math.max(15 * Math.PI / 180, (focusPx * 1.9 + 26) / Math.max(1, 2 * R));

    // 擒纵：换行时轮盘转过一格
    var targetSpin = -idx * step;
    this.wheelAngle += (targetSpin - this.wheelAngle) * Math.min(1, (dt || 0.016) * 5);
    var spin = this.wheelAngle;

    g.clearRect(0, 0, w, h);
    var bgGrad = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.9);
    bgGrad.addColorStop(0, cssRgba(c.accent, 0.1));
    bgGrad.addColorStop(0.45, hex(c.bg));
    bgGrad.addColorStop(1, '#02030a');
    g.fillStyle = bgGrad;
    g.fillRect(0, 0, w, h);

    if (this.tun('centerGradient', true)) {
      var cg = g.createRadialGradient(cx, cy, 0, cx, cy, R * 1.65);
      cg.addColorStop(0, cssRgba(c.bg, 0.72));
      cg.addColorStop(0.35, cssRgba(c.bg, 0.52));
      cg.addColorStop(0.7, cssRgba(c.bg, 0.2));
      cg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = cg;
      g.beginPath();
      g.arc(cx, cy, R * 1.65, 0, Math.PI * 2);
      g.fill();
    }

    g.save();
    g.translate(cx, cy);
    var guide = [0.3, 0.6, 0.85, 1.15, 1.4];
    g.strokeStyle = cssRgba(c.primary, 0.15);
    g.lineWidth = 1;
    for (var gi = 0; gi < guide.length; gi++) {
      g.beginPath();
      g.arc(0, 0, R * guide[gi], 0, Math.PI * 2);
      g.stroke();
    }

    // 外圈轮齿
    if (gearStyle !== 'none') {
      var gearAlpha = gearStyle === 'full' ? 0.55 : 0.3;
      pendoloGear(g, R + 8, 36, spin * 0.2, cssRgba(c.accent, gearAlpha), 2.2);
      // 60 格刻度
      for (var ti = 0; ti < 60; ti++) {
        var ta = (ti / 60) * Math.PI * 2 + spin * 0.2;
        var long = ti % 5 === 0;
        var r1 = R * 1.15;
        var r2 = R * 1.15 + (long ? 12 : 6);
        g.strokeStyle = long ? cssRgba(c.accent, 0.35) : cssRgba(c.primary, 0.15);
        g.lineWidth = long ? 1.5 : 1;
        g.beginPath();
        g.moveTo(Math.cos(ta) * r1, Math.sin(ta) * r1);
        g.lineTo(Math.cos(ta) * r2, Math.sin(ta) * r2);
        g.stroke();
      }
      // 六根辐条 + 双倒角环
      g.strokeStyle = cssRgba(c.primary, 0.1);
      g.lineWidth = 1;
      for (var si = 0; si < 6; si++) {
        var sa = (si / 6) * Math.PI * 2 + spin * 0.2;
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(Math.cos(sa) * R * 0.85, Math.sin(sa) * R * 0.85);
        g.stroke();
      }
      g.beginPath();
      g.arc(0, 0, R * 0.88, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(0, 0, R * 0.92, 0, Math.PI * 2);
      g.stroke();

      // 中心太阳轮与三颗行星齿轮
      pendoloGear(g, R * 0.22, 12, -spin * 2.5, cssRgba(c.accent, 0.45), 1.2);
      for (var pi = 0; pi < 3; pi++) {
        var pa = (pi / 3) * Math.PI * 2 + Math.PI / 2;
        g.save();
        g.translate(Math.cos(pa) * R * 0.52, Math.sin(pa) * R * 0.52);
        pendoloGear(g, R * 0.16, 10, spin * 1.8, cssRgba(c.primary, 0.3), 1);
        g.restore();
      }
      g.strokeStyle = cssRgba(c.accent, 0.4);
      g.lineWidth = 2;
      g.beginPath();
      g.arc(0, 0, R * 0.08, 0, Math.PI * 2);
      g.stroke();
    }

    g.restore();

    // 焦点轴
    var lr = R + minSide * 0.06;
    if (this.tun('lineGlow', true)) {
      g.strokeStyle = cssRgba(c.accent, 0.45 + 0.2 * power);
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(cx + R * 0.85, cy);
      g.lineTo(cx + lr - 6, cy);
      g.stroke();
      g.beginPath();
      g.moveTo(cx + lr - 6, cy);
      g.lineTo(cx + lr - 16, cy - 5);
      g.lineTo(cx + lr - 16, cy + 5);
      g.closePath();
      g.fillStyle = cssRgba(c.accent, 0.55);
      g.fill();
    }

    // 弧上歌词
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (var li = idx - 7; li <= idx + 7; li++) {
      var line = lines[li];
      if (!line || !line.text) continue;
      var dist = li - idx;
      var a = dist * step;
      var absA = Math.abs(a);
      if (absA >= Math.PI / 2) continue;
      var opacity = Math.max(0.12, Math.pow(Math.max(0, Math.cos(a * 0.75)), 2.5) * (1 - Math.abs(dist) * 0.18));
      if (absA > 1.24) opacity *= Math.max(0, (Math.PI / 2 - absA) / 0.33);
      if (opacity <= 0.01) continue;
      var isFocus = dist === 0;
      var px = isFocus ? focusPx : Math.max(12, otherPx * Math.max(0.7, 1 - Math.abs(dist) * 0.08));
      var x = cx + lr * Math.cos(a);
      var y = cy + lr * Math.sin(a);
      var innerRot = a * 1.2 * 0.65;

      g.save();
      g.translate(x, y);
      g.rotate(innerRot);
      g.font = (isFocus ? '500 ' : '400 ') + Math.round(px) + 'px ' + ((typeof LyricTunings !== 'undefined') ? LyricTunings.fontStack() : FONT);
      g.globalAlpha = opacity;

      if (isFocus) {
        // 基础色 + 按演唱进度扫光
        g.fillStyle = cssRgba(c.primary, 0.52);
        g.fillText(line.text, 0, 0);
        var chars = line.chars && line.chars.length ? line.chars : fallbackChars(line);
        var travel = 0;
        for (var ci = 0; ci < chars.length; ci++) {
          var cw = g.measureText(chars[ci].text).width;
          if (s.time >= chars[ci].start) travel += cw * LyricTiming.charProgress(chars[ci], s.time);
        }
        if (travel > 0) {
          g.save();
          g.beginPath();
          g.rect(-4, -px * 0.9, travel + 4, px * 1.8);
          g.clip();
          g.fillStyle = hex(mixNumeric(c.primary, c.accent, 0.58));
          if (this.tun('lineGlow', true)) {
            g.shadowColor = cssRgba(c.accent, 0.5);
            g.shadowBlur = 14 * (0.6 + 0.4 * power);
          }
          g.fillText(line.text, 0, 0);
          g.restore();
        }
      } else {
        g.fillStyle = cssRgba(c.primary, 0.75);
        g.fillText(line.text, 0, 0);
      }

      var trText = isFocus ? currentTr(s) : ((!s.opts || s.opts.translation !== false) ? (line.tr || '') : '');
      if (trText) {
        g.globalAlpha = opacity * (isFocus ? 0.6 : 0.35);
        g.fillStyle = hex(c.secondary);
        g.font = '400 ' + Math.round(px * (isFocus ? 0.56 : 0.52)) + 'px ' + ((typeof LyricTunings !== 'undefined') ? LyricTunings.fontStack() : FONT);
        g.fillText(trText, 0, px * 1.35);
      }
      g.restore();
    }
    g.globalAlpha = 1;
  };

  PendoloScene.prototype.resize = function (w, h) {
    Scene.prototype.resize.call(this, w, h);
    this.layout();
  };

  /* ================= 商籁（沉浸） ================= */

  function SonnetScene(box) { Scene.call(this, box); this.noCommonFontScale = true; }
  inherit(SonnetScene, Scene);

  function sonnetWords(line) {
    if (!line) return [];
    if (line.words && line.words.length > 1) {
      var list = [];
      for (var i = 0; i < line.words.length; i++) {
        if (line.words[i].text && !/^\s+$/.test(line.words[i].text)) list.push(line.words[i].text);
      }
      if (list.length) return list;
    }
    var text = String(line.text || '').trim();
    if (!text) return [];
    if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(text)) {
      var chars = Array.from(text.replace(/\s+/g, ''));
      var out = [];
      for (var c = 0; c < chars.length; c += 2) out.push(chars.slice(c, c + 2).join(''));
      return out;
    }
    return text.split(/\s+/).filter(Boolean);
  }

  SonnetScene.prototype.mount = function () {
    this.bg = el('div', 'position:absolute;inset:0;', this.box);
    this.cv = el('canvas', 'position:absolute;inset:0;width:100%;height:100%;', this.box);
    this.g = this.cv.getContext('2d');
    this.eyebrow = el('div', 'position:absolute;left:30px;top:26px;font-size:11px;letter-spacing:.34em;text-transform:uppercase;', this.box);
    this.eyebrow.textContent = 'SONNET';
    this.page = el('div', 'position:absolute;right:30px;bottom:26px;font-size:11px;letter-spacing:.2em;', this.box);
    this.frame = el('div', 'position:absolute;inset:18px;pointer-events:none;', this.box);
    this.stage = el('div', 'position:absolute;inset:0;', this.box);
    this.sub = el('div', 'position:absolute;left:0;right:0;bottom:7%;text-align:center;padding:0 16px;pointer-events:none;opacity:0;transition:opacity .24s ease-out;', this.box);
    this.subText = el('div', 'font-weight:500;line-height:1.35;', this.sub);
    this.subNext = el('div', 'font-weight:400;line-height:1.35;margin-top:8px;filter:blur(1px);', this.sub);
    this.hud = null;
    this.layout();
  };

  SonnetScene.prototype.onLine = function (s) {
    if (!this.cv) this.mount();
    this.stage.textContent = '';
    this.words = [];
    var line = s.line;
    var base = this.noCommonFontScale ? 1 : 1;
    var words = sonnetWords(line);
    if (!words.length) return;

    var heroIndex = 0;
    var heroLen = 0;
    for (var i = 0; i < words.length; i++) {
      if (words[i].length > heroLen) { heroLen = words[i].length; heroIndex = i; }
    }
    var n = Math.max(1, words.length);
    var seed = (line && line.t || 0) + 1;
    var rnd = function () { var x = Math.sin(seed++) * 10000; return x - Math.floor(x); };
    var basePx = clamp(this.width / Math.max(7, n * 2.15), 24, 112) * base;
    var heroPx = Math.min(this.width * 0.4, this.height * 0.36, basePx * (2.4 + rnd() * 0.8), this.width * 0.82 / Math.max(1, words[heroIndex].length));
    var supportPx = clamp(basePx * (0.55 + rnd() * 0.25), 16, 60);

    var before = [];
    var after = [];
    for (var g = 0; g < words.length; g++) {
      if (g === heroIndex) continue;
      (g < heroIndex ? before : after).push(g);
    }

    for (var w = 0; w < words.length; w++) {
      var isHero = w === heroIndex;
      var word = el('div', 'position:absolute;white-space:nowrap;transform-origin:center;opacity:0;will-change:transform,opacity;', this.stage);
      word.textContent = words[w];
      word.style.fontWeight = isHero ? '900' : '700';
      word.style.fontSize = (isHero ? heroPx : supportPx * (0.9 + rnd() * 0.4)) + 'px';
      word.style.lineHeight = '1.2';
      word.style.color = '#ffffff';
      var left, top;
      if (isHero) {
        left = 50 + (rnd() - 0.5) * 6;
        top = 45;
        word.style.textAlign = 'center';
        word.style.transform = 'translate(-50%,-50%) rotate(' + ((rnd() - 0.5) * 3).toFixed(1) + 'deg) scale(.86)';
      } else {
        var group = w < heroIndex ? before : after;
        var pos = group.indexOf(w);
        var m = Math.max(1, group.length);
        left = 50 + ((pos + 0.5) / m - 0.5) * 74 + (rnd() - 0.5) * 4;
        left = clamp(left, 10, 90);
        top = (w < heroIndex ? 17 : 76) + (rnd() - 0.5) * 8;
        word.style.transform = 'translate(-50%,-50%) rotate(' + ((rnd() - 0.5) * 8).toFixed(1) + 'deg) scale(.9)';
        word.style.color = 'rgba(255,255,255,.72)';
      }
      word.style.left = left + '%';
      word.style.top = top + '%';
      this.stage.appendChild(word);
      this.words.push({ el: word, isHero: isHero });
      (function (node, delay, isHeroWord, tx) {
        setTimeout(function () {
          if (!node.parentNode) return;
          node.style.transition = 'opacity .6s ease, transform .7s cubic-bezier(.16,1,.3,1)';
          node.style.transitionDelay = (delay * 0.06).toFixed(2) + 's, ' + (delay * 0.06).toFixed(2) + 's';
          node.style.opacity = '1';
          node.style.transform = tx.replace(' scale(.86)', ' scale(1)').replace(' scale(.9)', ' scale(1)');
        }, 20);
      })(word, w, isHero, word.style.transform);
      if (isHero) word.style.textShadow = '2px 0 rgba(0,255,255,.3), -2px 0 rgba(255,0,68,.3)';
    }

    var tr = currentTr(s);
    var nx = nextText(s);
    setText(this.subText, tr);
    setText(this.subNext, nx);
    this.subNext.style.display = nx ? '' : 'none';
    this.sub.style.opacity = (tr || nx) ? '0.6' : '0';
    if (this.page) this.page.textContent = String((s.index + 1) || 1).padStart(2, '0') + ' / ' + String((s.lines && s.lines.length) || 0).padStart(2, '0');
    this.applyTheme(this.colors);
  };

  SonnetScene.prototype.layout = function () {
    if (!this.cv) return;
    this.cv.width = Math.max(1, this.width);
    this.cv.height = Math.max(1, this.height);
    this.cv.style.display = this.tun('backgroundMg', true) ? '' : 'none';
  };

  SonnetScene.prototype.resize = function (w, h) {
    Scene.prototype.resize.call(this, w, h);
    this.layout();
  };

  SonnetScene.prototype.onFrame = function (dt, s) {
    if (!this.g) return;
    var w = this.cv.width, h = this.cv.height;
    var g = this.g;
    var c = this.colors;
    var power = powerOf(s);
    var camera = this.tun('cameraMotion', 1) * this.tun('cameraScale', 1);
    var swim = this.tun('mgSwimScale', 1);
    var breath = this.tun('breathScale', 1);
    var ca = this.tun('caScale', 1);
    if (this.stage) {
      this.stage.style.transform = 'translate(' + (2 * camera * Math.sin(this.elapsed * 0.2)).toFixed(1) + 'px,' + (1.6 * camera * Math.cos(this.elapsed * 0.18)).toFixed(1) + 'px) scale(' + (1 + 0.006 * breath * Math.sin(this.elapsed * 1.1)).toFixed(4) + ')';
    }
    if (this.cv) this.cv.style.transform = 'translate(' + (2 * swim * Math.sin(this.elapsed * 0.14)).toFixed(1) + 'px,' + (2 * swim * Math.cos(this.elapsed * 0.12)).toFixed(1) + 'px)';
    var off = (2 * ca).toFixed(2);
    if (this.words) {
      for (var wi = 0; wi < this.words.length; wi++) {
        if (!this.words[wi].isHero) continue;
        this.words[wi].el.style.textShadow = off + 'px 0 ' + cssRgba(c.accent, 0.35) + ', -' + off + 'px 0 rgba(255,0,68,.25), 0 14px 60px ' + cssRgba(c.accent, 0.2);
      }
    }
    var showMg = this.tun('backgroundMg', true) !== false;
    var showGuide = this.tun('guide', true) !== false;
    if (!showMg) return;
    var seed = ((s.line && s.line.t) || 0) + 1;
    g.clearRect(0, 0, w, h);
    if (showGuide) {
      g.strokeStyle = cssRgba(c.primary, 0.16);
      g.lineWidth = 1.5;
      for (var i = 0; i < 9; i++) {
        var y = (0.08 + rand(i, seed) * 0.84) * h;
        var len = (0.06 + rand(i, seed + 1) * 0.22) * w;
        var x = (0.06 + rand(i, seed + 2) * 0.7) * w;
        g.globalAlpha = 0.35;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + len, y);
        g.stroke();
        g.globalAlpha = 1;
      }
      for (var k = 0; k < 4; k++) {
        var cx = (0.15 + rand(k, seed + 7) * 0.7) * w;
        var cy = (0.15 + rand(k, seed + 8) * 0.7) * h;
        var s2 = 6 + rand(k, seed + 9) * 10;
        g.strokeStyle = cssRgba(c.accent, 0.28);
        g.beginPath();
        g.moveTo(cx - s2, cy);
        g.lineTo(cx + s2, cy);
        g.moveTo(cx, cy - s2);
        g.lineTo(cx, cy + s2);
        g.stroke();
      }
    }
    if (this.frame) {
      var arm = Math.min(w, h) * 0.03;
      var pad = 18;
      g.strokeStyle = cssRgba(c.primary, 0.35);
      g.lineWidth = 1.4;
      var corners = [[pad, pad, 1, 1], [w - pad, pad, -1, 1], [pad, h - pad, 1, -1], [w - pad, h - pad, -1, -1]];
      for (var ci = 0; ci < 4; ci++) {
        var o = corners[ci];
        g.beginPath();
        g.moveTo(o[0] + arm * o[2], o[1]);
        g.lineTo(o[0], o[1]);
        g.lineTo(o[0], o[1] + arm * o[3]);
        g.stroke();
      }
    }
  };

  SonnetScene.prototype.applyTheme = function (c) {
    if (!this.bg) return;
    this.bg.style.background = 'radial-gradient(120% 100% at 30% 20%, ' + hex(mixNumeric(c.bg, c.primary, 0.1)) + ' 0%, ' + hex(c.bg) + ' 60%, #05060b 100%)';
    if (this.eyebrow) this.eyebrow.style.color = cssRgba(c.secondary, 0.7);
    if (this.page) this.page.style.color = cssRgba(c.secondary, 0.6);
    if (this.words) {
      for (var i = 0; i < this.words.length; i++) {
        var it = this.words[i];
        it.el.style.color = it.isHero ? hex(c.primary) : cssRgba(c.primary, 0.72);
        if (it.isHero) it.el.style.textShadow = '2px 0 ' + cssRgba(c.accent, 0.35) + ', -2px 0 rgba(255,0,68,.25), 0 14px 60px ' + cssRgba(c.accent, 0.2);
      }
    }
    if (this.subText) {
      this.subText.style.color = hex(c.secondary);
      this.subText.style.fontSize = Math.round(clamp(0.02 * this.width, 17, 21) * (this.fontScale || 1)) + 'px';
    }
    if (this.subNext) {
      this.subNext.style.color = hex(c.secondary);
      this.subNext.style.fontSize = Math.round(clamp(0.016 * this.width, 14, 17) * (this.fontScale || 1)) + 'px';
    }
  };

  SonnetScene.prototype.dispose = function () {
    this.words = null;
    Scene.prototype.dispose.call(this);
  };

  /* ================= 凝彩（沉浸） ================= */

  function TemperaScene(box) { Scene.call(this, box); this.noCommonFontScale = true; }
  inherit(TemperaScene, Scene);

  TemperaScene.prototype.mount = function () {
    this.bg = el('div', 'position:absolute;inset:0;', this.box);
    this.imgWrap = el('div', 'position:absolute;pointer-events:none;overflow:hidden;border-radius:14px;background-size:cover;background-position:center;opacity:0;', this.box);
    this.blockA = el('div', 'position:absolute;left:0;top:0;width:58%;height:36%;', this.box);
    this.blockB = el('div', 'position:absolute;right:0;bottom:0;width:46%;height:52%;', this.box);
    this.blockC = el('div', 'position:absolute;left:34%;top:48%;width:30%;height:22%;border-radius:50%;', this.box);
    this.watermark = el('div', 'position:absolute;right:2%;top:48%;font-size:240px;font-weight:900;line-height:1;letter-spacing:-.04em;pointer-events:none;', this.box);
    this.dots = el('div', 'position:absolute;inset:0;opacity:.3;background-image:radial-gradient(rgba(255,255,255,.6) 1.2px, transparent 1.2px);background-size:10px 10px;mix-blend-mode:overlay;', this.box);
    this.curEl = el('div', 'position:absolute;inset:0;font-weight:800;line-height:1.08;color:#fff;mix-blend-mode:difference;letter-spacing:.01em;z-index:2;', this.box);
    this.tag = el('div', 'position:absolute;right:6%;top:8%;font-size:11px;letter-spacing:.28em;color:rgba(255,255,255,.55);z-index:3;', this.box);
    this.tag.textContent = 'TEMPERA / 凝彩';
    this.corners = el('div', 'position:absolute;inset:26px;pointer-events:none;border:1px solid rgba(255,255,255,.18);z-index:3;', this.box);
    this.sub = el('div', 'position:absolute;left:50%;transform:translateX(-50%);bottom:7%;width:max-content;max-width:80%;text-align:center;padding:8px 20px;border-radius:14px;background:rgba(0,0,0,.32);backdrop-filter:blur(6px);pointer-events:none;opacity:0;transition:opacity .24s ease-out;z-index:3;', this.box);
    this.subText = el('div', 'font-weight:500;line-height:1.35;', this.sub);
    this.subNext = el('div', 'font-weight:400;line-height:1.35;margin-top:8px;filter:blur(1px);', this.sub);
    this.fx = el('div', 'position:absolute;inset:0;pointer-events:none;z-index:4;', this.box);
    this.layout();
  };

  TemperaScene.prototype.layout = function () {
    if (!this.dots) return;
    var spacing = Math.max(26, Math.sqrt(this.width * this.height / 6000));
    this.dots.style.backgroundSize = spacing + 'px ' + spacing + 'px';
  };

  TemperaScene.prototype.resize = function (w, h) {
    Scene.prototype.resize.call(this, w, h);
    this.layout();
  };

  TemperaScene.prototype.onLine = function (s) {
    if (!this.curEl) this.mount();
    var line = s.line;
    var base = this.noCommonFontScale ? 1 : (this.fontScale || 1);
    var words = sonnetWords(line);
    this.curEl.textContent = '';
    if (!words.length) return;

    var graphemes = Array.from(String(line.text).replace(/\s+/g, '')).length;
    var basePx = Math.max(30, Math.min(100, this.width / Math.max(6, graphemes * 1.35))) * base;
    var seed = (line.t || 0) + 1;
    var rnd = function () { var x = Math.sin(seed++) * 10000; return x - Math.floor(x); };
    var heroIndex = 0;
    var heroLen = 0;
    for (var i = 0; i < words.length; i++) {
      if (words[i].length > heroLen) { heroLen = words[i].length; heroIndex = i; }
    }

    // 拆成 1–3 行，行整体带横向漂移和轻微倾斜
    var rowCount = words.length >= 8 ? 3 : (words.length >= 5 ? 2 : 1);
    var rows = [];
    for (var r = 0; r < rowCount; r++) rows.push([]);
    var perRow = Math.ceil(words.length / rowCount);
    for (var w = 0; w < words.length; w++) rows[Math.min(rowCount - 1, Math.floor(w / perRow))].push(w);

    var k = 0;
    for (var ri = 0; ri < rows.length; ri++) {
      var rowEl = el('div', 'position:absolute;left:50%;white-space:nowrap;display:flex;align-items:baseline;gap:.18em;', this.curEl);
      rowEl.style.top = (50 + (ri - (rowCount - 1) / 2) * 22 + (rnd() - 0.5) * 3) + '%';
      var rowWidth = 0;
      for (var rw = 0; rw < rows[ri].length; rw++) {
        var rwIdx = rows[ri][rw];
        rowWidth += words[rwIdx].length * basePx * (rwIdx === heroIndex ? 1.42 : 0.78) + basePx * 0.18;
      }
      var rowFit = rowWidth > this.width * 0.9 ? (this.width * 0.9 / rowWidth) : 1;
      rowEl.style.transform = 'translate(-50%,-50%) translateX(' + ((rnd() - 0.5) * 6).toFixed(1) + '%) rotate(' + ((rnd() - 0.5) * 3.4).toFixed(1) + 'deg) scale(' + rowFit.toFixed(3) + ')';
      for (var wi = 0; wi < rows[ri].length; wi++) {
        var idx = rows[ri][wi];
        var isHero = idx === heroIndex;
        var sp = document.createElement('span');
        sp.textContent = words[idx];
        sp.style.display = 'inline-block';
        sp.style.fontSize = Math.round(basePx * (isHero ? 1.42 : 0.78)) + 'px';
        sp.style.fontWeight = isHero ? '900' : '700';
        sp.style.transform = 'rotate(' + ((rnd() - 0.5) * 4).toFixed(1) + 'deg) translateY(' + ((rnd() - 0.5) * 0.09).toFixed(2) + 'em)';
        sp.style.opacity = '0';
        rowEl.appendChild(sp);
        (function (node, delay) {
          setTimeout(function () {
            if (!node.parentNode) return;
            node.style.transition = 'opacity .5s ease, transform .65s cubic-bezier(.22,1,.36,1)';
            node.style.transitionDelay = (delay * 0.09).toFixed(2) + 's';
            node.style.opacity = '1';
          }, 20);
        })(sp, k++);
      }
      this.curEl.appendChild(rowEl);
    }

    var mark = Array.from(String(line.text).replace(/\s+/g, '')).slice(-1)[0] || '';
    this.watermark.textContent = mark;
    this.watermark.style.fontSize = Math.round(Math.max(120, Math.min(this.width, this.height) * 0.6)) + 'px';
    this.watermark.style.display = this.tun('decorations', true) ? '' : 'none';

    var tr = currentTr(s);
    var nx = nextText(s);
    setText(this.subText, tr);
    setText(this.subNext, nx);
    this.subNext.style.display = nx ? '' : 'none';
    this.sub.style.opacity = (tr || nx) ? '0.62' : '0';

    this.blockA.style.display = this.tun('blocks', true) ? '' : 'none';
    this.blockB.style.display = this.tun('blocks', true) ? '' : 'none';
    this.blockC.style.display = this.tun('blocks', true) ? '' : 'none';
    this.dots.style.display = this.tun('decorations', true) ? '' : 'none';
    this.tag.style.display = this.tun('decorations', true) ? '' : 'none';
    this.corners.style.display = this.tun('decorations', true) ? '' : 'none';
    this.curEl.style.mixBlendMode = this.tun('invert', true) ? 'difference' : 'normal';
    this.applyPoolImage(s.index * 10);
    this.applyTheme(this.colors);
  };

  TemperaScene.prototype.applyPoolImage = function (seed) {
    var pool = this.tun('imagePool', []);
    var freq = this.tun('imageFrequency', 0.3);
    if (!pool || !pool.length || rand(seed, 21) >= freq) {
      this.imgWrap.style.display = 'none';
      return;
    }
    var src = pool[Math.floor(rand(seed, 22) * pool.length) % pool.length];
    var size = Math.min(this.width, this.height) * this.tun('imageSize', 0.5);
    var align = this.tun('imageAlign', 'random');
    var grid = {
      tl: [6, 14], tc: [34, 14], tr: [66, 14],
      ml: [6, 36], mc: [34, 36], mr: [66, 36],
      bl: [6, 58], bc: [34, 58], br: [66, 58]
    };
    var pos;
    if (align === 'random') pos = [rand(seed, 23) * 58, 14 + rand(seed, 24) * 44];
    else if (align === 'randomH') pos = [rand(seed, 23) * 58, 36];
    else if (align === 'randomV') pos = [34, 14 + rand(seed, 24) * 44];
    else pos = grid[align] || [34, 36];
    this.imgWrap.style.width = size + 'px';
    this.imgWrap.style.height = (size * 0.72) + 'px';
    this.imgWrap.style.left = pos[0] + '%';
    this.imgWrap.style.top = pos[1] + '%';
    this.imgWrap.style.opacity = String(this.tun('imageOpacity', 0.6));
    this.imgWrap.style.backgroundImage = 'url(' + src + ')';
    this.imgWrap.style.zIndex = this.tun('imageLayer', 'below') === 'above' ? '3' : '1';
    this.imgWrap.style.display = '';
  };

  TemperaScene.prototype.onFrame = function (dt, s) {
    var power = powerOf(s);
    var camera = this.tun('cameraMotion', 1);
    var shift = Math.sin(this.elapsed * 0.5) * (6 + 10 * power) * camera;
    this.blockA.style.transform = 'translate(' + (-shift).toFixed(1) + 'px,' + (shift * 0.6).toFixed(1) + 'px)';
    this.blockB.style.transform = 'translate(' + shift.toFixed(1) + 'px,' + (-shift * 0.5).toFixed(1) + 'px)';
    this.blockC.style.transform = 'translate(' + (shift * 0.4).toFixed(1) + 'px,' + (shift * 0.8).toFixed(1) + 'px) rotate(' + (shift * 0.2).toFixed(2) + 'deg)';
    var post = this.tun('postFx', true);
    var filters = [];
    if (post && this.tun('contrast', true)) filters.push('contrast(1.08)');
    if (post && this.tun('lensDistort', false)) filters.push('saturate(1.15)');
    this.box.style.filter = filters.length ? filters.join(' ') : 'none';
    this.fx.style.boxShadow = (post && this.tun('vignette', true)) ? 'inset 0 0 180px rgba(0,0,0,.55)' : 'none';
    this.fx.style.backgroundImage = (post && this.tun('grain', true))
      ? 'radial-gradient(rgba(255,255,255,.1) 0.7px, transparent 0.7px)' : 'none';
    this.fx.style.backgroundSize = '3px 3px';
    this.fx.style.opacity = (post && this.tun('grain', true)) ? '0.3' : '0';
    this.curEl.style.textShadow = (post && this.tun('rgbShift', false))
      ? '2px 0 rgba(255,0,80,.4), -2px 0 rgba(0,200,255,.4)' : 'none';
    this.curEl.style.transform = (post && this.tun('lensDistort', false)) ? 'perspective(900px) rotateX(0.35deg)' : 'none';
    var res = this.tun('textureRes', '1');
    var compress = this.tun('textureCompress', true);
    this.curEl.style.textRendering = (res === '1' || compress) ? 'optimizeSpeed' : 'geometricPrecision';
    this.curEl.style.webkitFontSmoothing = (res === '1' || compress) ? 'auto' : 'antialiased';
  };

  TemperaScene.prototype.applyTheme = function (c) {
    if (!this.bg) return;
    this.bg.style.background = hex(c.bg);
    if (this.watermark) {
      this.watermark.style.color = 'rgba(255,255,255,.09)';
      this.watermark.style.webkitTextStroke = '1px ' + cssRgba(c.accent, 0.22);
    }
    if (this.subText) {
      this.subText.style.color = hex(c.secondary);
      this.subText.style.fontSize = Math.round(clamp(0.02 * this.width, 17, 21) * (this.fontScale || 1)) + 'px';
    }
    if (this.subNext) {
      this.subNext.style.color = hex(c.secondary);
      this.subNext.style.fontSize = Math.round(clamp(0.016 * this.width, 14, 17) * (this.fontScale || 1)) + 'px';
    }
    var mode = this.tun('colorMode', 'duo');
    if (mode === 'mono') {
      this.blockA.style.background = '#1b1b1f';
      this.blockB.style.background = '#8a8a92';
      this.blockC.style.background = '#f2f2f2';
    } else if (mode === 'gradient') {
      this.blockA.style.background = 'linear-gradient(135deg, ' + c.accentCss + ', ' + hex(c.secondary) + ')';
      this.blockB.style.background = 'linear-gradient(135deg, ' + hex(c.secondary) + ', ' + c.accentCss + ')';
      this.blockC.style.background = 'rgba(255,255,255,.9)';
    } else {
      this.blockA.style.background = c.accentCss;
      this.blockB.style.background = cssRgba(c.secondary, 0.9);
      this.blockC.style.background = 'rgba(255,255,255,.9)';
    }
  };

  /* ================= 渲染包装 ================= */

  function DomRenderer(modeId, factory) {
    this.modeId = modeId;
    this.factory = factory;
    this.layer = null;
    this.box = null;
    this.scene = null;
  }

  DomRenderer.prototype.mount = function () {
    this.layer = el('div', 'position:fixed;inset:0;z-index:3;pointer-events:none;overflow:hidden;');
    this.layer.className = 'uta-builtin-layer';
    this.box = el('div', 'position:absolute;inset:0;', this.layer);
    document.body.appendChild(this.layer);
    this.scene = this.factory(this.box);
    this.scene.modeId = this.modeId;
    this.scene.resize(window.innerWidth || 800, window.innerHeight || 600);
  };

  DomRenderer.prototype.update = function (dt, s) {
    if (this.scene) this.scene.update(dt, s);
  };

  DomRenderer.prototype.resize = function (w, h) {
    if (this.scene) this.scene.resize(w, h);
  };

  DomRenderer.prototype.dispose = function () {
    if (this.scene) {
      this.scene.dispose();
      this.scene = null;
    }
    if (this.layer && this.layer.parentNode) this.layer.parentNode.removeChild(this.layer);
    this.layer = null;
    this.box = null;
  };

  /* ================= 注册 ================= */

  var MODES = [
    { id: 'folia-still', label: '静止', order: 100, scope: 'lyric', make: function (box) { return new StillScene(box); } },
    { id: 'folia-stream', label: '流光', order: 101, scope: 'lyric', make: function (box) { return new StreamScene(box); } },
    { id: 'folia-cadenza', label: '心象', order: 102, scope: 'lyric', make: function (box) { return new CadenzaScene(box); } },
    { id: 'folia-partita', label: '云阶', order: 103, scope: 'lyric', make: function (box) { return new PartitaScene(box); } },
    { id: 'folia-cappella', label: '群唱', order: 104, scope: 'lyric', make: function (box) { return new CappellaScene(box); } },
    { id: 'folia-tilt', label: '倾诉', order: 105, scope: 'lyric', make: function (box) { return new TiltScene(box); } },
    { id: 'folia-fume', label: '浮名', order: 106, scope: 'immersive', make: function (box) { return new FumeScene(box); } },
    { id: 'folia-monet', label: '莫奈', order: 107, scope: 'immersive', make: function (box) { return new MonetScene(box); } },
    { id: 'folia-claddagh', label: '回环', order: 108, scope: 'immersive', make: function (box) { return new CladdaghScene(box); } },
    { id: 'folia-diorama', label: '镜台', order: 109, scope: 'immersive', make: function (box) { return new DioramaScene(box); } },
    { id: 'folia-pendolo', label: '时计', order: 110, scope: 'immersive', make: function (box) { return new PendoloScene(box); } },
    { id: 'folia-sonnet', label: '商籁', order: 111, scope: 'immersive', make: function (box) { return new SonnetScene(box); } },
    { id: 'folia-tempera', label: '凝彩', order: 112, scope: 'immersive', make: function (box) { return new TemperaScene(box); } }
  ];

  function installKeyframes() {
    if (document.getElementById('uta-builtin-keyframes')) return;
    var style = document.createElement('style');
    style.id = 'uta-builtin-keyframes';
    style.textContent =
      '@keyframes uta-sonnet-in{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}' +
      '@keyframes uta-tempera-in{from{opacity:0;transform:translateX(-24px) skewX(-4deg)}to{opacity:1;transform:translateX(0) skewX(0)}}' +
      '@keyframes uta-tempera-char{from{opacity:0;transform:translateY(14px) scale(1.04)}to{opacity:1;transform:translateY(0) scale(1)}}';
    document.head.appendChild(style);
  }
  installKeyframes();

  MODES.forEach(function (m) {
    if (typeof VisualizerRegistry === 'undefined' || VisualizerRegistry.has(m.id)) return;
    VisualizerRegistry.register({
      id: m.id,
      label: m.label,
      order: m.order,
      scope: m.scope,
      create: (function (modeId, factory) {
        return function () { return new DomRenderer(modeId, factory); };
      })(m.id, m.make)
    });
  });

  return {
    modes: MODES.map(function (m) { return { id: m.id, label: m.label, scope: m.scope }; })
  };
})();

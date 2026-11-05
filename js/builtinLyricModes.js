/**
 * builtinLyricModes.js — Folia 风格内置歌词演出模式（独立实现）
 * ============================================================
 * 参考 Folia 内置模式的观感与命名，用 uta-tap 自己的 DOM/Canvas 实现重写，
 * 不复制 Folia 源码（Folia 为 AGPL-3.0）。
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

  /* ================= 静止 ================= */

  function StillScene(box) { Scene.call(this, box); }
  inherit(StillScene, Scene);

  StillScene.prototype.onLine = function (s) {
    if (!this.wrap) {
      this.wrap = el('div', 'position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center;', this.box);
      this.prevEl = el('div', 'font-size:22px;color:rgba(255,255,255,.3);', this.wrap);
      this.curEl = el('div', 'font-size:40px;font-weight:600;letter-spacing:1px;', this.wrap);
      this.nextEl = el('div', 'font-size:22px;color:rgba(255,255,255,.28);', this.wrap);
      this.trEl = el('div', 'font-size:18px;color:rgba(255,255,255,.5);margin-top:4px;', this.wrap);
    }
    var lines = s.lines || [];
    var prev = prevLine(s);
    setText(this.prevEl, prev ? prev.text : '');
    setText(this.curEl, currentText(s));
    setText(this.nextEl, s.index >= 0 && lines[s.index + 1] ? lines[s.index + 1].text : '');
    setText(this.trEl, currentTr(s));
    this.prevEl.style.fontSize = this.fs(22) + 'px';
    this.curEl.style.fontSize = this.fs(40) + 'px';
    this.nextEl.style.fontSize = this.fs(22) + 'px';
    this.trEl.style.fontSize = this.fs(18) + 'px';
  };

  StillScene.prototype.applyTheme = function (c) {
    if (this.curEl) this.curEl.style.color = c.accentCss;
  };

  /* ================= 流光 ================= */

  function StreamScene(box) { Scene.call(this, box); }
  inherit(StreamScene, Scene);

  StreamScene.prototype.onLine = function (s) {
    var gap = this.tun('wordGap', 2);
    if (!this.lineEl) {
      this.glow = el('div', 'position:absolute;left:50%;top:45%;width:72%;height:34%;transform:translate(-50%,-50%);filter:blur(34px);opacity:.55;pointer-events:none;', this.box);
      this.lineEl = new CharLine(this.box, 'position:absolute;left:50%;top:43%;transform:translateX(-50%);text-align:center;', this.fs(Math.max(28, Math.min(52, this.height * 0.075))), '600', gap);
      this.bar = el('div', 'position:absolute;left:50%;top:56%;height:2px;width:0;transform:translateX(-50%);border-radius:2px;', this.box);
      this.trEl = el('div', 'position:absolute;left:50%;top:60.5%;transform:translateX(-50%);max-width:76%;text-align:center;font-size:18px;color:rgba(255,255,255,.55);', this.box);
    }
    this.lineEl.setLine(s.line);
    this.lineEl.setFontSize(this.fs(Math.max(28, Math.min(52, this.height * 0.075))));
    this.lineEl.el.style.letterSpacing = gap + 'px';
    this.trEl.style.fontSize = this.fs(18) + 'px';
    setText(this.trEl, currentTr(s));
  };

  StreamScene.prototype.onFrame = function (dt, s) {
    if (!this.lineEl) return;
    var rotate = this.tun('wordRotate', false);
    var self = this;
    this.lineEl.update(s.time, this.colors.accent, s.opts, rotate ? function (p, i) {
      return 'rotate(' + (Math.sin(self.elapsed * 1.5 + i * 0.5) * 6 * p).toFixed(2) + 'deg)';
    } : null);
    var p = this.line ? LyricTiming.lineProgress(this.line, s.time) : 0;
    var power = powerOf(s);
    var breath = this.tun('breath', 6);
    var legacy = this.tun('layout', 'auto') === 'legacy';
    this.glow.style.transform = 'translate(-50%,-50%) scale(' + (1 + 0.05 * Math.sin(this.elapsed * 1.2) + 0.08 * power).toFixed(3) + ')';
    this.bar.style.width = (p * 72).toFixed(1) + '%';
    this.bar.style.opacity = (0.25 + 0.75 * p).toFixed(2);
    this.lineEl.el.style.transform = 'translateX(-50%) translateY(' + (Math.sin(this.elapsed * 0.9) * breath * 0.5).toFixed(2) + 'px) scale(' + (1 + 0.012 * power).toFixed(3) + ')' + (legacy ? ' skewX(-4deg)' : '');
  };

  StreamScene.prototype.applyTheme = function (c) {
    if (!this.glow) return;
    this.glow.style.background = 'radial-gradient(closest-side, ' + cssRgba(c.accent, 0.65) + ', transparent 72%)';
    this.bar.style.background = 'linear-gradient(90deg, transparent, ' + c.accentCss + ', transparent)';
    this.bar.style.boxShadow = '0 0 12px ' + cssRgba(c.accent, 0.7);
  };

  /* ================= 心象 ================= */

  function CadenzaScene(box) { Scene.call(this, box); }
  inherit(CadenzaScene, Scene);

  CadenzaScene.prototype.onLine = function (s) {
    if (!this.lineEl) {
      this.orbs = [];
      for (var i = 0; i < 6; i++) {
        var orb = el('div', 'position:absolute;border-radius:50%;filter:blur(38px);opacity:.5;pointer-events:none;');
        orb.style.width = (120 + i * 34) + 'px';
        orb.style.height = (120 + i * 34) + 'px';
        this.box.appendChild(orb);
        this.orbs.push(orb);
      }
      this.lineEl = new CharLine(this.box, 'position:absolute;left:50%;top:46%;transform:translateX(-50%);text-align:center;', this.fs(Math.max(30, Math.min(56, this.height * 0.08))), '500', 4);
      this.trEl = el('div', 'position:absolute;left:50%;top:61%;transform:translateX(-50%);max-width:76%;text-align:center;font-size:18px;color:rgba(255,255,255,.55);', this.box);
    }
    this.lineEl.setLine(s.line);
    this.lineEl.setFontSize(this.fs(Math.max(30, Math.min(56, this.height * 0.08))));
    this.trEl.style.fontSize = this.fs(18) + 'px';
    setText(this.trEl, currentTr(s));
  };

  CadenzaScene.prototype.onFrame = function (dt, s) {
    var power = powerOf(s);
    for (var i = 0; i < this.orbs.length; i++) {
      var o = this.orbs[i];
      var x = 18 + 64 * (0.5 + 0.5 * Math.sin(this.elapsed * 0.12 + i * 1.7));
      var y = 22 + 56 * (0.5 + 0.5 * Math.cos(this.elapsed * 0.1 + i * 1.3));
      o.style.left = x + '%';
      o.style.top = y + '%';
      o.style.transform = 'translate(-50%,-50%) scale(' + (0.9 + 0.2 * Math.sin(this.elapsed * 0.4 + i) + 0.15 * power).toFixed(3) + ')';
    }
    if (this.lineEl) {
      this.lineEl.update(s.time, this.colors.accent, s.opts);
      this.lineEl.el.style.transform = 'translateX(-50%) scale(' + (1 + 0.012 * Math.sin(this.elapsed * 0.9) + 0.02 * power).toFixed(3) + ')';
    }
  };

  CadenzaScene.prototype.applyTheme = function (c) {
    if (!this.orbs) return;
    for (var i = 0; i < this.orbs.length; i++) {
      var col = i % 2 ? c.secondary : c.accent;
      this.orbs[i].style.background = 'radial-gradient(circle, ' + cssRgba(col, 0.34) + ', transparent 70%)';
    }
  };

  /* ================= 云阶 ================= */

  function PartitaScene(box) { Scene.call(this, box); }
  inherit(PartitaScene, Scene);

  PartitaScene.prototype.onLine = function (s) {
    if (!this.curEl) {
      this.prevEl = el('div', 'position:absolute;left:7%;top:33%;width:42%;text-align:left;font-size:26px;color:rgba(255,255,255,.34);', this.box);
      this.bar = el('div', 'position:absolute;left:7%;top:41.5%;height:3px;width:0;border-radius:2px;', this.box);
      this.guide = el('div', 'position:absolute;left:6%;right:6%;top:45%;height:1px;background:rgba(255,255,255,.1);', this.box);
      this.curEl = el('div', 'position:absolute;left:12%;top:45%;width:76%;text-align:left;font-size:44px;font-weight:700;line-height:1.25;letter-spacing:1px;', this.box);
      this.trEl = el('div', 'position:absolute;left:12%;top:59%;width:70%;text-align:left;font-size:18px;color:rgba(255,255,255,.5);', this.box);
      this.nextEl = el('div', 'position:absolute;right:7%;top:68%;width:52%;text-align:right;font-size:26px;color:rgba(255,255,255,.3);', this.box);
    }
    var prev = prevLine(s);
    setText(this.prevEl, prev ? prev.text : '');
    setText(this.curEl, currentText(s));
    setText(this.trEl, currentTr(s));
    setText(this.nextEl, nextText(s));
    this.layout(s);
  };

  PartitaScene.prototype.layout = function (s) {
    if (!this.curEl) return;
    var min = this.tun('offsetMin', 4);
    var max = this.tun('offsetMax', 14);
    var off = Math.round(min + (max - min) * 0.6);
    var semantic = this.tun('semantic', true);
    var extra = semantic && s ? Math.min(6, (currentText(s).length || 0) * 0.35) : 0;
    this.prevEl.style.left = off + '%';
    this.curEl.style.left = Math.round(off + 6 + extra) + '%';
    this.nextEl.style.right = off + '%';
    this.trEl.style.left = Math.round(off + 6 + extra) + '%';
    this.bar.style.left = off + '%';
    this.prevEl.style.fontSize = this.fs(26) + 'px';
    this.curEl.style.fontSize = this.fs(Math.max(28, Math.min(52, this.height * 0.072))) + 'px';
    this.trEl.style.fontSize = this.fs(18) + 'px';
    this.nextEl.style.fontSize = this.fs(26) + 'px';
    var guide = this.tun('guide', true);
    this.bar.style.display = guide ? '' : 'none';
    this.guide.style.display = guide ? '' : 'none';
  };

  PartitaScene.prototype.onFrame = function (dt, s) {
    var p = this.line ? LyricTiming.lineProgress(this.line, s.time) : 0;
    var power = powerOf(s);
    this.bar.style.width = (p * 34).toFixed(1) + '%';
    this.bar.style.opacity = (0.3 + 0.7 * p).toFixed(2);
    this.prevEl.style.transform = 'translateY(' + (-4 - 3 * power).toFixed(1) + 'px)';
    this.nextEl.style.transform = 'translateY(' + (4 + 3 * power).toFixed(1) + 'px)';
    this.curEl.style.transform = 'translateX(' + (2 * Math.sin(this.elapsed * 0.7)).toFixed(1) + 'px)';
  };

  PartitaScene.prototype.applyTheme = function (c) {
    if (!this.bar) return;
    this.bar.style.background = c.accentCss;
    this.bar.style.boxShadow = '0 0 10px ' + cssRgba(c.accent, 0.5);
    this.curEl.style.color = '#ffffff';
  };

  /* ================= 群唱 ================= */

  function CappellaScene(box) { Scene.call(this, box); }
  inherit(CappellaScene, Scene);

  CappellaScene.prototype.onLine = function (s) {
    if (!this.feed) {
      this.feed = el('div', 'position:absolute;left:5%;bottom:12%;width:46%;max-height:64%;display:flex;flex-direction:column;justify-content:flex-end;gap:8px;', this.box);
    }
    this.feed.textContent = '';
    this.currentBubble = null;
    this.emojiEl = null;
    var lines = s.lines || [];
    if (s.index < 0 || !lines.length) return;
    var from = Math.max(0, s.index - 4);
    for (var i = from; i <= s.index; i++) {
      var line = lines[i];
      if (!line || !line.text) continue;
      var isCur = i === s.index;
      var bubble = el('div', 'position:relative;display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);opacity:' + (isCur ? '1' : '0.45') + ';', this.feed);
      var avatar = el('div', 'width:28px;height:28px;border-radius:50%;flex:0 0 28px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;background-size:cover;background-position:center;', bubble);
      var body = el('div', 'flex:1;min-width:0;', bubble);
      var name = el('div', 'font-size:11px;color:rgba(255,255,255,.45);margin-bottom:2px;', body);
      name.textContent = (s.song && s.song.artist) || 'Miku';
      var text = el('div', 'font-size:' + this.fs(isCur ? 19 : 16) + 'px;line-height:1.35;color:' + (isCur ? '#fff' : 'rgba(255,255,255,.7)') + ';', body);
      text.textContent = line.text;
      var avatarSrc = this.tun('customAvatar', '');
      var avatarSource = this.tun('avatarSource', 'builtin');
      if (avatarSource === 'custom' && avatarSrc) {
        avatar.style.backgroundImage = 'url(' + avatarSrc + ')';
      } else if (avatarSource === 'cover' && s.coverUrl) {
        avatar.style.backgroundImage = 'url(' + s.coverUrl + ')';
      } else {
        avatar.textContent = Array.from(line.text)[0] || '♪';
        if (avatarSource === 'theme') {
          avatar.style.background = isCur
            ? 'linear-gradient(135deg, ' + this.colors.accentCss + ', ' + hex(this.colors.secondary) + ')'
            : 'rgba(255,255,255,.16)';
        } else {
          avatar.style.background = 'linear-gradient(135deg, ' + hex(this.colors.primary) + ', ' + hex(this.colors.secondary) + ')';
        }
      }
      if (isCur) {
        if (line.tr && (!s.opts || s.opts.translation !== false)) {
          var tr = el('div', 'font-size:' + this.fs(12) + 'px;color:rgba(255,255,255,.45);margin-top:2px;', body);
          tr.textContent = line.tr;
        }
        this.currentBubble = bubble;
        if (this.tun('showEmoji', true)) {
          this.emojiEl = el('div', 'position:absolute;right:-6px;top:-8px;font-size:15px;opacity:.8;', bubble);
          var emojiSrc = this.tun('customEmoji', '');
          if (this.tun('emojiSource', 'builtin') === 'custom' && emojiSrc) {
            var im = el('img', 'width:20px;height:20px;object-fit:contain;display:block;', this.emojiEl);
            im.src = emojiSrc;
          } else {
            this.emojiEl.textContent = '✨';
          }
        }
        bubble.style.borderColor = cssRgba(this.colors.accent, 0.5);
        bubble.style.background = 'linear-gradient(180deg, ' + cssRgba(this.colors.accent, 0.16) + ', rgba(255,255,255,.04))';
      }
    }
  };

  CappellaScene.prototype.onFrame = function (dt, s) {
    if (!this.currentBubble) return;
    var power = powerOf(s);
    this.currentBubble.style.transform = 'scale(' + (1 + 0.012 * power).toFixed(3) + ')';
    if (this.emojiEl) this.emojiEl.style.opacity = (0.35 + 0.65 * power).toFixed(2);
  };

  /* ================= 倾诉 ================= */

  function TiltScene(box) { Scene.call(this, box); }
  inherit(TiltScene, Scene);

  TiltScene.prototype.onLine = function (s) {
    if (!this.lineEl) {
      this.halo = el('div', 'position:absolute;left:50%;top:47%;width:56%;height:34%;transform:translate(-50%,-50%);filter:blur(40px);opacity:.4;border-radius:50%;', this.box);
      this.lineEl = new CharLine(this.box, 'position:absolute;left:50%;top:45%;transform:translateX(-50%);text-align:center;', this.fs(Math.max(30, Math.min(54, this.height * 0.078))), '600', 3);
      this.trEl = el('div', 'position:absolute;left:50%;top:61%;transform:translateX(-50%);max-width:76%;text-align:center;font-size:18px;color:rgba(255,255,255,.55);', this.box);
    }
    var breakChance = this.tun('breakChance', 0.25);
    var text = s.line ? (s.line.text || '') : '';
    var breakIndex = -1;
    if (breakChance > 0 && text.length > 8 && rand(s.index, 3) < breakChance) {
      var mid = Math.floor(text.length / 2);
      var candidates = [' ', '，', ',', '、', '。'];
      var best = -1;
      for (var c = 0; c < candidates.length; c++) {
        var at = text.indexOf(candidates[c], mid);
        if (at > 0 && (best < 0 || Math.abs(at - mid) < Math.abs(best - mid))) best = at;
      }
      if (best > 0) breakIndex = Array.from(text.slice(0, best)).length;
    }
    this.lineEl.setFontSize(this.fs(Math.max(30, Math.min(54, this.height * 0.078))));
    this.lineEl.setLine(s.line, { breakIndex: breakIndex, italicChance: this.tun('italicChance', 0.2) });
    this.trEl.style.fontSize = this.fs(18) + 'px';
    setText(this.trEl, currentTr(s));
  };

  TiltScene.prototype.onFrame = function (dt, s) {
    if (!this.lineEl) return;
    var power = powerOf(s);
    var self = this;
    this.lineEl.update(s.time, this.colors.accent, s.opts, function (p, i) {
      var wave = Math.sin(self.elapsed * 1.7 + i * 0.55);
      var amp = 0.35 + p * 0.65;
      return 'translateY(' + (wave * 5.5 * amp).toFixed(2) + 'px) rotate(' + (wave * 3.2 * amp).toFixed(2) + 'deg)';
    });
    var mode = this.tun('colorMode', 'duo');
    var len = this.lineEl.items.length || 1;
    var c = this.colors;
    for (var i = 0; i < this.lineEl.items.length; i++) {
      var p = this.lineEl.line ? (this.lineEl.items[i] && LyricTiming.charProgress(this.lineEl.items[i], s.time)) : 0;
      var col;
      if (mode === 'mono') col = c.accent;
      else if (mode === 'gradient') col = mixNumeric(c.accent, c.secondary, i / Math.max(1, len - 1));
      else col = i % 2 ? c.secondary : c.accent;
      this.lineEl.items[i].el.style.color = hex(mixNumeric(0xffffff, col, 0.3 + 0.7 * p));
    }
    this.lineEl.el.style.transform = 'translateX(-50%) scale(' + (1 + 0.015 * power).toFixed(3) + ')';
  };

  TiltScene.prototype.applyTheme = function (c) {
    if (!this.halo) return;
    this.halo.style.background = 'radial-gradient(circle, ' + cssRgba(c.accent, 0.4) + ', transparent 70%)';
  };

  /* ================= 浮名（沉浸） ================= */

  function FumeScene(box) { Scene.call(this, box); }
  inherit(FumeScene, Scene);

  FumeScene.prototype.onLine = function (s) {
    var titleScale = this.tun('titleScale', 1);
    if (!this.cv) {
      this.box.style.background = 'radial-gradient(120% 100% at 50% 40%, #141a2e 0%, #070912 62%, #03040a 100%)';
      this.cv = el('canvas', 'position:absolute;inset:0;width:100%;height:100%;', this.box);
      this.g = this.cv.getContext('2d');
      this.lineEl = new CharLine(this.box, 'position:absolute;left:50%;top:47%;transform:translateX(-50%);text-align:center;', this.fs(Math.max(30, Math.min(50, this.height * 0.072)) * titleScale), '500', 3);
      this.trEl = el('div', 'position:absolute;left:50%;top:60%;transform:translateX(-50%);max-width:76%;text-align:center;font-size:18px;color:rgba(255,255,255,.5);', this.box);
      this.cam = 0;
      this.layout();
    }
    this.lineEl.setFontSize(this.fs(Math.max(30, Math.min(50, this.height * 0.072)) * titleScale));
    this.lineEl.setLine(s.line);
    this.trEl.style.fontSize = this.fs(18) + 'px';
    setText(this.trEl, currentTr(s));
  };

  FumeScene.prototype.layout = function () {
    if (!this.cv) return;
    this.cv.width = Math.max(1, this.width);
    this.cv.height = Math.max(1, this.height);
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
    var snap = this.tun('cameraFollow', 'smooth') === 'snap';
    var glow = this.tun('glow', 0.7);
    var dwell = this.tun('textDwell', 0.8);
    var target = this.elapsed * camSpeed;
    this.cam += (target - this.cam) * (snap ? 0.5 : 0.06);
    this.g.clearRect(0, 0, w, h);
    var grad = this.g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hex(c.bg));
    grad.addColorStop(1, '#02030a');
    this.g.fillStyle = grad;
    this.g.fillRect(0, 0, w, h);
    if (showGeometry) {
      var count = hideBoxes ? 8 : 16;
      if (!hideBoxes) {
        for (var s = 0; s < 6; s++) {
          var sx = rand(s, 31) * w;
          var sy = rand(s, 32) * h;
          var ss = 30 + rand(s, 33) * 90;
          this.g.fillStyle = cssRgba(c.accent, 0.035 + 0.03 * power);
          this.g.fillRect(sx, sy, ss, ss * 0.55);
        }
      }
      this.g.strokeStyle = cssRgba(c.accent, (0.18 + 0.12 * power) * objOpacity);
      this.g.lineWidth = 1;
      for (var i = 0; i < count; i++) {
        var cx = rand(i, 1) * w;
        var cy = rand(i, 2) * h;
        var r = 30 + rand(i, 3) * 130;
        var rot = this.cam * (0.06 + rand(i, 4) * 0.1) + i;
        var sides = 3 + Math.floor(rand(i, 5) * 4);
        this.g.beginPath();
        for (var k = 0; k < sides; k++) {
          var a = rot + k / sides * Math.PI * 2;
          var x = cx + Math.cos(a) * r * (0.7 + 0.3 * rand(i, k + 6));
          var y = cy + Math.sin(a) * r * 0.62;
          if (k === 0) this.g.moveTo(x, y); else this.g.lineTo(x, y);
        }
        this.g.closePath();
        this.g.stroke();
      }
    }
    if (this.lineEl) {
      this.lineEl.update(s.time, c.accent, s.opts);
      this.lineEl.el.style.opacity = dwell;
      this.lineEl.el.style.textShadow = '0 0 ' + (6 + 18 * glow).toFixed(1) + 'px ' + cssRgba(c.accent, 0.25 + 0.4 * glow) + ', 0 18px 30px rgba(0,0,0,.65)';
    }
  };

  /* ================= 莫奈（沉浸） ================= */

  function MonetScene(box) { Scene.call(this, box); }
  inherit(MonetScene, Scene);

  MonetScene.prototype.onLine = function (s) {
    var fontScale = this.tun('fontScale', 1);
    if (!this.lineEl) {
      this.bgImg = el('img', 'position:absolute;left:-8%;top:-8%;width:116%;height:116%;object-fit:cover;transform:scale(1.04);', this.box);
      this.bgImg.crossOrigin = 'anonymous';
      this.overlay = el('div', 'position:absolute;inset:0;', this.box);
      this.tintEl = el('div', 'position:absolute;inset:0;pointer-events:none;mix-blend-mode:soft-light;opacity:0;', this.box);
      this.washEl = el('div', 'position:absolute;inset:0;pointer-events:none;mix-blend-mode:color;opacity:0;', this.box);
      this.portrait = el('div', 'position:absolute;right:7%;top:20%;width:28%;border-radius:20px;overflow:hidden;border:1px solid rgba(255,255,255,.28);box-shadow:0 30px 80px rgba(0,0,0,.55);', this.box);
      this.portraitImg = el('img', 'width:100%;height:100%;object-fit:cover;', this.portrait);
      this.portraitImg.crossOrigin = 'anonymous';
      this.glow = el('div', 'position:absolute;inset:0;pointer-events:none;opacity:0;', this.box);
      this.lineEl = new CharLine(this.box, 'position:absolute;left:7%;top:48%;max-width:54%;text-align:left;', this.fs(Math.max(30, Math.min(52, this.height * 0.073)) * fontScale), '500', 2);
      this.trEl = el('div', 'position:absolute;left:7%;top:63%;max-width:54%;text-align:left;font-size:18px;color:rgba(255,255,255,.55);', this.box);
      this.descEl = el('div', 'position:absolute;left:7%;top:68%;max-width:54%;text-align:left;font-size:13px;letter-spacing:.08em;color:rgba(255,255,255,.35);', this.box);
      this.bars = el('canvas', 'position:absolute;left:0;right:0;bottom:0;width:100%;height:64px;opacity:.55;', this.box);
      this.bg = this.bars.getContext('2d');
    }
    this.lineEl.setFontSize(this.fs(Math.max(30, Math.min(52, this.height * 0.073)) * fontScale));
    this.lineEl.setLine(s.line);
    this.trEl.style.fontSize = this.fs(18) + 'px';
    setText(this.trEl, currentTr(s));
    setText(this.descEl, this.tun('showDesc', false) && s.song ? ((s.song.artist || '') + (s.song.album ? ' · ' + s.song.album : '')) : '');
    this.portrait.style.aspectRatio = this.tun('coverShape', 'tall') === 'square' ? '1 / 1' : '3 / 4';
    this.portrait.style.width = this.tun('coverShape', 'tall') === 'square' ? '22%' : '28%';
    this.portrait.style.pointerEvents = this.tun('portraitDragOn', false) ? 'auto' : 'none';
    this.portrait.style.cursor = this.tun('portraitDragOn', false) ? 'grab' : 'default';
    if (this.tun('portraitDragOn', false) && !this._dragBound) {
      this._dragBound = true;
      var self = this;
      this.portrait.addEventListener('mousedown', function (e) { self.startDrag(e); });
    }
    this.layout();
  };

  MonetScene.prototype.startDrag = function (e) {
    if (!this.portrait) return;
    e.preventDefault();
    var rect = this.portrait.getBoundingClientRect();
    var startX = e.clientX, startY = e.clientY;
    var left = rect.left, top = rect.top;
    var self = this;
    this.portrait.style.left = left + 'px';
    this.portrait.style.top = top + 'px';
    this.portrait.style.right = 'auto';
    this.portrait.style.cursor = 'grabbing';
    function move(ev) {
      self.portrait.style.left = (left + ev.clientX - startX) + 'px';
      self.portrait.style.top = (top + ev.clientY - startY) + 'px';
    }
    function up() {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      self.portrait.style.cursor = 'grab';
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  MonetScene.prototype.layout = function () {
    if (!this.bars) return;
    this.bars.width = Math.max(1, this.width);
    this.bars.height = 64;
  };

  MonetScene.prototype.onFrame = function (dt, s) {
    var power = powerOf(s);
    var bgUrl = this.tun('backgroundSource', 'cover') === 'custom'
      ? this.tun('customBackground', '') : (s.coverUrl || '');
    var portraitUrl = this.tun('portraitSource', 'cover') === 'custom'
      ? this.tun('customPortrait', '') : (s.coverUrl || '');
    if (bgUrl !== this._bgUrl) {
      this._bgUrl = bgUrl;
      if (bgUrl) { this.bgImg.src = bgUrl; this.bgImg.style.display = ''; }
      else this.bgImg.style.display = 'none';
    }
    if (portraitUrl !== this._portraitUrl) {
      this._portraitUrl = portraitUrl;
      if (portraitUrl) { this.portraitImg.src = portraitUrl; this.portrait.style.display = ''; }
      else this.portrait.style.display = 'none';
    }
    var blur = this.tun('blur', 18);
    var sat = this.tun('saturation', 1.1);
    var desat = this.tun('desaturate', 0);
    this.bgImg.style.filter = 'blur(' + blur + 'px) saturate(' + sat + ') brightness(' + (0.52 - desat * 0.25).toFixed(2) + ') grayscale(' + Math.round(desat * 100) + '%)';
    this.bgImg.style.objectPosition = (50 + this.tun('imageOffset', 0)) + '% 50%';
    this.portraitImg.style.objectPosition = (50 + this.tun('imageOffset', 0)) + '% 50%';
    this.bgImg.style.transform = 'scale(' + (1.05 + 0.02 * Math.sin(this.elapsed * 0.16) + 0.02 * power).toFixed(3) + ')';
    this.portrait.style.transform = 'translateY(' + (-4 * Math.sin(this.elapsed * 0.22)).toFixed(2) + 'px)';
    this.glow.style.opacity = (0.15 + 0.55 * power).toFixed(2);
    var wash = this.tun('wash', false);
    this.washEl.style.opacity = wash ? '0.55' : '0';
    this.tintEl.style.background = this.colors.accentCss;
    this.tintEl.style.opacity = (this.tun('themeTint', 0.3) * 0.55).toFixed(2);
    var washColor = this.tun('washSource', 'theme') === 'custom' ? this.tun('washColor', '#5f7cff') : this.colors.accentCss;
    this.washEl.style.background = washColor;
    this.descEl.style.display = this.tun('showDesc', false) ? '' : 'none';
    this.bars.style.display = this.tun('audioBars', true) ? '' : 'none';
    if (this.tun('audioBars', true) && s.audio && s.audio.spectrum) this.drawBars(s.audio.spectrum, power);
    else if (this.bg) this.bg.clearRect(0, 0, this.bars.width, this.bars.height);
    var keyword = this.tun('keyword', true);
    if (this.lineEl) {
      this.lineEl.update(s.time, keyword ? this.colors.accent : 0xffffff, s.opts);
      this.lineEl.el.style.textShadow = '0 10px 30px rgba(0,0,0,.6)';
    }
  };

  MonetScene.prototype.drawBars = function (spectrum, power) {
    if (!this.bg) return;
    var w = this.bars.width, h = this.bars.height;
    this.bg.clearRect(0, 0, w, h);
    var n = 56;
    var step = w / n;
    var style = this.tun('barStyle', 'bars');
    this.bg.strokeStyle = cssRgba(this.colors.accent, 0.5);
    this.bg.fillStyle = cssRgba(this.colors.accent, 0.35);
    this.bg.lineWidth = 1.5;
    for (var i = 0; i < n; i++) {
      var v = spectrum[Math.floor(i / n * spectrum.length)] / 255 || 0;
      var bh = Math.max(2, v * h * (0.55 + power * 0.4));
      if (style === 'lines') {
        this.bg.beginPath();
        this.bg.moveTo(i * step + step / 2, h);
        this.bg.lineTo(i * step + step / 2, h - bh);
        this.bg.stroke();
      } else {
        this.bg.fillRect(i * step + 1, h - bh, Math.max(1, step - 2), bh);
      }
    }
  };

  MonetScene.prototype.applyTheme = function (c) {
    if (!this.overlay) return;
    this.box.style.background = hex(c.bg);
    var half = this.tun('layoutMode', 'full') === 'half';
    this.overlay.style.background = half
      ? 'linear-gradient(90deg, ' + cssRgba(c.bg, 0.96) + ' 0%, ' + cssRgba(c.bg, 0.88) + ' 48%, ' + cssRgba(c.bg, 0.2) + ' 100%)'
      : 'linear-gradient(100deg, ' + cssRgba(c.bg, 0.94) + ' 0%, ' + cssRgba(c.bg, 0.7) + ' 46%, ' + cssRgba(c.bg, 0.3) + ' 100%)';
    var tint = this.tun('themeTint', 0.3);
    this.overlay.style.boxShadow = 'inset 0 0 160px ' + cssRgba(c.accent, tint * 0.6);
    this.glow.style.background = 'radial-gradient(circle at 30% 45%, ' + cssRgba(c.accent, 0.35) + ', transparent 60%)';
    if (this.lineEl) this.lineEl.el.style.textShadow = '0 10px 30px rgba(0,0,0,.6)';
  };

  /* ================= 回环（沉浸） ================= */

  function CladdaghScene(box) { Scene.call(this, box); }
  inherit(CladdaghScene, Scene);

  CladdaghScene.prototype.onLine = function (s) {
    var focus = this.tun('focusScale', 1.25);
    var gap = this.tun('letterGap', 3);
    var tilt = this.tun('tilt', -16);
    if (!this.cv) {
      this.box.style.background = 'radial-gradient(130% 100% at 50% 45%, #12152a 0%, #06070f 65%, #020309 100%)';
      this.cv = el('canvas', 'position:absolute;inset:0;width:100%;height:100%;', this.box);
      this.g = this.cv.getContext('2d');
      this.prevEl = el('div', 'position:absolute;left:7%;top:36%;width:34%;text-align:left;font-size:24px;color:rgba(255,255,255,.32);', this.box);
      this.nextEl = el('div', 'position:absolute;right:7%;top:58%;width:34%;text-align:right;font-size:24px;color:rgba(255,255,255,.3);', this.box);
      this.lineEl = new CharLine(this.box, 'position:absolute;left:50%;top:46%;transform:translateX(-50%);text-align:center;', this.fs(Math.max(30, Math.min(50, this.height * 0.072)) * focus), '500', gap);
      this.trEl = el('div', 'position:absolute;left:50%;top:60%;transform:translateX(-50%);max-width:72%;text-align:center;font-size:18px;color:rgba(255,255,255,.5);', this.box);
      this.layout();
    }
    var prev = prevLine(s);
    setText(this.prevEl, prev ? prev.text : '');
    setText(this.nextEl, nextText(s));
    this.lineEl.setFontSize(this.fs(Math.max(30, Math.min(50, this.height * 0.072)) * focus));
    this.lineEl.el.style.letterSpacing = gap + 'px';
    this.lineEl.setLine(s.line);
    this.trEl.style.fontSize = this.fs(18) + 'px';
    setText(this.trEl, currentTr(s));
    this.prevEl.style.fontSize = this.fs(24) + 'px';
    this.nextEl.style.fontSize = this.fs(24) + 'px';
    this.prevEl.style.transform = 'rotate(' + tilt + 'deg)';
    this.nextEl.style.transform = 'rotate(' + tilt + 'deg)';
    this.lineEl.el.style.transform = 'translateX(-50%) rotate(' + (tilt * 0.35) + 'deg)';
  };

  CladdaghScene.prototype.layout = function () {
    if (!this.cv) return;
    this.cv.width = Math.max(1, this.width);
    this.cv.height = Math.max(1, this.height);
  };

  CladdaghScene.prototype.onFrame = function (dt, s) {
    if (!this.g) return;
    var w = this.cv.width, h = this.cv.height;
    var c = this.colors;
    var tilt = this.tun('tilt', -16) * Math.PI / 180;
    var radius = this.tun('radius', 0.42);
    this.g.clearRect(0, 0, w, h);
    var cx = w * 0.5, cy = h * 0.44;
    var rx = w * radius, ry = h * radius * 0.45;
    this.g.save();
    this.g.translate(cx, cy);
    this.g.rotate(tilt);
    if (this.tun('axis', true)) {
      this.g.strokeStyle = cssRgba(c.accent, 0.12);
      this.g.lineWidth = 1;
      this.g.beginPath();
      this.g.moveTo(-rx * 1.1, 0);
      this.g.lineTo(rx * 1.1, 0);
      this.g.stroke();
    }
    this.g.strokeStyle = cssRgba(c.accent, 0.3);
    this.g.lineWidth = 1.4;
    this.g.setLineDash([6, 8]);
    this.g.beginPath();
    this.g.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    this.g.stroke();
    this.g.setLineDash([]);
    for (var i = 0; i < 3; i++) {
      var a = this.elapsed * (0.12 + i * 0.05) + i * 2.1;
      this.g.strokeStyle = cssRgba(c.accent, 0.5 - i * 0.1);
      this.g.lineWidth = 2.2 - i * 0.4;
      this.g.beginPath();
      this.g.ellipse(0, 0, rx, ry, 0, a, a + 0.7);
      this.g.stroke();
    }
    this.g.restore();
    if (this.lineEl) this.lineEl.update(s.time, c.accent, s.opts);
  };

  /* ================= 镜台（沉浸） ================= */

  function DioramaScene(box) { Scene.call(this, box); }
  inherit(DioramaScene, Scene);

  DioramaScene.prototype.onLine = function (s) {
    if (!this.cv) {
      this.box.style.background = 'radial-gradient(120% 100% at 50% 50%, #0b1022 0%, #04050c 70%, #010207 100%)';
      this.cv = el('canvas', 'position:absolute;inset:0;width:100%;height:100%;', this.box);
      this.g = this.cv.getContext('2d');
      this.soulEl = new CharLine(this.box, 'position:absolute;left:50%;top:46%;transform:translate(-50%, 12px);text-align:center;opacity:.24;filter:blur(3px);', this.fs(Math.max(30, Math.min(50, this.height * 0.072))), '500', 3);
      this.lineEl = new CharLine(this.box, 'position:absolute;left:50%;top:46%;transform:translateX(-50%);text-align:center;', this.fs(Math.max(30, Math.min(50, this.height * 0.072))), '500', 3);
      this.trEl = el('div', 'position:absolute;left:50%;top:60%;transform:translateX(-50%);max-width:76%;text-align:center;font-size:18px;color:rgba(255,255,255,.5);', this.box);
      this.layout();
    }
    var density = this.tun('density', 1);
    var shape = this.tun('shape', 'ring');
    var ringDensity = this.tun('ringDensity', 1);
    var radialDensity = this.tun('radialDensity', 1);
    var count = Math.round(190 * density);
    this.points = [];
    for (var i = 0; i < count; i++) {
      var x, y, z;
      if (shape === 'cube') {
        x = rand(i, 1) * 2 - 1;
        y = rand(i, 2) * 2 - 1;
        z = rand(i, 3) * 2 - 1;
      } else if (shape === 'cylinder') {
        var a = rand(i, 4) * Math.PI * 2 * ringDensity;
        var rad = 0.55 + rand(i, 5) * 0.45 * radialDensity;
        x = Math.cos(a) * rad;
        y = rand(i, 2) * 2 - 1;
        z = Math.sin(a) * rad;
      } else if (shape === 'crystal') {
        var t = rand(i, 6);
        var a2 = rand(i, 7) * Math.PI * 2;
        var rr = (1 - t) * 0.95;
        x = Math.cos(a2) * rr;
        y = (t - 0.5) * 1.6;
        z = Math.sin(a2) * rr;
      } else {
        var ang = (i / Math.max(1, count)) * Math.PI * 2 * ringDensity;
        var rad2 = 0.7 + rand(i, 5) * 0.3 * radialDensity;
        x = Math.cos(ang) * rad2;
        y = Math.sin(ang) * rad2;
        z = (rand(i, 3) - 0.5) * 0.2;
      }
      this.points.push({ x: x, y: y, z: z, s: 0.6 + rand(i, 4) * 1.2 });
    }
    this.lineEl.setFontSize(this.fs(Math.max(30, Math.min(50, this.height * 0.072))));
    this.soulEl.setFontSize(this.fs(Math.max(30, Math.min(50, this.height * 0.072))));
    this.lineEl.setLine(s.line);
    this.soulEl.setLine(s.line);
    this.soulEl.el.style.display = this.tun('soulFollow', false) ? '' : 'none';
    this.trEl.style.fontSize = this.fs(18) + 'px';
    setText(this.trEl, currentTr(s));
  };

  DioramaScene.prototype.layout = function () {
    if (!this.cv) return;
    this.cv.width = Math.max(1, this.width);
    this.cv.height = Math.max(1, this.height);
  };

  DioramaScene.prototype.onFrame = function (dt, s) {
    if (!this.g) return;
    var w = this.cv.width, h = this.cv.height;
    var c = this.colors;
    var power = powerOf(s);
    var cameraSpeed = this.tun('cameraSpeed', 1);
    var motion = this.tun('motion', 1);
    var volume = this.tun('volume', 1);
    var glow = this.tun('glow', true);
    var glowStrength = this.tun('glowStrength', 0.8);
    var audioResponse = this.tun('audioResponse', true);
    var bgParticles = this.tun('bgParticles', true);
    var geometry = this.tun('geometry', 'points');
    var cam = this.elapsed * 0.35 * cameraSpeed;
    this.g.clearRect(0, 0, w, h);
    var cx = w * 0.5, cy = h * 0.45;
    if (geometry === 'corridor') {
      this.g.strokeStyle = cssRgba(c.accent, 0.18);
      this.g.lineWidth = 1;
      for (var k = 0; k < 18; k++) {
        var pz = ((k / 18 + cam * 0.15) % 1);
        var scaleK = 1 / (1.2 + pz * 2.5);
        var half = w * 0.55 * scaleK;
        var yy = cy + (pz - 0.5) * h * 0.9 * motion;
        this.g.beginPath();
        this.g.moveTo(cx - half, yy);
        this.g.lineTo(cx + half, yy);
        this.g.stroke();
      }
      this.g.strokeStyle = cssRgba(c.accent, 0.12);
      for (var side = 0; side < 8; side++) {
        var sx = cx + (side / 7 - 0.5) * w * 1.1;
        this.g.beginPath();
        this.g.moveTo(cx, cy - h * 0.1);
        this.g.lineTo(sx, h);
        this.g.stroke();
      }
    } else {
      if (bgParticles) {
        for (var b = 0; b < 60; b++) {
          var bx = w * rand(b, 11), by = h * rand(b, 12);
          this.g.fillStyle = cssRgba(c.accent, 0.08 + 0.06 * rand(b, 13));
          this.g.fillRect(bx, by, 1.2, 1.2);
        }
      }
      for (var i = 0; i < this.points.length; i++) {
        var p = this.points[i];
        var z = p.z + Math.sin(cam * 0.5 + i) * 0.04 * motion;
        var scale = 1 / (z + 2.2);
        var x = cx + p.x * scale * w * 0.55 * motion;
        var y = cy + p.y * scale * h * 0.5 * motion;
        var r = Math.max(0.6, scale * p.s * (1.4 + (audioResponse ? power * 0.8 : 0)) * volume);
        var alpha = clamp(0.15 + scale * 0.35, 0, 0.75);
        this.g.fillStyle = cssRgba(i % 5 === 0 ? c.secondary : c.accent, alpha);
        if (glow) {
          this.g.shadowColor = cssRgba(c.accent, 0.5 * glowStrength);
          this.g.shadowBlur = 8 * glowStrength;
        }
        this.g.beginPath();
        this.g.arc(x, y, r, 0, Math.PI * 2);
        this.g.fill();
      }
      this.g.shadowBlur = 0;
    }
    if (this.lineEl) {
      var strength = this.tun('strength', 'mid');
      var mult = strength === 'weak' ? 0.5 : (strength === 'strong' ? 1.6 : (strength === 'custom' ? this.tun('customStrength', 1) : 1));
      this.lineEl.update(s.time, this.tun('keyword', true) ? c.accent : 0xffffff, s.opts);
      if (this.tun('soulFollow', false) && this.soulEl) {
        this.soulEl.el.style.display = '';
        this.soulEl.update(s.time, c.accent, s.opts);
        this.soulEl.el.style.opacity = (0.16 + 0.12 * mult).toFixed(2);
        this.soulEl.el.style.transform = 'translate(-50%, ' + (10 + 6 * mult).toFixed(1) + 'px) scale(1.02)';
      } else if (this.soulEl) {
        this.soulEl.el.style.display = 'none';
      }
      if (this.tun('charSoul', false)) {
        for (var ci = 0; ci < this.lineEl.items.length; ci++) {
          this.lineEl.items[ci].el.style.textShadow = '0 10px 6px ' + cssRgba(c.accent, 0.35);
        }
      } else {
        for (var cj = 0; cj < this.lineEl.items.length; cj++) {
          this.lineEl.items[cj].el.style.textShadow = '';
        }
      }
      if (this.tun('gradientFollow', false)) {
        for (var gi = 0; gi < this.lineEl.items.length; gi++) {
          var gp = LyricTiming.charProgress(this.lineEl.items[gi], s.time);
          var gcol = mixNumeric(c.accent, c.secondary, this.lineEl.items.length > 1 ? gi / (this.lineEl.items.length - 1) : 0);
          this.lineEl.items[gi].el.style.color = hex(mixNumeric(0xffffff, gcol, 0.25 + 0.75 * gp));
        }
      }
      var glowOn = this.tun('glowFollow', true);
      this.lineEl.el.style.textShadow = glowOn
        ? '0 0 ' + (8 + 16 * mult).toFixed(1) + 'px ' + cssRgba(c.accent, 0.3 + 0.25 * mult) + ', 0 20px 40px rgba(0,0,0,.7)'
        : '0 20px 40px rgba(0,0,0,.7)';
    }
  };

  /* ================= 时计（沉浸） ================= */

  function PendoloScene(box) { Scene.call(this, box); }
  inherit(PendoloScene, Scene);

  PendoloScene.prototype.onLine = function (s) {
    var focus = this.tun('focusScale', 1);
    if (!this.cv) {
      this.box.style.background = 'radial-gradient(120% 100% at 50% 40%, #141326 0%, #070610 70%, #020208 100%)';
      this.cv = el('canvas', 'position:absolute;inset:0;width:100%;height:100%;', this.box);
      this.g = this.cv.getContext('2d');
      this.orbit = el('div', 'position:absolute;inset:0;pointer-events:none;opacity:.45;', this.box);
      this.orbitChars = [];
      this.coverWrap = el('div', 'position:absolute;left:50%;top:44%;width:0;height:0;border-radius:50%;overflow:hidden;transform:translate(-50%,-50%);border:1px solid rgba(255,255,255,.3);box-shadow:0 0 40px rgba(0,0,0,.6);', this.box);
      this.coverImg = el('img', 'width:100%;height:100%;object-fit:cover;', this.coverWrap);
      this.coverImg.crossOrigin = 'anonymous';
      this.lineEl = new CharLine(this.box, 'position:absolute;left:50%;top:69%;transform:translateX(-50%);text-align:center;', this.fs(Math.max(26, Math.min(44, this.height * 0.062)) * focus), '500', 2);
      this.trEl = el('div', 'position:absolute;left:50%;top:79%;transform:translateX(-50%);max-width:74%;text-align:center;font-size:17px;color:rgba(255,255,255,.5);', this.box);
      this.layout();
    }
    this.lineEl.setFontSize(this.fs(Math.max(26, Math.min(44, this.height * 0.062)) * focus));
    this.lineEl.setLine(s.line);
    this.trEl.style.fontSize = this.fs(17) + 'px';
    setText(this.trEl, currentTr(s));
    this.coverWrap.style.display = this.tun('showCover', true) ? '' : 'none';
    var orbitText = nextText(s) || currentText(s);
    var orbitChars = Array.from(orbitText || '').slice(0, 22);
    this.orbit.textContent = '';
    this.orbitChars = [];
    for (var oi = 0; oi < orbitChars.length; oi++) {
      var osp = document.createElement('span');
      osp.textContent = orbitChars[oi] === ' ' ? '·' : orbitChars[oi];
      osp.style.cssText = 'position:absolute;font-size:' + this.fs(14) + 'px;color:rgba(255,255,255,.7);white-space:pre;';
      this.orbit.appendChild(osp);
      this.orbitChars.push(osp);
    }
  };

  PendoloScene.prototype.layout = function () {
    if (!this.cv) return;
    this.cv.width = Math.max(1, this.width);
    this.cv.height = Math.max(1, this.height);
    var r = Math.min(this.width, this.height) * this.tun('wheelR', 0.2);
    this.coverWrap.style.width = (r * 1.2) + 'px';
    this.coverWrap.style.height = (r * 1.2) + 'px';
  };

  PendoloScene.prototype.onFrame = function (dt, s) {
    if (!this.g) return;
    if (s.coverUrl !== this.coverUrl) {
      this.coverUrl = s.coverUrl;
      this.coverWrap.style.display = s.coverUrl && this.tun('showCover', true) ? '' : 'none';
      if (s.coverUrl) this.coverImg.src = s.coverUrl;
    }
    var w = this.cv.width, h = this.cv.height;
    var c = this.colors;
    var wheelX = this.tun('wheelX', 50) / 100;
    var wheelR = this.tun('wheelR', 0.2);
    var arcDeg = this.tun('arc', 300);
    var escapement = this.tun('escapement', 0.4);
    var gear = this.tun('gearStyle', 'half');
    var cx = w * wheelX, cy = h * 0.44;
    var r = Math.min(w, h) * wheelR;
    this.coverWrap.style.left = (wheelX * 100) + '%';
    this.g.clearRect(0, 0, w, h);
    var arcRad = arcDeg * Math.PI / 180;
    var orbitStart = -Math.PI / 2 - arcRad / 2 + this.elapsed * 0.08;
    var orbitStep = arcRad / Math.max(1, this.orbitChars.length - 1);
    for (var oi = 0; oi < this.orbitChars.length; oi++) {
      var oa = orbitStart + oi * orbitStep;
      var ox = cx + Math.cos(oa) * r * 0.92;
      var oy = cy + Math.sin(oa) * r * 0.92;
      this.orbitChars[oi].style.left = ox + 'px';
      this.orbitChars[oi].style.top = oy + 'px';
      this.orbitChars[oi].style.transform = 'translate(-50%,-50%) rotate(' + (oa + Math.PI / 2) + 'rad)';
    }
    if (this.tun('centerGradient', true)) {
      var cg = this.g.createRadialGradient(cx, cy, 0, cx, cy, r * 1.15);
      cg.addColorStop(0, 'rgba(0,0,0,.55)');
      cg.addColorStop(1, 'rgba(0,0,0,0)');
      this.g.fillStyle = cg;
      this.g.beginPath();
      this.g.arc(cx, cy, r * 1.15, 0, Math.PI * 2);
      this.g.fill();
    }
    this.g.strokeStyle = cssRgba(c.accent, 0.35);
    this.g.lineWidth = 2;
    this.g.beginPath();
    this.g.arc(cx, cy, r, 0, Math.PI * 2);
    this.g.stroke();
    if (gear !== 'none') {
      this.g.strokeStyle = cssRgba(c.accent, gear === 'full' ? 0.3 : 0.16);
      this.g.lineWidth = 1;
      for (var i = 0; i < 60; i++) {
        var a = i / 60 * Math.PI * 2;
        var inner = i % 5 === 0 ? r * 0.9 : r * 0.95;
        this.g.beginPath();
        this.g.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
        this.g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        this.g.stroke();
      }
      if (gear === 'full') {
        this.g.strokeStyle = cssRgba(c.accent, 0.2);
        for (var t = 0; t < 24; t++) {
          var ta = t / 24 * Math.PI * 2 + this.elapsed * 0.04;
          this.g.beginPath();
          this.g.moveTo(cx + Math.cos(ta) * r * 1.06, cy + Math.sin(ta) * r * 1.06);
          this.g.lineTo(cx + Math.cos(ta) * r * 1.16, cy + Math.sin(ta) * r * 1.16);
          this.g.stroke();
        }
      }
    }
    this.g.strokeStyle = cssRgba(c.accent, 0.12);
    var arcStart = -Math.PI / 2 - (arcDeg / 2) * Math.PI / 180;
    var arcEnd = -Math.PI / 2 + (arcDeg / 2) * Math.PI / 180;
    this.g.beginPath();
    this.g.arc(cx, cy, r * 0.86, arcStart, arcEnd);
    this.g.stroke();
    var jitter = Math.sin(this.elapsed * 20) * escapement * 0.02;
    var sec = this.elapsed * 6;
    var min = this.elapsed * 0.1;
    if (this.tun('lineGlow', true)) {
      this.g.shadowColor = cssRgba(c.accent, 0.6);
      this.g.shadowBlur = 10;
    }
    this.g.strokeStyle = c.accentCss;
    this.g.lineWidth = 2;
    this.g.beginPath();
    this.g.moveTo(cx, cy);
    this.g.lineTo(cx + Math.cos(min - Math.PI / 2 + jitter) * r * 0.55, cy + Math.sin(min - Math.PI / 2 + jitter) * r * 0.55);
    this.g.stroke();
    this.g.strokeStyle = 'rgba(255,255,255,.8)';
    this.g.lineWidth = 1.4;
    this.g.beginPath();
    this.g.moveTo(cx, cy);
    this.g.lineTo(cx + Math.cos(sec - Math.PI / 2 + jitter) * r * 0.78, cy + Math.sin(sec - Math.PI / 2 + jitter) * r * 0.78);
    this.g.stroke();
    this.g.shadowBlur = 0;
    if (this.lineEl) this.lineEl.update(s.time, c.accent, s.opts);
  };

  /* ================= 商籁（沉浸） ================= */

  function SonnetScene(box) { Scene.call(this, box); this.noCommonFontScale = true; }
  inherit(SonnetScene, Scene);

  SonnetScene.prototype.onLine = function (s) {
    if (!this.curEl) {
      this.bg = el('div', 'position:absolute;inset:0;', this.box);
      this.grid = el('div', 'position:absolute;inset:0;opacity:.12;background-image:linear-gradient(rgba(255,255,255,.5) 1px, transparent 1px),linear-gradient(90deg, rgba(255,255,255,.5) 1px, transparent 1px);background-size:64px 64px;', this.box);
      this.hollow = el('div', 'position:absolute;right:4%;top:30%;font-size:160px;font-weight:800;line-height:1;color:transparent;-webkit-text-stroke:1px rgba(255,255,255,.12);letter-spacing:-6px;pointer-events:none;', this.box);
      this.frameDecor = el('div', 'position:absolute;inset:10px;border:1px solid rgba(255,255,255,.16);pointer-events:none;', this.box);
      this.trail = el('div', 'position:absolute;left:12%;top:60%;width:0;height:1px;background:rgba(255,255,255,.14);', this.box);
      this.bar = el('div', 'position:absolute;left:8%;top:16%;width:4px;bottom:16%;', this.box);
      this.eyebrow = el('div', 'position:absolute;left:12%;top:13%;font-size:12px;letter-spacing:.32em;color:rgba(255,255,255,.45);', this.box);
      this.eyebrow.textContent = 'SONNET / 商籁';
      this.curEl = el('div', 'position:absolute;left:12%;top:36%;width:72%;font-family:inherit;font-size:' + this.fs(Math.min(72, Math.max(34, this.height * 0.085))) + 'px;line-height:1.22;color:#fff;', this.box);
      this.trEl = el('div', 'position:absolute;left:12%;top:66%;width:56%;font-size:18px;line-height:1.6;color:rgba(255,255,255,.55);border-left:2px solid rgba(255,255,255,.18);padding-left:12px;', this.box);
      this.page = el('div', 'position:absolute;right:9%;bottom:12%;font-size:12px;letter-spacing:.2em;color:rgba(255,255,255,.35);', this.box);
      this.nextEl = el('div', 'position:absolute;right:9%;top:22%;width:26%;text-align:right;font-size:22px;line-height:1.5;color:rgba(255,255,255,.28);', this.box);
      this.fx = el('div', 'position:absolute;inset:0;pointer-events:none;', this.box);
    }
    var textOnly = this.tun('textOnly', false);
    var showMain = this.tun('showMain', true) && !textOnly ? true : this.tun('showMain', true);
    var decorations = this.tun('decorations', true) && !textOnly;
    var density = this.tun('lineDensity', 1);
    this.curEl.style.display = showMain ? '' : 'none';
    this.curEl.style.fontSize = this.fs(Math.min(72, Math.max(34, this.height * 0.085))) + 'px';
    this.trEl.style.fontSize = this.fs(18) + 'px';
    this.nextEl.style.fontSize = this.fs(22) + 'px';
    setText(this.curEl, currentText(s));
    setText(this.trEl, currentTr(s));
    setText(this.nextEl, nextText(s));
    setText(this.hollow, Array.from(currentText(s)).slice(0, 2).join(''));
    this.hollow.style.display = decorations && this.tun('hollowTitle', true) ? '' : 'none';
    this.trail.style.display = decorations && this.tun('trail', true) ? '' : 'none';
    this.grid.style.display = decorations ? '' : 'none';
    this.grid.style.backgroundSize = Math.max(24, 64 / Math.max(0.2, density)) + 'px ' + Math.max(24, 64 / Math.max(0.2, density)) + 'px';
    this.grid.style.opacity = String(0.04 + 0.12 * density);
    this.eyebrow.style.display = decorations && this.tun('floatingText', true) ? '' : 'none';
    this.page.style.display = decorations && this.tun('floatingText', true) ? '' : 'none';
    this.nextEl.style.display = (decorations && nextText(s)) ? '' : 'none';
    this.bar.style.display = textOnly ? 'none' : '';
    this.page.textContent = String((s.index + 1) || 1).padStart(2, '0') + ' / ' + String((s.lines && s.lines.length) || 0).padStart(2, '0');
    this.trail.style.width = (this.tun('trail', true) ? 44 : 0) + '%';
    var frame = this.tun('frameStyle', 'frame');
    this.box.style.border = (frame === 'none' || textOnly) ? 'none' : '1px solid rgba(255,255,255,.1)';
    this.frameDecor.style.display = (frame === 'full' && !textOnly) ? '' : 'none';
    this.box.style.boxSizing = 'border-box';
    var motion = this.tun('textMotion', 1) * this.tun('motionScale', 1) * this.tun('transitionMotionScale', 1);
    var transition = this.tun('sceneTransition', true);
    this.curEl.style.animation = 'none';
    void this.curEl.offsetWidth;
    this.curEl.style.animation = transition ? 'uta-sonnet-in ' + (0.5 / Math.max(0.2, motion)).toFixed(2) + 's cubic-bezier(.2,.8,.3,1) both' : 'none';
    this.trEl.style.animation = 'none';
    void this.trEl.offsetWidth;
    this.trEl.style.animation = transition ? 'uta-sonnet-in ' + (0.6 / Math.max(0.2, motion)).toFixed(2) + 's .06s cubic-bezier(.2,.8,.3,1) both' : 'none';
  };

  SonnetScene.prototype.onFrame = function (dt, s) {
    var power = powerOf(s);
    this.bar.style.background = this.colors.accentCss;
    this.bar.style.transform = 'scaleY(' + (0.75 + 0.25 * power).toFixed(3) + ')';
    // K3Panel 倍率（默认 1，未启用模组时与原来完全一致）
    var camera = this.tun('cameraMotion', 1) * this.tun('cameraScale', 1);
    var swim = this.tun('mgSwimScale', 1);
    var drift = this.tun('driftScale', 1);
    var parallax = this.tun('parallaxScale', 1);
    var breath = this.tun('breathScale', 1);
    var ca = this.tun('caScale', 1);
    var ghost = this.tun('ghostScale', 1);
    var blur = this.tun('transitionBlurScale', 1);
    var glitch = this.tun('transitionGlitchScale', 1);
    this.grid.style.transform = 'translate(' + (2 * camera * swim * Math.sin(this.elapsed * 0.2)).toFixed(1) + 'px,' + (2 * camera * swim * Math.cos(this.elapsed * 0.18)).toFixed(1) + 'px)';
    this.hollow.style.transform = 'translateX(' + (6 * Math.sin(this.elapsed * 0.15) * camera * parallax).toFixed(1) + 'px) scale(' + (1 + 0.012 * breath * Math.sin(this.elapsed * 1.1)).toFixed(4) + ')';
    if (this.nextEl) this.nextEl.style.transform = 'translateY(' + (4 * Math.sin(this.elapsed * 0.9) * drift).toFixed(1) + 'px)';
    if (this.page) this.page.style.transform = 'translateY(' + (3 * Math.cos(this.elapsed * 0.7) * drift).toFixed(1) + 'px)';
    var post = this.tun('postFx', true);
    var contrast = post && this.tun('contrast', true);
    var filters = [];
    if (contrast) filters.push('contrast(1.06)');
    if (post && this.tun('lensDistort', false)) filters.push('saturate(1.1)');
    this.box.style.filter = filters.length ? filters.join(' ') : 'none';
    this.fx.style.boxShadow = (post && this.tun('vignette', true)) ? 'inset 0 0 180px rgba(0,0,0,.55)' : 'none';
    this.fx.style.backgroundImage = (post && this.tun('halftone', false))
      ? 'radial-gradient(rgba(255,255,255,.15) 1px, transparent 1px)' : (post && this.tun('grain', true))
        ? 'radial-gradient(rgba(255,255,255,.08) 0.7px, transparent 0.7px)' : 'none';
    this.fx.style.backgroundSize = (post && this.tun('halftone', false)) ? '6px 6px' : '3px 3px';
    this.fx.style.opacity = post && (this.tun('halftone', false) || this.tun('grain', true)) ? '0.35' : '0';
    var shadows = [];
    if (post && this.tun('rgbShift', false)) {
      var off = (2 * ca + Math.sin(this.elapsed * 12) * 0.6 * glitch).toFixed(2);
      shadows.push(off + 'px 0 rgba(255,0,80,.35)', '-' + off + 'px 0 rgba(0,200,255,.35)');
    } else if (post && this.tun('lensDispersion', false)) {
      var off2 = (1 * ca).toFixed(2);
      shadows.push(off2 + 'px 0 rgba(255,0,80,.3)', '-' + off2 + 'px 0 rgba(0,120,255,.3)');
    }
    if (ghost > 1) shadows.push('0 0 ' + (8 * ghost).toFixed(1) + 'px rgba(255,255,255,' + Math.min(.28, 0.1 * ghost).toFixed(2) + ')');
    this.curEl.style.textShadow = shadows.length ? shadows.join(', ') : 'none';
    this.curEl.style.filter = blur > 1 ? 'blur(' + ((blur - 1) * 0.9).toFixed(2) + 'px)' : 'none';
    this.curEl.style.transform = (post && this.tun('lensDistort', false)) ? 'perspective(900px) rotateX(0.35deg)' : 'none';
    var res = this.tun('textureRes', '1');
    this.curEl.style.textRendering = res === '1' ? 'optimizeSpeed' : 'geometricPrecision';
    this.curEl.style.webkitFontSmoothing = res === '1' ? 'auto' : 'antialiased';
    this.hollow.style.opacity = post ? '1' : '0.5';
  };

  SonnetScene.prototype.applyTheme = function (c) {
    if (!this.bg) return;
    this.bg.style.background = 'linear-gradient(135deg, ' + hex(c.bg) + ' 0%, ' + hex(mixNumeric(c.bg, c.primary, 0.28)) + ' 100%)';
    this.bar.style.background = c.accentCss;
    this.hollow.style.webkitTextStroke = '1px ' + cssRgba(c.accent, 0.16);
  };

  /* ================= 凝彩（沉浸） ================= */

  function TemperaScene(box) { Scene.call(this, box); this.noCommonFontScale = true; }
  inherit(TemperaScene, Scene);

  TemperaScene.prototype.onLine = function (s) {
    if (!this.curEl) {
      this.bg = el('div', 'position:absolute;inset:0;', this.box);
      this.imgWrap = el('div', 'position:absolute;pointer-events:none;overflow:hidden;border-radius:14px;background-size:cover;background-position:center;opacity:0;', this.box);
      this.blockA = el('div', 'position:absolute;left:0;top:0;width:58%;height:36%;', this.box);
      this.blockB = el('div', 'position:absolute;right:0;bottom:0;width:46%;height:52%;', this.box);
      this.blockC = el('div', 'position:absolute;left:34%;top:48%;width:30%;height:22%;', this.box);
      this.dots = el('div', 'position:absolute;inset:0;opacity:.35;background-image:radial-gradient(rgba(255,255,255,.55) 1.2px, transparent 1.2px);background-size:10px 10px;mix-blend-mode:overlay;', this.box);
      this.curEl = el('div', 'position:absolute;left:7%;top:34%;width:86%;font-weight:800;line-height:1.16;color:#fff;mix-blend-mode:difference;letter-spacing:1px;white-space:pre-line;z-index:2;', this.box);
      this.trEl = el('div', 'position:absolute;left:9%;top:64%;max-width:58%;font-size:18px;line-height:1.5;color:#fff;background:rgba(0,0,0,.34);padding:5px 10px;border-radius:6px;z-index:2;', this.box);
      this.tag = el('div', 'position:absolute;right:6%;top:8%;font-size:11px;letter-spacing:.28em;color:rgba(255,255,255,.55);z-index:2;', this.box);
      this.tag.textContent = 'TEMPERA / 凝彩';
      this.fx = el('div', 'position:absolute;inset:0;pointer-events:none;z-index:4;', this.box);
    }
    var whole = this.tun('wholeLine', true);
    var text = currentText(s);
    this._chunks = null;
    this._chunkIndex = -1;
    var displayText = text;
    if (!whole && text.length > 8) {
      var chars = Array.from(text);
      var n = Math.min(4, Math.max(2, Math.round(chars.length / 6)));
      var size = Math.ceil(chars.length / n);
      this._chunks = [];
      for (var ci = 0; ci < chars.length; ci += size) {
        this._chunks.push(chars.slice(ci, ci + size).join(''));
      }
      displayText = this._chunks[0] || text;
      this._chunkIndex = 0;
    }
    var fsBase = Math.min(64, Math.max(32, this.height * 0.082)) * (whole ? 1 : 1.35);
    this.curEl.style.fontSize = this.fs(fsBase) + 'px';
    this.trEl.style.fontSize = this.fs(18) + 'px';
    var transition = this.tun('sceneTransition', true);
    var motion = this.tun('charMotion', 1);
    var timing = this.tun('charTiming', 0.5);
    this.renderTemperaText(displayText, transition, motion, timing);
    setText(this.trEl, currentTr(s));
    this.blockA.style.display = this.tun('blocks', true) ? '' : 'none';
    this.blockB.style.display = this.tun('blocks', true) ? '' : 'none';
    this.blockC.style.display = this.tun('blocks', true) ? '' : 'none';
    this.dots.style.display = this.tun('decorations', true) ? '' : 'none';
    this.tag.style.display = this.tun('decorations', true) ? '' : 'none';
    this.curEl.style.mixBlendMode = this.tun('invert', true) ? 'difference' : 'normal';
    this.applyPoolImage(s.index * 10);
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

  TemperaScene.prototype.renderTemperaText = function (text, transition, motion, timing) {
    var el = this.curEl;
    el.textContent = '';
    var chars = Array.from(text || '');
    var n = chars.length || 1;
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      if (ch === '\n') {
        el.appendChild(document.createElement('br'));
        continue;
      }
      var sp = document.createElement('span');
      sp.textContent = ch;
      sp.style.display = 'inline-block';
      sp.style.whiteSpace = 'pre';
      if (transition) {
        var delay = (1 - timing) * 0.02 + timing * (i / n) * 0.45;
        var dur = 0.2 + 0.25 / Math.max(0.2, motion);
        sp.style.animation = 'uta-tempera-char ' + dur.toFixed(2) + 's ' + delay.toFixed(2) + 's ease-out both';
      }
      el.appendChild(sp);
    }
  };

  TemperaScene.prototype.onFrame = function (dt, s) {
    if (this._chunks && this._chunks.length > 1 && this.line) {
      var start = this.line.t;
      var end = this.line.end || this.line.timingEnd || start + 1;
      var cp = Math.min(0.999, Math.max(0, (s.time - start) / Math.max(0.2, end - start)));
      var cidx = Math.min(this._chunks.length - 1, Math.floor(cp * this._chunks.length));
      if (cidx !== this._chunkIndex) {
        this._chunkIndex = cidx;
        this.applyPoolImage(s.index * 10 + cidx + 1);
        this.renderTemperaText(
          this._chunks[cidx],
          this.tun('sceneTransition', true),
          this.tun('charMotion', 1),
          this.tun('charTiming', 0.5)
        );
      }
    }
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

/**
 * coreLayer.js — 星海共振 · 中心特效层
 * ====================================================================
 * 4 种中心视觉，均绘制在网格/粒子之上、歌词之下，不拦截输入：
 *
 *   core     流体核心   低频驱动的呼吸流体球 + 外圈实时波形环（点击向外扩散圆环）
 *   mandala  曼陀罗     点击生成笔触，按镜像份数环形复制并累积成对称图案，随歌曲推进淡出
 *   orbit    粒子星环   粒子环绕核心旋转，点击从核心弹出并被轨道捕获，连击加速
 *   poly     多面体     线框反棱柱缓慢旋转，音量驱动顶点缩放与抖动
 *   none     关闭       仅保留原有环形频谱
 *
 * 接口：
 *   var cl = new CoreLayer();
 *   cl.init(container, { getTheme, themeId });
 *   cl.setMode('core'); cl.setParam('core', 'breath', 0.4);
 *   cl.setTheme(theme); cl.tick(dt, spectrumData);
 *   cl.onTap(x, y, strength); cl.clear(); cl.resize(w, h);
 */
(function (global) {
  'use strict';

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // 频谱区间均值（0..1）
  function band(data, from, to) {
    if (!data || !data.length) return 0;
    var s = 0, n = 0;
    for (var i = from; i <= to && i < data.length; i++) { s += data[i]; n++; }
    return n ? (s / n) / 255 : 0;
  }

  /* ============================================================
   * 模式元数据（设置面板 / 播放器面板据此渲染）
   * ============================================================ */

  var MODE_META = {
    core: {
      name: '流体核心',
      params: [
        { key: 'size', label: '核心尺寸', min: 0.06, max: 0.26, step: 0.005, def: 0.13 },
        { key: 'breath', label: '呼吸幅度', min: 0, max: 0.8, step: 0.02, def: 0.28 },
        { key: 'glow', label: '辉光强度', min: 0, max: 1, step: 0.05, def: 0.55 }
      ]
    },
    mandala: {
      name: '曼陀罗',
      params: [
        { key: 'mirror', label: '镜像份数', min: 4, max: 16, step: 1, def: 8 },
        { key: 'length', label: '笔触长度', min: 0.05, max: 0.35, step: 0.01, def: 0.16 },
        { key: 'fade', label: '消退速度', min: 0.05, max: 1, step: 0.05, def: 0.22 }
      ]
    },
    orbit: {
      name: '粒子星环',
      params: [
        { key: 'count', label: '粒子数', min: 20, max: 220, step: 10, def: 100 },
        { key: 'radius', label: '轨道半径', min: 0.08, max: 0.4, step: 0.01, def: 0.18 },
        { key: 'spin', label: '转速', min: 0.1, max: 3, step: 0.05, def: 1 }
      ]
    },
    poly: {
      name: '音频多面体',
      params: [
        { key: 'faces', label: '面数', min: 4, max: 12, step: 1, def: 6 },
        { key: 'spin', label: '旋转速度', min: 0, max: 2, step: 0.05, def: 0.6 },
        { key: 'react', label: '音频响应', min: 0, max: 2, step: 0.05, def: 1 }
      ]
    },
    none: {
      name: '关闭',
      params: []
    }
  };

  var MODE_ORDER = ['core', 'mandala', 'orbit', 'poly', 'none'];

  /* ============================================================
   * 多面体（反棱柱）几何
   * ============================================================ */

  function buildPoly(n) {
    var verts = [], edges = [], i;
    for (i = 0; i < n; i++) {
      var a1 = (i / n) * Math.PI * 2;
      var a2 = a1 + Math.PI / n;
      verts.push([Math.cos(a1), -0.62, Math.sin(a1)]); // 上环
      verts.push([Math.cos(a2), 0.62, Math.sin(a2)]);  // 下环（错位，构成反棱柱）
    }
    for (i = 0; i < n; i++) {
      var t0 = i * 2, b0 = i * 2 + 1;
      var t1 = ((i + 1) % n) * 2, b1 = ((i + 1) % n) * 2 + 1;
      edges.push([t0, t1]); // 上环
      edges.push([b0, b1]); // 下环
      edges.push([t0, b0]); // 竖边
      edges.push([t0, b1]); // 斜撑
    }
    return { verts: verts, edges: edges };
  }

  /* ============================================================
   * CoreLayer
   * ============================================================ */

  function CoreLayer() {
    this.mode = 'core';
    this.theme = null;
    this.palette = [0x00f0ff, 0xff00aa, 0x7fff00, 0xffcc00];
    this.accent = 0x00f0ff;

    this.params = {};
    Object.keys(MODE_META).forEach(function (m) {
      var o = {};
      MODE_META[m].params.forEach(function (s) { o[s.key] = s.def; });
      this.params[m] = o;
    }, this);

    this.w = 1;
    this.h = 1;
    this._time = 0;
    this._rot = 0;
    this._bass = 0;
    this._mid = 0;
    this._hi = 0;
    this._power = 0;
    this._spinBoost = 0;

    this._strokes = [];   // 曼陀罗笔触
    this._orbits = [];    // 星环粒子
    this._taps = [];      // 星环点击弹出
    this._rings = [];     // 核心点击涟漪

    this._poly = null;
    this._polyKey = 0;
    this._polyA = 0;
    this._polyB = 0;
    this._tapJitter = 0;

    this.costMs = 0;

    this._root = null;
    this.glow = null;
    this.g = null;
  }

  CoreLayer.prototype.init = function (container, opts) {
    opts = opts || {};
    this._getTheme = opts.getTheme || null;

    this._root = new PIXI.Container();
    this._root.interactive = false;
    this._root.interactiveChildren = false;

    // 加色图层：流体/光点，视觉上更接近「发光」
    this.glow = new PIXI.Graphics();
    this.glow.blendMode = PIXI.BLEND_MODES.ADD;
    this.g = new PIXI.Graphics();

    this._root.addChild(this.glow);
    this._root.addChild(this.g);
    container.addChild(this._root);

    if (this._getTheme) this.setTheme(this._getTheme());
    return this;
  };

  CoreLayer.prototype.setTheme = function (theme) {
    if (!theme) return;
    this.theme = theme;
    var pal = (theme.particles || []).slice();
    if (!pal.length) pal = [0x00f0ff, 0xff00aa, 0x7fff00, 0xffcc00];
    while (pal.length < 4) pal.push(pal[pal.length - 1]);
    this.palette = pal;
    this.accent = theme.accent || pal[0];
  };

  CoreLayer.prototype.setMode = function (modeId) {
    if (!MODE_META[modeId]) modeId = 'core';
    this.mode = modeId;
    this._strokes = [];
    this._taps = [];
    this._rings = [];
    this._spinBoost = 0;
    if (this.g) this.g.clear();
    if (this.glow) this.glow.clear();
    if (this._root) this._root.visible = modeId !== 'none';
  };

  CoreLayer.prototype.setParam = function (modeId, key, value) {
    if (!this.params[modeId]) return;
    this.params[modeId][key] = value;
  };

  CoreLayer.prototype.getParam = function (modeId, key) {
    return this.params[modeId] ? this.params[modeId][key] : undefined;
  };

  CoreLayer.prototype.resize = function (w, h) {
    this.w = w || this.w;
    this.h = h || this.h;
    // 轨道粒子半径与画面尺寸无关，重建仅需一次
    this._orbits = [];
  };

  /** 点击/拖拽/键盘打拍：各模式留下痕迹 */
  CoreLayer.prototype.onTap = function (x, y, strength) {
    if (this.mode === 'none' || !this._root) return;
    var s = strength == null ? 1 : strength;
    var cx = this.w / 2, cy = this.h / 2;
    var dx = x - cx, dy = y - cy;
    var base = Math.min(this.w, this.h);

    if (this.mode === 'mandala') {
      var p = this.params.mandala;
      var life = 6 / Math.max(0.05, p.fade);
      // 落点太靠近中心时沿上方铺笔，避免图案塌缩成一点
      if (Math.sqrt(dx * dx + dy * dy) < base * 0.04) {
        dx = 0;
        dy = -base * 0.12;
      }
      this._strokes.push({
        x: dx * 0.92,
        y: dy * 0.92,
        len: base * p.length * (0.7 + s * 0.6),
        bend: (Math.random() - 0.5) * 0.7,
        color: this.palette[Math.floor(Math.random() * this.palette.length)],
        age: 0,
        life: life,
        strength: s
      });
      if (this._strokes.length > 160) this._strokes.splice(0, this._strokes.length - 160);
      return;
    }

    if (this.mode === 'orbit') {
      this._taps.push({
        a: Math.atan2(dy, dx),
        r: 0.6 + Math.random() * 0.7,
        age: 0,
        life: 0.9 + Math.random() * 0.3,
        color: this.palette[Math.floor(Math.random() * this.palette.length)]
      });
      if (this._taps.length > 60) this._taps.shift();
      this._spinBoost = Math.min(2.6, this._spinBoost + 0.28 * s);
      return;
    }

    if (this.mode === 'core') {
      this._rings.push({ age: 0, life: 1.1 });
      if (this._rings.length > 8) this._rings.shift();
      return;
    }

    if (this.mode === 'poly') {
      this._tapJitter = Math.min(1.6, this._tapJitter + 0.7 * s);
    }
  };

  /** 换歌/重置：清空累积痕迹 */
  CoreLayer.prototype.clear = function () {
    this._strokes = [];
    this._taps = [];
    this._rings = [];
    this._spinBoost = 0;
    this._tapJitter = 0;
  };

  CoreLayer.prototype.destroy = function () {
    if (this._root) {
      this._root.removeChildren();
      this._root.destroy({ children: true, texture: false, baseTexture: false });
    }
    this._root = null;
    this.glow = null;
    this.g = null;
  };

  /* ============================================================
   * 每帧绘制
   * ============================================================ */

  CoreLayer.prototype.tick = function (dt, data) {
    if (!this._root) return;
    if (!dt || dt < 0) dt = 1;
    dt = Math.min(dt, 4);

    var t0 = (global.performance && global.performance.now) ? global.performance.now() : 0;

    this._time += dt / 60;
    var m = Math.min(1, dt * 0.22);
    this._bass += (band(data, 0, 10) - this._bass) * m;
    this._mid += (band(data, 11, 32) - this._mid) * m;
    this._hi += (band(data, 33, 80) - this._hi) * m;
    this._power = this._bass * 0.5 + this._mid * 0.3 + this._hi * 0.2;
    this._spinBoost *= Math.pow(0.95, dt);

    var g = this.g, gl = this.glow;
    g.clear();
    gl.clear();

    if (this.mode === 'none') return;

    // 曼陀罗整体缓慢旋转，低频加速
    this._rot += (0.14 + this._bass * 0.9) * (dt / 60);

    switch (this.mode) {
      case 'core': this._drawCore(data, dt); break;
      case 'mandala': this._drawMandala(dt); break;
      case 'orbit': this._drawOrbit(dt); break;
      case 'poly': this._drawPoly(dt); break;
    }

    if (t0) {
      var cost = global.performance.now() - t0;
      this.costMs = this.costMs ? this.costMs * 0.9 + cost * 0.1 : cost;
    }
  };

  /* ---------------- 流体核心 ---------------- */

  CoreLayer.prototype._drawCore = function (data, dt) {
    var p = this.params.core;
    var g = this.g, gl = this.glow, pal = this.palette;
    var cx = this.w / 2, cy = this.h / 2;
    var base = Math.min(this.w, this.h);
    var t = this._time;

    var r = base * p.size * (1 + this._bass * p.breath * 1.5 + Math.sin(t * 1.6) * 0.02);
    var glowMul = 0.4 + p.glow * 0.9;

    // 流体团块（多个错相圆叠成 meta-ball 观感）
    var blobs = 5;
    for (var i = 0; i < blobs; i++) {
      var ang = t * 0.7 + (i / blobs) * Math.PI * 2;
      var dist = r * 0.42 * (0.6 + 0.4 * Math.sin(t * 1.4 + i * 1.7));
      var bx = cx + Math.cos(ang) * dist;
      var by = cy + Math.sin(ang) * dist * 0.88;
      var br = r * (0.6 + 0.14 * Math.sin(t * 1.9 + i));
      gl.beginFill(pal[i % 3], (0.075 + this._bass * 0.055) * glowMul);
      gl.drawCircle(bx, by, br);
      gl.endFill();
    }

    // 核心分层
    for (var k = 3; k >= 1; k--) {
      gl.beginFill(pal[0], (0.05 * k + this._power * 0.05) * glowMul);
      gl.drawCircle(cx, cy, r * (0.3 + k * 0.17));
      gl.endFill();
    }

    // 中心亮点
    gl.beginFill(pal[1] || pal[0], 0.14 + this._bass * 0.22);
    gl.drawCircle(cx, cy, r * 0.24 * (1 + this._bass * 0.35));
    gl.endFill();

    // 外圈波形环：低频→高频沿半环铺开，左右镜像成对称声浪
    var points = 72;
    var half = points / 2;
    var vals = new Array(points);
    for (var vi = 0; vi < half; vi++) {
      if (data) {
        var di = Math.floor(vi * (data.length - 1) / (half - 1));
        vals[vi] = Math.sqrt(data[di] / 255); // 感知提亮，弱信号也可见
      } else {
        vals[vi] = 0.35 + 0.3 * Math.sin(t * 2 + vi * 0.3);
      }
    }
    for (var mi = half; mi < points; mi++) vals[mi] = vals[points - 1 - mi];

    g.lineStyle(2, pal[1] || pal[0], 0.62);
    for (var j = 0; j <= points; j++) {
      var idx = j % points;
      var sv = (vals[(idx + points - 1) % points] + vals[idx] * 2 + vals[(idx + 1) % points]) / 4;
      var a = (idx / points) * Math.PI * 2 - Math.PI / 2 + this._rot * 0.25;
      var rr = r * 1.16 + sv * base * p.size * 1.15 + this._bass * base * p.size * 0.22;
      var x = cx + Math.cos(a) * rr;
      var y = cy + Math.sin(a) * rr;
      if (j === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.lineStyle(0);

    // 细内环 + 环上的光点
    g.lineStyle(1, pal[0], 0.22);
    g.drawCircle(cx, cy, r * 1.1);
    g.lineStyle(0);
    var dots = 8;
    for (var d = 0; d < dots; d++) {
      var da = t * 0.55 + (d / dots) * Math.PI * 2;
      var dx = cx + Math.cos(da) * r * 1.1;
      var dy = cy + Math.sin(da) * r * 1.1;
      gl.beginFill(pal[d % pal.length], 0.75);
      gl.drawCircle(dx, dy, 1.8 + this._bass * 1.6);
      gl.endFill();
    }

    // 点击涟漪
    for (var i2 = this._rings.length - 1; i2 >= 0; i2--) {
      var ring = this._rings[i2];
      ring.age += dt / 60;
      var q = ring.age / ring.life;
      if (q >= 1) { this._rings.splice(i2, 1); continue; }
      g.lineStyle(2.4 * (1 - q) + 0.4, pal[0], (1 - q) * 0.5);
      g.drawCircle(cx, cy, r * (1.02 + q * 2.4));
      g.lineStyle(0);
    }
  };

  /* ---------------- 曼陀罗 ---------------- */

  CoreLayer.prototype._drawMandala = function (dt) {
    var p = this.params.mandala;
    var g = this.g, gl = this.glow, pal = this.palette;
    var cx = this.w / 2, cy = this.h / 2;
    var base = Math.min(this.w, this.h);
    var mirror = Math.max(4, Math.round(p.mirror));

    // 寿命推进（每笔按创建时的 fade 独立衰减）
    for (var i = this._strokes.length - 1; i >= 0; i--) {
      var st = this._strokes[i];
      st.age += dt / 60;
      if (st.age >= st.life) this._strokes.splice(i, 1);
    }

    // 笔触总量上限：镜像越多，同时段显示的笔数越少
    var maxStrokes = Math.max(6, Math.floor(640 / mirror));
    var start = Math.max(0, this._strokes.length - maxStrokes);
    var baseAlpha = 0.3 + this._bass * 0.35;

    for (var n = start; n < this._strokes.length; n++) {
      var s = this._strokes[n];
      var k = 1 - s.age / s.life;
      if (k <= 0) continue;
      var alpha = Math.pow(k, 1.15) * (0.35 + s.strength * 0.45);
      var ang = Math.atan2(s.y, s.x) + Math.PI / 2;
      var len = s.len;
      var bend = s.bend;

      for (var mir = 0; mir < mirror; mir++) {
        var rot = this._rot + (mir / mirror) * Math.PI * 2;
        var cs = Math.cos(rot), sn = Math.sin(rot);
        var x0 = s.x * cs - s.y * sn;
        var y0 = s.x * sn + s.y * cs;
        var ta = ang + rot;
        var ex = x0 + Math.cos(ta) * len;
        var ey = y0 + Math.sin(ta) * len;
        var mx = (x0 + ex) / 2 - Math.sin(ta) * bend * len;
        var my = (y0 + ey) / 2 + Math.cos(ta) * bend * len;

        g.lineStyle(1.6, s.color, Math.min(0.9, alpha));
        g.moveTo(cx + x0, cy + y0);
        g.quadraticCurveTo(cx + mx, cy + my, cx + ex, cy + ey);
        g.lineStyle(0);

        gl.beginFill(s.color, Math.min(0.9, alpha * 0.9));
        gl.drawCircle(cx + ex, cy + ey, 1.5 + this._bass * 1.2);
        gl.endFill();
      }
    }

    // 中心核心随低频呼吸
    var coreR = base * 0.032 * (1 + this._bass * 0.55);
    gl.beginFill(pal[0], 0.2 + baseAlpha * 0.3);
    gl.drawCircle(cx, cy, coreR);
    gl.endFill();
    g.lineStyle(1, pal[0], 0.28);
    g.drawCircle(cx, cy, coreR * 1.9);
    g.lineStyle(0);
  };

  /* ---------------- 粒子星环 ---------------- */

  CoreLayer.prototype._drawOrbit = function (dt) {
    var p = this.params.orbit;
    var g = this.g, gl = this.glow, pal = this.palette;
    var cx = this.w / 2, cy = this.h / 2;
    var base = Math.min(this.w, this.h);
    var count = Math.max(10, Math.round(p.count));

    if (this._orbits.length !== count) {
      this._orbits = [];
      for (var i = 0; i < count; i++) {
        this._orbits.push({
          a: Math.random() * Math.PI * 2,
          r: 0.66 + Math.random() * 0.62,
          sp: 0.65 + Math.random() * 0.8,
          sz: 0.8 + Math.random() * 1.4,
          color: pal[i % pal.length]
        });
      }
    }

    var R = base * p.radius;
    var boost = 1 + this._spinBoost * 0.9;
    var ringR = R;

    // 轨道导引线
    g.lineStyle(1, pal[0], 0.1);
    g.drawCircle(cx, cy, ringR);
    g.lineStyle(1, pal[1] || pal[0], 0.07);
    g.drawCircle(cx, cy, ringR * 0.62);
    g.lineStyle(0);

    for (var j = 0; j < this._orbits.length; j++) {
      var o = this._orbits[j];
      o.a += (0.42 * p.spin * o.sp * boost + this._bass * 0.7) * (dt / 60);
      var rr = R * (o.r + this._hi * 0.16 + this._bass * 0.1);
      var x = cx + Math.cos(o.a) * rr;
      var y = cy + Math.sin(o.a) * rr;
      var pa = o.a - 0.22 * (0.5 + boost);
      var px = cx + Math.cos(pa) * rr;
      var py = cy + Math.sin(pa) * rr;

      // 彗尾
      g.lineStyle(1, o.color, 0.28);
      g.moveTo(px, py);
      g.lineTo(x, y);
      g.lineStyle(0);

      gl.beginFill(o.color, 0.85);
      gl.drawCircle(x, y, o.sz * (1 + this._bass * 0.55));
      gl.endFill();
    }

    // 点击弹出：由核心飞向轨道并被捕获
    for (var k = this._taps.length - 1; k >= 0; k--) {
      var b = this._taps[k];
      b.age += dt / 60;
      var q = b.age / b.life;
      if (q >= 1) { this._taps.splice(k, 1); continue; }
      var br = R * (0.1 + 0.9 * Math.pow(q, 0.55)) * (0.7 + b.r * 0.6);
      var ba = b.a + q * 0.9;
      var bx = cx + Math.cos(ba) * br;
      var by = cy + Math.sin(ba) * br;
      var alpha = (1 - q) * 0.9;
      gl.beginFill(b.color, alpha);
      gl.drawCircle(bx, by, 2.4 * (1 - q * 0.5));
      gl.endFill();
      g.lineStyle(1.2, b.color, alpha * 0.5);
      g.moveTo(cx, cy);
      g.lineTo(bx, by);
      g.lineStyle(0);
    }

    // 中心核：三层叠加出柔和光球
    var coreR = base * 0.03 * (1 + this._bass * 0.7);
    gl.beginFill(pal[0], 0.05 + this._bass * 0.07);
    gl.drawCircle(cx, cy, coreR * 2.7);
    gl.endFill();
    gl.beginFill(pal[0], 0.1 + this._bass * 0.14);
    gl.drawCircle(cx, cy, coreR * 1.5);
    gl.endFill();
    gl.beginFill(0xffffff, 0.16 + this._bass * 0.2);
    gl.drawCircle(cx, cy, coreR * 0.5);
    gl.endFill();
  };

  /* ---------------- 音频多面体 ---------------- */

  CoreLayer.prototype._drawPoly = function (dt) {
    var p = this.params.poly;
    var g = this.g, gl = this.glow, pal = this.palette;
    var cx = this.w / 2, cy = this.h / 2;
    var base = Math.min(this.w, this.h);

    var n = Math.round(clamp(p.faces, 4, 12));
    if (!this._poly || this._polyKey !== n) {
      this._poly = buildPoly(n);
      this._polyKey = n;
    }
    var verts = this._poly.verts, edges = this._poly.edges;

    this._polyA += 0.36 * p.spin * (dt / 60);
    this._polyB += 0.19 * p.spin * (dt / 60);

    var scale = base * 0.24 * (1 + this._power * p.react * 0.45);
    this._tapJitter *= Math.pow(0.92, dt);
    var jitter = this._hi * p.react * 4.5 + this._tapJitter * 7;

    var ry = this._polyA, rx = this._polyB;
    var cy1 = Math.cos(ry), sy1 = Math.sin(ry);
    var cx1 = Math.cos(rx), sx1 = Math.sin(rx);

    var pts = [];
    for (var i = 0; i < verts.length; i++) {
      var v = verts[i];
      var x1 = v[0] * cy1 + v[2] * sy1;
      var z1 = -v[0] * sy1 + v[2] * cy1;
      var y2 = v[1] * cx1 - z1 * sx1;
      var z2 = v[1] * sx1 + z1 * cx1;
      var sc = 3.2 / (3.2 - z2 * 0.85);
      pts.push([
        cx + x1 * sc * scale + (Math.random() - 0.5) * jitter,
        cy + y2 * sc * scale + (Math.random() - 0.5) * jitter,
        z2,
        sc
      ]);
    }

    // 背后辉光
    gl.beginFill(pal[0], 0.05 + this._power * 0.08);
    gl.drawCircle(cx, cy, scale * 0.95);
    gl.endFill();

    // 线框
    for (var e = 0; e < edges.length; e++) {
      var a = pts[edges[e][0]], b = pts[edges[e][1]];
      var depth = ((a[2] + b[2]) / 2 + 1) / 2;
      var alpha = 0.16 + depth * 0.58 + this._bass * 0.12;
      var color = pal[e % pal.length];
      g.lineStyle(1 + depth * 0.9, color, Math.min(0.92, alpha));
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.lineStyle(0);
    }

    // 顶点光点
    for (var j = 0; j < pts.length; j++) {
      var pt = pts[j];
      var da = (pt[2] + 1) / 2;
      gl.beginFill(pal[j % pal.length], 0.2 + da * 0.65);
      gl.drawCircle(pt[0], pt[1], 1.4 + da * 1.8);
      gl.endFill();
    }
  };

  /* ============================================================
   * 静态元数据
   * ============================================================ */

  CoreLayer.modes = function () {
    return MODE_ORDER.map(function (id) {
      return { id: id, name: MODE_META[id].name };
    });
  };

  CoreLayer.paramSchema = function (modeId) {
    var meta = MODE_META[modeId];
    if (!meta) return [];
    return meta.params;
  };

  CoreLayer.defaultMode = 'core';

  global.CoreLayer = CoreLayer;
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * coreLayer.js — 星海共振 · 中心特效层
 * ====================================================================
 * 5 种中心视觉，均绘制在网格/粒子之上、歌词之下，不拦截输入：
 *
 *   core     流体核心   呼吸流体球 + 心电双轮廓环（内外对称呼吸、偏差封顶）+
 *                       节拍声呐环（kick 检测触发）+ 点击涟漪
 *   crown    频谱花冠   64×2 镜像频谱条围成花冠（低频在下/高频在上），
 *                       attack 0.6 / release 0.12 包络，击键在对应方位顶出亮条
 *                       并轮转一档配色（每次点击换色）
 *   blob     液态呼吸   单条闭合光滑轮廓随频段隆起 + 噪声微扰，抒情曲风的柔和档
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

  // 不对称包络：快起（attack）慢落（release），让「跳起来」干脆、「落回去」有余韵
  function chase(cur, target, dt, atk, rel) {
    var c = target > cur ? atk : rel;
    return cur + (target - cur) * Math.min(1, c * dt);
  }

  /* ============================================================
   * 模式元数据（设置面板 / 播放器面板据此渲染）
   * ============================================================ */

  var MODE_META = {
    core: {
      name: '流体核心',
      params: [
        { key: 'size', label: '核心尺寸', min: 0.06, max: 0.26, step: 0.005, def: 0.13 },
        { key: 'breath', label: '跳动幅度', min: 0, max: 0.8, step: 0.02, def: 0.45 },
        { key: 'glow', label: '辉光强度', min: 0, max: 1, step: 0.05, def: 0.55 },
        { key: 'wave', label: '心电幅度', min: 0, max: 1.5, step: 0.05, def: 1.1 },
        { key: 'sonar', label: '声呐强度', min: 0, max: 1, step: 0.05, def: 0.8 }
      ]
    },
    crown: {
      name: '频谱花冠',
      params: [
        { key: 'inner', label: '内半径', min: 0.06, max: 0.2, step: 0.005, def: 0.11 },
        { key: 'depth', label: '花冠幅度', min: 0.04, max: 0.25, step: 0.005, def: 0.16 },
        { key: 'glow', label: '辉光强度', min: 0, max: 1, step: 0.05, def: 0.5 }
      ]
    },
    blob: {
      name: '液态呼吸',
      params: [
        { key: 'size', label: '基础半径', min: 0.08, max: 0.26, step: 0.005, def: 0.15 },
        { key: 'depth', label: '反应深度', min: 0, max: 1, step: 0.02, def: 0.62 },
        { key: 'flow', label: '有机流动', min: 0, max: 1, step: 0.05, def: 0.4 }
      ]
    },
    poly: {
      name: '音频多面体',
      params: [
        { key: 'faces', label: '面数', min: 4, max: 12, step: 1, def: 6 },
        { key: 'spin', label: '旋转速度', min: 0, max: 2, step: 0.05, def: 0.6 },
        { key: 'react', label: '音频响应', min: 0, max: 2, step: 0.05, def: 1.25 }
      ]
    },
    none: {
      name: '关闭',
      params: []
    }
  };

  var MODE_ORDER = ['core', 'crown', 'blob', 'poly', 'none'];

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

    this._rings = [];     // 涟漪队列：{ age, life, kind: 'tap' | 'beat' }

    // 节拍检测（声呐环触发）
    this._beatAvg = 0.12;   // 低频能量滑动均值
    this._beatLast = -1;    // 上次触发时刻（秒）
    this.beatFlash = 0;     // 最近一次节拍后的余辉（供其他层读取）

    // 频谱花冠 / 液态呼吸的分带包络（惰性分配）
    this._crownEnv = null;  // Float32Array(64)：attack 0.6 / release 0.12
    this._crownBoost = null;// Float32Array(64)：击键顶出的临时增量
    this._crownShift = 0;   // 调色板轮转偏移：每次击键 +1，花冠换色
    this._blobEnv = null;   // Float32Array(32)：慢包络（柔和起落）

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

  /** 视差偏移：中心特效接近锚定，只做极小位移制造纵深 */
  CoreLayer.prototype.setOffset = function (x, y) {
    if (!this._root) return;
    this._root.position.set(x || 0, y || 0);
  };

  CoreLayer.prototype.setMode = function (modeId) {
    if (!MODE_META[modeId]) modeId = 'core';
    this.mode = modeId;
    this._rings = [];

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
  };

  /** 点击/拖拽/键盘打拍：各模式留下痕迹 */
  CoreLayer.prototype.onTap = function (x, y, strength) {
    if (this.mode === 'none' || !this._root) return;
    var s = strength == null ? 1 : strength;

    if (this.mode === 'core' || this.mode === 'blob') {
      this._rings.push({ age: 0, life: 1.1, kind: 'tap' });
      if (this._rings.length > 10) this._rings.shift();
      return;
    }

    if (this.mode === 'crown') {
      // 击键 → 对应方位的频段条顶出亮条（花冠与演奏的直接耦合）
      if (!this._crownBoost) return;
      this._crownShift = (this._crownShift + 1) % Math.max(1, this.palette.length); // 每次击键换一档配色
      var cx = this.w / 2, cy = this.h / 2;
      var a = Math.atan2(y - cy, x - cx);            // -PI..PI
      var u = (Math.PI / 2 - a);                     // 自正下方起顺时针的角度
      u = ((u % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      if (u > Math.PI) u = Math.PI * 2 - u;          // 左右镜像
      var k = clamp(Math.round(u / Math.PI * 63), 0, 63);
      var N = this._crownBoost.length;
      this._crownBoost[k] = Math.max(this._crownBoost[k], 0.95 * s);
      if (k > 0) this._crownBoost[k - 1] = Math.max(this._crownBoost[k - 1], 0.4 * s);
      if (k < N - 1) this._crownBoost[k + 1] = Math.max(this._crownBoost[k + 1], 0.4 * s);
      return;
    }

    if (this.mode === 'poly') {
      this._tapJitter = Math.min(1.6, this._tapJitter + 0.7 * s);
    }
  };

  /** 换歌/重置：清空累积痕迹 */
  CoreLayer.prototype.clear = function () {
    this._rings = [];
    this._tapJitter = 0;
    if (this._crownBoost) this._crownBoost.fill(0);
    if (this._crownEnv) this._crownEnv.fill(0);
    if (this._blobEnv) this._blobEnv.fill(0);
    this._beatAvg = 0.12;
    this._beatLast = -1;
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
    // 快起（0.65）/ 慢落（0.16）：鼓点一进来当帧弹起，回落保留余韵——「跳动感」的关键
    this._bass = chase(this._bass, band(data, 0, 10), dt, 0.65, 0.16);
    this._mid = chase(this._mid, band(data, 11, 32), dt, 0.6, 0.15);
    this._hi = chase(this._hi, band(data, 33, 80), dt, 0.55, 0.14);
    this._power = this._bass * 0.5 + this._mid * 0.3 + this._hi * 0.2;

    // ---- 节拍检测（通用做法：瞬时低频能量 > 滑动均值×阈值，带不应期）----
    this.beatFlash *= Math.pow(0.86, dt);
    var bassNow = band(data, 0, 6);
    this._beatAvg += (bassNow - this._beatAvg) * Math.min(1, dt * 0.06);
    var sinceBeat = this._time - this._beatLast;
    if (data && data.some(function (v) { return v > 8; }) &&
        bassNow > 0.22 && bassNow > this._beatAvg * 1.38 + 0.06 && sinceBeat > 0.22) {
      this._beatLast = this._time;
      this.beatFlash = 1;
      if (this.mode === 'core' && this.params.core.sonar > 0.02) {
        this._rings.push({ age: 0, life: 1.6, kind: 'beat' });
        if (this._rings.length > 12) this._rings.shift();
      }
    }

    var g = this.g, gl = this.glow;
    g.clear();
    gl.clear();

    if (this.mode === 'none') return;

    // 波形环整体缓慢旋转，低频加速
    this._rot += (0.14 + this._bass * 0.9) * (dt / 60);

    switch (this.mode) {
      case 'core': this._drawCore(data, dt); break;
      case 'crown': this._drawCrown(data, dt); break;
      case 'blob': this._drawBlob(data, dt); break;
      case 'poly': this._drawPoly(dt); break;
    }

    if (t0) {
      var cost = global.performance.now() - t0;
      this.costMs = this.costMs ? this.costMs * 0.9 + cost * 0.1 : cost;
    }
  };

  /* ---------------- 流体核心：心电双轮廓 + 节拍声呐 ---------------- */

  CoreLayer.prototype._drawCore = function (data, dt) {
    var p = this.params.core;
    var g = this.g, gl = this.glow, pal = this.palette;
    var cx = this.w / 2, cy = this.h / 2;
    var base = Math.min(this.w, this.h);
    var t = this._time;

    var punch = this.beatFlash;   // 节拍冲击量（0..1，触发后快速衰减）
    var r = base * p.size * (1 + this._bass * p.breath * 1.9 + punch * p.breath * 0.55
      + Math.sin(t * 1.6) * 0.02);
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

    // 中心亮点（节拍瞬间提亮）
    gl.beginFill(pal[1] || pal[0], 0.14 + this._bass * 0.22 + punch * 0.14);
    gl.drawCircle(cx, cy, r * 0.24 * (1 + this._bass * 0.42 + punch * 0.16));
    gl.endFill();

    // ---- 心电双轮廓环：scope 波形绕圆一周，内外对称呼吸、偏差封顶永不交叉 ----
    // 基圆放在核心辉光之外；内轮廓最低点也压不进核心，两条轮廓动态互斥。
    var points = 128;
    var half = points / 2;
    var vals = new Array(points);
    for (var vi = 0; vi < half; vi++) {
      if (data) {
        var di = Math.floor(Math.pow(vi / (half - 1), 1.35) * (data.length - 1)); // 低频区取样更密
        vals[vi] = Math.sqrt(data[di] / 255); // 感知提亮，弱信号也可见
      } else {
        vals[vi] = 0.3 + 0.25 * Math.sin(t * 1.8 + vi * 0.4);
      }
    }
    for (var mi = half; mi < points; mi++) vals[mi] = vals[points - 1 - mi];

    var R0 = r * 1.34 + this._bass * base * p.size * 0.16 + punch * base * p.size * 0.1;  // 基圆
    var devMax = r * 0.6 * (1 + punch * 0.35);              // 偏差上限（封顶防穿越，节拍瞬间放宽）
    var rot = this._rot * 0.25;

    // 外轮廓（正向偏移）
    g.lineStyle(2, pal[1] || pal[0], 0.62);
    for (var jo = 0; jo <= points; jo++) {
      var io = jo % points;
      var so = (vals[(io + points - 1) % points] + vals[io] * 2 + vals[(io + 1) % points]) / 4;
      var ao = (io / points) * Math.PI * 2 - Math.PI / 2 + rot;
      var ro = R0 + Math.pow(so, 1.2) * devMax * p.wave;
      var xo = cx + Math.cos(ao) * ro, yo = cy + Math.sin(ao) * ro;
      jo ? g.lineTo(xo, yo) : g.moveTo(xo, yo);
    }
    g.lineStyle(0);

    // 内轮廓（反向偏移，与外轮廓镜像呼吸）
    g.lineStyle(1.2, pal[0], 0.35);
    for (var ji = 0; ji <= points; ji++) {
      var ii = ji % points;
      var si = (vals[(ii + points - 1) % points] + vals[ii] * 2 + vals[(ii + 1) % points]) / 4;
      var ai = (ii / points) * Math.PI * 2 - Math.PI / 2 + rot;
      var ri = R0 - Math.pow(si, 1.2) * devMax * p.wave;
      var xi = cx + Math.cos(ai) * ri, yi = cy + Math.sin(ai) * ri;
      ji ? g.lineTo(xi, yi) : g.moveTo(xi, yi);
    }
    g.lineStyle(0);

    // 细导引环 + 环上的光点
    g.lineStyle(1, pal[0], 0.22);
    g.drawCircle(cx, cy, r * 1.1);
    g.lineStyle(0);
    var dots = 8;
    for (var d = 0; d < dots; d++) {
      var da = t * 0.55 + (d / dots) * Math.PI * 2;
      var dx = cx + Math.cos(da) * r * 1.1;
      var dy = cy + Math.sin(da) * r * 1.1;
      gl.beginFill(pal[d % pal.length], 0.75);
      gl.drawCircle(dx, dy, 1.8 + this._bass * 2.6 + punch * 1.4);
      gl.endFill();
    }

    // ---- 涟漪队列：节拍声呐环（主题色）+ 点击涟漪（强调色）----
    for (var i2 = this._rings.length - 1; i2 >= 0; i2--) {
      var ring = this._rings[i2];
      ring.age += dt / 60;
      var q = ring.age / ring.life;
      if (q >= 1) { this._rings.splice(i2, 1); continue; }
      if (ring.kind === 'beat') {
        g.lineStyle(1.8 * (1 - q) + 0.4, pal[0], (1 - q) * 0.45 * p.sonar);
        g.drawCircle(cx, cy, r * (1.02 + q * 3.2));
      } else {
        g.lineStyle(2.4 * (1 - q) + 0.4, pal[1] || pal[0], (1 - q) * 0.5);
        g.drawCircle(cx, cy, r * (1.02 + q * 2.4));
      }
      g.lineStyle(0);
    }
  };

  /* ---------------- 频谱花冠：64×2 镜像频谱条 ---------------- */

  CoreLayer.prototype._drawCrown = function (data, dt) {
    var p = this.params.crown;
    var g = this.g, gl = this.glow, pal = this.palette;
    var cx = this.w / 2, cy = this.h / 2;
    var base = Math.min(this.w, this.h);
    var t = this._time;
    var N = 64;

    if (!this._crownEnv) {
      this._crownEnv = new Float32Array(N);
      this._crownBoost = new Float32Array(N);
    }

    // 对数分带取样（约 40Hz–8kHz 映射到 64 带）+ attack 0.6 / release 0.12 包络
    var hiBin = data ? Math.min(data.length - 1, 96) : 0;
    for (var k = 0; k < N; k++) {
      var v;
      if (data) {
        var f0 = 2 * Math.pow(hiBin / 2, k / N);
        var f1 = 2 * Math.pow(hiBin / 2, (k + 1) / N);
        v = Math.sqrt(band(data, Math.floor(f0), Math.max(Math.floor(f0), Math.ceil(f1) - 1)));
      } else {
        v = 0.3 + 0.25 * Math.sin(t * 2 + k * 0.35);
      }
      this._crownBoost[k] *= Math.pow(0.88, dt);
      var target = Math.min(1.35, v + this._crownBoost[k]);
      var env = this._crownEnv[k];
      var coef = target > env ? 0.6 : 0.12;                 // 快起慢落
      this._crownEnv[k] = env + (target - env) * Math.min(1, coef * dt);
    }

    var r0 = base * p.inner;
    var D = base * p.depth;
    var glowMul = 0.4 + p.glow * 0.9;
    var punch = this.beatFlash;
    var shift = this._crownShift % pal.length;               // 击键轮转的配色档位

    // 角度映射：k=0 在正下方（低频），k=N-1 在正上方（高频），左右镜像
    var angleOf = function (k) { return Math.PI / 2 - (k / (N - 1)) * Math.PI; };

    // 中心呼吸核 + 内导引环
    var coreR = r0 * 0.22 * (1 + this._bass * 1.1 + punch * 0.3);
    gl.beginFill(pal[shift], (0.16 + this._bass * 0.18 + punch * 0.08) * glowMul);
    gl.drawCircle(cx, cy, coreR * 2.2);
    gl.endFill();
    gl.beginFill(0xffffff, 0.14 + this._bass * 0.22 + punch * 0.1);
    gl.drawCircle(cx, cy, coreR * 0.7);
    gl.endFill();
    g.lineStyle(1, pal[shift], 0.14);
    g.drawCircle(cx, cy, r0);
    g.lineStyle(0);

    // 频谱条（右半 + 左半镜像）与端点光
    var tips = new Array(N * 2);
    for (var s = 0; s < 2; s++) {
      for (var k2 = 0; k2 < N; k2++) {
        var e = this._crownEnv[k2];
        var a = angleOf(k2);
        if (s === 1) a = Math.PI - a;                        // 左右镜像
        var len = r0 * 0.16 + Math.pow(Math.min(1.2, e), 1.25) * D * (1 + punch * 0.3);
        var ca = Math.cos(a), sa = Math.sin(a);
        var x0 = cx + ca * r0, y0 = cy + sa * r0;
        var x1 = cx + ca * (r0 + len), y1 = cy + sa * (r0 + len);
        g.lineStyle(1.6, pal[(((k2 * pal.length / N) | 0) + shift) % pal.length],
          0.22 + Math.min(0.68, e * 0.7));
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        g.lineStyle(0);
        if (e > 0.45) {
          gl.beginFill(pal[(((k2 * pal.length / N) | 0) + shift) % pal.length],
            Math.min(0.8, (e - 0.35)) * glowMul);
          gl.drawCircle(x1, y1, 1.2 + e * 2.6 + punch * 1.2);
          gl.endFill();
        }
        tips[s === 0 ? k2 : N * 2 - 1 - k2] = [x1, y1];
      }
    }

    // 冠形轮廓：把全部条端连成一条闭合平滑曲线
    g.lineStyle(1, pal[shift], 0.4);
    var M = tips.length;
    g.moveTo((tips[0][0] + tips[M - 1][0]) / 2, (tips[0][1] + tips[M - 1][1]) / 2);
    for (var i3 = 0; i3 < M; i3++) {
      var cur = tips[i3], nxt = tips[(i3 + 1) % M];
      g.quadraticCurveTo(cur[0], cur[1], (cur[0] + nxt[0]) / 2, (cur[1] + nxt[1]) / 2);
    }
    g.lineStyle(0);
  };

  /* ---------------- 液态呼吸：闭合轮廓随频段隆起 ---------------- */

  CoreLayer.prototype._drawBlob = function (data, dt) {
    var p = this.params.blob;
    var g = this.g, gl = this.glow, pal = this.palette;
    var cx = this.w / 2, cy = this.h / 2;
    var base = Math.min(this.w, this.h);
    var t = this._time;
    var N = 32;

    if (!this._blobEnv) this._blobEnv = new Float32Array(N);

    // 慢包络（比花冠更柔和的起落）
    var hiBin = data ? Math.min(data.length - 1, 96) : 0;
    for (var k = 0; k < N; k++) {
      var v;
      if (data) {
        var f0 = 2 * Math.pow(hiBin / 2, k / N);
        var f1 = 2 * Math.pow(hiBin / 2, (k + 1) / N);
        v = Math.sqrt(band(data, Math.floor(f0), Math.max(Math.floor(f0), Math.ceil(f1) - 1)));
      } else {
        v = 0.22 + 0.16 * Math.sin(t * 1.1 + k * 0.5);
      }
      this._blobEnv[k] += (v - this._blobEnv[k]) * Math.min(1, 0.16 * dt);
    }

    var punch = this.beatFlash;
    var R = base * p.size * (1 + this._bass * 0.5 + punch * 0.16);
    var angleOf = function (k) { return Math.PI / 2 - (k / (N - 1)) * Math.PI; };

    // 轮廓半径 = 基础 × (1 + 频段隆起 + 有机噪声微扰)，左右镜像保持对称
    var radiusAt = function (k) {
      var e = Math.min(1.2, this._blobEnv[k]);
      var a = angleOf(k);
      var wob = Math.sin(3 * a + t * 0.9) * 0.5 + Math.sin(5 * a - t * 0.7) * 0.3
        + Math.sin(8 * a + t * 1.3) * 0.2;
      return R * (1 + e * p.depth * 0.85 * (1 + punch * 0.2) + wob * p.flow * 0.055);
    }.bind(this);

    // 整圈轮廓点：右半自上而下 + 左半镜像自下而上
    var pts = [];
    for (var kr = N - 1; kr >= 0; kr--) {
      var ar = angleOf(kr);
      pts.push([cx + Math.cos(ar) * radiusAt(kr), cy + Math.sin(ar) * radiusAt(kr)]);
    }
    for (var kl = 1; kl < N; kl++) {
      var al = Math.PI - angleOf(kl);
      pts.push([cx + Math.cos(al) * radiusAt(kl), cy + Math.sin(al) * radiusAt(kl)]);
    }

    // 中心柔光
    gl.beginFill(pal[0], 0.06 + this._bass * 0.07);
    gl.drawCircle(cx, cy, R * 0.72);
    gl.endFill();
    gl.beginFill(0xffffff, 0.1 + this._bass * 0.14);
    gl.drawCircle(cx, cy, R * 0.3);
    gl.endFill();

    // 主轮廓：半透明填充 + 描边，二次贝塞尔过中点平滑闭合
    var M = pts.length;
    g.beginFill(pal[0], 0.08 + this._bass * 0.06);
    g.lineStyle(2, pal[0], 0.55);
    g.moveTo((pts[0][0] + pts[M - 1][0]) / 2, (pts[0][1] + pts[M - 1][1]) / 2);
    for (var i4 = 0; i4 < M; i4++) {
      var cur = pts[i4], nxt = pts[(i4 + 1) % M];
      g.quadraticCurveTo(cur[0], cur[1], (cur[0] + nxt[0]) / 2, (cur[1] + nxt[1]) / 2);
    }
    g.closePath();
    g.endFill();
    g.lineStyle(0);

    // 内层副轮廓（rings 子型观感：给呼吸一个纵深）
    g.lineStyle(1, pal[1] || pal[0], 0.25);
    g.moveTo((pts[0][0] - cx) * 0.78 + cx, (pts[0][1] - cy) * 0.78 + cy);
    for (var i5 = 0; i5 < M; i5++) {
      var c5 = pts[i5], n5 = pts[(i5 + 1) % M];
      var c5x = (c5[0] - cx) * 0.78 + cx, c5y = (c5[1] - cy) * 0.78 + cy;
      var n5x = (n5[0] - cx) * 0.78 + cx, n5y = (n5[1] - cy) * 0.78 + cy;
      g.quadraticCurveTo(c5x, c5y, (c5x + n5x) / 2, (c5y + n5y) / 2);
    }
    g.closePath();
    g.lineStyle(0);

    // 点击涟漪（在轮廓内部扩散）
    var r = base * p.size;
    for (var i6 = this._rings.length - 1; i6 >= 0; i6--) {
      var ring = this._rings[i6];
      ring.age += dt / 60;
      var q = ring.age / ring.life;
      if (q >= 1) { this._rings.splice(i6, 1); continue; }
      g.lineStyle(2.2 * (1 - q) + 0.4, pal[1] || pal[0], (1 - q) * 0.45);
      g.drawCircle(cx, cy, r * (0.3 + q * 1.6));
      g.lineStyle(0);
    }
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

    var scale = base * 0.24 * (1 + this._power * p.react * 0.85 + this.beatFlash * p.react * 0.3);
    this._tapJitter *= Math.pow(0.92, dt);
    var jitter = this._hi * p.react * 5.5 + this._tapJitter * 7;

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

/**
 * stellarResonance.js — 背景模式「星海共振」渲染引擎（8 种共振效果共用）
 * ====================================================================
 * 不再是独立图层：本模块只负责把一帧画面画进一张离屏 canvas，
 * 由 BgLayer 作为 PIXI CanvasTexture 放进背景层渲染树 —— 与壁纸/星云
 * 等其他背景模式同一套生命周期（模式切换 crossfade、销毁、resize 重建）。
 *
 * 视觉与节奏对齐原型 stellar-bg-lab.html 的「背景」部分：
 *   drawBase()  深蓝紫渐变 + 80px 极淡网格 + 190 颗 hsla 彩色闪烁星点
 *   MODES[]     8 种创意效果，统一 init / hit / draw 接口
 *   pulse       hit 时 +0.85（上限 2.2）、每帧 ×0.935 衰减
 *   trail       独立离屏画布 + destination-out 淡出做磷光余晖
 *   ripple      128×80 ImageData 逐像素干涉场放大插值铺满全屏
 *
 * 刻意不画原型里的「星核 + 洋红共振环」签名层：
 * 中心点归 CoreLayer 所有（心跳线 / 频谱波形 / 点击涟漪都由音乐节奏驱动），
 * 星海只提供远景场，避免两套中心视觉叠在一起。对几何锚定在中心的变体
 * （吸积盘 / 李萨如 / 等高线）额外做径向让位遮罩，把中心区留给核心。
 *
 * 绘制顺序：base → effect（中心变体先让位再 lighter 合成）。
 * 时钟与原型同源：renderFrame(dt, absT) 直接采用 performance.now()/1000。
 * 本模块不发声：音频由项目既有 AudioEngine / DjFxEngine 负责。
 *
 * 分辨率：画布缓冲 = 视口 CSS 像素（DPR=1）——背景层每帧上传纹理，
 * 高倍缓冲会把上传带宽放大 DPR 平方倍；深色星云场景下 1x 足够细腻。
 * 降级：prefers-reduced-motion → 静态帧（仅在事件/切换时重画一帧）；
 *       性能模式 → 粒子减半、干涉场 96×60。
 */
  (function (global) {
  'use strict';

  var doc = global.document;

  /* ---------- 渲染状态（同一时刻至多一个活跃引擎：bgLayer 保证） ---------- */
  var cv = null, ctx = null, tctx = null, sctx = null;
  var fx = null, fctx = null, gapGrad = null;   // effect 独立缓冲：中心让位遮罩在它上面做
  var trail = null, small = null, sData = null;
  var W = 0, H = 0, SW = 128, SH = 80;
  var stars = [], t = 3.2, pulse = 0, variant = 0;
  var dirty = true, reduced = false, perf = false, mobile = false, live = false;
  var centerZone = true;   // 中心点是否被 CoreLayer 占用（占用时中心变体让位）
  var MODES = [];

  function mulberry(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var x = Math.imul(a ^ a >>> 15, 1 | a);
      x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x;
      return ((x ^ x >>> 14) >>> 0) / 4294967296;
    };
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function clearTrail() { if (tctx) tctx.clearRect(0, 0, W, H); }
  function fadeTrail(a) {
    tctx.globalCompositeOperation = 'destination-out';
    tctx.fillStyle = 'rgba(0,0,0,' + a + ')';
    tctx.fillRect(0, 0, W, H);
    tctx.globalCompositeOperation = 'source-over';
  }
  function overlayTrail(alpha) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha; ctx.drawImage(trail, 0, 0, W, H); ctx.restore();
  }

  function makeCanvases() {
    SW = (mobile || perf) ? 96 : 128;
    SH = (mobile || perf) ? 60 : 80;
    trail = doc.createElement('canvas'); trail.width = W; trail.height = H;
    tctx = trail.getContext('2d');
    fx = doc.createElement('canvas'); fx.width = W; fx.height = H;
    fctx = fx.getContext('2d');
    gapGrad = makeGapGradient();
    small = doc.createElement('canvas'); small.width = SW; small.height = SH;
    sctx = small.getContext('2d'); sData = sctx.createImageData(SW, SH);
  }

  /**
   * 中心让位渐变：半径 < 0.10×min 完全清空，到 0.30×min 恢复全强度。
   * 用于把中心舞台留给 CoreLayer（其核心 + 波形环大致落在 0.17×min 内）。
   */
  function makeGapGradient() {
    if (!fctx) return null;
    var cx = W / 2, cy = H / 2, unit = Math.min(W, H);
    var g = fctx.createRadialGradient(cx, cy, unit * .10, cx, cy, unit * .30);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(.55, 'rgba(0,0,0,.55)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    return g;
  }

  function resize(w, h) {
    W = Math.max(1, w | 0); H = Math.max(1, h | 0);
    if (cv) {
      cv.width = W; cv.height = H; // DPR=1：背景层每帧上传纹理，控制带宽
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    var rnd = mulberry(20261110);
    var palette = [190, 45, 55, 280, 320, 165, 210, 15];
    stars = [];
    for (var i = 0; i < 190; i++) {
      stars.push({
        x: rnd() * W, y: rnd() * H,
        r: 0.6 + rnd() * 1.6,
        h: palette[(rnd() * palette.length) | 0],
        a: 0.25 + rnd() * 0.65,
        sp: 0.6 + rnd() * 2.2,
        ph: rnd() * 6.283
      });
    }
    makeCanvases();
    dirty = true;
    if (MODES[variant] && MODES[variant].init) MODES[variant].init();
  }

  /* ---------- 视觉签名：底色（星核与共振环交由 CoreLayer 负责，此处不再绘制） ---------- */
  function drawBase() {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0a0a28'); g.addColorStop(.55, '#101046'); g.addColorStop(1, '#181052');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(130,150,255,.075)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = 0; x <= W; x += 80) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (var y = 0; y <= H; y += 80) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var a = s.a * (.55 + .45 * Math.sin(t * s.sp + s.ph));
      ctx.fillStyle = 'hsla(' + s.h + ',95%,72%,' + Math.max(.05, a) + ')';
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }
  }

  /** 在 effect 缓冲上做中心让位（destination-in 把中间擦成透明，边缘柔和过渡） */
  function applyCenterGap() {
    if (!gapGrad) gapGrad = makeGapGradient();
    if (!gapGrad) return;
    fctx.save();
    fctx.globalCompositeOperation = 'destination-in';
    fctx.fillStyle = gapGrad;
    fctx.fillRect(0, 0, W, H);
    fctx.restore();
  }

  /* ---------- 8 种背景创意（init / hit / draw 统一接口） ---------- */

  /* 1. 引力吸积盘 */
  MODES.push({
    key: 'gravity', name: '① 引力吸积盘', centerGap: true,
    desc: '星尘被中心捕获、绕行、螺旋坠落成倾斜吸积盘；演奏会把粒子向外炸开一圈再拉回。',
    init: function () {
      var n = mobile ? 600 : 1200;
      this.p = [];
      for (var i = 0; i < n; i++) {
        var r = .14 + Math.random() * .95;
        this.p.push({
          a: r * 7 + (Math.random() < .5 ? 0 : Math.PI) + (Math.random() - .5) * 1.1,
          r: r, sp: .4 + Math.random() * .8, h: Math.random()
        });
      }
    },
    hit: function () {
      for (var i = 0; i < 180; i++) {
        var p = this.p[(Math.random() * this.p.length) | 0];
        p.r = Math.min(1.25, p.r + .1 + Math.random() * .25);
      }
    },
    draw: function () {
      var cx = W / 2, cy = H / 2, S = Math.min(W, H) * .47;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < this.p.length; i++) {
        var p = this.p[i];
        var r0 = p.r * S, a0 = p.a;
        var x = cx + Math.cos(a0) * r0, y = cy + Math.sin(a0) * r0 * .52;
        p.a += (.0045 + p.sp * .008) / Math.max(.22, p.r) * (1 + pulse * .8);
        p.r -= .0015 * p.sp * (1 - pulse * .6);
        if (p.r < .12) {
          p.r = .92 + Math.random() * .18;
          p.a = p.r * 7 + (Math.random() < .5 ? 0 : Math.PI) + (Math.random() - .5) * 1.1;
          continue;
        }
        var r1 = p.r * S;
        var x2 = cx + Math.cos(p.a) * r1, y2 = cy + Math.sin(p.a) * r1 * .52;
        ctx.strokeStyle = 'hsla(' + (185 + p.h * 125) + ',95%,' + (68 + p.h * 10) + '%,.72)';
        ctx.lineWidth = 1.15; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
      }
      ctx.restore();
    }
  });

  /* 2. 声波涟漪干涉 */
  MODES.push({
    key: 'ripple', name: '② 声波涟漪干涉',
    desc: '每个音符从落点扩散一圈波前，多个波前叠加出明暗相间的干涉条纹；看得见波峰相遇。',
    init: function () {
      this.waves = [
        { x: W / 2, y: H / 2, born: t },
        { x: W * .29, y: H * .30, born: t - .28 },
        { x: W * .74, y: H * .71, born: t - .52 }
      ];
    },
    hit: function (x, y) {
      this.waves.push({ x: x, y: y, born: t });
      if (this.waves.length > 5) this.waves.shift();
    },
    draw: function () {
      var d = sData.data;
      for (var j = 0; j < SH; j++) {
        for (var i = 0; i < SW; i++) {
          var px = i / SW * W, py = j / SH * H;
          var v = 0;
          for (var k = 0; k < this.waves.length; k++) {
            var w = this.waves[k];
            var age = t - w.born, dx = px - w.x, dy = py - w.y;
            var dist = Math.sqrt(dx * dx + dy * dy);
            var front = dist - age * 155;
            v += Math.sin(dist * .055 - age * 5.5) * Math.exp(-Math.abs(front) * .006) * Math.exp(-age * .55);
          }
          var q = Math.max(-1, Math.min(1, v * .8)), k2 = (j * SW + i) * 4;
          d[k2] = 40 + 215 * Math.max(0, q);
          d[k2 + 1] = 40 + 110 * Math.min(1, Math.abs(q));
          d[k2 + 2] = 95 + 160 * Math.max(0, -q);
          d[k2 + 3] = 105 * Math.min(1, Math.abs(q) * 1.5);
        }
      }
      sctx.putImageData(sData, 0, 0);
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = .85;
      ctx.imageSmoothingEnabled = true; ctx.drawImage(small, 0, 0, W, H);
      for (var k = 0; k < this.waves.length; k++) {
        var w = this.waves[k];
        var age = t - w.born, r = age * 155;
        if (r < Math.max(W, H) * 1.2) {
          ctx.strokeStyle = 'rgba(255,90,200,' + Math.max(0, .35 - age * .25) + ')';
          ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(w.x, w.y, r, 0, 6.283); ctx.stroke();
        }
      }
      ctx.restore();
    }
  });

  /* 3. 克拉德尼驻波 */
  MODES.push({
    key: 'cymatics', name: '③ 克拉德尼驻波',
    desc: '数千颗沙粒自动聚拢到振动节线上，形成对称曼陀罗几何；不同音高切换模态，图案瞬间重组。',
    init: function () {
      var n = mobile ? 1800 : 3600;
      this.a = new Float32Array(n); this.b = new Float32Array(n);
      for (var i = 0; i < n; i++) { this.a[i] = Math.random(); this.b[i] = Math.random(); }
      this.m = 3; this.n = 5;
    },
    hit: function (x, y, note) {
      this.m = 2 + (note % 5); this.n = 3 + ((note * 3) % 6);
      if (this.m === this.n) this.n++;
    },
    f: function (x, y) {
      var P = Math.PI, m = this.m, n = this.n;
      return Math.sin(m * P * x) * Math.sin(n * P * y) - Math.sin(n * P * x) * Math.sin(m * P * y);
    },
    draw: function () {
      var n = this.a.length, P = Math.PI, m = this.m, k = this.n;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < n; i++) {
        var x = this.a[i], y = this.b[i];
        var smx = Math.sin(m * P * x), snx = Math.sin(k * P * x);
        var smy = Math.sin(m * P * y), sny = Math.sin(k * P * y);
        var cmx = Math.cos(m * P * x), cnx = Math.cos(k * P * x);
        var cmy = Math.cos(m * P * y), cny = Math.cos(k * P * y);
        var f = smx * sny - snx * smy;
        var gx = m * P * cmx * sny - k * P * cnx * smy;
        var gy = k * P * smx * cny - m * P * snx * cmy;
        var den = gx * gx + gy * gy + .35;
        x -= .55 * f * gx / den + (Math.random() - .5) * .004;
        y -= .55 * f * gy / den + (Math.random() - .5) * .004;
        if (x < .002 || x > .998 || y < .002 || y > .998) { x = Math.random(); y = Math.random(); }
        this.a[i] = x; this.b[i] = y;
        var e = Math.min(1, Math.abs(f) * 1.4);
        ctx.fillStyle = 'hsla(' + (190 + e * 110) + ',95%,' + (76 - e * 20) + '%,' + (1 - e * .72) + ')';
        ctx.fillRect(x * W, y * H, 1.6, 1.6);
      }
      ctx.restore();
    }
  });

  /* 4. 李萨如电子束 */
  MODES.push({
    key: 'lissajous', name: '④ 李萨如电子束', centerGap: true,
    desc: '两个正交振荡画出电子束轨迹，带磷光余晖；按键把频率比锁到协和音程，画出闭合花结。',
    init: function () { clearTrail(); this.r = [3, 2]; },
    hit: function (x, y, note) {
      var R = [[3, 2], [4, 3], [5, 4], [5, 3], [2, 1], [1, 1], [6, 5], [3, 1]];
      this.r = R[note % R.length];
    },
    draw: function () {
      fadeTrail(.055);
      var cx = W / 2, cy = H / 2, R = Math.min(W, H) * .33 * (1 + pulse * .07);
      var drift = t * .075, a = this.r[0], b = this.r[1];
      for (var layer = 0; layer < 2; layer++) {
        tctx.beginPath();
        for (var i = 0; i <= 520; i++) {
          var u = i / 520 * 6.283;
          var x = cx + R * Math.sin(a * u + drift + layer * .05) * (.86 + .14 * Math.sin(u * .3 + t * .2));
          var y = cy + R * Math.sin(b * u + .55 + drift * .7 + layer * .035);
          i ? tctx.lineTo(x, y) : tctx.moveTo(x, y);
        }
        tctx.closePath();
        tctx.strokeStyle = layer ? 'hsla(310,100%,74%,.20)' : 'hsla(190,100%,74%,.42)';
        tctx.lineWidth = 1.2; tctx.stroke();
      }
      overlayTrail(.95);
    }
  });

  /* 5. 极光帷幕 */
  MODES.push({
    key: 'aurora', name: '⑤ 极光帷幕',
    desc: '半透明光幕按行缓慢摆动、边缘发亮；演奏把光幕推开并掀起一道全屏光浪，氛围最柔和。',
    init: function () { this.mx = W / 2; },
    hit: function (x) { this.mx = x; },
    draw: function () {
      var bands = 6;
      var self = this;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      var center = function (y, b) {
        return W * (.5 + (b - (bands - 1) / 2) * .075)
          + Math.sin(y * .008 + t * .45 + b * .7) * W * .15
          + Math.sin(y * .019 - t * .62 + b * .3) * W * .05
          + Math.max(-1, Math.min(1, (self.mx - W / 2) / (W * .5))) * 40 * Math.sin(y * .006 + t * .3);
      };
      for (var b = 0; b < bands; b++) {
        var w = (60 + 34 * Math.sin(t * .6 + b)) * (1 + pulse * .7);
        ctx.beginPath();
        for (var y = 0; y <= H; y += 10) ctx.lineTo(center(y, b) - w / 2, y);
        for (var y2 = H; y2 >= 0; y2 -= 10) ctx.lineTo(center(y2, b) + w / 2, y2);
        ctx.closePath();
        var g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, 'hsla(' + (165 + b * 18) + ',100%,65%,0)');
        g.addColorStop(.32, 'hsla(' + (165 + b * 18) + ',100%,65%,' + (.13 + pulse * .06) + ')');
        g.addColorStop(.72, 'hsla(' + (210 + b * 20) + ',100%,68%,' + (.09 + pulse * .05) + ')');
        g.addColorStop(1, 'hsla(285,100%,70%,0)');
        ctx.fillStyle = g; ctx.fill();
        ctx.strokeStyle = 'hsla(' + (170 + b * 20) + ',100%,80%,' + (.10 + pulse * .08) + ')';
        ctx.lineWidth = .8;
        for (var k = -6; k <= 6; k++) {
          ctx.beginPath();
          for (var yy = 0; yy <= H; yy += 16) {
            var xx = center(yy, b) + k * w / 14 + Math.sin(yy * .03 + t * 1.4 + k) * 3;
            yy ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
          }
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  });

  /* 6. 流场丝线 */
  MODES.push({
    key: 'flow', name: '⑥ 流场丝线',
    desc: '粒子沿连续的 curl 噪声向量场滑动，留下细长光丝，像星际流体或墨在水中散开。',
    init: function () {
      clearTrail();
      var n = mobile ? 375 : 750;
      this.p = [];
      for (var i = 0; i < n; i++) this.p.push({ x: Math.random() * W, y: Math.random() * H, h: Math.random() });
    },
    hit: function () { /* pulse 统一加速 */ },
    draw: function () {
      fadeTrail(.025);
      var sp = 1.15 + pulse * 1.7;
      for (var i = 0; i < this.p.length; i++) {
        var p = this.p[i];
        var x = p.x, y = p.y;
        var vx = Math.sin(y * .007 + t * .35) + .6 * Math.cos(x * .011 - t * .22) + .5 * Math.sin((x + y) * .005 + t * .4);
        var vy = Math.cos(x * .009 - t * .28) + .6 * Math.sin(y * .012 + t * .19);
        var nx = x + vx * sp, ny = y + vy * sp;
        tctx.strokeStyle = 'hsla(' + (180 + p.h * 135) + ',95%,70%,.42)';
        tctx.lineWidth = .9; tctx.beginPath(); tctx.moveTo(x, y); tctx.lineTo(nx, ny); tctx.stroke();
        p.x = nx; p.y = ny;
        if (nx < -30 || nx > W + 30 || ny < -30 || ny > H + 30) { p.x = Math.random() * W; p.y = Math.random() * H; }
      }
      overlayTrail(.9);
    }
  });

  /* 7. 星座连线网络 */
  MODES.push({
    key: 'network', name: '⑦ 星座连线网络',
    desc: '散点星群按距离阈值连成星座图；演奏点亮一颗星，光沿连线向邻居传播，整张网像神经元一闪。',
    init: function () {
      this.n = stars.slice(0, 110).map(function (s) { return { x: s.x, y: s.y, h: s.h }; });
      this.g = new Float32Array(this.n.length);
    },
    hit: function (x, y) {
      var best = 0, bd = 1e9;
      this.n.forEach(function (p, i) { var d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y); if (d < bd) { bd = d; best = i; } });
      this.g[best] = 1.6;
      var self = this;
      this.n.forEach(function (p, i) {
        var dx = p.x - self.n[best].x, dy = p.y - self.n[best].y;
        if (i !== best && dx * dx + dy * dy < 180 * 180) self.g[i] = .8;
      });
    },
    draw: function () {
      var lim = Math.min(W, H) * .17;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < this.n.length; i++) {
        for (var j = i + 1; j < this.n.length; j++) {
          var a = this.n[i], b = this.n[j], dx = a.x - b.x, dy = a.y - b.y;
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d < lim) {
            ctx.strokeStyle = 'hsla(' + ((a.h + b.h) / 2) + ',90%,72%,' + ((1 - d / lim) * .22 * (1 + this.g[i] + this.g[j])) + ')';
            ctx.lineWidth = .8; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
      }
      for (var k = 0; k < this.n.length; k++) {
        var p = this.n[k]; this.g[k] *= .955;
        ctx.fillStyle = 'hsla(' + p.h + ',95%,78%,' + Math.min(1, .35 + this.g[k]) + ')';
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.2 + this.g[k] * 3.2, 0, 6.283); ctx.fill();
      }
      ctx.restore();
    }
  });

  /* 8. 拓扑等高线 */
  MODES.push({
    key: 'topo', name: '⑧ 拓扑等高线', centerGap: true,
    desc: '以中心为源画几十圈会呼吸的等高线，多组驻波叠在半径上，像地形图又像声波切片。',
    init: function () { },
    hit: function () { },
    draw: function () {
      var cx = W / 2, cy = H / 2, unit = Math.min(W, H);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (var k = 0; k < 26; k++) {
        var r0 = unit * .06 + k * unit * .013;
        ctx.beginPath();
        for (var i = 0; i <= 180; i++) {
          var th = i / 180 * 6.283;
          var r = r0 + Math.sin(3 * th + t * .8 + k * .22) * (3 + k * .65)
            + Math.sin(7 * th - t * .5 + k * .4) * (2 + k * .28)
            + pulse * 11 * Math.sin(5 * th + t * 3) * Math.exp(-k * .05);
          var x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = 'hsla(' + (188 + k * 3.5) + ',92%,66%,' + (.34 * (1 - k / 30)) + ')';
        ctx.lineWidth = 1; ctx.stroke();
      }
      ctx.restore();
    }
  });

  /* ---------- 引擎内部：交互 / 逐帧渲染 ---------- */
  function hit(x, y, note) {
    pulse = Math.min(2.2, pulse + .85);
    var m = MODES[variant];
    if (m.hit) m.hit(x, y, note | 0);
    dirty = true;
  }

  function reset() {
    if (!live) return;
    pulse = 0;
    clearTrail();
    if (MODES[variant].init) MODES[variant].init();
    dirty = true;
  }

  /**
   * 渲染一帧。dt：帧间隔（60fps = 1）；absT：绝对秒（可选，与原型 t=ts/1000 同源）。
   * 返回是否真的重画了（reduced 静态帧返回 false，调用方可跳过纹理上传）。
   */
  function renderFrame(dt, absT) {
    if (!live) return false;
    var dtScale = clamp(dt, .25, 3);
    if (reduced) {
      if (!dirty) return false;   // 静态帧：仅在事件 / 切换 / resize 后重画
      dirty = false;
    } else if (typeof absT === 'number') {
      t = absT;
    } else {
      t += dtScale / 60;
    }
    var main = ctx;
    drawBase();
    var m = MODES[variant];
    if (m.draw) {
      // 中心让位：把 effect 画进独立缓冲，径向遮罩擦掉中心区再 lighter 合成，
      // 让 CoreLayer 的核心 / 波形环独占中心舞台。
      var gap = centerZone && m.centerGap && fctx;
      if (gap) {
        ctx = fctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, W, H);
      }
      m.draw();
      ctx = main;
      if (gap) {
        applyCenterGap();
        main.save();
        main.globalCompositeOperation = 'lighter';
        main.globalAlpha = 1;
        main.drawImage(fx, 0, 0, W, H);
        main.restore();
      }
    }
    pulse *= Math.pow(0.935, dtScale);   // 60fps 下等价于原型 ×0.935，高刷屏节奏不变
    return true;
  }

  function destroy() {
    live = false;
    dirty = false;
    cv = null; ctx = null;
    fx = null; fctx = null; gapGrad = null;
    trail = null; tctx = null; small = null; sctx = null; sData = null;
  }

  /* ---------- 对外接口 ---------- */
  var engineApi = {
    /** 当前画布（BgLayer 用它创建 PIXI CanvasTexture） */
    canvas: null,

    renderFrame: function (dt, absT) { return renderFrame(dt, absT); },
    hit: function (x, y, note) { hit(x, y, note | 0); return engineApi; },
    reset: function () { reset(); return engineApi; },

    setPerfMode: function (v) {
      v = !!v;
      if (perf === v) return engineApi;
      perf = v;
      if (cv) makeCanvases();
      dirty = true;
      return engineApi;
    },
    setReducedMotion: function (v) { reduced = !!v; dirty = true; return engineApi; },

    /**
     * 中心点是否被 CoreLayer 占用。
     * true（默认）：中心锚定的变体让出中心区，只留背景；
     * false：中心没有核心特效时（CoreLayer 关闭），让位取消，画面保持完整。
     */
    setCenterZone: function (v) {
      v = !!v;
      if (centerZone === v) return engineApi;
      centerZone = v;
      dirty = true;
      return engineApi;
    },

    /** 释放引擎（画布引用交给调用方的纹理管理，此处只解绑内部状态） */
    destroy: function () { destroy(); return engineApi; },

    /** 供无头回归检查内部状态 */
    state: function () {
      return {
        live: live, variant: variant, pulse: pulse, t: t,
        W: W, H: H, SW: SW, SH: SH, modes: MODES.length,
        reduced: reduced, perf: perf, mobile: mobile, centerZone: centerZone
      };
    }
  };

  global.StellarResonance = {
    /**
     * 创建一个引擎实例（画到离屏 canvas，不触碰 DOM / rAF / localStorage）。
     * 同一时刻只保留一个活跃实例：再次 create 会先释放上一个。
     */
    create: function (variantIdx, w, h, t0) {
      if (live) destroy();
      cv = doc.createElement('canvas');
      ctx = cv.getContext('2d');
      engineApi.canvas = cv;
      variant = clamp(variantIdx | 0, 0, MODES.length - 1);
      var mq = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)');
      reduced = !!(mq && mq.matches);
      mobile = (global.innerWidth || w) < 720;
      if (typeof t0 === 'number') t = t0; // 时钟锚点：init 里 born 基准必须与首次渲染同源
      live = true;
      resize(w, h);
      return engineApi;
    },

    /** 效果清单（调试 / 回归用） */
    variants: function () {
      return MODES.map(function (m) { return { key: m.key, name: m.name, desc: m.desc }; });
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);

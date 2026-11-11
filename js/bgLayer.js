/**
 * bgLayer.js — 星海共振 · 背景系统
 * ====================================================================
 * 4 种背景，均位于渲染树最底层，不拦截任何输入：
 *
 *   common  通用   主题色星云光斑漂浮（星星由全局 ParallaxStarfield 绘制）
 *   nebula  星云   哈勃船底座星云壁纸，缓慢漂移（不随音乐动）
 *   aurora  极光   ISS 南极光壁纸，缓慢漂移（不随音乐动）
 *   warp    穿梭   向镜头飞来的星海（速度线）
 *
 * 设计原则：背景是壁纸，不是伴舞——除「穿梭」的速度线外一律不响应音频，
 * 只做极缓慢的 Ken Burns 漂移，永远不与中心星抢焦点。
 *
 * 依赖：PIXI v6（本地 vendor）。壁纸图为 NASA 公版素材（img/ 目录，本地打包）。
 *
 * 接口：
 *   var bg = new BgLayer();
 *   bg.init({ stage, renderer, container, themeId }, { getTheme });
 *   bg.setMode('common'); bg.setParam('common', 'glow', 0.6);
 *   bg.retheme('nebula'); bg.setCustomTheme(themeObj);
 *   bg.setCover(coverUrl);            // 封面（当前模式均不用图，保留接口）
 *   bg.tick(dt, spectrumData);
 *   bg.destroy();
 */
(function (global) {
  'use strict';

  /* ============================================================
   * 一、通用工具
   * ============================================================ */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: h, s: s, l: l };
  }

  function hslToRgb(h, s, l) {
    h = ((h % 1) + 1) % 1;
    var r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      var f = function (t) {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      r = f(h + 1 / 3); g = f(h); b = f(h - 1 / 3);
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  }

  function num(r, g, b) { return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255); }

  function channel(color) {
    return { r: (color >> 16) & 255, g: (color >> 8) & 255, b: color & 255 };
  }

  function cssHex(color) {
    return '#' + ('000000' + (color >>> 0).toString(16)).slice(-6);
  }

  function rgbaCss(color, a) {
    var c = channel(color);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }

  // 背景用色：降饱和，避免与前景抢戏
  function softColor(color, sMul, lAdd) {
    var c = channel(color);
    var hsl = rgbToHsl(c.r, c.g, c.b);
    var rgb = hslToRgb(hsl.h, clamp(hsl.s * sMul, 0, 1), clamp(hsl.l + (lAdd || 0), 0, 1));
    return num(rgb.r, rgb.g, rgb.b);
  }

  /**
   * 星海专用冷色调色板：背景一律围绕中心星的青蓝走，不跟随封面的绿色/暖色，
   * 避免「青蓝星核 + 翠绿星云」这类打架配色。
   *   主题色本身在青→蓝紫区间时沿用其色相，否则回落到青色。
   */
  function cosmicPalette(primary) {
    var c = channel(primary);
    var h = rgbToHsl(c.r, c.g, c.b).h;
    if (!(h >= 0.44 && h <= 0.82)) h = 0.52;
    h = clamp(h, 0.48, 0.60);
    return {
      cyan: num2(hslToRgb(h, 0.86, 0.66)),          // 亮青（帘幕底缘 / 流星尾）
      gas: num2(hslToRgb(h + 0.05, 0.80, 0.50)),     // 星云主气
      deep: num2(hslToRgb(h + 0.11, 0.88, 0.36)),    // 深蓝
      violet: num2(hslToRgb(0.74, 0.60, 0.40)),      // 紫罗兰暗尘
      magenta: num2(hslToRgb(0.84, 0.66, 0.54)),     // 极光顶缘紫红
      white: 0xf2fbff                                 // 亮核
    };
  }

  function num2(rgb) { return num(rgb.r, rgb.g, rgb.b); }

  function toUniform(color) {
    return [(color >> 16 & 255) / 255, (color >> 8 & 255) / 255, (color & 255) / 255];
  }

  // 频谱区间均值（0..1）
  function ech(data, from, to) {
    if (!data || !data.length) return 0;
    var s = 0, n = 0;
    for (var i = from; i <= to && i < data.length; i++) { s += data[i]; n++; }
    return n ? (s / n) / 255 : 0;
  }

  // 感知曲线：真实音乐各段均值偏小，sqrt 提亮弱信号
  function boost(v, gain) {
    return Math.min(1, Math.sqrt(clamp(v * (gain || 3), 0, 1)));
  }

  /* ============================================================
   * 二、程序化纹理
   * ============================================================ */

  var TEX_CACHE = {};

  function cacheTex(key, build) {
    if (TEX_CACHE[key]) return TEX_CACHE[key];
    var t = build();
    TEX_CACHE[key] = t;
    return t;
  }

  function radialTexture(color, size) {
    return cacheTex('r' + color + '_' + size, function () {
      var cv = document.createElement('canvas');
      cv.width = cv.height = size;
      var ctx = cv.getContext('2d');
      var c = channel(color);
      var g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0.95)');
      g.addColorStop(0.35, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0.5)');
      g.addColorStop(1, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      return PIXI.Texture.from(cv);
    });
  }

  function vignetteTexture(size) {
    return cacheTex('vig' + size, function () {
      var cv = document.createElement('canvas');
      cv.width = cv.height = size;
      var ctx = cv.getContext('2d');
      var g = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.66);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.55, 'rgba(0,0,0,0.18)');
      g.addColorStop(1, 'rgba(0,0,0,0.72)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      return PIXI.Texture.from(cv);
    });
  }

  // 主题色渐变底图（无封面时的兜底）
  function gradientTexture(colors, size) {
    var key = 'g' + size + '_' + colors.join('-');
    return cacheTex(key, function () {
      var cv = document.createElement('canvas');
      cv.width = cv.height = size;
      var ctx = cv.getContext('2d');
      // 深底 + 主题色光斑（不能整块铺亮色，否则背景过曝）
      ctx.fillStyle = cssHex(softColor(colors[0], 0.9, -0.32));
      ctx.fillRect(0, 0, size, size);
      var spots = [
        [0.26, 0.28, 0.6, colors[1] || colors[0], 0.55],
        [0.76, 0.32, 0.52, colors[2] || colors[0], 0.45],
        [0.54, 0.78, 0.66, colors[3] || colors[0], 0.5]
      ];
      spots.forEach(function (s) {
        var g = ctx.createRadialGradient(size * s[0], size * s[1], 0, size * s[0], size * s[1], size * s[2]);
        g.addColorStop(0, rgbaCss(s[3], s[4]));
        g.addColorStop(1, rgbaCss(s[3], 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      });
      return PIXI.Texture.from(cv);
    });
  }

  function clearTextureCache() {
    Object.keys(TEX_CACHE).forEach(function (k) {
      try { TEX_CACHE[k].destroy(true); } catch (e) { /* 忽略 */ }
      delete TEX_CACHE[k];
    });
  }

  /* ============================================================
   * 三、滤镜（光晕波浪）
   * ============================================================ */

  // 光晕波浪：只作用于画面亮部（星云辉光 / 极光光带）——亮部做缓慢的
  // 斜向行波折射 + 亮度呼吸，暗部（星空 / 深空）保持绝对稳定。
  // 纯时间驱动，不随音频——背景依然是壁纸，只是光在「活着」。
  var GLOW_WAVE_FRAG = [
    'precision mediump float;',
    'varying vec2 vTextureCoord;',
    'uniform sampler2D uSampler;',
    'uniform float uTime;',
    'uniform float uWave;',
    'uniform float uGlow;',
    'void main(void) {',
    '  vec2 uv = vTextureCoord;',
    '  vec4 src = texture2D(uSampler, uv);',
    '  float lum = dot(src.rgb, vec3(0.299, 0.587, 0.114));',
    '  float wgt = smoothstep(0.30, 0.85, lum);',
    '  float ph = uv.x * 2.0 + uv.y * 1.0 - uTime * 0.20;',
    '  vec2 flow = vec2(',
    '    sin(ph * 2.6 + uv.y * 5.0),',
    '    sin(ph * 2.0 - uv.x * 4.0 + 1.7)',
    '  );',
    '  vec2 duv = clamp(uv + flow * uWave * 0.0045 * wgt, 0.002, 0.998);',
    '  vec4 col = texture2D(uSampler, duv);',
    '  float pulse = 0.5 + 0.5 * sin(ph * 3.0);',
    '  col.rgb *= 1.0 + wgt * uGlow * (0.05 + 0.20 * pulse);',
    '  float crest = wgt * uWave * pow(max(0.0, sin(ph * 3.2)), 8.0);',
    '  col.rgb += vec3(0.85, 0.92, 1.0) * crest * 0.06;',
    '  gl_FragColor = vec4(col.rgb, src.a);',
    '}'
  ].join('\n');

  /* ============================================================
   * 四、模式元数据（设置面板据此渲染）
   * ============================================================ */

  var MODE_META = {
    common: {
      name: '通用',
      params: [
        { key: 'glow', label: '星云辉光', min: 0, max: 1, step: 0.05, def: 0.55 },
        { key: 'dim', label: '压暗', min: 0, max: 0.85, step: 0.05, def: 0 }
      ]
    },
    nebula: {
      name: '星云',
      params: [
        { key: 'drift', label: '漂移', min: 0, max: 2, step: 0.05, def: 0.8 },
        { key: 'breath', label: '呼吸', min: 0, max: 1, step: 0.05, def: 0.4 },
        { key: 'wave', label: '光浪', min: 0, max: 1.5, step: 0.05, def: 0.6 },
        { key: 'glow', label: '光晕', min: 0, max: 1.5, step: 0.05, def: 0.6 },
        { key: 'dim', label: '压暗', min: 0, max: 0.85, step: 0.05, def: 0.12 }
      ]
    },
    aurora: {
      name: '极光',
      params: [
        { key: 'drift', label: '漂移', min: 0, max: 2, step: 0.05, def: 0.8 },
        { key: 'breath', label: '呼吸', min: 0, max: 1, step: 0.05, def: 0.4 },
        { key: 'wave', label: '光浪', min: 0, max: 1.5, step: 0.05, def: 0.7 },
        { key: 'glow', label: '光晕', min: 0, max: 1.5, step: 0.05, def: 0.7 },
        { key: 'dim', label: '压暗', min: 0, max: 0.85, step: 0.05, def: 0.1 }
      ]
    },
    warp: {
      name: '穿梭',
      params: [
        { key: 'density', label: '密度', min: 80, max: 500, step: 10, def: 260 },
        { key: 'speed', label: '速度', min: 0.2, max: 3, step: 0.05, def: 1 },
        { key: 'streak', label: '拉伸', min: 0, max: 1, step: 0.05, def: 0.55 },
        { key: 'glow', label: '辉光', min: 0, max: 1, step: 0.05, def: 0.6 }
      ]
    },
    // 星海共振 8 种共振效果：与上面 4 种并列的顶级背景模式（无二级菜单）。
    // 视觉由 stellarResonance 引擎画进离屏 canvas，本层在 _buildStellar 里
    // 把它作为 PIXI CanvasTexture 放进模式根容器 —— 与壁纸模式同一套生命周期。
    sv0: { name: '引力吸积盘', params: [], variant: 0 },
    sv1: { name: '声波涟漪干涉', params: [], variant: 1 },
    sv2: { name: '克拉德尼驻波', params: [], variant: 2 },
    sv3: { name: '李萨如电子束', params: [], variant: 3 },
    sv4: { name: '极光帷幕', params: [], variant: 4 },
    sv5: { name: '流场丝线', params: [], variant: 5 },
    sv6: { name: '星座连线网络', params: [], variant: 6 },
    sv7: { name: '拓扑等高线', params: [], variant: 7 }
  };

  var MODE_ORDER = ['common', 'nebula', 'aurora', 'warp',
    'sv0', 'sv1', 'sv2', 'sv3', 'sv4', 'sv5', 'sv6', 'sv7'];

  /* ============================================================
   * 五、BgLayer
   * ============================================================ */

  function BgLayer() {
    this.mode = 'common';
    this.perf = false;
    this.theme = null;
    this.palette = [0x00f0ff, 0xff00aa, 0x7fff00, 0xffcc00, 0x9b59ff, 0xff6b35];
    this.colors = { bg: 0x0a0420, primary: 0x00f0ff, secondary: 0xff00aa, accent: 0x00f0ff };
    // 星海专用冷色板（背景统一青蓝，见 cosmicPalette）
    this.cosmic = {
      cyan: 0x4de7ff, gas: 0x2f7fd8, deep: 0x1a3f8f,
      violet: 0x6f4fb0, magenta: 0xc23c8f, white: 0xf2fbff
    };
    this.params = {};

    this.coverUrl = '';
    this._coverImage = null;
    this._coverToken = 0;

    this.w = 1;
    this.h = 1;
    this._time = 0;          // ms
    this._ready = false;
    this._modeRoot = null;
    this._modeFilters = [];
    this._fading = [];       // 模式切换 crossfade：下沉中的旧层
    this._fadeDur = 0.9;     // 秒
    this._bands = { bass: 0, lowMid: 0, mid: 0, vocal: 0, treble: 0, power: 0 };
    this._smooth = { bass: 0, lowMid: 0, mid: 0, vocal: 0, treble: 0, power: 0 };
    this.onPostFiltersChange = null;

    this._wpTex = null;      // 壁纸纹理缓存（init 时预载）
    this._wp = null;         // 当前壁纸精灵
    this._wpFilter = null;   // 光晕波浪滤镜
  }

  /* ---------------- 生命周期 ---------------- */

  BgLayer.prototype.init = function (app, themesModule) {
    var self = this;
    this.app = app || {};
    this.themes = themesModule || { getTheme: global.getTheme };
    // 中心点是否被 CoreLayer 占用（星海模式据此让出中心，避免两套中心视觉重叠）
    this._getCenterMode = (themesModule && themesModule.getCenterMode) || null;
    this.stage = this.app.stage || null;
    this.renderer = this.app.renderer || null;

    if (this.renderer && this.renderer.screen) {
      this.w = this.renderer.screen.width;
      this.h = this.renderer.screen.height;
    } else {
      this.w = global.innerWidth || 1;
      this.h = global.innerHeight || 1;
    }

    if (this.app.container) {
      this.container = this.app.container;
    } else if (this.stage) {
      this.container = new PIXI.Container();
      this.stage.addChildAt(this.container, 0);
    }
    if (this.container) {
      this.container.interactive = false;
      this.container.interactiveChildren = false;
    }

    // 后处理覆盖层（暗角等），位于所有内容之上但不可交互
    this.topContainer = new PIXI.Container();
    this.topContainer.interactive = false;
    this.topContainer.interactiveChildren = false;
    if (this.stage) this.stage.addChild(this.topContainer);

    // 参数默认值
    Object.keys(MODE_META).forEach(function (m) {
      var o = {};
      MODE_META[m].params.forEach(function (s) { o[s.key] = s.def; });
      self.params[m] = o;
    });

    // 星海共振引擎的减少动效偏好（模式激活时随 _buildStellar 下发）
    var mq = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)');
    this._stellarReduced = !!(mq && mq.matches);
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', function (e) {
        self._stellarReduced = !!e.matches;
        if (self._stellar) self._stellar.setReducedMotion(self._stellarReduced);
      });
    }

    // 预载壁纸纹理（星云 / 极光）
    this._preloadWallpapers();

    this._ready = true;
    this._applyTheme(this.themes.getTheme ? this.themes.getTheme(this.app.themeId || 'nebula') : null,
      this.app.themeId || 'nebula');
    if (!this.mode || !MODE_META[this.mode]) this.mode = 'common';
    this.setMode(this.mode);
    return this;
  };

  BgLayer.prototype.destroy = function () {
    this._teardownMode();
    if (this.topContainer) {
      this.topContainer.removeChildren();
      this.topContainer.destroy({ children: true, texture: false, baseTexture: false });
      this.topContainer = null;
    }
    if (this.container && !this.app.container) {
      this.container.destroy({ children: true, texture: false, baseTexture: false });
    }
    this.container = null;
    this._coverImage = null;
    this._ready = false;
    clearTextureCache();
  };

  /* ---------------- 主题 ---------------- */

  BgLayer.prototype._applyTheme = function (theme, themeId) {
    if (!theme) return;
    this.theme = theme;
    this.themeId = themeId || theme.id;
    var pal = (theme.particles || [0x00f0ff, 0xff00aa, 0x7fff00]).slice();
    while (pal.length < 6) pal.push(pal[pal.length - 1]);
    this.palette = pal.map(function (c) { return softColor(c, 0.72, 0.02); });
    this.rawPalette = pal;
    this.colors = {
      bg: theme.background || 0x0a0420,
      primary: pal[0],
      secondary: pal[2] || pal[1],
      accent: theme.accent || pal[3]
    };
    // 背景统一冷色系（围绕中心星青蓝），与封面色板解耦
    this.cosmic = cosmicPalette(this.colors.accent || pal[0]);
    if (this._ready && this.container) this.setMode(this.mode);
  };

  BgLayer.prototype.retheme = function (themeId) {
    var t = this.themes && this.themes.getTheme ? this.themes.getTheme(themeId) : null;
    if (t) this._applyTheme(t, themeId);
  };

  BgLayer.prototype.setCustomTheme = function (themeObj) {
    if (themeObj) this._applyTheme(themeObj, 'custom');
  };

  // 封面：当前 5 种模式均不以封面为背景，保留接口存图备用
  BgLayer.prototype.setCover = function (url) {
    if (!url || url === this.coverUrl) return;
    var self = this;
    this.coverUrl = url;
    var token = ++this._coverToken;
    var img = new Image();
    img.crossOrigin = 'anonymous'; // 需要上传到 WebGL，必须 CORS
    img.onload = function () {
      if (token !== self._coverToken) return;
      self._coverImage = img;
    };
    img.onerror = function () {
      // CORS 或网络问题：忽略
    };
    img.src = url;
  };

  /* ---------------- 模式切换 ---------------- */

  /** 递归摘掉滤镜引用，避免销毁滤镜后渲染系统仍持有已销毁对象 */
  function detachFilters(node) {
    if (!node || !node.children) return;
    var kids = node.children;
    for (var i = 0; i < kids.length; i++) {
      var ch = kids[i];
      if (ch.filters) ch.filters = null;
      detachFilters(ch);
    }
  }

  BgLayer.prototype.setMode = function (modeId, opts) {
    if (!MODE_META[modeId]) modeId = 'common';
    var same = (this.mode === modeId);
    this.mode = modeId;
    if (!this._ready || !this.container) return;

    var prevRoot = this._modeRoot;
    var prevFilters = this._modeFilters;
    var prevAlpha = prevRoot ? prevRoot.alpha : 1;
    // 同一模式重建（换主题）不做淡入淡出，避免闪一下
    var immediate = !!(opts && opts.immediate) || same || !prevRoot;

    // 星海共振纹理要等旧层淡出完成后才能销毁（否则 crossfade 白屏）
    var bgSelf = this;
    var prevStellarTex = this._stellarTex;
    var prevGone = prevStellarTex ? function () {
      prevStellarTex.destroy(true);
      if (bgSelf._stellarTex === prevStellarTex) bgSelf._stellarTex = null;
    } : null;

    this._modeRoot = null;
    this._modeFilters = [];
    this._resetModeRefs();

    var root = new PIXI.Container();
    root.interactive = false;
    root.interactiveChildren = false;
    this.container.addChild(root);
    this._modeRoot = root;

    if (prevRoot) {
      if (immediate) {
        this._destroyModeRoot(prevRoot, prevFilters, prevGone);
      } else {
        // 旧层原地淡出 → 新层淡入：切换模式不闪黑、不硬切
        this._fading.push({ root: prevRoot, filters: prevFilters, alpha: prevAlpha, onGone: prevGone });
        root.alpha = 0;
      }
    } else {
      root.alpha = 1;
    }

    switch (modeId) {
      case 'common': this._buildCommon(); break;
      case 'nebula':
      case 'aurora': this._buildWallpaper(modeId); break;
      case 'warp': this._buildWarp(); break;
      default:
        if (MODE_META[modeId] && MODE_META[modeId].variant !== undefined) {
          this._buildStellar(MODE_META[modeId].variant);
        }
        break;
    }
    this._notifyPost();
  };

  BgLayer.prototype._destroyModeRoot = function (root, filters, onGone) {
    if (!root) return;
    detachFilters(root);
    try {
      root.removeChildren();
      root.destroy({ children: true, texture: false, baseTexture: false });
    } catch (e) { /* 忽略 */ }
    for (var i = 0; i < (filters || []).length; i++) {
      try { filters[i].destroy(); } catch (e2) { /* 忽略 */ }
    }
    if (onGone) onGone();
  };

  BgLayer.prototype._resetModeRefs = function () {
    this._dimVeil = null;
    this._commonRoot = null;
    this._commonGlows = null;
    this._wp = null;
    this._wpGrads = null;
    this._wpFilter = null;
    this._gWarp = null;
    this._warpStars = null;
    // 星海共振引擎：立即停机（画布引用仍被淡出中的旧纹理持有，无害）
    if (this._stellar) {
      this._stellar.destroy();
      this._stellar = null;
    }
    this._stellarTex = null;
  };

  BgLayer.prototype._teardownMode = function () {
    var self = this;
    var tex = this._stellarTex;
    var onGone = tex ? function () {
      tex.destroy(true);
      if (self._stellarTex === tex) self._stellarTex = null;
    } : null;
    if (this._modeRoot) this._destroyModeRoot(this._modeRoot, this._modeFilters, onGone);
    this._modeRoot = null;
    this._modeFilters = [];
    for (var i = 0; i < this._fading.length; i++) {
      this._destroyModeRoot(this._fading[i].root, this._fading[i].filters, this._fading[i].onGone || onGone);
    }
    this._fading = [];
    this._resetModeRefs();
    if (this.topContainer) this.topContainer.removeChildren();
    if (this.renderer) this.renderer.backgroundAlpha = 1;
  };

  BgLayer.prototype._notifyPost = function () {
    if (typeof this.onPostFiltersChange === 'function') this.onPostFiltersChange();
  };

  /* ---------------- 参数 ---------------- */

  BgLayer.prototype.setParam = function (modeId, key, value) {
    if (!this.params[modeId]) return;
    this.params[modeId][key] = value;
    if (modeId !== this.mode) return;

    if (key === 'dim' && this._dimVeil) {
      this._dimVeil.alpha = clamp(value, 0, 1);
      return;
    }

    if (modeId === 'common') {
      // glow / dim 由 tick 与通用 dim 分支实时读取，无需重建
    } else if (modeId === 'nebula' || modeId === 'aurora') {
      // 漂移 / 呼吸 / 压暗均由 tick 每帧读取，实时生效
    } else if (modeId === 'warp') {
      if (key === 'density') this._makeWarpStars();
    }
  };

  BgLayer.prototype.getParam = function (modeId, key) {
    return this.params[modeId] ? this.params[modeId][key] : undefined;
  };

  BgLayer.prototype.setPerfMode = function (on) {
    this.perf = !!on;
    if (this._ready) this.setMode(this.mode);
  };

  BgLayer.prototype.resize = function (w, h) {
    this.w = w || this.w;
    this.h = h || this.h;
    // 全屏 shader 模式需按新尺寸重建；流星/穿梭按帧读取 w/h 自适应
    var sm = MODE_META[this.mode];
    if (this.mode === 'common' || this.mode === 'nebula' || this.mode === 'aurora' ||
        (sm && sm.variant !== undefined)) this.setMode(this.mode);
  };

  /**
   * 视差偏移：以画面中心为轴心，放大 5% 过扫描抵消位移带来的露边。
   * topContainer（暗角等后处理）不跟随——它必须锚定屏幕边缘。
   */
  BgLayer.prototype.setOffset = function (x, y) {
    if (!this.container) return;
    this.container.pivot.set(this.w / 2, this.h / 2);
    this.container.position.set(this.w / 2 + (x || 0), this.h / 2 + (y || 0));
    this.container.scale.set(1.05);
  };

  /* ============================================================
   * M1 通用：主题色星云光斑漂浮
   * ============================================================ */

  BgLayer.prototype._buildCommon = function () {
    // 纯色主题背景 + 星云辉光；星星由全局 ParallaxStarfield 统一绘制
    this._commonRoot = new PIXI.Container();
    this._modeRoot.addChild(this._commonRoot);

    // 星云底光：主题色径向光斑，缓慢漂移
    this._commonGlows = [];
    var baseCols = [this.cosmic.deep, this.cosmic.gas, this.cosmic.violet];
    for (var gi = 0; gi < 3; gi++) {
      var gs = new PIXI.Sprite(radialTexture(baseCols[gi], 256));
      gs.anchor.set(0.5);
      gs.blendMode = PIXI.BLEND_MODES.SCREEN;
      var gsize = Math.max(this.w, this.h) * (0.9 + gi * 0.35);
      gs.width = gsize;
      gs.height = gsize;
      gs.alpha = 0.14;
      gs.x = this.w * (0.24 + gi * 0.26);
      gs.y = this.h * (0.34 + (gi % 2) * 0.3);
      this._commonRoot.addChild(gs);
      this._commonGlows.push({ sprite: gs, cx: gs.x, cy: gs.y, ph: gi * 2.1 });
    }

    this._addDimVeil(this.params.common.dim || 0);
  };

  // 统一压暗层：把背景压到不抢前景的程度（0 = 不压）
  BgLayer.prototype._addDimVeil = function (alpha) {
    this._dimVeil = new PIXI.Graphics();
    this._dimVeil.beginFill(0x000000, 1).drawRect(0, 0, this.w, this.h).endFill();
    this._dimVeil.alpha = clamp(alpha || 0, 0, 1);
    this._modeRoot.addChild(this._dimVeil);
  };

  BgLayer.prototype._tickCommon = function (dt) {
    var t = this._time * 0.001;
    var w = this.w, h = this.h;
    var p = this.params.common;
    var bands = this._smooth;

    // 星云光斑缓慢漂移（低频呼吸）
    var glows = this._commonGlows;
    if (!glows) return;
    for (var gi = 0; gi < glows.length; gi++) {
      var gg = glows[gi];
      gg.sprite.x = gg.cx + Math.sin(t * 0.16 + gg.ph) * w * 0.07;
      gg.sprite.y = gg.cy + Math.cos(t * 0.13 + gg.ph) * h * 0.05;
      gg.sprite.alpha = (0.03 + p.glow * 0.06) + bands.bass * 0.05;
    }
  };

  /* ============================================================
  /* ============================================================
   * M2/M3 壁纸背景：星云 / 极光（NASA 公版摄影，慢速漂移）
   * 设计原则：背景是壁纸，不是伴舞——不跟音乐动，只有极缓慢的
   * Ken Burns 式漂移与呼吸变焦，画面「活着」但永远不抢戏。
   * ============================================================ */

  var WALLPAPERS = {
    nebula: { url: 'img/bg-nebula.jpg' }, // 哈勃 · 船底座星云（NASA 公版）
    aurora: { url: 'img/bg-aurora.jpg' }  // ISS · 南极光（NASA 公版）
  };

  // 预载壁纸纹理（init 时调用一次，之后切换模式秒开）
  BgLayer.prototype._preloadWallpapers = function () {
    var self = this;
    this._wpTex = {};
    Object.keys(WALLPAPERS).forEach(function (id) {
      try { self._wpTex[id] = PIXI.Texture.from(WALLPAPERS[id].url); } catch (e) { /* 加载失败走降级 */ }
    });
  };

  BgLayer.prototype._buildWallpaper = function (modeId) {
    var tex = this._wpTex && this._wpTex[modeId];
    var ok = tex && tex.baseTexture && tex.baseTexture.valid;

    if (ok) {
      var sp = new PIXI.Sprite(tex);
      sp.anchor.set(0.5);
      this._modeRoot.addChild(sp);
      this._wp = { sprite: sp, mode: modeId };
      this._layoutWallpaper();

      // 光晕波浪滤镜：亮部缓慢流动 + 呼吸（纯时间驱动，不随音频）
      try {
        var wpP = this.params[modeId];
        this._wpFilter = new PIXI.Filter(null, GLOW_WAVE_FRAG, {
          uTime: 0,
          uWave: wpP.wave == null ? 0.6 : wpP.wave,
          uGlow: wpP.glow == null ? 0.6 : wpP.glow
        });
        sp.filters = [this._wpFilter];
        this._modeFilters.push(this._wpFilter);
      } catch (e) {
        console.warn('[BgLayer] 光晕滤镜创建失败，退回静态壁纸：' + e.message);
        this._wpFilter = null;
      }

      // 中心微压暗：让中心星从壁纸上「跳出来」（极淡的径向暗晕）
      var veil = new PIXI.Sprite(radialTexture(0x000000, 512));
      veil.anchor.set(0.5);
      veil.width = veil.height = Math.max(this.w, this.h) * 1.15;
      veil.x = this.w / 2;
      veil.y = this.h / 2;
      veil.alpha = 0.34;
      this._modeRoot.addChild(veil);
    } else {
      // 降级：图片缺失或未加载完 → 冷色光斑缓慢漂移
      this._wpGrads = [];
      var cols = [this.cosmic.gas, this.cosmic.deep, this.cosmic.violet];
      for (var i = 0; i < 4; i++) {
        var gs = new PIXI.Sprite(radialTexture(cols[i % cols.length], 256));
        gs.anchor.set(0.5);
        gs.blendMode = PIXI.BLEND_MODES.ADD;
        var size = Math.max(this.w, this.h) * (0.8 + i * 0.22);
        gs.width = size;
        gs.height = size;
        gs.alpha = 0.1;
        gs.x = this.w * (0.22 + (i % 3) * 0.28);
        gs.y = this.h * (0.3 + Math.floor(i / 3) * 0.35);
        this._modeRoot.addChild(gs);
        this._wpGrads.push({ sprite: gs, ph: i * 1.7, cx: gs.x, cy: gs.y });
      }
    }

    this._addDimVeil(this.params[modeId].dim);
  };

  // cover 铺满 + 漂移余量（放大 8%，四周留出缓慢平移的空间）
  BgLayer.prototype._layoutWallpaper = function () {
    var wp = this._wp;
    if (!wp) return;
    var tex = wp.sprite.texture;
    var tw = tex.width || 1920;
    var th = tex.height || 1080;
    wp.baseScale = Math.max(this.w / tw, this.h / th) * 1.08;
  };

  // 壁纸只做两件事：极慢漂移 + 极慢呼吸变焦，与音频完全解耦
  BgLayer.prototype._tickWallpaper = function () {
    var p = this.params[this.mode] || {};
    var t = this._time * 0.001;
    var wp = this._wp;

    if (wp) {
      if (!wp.sprite.texture.baseTexture.valid) return; // 纹理未就绪
      if (!wp.baseScale) this._layoutWallpaper();
      var drift = p.drift == null ? 0.8 : p.drift;
      var breath = p.breath == null ? 0.4 : p.breath;
      var w = this.w, h = this.h;
      // 漂移：约 2 分钟一个来回的正弦平移，幅度极小
      wp.sprite.x = w / 2 + Math.sin(t * 0.052) * w * 0.018 * drift;
      wp.sprite.y = h / 2 + Math.cos(t * 0.041) * h * 0.014 * drift;
      // 呼吸：极缓慢变焦 1.0 ~ +3%
      var zoom = 1 + breath * 0.03 * (0.5 + 0.5 * Math.sin(t * 0.033));
      wp.sprite.scale.set(wp.baseScale * zoom);

      // 光晕波浪：行波推进 + 亮度呼吸
      if (this._wpFilter) {
        var u = this._wpFilter.uniforms;
        u.uTime = t;
        u.uWave = p.wave == null ? 0.6 : p.wave;
        u.uGlow = p.glow == null ? 0.6 : p.glow;
      }
    } else if (this._wpGrads) {
      for (var i = 0; i < this._wpGrads.length; i++) {
        var g = this._wpGrads[i];
        g.sprite.x = g.cx + Math.sin(t * 0.05 + g.ph) * this.w * 0.04;
        g.sprite.y = g.cy + Math.cos(t * 0.04 + g.ph) * this.h * 0.03;
      }
    }
  };

  /* ============================================================
   * M6 星海共振系列（sv0–sv7）：stellarResonance 引擎 → CanvasTexture
   * 引擎画进离屏 canvas，本层把它作为纹理放进模式根容器 ——
   * 不插入 DOM、不遮挡 PIXI，切换/销毁/resize 与其他模式完全一致。
   * ============================================================ */

  BgLayer.prototype._stellarClock = function () {
    return (global.performance && global.performance.now)
      ? global.performance.now() / 1000 : Date.now() / 1000;
  };

  BgLayer.prototype._buildStellar = function (variant) {
    if (!global.StellarResonance) return;
    var eng = global.StellarResonance.create(variant, this.w, this.h, this._stellarClock());
    eng.setPerfMode(this.perf);
    eng.setReducedMotion(this._stellarReduced);
    eng.setCenterZone(this._centerReserved());
    this._stellar = eng;
    this._stellarTex = PIXI.Texture.from(eng.canvas);
    var sp = new PIXI.Sprite(this._stellarTex);
    sp.width = this.w;
    sp.height = this.h;
    sp.interactive = false;
    if (this._modeRoot) this._modeRoot.addChild(sp);
  };

  /** 中心特效开着（非「关闭」）时，星海背景让出中心区 */
  BgLayer.prototype._centerReserved = function () {
    if (!this._getCenterMode) return true;
    return this._getCenterMode() !== 'none';
  };

  BgLayer.prototype._tickStellar = function (dt) {
    if (!this._stellar || !this._stellarTex) return;
    this._stellar.setCenterZone(this._centerReserved()); // 中心模式运行中切换也能即时生效
    var redrawn = this._stellar.renderFrame(dt, this._stellarClock());
    if (redrawn) this._stellarTex.update(); // 只有真重画才上传，reduced 静态帧零开销
  };

  /** 演奏事件转发：当前模式是星海共振时触发引擎脉冲 */
  BgLayer.prototype.tapFx = function (x, y, note) {
    if (this._stellar) this._stellar.hit(x, y, note | 0);
  };

  /** 换歌时重置波源与余晖 */
  BgLayer.prototype.resetFx = function () {
    if (this._stellar) this._stellar.reset();
  };

  /* ============================================================
   * M5 穿梭：向镜头飞来的星海（速度线）
   * ============================================================ */

  BgLayer.prototype._buildWarp = function () {
    this._gWarp = new PIXI.Graphics();
    this._modeRoot.addChild(this._gWarp);
    this._makeWarpStars();
  };

  BgLayer.prototype._makeWarpStars = function () {
    var n = Math.round(this.params.warp.density * (this.perf ? 0.6 : 1));
    var arr = [];
    for (var i = 0; i < n; i++) {
      arr.push({
        x: (Math.random() - 0.5) * 2,
        y: (Math.random() - 0.5) * 2,
        z: 0.05 + Math.random() * 0.95,
        ci: Math.floor(Math.random() * this.palette.length),
        accent: Math.random() > 0.88
      });
    }
    this._warpStars = arr;
  };

  BgLayer.prototype._tickWarp = function (dt) {
    var g = this._gWarp;
    if (!g) return;
    var p = this.params.warp;
    var s = this._smooth;
    var w = this.w, h = this.h;
    var cx = w / 2, cy = h / 2;
    var scale = Math.min(w, h) * 0.55;
    var speed = p.speed * (1 + s.bass * 0.9);

    g.clear();
    for (var i = 0; i < this._warpStars.length; i++) {
      var st = this._warpStars[i];
      st.z -= 0.006 * dt * speed;
      if (st.z <= 0.03) {
        st.z = 1;
        st.x = (Math.random() - 0.5) * 2;
        st.y = (Math.random() - 0.5) * 2;
      }
      var sx = cx + (st.x / st.z) * scale;
      var sy = cy + (st.y / st.z) * scale;
      if (sx < -60 || sx > w + 60 || sy < -60 || sy > h + 60) continue;

      // 拖尾：用 z 更远处的同一颗星作为尾端，速度越快尾巴越长
      var zTail = st.z + 0.04 + p.streak * 0.18;
      var tx = cx + (st.x / zTail) * scale;
      var ty = cy + (st.y / zTail) * scale;

      var color = st.accent ? this.colors.accent : this.palette[st.ci];
      var a = clamp((1 - st.z) * 0.95, 0.08, 0.9);
      g.lineStyle(0.6 + (1 - st.z) * 2.2 * p.glow, color, a);
      g.moveTo(tx, ty);
      g.lineTo(sx, sy);
      g.lineStyle(0);
      g.beginFill(color, a);
      g.drawCircle(sx, sy, 0.5 + (1 - st.z) * 1.8 * (0.4 + p.glow));
      g.endFill();
    }
  };

  /* ============================================================
   * 主循环
   * ============================================================ */

  BgLayer.prototype.tick = function (dt, spectrumData) {
    if (!this._ready) return;

    // 频谱源：传入 → window.__djFx → audioEngine；全缺失按静默处理
    var data = spectrumData;
    if (!data) {
      if (global.__djFx && typeof global.__djFx.getSpectrumData === 'function') {
        data = global.__djFx.getSpectrumData();
      } else if (global.__audioEngine && typeof global.__audioEngine.getSpectrumData === 'function') {
        data = global.__audioEngine.getSpectrumData();
      }
    }
    this._time += dt * 16.667;

    var bass = ech(data, 0, 11);
    var lowMid = ech(data, 11, 22);
    var mid = ech(data, 22, 45);
    var vocal = ech(data, 45, 70);
    var treble = ech(data, 70, 100);
    var power = Math.pow(bass * 0.22 + lowMid * 0.18 + mid * 0.22 + vocal * 0.28 + treble * 0.1, 0.55);

    // 一阶平滑：避免逐帧跳变（帧率无关）
    var k = 1 - Math.pow(0.86, dt);
    var s = this._smooth;
    s.bass += (boost(bass) - s.bass) * k;
    s.lowMid += (boost(lowMid) - s.lowMid) * k;
    s.mid += (boost(mid) - s.mid) * k;
    s.vocal += (boost(vocal) - s.vocal) * k;
    s.treble += (boost(treble) - s.treble) * k;
    s.power += (clamp(power, 0, 1) - s.power) * k;

    // 模式切换 crossfade：新层淡入、旧层淡出（旧层销毁前先摘滤镜）
    var dts = Math.min(dt / 60, 0.05);
    if (this._modeRoot && this._modeRoot.alpha < 1) {
      this._modeRoot.alpha = Math.min(1, this._modeRoot.alpha + dts / this._fadeDur);
    }
    for (var fi = this._fading.length - 1; fi >= 0; fi--) {
      var fade = this._fading[fi];
      fade.alpha -= dts / this._fadeDur;
      if (fade.alpha <= 0) {
        this._destroyModeRoot(fade.root, fade.filters, fade.onGone);
        this._fading.splice(fi, 1);
      } else {
        fade.root.alpha = fade.alpha;
      }
    }

    switch (this.mode) {
      case 'common': this._tickCommon(dt); break;
      case 'nebula':
      case 'aurora': this._tickWallpaper(); break;
      case 'warp': this._tickWarp(dt); break;
      default:
        if (MODE_META[this.mode] && MODE_META[this.mode].variant !== undefined) {
          this._tickStellar(dt);
        }
        break;
    }
  };

  /**
   * 后处理滤镜（M5 商籁/凝彩那类整体滤镜不在本背景系统内）。
   * 保留接口：main.js 用它把滤镜合成到 stage.filters。
   */
  BgLayer.prototype.getPostFilters = function () {
    return [];
  };

  /* ============================================================
   * 静态元数据
   * ============================================================ */

  BgLayer.modes = function () {
    return MODE_ORDER.map(function (id) {
      return { id: id, name: MODE_META[id].name };
    });
  };

  BgLayer.paramSchema = function (modeId) {
    var meta = MODE_META[modeId];
    if (!meta) return [];
    return meta.params.map(function (s) { return s; });
  };

  BgLayer.defaultMode = 'common';

  global.BgLayer = BgLayer;
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * bgLayer.js — 星海共振 · 背景系统（参考 folia-major 的背景语言重做）
 * ====================================================================
 * 6 种背景，均位于渲染树最底层，不拦截任何输入：
 *
 *   common  通用   模糊封面 + 主题渐变叠色 + 15 个几何图形漂浮 + 上升微粒 + 暗角
 *   latent  隐现   封面取色 MeshGradient 流体 + 4x4 抖动像素层，随音频起伏（可单层/混合）
 *   monet   莫奈   封面/自定义图铺满，全屏叠色或半屏渐变，模糊 + 偏移 + 漂移 + 水洗
 *   nomand  漫游   封面/自定义图加 Paper 纸感：像素化 / 网点 / 纸纹
 *   sora    空     一片缓缓横移的星空，最干净的画面
 *   url     嵌入   把任意网页作为背景（iframe 置于 canvas 之下）
 *
 * 依赖：PIXI v6（本地 vendor）。纹理全部程序化生成，断网可用。
 *
 * 接口：
 *   var bg = new BgLayer();
 *   bg.init({ stage, renderer, container, themeId }, { getTheme });
 *   bg.setMode('common'); bg.setParam('common', 'shapes', 18);
 *   bg.retheme('nebula'); bg.setCustomTheme(themeObj);
 *   bg.setCover(coverUrl);            // 歌曲封面（通用/莫奈/漫游 取图，隐现取色）
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

  function verticalFadeTexture(color, w, h) {
    var key = 'vf' + color + '_' + w + 'x' + h;
    return cacheTex(key, function () {
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var ctx = cv.getContext('2d');
      var g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, rgbaCss(color, 1));
      g.addColorStop(0.5, rgbaCss(color, 0.6));
      g.addColorStop(1, rgbaCss(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
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
   * 三、着色器
   * ============================================================ */

  // 隐现·流体层：6 色 mesh gradient（域扭曲 + 旋涡）
  var MESH_FRAG = [
    'precision mediump float;',
    'varying vec2 vTextureCoord;',
    'uniform float uTime;',
    'uniform float uSpeed;',
    'uniform float uDistortion;',
    'uniform float uSwirl;',
    'uniform vec3 uC0;',
    'uniform vec3 uC1;',
    'uniform vec3 uC2;',
    'uniform vec3 uC3;',
    'uniform vec3 uC4;',
    'uniform vec3 uC5;',
    'vec2 warp(vec2 p, float t) {',
    '  float n = sin(p.x * 3.1 + t * 0.72) * sin(p.y * 2.7 - t * 0.51);',
    '  p += vec2(n * 0.055, n * 0.045) * uDistortion;',
    '  p += 0.03 * uSwirl * vec2(sin(p.y * 4.2 + t * 1.1), cos(p.x * 4.2 - t * 0.9));',
    '  return p;',
    '}',
    'void main(void) {',
    '  float t = uTime * uSpeed;',
    '  vec2 uv = warp(vTextureCoord, t);',
    '  vec3 acc = vec3(0.0);',
    '  float wsum = 0.0;',
    '  vec2 c0 = vec2(0.50 + 0.38 * sin(t * 0.33 + 0.0), 0.50 + 0.34 * cos(t * 0.27 + 1.1));',
    '  vec2 c1 = vec2(0.50 + 0.40 * sin(t * 0.29 + 2.1), 0.50 + 0.36 * cos(t * 0.31 + 3.4));',
    '  vec2 c2 = vec2(0.50 + 0.36 * sin(t * 0.37 + 4.2), 0.50 + 0.40 * cos(t * 0.23 + 5.0));',
    '  vec2 c3 = vec2(0.50 + 0.42 * sin(t * 0.25 + 1.4), 0.50 + 0.32 * cos(t * 0.35 + 2.6));',
    '  vec2 c4 = vec2(0.50 + 0.34 * sin(t * 0.41 + 3.1), 0.50 + 0.38 * cos(t * 0.28 + 4.4));',
    '  vec2 c5 = vec2(0.50 + 0.38 * sin(t * 0.31 + 5.6), 0.50 + 0.36 * cos(t * 0.39 + 0.7));',
    '  float w0 = 1.0 / (dot(uv - c0, uv - c0) + 0.05); acc += uC0 * w0; wsum += w0;',
    '  float w1 = 1.0 / (dot(uv - c1, uv - c1) + 0.05); acc += uC1 * w1; wsum += w1;',
    '  float w2 = 1.0 / (dot(uv - c2, uv - c2) + 0.05); acc += uC2 * w2; wsum += w2;',
    '  float w3 = 1.0 / (dot(uv - c3, uv - c3) + 0.05); acc += uC3 * w3; wsum += w3;',
    '  float w4 = 1.0 / (dot(uv - c4, uv - c4) + 0.05); acc += uC4 * w4; wsum += w4;',
    '  float w5 = 1.0 / (dot(uv - c5, uv - c5) + 0.05); acc += uC5 * w5; wsum += w5;',
    '  vec3 col = acc / wsum;',
    '  float vig = smoothstep(1.35, 0.15, length(vTextureCoord - 0.5) * 1.6);',
    '  gl_FragColor = vec4(col * (0.72 + 0.28 * vig), 1.0);',
    '}'
  ].join('\n');

  // 隐现·像素层：4x4 有序抖动 + warp 形状
  var DITHER_FRAG = [
    'precision mediump float;',
    'varying vec2 vTextureCoord;',
    'uniform float uTime;',
    'uniform float uSpeed;',
    'uniform float uSize;',
    'uniform vec3 uBack;',
    'uniform vec3 uFront;',
    'float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }',
    'float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }',
    'void main(void) {',
    '  float t = uTime * uSpeed;',
    '  vec2 p = vTextureCoord * 3.0;',
    '  float f = 0.5 + 0.30 * sin(p.x * 2.2 + t * 0.9) * sin(p.y * 1.8 - t * 0.7)',
    '              + 0.16 * sin((p.x + p.y) * 3.4 + t * 1.3);',
    '  float d = bayer4(gl_FragCoord.xy / max(uSize, 1.0));',
    '  float v = step(d, clamp(f, 0.0, 1.0));',
    '  gl_FragColor = vec4(mix(uBack, uFront, v), 1.0);',
    '}'
  ].join('\n');

  // 漫游·像素化：3 色阶有序抖动
  var IMG_DITHER_FRAG = [
    'precision mediump float;',
    'varying vec2 vTextureCoord;',
    'uniform sampler2D uSampler;',
    'uniform float uSize;',
    'uniform vec3 uBack;',
    'uniform vec3 uFront;',
    'uniform vec3 uHigh;',
    'uniform float uMix;',
    'uniform float uContrast;',
    'float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }',
    'float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }',
    'void main(void) {',
    '  vec4 src = texture2D(uSampler, vTextureCoord);',
    '  float lum = dot(src.rgb, vec3(0.299, 0.587, 0.114));',
    '  lum = clamp((lum - 0.5) * (1.0 + uContrast) + 0.5, 0.0, 1.0);',
    '  float d = bayer4(gl_FragCoord.xy / max(uSize, 1.0)) - 0.5;',
    '  float q = clamp(lum + d * 0.42, 0.0, 1.0);',
    '  vec3 col = q < 0.5 ? mix(uBack, uFront, q * 2.0) : mix(uFront, uHigh, (q - 0.5) * 2.0);',
    '  col = mix(col, src.rgb, uMix);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  // 漫游·网点：六边形 halftone
  var HALFTONE_FRAG = [
    'precision mediump float;',
    'varying vec2 vTextureCoord;',
    'uniform sampler2D uSampler;',
    'uniform float uSize;',
    'uniform vec3 uBack;',
    'uniform vec3 uFront;',
    'uniform float uContrast;',
    'void main(void) {',
    '  vec4 src = texture2D(uSampler, vTextureCoord);',
    '  float lum = dot(src.rgb, vec3(0.299, 0.587, 0.114));',
    '  lum = clamp((lum - 0.5) * (1.0 + uContrast) + 0.5, 0.0, 1.0);',
    '  float s = max(uSize, 2.0);',
    '  vec2 p = gl_FragCoord.xy / s;',
    '  p.y += mod(floor(p.x), 2.0) * 0.5;',
    '  vec2 cell = fract(p) - 0.5;',
    '  float dist = length(cell) * s;',
    '  float r = (1.0 - lum) * s * 0.62;',
    '  float a = smoothstep(r + 1.2, r - 1.2, dist);',
    '  gl_FragColor = vec4(mix(uBack, uFront, a), 1.0);',
    '}'
  ].join('\n');

  // 漫游·纸感：对比 + 纸纤维 + 颗粒
  var PAPER_FRAG = [
    'precision mediump float;',
    'varying vec2 vTextureCoord;',
    'uniform sampler2D uSampler;',
    'uniform vec3 uBack;',
    'uniform vec3 uFront;',
    'uniform float uContrast;',
    'uniform float uRough;',
    'uniform float uMix;',
    'float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'void main(void) {',
    '  vec4 src = texture2D(uSampler, vTextureCoord);',
    '  float lum = dot(src.rgb, vec3(0.299, 0.587, 0.114));',
    '  lum = clamp((lum - 0.5) * (1.0 + uContrast) + 0.5, 0.0, 1.0);',
    '  vec2 px = gl_FragCoord.xy;',
    '  float fiber = hash(floor(px * vec2(0.85, 0.06))) * 0.5 + hash(floor(px * vec2(0.06, 0.85))) * 0.5;',
    '  float grain = hash(px * 0.71) - 0.5;',
    '  float tex = (fiber - 0.5) * uRough + grain * 0.14 * uRough;',
    '  vec3 col = mix(uBack, uFront, clamp(lum + tex, 0.0, 1.0));',
    '  col = mix(col, src.rgb, uMix);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /**
   * 着色器编译探测：临时 WebGL 上下文编译+链接，失败返回 false。
   * 避免把错误 shader 交给 PIXI 后在渲染阶段刷 console error。
   */
  function probeShader(fragSrc) {
    var cv = null, gl = null;
    try {
      cv = document.createElement('canvas');
      cv.width = cv.height = 4;
      gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
      if (!gl) return false;
      var vsSrc = [
        'attribute vec2 aPosition;',
        'varying vec2 vTextureCoord;',
        'void main(void) {',
        '  vTextureCoord = aPosition * 0.5 + 0.5;',
        '  gl_Position = vec4(aPosition, 0.0, 1.0);',
        '}'
      ].join('\n');
      var vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, vsSrc);
      gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) return false;
      var fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fragSrc);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        console.warn('[BgLayer] 片元着色器编译失败，降级：' + gl.getShaderInfoLog(fs));
        return false;
      }
      var prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      var ok = !!gl.getProgramParameter(prog, gl.LINK_STATUS);
      if (!ok) console.warn('[BgLayer] 着色器链接失败，降级');
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return ok;
    } catch (e) {
      console.warn('[BgLayer] 着色器探测异常，降级：' + e.message);
      return false;
    } finally {
      try {
        var lose = gl && gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch (e2) { /* 忽略 */ }
      cv = gl = null;
    }
  }

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
    latent: {
      name: '隐现',
      params: [
        { key: 'display', label: '图层', min: 0, max: 2, step: 1, def: 0 },
        { key: 'meshSpeed', label: '流速', min: 0, max: 2, step: 0.05, def: 0.55 },
        { key: 'distortion', label: '失真', min: 0, max: 1.5, step: 0.05, def: 0.6 },
        { key: 'swirl', label: '旋涡', min: 0, max: 1.5, step: 0.05, def: 0.5 },
        { key: 'ditherSize', label: '像素', min: 1, max: 8, step: 0.2, def: 2.4 },
        { key: 'ditherAlpha', label: '像素透明', min: 0, max: 1, step: 0.05, def: 0.55 },
        { key: 'dim', label: '压暗', min: 0, max: 0.85, step: 0.05, def: 0.3 }
      ]
    },
    monet: {
      name: '莫奈',
      params: [
        { key: 'layout', label: '布局', min: 0, max: 1, step: 1, def: 0 },
        { key: 'offset', label: '偏移', min: -50, max: 50, step: 1, def: 0 },
        { key: 'blur', label: '模糊', min: 0, max: 20, step: 1, def: 8 },
        { key: 'tint', label: '叠色', min: 0, max: 0.8, step: 0.05, def: 0.35 },
        { key: 'wash', label: '水洗', type: 'color', def: '' },
        { key: 'drift', label: '漂移', min: 0, max: 1, step: 0.05, def: 0.3 },
        { key: 'dim', label: '压暗', min: 0, max: 0.85, step: 0.05, def: 0.5 }
      ]
    },
    nomand: {
      name: '漫游',
      params: [
        { key: 'effect', label: '效果', min: 0, max: 2, step: 1, def: 0 },
        { key: 'size', label: '颗粒', min: 1, max: 12, step: 0.5, def: 3 },
        { key: 'mix', label: '原色', min: 0, max: 1, step: 0.05, def: 0.18 },
        { key: 'contrast', label: '对比', min: 0, max: 2, step: 0.05, def: 0.4 },
        { key: 'rough', label: '纸纹', min: 0, max: 1, step: 0.05, def: 0.45 },
        { key: 'dim', label: '压暗', min: 0, max: 0.85, step: 0.05, def: 0.35 }
      ]
    },
    sora: {
      name: '空',
      params: [
        { key: 'density', label: '密度', min: 40, max: 300, step: 10, def: 150 },
        { key: 'speed', label: '漂移', min: 0.2, max: 2, step: 0.05, def: 1 },
        { key: 'size', label: '大小', min: 0.5, max: 2, step: 0.05, def: 1 },
        { key: 'glow', label: '辉光', min: 0, max: 1, step: 0.05, def: 0.55 }
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
    }
  };

  var MODE_ORDER = ['common', 'latent', 'monet', 'nomand', 'sora', 'warp'];

  /* ============================================================
   * 五、图形工具（几何漂浮）
   * ============================================================ */

  var SHAPE_POINTS = {
    square: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]],
    triangle: [[0, -0.55], [0.5, 0.45], [-0.5, 0.45]],
    cross: [
      [-0.3, -0.5], [-0.5, -0.3], [-0.2, 0], [-0.5, 0.3], [-0.3, 0.5], [0, 0.2],
      [0.3, 0.5], [0.5, 0.3], [0.2, 0], [0.5, -0.3], [0.3, -0.5], [0, -0.2]
    ]
  };

  function rotatedPoints(cx, cy, pts, size, rot) {
    var cos = Math.cos(rot), sin = Math.sin(rot);
    var out = new Array(pts.length * 2);
    for (var i = 0; i < pts.length; i++) {
      var x = pts[i][0] * size, y = pts[i][1] * size;
      out[i * 2] = cx + x * cos - y * sin;
      out[i * 2 + 1] = cy + x * sin + y * cos;
    }
    return out;
  }

  /* ============================================================
   * 六、BgLayer
   * ============================================================ */

  function BgLayer() {
    this.mode = 'common';
    this.perf = false;
    this.theme = null;
    this.palette = [0x00f0ff, 0xff00aa, 0x7fff00, 0xffcc00, 0x9b59ff, 0xff6b35];
    this.colors = { bg: 0x0a0420, primary: 0x00f0ff, secondary: 0xff00aa, accent: 0x00f0ff };
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
    this._bands = { bass: 0, lowMid: 0, mid: 0, vocal: 0, treble: 0, power: 0 };
    this._smooth = { bass: 0, lowMid: 0, mid: 0, vocal: 0, treble: 0, power: 0 };
    this.onPostFiltersChange = null;

    this._shaderOk = { mesh: false, dither: false, imgDither: false, halftone: false, paper: false };
  }

  /* ---------------- 生命周期 ---------------- */

  BgLayer.prototype.init = function (app, themesModule) {
    var self = this;
    this.app = app || {};
    this.themes = themesModule || { getTheme: global.getTheme };
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

    // 着色器探测
    this._shaderOk.mesh = probeShader(MESH_FRAG);
    this._shaderOk.dither = probeShader(DITHER_FRAG);
    this._shaderOk.imgDither = probeShader(IMG_DITHER_FRAG);
    this._shaderOk.halftone = probeShader(HALFTONE_FRAG);
    this._shaderOk.paper = probeShader(PAPER_FRAG);

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
    if (this._ready && this.container) this.setMode(this.mode);
  };

  BgLayer.prototype.retheme = function (themeId) {
    var t = this.themes && this.themes.getTheme ? this.themes.getTheme(themeId) : null;
    if (t) this._applyTheme(t, themeId);
  };

  BgLayer.prototype.setCustomTheme = function (themeObj) {
    if (themeObj) this._applyTheme(themeObj, 'custom');
  };

  // 封面：通用 / 莫奈 / 漫游 取图，隐现取色（配色由 setCustomTheme 提供）
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
      if (self._ready && (self.mode === 'monet' || self.mode === 'nomand')) {
        self.setMode(self.mode);
      }
    };
    img.onerror = function () {
      // CORS 或网络问题：保持当前兜底渐变
    };
    img.src = url;
  };

  /* ---------------- 模式切换 ---------------- */

  BgLayer.prototype.setMode = function (modeId) {
    if (!MODE_META[modeId]) modeId = 'common';
    this.mode = modeId;
    if (!this._ready || !this.container) return;
    this._teardownMode();
    this._modeRoot = new PIXI.Container();
    this._modeRoot.interactive = false;
    this._modeRoot.interactiveChildren = false;
    this.container.addChild(this._modeRoot);

    switch (modeId) {
      case 'common': this._buildCommon(); break;
      case 'latent': this._buildLatent(); break;
      case 'monet': this._buildMonet(); break;
      case 'nomand': this._buildNomand(); break;
      case 'sora': this._buildSora(); break;
      case 'warp': this._buildWarp(); break;
    }
    this._notifyPost();
  };

  BgLayer.prototype._teardownMode = function () {
    // 先摘掉滤镜引用，再销毁，避免渲染系统仍持有已销毁滤镜（uniforms 已为 null）
    if (this._meshSprite) this._meshSprite.filters = null;
    if (this._latentMesh) this._latentMesh.sprite.filters = null;
    if (this._commonMesh) this._commonMesh.sprite.filters = null;
    if (this._ditherSprite) this._ditherSprite.filters = null;
    if (this._monetBase) this._monetBase.filters = null;
    if (this._nomandSprite) this._nomandSprite.filters = null;

    if (this._modeRoot) {
      this._modeRoot.removeChildren();
      this._modeRoot.destroy({ children: true, texture: false, baseTexture: false });
      this._modeRoot = null;
    }
    for (var i = 0; i < this._modeFilters.length; i++) {
      try { this._modeFilters[i].destroy(); } catch (e) { /* 忽略 */ }
    }
    this._modeFilters = [];
    this._gShapes = null;
    this._gParticles = null;
    this._dimVeil = null;
    this._shapeData = null;
    this._particleData = null;
    this._backdrop = null;
    this._commonMesh = null;
    this._commonGlow = null;
    this._commonRoot = null;
    this._commonGlows = null;
    this._backdropTexture = null;
    this._gradSprite = null;
    this._vigSprite = null;
    this._meshSprite = null;
    this._meshFilter = null;
    this._latentMesh = null;
    this._ditherSprite = null;
    this._ditherFilter = null;
    this._fallbackGrads = null;
    this._monetBase = null;
    this._monetBlur = null;
    this._monetTint = null;
    this._monetFade = null;
    this._nomandSprite = null;
    this._nomandFilter = null;
    this._soraStars = null;
    this._soraRoot = null;
    this._gWarp = null;
    this._warpStars = null;
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
    } else if (modeId === 'latent') {
      this.setMode('latent');
    } else if (modeId === 'monet') {
      this._applyMonetLayout();
      this._applyMonetTint();
      if (key === 'blur') this._applyMonetBlur();
    } else if (modeId === 'nomand') {
      this._applyNomandUniforms();
    } else if (modeId === 'sora') {
      if (key === 'density') this._buildSoraStars();
      else this._applySoraSize();
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
    if (this.mode === 'common' || this.mode === 'monet' || this.mode === 'nomand') this.setMode(this.mode);
    else if (this.mode === 'latent') this._resizeFullscreen();
  };

  /* ============================================================
   * M1 通用：模糊封面 + 渐变叠色 + 几何漂浮
   * ============================================================ */

  // 通用/隐现共用的流体层（6 色 mesh gradient）
  BgLayer.prototype._createMeshLayer = function (speed, distortion, swirl, alpha) {
    if (!this._shaderOk.mesh || this.perf) return null;
    var sprite = new PIXI.Sprite(PIXI.Texture.WHITE);
    sprite.width = this.w;
    sprite.height = this.h;
    sprite.blendMode = PIXI.BLEND_MODES.SCREEN;
    sprite.alpha = alpha == null ? 1 : alpha;
    var filter = null;
    try {
      filter = new PIXI.Filter(null, MESH_FRAG, {
        uTime: 0,
        uSpeed: speed,
        uDistortion: distortion,
        uSwirl: swirl,
        uC0: toUniform(this.palette[0]),
        uC1: toUniform(this.palette[1]),
        uC2: toUniform(this.palette[2]),
        uC3: toUniform(this.palette[3]),
        uC4: toUniform(this.palette[4]),
        uC5: toUniform(this.palette[5])
      });
      sprite.filters = [filter];
      this._modeFilters.push(filter);
    } catch (e) {
      console.warn('[BgLayer] 流体 shader 创建失败，降级为渐变光斑：' + e.message);
      try { sprite.destroy(); } catch (e2) { /* 忽略 */ }
      return null;
    }
    this._modeRoot.addChild(sprite);
    return { sprite: sprite, filter: filter, speed: speed, distortion: distortion, swirl: swirl };
  };

  BgLayer.prototype._buildCommon = function () {
    // 纯色主题背景 + 星云辉光；星星由全局 ParallaxStarfield 统一绘制
    this._commonRoot = new PIXI.Container();
    this._modeRoot.addChild(this._commonRoot);

    // 星云底光：主题色径向光斑，缓慢漂移
    this._commonGlows = [];
    for (var gi = 0; gi < 3; gi++) {
      var gs = new PIXI.Sprite(radialTexture(this.palette[gi], 256));
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

  // 模糊封面 + 主题渐变叠色（与 folia 的 drawCover 同构，纯 Canvas2D 合成）
  BgLayer.prototype._buildBackdropTexture = function () {
    if (this._backdropTexture) {
      try { this._backdropTexture.destroy(true); } catch (e) { /* 忽略 */ }
      this._backdropTexture = null;
    }
    var cw = 360;
    var ch = Math.max(1, Math.round(cw * this.h / Math.max(1, this.w)));
    var cv = document.createElement('canvas');
    cv.width = cw;
    cv.height = ch;
    var ctx = cv.getContext('2d');
    var p = this.params.common;

    ctx.fillStyle = cssHex(this.colors.bg);
    ctx.fillRect(0, 0, cw, ch);

    var img = this._coverImage;
    if (img && img.width) {
      // object-cover + 放大 1.5 倍 + 模糊（与 folia 的封面处理一致）
      var scale = Math.max(cw / img.width, ch / img.height) * 1.5;
      var dw = img.width * scale;
      var dh = img.height * scale;
      var blurPx = p.blur * (cw / Math.max(1, this.w)) * 1.5;
      try { ctx.filter = 'blur(' + Math.max(0, blurPx).toFixed(2) + 'px)'; } catch (e) { /* 不支持则忽略 */ }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
      ctx.filter = 'none';
    } else {
      // 无封面：主题色径向渐变兜底
      var g0 = ctx.createRadialGradient(cw * 0.3, ch * 0.32, 0, cw * 0.3, ch * 0.32, cw * 0.75);
      g0.addColorStop(0, rgbaCss(this.colors.primary, 0.5));
      g0.addColorStop(1, rgbaCss(this.colors.primary, 0));
      ctx.fillStyle = g0;
      ctx.fillRect(0, 0, cw, ch);
      var g1 = ctx.createRadialGradient(cw * 0.76, ch * 0.68, 0, cw * 0.76, ch * 0.68, cw * 0.7);
      g1.addColorStop(0, rgbaCss(this.colors.secondary, 0.42));
      g1.addColorStop(1, rgbaCss(this.colors.secondary, 0));
      ctx.fillStyle = g1;
      ctx.fillRect(0, 0, cw, ch);
    }

    // 主色 → 透明 → 副色：soft-light 轻叠，避免 overlay 把画面推成一片土色
    var diagonal = Math.hypot(cw, ch);
    var half = (cw * ch) / diagonal;
    var dx = (ch / diagonal) * half;
    var dy = (cw / diagonal) * half;
    var grad = ctx.createLinearGradient(cw / 2 - dx, ch / 2 - dy, cw / 2 + dx, ch / 2 + dy);
    grad.addColorStop(0, cssHex(this.colors.primary));
    grad.addColorStop(0.5, rgbaCss(this.colors.primary, 0));
    grad.addColorStop(0.5, rgbaCss(this.colors.secondary, 0));
    grad.addColorStop(1, cssHex(this.colors.secondary));
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cw, ch);
    // 再压一层灰，让照片只作底衬（流体层会盖在上面）
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    ctx.globalAlpha = 1;

    try {
      this._backdropTexture = PIXI.Texture.from(cv);
    } catch (e) {
      console.warn('[BgLayer] 封面底图纹理创建失败（可能跨域受限），改用主题渐变：' + e.message);
      this._backdropTexture = gradientTexture(this.palette, 512);
    }
    return this._backdropTexture;
  };

  BgLayer.prototype._invalidateBackdrop = function () {
    if (this.mode !== 'common' || !this._backdrop) return;
    var tex = this._buildBackdropTexture();
    this._backdrop.texture = tex;
    this._backdrop.width = this.w;
    this._backdrop.height = this.h;
  };

  // 统一压暗层：把图片类背景压到不抢前景的程度（0 = 不压）
  BgLayer.prototype._addDimVeil = function (alpha) {
    this._dimVeil = new PIXI.Graphics();
    this._dimVeil.beginFill(0x000000, 1).drawRect(0, 0, this.w, this.h).endFill();
    this._dimVeil.alpha = clamp(alpha || 0, 0, 1);
    this._modeRoot.addChild(this._dimVeil);
  };

  BgLayer.prototype._buildCommonGeometry = function () {
    if (this._gShapes) { this._gShapes.destroy(); this._gShapes = null; }
    if (this._gParticles) { this._gParticles.destroy(); this._gParticles = null; }
    var p = this.params.common;
    var self = this;

    this._gShapes = new PIXI.Graphics();
    this._modeRoot.addChild(this._gShapes);
    this._gParticles = new PIXI.Graphics();
    this._modeRoot.addChild(this._gParticles);

    var types = ['circle', 'square', 'triangle', 'cross'];
    var shapes = [];
    for (var i = 0; i < Math.round(p.shapes); i++) {
      shapes.push({
        type: types[Math.floor(Math.random() * types.length)],
        x: Math.random(),
        y: Math.random(),
        size: 40 + Math.random() * 100,
        rot: Math.random() * Math.PI * 2,
        rotSpd: (Math.random() > 0.5 ? 1 : -1) * (Math.PI * 2 / (30 + Math.random() * 30)) / 60,
        dir: Math.random() > 0.5 ? 1 : -1,
        dur: 30 + Math.random() * 30,
        ph: Math.random() * Math.PI * 2,
        alpha: 0.11 + Math.random() * 0.08,
        filled: Math.random() < 0.3
      });
    }
    this._shapeData = shapes;

    var parts = [];
    for (var j = 0; j < Math.round(p.particles); j++) {
      parts.push({
        x: Math.random(),
        y: Math.random(),
        size: 1 + Math.random() * 4,
        dur: 15 + Math.random() * 20,
        ph: Math.random() * 10,
        peak: Math.random() * 0.3
      });
    }
    this._particleData = parts;
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
   * M2 隐现：MeshGradient 流体 + 抖动像素
   * ============================================================ */

  BgLayer.prototype._buildLatent = function () {
    var p = this.params.latent;
    var showMesh = p.display !== 2;
    var showDither = p.display !== 1;

    if (showMesh) {
      this._latentMesh = this._createMeshLayer(p.meshSpeed, p.distortion, p.swirl, 1);
    }

    // 降级（性能模式或 shader 不可用）：多层径向渐变光斑
    if (showMesh && !this._latentMesh) {
      this._fallbackGrads = [];
      for (var i = 0; i < 5; i++) {
        var sp = new PIXI.Sprite(radialTexture(this.palette[i % this.palette.length], 256));
        sp.anchor.set(0.5);
        sp.blendMode = PIXI.BLEND_MODES.SCREEN;
        var size = Math.max(this.w, this.h) * (0.85 + i * 0.22);
        sp.width = size;
        sp.height = size;
        sp.alpha = 0.16;
        sp.x = this.w * (0.2 + (i % 3) * 0.3);
        sp.y = this.h * (0.25 + Math.floor(i / 3) * 0.4);
        this._modeRoot.addChild(sp);
        this._fallbackGrads.push({ sprite: sp, ph: i * 1.7, cx: sp.x, cy: sp.y });
      }
    }

    if (showDither && this._shaderOk.dither && !this.perf) {
      this._ditherSprite = new PIXI.Sprite(PIXI.Texture.WHITE);
      this._ditherSprite.width = this.w;
      this._ditherSprite.height = this.h;
      this._ditherSprite.blendMode = PIXI.BLEND_MODES.SCREEN;
      this._ditherSprite.alpha = p.ditherAlpha;
      try {
        this._ditherFilter = new PIXI.Filter(null, DITHER_FRAG, {
          uTime: 0,
          uSpeed: 1,
          uSize: p.ditherSize,
          uBack: toUniform(0x000000),
          uFront: toUniform(this.palette[0])
        });
        this._ditherSprite.filters = [this._ditherFilter];
        this._modeFilters.push(this._ditherFilter);
      } catch (e) {
        console.warn('[BgLayer] 抖动 shader 创建失败，降级为颗粒纹理：' + e.message);
        this._ditherFilter = null;
      }
      this._modeRoot.addChild(this._ditherSprite);
    }

    this._addDimVeil(this.params.latent.dim);
  };

  BgLayer.prototype._resizeFullscreen = function () {
    if (this._latentMesh) { this._latentMesh.sprite.width = this.w; this._latentMesh.sprite.height = this.h; }
    if (this._commonMesh) { this._commonMesh.sprite.width = this.w; this._commonMesh.sprite.height = this.h; }
    if (this._ditherSprite) { this._ditherSprite.width = this.w; this._ditherSprite.height = this.h; }
  };

  BgLayer.prototype._tickLatent = function (dt) {
    var p = this.params.latent;
    var t = this._time * 0.001;
    var bands = this._smooth;

    if (this._latentMesh) {
      var u = this._latentMesh.filter.uniforms;
      u.uTime = t;
      u.uSpeed = p.meshSpeed;
      u.uDistortion = p.distortion + bands.power * 0.62;
      u.uSwirl = p.swirl + bands.mid * 0.38;
    } else if (this._fallbackGrads) {
      for (var i = 0; i < this._fallbackGrads.length; i++) {
        var g = this._fallbackGrads[i];
        g.sprite.x = g.cx + Math.sin(t * 0.25 + g.ph) * this.w * 0.1;
        g.sprite.y = g.cy + Math.cos(t * 0.2 + g.ph) * this.h * 0.08;
        g.sprite.alpha = 0.14 + bands.bass * 0.2;
      }
    }

    if (this._ditherFilter) {
      var d = this._ditherFilter.uniforms;
      d.uTime = t;
      d.uSpeed = 0.7 + bands.bass * 1.2;
      d.uSize = Math.max(1, p.ditherSize - bands.bass * p.ditherSize * 0.34);
      d.uFront = toUniform(this.palette[0]);
      if (this._ditherSprite) {
        this._ditherSprite.alpha = clamp(p.ditherAlpha + bands.bass * 0.25, 0, 1);
      }
    }
  };

  /* ============================================================
   * M3 莫奈：图片铺满 / 半屏渐变
   * ============================================================ */

  BgLayer.prototype._buildMonet = function () {
    var p = this.params.monet;
    var layer = new PIXI.Container();
    this._modeRoot.addChild(layer);

    var base = new PIXI.Sprite(this._coverImage ? this._coverTexture() : gradientTexture(this.palette, 512));
    base.anchor.set(0.5);
    layer.addChild(base);
    this._monetBase = base;
    this._applyMonetBlur();
    this._addDimVeil(this.params.monet.dim);

    var tint = new PIXI.Graphics();
    layer.addChild(tint);
    this._monetTint = tint;
    this._applyMonetTint();

    this._monetFade = new PIXI.Sprite();
    this._monetFade.visible = false;
    layer.addChild(this._monetFade);

    this._applyMonetLayout();
  };

  BgLayer.prototype._coverTexture = function () {
    if (!this._coverTexCache || this._coverTexCacheSrc !== this.coverUrl) {
      try {
        this._coverTexCache = PIXI.Texture.from(this._coverImage);
        this._coverTexCacheSrc = this.coverUrl;
      } catch (e) {
        console.warn('[BgLayer] 封面纹理创建失败，使用渐变兜底');
        return gradientTexture(this.palette, 512);
      }
    }
    return this._coverTexCache;
  };

  BgLayer.prototype._applyMonetBlur = function () {
    if (!this._monetBase) return;
    var p = this.params.monet;
    // 先释放上一个模糊滤镜，避免反复调参时堆积
    if (this._monetBlur) {
      var idx = this._modeFilters.indexOf(this._monetBlur);
      if (idx >= 0) this._modeFilters.splice(idx, 1);
      this._monetBase.filters = null;
      try { this._monetBlur.destroy(); } catch (e) { /* 忽略 */ }
      this._monetBlur = null;
    }
    if (p.blur > 0) {
      var blur = new PIXI.filters.BlurFilter(p.blur);
      this._monetBase.filters = [blur];
      this._modeFilters.push(blur);
      this._monetBlur = blur;
    }
  };

  BgLayer.prototype._washColor = function () {
    var w = this.params.monet.wash;
    if (typeof w === 'string' && /^#[0-9a-fA-F]{6}$/.test(w)) return parseInt(w.slice(1), 16);
    return this.colors.primary;
  };

  BgLayer.prototype._applyMonetTint = function () {
    var tint = this._monetTint;
    if (!tint) return;
    tint.clear();
    tint.beginFill(this._washColor(), 1).drawRect(0, 0, this.w, this.h).endFill();
    tint.alpha = this.params.monet.tint;
  };

  BgLayer.prototype._applyMonetLayout = function () {
    var base = this._monetBase;
    if (!base) return;
    var p = this.params.monet;
    var w = this.w, h = this.h;
    var tw = base.texture.width || 512;
    var th = base.texture.height || 512;
    var cover, centerY;

    if (p.layout < 1) {
      cover = Math.max(w / tw, h / th) * 1.25;
      centerY = h / 2;
      if (this._monetFade) this._monetFade.visible = false;
    } else {
      var regionH = h * 0.64;
      cover = Math.max(w / tw, regionH / th) * 1.15;
      centerY = h - (th * cover) / 2;
      if (this._monetFade) {
        var fadeH = Math.max(8, Math.round(h * 0.34));
        this._monetFade.texture = verticalFadeTexture(this.colors.bg, Math.max(8, Math.round(w)), fadeH);
        this._monetFade.width = w;
        this._monetFade.height = fadeH;
        this._monetFade.x = 0;
        this._monetFade.y = h - regionH - fadeH * 0.5;
        this._monetFade.visible = true;
      }
    }
    base.scale.set(cover);
    base.y = centerY;
    this._monetCenterX = w / 2;
    base.x = this._monetCenterX + (p.offset / 100) * w;
  };

  BgLayer.prototype._tickMonet = function (dt) {
    var p = this.params.monet;
    var base = this._monetBase;
    if (!base) return;
    var t = this._time * 0.001;
    var span = this.w * 0.05 * p.drift;
    base.rotation = Math.sin(t * 0.12) * 0.008;
    base.x = (this._monetCenterX || this.w / 2)
      + (p.offset / 100) * this.w
      + Math.sin(t * 0.18 * (0.4 + p.drift)) * span;
  };

  /* ============================================================
   * M4 漫游：Paper 纸感（像素化 / 网点 / 纸纹）
   * ============================================================ */

  BgLayer.prototype._buildNomand = function () {
    var tex = this._coverImage ? this._coverTexture() : gradientTexture(this.palette, 512);
    var sprite = new PIXI.Sprite(tex);
    sprite.anchor.set(0.5);
    var cover = Math.max(this.w / (tex.width || 512), this.h / (tex.height || 512)) * 1.02;
    sprite.scale.set(cover);
    sprite.x = this.w / 2;
    sprite.y = this.h / 2;
    this._modeRoot.addChild(sprite);
    this._nomandSprite = sprite;
    this._addDimVeil(this.params.nomand.dim);

    var effect = this.params.nomand.effect;
    var frag = effect === 1 ? HALFTONE_FRAG : (effect === 2 ? PAPER_FRAG : IMG_DITHER_FRAG);
    var ok = effect === 1 ? this._shaderOk.halftone : (effect === 2 ? this._shaderOk.paper : this._shaderOk.imgDither);

    if (ok && !this.perf) {
      try {
        var uniforms = {
          uSize: this.params.nomand.size,
          uBack: toUniform(this.colors.bg),
          uFront: toUniform(this.colors.primary),
          uHigh: toUniform(this.colors.accent),
          uMix: this.params.nomand.mix,
          uContrast: this.params.nomand.contrast,
          uRough: this.params.nomand.rough
        };
        this._nomandFilter = new PIXI.Filter(null, frag, uniforms);
        sprite.filters = [this._nomandFilter];
        this._modeFilters.push(this._nomandFilter);
      } catch (e) {
        console.warn('[BgLayer] 纸感 shader 创建失败，降级为原图：' + e.message);
        this._nomandFilter = null;
      }
    }
  };

  BgLayer.prototype._applyNomandUniforms = function () {
    var f = this._nomandFilter;
    if (!f) return;
    var p = this.params.nomand;
    f.uniforms.uSize = p.size;
    f.uniforms.uMix = p.mix;
    f.uniforms.uContrast = p.contrast;
    f.uniforms.uRough = p.rough;
    f.uniforms.uBack = toUniform(this.colors.bg);
    f.uniforms.uFront = toUniform(this.colors.primary);
    f.uniforms.uHigh = toUniform(this.colors.accent);
  };

  /* ============================================================
   * M5 空：缓缓横移的星空
   * ============================================================ */

  BgLayer.prototype._buildSora = function () {
    this._soraRoot = new PIXI.Container();
    this._modeRoot.addChild(this._soraRoot);
    this._soraTex = radialTexture(0xffffff, 48);
    this._buildSoraStars();
  };

  BgLayer.prototype._buildSoraStars = function () {
    var root = this._soraRoot;
    if (!root) return;
    root.removeChildren();
    this._soraStars = [];
    var n = Math.round(this.params.sora.density * (this.perf ? 0.6 : 1));
    for (var i = 0; i < n; i++) {
      var sp = new PIXI.Sprite(this._soraTex);
      sp.anchor.set(0.5);
      var accent = Math.random() > 0.9;
      sp.tint = accent ? this.colors.accent : this.palette[0];
      root.addChild(sp);
      this._soraStars.push({
        sprite: sp,
        x0: Math.random(),
        y: 0.05 + Math.random() * 0.9,
        speed: 0.008 + Math.random() * 0.024,
        sizeRand: Math.pow(Math.random(), 3.8),
        blinkSp: 1 + Math.random() * 2.5,
        ph: Math.random() * Math.PI * 2
      });
    }
    this._applySoraSize();
  };

  BgLayer.prototype._applySoraSize = function () {
    if (!this._soraStars) return;
    var k = this.params.sora.size;
    for (var i = 0; i < this._soraStars.length; i++) {
      var s = this._soraStars[i];
      var dia = (0.0012 + 0.0076 * s.sizeRand) * this.h * 2 * k;
      s.sprite.width = dia;
      s.sprite.height = dia;
    }
  };

  BgLayer.prototype._tickSora = function (dt) {
    var stars = this._soraStars;
    if (!stars) return;
    var t = this._time * 0.001;
    var w = this.w, h = this.h;
    var p = this.params.sora;
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var x = (s.x0 + t * s.speed * p.speed) % 1.1 - 0.05;
      s.sprite.x = x * w;
      s.sprite.y = (s.y + Math.sin(t * 0.3 + s.ph) * 0.004) * h;
      var blink = 0.3 + 0.7 * Math.sin(t * s.blinkSp + s.ph);
      s.sprite.alpha = clamp(blink, 0, 1) * (0.55 + p.glow * 0.45);
    }
  };

  /* ============================================================
   * M6 穿梭：向镜头飞来的星海（速度线）
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

    switch (this.mode) {
      case 'common': this._tickCommon(dt); break;
      case 'latent': this._tickLatent(dt); break;
      case 'monet': this._tickMonet(dt); break;
      case 'nomand': break;
      case 'sora': this._tickSora(dt); break;
      case 'warp': this._tickWarp(dt); break;
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

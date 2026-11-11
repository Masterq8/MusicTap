/**
 * parallaxStarfield.js — 三层闪烁星空（PIXI v6）
 * 远/中/近三层：大小、亮度、闪烁速度不同；按深度跟随鼠标视差（setOffset）。
 * 全局层：位于粒子/波纹/中心特效之下，所有背景模式共用（空/穿梭除外）。
 */
var PARALLAX_STARFIELD_DEPTH = [0.18, 0.45, 1.0]; // 远/中/近 位移系数
var PARALLAX_STARFIELD_MARGIN = 16;               // 星星生成外扩边距（防视差露边）

var ParallaxStarfield = function (container, theme) {
  this.graphics = new PIXI.Graphics();
  container.addChildAt(this.graphics, 0);

  this.theme = theme;
  this.stars = [];
  this.width = 0;
  this.height = 0;

  // 视差偏移（鼠标驱动，外部 setOffset 注入）
  this.ox = 0;
  this.oy = 0;

  this.enabled = true;
  this.reducedMotion = false;
  this.energy = 0;   // 高频能量（0..1）：镲片/齿音越强，星星闪得越亮
};

/** 高频能量注入（main.js 每帧传入 treble） */
ParallaxStarfield.prototype.setEnergy = function (v) {
  this.energy = Math.max(0, Math.min(1, v || 0));
};

ParallaxStarfield.prototype.resize = function (w, h) {
  this.width = w;
  this.height = h;
  this.generateStars();
};

ParallaxStarfield.prototype.setTheme = function (theme) {
  this.theme = theme;
  this.generateStars();
};

ParallaxStarfield.prototype.setEnabled = function (v) {
  this.enabled = !!v;
  if (!this.enabled) this.graphics.clear();
};

ParallaxStarfield.prototype.setReducedMotion = function (v) {
  this.reducedMotion = !!v;
};

/** 视差偏移注入（交互平面锚定，星场按层深错位）。归零时传 (0, 0) */
ParallaxStarfield.prototype.setOffset = function (x, y) {
  this.ox = x || 0;
  this.oy = y || 0;
};

ParallaxStarfield.prototype.generateStars = function () {
  this.stars = [];
  if (this.width <= 0 || this.height <= 0) return;

  var density = (this.width * this.height) / 3000;
  var m = PARALLAX_STARFIELD_MARGIN;
  var i, s;

  // 远层：小、暗、多
  for (i = 0; i < density * 0.5; i++) {
    this.stars.push({
      x: -m + Math.random() * (this.width + m * 2),
      y: -m + Math.random() * (this.height + m * 2),
      size: Math.random() * 0.8 + 0.2,
      twinkle: Math.random() * Math.PI * 2,
      layer: 0
    });
  }
  // 中层：中、灰
  for (i = 0; i < density * 0.35; i++) {
    this.stars.push({
      x: -m + Math.random() * (this.width + m * 2),
      y: -m + Math.random() * (this.height + m * 2),
      size: Math.random() * 1.2 + 0.4,
      twinkle: Math.random() * Math.PI * 2,
      layer: 1
    });
  }
  // 近层：大、亮、主题色
  for (i = 0; i < density * 0.15; i++) {
    this.stars.push({
      x: -m + Math.random() * (this.width + m * 2),
      y: -m + Math.random() * (this.height + m * 2),
      size: Math.random() * 2 + 1,
      twinkle: Math.random() * Math.PI * 2,
      layer: 2
    });
  }
};

ParallaxStarfield.prototype.update = function (dt) {
  if (!this.enabled) return;
  dt = Math.min(dt || 0, 0.05);

  var g = this.graphics;
  g.clear();

  // 视差：减少动效时强制归零（相机层已门控，这里兜底）
  var ox = this.reducedMotion ? 0 : this.ox;
  var oy = this.reducedMotion ? 0 : this.oy;

  var palette = (this.theme && this.theme.particles) || [0xffffff];
  var e = this.energy;
  for (var i = 0; i < this.stars.length; i++) {
    var star = this.stars[i];
    star.twinkle += dt * (star.layer === 2 ? 3 : 2) * (this.reducedMotion ? 0.3 : 1);
    var a = 0.3 + Math.sin(star.twinkle) * 0.3;
    var depth = PARALLAX_STARFIELD_DEPTH[star.layer] || 0;

    var color = 0xffffff;
    if (star.layer === 2) {
      color = palette[Math.floor((star.x / this.width) * palette.length)] || palette[0];
    } else if (star.layer === 1) {
      color = 0xcccccc;
    }

    var sx = star.x + ox * depth;
    var sy = star.y + oy * depth;

    // 高频段把远/中层的暗星也点亮一点，像镲片扫过星野
    if (star.layer > 0) a = Math.min(1, a + e * (star.layer === 2 ? 0.55 : 0.3));

    g.beginFill(color, a);
    g.drawCircle(sx, sy, star.size);
    g.endFill();

    if (star.layer === 2 && star.size > 1.5) {
      g.beginFill(color, a * 0.2);
      g.drawCircle(sx, sy, star.size * 3);
      g.endFill();
    }
  }
};

ParallaxStarfield.prototype.clear = function () {
  this.graphics.clear();
};

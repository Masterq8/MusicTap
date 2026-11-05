/**
 * parallaxStarfield.js — 三层闪烁星空（PIXI v6）
 * 远/中/近三层：大小、亮度、闪烁速度不同；位置固定，不跟随鼠标。
 * 全局层：位于粒子/波纹/中心特效之下，所有背景模式共用（空/穿梭除外）。
 */
var ParallaxStarfield = function (container, theme) {
  this.graphics = new PIXI.Graphics();
  container.addChildAt(this.graphics, 0);

  this.theme = theme;
  this.stars = [];
  this.width = 0;
  this.height = 0;

  this.enabled = true;
  this.reducedMotion = false;
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

ParallaxStarfield.prototype.generateStars = function () {
  this.stars = [];
  if (this.width <= 0 || this.height <= 0) return;

  var density = (this.width * this.height) / 3000;
  var i, s;

  // 远层：小、暗、多
  for (i = 0; i < density * 0.5; i++) {
    this.stars.push({
      x: Math.random() * this.width,
      y: Math.random() * this.height,
      size: Math.random() * 0.8 + 0.2,
      twinkle: Math.random() * Math.PI * 2,
      layer: 0
    });
  }
  // 中层：中、灰
  for (i = 0; i < density * 0.35; i++) {
    this.stars.push({
      x: Math.random() * this.width,
      y: Math.random() * this.height,
      size: Math.random() * 1.2 + 0.4,
      twinkle: Math.random() * Math.PI * 2,
      layer: 1
    });
  }
  // 近层：大、亮、主题色
  for (i = 0; i < density * 0.15; i++) {
    this.stars.push({
      x: Math.random() * this.width,
      y: Math.random() * this.height,
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

  var palette = (this.theme && this.theme.particles) || [0xffffff];
  for (var i = 0; i < this.stars.length; i++) {
    var star = this.stars[i];
    star.twinkle += dt * (star.layer === 2 ? 3 : 2) * (this.reducedMotion ? 0.3 : 1);
    var a = 0.3 + Math.sin(star.twinkle) * 0.3;

    var color = 0xffffff;
    if (star.layer === 2) {
      color = palette[Math.floor((star.x / this.width) * palette.length)] || palette[0];
    } else if (star.layer === 1) {
      color = 0xcccccc;
    }

    g.beginFill(color, a);
    g.drawCircle(star.x, star.y, star.size);
    g.endFill();

    if (star.layer === 2 && star.size > 1.5) {
      g.beginFill(color, a * 0.2);
      g.drawCircle(star.x, star.y, star.size * 3);
      g.endFill();
    }
  }
};

ParallaxStarfield.prototype.clear = function () {
  this.graphics.clear();
};

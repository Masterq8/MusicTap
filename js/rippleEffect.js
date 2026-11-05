/**
 * rippleEffect.js — 三层同心圆波纹（PIXI v6）
 * 扩散 1.1s，easeOutQuad；所有运动量按秒计算（调用方传 dt 秒）。
 */
var RIPPLE_LAYERS = [
  { scale: 1.0, alpha: 0.8, width: 4.0 },
  { scale: 0.85, alpha: 0.4, width: 2.0 },
  { scale: 0.7, alpha: 0.2, width: 1.2 }
];
var RIPPLE_DURATION = 1.1;

function rippleEaseOutQuad(t) {
  return 1 - (1 - t) * (1 - t);
}

var RippleEffect = function (container, theme) {
  this.graphics = new PIXI.Graphics();
  container.addChild(this.graphics);
  this.theme = theme;
  this.ripples = [];
  this.width = 0;
  this.height = 0;
  this.enabled = true;
};

RippleEffect.prototype.resize = function (w, h) {
  this.width = w;
  this.height = h;
};

RippleEffect.prototype.setTheme = function (theme) {
  this.theme = theme;
};

RippleEffect.prototype.setEnabled = function (v) {
  this.enabled = !!v;
  if (!this.enabled) this.graphics.clear();
};

RippleEffect.prototype.emit = function (x, y) {
  if (!this.enabled) return;
  var maxR = Math.min(this.width, this.height) * 0.35;
  // 拖拽洪水保护
  if (this.ripples.length > 36) this.ripples.shift();
  this.ripples.push({
    x: x,
    y: y,
    progress: 0,
    maxRadius: maxR,
    color: this.theme.ripple,
    active: true
  });
};

RippleEffect.prototype.update = function (dt) {
  if (!this.enabled) return;
  var g = this.graphics;
  g.clear();

  if (this.ripples.length === 0) return;
  var step = Math.min(dt || 0, 0.05) / RIPPLE_DURATION;

  for (var i = 0; i < this.ripples.length; i++) {
    var r = this.ripples[i];
    if (!r.active) continue;

    r.progress += step;
    if (r.progress >= 1) {
      r.active = false;
      continue;
    }

    var p = r.progress;
    var radius = 2 + (r.maxRadius - 2) * rippleEaseOutQuad(p);
    var fade = (1 - p) * (1 - p);

    for (var l = 0; l < RIPPLE_LAYERS.length; l++) {
      var layer = RIPPLE_LAYERS[l];
      g.lineStyle(Math.max(0.2, layer.width * (1 - p)), r.color, layer.alpha * fade);
      g.drawCircle(r.x, r.y, radius * layer.scale);
    }
    g.lineStyle(0);
  }

  // 原地压缩
  var write = 0;
  for (var j = 0; j < this.ripples.length; j++) {
    if (this.ripples[j].active) this.ripples[write++] = this.ripples[j];
  }
  this.ripples.length = write;
};

RippleEffect.prototype.clear = function () {
  this.ripples = [];
  this.graphics.clear();
};

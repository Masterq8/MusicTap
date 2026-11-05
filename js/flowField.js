/**
 * flowField.js — 轻量 2D value-noise 力场（无外部依赖）
 * 粒子沿隐形力场漂移；所有速度按 60fps 基准换算。
 */
var FlowField = function () {
  this.time = 0;
  this.scale = 0.01;
  this.strength = 2;
  this.enabled = false;
};

function _ffHash(x, y) {
  var n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function _ffSmooth(t) {
  return t * t * (3 - 2 * t);
}

function _ffNoise(x, y) {
  var xi = Math.floor(x);
  var yi = Math.floor(y);
  var xf = x - xi;
  var yf = y - yi;
  var v00 = _ffHash(xi, yi);
  var v10 = _ffHash(xi + 1, yi);
  var v01 = _ffHash(xi, yi + 1);
  var v11 = _ffHash(xi + 1, yi + 1);
  var u = _ffSmooth(xf);
  var v = _ffSmooth(yf);
  var top = v00 + (v10 - v00) * u;
  var bottom = v01 + (v11 - v01) * u;
  return top + (bottom - top) * v; // 0..1
}

FlowField.prototype.setEnabled = function (v) {
  this.enabled = !!v;
};

FlowField.prototype.setStrength = function (v) {
  this.strength = Math.max(0, Math.min(5, v));
};

FlowField.prototype.update = function (dt) {
  if (!this.enabled) return;
  this.time += Math.min(dt || 0, 0.05) * 0.1;
};

FlowField.prototype.getForce = function (x, y) {
  if (!this.enabled) return { fx: 0, fy: 0 };
  var nx = x * this.scale;
  var ny = y * this.scale;
  // 两个 octave，避免过于规则
  var n = _ffNoise(nx, ny + this.time) * 0.65
    + _ffNoise(nx * 2.1, ny * 2.1 - this.time * 0.7) * 0.35;
  var angle = (n * 2 - 1) * Math.PI * 2;
  return {
    fx: Math.cos(angle) * this.strength,
    fy: Math.sin(angle) * this.strength
  };
};

FlowField.prototype.applyForce = function (p, dt) {
  if (!this.enabled) return;
  var f = this.getForce(p.x, p.y);
  var step = Math.min(dt || (1 / 60), 0.05) * 60;
  p.vx += f.fx * 0.15 * step;
  p.vy += f.fy * 0.15 * step;
};

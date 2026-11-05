/**
 * spectrumVisualizer.js — 环形频谱雷达（PIXI v6）
 * attack/release 包络（上升快、下降慢），中心圆连续呼吸。
 * draw(data, dtSec) —— dtSec 为秒，用于帧率无关平滑。
 */
var SpectrumVisualizer = function (container, theme) {
  this.graphics = new PIXI.Graphics();
  container.addChild(this.graphics);
  this.theme = theme;
  this.width = 0;
  this.height = 0;
  this.enabled = true;
  this.rainbow = false; // 模组 rainbow-spectrum

  this.barCount = 64;
  this.display = new Float32Array(this.barCount);
  this.center = 0;
};

SpectrumVisualizer.prototype.resize = function (w, h) {
  this.width = w;
  this.height = h;
};

SpectrumVisualizer.prototype.setTheme = function (theme) {
  this.theme = theme;
};

SpectrumVisualizer.prototype.setEnabled = function (v) {
  this.enabled = !!v;
  if (!this.enabled) this.graphics.clear();
};

SpectrumVisualizer.prototype.draw = function (spectrumData, dt) {
  if (!this.enabled) return;
  dt = Math.min(dt || (1 / 60), 0.05);

  var g = this.graphics;
  g.clear();

  var cx = this.width / 2;
  var cy = this.height / 2;
  var baseRadius = Math.min(this.width, this.height) * 0.15;
  var barCount = this.barCount;

  if (!spectrumData) {
    // 无音频：缓慢回落，而不是瞬间消失
    var decay = 1 - Math.exp(-6 * dt);
    var any = false;
    for (var d = 0; d < barCount; d++) {
      this.display[d] += (0 - this.display[d]) * decay;
      if (this.display[d] > 0.004) any = true;
    }
    this.center += (0 - this.center) * decay;
    if (!any && this.center < 0.005) return;
  } else {
    var step = Math.max(1, Math.floor(spectrumData.length / barCount));
    var kUp = 1 - Math.exp(-28 * dt);
    var kDown = 1 - Math.exp(-7 * dt);

    for (var i = 0; i < barCount; i++) {
      var target = (spectrumData[i * step] || 0) / 255;
      var k = target > this.display[i] ? kUp : kDown;
      this.display[i] += (target - this.display[i]) * k;
    }

    var bass = 0;
    var bins = Math.min(8, spectrumData.length);
    for (var b = 0; b < bins; b++) bass += spectrumData[b];
    bass /= bins * 255;
    this.center += (bass - this.center) * (1 - Math.exp(-8 * dt));
  }

  var palette = this.theme.spectrum;
  for (var j = 0; j < barCount; j++) {
    var value = Math.max(0, Math.min(1, this.display[j]));
    if (value < 0.004) continue;

    var angle = (j / barCount) * Math.PI * 2 - Math.PI / 2;
    var barHeight = value * Math.min(this.width, this.height) * 0.2;

    var color;
    if (this.rainbow && window.ColorUtil) {
      var base = palette[0] || 0xffffff;
      var bHsl = window.ColorUtil.rgbToHsl((base >> 16) & 255, (base >> 8) & 255, base & 255);
      var hue = (bHsl.h + Date.now() * 0.00012 + j / barCount) % 1;
      var c = window.ColorUtil.hslToRgb(hue, Math.max(0.75, bHsl.s), 0.55);
      color = window.ColorUtil.rgbToNum(c);
    } else {
      var colorIdx = Math.floor(value * (palette.length - 1));
      color = palette[colorIdx] || palette[0];
    }

    var x1 = cx + Math.cos(angle) * baseRadius;
    var y1 = cy + Math.sin(angle) * baseRadius;
    var x2 = cx + Math.cos(angle) * (baseRadius + barHeight);
    var y2 = cy + Math.sin(angle) * (baseRadius + barHeight);

    g.lineStyle(2 + value * 3, color, 0.8);
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
  }
  g.lineStyle(0);

  this.drawCenter(cx, cy, baseRadius);
};

SpectrumVisualizer.prototype.drawCenter = function (cx, cy, baseRadius) {
  var v = Math.max(0, Math.min(1, this.center));
  if (v < 0.003) return;
  var r = baseRadius * (0.34 + v * 0.5);
  var color = this.theme.spectrum[0];
  var g = this.graphics;

  g.beginFill(color, 0.04 + v * 0.14);
  g.drawCircle(cx, cy, r);
  g.endFill();

  g.lineStyle(1.5, color, 0.12 + v * 0.5);
  g.drawCircle(cx, cy, r);
  g.lineStyle(0);
};

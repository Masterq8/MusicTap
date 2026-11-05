/**
 * metaballRenderer.js — 星云 Metaball（半分辨率离屏 Canvas）
 * 实心光点层 → 整层单次 blur → 阈值 → 按亮度映射主题色。
 */
var MetaballRenderer = function (width, height, theme) {
  this.pixelScale = 0.5;
  this.threshold = 128;
  this.blurRadius = 20;
  this.enabled = false;
  this.theme = theme || { spectrum: [0xffffff], ripple: 0xffffff };

  this.offscreen = document.createElement('canvas');
  this.ctx = this.offscreen.getContext('2d', { willReadFrequently: true });

  this.blobCanvas = document.createElement('canvas');
  this.blobCtx = this.blobCanvas.getContext('2d');

  this.thresholdCanvas = document.createElement('canvas');
  this.thresholdCtx = this.thresholdCanvas.getContext('2d');

  this.resize(width, height);
};

MetaballRenderer.prototype.resize = function (w, h) {
  var cw = Math.max(1, Math.round(w * this.pixelScale));
  var ch = Math.max(1, Math.round(h * this.pixelScale));
  this.offscreen.width = cw;
  this.offscreen.height = ch;
  this.blobCanvas.width = cw;
  this.blobCanvas.height = ch;
  this.thresholdCanvas.width = cw;
  this.thresholdCanvas.height = ch;
};

MetaballRenderer.prototype.setTheme = function (theme) {
  if (theme) this.theme = theme;
};

MetaballRenderer.prototype.setEnabled = function (v) {
  this.enabled = !!v;
};

MetaballRenderer.prototype.setThreshold = function (v) {
  this.threshold = Math.max(32, Math.min(224, v));
};

MetaballRenderer.prototype.setBlurRadius = function (v) {
  this.blurRadius = Math.max(5, Math.min(60, v));
};

MetaballRenderer.prototype.getCanvas = function () {
  return this.thresholdCanvas;
};

MetaballRenderer.prototype.getScale = function () {
  return 1 / this.pixelScale;
};

/**
 * @param {Array<{x:number,y:number,size:number,alpha:number}>} particles
 * @returns {HTMLCanvasElement|null}
 */
MetaballRenderer.prototype.render = function (particles) {
  if (!this.enabled) return null;
  if (!particles || particles.length === 0) return null;

  var s = this.pixelScale;
  var w = this.offscreen.width;
  var h = this.offscreen.height;
  if (!w || !h) return null;

  // 1) 光点层：实心圆（不逐点 blur）
  var blobCtx = this.blobCtx;
  blobCtx.clearRect(0, 0, w, h);
  for (var i = 0; i < particles.length; i++) {
    var p = particles[i];
    var r = Math.max(1, (p.size + this.blurRadius * 0.4) * s);
    blobCtx.beginPath();
    blobCtx.arc(p.x * s, p.y * s, r, 0, Math.PI * 2);
    blobCtx.fillStyle = 'rgba(255,255,255,' + p.alpha + ')';
    blobCtx.fill();
  }

  // 2) 整层只模糊一次
  this.ctx.clearRect(0, 0, w, h);
  this.ctx.filter = 'blur(' + (this.blurRadius * s) + 'px)';
  this.ctx.drawImage(this.blobCanvas, 0, 0);
  this.ctx.filter = 'none';

  // 3) 阈值 + 主题色映射
  var imgData = this.ctx.getImageData(0, 0, w, h);
  var data = imgData.data;
  var palette = (this.theme.spectrum && this.theme.spectrum.length)
    ? this.theme.spectrum
    : [this.theme.ripple || 0xffffff];
  var stops = palette.map(function (c) {
    return { r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255 };
  });
  var threshold = this.threshold;

  for (var j = 0; j < data.length; j += 4) {
    var alpha = data[j + 3];
    if (alpha === 0) continue;

    var a = alpha / 255;
    var brightness = ((data[j] + data[j + 1] + data[j + 2]) / 3) * a;
    if (brightness > threshold) {
      var t = Math.max(0, Math.min(1, (brightness - threshold) / (255 - threshold)));
      var idx = Math.min(stops.length - 1, Math.floor(t * stops.length));
      var c = stops[idx];
      data[j] = c.r;
      data[j + 1] = c.g;
      data[j + 2] = c.b;
      data[j + 3] = 255;
    } else {
      data[j + 3] = 0;
    }
  }

  this.thresholdCtx.putImageData(imgData, 0, 0);
  return this.thresholdCanvas;
};

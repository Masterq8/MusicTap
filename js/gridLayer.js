/**
 * 网格层 - mikutap 标志性的 4×8 网格 + 点击选中方块高亮
 * 每个方块代表一个音色区域，点击时高亮并淡出
 */
var GridLayer = function (container, theme) {
  this.graphics = new PIXI.Graphics();
  container.addChild(this.graphics);
  this.theme = theme;
  this.width = 0;
  this.height = 0;
  this.cols = 8;
  this.rows = 4;
  this.enabled = true;
  // 高亮方块列表 {col, row, color, alpha}
  this.highlights = [];
};

GridLayer.prototype.resize = function (w, h) {
  this.width = w;
  this.height = h;
};

GridLayer.prototype.setTheme = function (theme) {
  this.theme = theme;
};

GridLayer.prototype.setEnabled = function (v) {
  this.enabled = v;
  if (!v) { this.graphics.clear(); this.highlights = []; }
};

/** 根据屏幕坐标返回对应的网格行列 */
GridLayer.prototype.getCell = function (x, y) {
  var col = Math.floor(x / this.width * this.cols);
  var row = Math.floor(y / this.height * this.rows);
  col = Math.max(0, Math.min(this.cols - 1, col));
  row = Math.max(0, Math.min(this.rows - 1, row));
  return { col: col, row: row };
};

/** 高亮某个方块（点击时调用） */
GridLayer.prototype.highlight = function (col, row, color) {
  this.highlights.push({ col: col, row: row, color: color || this.theme.accent, alpha: 0.85 });
};

GridLayer.prototype.update = function (dt) {
  if (!this.enabled) return;
  var g = this.graphics;
  g.clear();

  var cellW = this.width / this.cols;
  var cellH = this.height / this.rows;

  // 画网格线（半透明，mikutap 的淡网格）
  g.lineStyle(1, 0xffffff, 0.06);
  for (var c = 1; c < this.cols; c++) {
    g.moveTo(c * cellW, 0);
    g.lineTo(c * cellW, this.height);
  }
  for (var r = 1; r < this.rows; r++) {
    g.moveTo(0, r * cellH);
    g.lineTo(this.width, r * cellH);
  }

  // 画高亮方块（点击选中，淡出）
  for (var i = 0; i < this.highlights.length; i++) {
    var hl = this.highlights[i];
    hl.alpha -= dt * 1.5;
    if (hl.alpha <= 0) continue;

    var x = hl.col * cellW;
    var y = hl.row * cellH;

    // 方块填充 + 边框
    g.beginFill(hl.color, hl.alpha * 0.25);
    g.drawRect(x + 2, y + 2, cellW - 4, cellH - 4);
    g.lineStyle(2, hl.color, hl.alpha);
    g.drawRect(x + 2, y + 2, cellW - 4, cellH - 4);
    g.lineStyle(0);
  }

  // 清理已消失的高亮
  this.highlights = this.highlights.filter(function (h) { return h.alpha > 0; });
};

GridLayer.prototype.clear = function () {
  this.highlights = [];
  this.graphics.clear();
};

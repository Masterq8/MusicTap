/**
 * 网格层 - mikutap 标志性的 4×8 网格 + 点击选中方块高亮
 * 每个方块代表一个音色区域，点击时高亮并淡出
 *
 * 音游模式扩展（rhythmGame.js 驱动）——中心 2×2 四分区（QWER）：
 *   zoneRect(i)                       分区几何（0=Q左上 1=W右上 2=E左下 3=R右下）
 *   zoneAt(x,y)                       画布坐标 → 分区号（-1 = 四区之外）
 *   zonePreview(zone,progress,color)  分区内 approach 光框（随 progress 收缩增亮）
 *   clearZonePreview(zone?)           清除分区光框
 *   zoneHit(zone,color)               命中反馈：网格高亮同款（填充+边框外扩淡出）
 *   zoneJudge(zone,text,color,dim)    分区中心判定文字（同一时刻只保留最新一条）
 *   fadeJudge()                       快速淡出当前判定文字（每次按下时调用）
 *   setZoneGuides(v)                  常驻四分区淡引导框 + Q/W/E/R 角标
 *   setBeat(phase,down,color) / clearBeat()   节拍脉冲（判定辅助：中心点随拍点闪动）
 *   milestone(combo,level)            连击里程碑演出（全屏轻闪 + 中心冲击波）
 *   preview/clearPreview/judge/flash  旧格子版接口（保留兼容）
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

  // ---- 音游模式：提示光框（ADD 混合发光）+ 判定文字 ----
  this.glow = new PIXI.Graphics();
  this.glow.blendMode = PIXI.BLEND_MODES.ADD;
  container.addChild(this.glow);
  this._previews = {};          // key 'col-row' → { col,row,progress,color }
  this._flash = [];             // { col,row,color,age }
  this._judgeTexts = [];        // { text(PIXI.Text), age, x, y }
  this._judgePool = [];         // 回收的 PIXI.Text

  // ---- 音游模式：中心 2×2 四分区 ----
  this._zonePreviews = {};      // zone → { progress, color }
  this._zoneFlash = [];         // { zone, color, age }
  this._zoneGuides = false;     // 常驻淡引导框开关
  this._zoneLabels = null;      // 惰性创建的 Q/W/E/R 角标

  // ---- 判定辅助 / 连击里程碑 ----
  this._beat = null;            // { phase, down, color } 拍点相位（0=拍点）
  this._comboFx = [];           // { age, level, combo } 里程碑演出
};
var _proto = GridLayer.prototype;

_proto.resize = function (w, h) {
  this.width = w;
  this.height = h;
  // 尺寸变化：判定文字按新尺寸重排（少见路径，直接回收）
  while (this._judgeTexts.length) this._recycleJudge(this._judgeTexts.pop());
};

_proto.setTheme = function (theme) {
  this.theme = theme;
};

_proto.setEnabled = function (v) {
  this.enabled = v;
  if (!v) {
    this.graphics.clear();
    this.glow.clear();
    this.highlights = [];
    this.clearPreview();
    this.clearZonePreview();
    this._clearJudgeTexts();
    this.setZoneGuides(false);
  }
};

/** 根据屏幕坐标返回对应的网格行列 */
_proto.getCell = function (x, y) {
  var col = Math.floor(x / this.width * this.cols);
  var row = Math.floor(y / this.height * this.rows);
  col = Math.max(0, Math.min(this.cols - 1, col));
  row = Math.max(0, Math.min(this.rows - 1, row));
  return { col: col, row: row };
};

/** 高亮某个方块（点击时调用） */
_proto.highlight = function (col, row, color) {
  this.highlights.push({ col: col, row: row, color: color || this.theme.accent, alpha: 0.85 });
};

/* ---------------- 音游模式：中心 2×2 四分区（QWER） ---------------- */

/** 分区几何：以画布中心为圆心的四个象限方块，与中心特效之间留呼吸缝 */
_proto.zoneRect = function (i) {
  var m = Math.min(this.width, this.height);
  var s = m * 0.34;                          // 象限边长
  var gap = Math.max(6, m * 0.014);          // 与中心的缝
  var cx = this.width / 2, cy = this.height / 2;
  var left = (i % 2) === 0, up = i < 2;
  return {
    x: left ? cx - gap - s : cx + gap,
    y: up ? cy - gap - s : cy + gap,
    w: s, h: s
  };
};

/** 画布坐标 → 分区号；四区之外返回 -1 */
_proto.zoneAt = function (x, y) {
  for (var i = 0; i < 4; i++) {
    var r = this.zoneRect(i);
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
  }
  return -1;
};

/** 分区 approach 光框进度（0=完整外框 1=拍点贴合） */
_proto.zonePreview = function (zone, progress, color) {
  this._zonePreviews[zone] = { progress: progress, color: color };
};

_proto.clearZonePreview = function (zone) {
  if (zone == null) { this._zonePreviews = {}; this._zoneFlash = []; return; }
  delete this._zonePreviews[zone];
};

/** 命中反馈：网格高亮同款打击感 —— 填充闪 + 边框外扩淡出（300ms，与格子命中一致） */
_proto.zoneHit = function (zone, color) {
  this._zoneFlash.push({ zone: zone, color: color, age: 0 });
  if (this._zoneFlash.length > 8) this._zoneFlash.shift();
};

/** 快速淡出当前判定文字：每次按下时调用（不按也会在短时间内自动消失） */
_proto.fadeJudge = function () {
  for (var i = 0; i < this._judgeTexts.length; i++) {
    var jt = this._judgeTexts[i];
    // 直接跳到淡出段起点：约 130ms 内淡完，不突兀
    jt.age = Math.max(jt.age, 0.42);
  }
};

/**
 * 节拍脉冲（判定辅助）：中心点随拍点闪动 + 一圈向外扩散的脉冲环。
 * 做法参考 osu! 的 beat meter 与 Metronoom 的视觉拍点——只给「时间锚」，
 * 不提示按哪个分区（那由光框负责），因此不会削弱读谱。
 * phase: 0~1（0 = 拍点），down: 是否为小节首拍。
 */
_proto.setBeat = function (phase, down, color) {
  this._beat = { phase: phase, down: !!down, color: color || 0x7fe8ff };
};

_proto.clearBeat = function () {
  this._beat = null;
};

/** 连击里程碑演出：全屏轻闪 + 中心冲击波（level 越大越强，0=10连 1=25连 2=50连 3=50的倍数） */
_proto.milestone = function (combo, level) {
  this._comboFx.push({ age: 0, level: clampLv(level), combo: combo });
  if (this._comboFx.length > 4) this._comboFx.shift();
};

function clampLv(l) {
  l = l | 0;
  return l < 0 ? 0 : (l > 3 ? 3 : l);
}

/**
 * 音游视觉一次性清空（切回自由模式 / 重置时调用）。
 * 关键：updatePreview 只在音游 tick 里跑，模式切走后 glow 的最后一帧
 * （引导框 + 收缩光框）会永久滞留画面 —— 必须在这里主动 clear。
 */
_proto.clearRhythmVisuals = function () {
  this._zonePreviews = {};
  this._zoneFlash = [];
  this._beat = null;
  this._comboFx = [];
  this._clearJudgeTexts();
  this._zoneGuides = false;
  if (this._zoneLabels) {
    for (var i = 0; i < this._zoneLabels.length; i++) {
      var t = this._zoneLabels[i];
      if (t && t.parent) t.parent.removeChild(t);
    }
    this._zoneLabels = null;
  }
  this.glow.clear();
};

/** 判定文字：分区中心浮起淡出 */
_proto.zoneJudge = function (zone, text, color, dim) {
  var r = this.zoneRect(zone);
  this._judgeAt(r.x + r.w / 2, r.y + r.h / 2, text, color, dim);
};

/** 常驻四分区淡引导框 + Q/W/E/R 角标（音游模式开 / 关） */
_proto.setZoneGuides = function (v) {
  this._zoneGuides = !!v;
  if (!v && this._zoneLabels) {
    for (var i = 0; i < this._zoneLabels.length; i++) {
      var t = this._zoneLabels[i];
      if (t && t.parent) t.parent.removeChild(t);
    }
    this._zoneLabels = null;
  }
};

_proto._makeZoneLabels = function () {
  var names = ['Q', 'W', 'E', 'R'];
  this._zoneLabels = [];
  for (var i = 0; i < 4; i++) {
    var t = new PIXI.Text(names[i], {
      fontFamily: 'Menlo, Consolas, monospace',
      fontSize: 15,
      fontWeight: 'bold',
      fill: '#7fe8ff',
      letterSpacing: 1
    });
    t.alpha = 0.3;
    if (this.glow.parent) this.glow.parent.addChild(t);
    this._zoneLabels.push(t);
  }
};

/* ---------------- 音游模式：格子版接口（保留兼容） ---------------- */

/** 设置/更新某个格子的 approach 光框进度（0=刚亮起 1=拍点） */
_proto.preview = function (col, row, progress, color) {
  this._previews[col + '-' + row] = { col: col, row: row, progress: progress, color: color };
};

_proto.clearPreview = function (col, row) {
  if (col == null) { this._previews = {}; this.clearZonePreview(); return; }
  delete this._previews[col + '-' + row];
};

/** 命中爆闪：格子边框快闪外扩 */
_proto.flash = function (col, row, color) {
  this._flash.push({ col: col, row: row, color: color, age: 0 });
  if (this._flash.length > 12) this._flash.shift();
};

/** 判定文字（格子版，兼容保留）：格子上方浮起淡出 */
_proto.judge = function (col, row, text, color, dim) {
  this._judgeAt((col + 0.5) * (this.width / this.cols), (row + 0.5) * (this.height / this.rows), text, color, dim);
};

/**
 * 判定文字（坐标锚定）：同屏只保留最新一条 —— 新判定直接替换旧判定，
 * 从根本上杜绝 PERFECT/GREAT/MISS 重叠糊屏；不按 0.55s 内自动淡出。
 * 打击感：字号加大 + 弹性放大更有力。
 */
_proto._judgeAt = function (x, y, text, color, dim) {
  // 关键：先回收全部在场的判定文字（下一次判定 = 上一条立刻消失，绝不堆积）
  this._clearJudgeTexts();
  var t = this._judgePool.pop();
  if (!t) {
    t = new PIXI.Text('', {
      fontFamily: 'Menlo, Consolas, monospace',
      fontSize: 30,
      fontWeight: 'bold',
      fill: '#ffffff',
      letterSpacing: 2
    });
    t.anchor.set(0.5, 0.5);
  }
  t.style.fill = dim ? '#9a9aa6' : '#' + ('000000' + (color || 0x7fe8ff).toString(16)).slice(-6);
  t.alpha = 1;
  t.visible = true;
  t.text = text;
  if (this.glow.parent) this.glow.parent.addChild(t);   // 与 glow 同容器（stage）
  this._judgeTexts.push({ text: t, age: 0, x: x, y: y });
};

_proto._recycleJudge = function (item) {
  if (item && item.text) {
    item.text.visible = false;
    if (item.text.parent) item.text.parent.removeChild(item.text);
    if (this._judgePool.length < 6) this._judgePool.push(item.text);
    else item.text.destroy({ texture: false, baseTexture: false });
  }
};

_proto._clearJudgeTexts = function () {
  while (this._judgeTexts.length) this._recycleJudge(this._judgeTexts.pop());
};

/** 音游模式每帧视觉（rhythmGame.tick 内调用） */
_proto.updatePreview = function () {
  var g = this.glow;
  g.clear();
  if (!this.enabled) return;

  var cellW = this.width / this.cols;
  var cellH = this.height / this.rows;
  var key, p;
  var m0 = Math.min(this.width, this.height);      // 中心脉冲按短边取尺寸（自适应）
  var cx0 = this.width / 2, cy0 = this.height / 2;

  // ---- 常驻四分区引导框 + Q/W/E/R 角标 ----
  // 样式复用网格高亮（highlight）的「填充 + 2px 边框」语言，只是常驻态更淡，保持视觉统一
  if (this._zoneGuides) {
    if (!this._zoneLabels) this._makeZoneLabels();
    for (var z = 0; z < 4; z++) {
      var zr = this.zoneRect(z);
      g.beginFill(0x7fe8ff, 0.045);
      g.drawRect(zr.x + 2, zr.y + 2, zr.w - 4, zr.h - 4);
      g.lineStyle(2, 0x7fe8ff, 0.12);
      g.drawRect(zr.x + 2, zr.y + 2, zr.w - 4, zr.h - 4);
      g.lineStyle(0);
      var lb = this._zoneLabels[z];
      if (lb) lb.position.set(zr.x + 10, zr.y + 7);
    }
  }

  // ---- 判定辅助：中心节拍脉冲（osu! beat meter / Metronoom 视觉拍点同源） ----
  // 只给「时间锚」，不提示该按哪个分区（读谱仍由光框负责），因此不削弱玩法。
  // 双通道：中心点（精确拍点）+ 四分区整体外框「呼吸」（不被中心星核光晕淹没）。
  if (this._beat) {
    var bp = this._beat;
    var ph = bp.phase - Math.floor(bp.phase);
    var dec = Math.pow(1 - ph, 2.4);            // 拍点最亮，之后快速衰减
    var st = bp.down ? 1 : 0.5;                 // 小节首拍更重，帮助数 4 拍
    g.lineStyle(0);
    // 常驻微光点：让「节拍在哪」始终有个固定位置可看
    g.beginFill(bp.color, 0.10);
    g.drawCircle(cx0, cy0, m0 * 0.009);
    g.endFill();
    // 拍点爆亮
    g.beginFill(bp.color, (0.12 + 0.5 * dec) * st);
    g.drawCircle(cx0, cy0, m0 * 0.009 * (1 + 0.7 * dec * st));
    g.endFill();
    // 扩散脉冲环：半径随相位外扩、亮度同步衰减（「一下、一下」的视觉拍）
    g.lineStyle(1.2 + 2.2 * (1 - ph) * st, bp.color, 0.3 * dec * st + 0.03);
    g.drawCircle(cx0, cy0, m0 * (0.012 + ph * 0.036 * (bp.down ? 1.25 : 1)));
    // 四分区外框呼吸：整个演奏区随拍点提亮再回落（与中心星核互不遮挡）
    var za = this.zoneRect(0), zb = this.zoneRect(3);
    g.lineStyle(1 + 1.5 * (1 - ph) * st, bp.color, 0.05 + 0.30 * dec * st);
    g.drawRect(za.x - 4, za.y - 4, zb.x + zb.w - za.x + 8, zb.y + zb.h - za.y + 8);
  }

  // ---- 分区 approach 光框（音游主视觉：中心 2×2 象限内收缩） ----
  for (key in this._zonePreviews) {
    if (!this._zonePreviews.hasOwnProperty(key)) continue;
    p = this._zonePreviews[key];
    var zr2 = this.zoneRect(+key);
    var zcx = zr2.x + zr2.w / 2;
    var zcy = zr2.y + zr2.h / 2;
    var zw = zr2.w * (1.45 - 0.47 * p.progress);    // 1.45 → 0.98 倍分区尺寸
    var zh = zr2.h * (1.45 - 0.47 * p.progress);
    g.lineStyle(1.5 + p.progress * 1.5, p.color, 0.22 + 0.6 * p.progress);
    g.drawRect(zcx - zw / 2, zcy - zh / 2, zw, zh);
    // 目标分区边框常亮（2px，与网格高亮边框同宽）
    g.lineStyle(2, p.color, 0.22 + 0.3 * p.progress);
    g.drawRect(zr2.x + 2, zr2.y + 2, zr2.w - 4, zr2.h - 4);
    // 最后 ~150ms：中心光点 + 框线爆亮（「就是现在」的视觉锚）
    if (p.progress > 0.86) {
      var zk = (p.progress - 0.86) / 0.14;
      g.lineStyle(0);
      g.beginFill(p.color, zk * 0.4);
      g.drawCircle(zcx, zcy, 3 + zk * 5);
      g.endFill();
      g.lineStyle(2.5, p.color, zk * 0.8);
      g.drawRect(zcx - zw / 2, zcy - zh / 2, zw, zh);
    }
  }

  // ---- 分区命中反馈：网格命中同款（填充闪 + 边框外扩淡出 300ms，参数与格子 _flash 一致） ----
  for (var zf = this._zoneFlash.length - 1; zf >= 0; zf--) {
    var f2 = this._zoneFlash[zf];
    f2.age += 1 / 60;
    if (f2.age > 0.3) { this._zoneFlash.splice(zf, 1); continue; }
    var q2 = f2.age / 0.3;
    var fr = this.zoneRect(f2.zone);
    var finset = 2 + q2 * 14;
    // 填充闪：前 100ms 快速衰减的整块填充（highlight 同款语言，打击「实感」）
    if (q2 < 0.34) {
      g.beginFill(f2.color, (1 - q2 / 0.34) * 0.32);
      g.drawRect(fr.x + 2, fr.y + 2, fr.w - 4, fr.h - 4);
      g.endFill();
    }
    g.lineStyle(4 * (1 - q2) + 0.5, f2.color, (1 - q2) * 0.95);
    g.drawRect(fr.x - finset + 2, fr.y - finset + 2, fr.w - 4 + finset * 2, fr.h - 4 + finset * 2);
  }

  // ---- 连击里程碑演出：全屏轻闪 + 中心冲击波（osu! comboburst / ComboTracker 的 juice 做法） ----
  for (var cf = this._comboFx.length - 1; cf >= 0; cf--) {
    var fx = this._comboFx[cf];
    fx.age += 1 / 60;
    if (fx.age > 0.62) { this._comboFx.splice(cf, 1); continue; }
    var fq = fx.age / 0.62;
    var fade = (1 - fq) * (1 - fq);
    var lv = fx.level;
    g.lineStyle(0);
    // ① 全屏金色轻闪：透明度极低，只做「一瞬提亮」，不压住音符
    g.beginFill(0xffd75e, (lv >= 2 ? 0.085 : 0.055) * fade);
    g.drawRect(0, 0, this.width, this.height);
    g.endFill();
    // ② 中心冲击波：主环外扩淡出 +（25连以上）错相位副环
    var r1 = m0 * (0.06 + fq * (0.5 + lv * 0.09));
    g.lineStyle((2.5 + lv * 1.2) * (1 - fq) + 0.5, 0xffd75e, (1 - fq) * 0.6);
    g.drawCircle(cx0, cy0, r1);
    if (lv >= 1) {
      g.lineStyle((1.5 + lv) * (1 - fq) + 0.4, 0xfff2c0, (1 - fq) * 0.35);
      g.drawCircle(cx0, cy0, r1 * 0.75);
    }
  }

  // ---- 格子版 approach 光框（兼容保留） ----
  for (key in this._previews) {
    if (!this._previews.hasOwnProperty(key)) continue;
    p = this._previews[key];
    var cx = (p.col + 0.5) * cellW;
    var cy = (p.row + 0.5) * cellH;
    var w = cellW * (1.45 - 0.47 * p.progress);      // 1.45 → 0.98
    var h = cellH * (1.45 - 0.47 * p.progress);
    var alpha = 0.22 + 0.6 * p.progress;
    var lw = 1.5 + p.progress * 1.5;
    g.lineStyle(lw, p.color, alpha);
    g.drawRect(cx - w / 2, cy - h / 2, w, h);
    // 目标格边框常亮（细）
    g.lineStyle(1, p.color, 0.30 + 0.35 * p.progress);
    g.drawRect(p.col * cellW + 2, p.row * cellH + 2, cellW - 4, cellH - 4);
    // 最后 ~150ms：中心光点 + 框线爆亮（「就是现在」的视觉锚）
    if (p.progress > 0.86) {
      var k = (p.progress - 0.86) / 0.14;
      g.lineStyle(0);
      g.beginFill(p.color, k * 0.55);
      g.drawCircle(cx, cy, 3 + k * 5);
      g.endFill();
      g.lineStyle(2.5, p.color, k * 0.8);
      g.drawRect(cx - w / 2, cy - h / 2, w, h);
    }
  }

  // 命中爆闪：边框高亮外扩淡出（300ms）
  for (var i = this._flash.length - 1; i >= 0; i--) {
    var f = this._flash[i];
    f.age += 1 / 60;
    if (f.age > 0.3) { this._flash.splice(i, 1); continue; }
    var q = f.age / 0.3;
    var fx = f.col * cellW, fy = f.row * cellH;
    var inset = 2 + q * 14;
    g.lineStyle(4 * (1 - q) + 0.5, f.color, (1 - q) * 0.95);
    g.drawRect(fx - inset + 2, fy - inset + 2, cellW - 4 + inset * 2, cellH - 4 + inset * 2);
  }
};

_proto.update = function (dt) {
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

  // 判定文字：上浮 + 淡出（弹性放大 → 收稳）；0.55s 生命，0.32s 后开始淡出
  for (var j = this._judgeTexts.length - 1; j >= 0; j--) {
    var jt = this._judgeTexts[j];
    jt.age += dt / 60;
    if (jt.age > 0.55) { this._recycleJudge(jt); this._judgeTexts.splice(j, 1); continue; }
    jt.text.position.set(jt.x, jt.y - 30 - jt.age * 46);
    jt.text.scale.set(jt.age < 0.08 ? 0.8 + (jt.age / 0.08) * 0.4 : 1.2 - Math.min(0.2, (jt.age - 0.08) * 1.4));
    jt.text.alpha = jt.age < 0.32 ? 1 : 1 - (jt.age - 0.32) / 0.23;
  }
};

_proto.clear = function () {
  this.highlights = [];
  this.graphics.clear();
  this.clearPreview();
  this.clearZonePreview();
  this._clearJudgeTexts();
};

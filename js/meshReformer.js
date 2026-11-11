/**
 * meshReformer.js — 粒子 Mesh 重组（北斗 / 猎户 / 旋涡 / 字母 M / 同心圆）
 * 三段状态机：flyin(1.2s) → hold(2s 呼吸) → release(0.6s 回物理)
 */
var MeshReformer = function () {
  this.phase = 'idle';
  this.elapsed = 0;
  this.targets = [];
  this.links = [];   // 星座连线（目标点最近邻对）
  this.maxDelay = 0; // flyin 错峰的最大延迟
  this.enabled = false;
};

var MESH_PATTERNS = (function () {
  var spiral = [];
  var a, i;
  for (a = 0; a < 3; a++) {
    for (i = 0; i < 20; i++) {
      var st = i / 20;
      var angle = (a / 3) * Math.PI * 2 + st * Math.PI * 2;
      var r = st * 0.35;
      spiral.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    }
  }

  var circle = [];
  for (var ring = 1; ring <= 5; ring++) {
    var count = 8 + ring * 4;
    for (var c = 0; c < count; c++) {
      var ca = (c / count) * Math.PI * 2;
      var cr = (ring / 5) * 0.35;
      circle.push({ x: Math.cos(ca) * cr, y: Math.sin(ca) * cr });
    }
  }

  return {
    bigDipper: [
      { x: -0.2, y: 0.15 }, { x: -0.1, y: 0.12 }, { x: 0.0, y: 0.1 }, { x: 0.1, y: 0.12 },
      { x: 0.22, y: 0.05 }, { x: 0.3, y: -0.05 }, { x: 0.35, y: -0.18 }
    ],
    orion: [
      { x: -0.15, y: -0.25 }, { x: 0.15, y: -0.25 },
      { x: -0.05, y: 0.0 }, { x: 0.05, y: 0.0 },
      { x: -0.15, y: 0.25 }, { x: 0.15, y: 0.25 }
    ],
    spiral: spiral,
    letterM: [
      { x: -0.3, y: -0.25 }, { x: -0.3, y: 0.25 },
      { x: -0.18, y: -0.15 }, { x: -0.18, y: 0.25 },
      { x: -0.05, y: 0.05 }, { x: -0.05, y: 0.25 },
      { x: 0.05, y: 0.05 }, { x: 0.05, y: 0.25 },
      { x: 0.18, y: -0.15 }, { x: 0.18, y: 0.25 },
      { x: 0.3, y: -0.25 }, { x: 0.3, y: 0.25 }
    ],
    circle: circle
  };
})();

var MESH_FLY_TIME = 1.2;
var MESH_HOLD_TIME = 2.0;
var MESH_RELEASE_TIME = 0.6;

function meshEaseInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function meshEaseIn(t) {
  return t * t;
}

MeshReformer.prototype.setEnabled = function (v) {
  this.enabled = !!v;
  if (!this.enabled) this.cancel();
};

MeshReformer.prototype.isActive = function () {
  return this.phase !== 'idle';
};

MeshReformer.prototype.getPhase = function () {
  return this.phase;
};

MeshReformer.prototype.getElapsedInPhase = function () {
  return this.elapsed;
};

MeshReformer.prototype.getProgress = function () {
  if (this.phase === 'flyin') return meshEaseInOutCubic(Math.min(1, this.elapsed / MESH_FLY_TIME));
  if (this.phase === 'hold') return Math.min(1, this.elapsed / MESH_HOLD_TIME);
  if (this.phase === 'release') return meshEaseIn(Math.min(1, this.elapsed / MESH_RELEASE_TIME));
  return 0;
};

/** 带延迟的飞行进度：错峰入场用（最近的粒子先到，远的一圈圈跟上） */
MeshReformer.prototype.getFlyProgress = function (delaySec) {
  var t = (this.elapsed - (delaySec || 0)) / MESH_FLY_TIME;
  if (t <= 0) return 0;
  return meshEaseInOutCubic(Math.min(1, t));
};

/** 开始重组，返回目标点绝对坐标 */
MeshReformer.prototype.trigger = function (pattern, width, height) {
  if (!this.enabled) return [];
  var points = MESH_PATTERNS[pattern] || MESH_PATTERNS.circle;
  var cx = width / 2;
  var cy = height / 2;
  var scale = Math.min(width, height);

  this.targets = points.map(function (p) {
    return { x: cx + p.x * scale, y: cy + p.y * scale };
  });
  this.maxDelay = 0;
  this.links = this.buildLinks(this.targets);
  this.phase = 'flyin';
  this.elapsed = 0;
  return this.targets;
};

/** 星座连线：每个目标点连最近的 2 个邻点（去重），hold 阶段淡入 */
MeshReformer.prototype.buildLinks = function (targets) {
  var links = [];
  if (!targets || targets.length < 2) return links;
  var seen = {};
  for (var i = 0; i < targets.length; i++) {
    // 找 i 的两个最近邻
    var nearest = [];
    for (var j = 0; j < targets.length; j++) {
      if (j === i) continue;
      var dx = targets[j].x - targets[i].x;
      var dy = targets[j].y - targets[i].y;
      nearest.push({ j: j, d2: dx * dx + dy * dy });
    }
    nearest.sort(function (a, b) { return a.d2 - b.d2; });
    for (var k = 0; k < Math.min(2, nearest.length); k++) {
      var a = Math.min(i, nearest[k].j), b = Math.max(i, nearest[k].j);
      var key = a + '-' + b;
      if (!seen[key]) {
        seen[key] = 1;
        links.push([a, b]);
      }
    }
  }
  return links;
};

/** 最近且未满员的目标点 + 8–14px 抖动，形成星团感。
 *  返回值带 delay：按粒子到目标的距离分 4 批（近的先飞，每批错 60ms），
 *  flyin 从「全体同时到齐」变成「一圈圈长出来」。 */
MeshReformer.prototype.assign = function (particles) {
  var n = this.targets.length;
  if (n === 0) return [];
  var capacity = Math.max(1, Math.ceil(particles.length / n));
  var used = new Array(n);
  for (var u = 0; u < n; u++) used[u] = 0;

  var out = particles.map(function (p) {
    var best = -1;
    var bestDist = Infinity;
    for (var i = 0; i < n; i++) {
      if (used[i] >= capacity) continue;
      var dx = this.targets[i].x - p.x;
      var dy = this.targets[i].y - p.y;
      var d2 = dx * dx + dy * dy;
      if (d2 < bestDist) {
        bestDist = d2;
        best = i;
      }
    }
    if (best < 0) best = 0;
    used[best]++;

    var jitter = 8 + Math.random() * 6;
    return {
      x: this.targets[best].x + (Math.random() * 2 - 1) * jitter,
      y: this.targets[best].y + (Math.random() * 2 - 1) * jitter,
      d2: bestDist
    };
  }, this);

  // 距离归一化分 4 批：batch 0（最近）延迟 0，batch 3 延迟 180ms
  var dMin = Infinity, dMax = 0, i;
  for (i = 0; i < out.length; i++) {
    if (out[i].d2 < dMin) dMin = out[i].d2;
    if (out[i].d2 > dMax) dMax = out[i].d2;
  }
  var span = dMax - dMin;
  this.maxDelay = 0;
  for (i = 0; i < out.length; i++) {
    var batch = span > 0 ? Math.min(3, Math.floor((out[i].d2 - dMin) / span * 4)) : 0;
    out[i].delay = batch * 0.06;
    if (out[i].delay > this.maxDelay) this.maxDelay = out[i].delay;
  }
  return out;
};

MeshReformer.prototype.update = function (dt) {
  if (this.phase === 'idle') return;
  this.elapsed += Math.min(dt || 0, 0.05);

  // flyin 总时长 = 基础飞行 + 最大错峰延迟，保证最后一批也飞完
  if (this.phase === 'flyin' && this.elapsed >= MESH_FLY_TIME + (this.maxDelay || 0)) {
    this.phase = 'hold';
    this.elapsed = 0;
  } else if (this.phase === 'hold' && this.elapsed >= MESH_HOLD_TIME) {
    this.phase = 'release';
    this.elapsed = 0;
  } else if (this.phase === 'release' && this.elapsed >= MESH_RELEASE_TIME) {
    this.cancel();
  }
};

MeshReformer.prototype.cancel = function () {
  this.phase = 'idle';
  this.elapsed = 0;
  this.targets = [];
  this.links = [];
  this.maxDelay = 0;
};

/**
 * particleSystem.js — 粒子系统（mikutap v3 移植，PIXI v6）
 * 对象池 / 空间网格 / 无残迹拖尾 / 引力 / 连线 / FlowField / Mesh / Metaball
 * 所有物理量按「秒」计算，调用方传入 dt（秒）。
 */
var PARTICLE_MAX = 1500;
var PARTICLE_CELL = 80;
var PARTICLE_LINK2 = 100 * 100;
var PARTICLE_ATTRACT2 = 50 * 50;
var LINK_SEGMENTS_MAX = 600;

// 重力场：捕获半径 / 环绕两圈（放慢转速）/ 收心
var CAPTURE_RATIO = 0.24;
var CAP_ORBIT_TIME = 3.6;
var CAP_SINK_TIME = 1.0;
var CAP_TURNS = 2;
var CAP_MIN_AGE = 0.4;   // 出生后先让初速飞一会儿，再进入捕获
var CAP_PULL = 0.1;      // 径向加速度（px/帧²），只叠加、不改写初速度
// 鼠标斥力：影响半径 / 推力
var REPEL_RADIUS = 200;
var REPEL_FORCE = 0.22;

var ParticleSystem = function (container, theme) {
  this.graphics = new PIXI.Graphics();
  container.addChild(this.graphics);

  this.metaballSprite = null;
  this.metaball = null;
  try {
    this.metaball = new MetaballRenderer(window.innerWidth, window.innerHeight, theme);
    var canvas = this.metaball.getCanvas();
    this.metaballSprite = new PIXI.Sprite(PIXI.Texture.from(canvas));
    this.metaballSprite.scale.set(this.metaball.getScale());
    this.metaballSprite.visible = false;
    container.addChild(this.metaballSprite);
  } catch (e) {
    console.warn('Metaball 初始化失败，已跳过:', e);
    this.metaball = null;
    this.metaballSprite = null;
  }

  this.particles = [];
  this.pool = [];
  this.nextId = 1;
  this.metaBuf = [];
  this.frame = 0;
  this.reducedMotion = false;
  this._releaseApplied = false;

  this.theme = theme;
  this.params = { density: 6, speed: 5, lifetime: 3, attract: 0.5, trailAlpha: 0.15 };
  // 鼠标斥力：局部坐标 + 衰减强度（鼠标移动时重置为 1）
  this.repel = { x: 0, y: 0, power: 0 };
  this.effects = {
    particles: true,
    trail: true,
    links: false,
    gravity: false,
    gravityField: false,
    flowField: false,
    meshReform: false,
    metaball: false
  };

  this.width = 0;
  this.height = 0;

  this.grid = {};
  this.gridCols = 1;
  this.gridRows = 1;

  this.flowField = new FlowField();
  this.meshReformer = new MeshReformer();
};

ParticleSystem.prototype.resize = function (w, h) {
  this.width = w;
  this.height = h;
  if (this.metaball) {
    this.metaball.resize(w, h);
    if (this.metaballSprite) this.metaballSprite.scale.set(this.metaball.getScale());
  }
};

ParticleSystem.prototype.setTheme = function (theme) {
  if (theme && this.particles.length > 0) {
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      if (!p.active) continue;
      p.targetColor = theme.particles[Math.floor(Math.random() * theme.particles.length)];
      p.colorT = 0;
    }
  }
  this.theme = theme;
  if (this.metaball) this.metaball.setTheme(theme);
};

ParticleSystem.prototype.setParams = function (params) {
  if (!params) return;
  for (var k in params) {
    if (Object.prototype.hasOwnProperty.call(params, k)) this.params[k] = params[k];
  }
};

ParticleSystem.prototype.setEffects = function (effects) {
  if (!effects) return;
  for (var k in effects) {
    if (Object.prototype.hasOwnProperty.call(effects, k)) this.effects[k] = effects[k];
  }
  // 关闭重力场：把环绕中的粒子放回自由物理
  if (!this.effects.gravityField) {
    for (var i = 0; i < this.particles.length; i++) {
      this.releaseCaptured(this.particles[i]);
    }
  }
  this.flowField.setEnabled(this.effects.flowField);
  this.meshReformer.setEnabled(this.effects.meshReform);
  if (this.metaball) this.metaball.setEnabled(this.effects.metaball);
  if (!this.effects.metaball && this.metaballSprite) this.metaballSprite.visible = false;
};

ParticleSystem.prototype.setReducedMotion = function (v) {
  this.reducedMotion = !!v;
};

ParticleSystem.prototype.emit = function (x, y) {
  if (!this.effects.particles) return;
  var room = PARTICLE_MAX - this.particles.length;
  if (room <= 0) return;

  var requested = Math.floor(this.params.density * 10 * (this.reducedMotion ? 0.4 : 1));
  var count = Math.min(requested, room);

  for (var i = 0; i < count; i++) {
    var angle = Math.random() * Math.PI * 2;
    var speed = (Math.random() * 4 + 1) * this.params.speed * 0.5;
    var life = (Math.random() * 2 + 1) * this.params.lifetime;
    var p = this.obtainParticle();

    p.id = this.nextId++;
    p.x = x;
    p.y = y;
    p.hx = x;
    p.hy = y;
    p.vx = Math.cos(angle) * speed;
    p.vy = Math.sin(angle) * speed;
    p.life = life;
    p.maxLife = life;
    p.baseSize = Math.random() * 4 + 2;
    p.size = p.baseSize;
    p.color = this.theme.particles[Math.floor(Math.random() * this.theme.particles.length)];
    p.alpha = 1;
    p.active = true;
    p.targetColor = undefined;
    p.colorT = undefined;
    p.meshFrom = undefined;
    p.meshTo = undefined;
    p.consumed = false;
    p.ambient = false;
    p.age = 0;
    p.captured = false;
    p.capT = 0;
    p.capR = 0;
    p.capAngle = 0;
    this.particles.push(p);
  }
};

ParticleSystem.prototype.emitAmbient = function (x, y, energy) {
  if (!this.effects.particles) return;
  if (this.particles.length >= PARTICLE_MAX) return;

  var angle = Math.random() * Math.PI * 2;
  var speed = (0.4 + Math.random() * 0.8) * Math.max(0.4, this.params.speed / 5);
  var life = 3 + Math.random() * 2;
  var p = this.obtainParticle();

  p.id = this.nextId++;
  p.x = x;
  p.y = y;
  p.hx = x;
  p.hy = y;
  p.vx = Math.cos(angle) * speed;
  p.vy = Math.sin(angle) * speed;
  p.life = life;
  p.maxLife = life;
  p.baseSize = 1 + Math.random() * 2;
  p.size = p.baseSize;
  p.color = this.theme.particles[Math.floor(Math.random() * this.theme.particles.length)];
  p.alpha = 0.4 + (energy || 0) * 0.5;
  p.active = true;
  p.targetColor = undefined;
  p.colorT = undefined;
  p.meshFrom = undefined;
  p.meshTo = undefined;
  p.consumed = false;
  p.ambient = true;
  p.age = 0;
  p.captured = false;
  p.capT = 0;
  p.capR = 0;
  p.capAngle = 0;
  this.particles.push(p);
};

/** 空格触发：把所有活跃粒子吸到随机星座图案 */
ParticleSystem.prototype.triggerMesh = function (pattern) {
  if (!this.effects.meshReform) return;
  var targets = this.meshReformer.trigger(pattern, this.width, this.height);
  if (targets.length === 0) return;

  var active = [];
  for (var i = 0; i < this.particles.length; i++) {
    if (this.particles[i].active) active.push(this.particles[i]);
  }
  if (active.length === 0) return;

  var assigned = this.meshReformer.assign(active);
  for (var j = 0; j < active.length; j++) {
    active[j].meshFrom = { x: active[j].x, y: active[j].y };
    active[j].meshTo = assigned[j];
  }
  this._releaseApplied = false;
};

ParticleSystem.prototype.update = function (dt) {
  dt = Math.min(dt || 0, 0.05);
  this.frame++;

  // 鼠标斥力衰减：移动时被 reset 到 1，停下后约 0.5s 内消退
  this.repel.power += (0 - this.repel.power) * (1 - Math.exp(-2.5 * dt));

  this.flowField.update(dt);
  this.meshReformer.update(dt);

  var phase = this.meshReformer.getPhase();
  var meshOn = this.effects.meshReform && this.meshReformer.isActive();
  if (meshOn && phase === 'release' && !this._releaseApplied) {
    this.applyMeshRelease();
    this._releaseApplied = true;
  }

  var useLinks = this.effects.links;
  // 粒子引力 = 粒子之间相互聚拢（与 mikutap 一致），高密度下关闭
  var attractOn = this.effects.gravity && this.particles.length < 1200;
  if (useLinks || attractOn) this.rebuildGrid();

  var g = this.graphics;
  g.clear();
  this.metaBuf.length = 0;

  var useMeta = this.effects.metaball && !!this.metaballSprite;
  var arr = this.particles;
  // 高密度下省掉额外辉光圈，把预算留给主体和拖尾
  this._dense = arr.length > 900;

  for (var i = 0; i < arr.length; i++) {
    var p = arr[i];
    if (!p.active) continue;
    p.age = (p.age || 0) + dt;

    if (meshOn && p.meshTo && p.meshFrom) {
      if (phase === 'flyin') {
        var e = this.meshReformer.getProgress();
        p.x = p.meshFrom.x + (p.meshTo.x - p.meshFrom.x) * e;
        p.y = p.meshFrom.y + (p.meshTo.y - p.meshFrom.y) * e;
        p.vx = 0;
        p.vy = 0;
      } else if (phase === 'hold') {
        var ht = this.meshReformer.getElapsedInPhase();
        p.x = p.meshTo.x + Math.sin(ht * 2.2 + (p.id % 11)) * 2;
        p.y = p.meshTo.y + Math.cos(ht * 1.9 + (p.id % 7)) * 2;
        p.vx = 0;
        p.vy = 0;
      }
    } else if (p.captured && this.effects.gravityField) {
      // 重力场：锁定在螺旋轨道上（两圈后坠入中心）
      this.updateSpiral(p, dt);
    } else {
      if (p.captured) this.releaseCaptured(p); // 重力场中途关闭
      if (this.effects.flowField) this.flowField.applyForce(p, dt);
      if (this.effects.gravityField && !p.ambient) this.applyCenterGravity(p, dt);
      if (attractOn) this.applyAttraction(p);
      this.applyMouseRepel(p, dt);

      var drag = Math.pow(0.985, dt * 60);
      p.vx *= drag;
      p.vy *= drag;
      var step = dt * 60;
      p.x += p.vx * step;
      p.y += p.vy * step;
    }

    // 边界反弹
    if (p.x < 0) { p.x = 0; p.vx *= -0.5; }
    if (p.x > this.width) { p.x = this.width; p.vx *= -0.5; }
    if (p.y < 0) { p.y = 0; p.vy *= -0.5; }
    if (p.y > this.height) { p.y = this.height; p.vy *= -0.5; }

    // 寿命
    p.life -= dt;
    var t = Math.max(0, p.life / p.maxLife);
    p.alpha = t;
    p.size = Math.max(0.5, p.baseSize * (0.5 + t * 0.5));

    if (p.life <= 0) {
      p.active = false;
      continue;
    }

    // 主题色平滑过渡
    if (p.targetColor !== undefined && p.colorT !== undefined) {
      p.colorT = Math.min(1, p.colorT + dt * 2);
      if (p.colorT < 1) {
        p.color = this.lerpColor(p.color, p.targetColor, p.colorT);
      } else {
        p.color = p.targetColor;
        p.targetColor = undefined;
        p.colorT = undefined;
      }
    }

    // 拖尾历史点
    var follow = this.effects.trail ? (1 - Math.exp(-8 * dt)) : 1;
    p.hx += (p.x - p.hx) * follow;
    p.hy += (p.y - p.hy) * follow;

    if (useMeta) {
      this.metaBuf.push({ x: p.x, y: p.y, size: p.size, alpha: p.alpha });
    } else {
      this.drawParticle(p);
    }
  }

  if (useLinks) this.drawLinks();
  this.renderMetaball();
  this.compact();
};

ParticleSystem.prototype.drawParticle = function (p) {
  var g = this.graphics;
  if (this.effects.trail && p.alpha > 0.25 && p.size > 2) {
    var trailA = p.alpha * Math.max(0.08, (this.params.trailAlpha || 0.15) * 2);
    g.lineStyle(Math.max(0.8, p.size * 0.9), p.color, trailA);
    g.moveTo(p.hx, p.hy);
    g.lineTo(p.x, p.y);
    g.lineStyle(0);
  }
  g.beginFill(p.color, p.alpha);
  g.drawCircle(p.x, p.y, p.size);
  g.endFill();
  if (!this._dense && p.size > 3.2) {
    g.beginFill(p.color, p.alpha * 0.12);
    g.drawCircle(p.x, p.y, p.size * 2);
    g.endFill();
  }
};

/* ---------------- 空间网格 ---------------- */

ParticleSystem.prototype.rebuildGrid = function () {
  this.grid = {};
  this.gridCols = Math.max(1, Math.ceil(this.width / PARTICLE_CELL));
  this.gridRows = Math.max(1, Math.ceil(this.height / PARTICLE_CELL));
  for (var i = 0; i < this.particles.length; i++) {
    var p = this.particles[i];
    if (!p.active) continue;
    var key = this.cellKey(p.x, p.y);
    if (!this.grid[key]) this.grid[key] = [];
    this.grid[key].push(p);
  }
};

ParticleSystem.prototype.cellKey = function (x, y) {
  var cx = Math.max(0, Math.min(this.gridCols - 1, Math.floor(x / PARTICLE_CELL)));
  var cy = Math.max(0, Math.min(this.gridRows - 1, Math.floor(y / PARTICLE_CELL)));
  return cy * this.gridCols + cx;
};

ParticleSystem.prototype.forEachNeighbor = function (p, cb) {
  var cx = Math.max(0, Math.min(this.gridCols - 1, Math.floor(p.x / PARTICLE_CELL)));
  var cy = Math.max(0, Math.min(this.gridRows - 1, Math.floor(p.y / PARTICLE_CELL)));
  for (var dy = -1; dy <= 1; dy++) {
    var ry = cy + dy;
    if (ry < 0 || ry >= this.gridRows) continue;
    for (var dx = -1; dx <= 1; dx++) {
      var rx = cx + dx;
      if (rx < 0 || rx >= this.gridCols) continue;
      var bucket = this.grid[ry * this.gridCols + rx];
      if (!bucket) continue;
      for (var k = 0; k < bucket.length; k++) cb(bucket[k]);
    }
  }
};

/** 重力场：先把飞溅粒子牵引到捕获半径，进入后转入螺旋轨道 */
ParticleSystem.prototype.applyCenterGravity = function (p, dt) {
  var cx = this.width / 2;
  var cy = this.height / 2;
  var dx = cx - p.x;
  var dy = cy - p.y;
  var d2 = dx * dx + dy * dy;
  if (d2 < 1) return;

  var d = Math.sqrt(d2);
  // 只叠加径向加速度：保留粒子飞溅的原始初速度，不做速度改写/阻尼
  var pull = CAP_PULL * dt * 60;
  p.vx += (dx / d) * pull;
  p.vy += (dy / d) * pull;

  // 出生后先飞一小段，再进入捕获半径锁定螺旋轨道
  var captureR = Math.min(this.width, this.height) * CAPTURE_RATIO;
  if (d < captureR && p.age > CAP_MIN_AGE && !p.captured) {
    p.captured = true;
    p.capT = 0;
    p.capR = Math.max(d, captureR * 0.35);
    p.capAngle = Math.atan2(p.y - cy, p.x - cx);
    // 保证两圈能转完；同步抬高 maxLife，避免亮度突变
    var need = CAP_ORBIT_TIME + CAP_SINK_TIME + 0.12;
    if (p.life < need) {
      var extra = need - p.life;
      p.life = need;
      p.maxLife += extra;
    }
  }
};

/** 螺旋轨道：前 2.0s 匀速环绕两圈，再 0.7s 加速坠入中心 */
ParticleSystem.prototype.updateSpiral = function (p, dt) {
  var cx = this.width / 2;
  var cy = this.height / 2;
  var total = CAP_ORBIT_TIME + CAP_SINK_TIME;

  p.vx = 0;
  p.vy = 0;
  if (p.capT < total) p.capT = Math.min(total, p.capT + dt);

  if (p.capT <= CAP_ORBIT_TIME) {
    var t = p.capT / CAP_ORBIT_TIME;
    var orbitAngle = p.capAngle + CAP_TURNS * Math.PI * 2 * t;
    var orbitR = p.capR * (1 - 0.4 * t);
    p.x = cx + Math.cos(orbitAngle) * orbitR;
    p.y = cy + Math.sin(orbitAngle) * orbitR;
    return;
  }

  var u = Math.min(1, (p.capT - CAP_ORBIT_TIME) / CAP_SINK_TIME);
  // 角速度与环绕段末端衔接，继续朝同一方向旋转
  var sinkAngle = p.capAngle + CAP_TURNS * Math.PI * 2
    + CAP_TURNS * Math.PI * 2 * (u * CAP_SINK_TIME / CAP_ORBIT_TIME);
  var sinkR = p.capR * 0.6 * (1 - u) * (1 - u);
  p.x = cx + Math.cos(sinkAngle) * sinkR;
  p.y = cy + Math.sin(sinkAngle) * sinkR;

  if (u >= 1) {
    // 抵达中心：停在核心并淡出（保持 captured，避免被重复捕获）
    p.x = cx;
    p.y = cy;
    p.capT = total;
    p.life = Math.min(p.life, 0.12);
  }
};

/** 关闭重力场时把环绕中的粒子放回自由物理：切向 + 轻微外扩 */
ParticleSystem.prototype.releaseCaptured = function (p) {
  if (!p.captured) return;
  p.captured = false;
  var ang = Math.atan2(p.y - this.height / 2, p.x - this.width / 2);
  var speed = 1.5 + Math.random();
  p.vx = Math.cos(ang) * speed - Math.sin(ang) * speed * 0.6;
  p.vy = Math.sin(ang) * speed + Math.cos(ang) * speed * 0.6;
};

/** 鼠标斥力：记录局部坐标并重置推力（移动时持续触发） */
ParticleSystem.prototype.setRepel = function (x, y) {
  this.repel.x = x;
  this.repel.y = y;
  this.repel.power = 1;
};

/** 鼠标斥力：光标半径内把粒子向外推开，形成荡漾涟漪 */
ParticleSystem.prototype.applyMouseRepel = function (p, dt) {
  if (this.repel.power < 0.02) return;
  var dx = p.x - this.repel.x;
  var dy = p.y - this.repel.y;
  var d2 = dx * dx + dy * dy;
  if (d2 >= REPEL_RADIUS * REPEL_RADIUS || d2 < 0.01) return;

  var d = Math.sqrt(d2);
  var falloff = 1 - d / REPEL_RADIUS;
  var push = REPEL_FORCE * this.repel.power * falloff * falloff * dt * 60;
  p.vx += (dx / d) * push;
  p.vy += (dy / d) * push;
};

ParticleSystem.prototype.applyAttraction = function (p) {
  var strength = this.params.attract;
  if (!strength) return;
  this.forEachNeighbor(p, function (other) {
    if (!other.active || other.id < p.id) return;
    var dx = other.x - p.x;
    var dy = other.y - p.y;
    var d2 = dx * dx + dy * dy;
    if (d2 > PARTICLE_ATTRACT2 || d2 < 0.01) return;
    var force = 0.008 * strength / Math.sqrt(d2);
    p.vx += dx * force;
    p.vy += dy * force;
    other.vx -= dx * force;
    other.vy -= dy * force;
  });
};

ParticleSystem.prototype.drawLinks = function () {
  var g = this.graphics;
  var segments = 0;
  var palette = (this.theme && this.theme.particles) || [0xffffff];
  g.lineStyle(0.8, palette[0], 0.32);

  var self = this;
  var limit = Math.min(this.particles.length, 800);
  for (var i = 0; i < limit; i++) {
    if (segments >= LINK_SEGMENTS_MAX) break;
    var p = this.particles[i];
    if (!p.active || p.captured) continue;
    (function (a) {
      self.forEachNeighbor(a, function (b) {
        if (segments >= LINK_SEGMENTS_MAX) return;
        if (!b.active || b.id <= a.id || b.captured) return;
        var dx = b.x - a.x;
        var dy = b.y - a.y;
        if (dx * dx + dy * dy >= PARTICLE_LINK2) return;
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        segments++;
      });
    })(p);
  }
};

/* ---------------- Metaball ---------------- */

ParticleSystem.prototype.renderMetaball = function () {
  var sprite = this.metaballSprite;
  if (!sprite || !this.metaball) return;

  if (!this.effects.metaball || this.metaBuf.length === 0) {
    sprite.visible = false;
    return;
  }

  this.metaball.render(this.metaBuf);
  sprite.texture.baseTexture.update();
  sprite.visible = true;
};

/* ---------------- Mesh 释放 ---------------- */

ParticleSystem.prototype.applyMeshRelease = function () {
  var cx = this.width / 2;
  var cy = this.height / 2;
  for (var i = 0; i < this.particles.length; i++) {
    var p = this.particles[i];
    if (!p.meshTo) continue;
    var dx = p.x - cx;
    var dy = p.y - cy;
    var d = Math.sqrt(dx * dx + dy * dy) || 1;
    var speed = 2 + Math.random() * 2;
    p.vx = (dx / d) * speed + (Math.random() - 0.5) * 2;
    p.vy = (dy / d) * speed + (Math.random() - 0.5) * 2;
    p.meshTo = undefined;
    p.meshFrom = undefined;
  }
};

/* ---------------- 对象池 ---------------- */

/** 点击画布：立即打断星座重组，粒子按径向散开 */
ParticleSystem.prototype.cancelMesh = function () {
  if (!this.meshReformer.isActive()) return;
  this.applyMeshRelease();
  this.meshReformer.cancel();
  this._releaseApplied = true;
};

ParticleSystem.prototype.obtainParticle = function () {
  var pooled = this.pool.pop();
  if (pooled) return pooled;
  return {
    id: 0, x: 0, y: 0, hx: 0, hy: 0, vx: 0, vy: 0,
    life: 0, maxLife: 1, size: 1, baseSize: 1, color: 0xffffff,
    alpha: 0, active: false, ambient: false, consumed: false, age: 0,
    captured: false, capT: 0, capR: 0, capAngle: 0
  };
};

ParticleSystem.prototype.compact = function () {
  var arr = this.particles;
  var write = 0;
  for (var i = 0; i < arr.length; i++) {
    var p = arr[i];
    if (p.active) {
      arr[write++] = p;
    } else {
      p.meshFrom = undefined;
      p.meshTo = undefined;
      this.pool.push(p);
    }
  }
  arr.length = write;
};

ParticleSystem.prototype.clear = function () {
  for (var i = 0; i < this.particles.length; i++) {
    this.pool.push(this.particles[i]);
  }
  this.particles = [];
  this.metaBuf.length = 0;
  this.meshReformer.cancel();
  this._releaseApplied = false;
  this.repel.power = 0;
  if (this.metaballSprite) this.metaballSprite.visible = false;
  this.graphics.clear();
};

ParticleSystem.prototype.lerpColor = function (from, to, t) {
  var r = Math.round(((from >> 16) & 0xff) + (((to >> 16) & 0xff) - ((from >> 16) & 0xff)) * t);
  var g = Math.round(((from >> 8) & 0xff) + (((to >> 8) & 0xff) - ((from >> 8) & 0xff)) * t);
  var b = Math.round((from & 0xff) + ((to & 0xff) - (from & 0xff)) * t);
  return (r << 16) | (g << 8) | b;
};

ParticleSystem.prototype.getActiveCount = function () {
  return this.particles.length;
};

/**
 * 主控制器 - 星海共振
 * 整合：PIXI 渲染器 + 音频合成 + 粒子 + 波纹 + 频谱
 * 管理：场景切换 / 事件绑定 / 游戏循环 / 设置面板
 */
$(function () {
  // ===== UI 层：主题变量 / 欢迎页星空 / 面板焦点（与 mikutap-app 对齐） =====

  function hexColor(n) {
    return '#' + ('000000' + (n >>> 0).toString(16)).slice(-6);
  }

  function rgbaColor(n, a) {
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // 当前主题主色：光标流星在渲染循环里读取它同步配色（跨作用域传递用）
  var uiAccent = 0x00f0ff;

  function applyUiTheme(theme) {
    if (!theme) return;
    var accent = theme.accent || (theme.particles && theme.particles[0]) || 0x00f0ff;
    var bg = theme.background == null ? 0x0a0420 : theme.background;
    var root = document.documentElement.style;
    root.setProperty('--accent', hexColor(accent));
    root.setProperty('--accent-line', rgbaColor(accent, 0.22));
    root.setProperty('--accent-soft', rgbaColor(accent, 0.12));
    root.setProperty('--bg-deep', hexColor(bg));
    root.setProperty('--bg-panel', rgbaColor(bg, 0.95));
    // 光标流星跟随主题换色
    root.setProperty('--cursor-rgb', ((accent >> 16) & 255) + ',' + ((accent >> 8) & 255) + ',' + (accent & 255));
    uiAccent = accent;
  }

  function buildWelcomeStars() {
    var host = document.getElementById('welcome-stars');
    if (!host) return;
    var frag = document.createDocumentFragment();
    var count = 48 + Math.floor(Math.random() * 12);
    for (var i = 0; i < count; i++) {
      var star = document.createElement('span');
      star.className = 'star';
      var bright = Math.random() < 0.14;
      var size = bright ? 2 + Math.random() * 1.6 : 1 + Math.random() * 0.8;
      star.style.width = size + 'px';
      star.style.height = size + 'px';
      star.style.left = (Math.random() * 100) + '%';
      star.style.top = (Math.random() * 100) + '%';
      star.style.animationDelay = (Math.random() * 3) + 's';
      star.style.animationDuration = (2.6 + Math.random() * 3) + 's';
      if (bright) star.classList.add('star-bright');
      frag.appendChild(star);
    }
    host.appendChild(frag);
  }

  var MainManager = function () {
    var self = this;
    var windowWidth, windowHeight;
    var renderer, renderContainer, stage;
    var audio, djFx, netease, playerCard, particles, ripple, spectrum, grid, starfield;
    var bgLayer = null, bgContainer = null; // 背景模式系统（渲染树最底层）
    var coreLayer = null; // 中心特效层（流体核心 / 音频多面体 / 关闭）
    var lyricStage = null; // 主舞台歌词演出层（经典单行 / 逐字点亮 / 关闭）
    var bloomFilter = null;
    var themeId = 'nebula';
    var particleParams = { density: 6, speed: 5, lifetime: 3, attract: 0.5, trailAlpha: 0.15 };
    var fx = {
      starfield: true,
      gravity: false,
      gravityField: false,
      flowField: false,
      meshReform: false,
      metaball: false
    };
    var dragging = false;
    var lastNoteId = -1;
    var lowFreqValue = 0;
    var lastEmitTime = 0;
    var djStarted = false; // BGM 是否已启动（首次手势后）
    var lastCellKey = ''; // 拖拽时上次所在的方块，用于"扫过方块发声"
    var lastPtrX = 0, lastPtrY = 0, lastPtrT = 0; // 指针速度采样（输入指纹）
    var dragVel = 1; // 拖拽力度 0.55–1.0（速度映射，低通平滑）；点击恒 1
    var pulseToggleEl = document.getElementById('toggle-pulse'); // 主循环每帧读取，用原生属性代替 jQuery 查询
    var lastBassBurst = 0; // 低音爆发模组的节流时间戳
    var lastBassStep = -1; // bass-explode 上一次触发的小节头 stepIndex
    var lastStepIndex = -1; // 上一帧步序号（检测跨步，切歌/断网格重置）
    var pulseAmp = 0; // 网格脉冲包络幅度
    var reducedMotion = false; // 尊重系统「减少动效」
    var ambientFlip = false; // cover-ambient 模组隔帧发射（控制稳态粒子数）
    var prevLo = 0; // 上一帧低频值（bass-explode 上升沿检测）
    var aiThemeEnabled = true; // 播放器右侧面板可关闭 AI 主题自动应用
    var gameStarted = false; // 欢迎页是否已完成退场
    var focusBeforePanel = null; // 面板关闭后焦点归还
    var inertedSiblings = []; // 窗口打开时被 inert 的兄弟节点
    // 自定义光标（3D 星晶体 + 拖尾）
    var trailCanvas = null;         // 光标画布：星体、光尾、火星都画在这里
    var trailCtx = null;
    var trailDpr = 1;
    var trailSprite = null;         // 预渲染光斑，绘制时只做 drawImage 缩放
    var trailRGB = '0,240,255';     // 主题 accent（棱线/光尾/轨道都用它）
    var trailAccent = -1;           // 已应用的主题色（检测变化，切主题时换色）
    var TRAIL_N = 18;               // 链条节点数（越多尾巴越长越软）
    var trailPX = [], trailPY = [];
    var trailPrimed = false;        // 首次出现时整条尾巴就位
    var trailBox = null;            // 上一帧的清除包围盒（只清脏区，不全屏擦）
    var sparkPool = [];             // 火星池（固定分配，无运行时 GC）
    var sparkPtr = 0;
    var trailTime = 0;
    var cursorActive = false;       // 是否启用（仅精确指针设备）
    var cursorOn = false;           // 当前是否应显示（进出窗口 / 进入输入框）
    var cursorHover = false;        // 当前悬停可交互元素
    var cursorHoverScale = 1;       // hover 时的放大系数（平滑过渡）
    var cursorVis = 0;              // 可见度 0..1（淡入淡出）
    var cursorTx = 0, cursorTy = 0; // 指针原始坐标（星体 0 延迟跟随）
    var camX = 0, camY = 0;         // 视差「相机」（-1..1，低通跟随指针）
    var cursorBreath = 0;           // 拍点呼吸包络
    var cursorPop = 0;              // 点击脉冲
    var starRotY = 0;               // 星晶体自转角 Y
    var starRotX = 0.42;            // 星晶体倾角 X
    // 星形多面体（stella octangula）：两个交错的正四面体，8 顶点 12 棱
    var STAR_VERTS = [
      [1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1],
      [-1, -1, -1], [-1, 1, 1], [1, -1, 1], [1, 1, -1]
    ];
    var STAR_EDGES = [
      [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3],
      [4, 5], [4, 6], [4, 7], [5, 6], [5, 7], [6, 7]
    ];
    var STAR_P = [];                // 投影后的顶点（预分配复用，避免每帧 new）
    var STAR_ORDER = [];            // 棱的深度排序槽（预分配复用）
    for (var _si = 0; _si < 8; _si++) STAR_P.push({ x: 0, y: 0, z: 0, k: 1 });
    for (_si = 0; _si < 12; _si++) STAR_ORDER.push({ i: _si, d: 0 });
    // 轨道：两道倾斜的椭圆环，环上各有一颗小星绕行（远近决定明暗）
    var ORBIT_DEFS = [
      { r: 13.5, tilt: 0.42, squash: 0.42, speed: 0.75, phase: 0 },
      { r: 10.5, tilt: -0.95, squash: 0.55, speed: -1.1, phase: 2.1 }
    ];
    var currentSettingsPane = 'bg';
    var showSettingsPane = null;
    // 背景色过渡
    var currentBg = getTheme(themeId).background;
    var targetBg = currentBg;

    /** 自定义光标：3D 星晶体 + 拖尾。
     *  系统光标仅在精确指针设备上隐藏（html.star-cursor-on），脚本异常时自动退回默认箭头。
     *  星体 0 延迟跟随指针，中心亮核保证点击精度；光尾用链条模型绘制。 */
    function initStarCursor() {
      trailCanvas = document.getElementById('cursor-trail');
      if (!trailCanvas) return;
      // 只在精确指针设备启用：触屏没有 hover 语义，自定义光标只会碍事
      if (!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches)) return;

      trailCtx = trailCanvas.getContext('2d');
      if (!trailCtx) return;

      cursorActive = true;
      TRAIL_N = reducedMotion ? 5 : 18;
      trailPX = new Array(TRAIL_N);
      trailPY = new Array(TRAIL_N);
      for (var i = 0; i < TRAIL_N; i++) { trailPX[i] = 0; trailPY[i] = 0; }

      for (i = 0; i < 24; i++) {
        sparkPool.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 1 });
      }

      setCursorAccent(uiAccent);
      trailAccent = uiAccent;
      resizeTrailCanvas();
      document.documentElement.classList.add('star-cursor-on');

      window.addEventListener('pointermove', function (e) {
        cursorTx = e.clientX;
        cursorTy = e.clientY;
        if (!trailPrimed) {
          // 首次出现：整条尾巴直接就位，避免从屏幕左上角飞进来
          for (var j = 0; j < TRAIL_N; j++) { trailPX[j] = cursorTx; trailPY[j] = cursorTy; }
          trailPrimed = true;
          cursorVis = 1;
        }
        cursorOn = true;
      }, { passive: true });

      window.addEventListener('pointerdown', function () {
        cursorPop = 1;                                  // 点击时星体与尾巴闪一下
        spawnSparks(cursorTx, cursorTy, 5, 1);
      }, { passive: true });

      document.addEventListener('pointerover', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        // 文本输入区交还系统 caret，星体让位
        if (t.closest('input[type="text"], input[type="search"], input[type="password"], textarea')) {
          cursorHover = false;
          cursorOn = false;
          return;
        }
        var hit = t.closest('button, a, [role="button"], select, label, input[type="range"], ' +
          '.pc-track, .pc-playlist-card, .pc-side-tab, .settings-nav, .pc-text-btn, .uta-close, .option-item');
        cursorHover = !!hit;
        cursorOn = true;
      }, { passive: true });

      window.addEventListener('blur', hideStarCursor);
      document.addEventListener('mouseleave', hideStarCursor);
      window.addEventListener('resize', resizeTrailCanvas);
    }

    function hideStarCursor() {
      cursorOn = false;
      cursorHover = false;
    }

    function resizeTrailCanvas() {
      if (!trailCanvas) return;
      trailDpr = Math.min(window.devicePixelRatio || 1, 2);
      trailCanvas.width = Math.max(1, Math.round(window.innerWidth * trailDpr));
      trailCanvas.height = Math.max(1, Math.round(window.innerHeight * trailDpr));
      trailBox = null;                  // 改尺寸会自动清空，脏区记录同步作废
      trailCtx.setTransform(trailDpr, 0, 0, trailDpr, 0, 0);
    }

    /** 预渲染一颗 64px 光斑（白心 → 主题色 → 透明），绘制时只缩放贴图，不createGradient */
    function buildTrailSprite() {
      var size = 64;
      var c = document.createElement('canvas');
      c.width = c.height = size;
      var g = c.getContext('2d');
      var grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.16, 'rgba(255,255,255,.9)');
      grad.addColorStop(0.34, 'rgba(' + trailRGB + ',.7)');
      grad.addColorStop(0.64, 'rgba(' + trailRGB + ',.16)');
      grad.addColorStop(1, 'rgba(' + trailRGB + ',0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
      trailSprite = c;
    }

    /** 主题切换时同步流星配色（不重建 canvas，只换贴图） */
    function setCursorAccent(accentNum) {
      trailRGB = ((accentNum >> 16) & 255) + ',' + ((accentNum >> 8) & 255) + ',' + (accentNum & 255);
      buildTrailSprite();
    }

    /** 火星：从流星核喷出的小颗粒，池复用，无运行时分配 */
    function spawnSparks(x, y, n, power) {
      if (!cursorActive || reducedMotion || !sparkPool.length) return;
      for (var i = 0; i < n; i++) {
        var s = sparkPool[sparkPtr];
        sparkPtr = (sparkPtr + 1) % sparkPool.length;
        var a = Math.random() * Math.PI * 2;
        var sp = (14 + Math.random() * 46) * power;
        s.x = x; s.y = y;
        s.vx = Math.cos(a) * sp;
        s.vy = Math.sin(a) * sp;
        s.max = s.life = 0.28 + Math.random() * 0.34;
        s.size = 1.5 + Math.random() * 2.2;
      }
    }

    /** 3D 星晶体：8 顶点做透视投影，12 条棱按平均深度排序（远的先画、更暗更细）。
     *  顶点缓存与排序槽都是预分配复用，主循环里零 new。 */
    function drawStarCrystal(ctx, cx, cy, scale, rotY, rotX, alpha) {
      var cyy = Math.cos(rotY), syy = Math.sin(rotY);
      var cxx = Math.cos(rotX), sxx = Math.sin(rotX);
      var focal = 4.6;
      var i, v, p;
      for (i = 0; i < 8; i++) {
        v = STAR_VERTS[i];
        var x = v[0] * cyy + v[2] * syy;
        var z = -v[0] * syy + v[2] * cyy;
        var y = v[1];
        var y2 = y * cxx - z * sxx;
        var z2 = y * sxx + z * cxx;
        var k = focal / (focal + z2);          // 透视：近大远小
        p = STAR_P[i];
        p.x = cx + x * scale * k;
        p.y = cy + y2 * scale * k;
        p.z = z2;
        p.k = k;
      }
      for (i = 0; i < 12; i++) {
        var e = STAR_EDGES[i];
        STAR_ORDER[i].i = i;
        STAR_ORDER[i].d = (STAR_P[e[0]].z + STAR_P[e[1]].z) * 0.5;
      }
      STAR_ORDER.sort(function (a, b) { return b.d - a.d; });

      ctx.lineCap = 'round';
      for (i = 0; i < 12; i++) {
        var e2 = STAR_EDGES[STAR_ORDER[i].i];
        var a = STAR_P[e2[0]], b = STAR_P[e2[1]];
        var near = (1.75 - STAR_ORDER[i].d) / 3.5;   // 0=最远 1=最近
        if (near < 0) near = 0; else if (near > 1) near = 1;
        // 近棱偏白（像反光的棱边），远棱偏主题色且更淡——立体感的主要来源
        if (near > 0.55) {
          ctx.strokeStyle = 'rgba(255,255,255,' + ((near - 0.55) * 1.9 * alpha).toFixed(3) + ')';
        } else {
          ctx.strokeStyle = 'rgba(' + trailRGB + ',' + ((0.14 + near * 0.5) * alpha).toFixed(3) + ')';
        }
        ctx.lineWidth = 0.7 + near * 1.05;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // 朝前的顶点各点一颗小星（背面不点，避免糊成一团）
      for (i = 0; i < 8; i++) {
        p = STAR_P[i];
        if (p.z > 0.5) continue;
        var near2 = (1.75 - p.z) / 3.5;
        var ds = 1.8 + near2 * 2.4;
        ctx.globalAlpha = (0.24 + near2 * 0.46) * alpha;
        ctx.drawImage(trailSprite, p.x - ds / 2, p.y - ds / 2, ds, ds);
      }
    }

    /** 两道倾斜轨道：椭圆环 + 环上绕行的小星，前半亮后半暗，给出「环在 3D 里」的读感 */
    function drawOrbits(ctx, cx, cy, alpha) {
      for (var o = 0; o < ORBIT_DEFS.length; o++) {
        var d = ORBIT_DEFS[o];
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(d.tilt + Math.sin(trailTime * 0.23 + o * 2) * 0.1);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(' + trailRGB + ',' + (0.22 * alpha).toFixed(3) + ')';
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.ellipse(0, 0, d.r, d.r * d.squash, 0, 0, Math.PI * 2);
        ctx.stroke();
        for (var k = 0; k < 2; k++) {
          var ang = trailTime * d.speed + d.phase + k * Math.PI;
          var front = Math.sin(ang) < 0;              // 轨道前半（朝观察者）更亮
          // 拖影：主点后面跟两个衰减小点，读得出绕行方向
          for (var tr = 0; tr < 3; tr++) {
            var ta = ang - tr * 0.22 * (d.speed > 0 ? 1 : -1);
            var sz = (k === 0 ? 4.2 : 2.6) * (1 - tr * 0.32);
            ctx.globalAlpha = (front ? 0.9 : 0.32) * (1 - tr * 0.3) * alpha;
            ctx.drawImage(trailSprite,
              Math.cos(ta) * d.r - sz / 2,
              Math.sin(ta) * d.r * d.squash - sz / 2,
              sz, sz);
          }
        }
        ctx.restore();
      }
    }

    /** 每帧绘制光标：推进链条 → 清脏区 → 柔光 → 光尾 → 轨道 → 星晶体 → 火星 */
    function drawStarCursor(dt) {
      if (!cursorActive || !trailCtx) return;
      if (dt > 0.1) dt = 0.1;                            // 切回标签页时不瞬移
      trailTime += dt;
      var i, t;

      // 主题切换：重建一次光斑贴图（不重建 canvas）
      if (uiAccent !== trailAccent) {
        trailAccent = uiAccent;
        setCursorAccent(uiAccent);
      }

      var visTarget = cursorOn ? 1 : 0;
      cursorVis += (visTarget - cursorVis) * (1 - Math.exp(-14 * dt));
      if (cursorVis < 0.004 && !visTarget) {
        if (trailBox) {
          trailCtx.clearRect(trailBox[0], trailBox[1], trailBox[2] - trailBox[0], trailBox[3] - trailBox[1]);
          trailBox = null;
        }
        return;
      }

      // 星体姿态：拍点呼吸 + 点击脉冲 + hover 放大，幅度都很小，不会「跳」
      cursorBreath = reducedMotion ? 0 : cursorBreath * Math.exp(-9 * dt);
      cursorPop *= Math.exp(-11 * dt);
      cursorHoverScale += ((cursorHover ? 1.14 : 1) - cursorHoverScale) * (1 - Math.exp(-16 * dt));
      if (!reducedMotion) {
        starRotY += dt * 1.45;
        starRotX = 0.42 + Math.sin(trailTime * 0.42) * 0.2;
      }
      var starScale = 6.1 * cursorHoverScale * (1 + cursorBreath * 0.08 + cursorPop * 0.3);

      // 链条推进：头节点锁死指针，后面每级低通（a 递减 = 越靠后越软）
      trailPX[0] = cursorTx;
      trailPY[0] = cursorTy;
      for (i = 1; i < TRAIL_N; i++) {
        var k = 1 - Math.exp(-(118 - i * 2.4) * dt);
        trailPX[i] += (trailPX[i - 1] - trailPX[i]) * k;
        trailPY[i] += (trailPY[i - 1] - trailPY[i]) * k;
      }

      // 脏区：本帧 bbox ∪ 上一帧 bbox（否则旧尾巴会永久残留）
      var pad = 30 + cursorPop * 14;
      var x0 = cursorTx, y0 = cursorTy, x1 = cursorTx, y1 = cursorTy;
      for (i = 0; i < TRAIL_N; i++) {
        if (trailPX[i] < x0) x0 = trailPX[i];
        if (trailPX[i] > x1) x1 = trailPX[i];
        if (trailPY[i] < y0) y0 = trailPY[i];
        if (trailPY[i] > y1) y1 = trailPY[i];
      }
      x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
      var cx0 = x0, cy0 = y0, cx1 = x1, cy1 = y1;
      if (trailBox) {
        if (trailBox[0] < cx0) cx0 = trailBox[0];
        if (trailBox[1] < cy0) cy0 = trailBox[1];
        if (trailBox[2] > cx1) cx1 = trailBox[2];
        if (trailBox[3] > cy1) cy1 = trailBox[3];
      }
      trailCtx.clearRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
      trailBox = [x0, y0, x1, y1];

      trailCtx.globalCompositeOperation = 'lighter';

      // 柔光外壳：让星体在深色背景上「浮」起来一层
      trailCtx.globalAlpha = 0.07 * cursorVis * (1 + cursorPop * 0.6);
      trailCtx.drawImage(trailSprite, cursorTx - 20, cursorTy - 20, 40, 40);

      // 光尾：相邻节点之间按距离插值补点（快甩时节点间距会超过光斑直径，
      // 不补会变成珠串），从尾到头叠加，头部更亮更大
      for (i = TRAIL_N - 1; i >= 1; i--) {
        var t0 = 1 - i / (TRAIL_N - 1);
        var t1 = 1 - (i - 1) / (TRAIL_N - 1);
        var ax = trailPX[i], ay = trailPY[i];
        var bx = trailPX[i - 1], by = trailPY[i - 1];
        var dx = bx - ax, dy = by - ay;
        var steps = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / 4.5));
        for (var s2 = 0; s2 <= steps; s2++) {
          var u = s2 / steps;
          t = t0 + (t1 - t0) * u;
          var alpha = Math.pow(t, 1.7) * 0.62 * cursorVis;
          if (alpha < 0.004) continue;
          var sz = (3 + 11 * t * t) * (1 + cursorPop * 0.6);
          trailCtx.globalAlpha = alpha;
          trailCtx.drawImage(trailSprite, ax + dx * u - sz / 2, ay + dy * u - sz / 2, sz, sz);
        }
      }

      // 轨道与星晶体（星体压在最上，保证中心清晰、点击精度可辨）
      drawOrbits(trailCtx, cursorTx, cursorTy, cursorVis);
      drawStarCrystal(trailCtx, cursorTx, cursorTy, starScale, starRotY, starRotX, cursorVis);

      // 中心亮核：定位点，比任何装饰都亮
      trailCtx.globalAlpha = 0.72 * cursorVis;
      trailCtx.drawImage(trailSprite, cursorTx - 2.4, cursorTy - 2.4, 4.8, 4.8);

      // 火星：速度衰减 + 极轻下坠
      for (i = 0; i < sparkPool.length; i++) {
        var s = sparkPool[i];
        if (s.life <= 0) continue;
        s.life -= dt;
        if (s.life <= 0) continue;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        var damp = 1 - 2.6 * dt;
        s.vx *= damp;
        s.vy = s.vy * damp + 16 * dt;
        var lt = s.life / s.max;
        trailCtx.globalAlpha = lt * lt * 0.8 * cursorVis;
        var ss = s.size * (0.35 + lt * 0.95);
        trailCtx.drawImage(trailSprite, s.x - ss / 2, s.y - ss / 2, ss, ss);
      }

      trailCtx.globalAlpha = 1;
      trailCtx.globalCompositeOperation = 'source-over';
    }

    function init() {
      windowWidth = $(window).width();
      windowHeight = $(window).height();

      initStarCursor();

      // PIXI v6 渲染器
      renderer = PIXI.autoDetectRenderer(windowWidth, windowHeight, {
        backgroundColor: getTheme(themeId).background,
        antialias: true,
        autoDensity: true,
        // 上限 1.5：4K/Retina 下全屏 shader 的填充率成本按 dpr² 增长，2.0 会拖垮集显
        resolution: Math.min(window.devicePixelRatio || 1, 1.5)
      });
      document.getElementById('view').appendChild(renderer.view);

      stage = new PIXI.Container();
      renderContainer = new PIXI.Container();
      stage.addChild(renderContainer);

      // 背景层容器：插入渲染树最底层，网格/粒子/频谱/波纹都在其之上
      bgContainer = new PIXI.Container();
      bgContainer.interactive = false;
      bgContainer.interactiveChildren = false;
      stage.addChildAt(bgContainer, 0);

      // 初始化模块
      audio = new AudioEngine();
      window.__audioEngine = audio; // 供 BgLayer 频谱回退使用
      // DJ 化音频引擎（BGM + 4 行乐器组 + FX，供冒烟测试探测）
      djFx = new DjFxEngine();
      window.__djFx = djFx;
      djFx.setTheme(themeId);
      // 网易云 BGM + 独立播放器卡片
      netease = new NeteaseBgm();
      window.__netease = netease;
      // 网易云歌曲开播时停掉 DJ 内置 BGM，避免双音乐重叠（点击合成音不受影响）
      netease.onStateChange = function () { djFx.stopBgm(); };
      // 歌曲播放期间压低 BGM 总线；暂停 / 结束恢复，并切换到歌曲节拍网格
      netease.audio.addEventListener('play', function () {
        djFx.setSongPlaying(true);
        djFx.setExternalGrid(netease.beatGrid || null);
      });
      netease.audio.addEventListener('pause', function () {
        djFx.setSongPlaying(false);
        djFx.setExternalGrid(null);
      });
      netease.audio.addEventListener('ended', function () {
        djFx.setSongPlaying(false);
        djFx.setExternalGrid(null);
      });
      // 全局视差星空：位于所有特效之下（通用/隐现/莫奈/漫游）
      starfield = new ParallaxStarfield(renderContainer, getTheme(themeId));
      window.__starfield = starfield; // 供自动化验收采样
      // 尊重系统「减少动效」：初始化 + 运行中切换都生效
      var motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      reducedMotion = !!(motionQuery && motionQuery.matches);
      if (motionQuery) {
        var onMotionChange = function (e) { reducedMotion = !!e.matches; };
        if (motionQuery.addEventListener) motionQuery.addEventListener('change', onMotionChange);
        else if (motionQuery.addListener) motionQuery.addListener(onMotionChange);
      }
      if (reducedMotion) {
        starfield.setReducedMotion(true);
      }
      particles = new ParticleSystem(renderContainer, getTheme(themeId));
      particles.setParams(particleParams);
      ripple = new RippleEffect(renderContainer, getTheme(themeId));
      spectrum = new SpectrumVisualizer(renderContainer, getTheme(themeId));
      grid = new GridLayer(renderContainer, getTheme(themeId));

      // 中心特效层（默认「流体核心」，替换原环形频谱）
      coreLayer = new CoreLayer();
      coreLayer.init(renderContainer, { getTheme: function () { return getTheme(themeId); } });
      window.__coreLayer = coreLayer;

      // 背景模式系统（M0–M5），默认「星海」
      bgLayer = new BgLayer();
      bgLayer.init({
        stage: stage,
        renderer: renderer,
        container: bgContainer,
        themeId: themeId
      }, { getTheme: getTheme, getCenterMode: function () { return coreLayer ? coreLayer.mode : 'none'; } });
      bgLayer.onPostFiltersChange = applyStageFilters;
      window.__bgLayer = bgLayer;

      playerCard = new PlayerCard(netease);
      window.__playerCard = playerCard;
      // 歌曲封面 → 背景层（通用/莫奈/漫游 取图，隐现取色）
      playerCard.onTrackChange = function (song) {
        if (bgLayer && song && song.coverUrl) bgLayer.setCover(song.coverUrl);
        if (coreLayer) coreLayer.clear(); // 换歌：涟漪/抖动痕迹淡出清空
        if (bgLayer && bgLayer.resetFx) bgLayer.resetFx(); // 换歌：重置星海共振的波源与余晖
        flashRainbow(); // 换歌：屏幕边缘彩虹跑马灯
      };
      // AI 主题生成回调：歌词情绪 + 封面色 → 沉浸式背景与视觉参数
      playerCard.onThemeChange = function (theme) {
        if (!aiThemeEnabled) return; // 播放器右侧面板可关闭
        // 背景色（封面色压暗）
        targetBg = theme.bg;
        // 粒子色板（封面色相旋转）
        var dyn = {
          id: 'ai',
          name: 'AI 主题',
          background: theme.bg,
          backgrounds: [theme.bg],
          particles: theme.palette,
          ripple: theme.palette[0],
          spectrum: theme.palette.slice(0, 3),
          text: 0xffffff,
          accent: theme.palette[0]
        };
        particles.setTheme(dyn);
        if (starfield) starfield.setTheme(dyn);
        ripple.setTheme(dyn);
        spectrum.setTheme(dyn);
        grid.setTheme(dyn);
        if (coreLayer) coreLayer.setTheme(dyn);
        // AI 主题同步 UI 强调色
        applyUiTheme(dyn);
        // 背景层同步换色（AI 主题）
        if (bgLayer) bgLayer.setCustomTheme(dyn);
        // 情绪 → 粒子参数（密度/初速）
        particleParams.density = Math.max(2, Math.min(10, 6 * theme.params.density));
        particleParams.speed = Math.max(2, Math.min(8, 5 * theme.params.speed));
        particles.setParams(particleParams);
        $('#slider-density').val(particleParams.density);
        $('#slider-speed').val(particleParams.speed);
      };
      // 换歌：音游引擎重置（onTrackChange 在 handleTrack 之前触发，重置后再铺面）
      playerCard.onTrackChange = (function (orig) {
        return function (song) {
          if (window.RhythmGame) window.RhythmGame.onTrackChanged(song);
          orig.call(playerCard, song);
        };
      })(playerCard.onTrackChange);
      // 音游模式引擎（先缓存再铺面）：状态 HUD + 结算卡 + seek 重置
      RhythmGame.init({
        netease: netease,
        grid: grid,
        getAccent: function () {
          var t = getTheme(themeId);
          return (t && t.accent) || 0x7fe8ff;
        },
        onStatus: function (text) {
          var el = document.getElementById('rh-status');
          if (el) el.textContent = text || '';
        },
        // 连击里程碑演出：音效上扬 + HUD 连击数字弹一下（视觉冲击波由 gridLayer.milestone 画）
        onMilestone: function (combo, level) {
          if (djFx && djFx.playMilestone) djFx.playMilestone(combo, level);
          popComboHud(level);
        },
        onFinish: showRhythmResult
      });
      window.__rhythm = RhythmGame;
      netease.audio.addEventListener('seeked', function () {
        if (window.RhythmGame) RhythmGame.onSeeked();
      });
      // 结算卡按钮
      $('#rr-close').click(function () { $('#rhythm-result').hide(); });
      $('#rr-replay').click(function () {
        $('#rhythm-result').hide();
        if (playerCard && playerCard.index >= 0) playerCard.playAt(playerCard.index);
      });
      PlayerUI.init(playerCard, netease);
      // 给播放器右侧面板用的应用级接口
      window.__app = {
        flashRainbow: flashRainbow,
        setAiThemeEnabled: function (v) { aiThemeEnabled = !!v; },
        isAiThemeEnabled: function () { return aiThemeEnabled; },
        setCenterMode: setCenterMode,
        getCenterMode: function () { return coreLayer ? coreLayer.mode : 'none'; },
        setLyricStageMode: setLyricStageMode,
        getLyricStageMode: function () { return lyricStage ? lyricStage.mode : 'off'; },
        openSettings: openSettings,
        closeSettings: closeSettings,
        isSettingsOpen: function () { return $('#select').hasClass('open'); },
        openWindow: function (panelEl, coverEl, focusEl) {
          openWindow(panelEl, coverEl, document.querySelector(panelEl), focusEl);
        },
        closeWindow: function (panelEl, coverEl) {
          closeWindow(panelEl, coverEl, document.querySelector(panelEl));
        }
      };
      // 调试/冒烟测试钩子
      window.__fx = { particles: particles, spectrum: spectrum };

      // 歌词演出层（模组 lyric-overlay 开启时显示）
      lyricStage = new LyricStage(stage, {
        getTheme: function () { return getTheme(themeId); }
      });
      lyricStage.resize(windowWidth, windowHeight);
      window.__lyricStage = lyricStage;

      // Bloom 后处理：默认开启，可在设置面板关闭
      try {
        if (window.PIXI && window.PIXI.filters && window.PIXI.filters.BloomFilter) {
          bloomFilter = new window.PIXI.filters.BloomFilter();
          bloomFilter.strength = 0.6;
          bloomFilter.radius = 8;
          bloomFilter.threshold = 0.5;
          // 实际启用状态由设置面板 toggle 控制（applyEffects）
          stage.filters = [];
        }
      } catch (e) {
        console.warn('Bloom 初始化失败:', e);
      }

      resize();
      setupEvents();
      bindSettings();
      bindCardTilt();

      // UI 层：主题变量 + 随机星空（mikutap-app 同步）
      applyUiTheme(getTheme(themeId));
      buildWelcomeStars();

      $('#scene_top').fadeIn(300);
      requestAnimationFrame(update);

      // hash 路由自动演示（用于截图 / 演示视频录制）
      applyHashRoute();
    }

    function applyHashRoute() {
      var hash = window.location.hash || '';
      if (hash.indexOf('shot=main') >= 0) {
        // 进入主画布并自动触发粒子
        $('#scene_top').hide();
        $('#scene_main').show().addClass('visible');
        audio.init();
        for (var i = 0; i < 12; i++) {
          var x = windowWidth * (0.2 + Math.random() * 0.6);
          var y = windowHeight * (0.2 + Math.random() * 0.6);
          var r = getNote(x, y);
          audio.playNote(r.note, r.pan);
          particles.emit(x, y);
          ripple.emit(x, y);
        }
      } else if (hash.indexOf('shot=settings') >= 0) {
        $('#scene_top').hide();
        $('#scene_main').show().addClass('visible');
        openSettings();
      } else if (hash.indexOf('shot=about') >= 0) {
        $('#scene_top').hide();
        $('#scene_main').show().addClass('visible');
        openAbout();
      }
    }

    function resize() {
      windowWidth = $(window).width();
      windowHeight = $(window).height();
      renderer.resize(windowWidth, windowHeight);
      if (stage) {
        // 低频脉冲围绕画面中心缩放
        stage.pivot.set(windowWidth / 2, windowHeight / 2);
        stage.position.set(windowWidth / 2, windowHeight / 2);
      }
      if (starfield) starfield.resize(windowWidth, windowHeight);
      particles.resize(windowWidth, windowHeight);
      if (lyricStage) lyricStage.resize(windowWidth, windowHeight);
      ripple.resize(windowWidth, windowHeight);
      spectrum.resize(windowWidth, windowHeight);
      grid.resize(windowWidth, windowHeight);
      if (coreLayer) coreLayer.resize(windowWidth, windowHeight);
      if (bgLayer) bgLayer.resize(windowWidth, windowHeight);
    }

    /** 屏幕坐标 → stage 局部坐标（stage 会因低频脉冲缩放） */
    function toLocalPoint(x, y) {
      if (!stage) return { x: x, y: y };
      if (Math.abs(stage.scale.x - 1) < 0.0001 && Math.abs(stage.scale.y - 1) < 0.0001) {
        return { x: x, y: y };
      }
      var p = stage.toLocal(new PIXI.Point(x, y));
      return { x: p.x, y: p.y };
    }

    function getNote(x, y) {
      var note = Math.round(48 + (1 - y / windowHeight) * 36);
      var pan = (x / windowWidth) * 2 - 1;
      return { note: note, pan: pan };
    }

    function onPointerDown(x, y) {
      // 首次手势：启动 DJ 引擎 + BGM
      if (!djStarted) {
        djFx.resume();
        djFx.startBgm();
        djStarted = true;
      }
      // 输入指纹：点击恒满力度；速度采样从当下重新开始
      dragVel = 1;
      lastPtrX = x; lastPtrY = y; lastPtrT = Date.now();
      var r = getNote(x, y);
      var pos = toLocalPoint(x, y);
      var cell = grid.getCell(pos.x, pos.y);
      var row = 3 - cell.row; // 反转：上行(屏幕上方)=旋律组 row 0
      if (netease && netease.duckForTap) netease.duckForTap();
      djFx.playNote(r.note, r.pan, row);
      particles.cancelMesh(); // 点击打断星座重组
      // 音游模式：点击分区 = 等效按键；停用星海爆裂，改分区边框闪，涟漪减半
      var RGd = window.RhythmGame;
      var rhythmTap = !!(RGd && RGd.isActive());
      var tapZoneIdx = rhythmTap && grid.zoneAt ? grid.zoneAt(pos.x, pos.y) : -1;
      if (rhythmTap) {
        if (tapZoneIdx >= 0) {
          var jr = RGd.tapZone(tapZoneIdx);        // 判定即时结算（命中时 _record 出分区闪+判定字）
          if (jr) {
            djFx.playHit(jr.judge, tapZoneIdx % 2 === 0 ? -0.45 : 0.45);  // 判定打击层（不量化，瞬时）
          } else if (grid.zoneHit) {
            grid.zoneHit(tapZoneIdx, getTheme(themeId).accent);           // 空敲轻闪
          }
        }
      } else {
        particles.emit(pos.x, pos.y);
      }
      ripple.emit(pos.x, pos.y, rhythmTap ? 0.55 : 1);
      if (coreLayer) coreLayer.onTap(pos.x, pos.y, 1);
      if (bgLayer && bgLayer.tapFx) bgLayer.tapFx(pos.x, pos.y, r.note || 0);
      // mikutap 标志性：高亮选中方块 + 背景色过渡
      var theme = getTheme(themeId);
      grid.highlight(cell.col, cell.row, theme.particles[cell.col % theme.particles.length]);
      // 背景色按行（音高）平滑过渡到对应深浅
      targetBg = theme.backgrounds[cell.row] || theme.background;
      dragging = true;
      lastCellKey = cell.col + '-' + cell.row;
    }

    function onPointerMove(x, y) {
      if (!dragging) return;

      // 输入指纹：拖拽速度 → 力度。慢拖 0.55、快甩 1.0（约 1.2 px/ms 封顶），低通平滑防抖
      var nowT = Date.now();
      var dtPtr = nowT - lastPtrT;
      if (lastPtrT > 0 && dtPtr > 0) {
        var speed = Math.sqrt((x - lastPtrX) * (x - lastPtrX) + (y - lastPtrY) * (y - lastPtrY)) / dtPtr;
        var vTarget = Math.min(1, 0.55 + (speed / 1.2) * 0.45);
        dragVel += (vTarget - dragVel) * 0.3;
      }
      lastPtrX = x; lastPtrY = y; lastPtrT = nowT;

      // 节流：拖拽时最小 40ms 发射一次，避免每帧爆发粒子导致卡顿
      var now = Date.now();
      if (now - lastEmitTime < 40) return;
      lastEmitTime = now;

      var pos = toLocalPoint(x, y);
      var cell = grid.getCell(pos.x, pos.y);
      var theme = getTheme(themeId);
      var cellKey = cell.col + '-' + cell.row;

      // 扫过新方块才发声（拖拽经过每个方块触发一次该行音色）
      if (cellKey !== lastCellKey) {
        var r = getNote(x, y);
        var row = 3 - cell.row;
        if (netease && netease.duckForTap) netease.duckForTap();
        djFx.playNote(r.note, r.pan, row, dragVel);
        lastCellKey = cellKey;
      }

      var rhythmDrag = !!(window.RhythmGame && RhythmGame.isActive());
      if (!rhythmDrag) particles.emit(pos.x, pos.y, dragVel);   // 音游模式拖拽同样不爆星星
      ripple.emit(pos.x, pos.y, rhythmDrag ? 0.55 : 1);
      if (coreLayer) coreLayer.onTap(pos.x, pos.y, Math.max(0.55, dragVel));
      if (bgLayer && bgLayer.tapFx) bgLayer.tapFx(pos.x, pos.y, (getNote(x, y).note || 0));
      // 拖拽经过的方块也高亮
      grid.highlight(cell.col, cell.row, theme.particles[cell.col % theme.particles.length]);
      targetBg = theme.backgrounds[cell.row] || theme.background;
    }

    function onPointerUp() {
      dragging = false;
    }

    function startGame() {
      if (gameStarted) return;
      gameStarted = true;
      var $welcome = $('#scene_top');
      $welcome.addClass('leaving');
      var revealed = false;
      var reveal = function () {
        if (revealed) return;
        revealed = true;
        $welcome.hide();
        var mainEl = document.getElementById('scene_main');
        $('#scene_main').show();
        void mainEl.offsetHeight; // 强制重排，让入场过渡生效
        $('#scene_main').addClass('visible');
        // 首次手势启动 BGM
        if (!djStarted) {
          djFx.resume();
          djFx.startBgm();
          djStarted = true;
        }
      };
      $welcome.one('transitionend', function (ev) {
        var oe = ev.originalEvent;
        if (!oe || oe.propertyName === 'opacity') reveal();
      });
      setTimeout(reveal, 560);
    }

    // 窗口退场计时器：.leaving 态在退场动画播完后移除，期间可被重新打开打断
    var windowLeaveTimers = {};

    function cancelLeaving(panelSel) {
      if (windowLeaveTimers[panelSel]) {
        clearTimeout(windowLeaveTimers[panelSel]);
        windowLeaveTimers[panelSel] = null;
      }
      $(panelSel).removeClass('leaving');
    }

    function openWindow(panelSel, coverSel, panelEl, focusEl) {
      cancelLeaving(panelSel);
      focusBeforePanel = document.activeElement;
      if (panelEl) {
        panelEl.inert = false;
        panelEl.removeAttribute('aria-hidden');
      }
      $(panelSel).addClass('open');
      $(coverSel).addClass('open');

      inertedSiblings = [];
      var coverEl = typeof coverSel === 'string' ? document.querySelector(coverSel) : coverSel;
      var children = document.body.children;
      for (var i = 0; i < children.length; i++) {
        var el = children[i];
        if (!el || el === panelEl || el === coverEl) continue;
        if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
        inertedSiblings.push({ el: el, inert: !!el.inert, aria: el.getAttribute('aria-hidden') });
        el.inert = true;
        el.setAttribute('aria-hidden', 'true');
      }
      if (focusEl && focusEl.focus) focusEl.focus();
    }

    function closeWindow(panelSel, coverSel, panelEl) {
      $(coverSel).removeClass('open');
      var $panel = $(panelSel);
      if ($panel.hasClass('open')) {
        $panel.removeClass('open').addClass('leaving');
        if (windowLeaveTimers[panelSel]) clearTimeout(windowLeaveTimers[panelSel]);
        windowLeaveTimers[panelSel] = setTimeout(function () {
          windowLeaveTimers[panelSel] = null;
          $(panelSel).removeClass('leaving');
        }, 230);
      }
      if (panelEl) {
        panelEl.setAttribute('aria-hidden', 'true');
        panelEl.inert = true;
      }
      for (var i = 0; i < inertedSiblings.length; i++) {
        var item = inertedSiblings[i];
        if (!item.el) continue;
        item.el.inert = item.inert;
        if (item.aria == null) item.el.removeAttribute('aria-hidden');
        else item.el.setAttribute('aria-hidden', item.aria);
      }
      inertedSiblings = [];
      if (focusBeforePanel && document.contains(focusBeforePanel) && focusBeforePanel.focus) {
        focusBeforePanel.focus();
      }
      focusBeforePanel = null;
    }

    function openSettings() {
      if (window.PlayerUI && $('#player').hasClass('open')) window.PlayerUI.close();
      openWindow('#select', '#select_cover', document.getElementById('select'), document.getElementById('bt_close'));
      if (showSettingsPane) showSettingsPane(currentSettingsPane);
    }

    function closeSettings() {
      if (!$('#select').hasClass('open')) return;
      closeWindow('#select', '#select_cover', document.getElementById('select'));
    }

    function openAbout() {
      if (window.PlayerUI && $('#player').hasClass('open')) window.PlayerUI.close();
      openWindow('#about', '#about_cover', document.getElementById('about'), document.getElementById('bt_close_about'));
    }

    function closeAbout() {
      if (!$('#about').hasClass('open')) return;
      closeWindow('#about', '#about_cover', document.getElementById('about'));
    }

    function setupEvents() {
      var view = renderer.view;
      view.addEventListener('mousedown', function (e) {
        onPointerDown(e.clientX, e.clientY);
      });
      window.addEventListener('mousemove', function (e) {
        // 鼠标斥力：把光标附近的粒子荡漾开
        var pos = toLocalPoint(e.clientX, e.clientY);
        particles.setRepel(pos.x, pos.y);
        onPointerMove(e.clientX, e.clientY);
      });
      window.addEventListener('mouseup', onPointerUp);
      view.addEventListener('touchstart', function (e) {
        e.preventDefault();
        onPointerDown(e.touches[0].clientX, e.touches[0].clientY);
      }, { passive: false });
      view.addEventListener('touchmove', function (e) {
        e.preventDefault();
        onPointerMove(e.touches[0].clientX, e.touches[0].clientY);
      }, { passive: false });
      view.addEventListener('touchend', onPointerUp);

      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('resize', resize);

      // 开始按钮：退场动画结束后再显示主画布
      $('#bt_start a').click(function (e) {
        e.preventDefault();
        startGame();
      });

      // 设置面板
      $('#bt_settings').click(function () { openSettings(); });
      $('#bt_close, #select_cover').click(function () { closeSettings(); });

      // 关于页
      $('#bt_about').click(function () { openAbout(); });
      $('#bt_close_about, #about_cover').click(function () { closeAbout(); });

      // ESC 关闭面板
      $(document).keydown(function (e) {
        if (e.key === 'Escape') {
          if ($('#select').hasClass('open')) closeSettings();
          if ($('#about').hasClass('open')) closeAbout();
          if (window.PlayerUI) window.PlayerUI.close();
        }
      });
    }

    function onKeyDown(e) {
      // 任意键都能打拍：自动连招 + 拍点对齐（输入框内不触发）
      if (e.repeat) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      var k = e.key;
      if (!k || k.length > 8) return;
      if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta'
        || k === 'Tab' || k === 'Escape' || k === 'CapsLock') return;
      if (/^F\d{1,2}$/.test(k)) return;

      // 空格：Mesh 重组（开启时拦截；未开启时保留原有打拍）
      if ((e.code === 'Space' || k === ' ') && fx.meshReform) {
        e.preventDefault();
        var patterns = ['bigDipper', 'orion', 'spiral', 'letterM', 'circle'];
        particles.triggerMesh(patterns[Math.floor(Math.random() * patterns.length)]);
        return;
      }

      if (k === ' ' || k === 'Spacebar') e.preventDefault();

      if (!djStarted) {
        djFx.resume();
        djFx.startBgm();
        djStarted = true;
      }

      // 音游模式：Q/W/E/R 直映中心四分区（Q左上 W右上 E左下 R右下），判定即时结算
      var RG = window.RhythmGame;
      var rhythmOn = !!(RG && RG.isActive());
      var zone = -1;
      if (rhythmOn) {
        var zmap = { KeyQ: 0, KeyW: 1, KeyE: 2, KeyR: 3 };
        var lk = (k || '').toLowerCase();
        zone = (e.code && zmap[e.code] !== undefined) ? zmap[e.code]
          : (lk === 'q' ? 0 : lk === 'w' ? 1 : lk === 'e' ? 2 : lk === 'r' ? 3 : -1);
      }

      // 键位决定声像与落点；QWER 键锚定分区中心
      var code = k.charCodeAt(0) || 32;
      var pan, pos, cell;
      if (zone >= 0) {
        pan = zone % 2 === 0 ? -0.45 : 0.45;         // 左区偏左、右区偏右
        var zr = grid.zoneRect(zone);
        pos = { x: zr.x + zr.w / 2, y: zr.y + zr.h / 2 };
        cell = grid.getCell(pos.x, pos.y);
      } else {
        pan = ((code % 10) / 9) * 2 - 1;
        var kx = windowWidth * (0.15 + ((code * 37) % 70) / 100);
        var ky = windowHeight * (0.2 + ((code * 53) % 60) / 100);
        pos = toLocalPoint(kx, ky);
        cell = grid.getCell(pos.x, pos.y);
      }

      var delay = djFx.playAutoBeat(pan);
      var fire = function () {
        // 音游模式停用星海粒子爆裂（避免遮挡分区视野），改用分区边框闪
        if (!(rhythmOn && zone >= 0)) particles.emit(pos.x, pos.y);
        ripple.emit(pos.x, pos.y, rhythmOn ? 0.55 : 1);
        if (coreLayer) coreLayer.onTap(pos.x, pos.y, 0.8);
        if (bgLayer && bgLayer.tapFx) bgLayer.tapFx(pos.x, pos.y, code % 18);
        var theme = getTheme(themeId);
        grid.highlight(cell.col, cell.row, theme.particles[cell.col % theme.particles.length]);
        targetBg = theme.backgrounds[cell.row] || theme.background;
        // 音游判定：QWER 同步结算（无 setTimeout，输入时刻 = 判定时刻）
        if (rhythmOn && zone >= 0) {
          var jr = RG.tapZone(zone);
          if (jr) djFx.playHit(jr.judge, pan);                            // 判定打击层（瞬时）
          else if (grid.zoneHit) grid.zoneHit(zone, theme.accent);        // 空敲：分区框轻闪
        }
      };
      if (rhythmOn) fire();                        // 音游模式：立即执行，绝不队列化延迟
      else if (delay > 0.02) setTimeout(fire, delay * 1000);
      else fire();
    }

    // 换歌：屏幕边缘彩虹跑马灯绕一圈
    function flashRainbow() {
      var el = document.getElementById('rainbow_ring');
      if (!el) return;
      el.classList.remove('on');
      void el.offsetWidth; // 强制重排以重启动画
      el.classList.add('on');
    }

    /**
     * 卡片浮起：鼠标在卡片外移动时，播放器卡片轻微倾斜（±0.8deg）。
     * 仅桌面精确指针；指针进入卡片或关闭后缓动归零；reduced-motion 不启用。
     */
    function bindCardTilt() {
      var finePointer = window.matchMedia
        && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
      if (!finePointer) return;

      var tiltX = 0, tiltY = 0, targetX = 0, targetY = 0, rafId = 0;
      var MAX_TILT = 0.8; // deg

      function step() {
        rafId = 0;
        var wrap = document.getElementById('player');
        var card = document.getElementById('player_in');
        if (!card || !wrap) return;
        if (reducedMotion || !wrap.classList.contains('open')) {
          targetX = 0; targetY = 0;
        }
        tiltX += (targetX - tiltX) * 0.14;
        tiltY += (targetY - tiltY) * 0.14;
        card.style.setProperty('--tilt-x', tiltX.toFixed(3) + 'deg');
        card.style.setProperty('--tilt-y', tiltY.toFixed(3) + 'deg');
        if (Math.abs(tiltX - targetX) > 0.01 || Math.abs(tiltY - targetY) > 0.01) {
          rafId = requestAnimationFrame(step);
        }
      }

      window.addEventListener('pointermove', function (e) {
        var wrap = document.getElementById('player');
        var card = document.getElementById('player_in');
        if (!wrap || !card || !wrap.classList.contains('open')) return;
        if (wrap.contains(e.target)) {
          // 指针在卡片上：不倾斜，交互优先
          targetX = 0; targetY = 0;
        } else {
          var r = wrap.getBoundingClientRect();
          targetX = (0.5 - (e.clientY - r.top) / r.height) * 2 * MAX_TILT; // rotateX
          targetY = ((e.clientX - r.left) / r.width - 0.5) * 2 * MAX_TILT; // rotateY
        }
        if (!rafId) rafId = requestAnimationFrame(step);
      }, { passive: true });
    }

    function bindSettings() {
      bindSettingsNav();

      // 特效开关
      var effectMap = {
        'toggle-particles': 'particles',
        'toggle-ripple': 'ripple',
        'toggle-spectrum': 'spectrum',
        'toggle-trail': 'trail',
        'toggle-links': 'links',
        'toggle-bloom': 'bloom',
        'toggle-pulse': 'pulse',
        'toggle-starfield': 'starfield',
        'toggle-gravity': 'gravity',
        'toggle-gravityfield': 'gravityField',
        'toggle-flow': 'flowField',
        'toggle-mesh': 'meshReform',
        'toggle-metaball': 'metaball'
      };

      function applyEffects() {
        var effects = particles.effects;
        effects.particles = $('#toggle-particles').is(':checked');
        effects.trail = $('#toggle-trail').is(':checked');
        effects.links = $('#toggle-links').is(':checked');
        effects.gravity = $('#toggle-gravity').is(':checked');
        effects.gravityField = $('#toggle-gravityfield').is(':checked');
        effects.flowField = $('#toggle-flow').is(':checked');
        effects.meshReform = $('#toggle-mesh').is(':checked');
        effects.metaball = $('#toggle-metaball').is(':checked');

        fx.starfield = $('#toggle-starfield').is(':checked');
        fx.gravity = effects.gravity;
        fx.gravityField = effects.gravityField;
        fx.flowField = effects.flowField;
        fx.meshReform = effects.meshReform;
        fx.metaball = effects.metaball;

        particles.setEffects(effects);
        ripple.setEnabled($('#toggle-ripple').is(':checked'));
        updateSpectrumVisibility();
        applyStageFilters();
      }

      Object.keys(effectMap).forEach(function (id) {
        $('#' + id).change(applyEffects);
      });

      // 粒子参数
      $('#slider-density').on('input', function () {
        particleParams.density = parseFloat($(this).val());
        particles.setParams(particleParams);
      });
      $('#slider-lifetime').on('input', function () {
        particleParams.lifetime = parseFloat($(this).val());
        particles.setParams(particleParams);
      });
      $('#slider-speed').on('input', function () {
        particleParams.speed = parseFloat($(this).val());
        particles.setParams(particleParams);
      });
      $('#slider-gravity').on('input', function () {
        particleParams.attract = parseFloat($(this).val());
        particles.setParams(particleParams);
      });

      // 音量（网易云 BGM 额外乘 0.35，保持点击节拍合成音的主体地位）
      $('#slider-volume').on('input', function () {
        var v = parseFloat($(this).val());
        audio.setVolume(v);
        djFx.setMasterVolume(v);
        netease.setVolume(v * 0.35);
      });

      // 重置
      $('#btn-reset').click(function () {
        particles.clear();
        ripple.clear();
        if (coreLayer) coreLayer.clear();
        lowFreqValue = 0;
        if (stage) stage.scale.set(1, 1);
        // 背景层重建（destroy 清理纹理/滤镜，避免泄漏）
        rebuildBgLayer();
      });

      // ===== 背景模式系统 =====
      bindBgSettings();
      // ===== 中心特效系统 =====
      bindCenterSettings();
      // ===== 演奏模式（音游） =====
      bindTapModeSettings();
      // ===== 歌词演出 =====
      bindLyricSettings();
      // ===== 歌词模组 =====
      bindModSettings();
      // ===== 歌词参数 =====
      bindTunings();

      // 应用初始开关（HTML 默认值 → 运行时）
      applyEffects();
    }

    /* ===== 背景模式系统：设置面板 ===== */

    function bindBgSettings() {
      renderBgModeChips();
      renderBgParams(bgLayer.mode);
      $('#toggle-bg-perf').change(function () {
        bgLayer.setPerfMode($(this).is(':checked'));
      });
    }

    function renderBgModeChips() {
      var $grid = $('#bg-mode-grid').empty();
      var modes = BgLayer.modes();
      modes.forEach(function (m) {
        var $label = $('<label class="option-item"></label>')
          .attr('data-mode', m.id)
          .append($('<input type="radio" name="bgmode">').attr('value', m.id))
          .append(document.createTextNode(m.name));
        if (m.id === bgLayer.mode) {
          $label.addClass('selected').find('input').prop('checked', true);
        }
        $label.click(function () {
          $('#bg-mode-grid .option-item').removeClass('selected');
          $label.addClass('selected');
          bgLayer.setMode(m.id);
          renderBgParams(m.id);
        });
        $grid.append($label);
      });
    }

    function renderBgParams(modeId) {
      var $box = $('#bg-params').empty();
      var schema = BgLayer.paramSchema(modeId) || [];
      schema.forEach(function (s) {
        if (s.type === 'toggle') {
          var $row = $('<label class="toggle-item"></label>').text(s.label + ' ');
          var $input = $('<input type="checkbox">').prop('checked', !!bgLayer.getParam(modeId, s.key));
          $input.change(function () {
            bgLayer.setParam(modeId, s.key, $(this).is(':checked') ? 1 : 0);
          });
          $row.append($input).append('<span class="toggle-switch"></span>');
          $box.append($row);
          return;
        }
        if (s.type === 'text') {
          // 文本参数（如嵌入背景的网址）
          var $textRow = $('<div class="slider-item"></div>')
            .append($('<span></span>').text(s.label))
            .append($('<input type="text">').attr({
              value: bgLayer.getParam(modeId, s.key) || '',
              placeholder: 'https://…'
            }).css({ flex: 1, minWidth: 0, padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontSize: '0.75rem' })
              .on('change', function () { bgLayer.setParam(modeId, s.key, $(this).val().trim()); }));
          $box.append($textRow);
          return;
        }
        if (s.type === 'color') {
          // 水洗色：空值 = 跟随主题首色
          var cur = bgLayer.getParam(modeId, s.key);
          var hex = (typeof cur === 'string' && /^#[0-9a-fA-F]{6}$/.test(cur))
            ? cur
            : '#' + ('000000' + (bgLayer.palette[0] || 0).toString(16)).slice(-6);
          var $colorRow = $('<div class="slider-item"></div>')
            .append($('<span></span>').text(s.label))
            .append($('<input type="color">').attr('value', hex)
              .css({ flex: 1, height: '26px', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' })
              .on('input', function () { bgLayer.setParam(modeId, s.key, $(this).val()); }));
          $box.append($colorRow);
          return;
        }
        var $slider = $('<div class="slider-item"></div>')
          .append($('<span></span>').text(s.label))
          .append($('<input type="range">').attr({
            min: s.min, max: s.max, step: s.step, value: bgLayer.getParam(modeId, s.key)
          }).on('input', function () {
            bgLayer.setParam(modeId, s.key, parseFloat($(this).val()));
          }));
        $box.append($slider);
      });
    }

    /* ===== 中心特效系统：设置面板 ===== */

    function bindCenterSettings() {
      if (!coreLayer) return;
      renderCenterChips();
      renderCenterParams(coreLayer.mode);
      updateSpectrumVisibility();
    }

    /* ===== 歌词演出：设置面板 ===== */

    function bindSettingsNav() {
      var $navs = $('#settings-rail .settings-nav');
      var $panes = $('#settings-main .settings-pane');
      var $main = $('#settings-main');
      var rail = document.getElementById('settings-rail');
      if (!$navs.length || !$panes.length) return;

      function syncOrientation() {
        if (rail) rail.setAttribute('aria-orientation', window.innerWidth <= 900 ? 'horizontal' : 'vertical');
      }

      function updateModeBadge() {
        var text = $('#tuning-mode-name').text().replace(/^·\s*/, '');
        $('#settings-nav-mode').text(text).prop('hidden', !text);
      }

      function activatePane(name, focus) {
        if (!name || !$panes.filter('[data-pane="' + name + '"]').length) name = 'bg';
        currentSettingsPane = name;
        $navs.each(function () {
          var on = $(this).data('pane') === name;
          $(this).toggleClass('is-active', on).attr('aria-selected', on ? 'true' : 'false');
          if (on && focus) this.focus();
        });
        $panes.each(function () {
          var on = $(this).data('pane') === name;
          $(this).toggleClass('is-active', on);
          if (on) $(this).removeAttr('hidden');
          else $(this).attr('hidden', 'hidden');
        });
        $main.scrollTop(0);
        try { localStorage.setItem('uta.settingsPane', name); } catch (e) { /* ignore */ }
        updateModeBadge();
      }

      showSettingsPane = function (name) { activatePane(name, false); };

      $navs.click(function () { activatePane($(this).data('pane'), false); });
      $navs.on('keydown', function (e) {
        var idx = $navs.index(this);
        var next = -1;
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = idx + 1;
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = idx - 1;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = $navs.length - 1;
        if (next < 0) return;
        e.preventDefault();
        next = (next + $navs.length) % $navs.length;
        activatePane($navs.eq(next).data('pane'), true);
      });
      $(window).on('resize', syncOrientation);
      syncOrientation();

      var saved = 'bg';
      try { saved = localStorage.getItem('uta.settingsPane') || 'bg'; } catch (e) { /* ignore */ }
      activatePane(saved, false);
      updateModeBadge();
    }

    function bindLyricSettings() {
      if (!lyricStage || typeof VisualizerRegistry === 'undefined') return;
      renderLyricStageChips();
    }

    function renderLyricStageChips() {
      if (!lyricStage || typeof VisualizerRegistry === 'undefined') return;
      renderStageChipGroup('#lyric-stage-grid', 'lyric', '暂无可用的歌词演出模式');
      renderStageChipGroup('#immersive-grid', 'immersive', '暂无沉浸式模块（启用「动感波光」等模组后可用）');
    }

    function renderStageChipGroup(selector, scope, emptyText) {
      var $grid = $(selector).empty();
      var list = VisualizerRegistry.list().filter(function (v) {
        return (v.scope || 'lyric') === scope;
      });
      if (!list.length) {
        $grid.append($('<div class="stage-empty"></div>').text(emptyText));
        return;
      }
      list.forEach(function (v) {
        var $label = $('<label class="option-item"></label>')
          .attr('data-lyric-stage', v.id)
          .append($('<input type="radio" name="lyricstage">').attr('value', v.id))
          .append(document.createTextNode(v.label));
        if (v.id === lyricStage.mode) {
          $label.addClass('selected').find('input').prop('checked', true);
        }
        $label.click(function () { setLyricStageMode(v.id); });
        $grid.append($label);
      });
    }

    function setLyricStageMode(id) {
      if (!lyricStage) return;
      lyricStage.setMode(id);
      $('#lyric-stage-grid .option-item, #immersive-grid .option-item').removeClass('selected');
      $('#lyric-stage-grid .option-item[data-lyric-stage="' + id + '"], #immersive-grid .option-item[data-lyric-stage="' + id + '"]')
        .addClass('selected').find('input').prop('checked', true);
      renderTuningPanels();
    }

    /* ===== 歌词模组：设置面板 ===== */

    function bindModSettings() {
      if (typeof UTAMods === 'undefined') return;
      UTAMods.init({
        onVisualizersChange: function () {
          if (lyricStage && !VisualizerRegistry.has(lyricStage.mode)) lyricStage.setMode('karaoke');
          renderLyricStageChips();
          renderTuningPanels();
        },
        onChange: function () { renderModList(); }
      });
      if (lyricStage) lyricStage.restoreMode();
      renderLyricStageChips();
      renderModList();
    }

    function renderModList() {
      var $box = $('#mod-list').empty();
      if (typeof UTAMods === 'undefined') return;
      var mods = UTAMods.list();
      if (!mods.length) {
        $box.append($('<div class="mod-empty"></div>')
          .text('未安装歌词模组。把模组脚本放到 www/mods/<id>/mod.js，并在 index.html 引入即可。'));
        return;
      }
      mods.forEach(function (m) {
        var $card = $('<div class="mod-card"></div>').attr('data-mod', m.id);
        var $head = $('<div class="mod-head"></div>');
        var $title = $('<div class="mod-name"></div>').text(m.name + ' ');
        $title.append($('<span class="mod-version"></span>').text('v' + m.version));

        var $toggle = $('<label class="toggle-item mod-toggle"></label>').text('启用 ');
        $toggle.append($('<input type="checkbox">').prop('checked', !!m.enabled).change(function () {
          UTAMods.setEnabled(m.id, $(this).is(':checked'));
        })).append('<span class="toggle-switch"></span>');

        $head.append($title).append($toggle);
        $card.append($head);
        if (m.description) $card.append($('<div class="mod-desc"></div>').text(m.description));
        if (m.error) $card.append($('<div class="mod-error"></div>').text('错误：' + m.error));

        if (m.enabled && m.settings && m.settings.length) {
          var $settings = $('<div class="mod-settings"></div>');
          m.settings.forEach(function (s) {
            $settings.append(renderModSetting(m, s));
          });
          $card.append($settings);
        }
        $box.append($card);
      });
    }

    function renderModSetting(mod, s) {
      var val = mod.values ? mod.values[s.key] : undefined;
      var label = s.label || s.key;

      if (s.type === 'boolean') {
        var $row = $('<label class="toggle-item"></label>').text(label + ' ');
        $row.append($('<input type="checkbox">').prop('checked', !!val).change(function () {
          UTAMods.setSetting(mod.id, s.key, $(this).is(':checked'));
        })).append('<span class="toggle-switch"></span>');
        return $row;
      }

      if (s.type === 'select') {
        var $sel = $('<select class="mod-select"></select>');
        (s.options || []).forEach(function (o) {
          $sel.append($('<option></option>').attr('value', o.value).text(o.label || o.value));
        });
        $sel.val(val == null ? '' : String(val)).change(function () {
          UTAMods.setSetting(mod.id, s.key, $(this).val());
        });
        return $('<div class="slider-item"></div>')
          .append($('<span></span>').text(label))
          .append($sel);
      }

      if (s.type === 'color') {
        var $color = $('<input type="color">')
          .val(/^#[0-9a-fA-F]{6}$/.test(val) ? val : '#00f0ff')
          .css({ flex: 1, height: '26px', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' })
          .on('input', function () { UTAMods.setSetting(mod.id, s.key, $(this).val()); });
        return $('<div class="slider-item"></div>')
          .append($('<span></span>').text(label))
          .append($color);
      }

      if (s.type === 'text') {
        var $text = $('<input type="text">').val(val || '')
          .css({ flex: 1, minWidth: 0, padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontSize: '0.75rem' })
          .on('change', function () { UTAMods.setSetting(mod.id, s.key, $(this).val()); });
        return $('<div class="slider-item"></div>')
          .append($('<span></span>').text(label))
          .append($text);
      }

      var attrs = {
        type: 'range',
        min: s.min != null ? s.min : 0,
        max: s.max != null ? s.max : 1,
        step: s.step != null ? s.step : 0.05,
        value: val != null ? val : 0
      };
      var $range = $('<input>').attr(attrs).on('input', function () {
        UTAMods.setSetting(mod.id, s.key, parseFloat($(this).val()));
      });
      return $('<div class="slider-item"></div>')
        .append($('<span></span>').text(label))
        .append($range);
    }

    /* ===== 歌词参数：通用 + 模式 ===== */

    function bindTunings() {
      if (typeof LyricTunings === 'undefined') return;
      renderTuningPanels();
    }

    function renderTuningPanels() {
      if (typeof LyricTunings === 'undefined') return;
      var $common = $('#tuning-common').empty();
      var common = LyricTunings.getCommon();
      LyricTunings.commonSchema.forEach(function (f) {
        $common.append(renderTuningField(f, common, function (key, value) {
          LyricTunings.setCommon(key, value);
        }));
      });

      var modeId = lyricStage ? lyricStage.mode : '';
      var def = (typeof VisualizerRegistry !== 'undefined') ? VisualizerRegistry.get(modeId) : null;
      $('#tuning-mode-name').text(def ? '· ' + def.label : '');
      var navMode = $('#tuning-mode-name').text().replace(/^·\s*/, '');
      $('#settings-nav-mode').text(navMode).prop('hidden', !navMode);
      var $mode = $('#tuning-mode').empty();
      var schema = LyricTunings.schemaFor(modeId);
      if (!schema) {
        $mode.append($('<div class="tuning-empty"></div>').text('该模式没有独立参数，只受上方通用参数影响。'));
        return;
      }
      var values = LyricTunings.get(modeId);
      schema.forEach(function (section) {
        $mode.append($('<div class="tuning-section-title"></div>').text(section.title));
        (section.fields || []).forEach(function (f) {
          $mode.append(renderTuningField(f, values, function (key, value) {
            LyricTunings.set(modeId, key, value);
          }, modeId));
        });
      });
    }

    function tuningFmt(v) {
      var n = Number(v);
      if (!isFinite(n)) return String(v);
      return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
    }

    function renderTuningField(field, values, onSet, modeId) {
      var val = values[field.key];
      var label = field.label || field.key;

      if (field.type === 'boolean') {
        var $row = $('<label class="toggle-item"></label>').text(label + ' ');
        $row.append($('<input type="checkbox">').prop('checked', !!val).change(function () {
          onSet(field.key, $(this).is(':checked'));
        })).append('<span class="toggle-switch"></span>');
        return $row;
      }

      if (field.type === 'alignGrid') {
        var $wrap = $('<div class="tuning-align"></div>');
        var $grid = $('<div class="tuning-align-grid"></div>');
        var positions = [
          ['tl', '↖'], ['tc', '↑'], ['tr', '↗'],
          ['ml', '←'], ['mc', '·'], ['mr', '→'],
          ['bl', '↙'], ['bc', '↓'], ['br', '↘']
        ];
        positions.forEach(function (p) {
          var $b = $('<button type="button" class="tuning-align-btn"></button>').attr('title', p[0]).text(p[1]);
          if (val === p[0]) $b.addClass('active');
          $b.click(function () {
            onSet('imageAlign', p[0]);
            renderTuningPanels();
          });
          $grid.append($b);
        });
        $wrap.append($grid);
        var $randomRow = $('<div class="tuning-align-random"></div>');
        [['random', '全随机'], ['randomH', '横向随机'], ['randomV', '纵向随机']].forEach(function (r) {
          var $b = $('<button type="button" class="tuning-align-btn tuning-align-wide"></button>').text(r[1]);
          if (val === r[0]) $b.addClass('active');
          $b.click(function () {
            onSet('imageAlign', r[0]);
            renderTuningPanels();
          });
          $randomRow.append($b);
        });
        $wrap.append($randomRow);
        return $('<div class="tuning-align-row"></div>')
          .append($('<span></span>').text(label))
          .append($wrap);
      }

      if (field.type === 'select') {
        var $sel = $('<select class="mod-select"></select>');
        (field.options || []).forEach(function (o) {
          $sel.append($('<option></option>').attr('value', o.value).text(o.label || o.value));
        });
        $sel.val(val == null ? '' : String(val)).change(function () {
          onSet(field.key, $(this).val());
        });
        return $('<div class="slider-item"></div>')
          .append($('<span></span>').text(label))
          .append($sel);
      }

      if (field.type === 'color') {
        var $color = $('<input type="color">')
          .val(/^#[0-9a-fA-F]{6}$/.test(val) ? val : '#5f7cff')
          .css({ flex: 1, height: '26px', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' })
          .on('input', function () { onSet(field.key, $(this).val()); });
        return $('<div class="slider-item"></div>')
          .append($('<span></span>').text(label))
          .append($color);
      }

      if (field.type === 'file') {
        var $file = $('<input type="file">').addClass('tuning-file').attr('accept', field.accept || 'image/*');
        $file.change(function () {
          var file = this.files && this.files[0];
          if (!file) return;
          readTuningImage(file, function (data) {
            onSet(field.key, data);
            renderTuningPanels();
          });
        });
        return $('<div class="tuning-file-row"></div>')
          .append($('<span></span>').text(label))
          .append($file);
      }

      if (field.type === 'action') {
        var $btn = $('<button class="tuning-action"></button>').text(label);
        $btn.click(function () {
          if (field.action === 'clear') {
            onSet(field.target, '');
            renderTuningPanels();
          } else if (field.action === 'exportPool') {
            exportTuningPool(values.imagePool);
          } else if (field.action === 'importPool') {
            importTuningPool(function (arr) {
              onSet('imagePool', arr);
              renderTuningPanels();
            });
          } else if (field.action === 'appendPool') {
            importTuningPool(function (arr) {
              onSet('imagePool', (values.imagePool || []).concat(arr));
              renderTuningPanels();
            });
          }
        });
        return $('<div class="tuning-action-row"></div>').append($btn);
      }

      if (field.type === 'imagePool') {
        var pool = Array.isArray(val) ? val : [];
        var $wrap = $('<div class="tuning-pool"></div>');
        var $grid = $('<div class="tuning-pool-grid"></div>');
        pool.forEach(function (src, index) {
          var $thumb = $('<div class="tuning-thumb"></div>').css('backgroundImage', 'url(' + src + ')');
          $thumb.append($('<button class="tuning-thumb-x" title="移除">×</button>').click(function () {
            var next = pool.slice();
            next.splice(index, 1);
            onSet('imagePool', next);
            renderTuningPanels();
          }));
          $grid.append($thumb);
        });
        $wrap.append($grid);
        var $poolFile = $('<input type="file" accept="image/*" multiple>').addClass('tuning-file');
        $poolFile.change(function () {
          var files = Array.prototype.slice.call(this.files || []);
          if (!files.length) return;
          var pending = files.length;
          var next = pool.slice();
          files.forEach(function (file) {
            readTuningImage(file, function (data) {
              next.push(data);
              if (--pending === 0) {
                onSet('imagePool', next);
                renderTuningPanels();
              }
            });
          });
        });
        $wrap.append($('<label class="tuning-file-label"></label>').text('添加图片').append($poolFile));
        $wrap.append($('<button class="tuning-action"></button>').text('清空全部').click(function () {
          onSet('imagePool', []);
          renderTuningPanels();
        }));
        return $wrap;
      }

      var $rangeRow = $('<div class="slider-item"></div>').append($('<span></span>').text(label));
      var $value = $('<span class="tuning-value"></span>').text(tuningFmt(val));
      var $range = $('<input type="range">').attr({
        min: field.min != null ? field.min : 0,
        max: field.max != null ? field.max : 1,
        step: field.step != null ? field.step : 0.05,
        value: val != null ? val : 0
      }).on('input', function () {
        var v = parseFloat($(this).val());
        $value.text(tuningFmt(v));
        onSet(field.key, v);
      });
      return $rangeRow.append($range).append($value);
    }

    function readTuningImage(file, cb) {
      if (!file || !/^image\//.test(file.type)) return;
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var max = 900;
          var scale = Math.min(1, max / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          cb(canvas.toDataURL('image/webp', 0.85));
        } catch (e) {
          console.warn('[Tunings] image failed', e);
        }
        URL.revokeObjectURL(url);
      };
      img.onerror = function () { URL.revokeObjectURL(url); };
      img.src = url;
    }

    var tuningCrcTableCache = null;

    function tuningCrcTable() {
      if (tuningCrcTableCache) return tuningCrcTableCache;
      var table = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
      }
      tuningCrcTableCache = table;
      return table;
    }

    function tuningCrc32(bytes) {
      var table = tuningCrcTable();
      var c = 0xFFFFFFFF;
      for (var i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function tuningZipStore(filename, text) {
      var enc = new TextEncoder();
      var name = enc.encode(filename);
      var data = enc.encode(text);
      var crc = tuningCrc32(data);
      var local = new Uint8Array(30 + name.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0x21, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);

      var central = new Uint8Array(46 + name.length);
      var cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, 0, true);
      central.set(name, 46);

      var end = new Uint8Array(22);
      var ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(4, 0, true);
      ev.setUint16(6, 0, true);
      ev.setUint16(8, 1, true);
      ev.setUint16(10, 1, true);
      ev.setUint32(12, central.length, true);
      ev.setUint32(16, local.length + data.length, true);
      ev.setUint16(20, 0, true);

      var out = new Uint8Array(local.length + data.length + central.length + end.length);
      var offset = 0;
      [local, data, central, end].forEach(function (part) {
        out.set(part, offset);
        offset += part.length;
      });
      return out;
    }

    function tuningUnzipStore(buffer) {
      var bytes = new Uint8Array(buffer);
      if (bytes.length < 30) return null;
      var dv = new DataView(buffer);
      if (dv.getUint32(0, true) !== 0x04034b50) return null;
      if (dv.getUint16(8, true) !== 0) return null;
      var compSize = dv.getUint32(18, true);
      var nameLen = dv.getUint16(26, true);
      var extraLen = dv.getUint16(28, true);
      var start = 30 + nameLen + extraLen;
      if (start + compSize > bytes.length) return null;
      return new TextDecoder().decode(bytes.subarray(start, start + compSize));
    }

    function exportTuningPool(pool) {
      try {
        var payload = JSON.stringify({ version: 1, images: pool || [] });
        var zip = tuningZipStore('images.json', payload);
        var blob = new Blob([zip], { type: 'application/zip' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'uta-tempera-images.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      } catch (e) { console.warn('[Tunings] export failed', e); }
    }

    function importTuningPool(cb) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.zip,.json,application/zip,application/json';
      input.onchange = function () {
        var file = input.files && input.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var buffer = reader.result;
            var bytes = new Uint8Array(buffer);
            var text = (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b)
              ? tuningUnzipStore(buffer)
              : new TextDecoder().decode(bytes);
            if (!text) throw new Error('unsupported backup');
            var data = JSON.parse(text);
            var images = Array.isArray(data) ? data : (data && data.images) || [];
            cb(images.filter(function (src) { return typeof src === 'string'; }));
          } catch (e) { console.warn('[Tunings] import failed', e); }
        };
        reader.readAsArrayBuffer(file);
      };
      input.click();
    }

    function renderCenterChips() {
      var $grid = $('#center-mode-grid').empty();
      var modes = CoreLayer.modes();
      modes.forEach(function (m) {
        var $label = $('<label class="option-item"></label>')
          .attr('data-center', m.id)
          .append($('<input type="radio" name="centermode">').attr('value', m.id))
          .append(document.createTextNode(m.name));
        if (m.id === coreLayer.mode) {
          $label.addClass('selected').find('input').prop('checked', true);
        }
        $label.click(function () { setCenterMode(m.id); });
        $grid.append($label);
      });
    }

    function renderCenterParams(modeId) {
      var $box = $('#center-params').empty();
      var schema = CoreLayer.paramSchema(modeId) || [];
      schema.forEach(function (s) {
        var $slider = $('<div class="slider-item"></div>')
          .append($('<span></span>').text(s.label))
          .append($('<input type="range">').attr({
            min: s.min, max: s.max, step: s.step, value: coreLayer.getParam(modeId, s.key)
          }).on('input', function () {
            coreLayer.setParam(modeId, s.key, parseFloat($(this).val()));
          }));
        $box.append($slider);
      });
    }

    /* ===== 演奏模式（音游）：HUD / 结算 / 设置面板 ===== */

    /** 连击里程碑：HUD 连击数弹一下（CSS 动画；强制回流保证连续里程碑也能重播） */
    function popComboHud(level) {
      var el = document.getElementById('rh-combo');
      if (!el) return;
      el.classList.remove('pop', 'pop-big');
      void el.offsetWidth;
      el.classList.add(level >= 2 ? 'pop-big' : 'pop');
    }

    /** 结算卡：填数据并显示 */
    function showRhythmResult(res) {
      var el = document.getElementById('rhythm-result');
      if (!el || !res) return;
      document.getElementById('rr-rank').textContent = res.rank;
      document.getElementById('rr-score').textContent = res.score.toLocaleString();
      document.getElementById('rr-combo').textContent = res.maxCombo;
      document.getElementById('rr-acc').textContent = res.accuracy + '%';
      document.getElementById('rr-judges').innerHTML =
        '<span>PERFECT<b>' + res.judges.perfect + '</b></span>' +
        '<span>GREAT<b>' + res.judges.great + '</b></span>' +
        '<span>GOOD<b>' + res.judges.good + '</b></span>' +
        '<span>MISS<b>' + res.judges.miss + '</b></span>' +
        (res.dropped ? '<span>丢弃<b>' + res.dropped + '</b></span>' : '');
      $(el).removeAttr('hidden').hide().fadeIn(220);
    }

    var _rhEls = null;
    function rhEls() {
      if (!_rhEls) {
        _rhEls = {
          hud: document.getElementById('rhythm-hud'),
          stats: document.getElementById('rh-stats'),
          combo: document.getElementById('rh-combo'),
          score: document.getElementById('rh-score'),
          acc: document.getElementById('rh-acc')
        };
      }
      return _rhEls;
    }

    /** 音游 HUD：缓存/铺面阶段显示状态，进行中显示连击/分数/准确率 */
    function updateRhythmHud() {
      var rg = window.RhythmGame;
      if (!rg) return;
      var e = rhEls();
      if (!e.hud) return;
      var busy = rg.mode === 'rhythm' && (rg.phase === 'caching' || rg.phase === 'charting');
      var active = rg.isActive();
      if (!busy && !active) {
        if (!e.hud.hidden) e.hud.hidden = true;
        return;
      }
      if (e.hud.hidden) e.hud.hidden = false;
      if (active) {
        if (e.stats.hidden) e.stats.hidden = false;
        var combo = rg.combo + '\u2003' + rg.score + '\u2003' + (Math.round(rg.accuracy() * 1000) / 10);
        if (combo !== rg._lastHud) {
          rg._lastHud = combo;
          e.combo.textContent = rg.combo;
          e.score.textContent = rg.score.toLocaleString();
          e.acc.textContent = (Math.round(rg.accuracy() * 1000) / 10) + '%';
        }
      } else if (!e.stats.hidden) {
        e.stats.hidden = true;
      }
    }

    function renderTapModeChips() {
      var $grid = $('#tapmode-grid').empty();
      var options = [
        { id: 'free', name: '自由演奏' },
        { id: 'rhythm', name: '节奏挑战' }
      ];
      options.forEach(function (o) {
        var $label = $('<label class="option-item"></label>')
          .attr('data-tapmode', o.id)
          .append($('<input type="radio" name="tapmode">').attr('value', o.id))
          .append(document.createTextNode(o.name));
        if (RhythmGame.mode === o.id) {
          $label.addClass('selected').find('input').prop('checked', true);
        }
        $label.click(function () { setTapMode(o.id); });
        $grid.append($label);
      });
    }

    function renderRhythmDiffChips() {
      var $grid = $('#rhythm-diff-grid').empty();
      var options = [
        { id: 'easy', name: '轻松' },
        { id: 'normal', name: '标准' },
        { id: 'hard', name: '激烈' }
      ];
      options.forEach(function (o) {
        var $label = $('<label class="option-item"></label>')
          .attr('data-diff', o.id)
          .append($('<input type="radio" name="rhythmdiff">').attr('value', o.id))
          .append(document.createTextNode(o.name));
        if (RhythmGame.difficulty === o.id) {
          $label.addClass('selected').find('input').prop('checked', true);
        }
        $label.click(function () {
          RhythmGame.setDifficulty(o.id);
          $('#rhythm-diff-grid .option-item').removeClass('selected')
            .filter('[data-diff="' + o.id + '"]').addClass('selected').find('input').prop('checked', true);
        });
        $grid.append($label);
      });
    }

    function renderRhythmParams() {
      var $box = $('#rhythm-params').empty();
      var $slider = $('<div class="slider-item"></div>')
        .append($('<span></span>').text('判定偏移（ms）'))
        .append($('<input type="range">').attr({
          min: -200, max: 200, step: 5, value: RhythmGame.offsetMs
        }).on('input', function () {
          RhythmGame.setOffset(parseFloat($(this).val()));
        }));
      $box.append($slider);
      $('#toggle-lenient').prop('checked', RhythmGame.lenient);
      $('#toggle-beatpulse').prop('checked', RhythmGame.beatAssist);
      $('#rhythm-param-group').toggle(RhythmGame.mode === 'rhythm');
    }

    function updateBottomHint(modeId) {
      var el = document.querySelector('.bottom-hint span');
      if (!el) return;
      el.textContent = modeId === 'rhythm'
        ? '节奏挑战：Q / W / E / R 敲击亮起的分区 · 点击分区等效按键'
        : '点击 / 拖拽 画布 · 键盘 QWERTY / ASDF 演奏';
    }

    function setTapMode(modeId) {
      if (modeId !== 'free' && modeId !== 'rhythm') modeId = 'free';
      RhythmGame.setMode(modeId);
      $('#tapmode-grid .option-item').removeClass('selected')
        .filter('[data-tapmode="' + modeId + '"]').addClass('selected').find('input').prop('checked', true);
      renderRhythmParams();
      updateBottomHint(modeId);
      if (window.RhythmGame && RhythmGame.debugInfo) {
        console.info('[Rhythm] 模式切换 → ' + modeId + ' ' + JSON.stringify(RhythmGame.debugInfo()));
      }
      if (modeId === 'rhythm') {
        // 正在播放的歌直接进入实时预判（完整谱面等下次切歌）
        var net = window.__netease;
        if (net && net.isPlaying() && window.RhythmGame && !RhythmGame.isActive() && RhythmGame.phase !== 'online') {
          RhythmGame._beginOnline();
          RhythmGame._status('当前歌曲已切换为实时铺面');
          console.info('[Rhythm] 路径=实时预判（播放中切模式，未做完整缓存；下次切歌才走离线铺面）');
          setTimeout(function () { if (RhythmGame.phase === 'online') RhythmGame._status(''); }, 2500);
        }
      }
    }

    function bindTapModeSettings() {
      if (!window.RhythmGame) return;
      renderTapModeChips();
      renderRhythmDiffChips();
      renderRhythmParams();
      updateBottomHint(RhythmGame.mode);
      $('#toggle-lenient').change(function () {
        RhythmGame.setLenient($(this).is(':checked'));
      });
      $('#toggle-beatpulse').change(function () {
        RhythmGame.setBeatAssist($(this).is(':checked'));
      });
    }

    // 统一切换中心特效（设置面板 + 播放器右侧面板共用）
    function setCenterMode(modeId) {
      if (!coreLayer) return;
      coreLayer.setMode(modeId);
      $('#center-mode-grid .option-item').removeClass('selected')
        .filter('[data-center="' + modeId + '"]').addClass('selected').find('input').prop('checked', true);
      $('#pc-center-grid .pc-chip').removeClass('active')
        .filter('[data-center="' + modeId + '"]').addClass('active');
      renderCenterParams(modeId);
      updateSpectrumVisibility();
    }

    // 原环形频谱只在「关闭」中心特效时显示
    function updateSpectrumVisibility() {
      var showRadar = $('#toggle-spectrum').is(':checked') && (!coreLayer || coreLayer.mode === 'none');
      spectrum.setEnabled(showRadar);
    }

    // 背景层重建：destroy 后重新挂载，确保不泄漏
    function rebuildBgLayer() {
      if (bgLayer) {
        bgLayer.destroy();
        bgLayer = null;
      }
      bgLayer = new BgLayer();
      bgLayer.init({
        stage: stage,
        renderer: renderer,
        container: bgContainer,
        themeId: themeId
      }, { getTheme: getTheme, getCenterMode: function () { return coreLayer ? coreLayer.mode : 'none'; } });
      bgLayer.setPerfMode($('#toggle-bg-perf').is(':checked'));
      bgLayer.onPostFiltersChange = applyStageFilters;
      window.__bgLayer = bgLayer;
      renderBgParams(bgLayer.mode);
      applyStageFilters();
    }

    // stage 滤镜合成：HDR Bloom（可选）+ 背景层后处理滤镜（M5）
    function applyStageFilters() {
      var filters = [];
      if ($('#toggle-bloom').is(':checked') && bloomFilter) filters.push(bloomFilter);
      var extra = bgLayer ? bgLayer.getPostFilters() : [];
      for (var i = 0; i < extra.length; i++) filters.push(extra[i]);
      stage.filters = filters;
    }

    var lastTs = 0;

    function update(ts) {
      // 帧率无关化：dt 为 60fps 基准倍率，dtSec 为秒。
      // dt clamp（>4）：标签页切回/系统卡顿后的极端帧不让特效爆闪（coreLayer 内部已 clamp，这里保护其余层）
      if (!lastTs) lastTs = ts;
      var dt = (ts - lastTs) / 16.667 || 1;
      if (dt > 4) dt = 4;
      lastTs = ts;
      var dtSec = Math.min(dt / 60, 0.05);

      // 空间视差：鼠标驱动的低通「相机」。
      // 交互平面（粒子/涟漪/网格/歌词/光标）锚定不动，保证点击落点精确；
      // 背景层位移最大（×11）、星场三层按深度错位（×6 内部再分层）、中心特效接近锚定（×1.6）。
      var camActive = trailPrimed && !reducedMotion;
      var camTX = camActive ? (cursorTx / windowWidth - 0.5) * 2 : 0;
      var camTY = camActive ? (cursorTy / windowHeight - 0.5) * 2 : 0;
      var camK = 1 - Math.exp(-4 * dtSec);
      camX += (camTX - camX) * camK;
      camY += (camTY - camY) * camK;
      if (starfield) starfield.setOffset(-camX * 6, -camY * 6);
      if (bgLayer) bgLayer.setOffset(-camX * 11, -camY * 11);
      if (coreLayer) coreLayer.setOffset(-camX * 1.6, -camY * 1.6);

      // 频谱数据源：优先网易云（若在播放，含本地文件），否则 DJ 引擎
      var spectrumData = netease.isPlaying() ? netease.getSpectrumData() : djFx.getSpectrumData();
      // 模组 rainbow-spectrum：彩虹频谱色相流转
      spectrum.rainbow = !!(playerCard && playerCard.isModEnabled('rainbow-spectrum'));
      spectrum.draw(spectrumData, dtSec);

      // 能量读取：低频 / 中频 / 高频
      var lo = 0, mid = 0, hi = 0;
      if (spectrumData) {
        lo = avg(spectrumData, 0, 11) / 255;
        mid = avg(spectrumData, 11, 33) / 255;
        hi = avg(spectrumData, 33, 81) / 255;
      }

      // 背景色平滑过渡（约 300ms 级）
      if (currentBg !== targetBg) {
        var bgLerp = 1 - Math.exp(-6 * dtSec);
        currentBg = lerpColorNumber(currentBg, targetBg, bgLerp);
        if (Math.abs(currentBg - targetBg) < 0x010101) currentBg = targetBg;
        renderer.backgroundColor = currentBg;
      }

      // 低频脉冲：改用 BeatGrid 网格包络，落在 16 分音符上（不看能量绝对值）
      var beat = djFx.getBeatInfo(); // 提前取数：脉冲关闭时 bass-explode 仍可用网格对拍
      var pulseEnabled = pulseToggleEl ? pulseToggleEl.checked : false;
      var targetScale = 0;
      if (reducedMotion) {
        lowFreqValue = 0; // 恒为 1，不做平滑过渡
        targetScale = 0;
        pulseAmp = 0;
        lastStepIndex = -1;
        lastBassStep = -1;
      } else if (pulseEnabled) {
        if (beat && beat.confident && beat.stepDur) {
          if (beat.stepIndex !== lastStepIndex) {
            lastStepIndex = beat.stepIndex;
            var si = ((beat.stepIndex % 16) + 16) % 16;
            if (si % 4 === 0) { // 只在拍点触发整屏缩放，16 分音符不驱动整屏
              pulseAmp = (si === 0) ? 1.0 : 0.72;
              cursorBreath = 1; // 光标与整屏同步呼吸：拍点起一个极小包络
            }
          }
          pulseAmp *= Math.exp(-7 * dtSec);
          targetScale = pulseAmp * 0.016;
        } else {
          // 无可靠网格：退回能量驱动
          targetScale = lo * 0.015;
          pulseAmp = 0;
          lastStepIndex = -1;
          lastBassStep = -1;
        }
      } else {
        pulseAmp = 0;
        lastStepIndex = -1;
        lastBassStep = -1;
      }
      lowFreqValue += (targetScale - lowFreqValue) * (1 - Math.exp(-14 * dtSec));
      stage.scale.set(1 + lowFreqValue, 1 + lowFreqValue);

      // 全局星空：通用/星云/极光/流星雨显示；穿梭自带速度线，自动去重
      if (starfield) {
        var modeId = bgLayer ? bgLayer.mode : '';
        starfield.setEnabled(fx.starfield && modeId !== 'warp');
        starfield.setEnergy(fx.starfield ? hi : 0);
        starfield.update(dtSec);
      }

      // 氛围粒子：BGM 运行时每帧低密度喷射慢速长寿命粒子（画面永不静止）
      if (djStarted && spectrumData) {
        var amb1 = toLocalPoint(windowWidth * Math.random(), windowHeight * Math.random());
        particles.emitAmbient(amb1.x, amb1.y, lo);
        // 模组 cover-ambient：封面氛围增强（隔帧追加氛围粒子，稳态约 1.5 倍）
        ambientFlip = !ambientFlip;
        if (playerCard && playerCard.isModEnabled('cover-ambient') && ambientFlip) {
          var amb2 = toLocalPoint(windowWidth * Math.random(), windowHeight * Math.random());
          particles.emitAmbient(amb2.x, amb2.y, lo);
        }
        // 模组 bass-explode：小节头触发（网格路径）；无网格退回上升沿 + 节流
        if (!reducedMotion && playerCard && playerCard.isModEnabled('bass-explode')) {
          if (beat && beat.confident && beat.stepDur) {
            var bi = ((beat.stepIndex % 16) + 16) % 16;
            if (bi === 0 && beat.stepIndex !== lastBassStep) {
              lastBassStep = beat.stepIndex;
              var bp = toLocalPoint(
                windowWidth / 2 + (Math.random() - 0.5) * 180,
                windowHeight / 2 + (Math.random() - 0.5) * 180
              );
              particles.emit(bp.x, bp.y);
            }
          } else if (lo > 0.28 && lo - prevLo > 0.05 && ts - lastBassBurst > 350) {
            lastBassBurst = ts;
            var bp2 = toLocalPoint(
              windowWidth / 2 + (Math.random() - 0.5) * 180,
              windowHeight / 2 + (Math.random() - 0.5) * 180
            );
            particles.emit(bp2.x, bp2.y);
          }
        }
        prevLo = lo;
      }

      particles.update(dtSec);
      ripple.update(dtSec);
      grid.update(dtSec);

      // 音游模式：note 调度 + 判定过期 + 提示光框（媒体时钟驱动）
      if (window.RhythmGame && RhythmGame.mode === 'rhythm') {
        RhythmGame.tick();
        updateRhythmHud();
      }

      // 中心特效（流体核心 / 音频多面体 / 关闭）
      if (coreLayer) coreLayer.tick(dt, spectrumData);

      // 背景模式系统（接收频谱，按模式绘制）
      if (bgLayer) bgLayer.tick(dt, spectrumData);

      // 歌词演出层（模组 lyric-overlay）：经典单行 / 逐字点亮，行切换在内部处理
      if (lyricStage) {
        var showLyric = playerCard && playerCard.isModEnabled('lyric-overlay') && netease.isPlaying();
        var currentSong = netease.currentSong;
        lyricStage.update(dtSec, {
          visible: !!showLyric,
          time: (netease.audio && netease.audio.currentTime) || 0,
          duration: (netease.audio && netease.audio.duration) || 0,
          lines: playerCard ? playerCard.lyricLines : null,
          opts: playerCard ? playerCard.lyricOpts : null,
          paused: !!(netease.audio && netease.audio.paused),
          theme: getTheme(themeId),
          audio: {
            power: Math.max(lo, mid, hi),
            bands: { bass: lo, lowMid: (lo + mid) / 2, mid: mid, vocal: mid, treble: hi },
            spectrum: spectrumData
          },
          coverUrl: currentSong ? currentSong.coverUrl : '',
          song: currentSong ? { id: currentSong.id, title: currentSong.name, artist: currentSong.artist, album: currentSong.album || '' } : null
        });
      }

      // 自定义光标：拖尾流星（亮核 0 延迟，光尾与火星在 canvas 上绘制）
      drawStarCursor(dtSec);

      renderer.render(stage);
      requestAnimationFrame(update);
    }

    function avg(arr, from, to) {
      var s = 0, n = 0;
      for (var i = from; i <= to && i < arr.length; i++) { s += arr[i]; n++; }
      return n ? s / n : 0;
    }

    // 颜色 number 的三通道 lerp
    function lerpColorNumber(from, to, t) {
      var fr = (from >> 16) & 0xff, fg = (from >> 8) & 0xff, fb = from & 0xff;
      var tr = (to >> 16) & 0xff, tg = (to >> 8) & 0xff, tb = to & 0xff;
      var r = Math.round(fr + (tr - fr) * t);
      var g = Math.round(fg + (tg - fg) * t);
      var b = Math.round(fb + (tb - fb) * t);
      return (r << 16) | (g << 8) | b;
    }

    this.init = init;
  };

  (new MainManager()).init();
});

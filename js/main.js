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
    var coreLayer = null; // 中心特效层（流体核心 / 曼陀罗 / 星环 / 多面体）
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
    var lastBassBurst = 0; // 低音爆发模组的节流时间戳
    var ambientFlip = false; // cover-ambient 模组隔帧发射（控制稳态粒子数）
    var prevLo = 0; // 上一帧低频值（bass-explode 上升沿检测）
    var aiThemeEnabled = true; // 播放器右侧面板可关闭 AI 主题自动应用
    var gameStarted = false; // 欢迎页是否已完成退场
    var focusBeforePanel = null; // 面板关闭后焦点归还
    var inertedSiblings = []; // 窗口打开时被 inert 的兄弟节点
    var currentSettingsPane = 'tone';
    var showSettingsPane = null;
    // 背景色过渡
    var currentBg = getTheme(themeId).background;
    var targetBg = currentBg;

    function init() {
      windowWidth = $(window).width();
      windowHeight = $(window).height();

      // PIXI v6 渲染器
      renderer = PIXI.autoDetectRenderer(windowWidth, windowHeight, {
        backgroundColor: getTheme(themeId).background,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1
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
      // 全局视差星空：位于所有特效之下（通用/隐现/莫奈/漫游）
      starfield = new ParallaxStarfield(renderContainer, getTheme(themeId));
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
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
      }, { getTheme: getTheme });
      bgLayer.onPostFiltersChange = applyStageFilters;
      window.__bgLayer = bgLayer;

      playerCard = new PlayerCard(netease);
      window.__playerCard = playerCard;
      // 歌曲封面 → 背景层（通用/莫奈/漫游 取图，隐现取色）
      playerCard.onTrackChange = function (song) {
        if (bgLayer && song && song.coverUrl) bgLayer.setCover(song.coverUrl);
        if (coreLayer) coreLayer.clear(); // 换歌：曼陀罗/星环痕迹淡出清空
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
      var r = getNote(x, y);
      var pos = toLocalPoint(x, y);
      var cell = grid.getCell(pos.x, pos.y);
      var row = 3 - cell.row; // 反转：上行(屏幕上方)=旋律组 row 0
      djFx.playNote(r.note, r.pan, row);
      particles.cancelMesh(); // 点击打断星座重组
      particles.emit(pos.x, pos.y);
      ripple.emit(pos.x, pos.y);
      if (coreLayer) coreLayer.onTap(pos.x, pos.y, 1);
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
        djFx.playNote(r.note, r.pan, row);
        lastCellKey = cellKey;
      }

      particles.emit(pos.x, pos.y);
      ripple.emit(pos.x, pos.y);
      if (coreLayer) coreLayer.onTap(pos.x, pos.y, 0.55);
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

    function openWindow(panelSel, coverSel, panelEl, focusEl) {
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
      $(panelSel).removeClass('open');
      $(coverSel).removeClass('open');
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

      // 键位决定声像与落点
      var code = k.charCodeAt(0) || 32;
      var pan = ((code % 10) / 9) * 2 - 1;
      var x = windowWidth * (0.15 + ((code * 37) % 70) / 100);
      var y = windowHeight * (0.2 + ((code * 53) % 60) / 100);

      var delay = djFx.playAutoBeat(pan);
      var fire = function () {
        var pos = toLocalPoint(x, y);
        particles.emit(pos.x, pos.y);
        ripple.emit(pos.x, pos.y);
        if (coreLayer) coreLayer.onTap(pos.x, pos.y, 0.8);
        var cell = grid.getCell(pos.x, pos.y);
        var theme = getTheme(themeId);
        grid.highlight(cell.col, cell.row, theme.particles[cell.col % theme.particles.length]);
        targetBg = theme.backgrounds[cell.row] || theme.background;
      };
      if (delay > 0.02) setTimeout(fire, delay * 1000);
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

    function bindSettings() {
      bindSettingsNav();
      // 音色
      $('input[name="waveform"]').change(function () {
        audio.setWaveform($(this).val());
        $('#waveform-grid .option-item').removeClass('selected');
        $(this).closest('.option-item').addClass('selected');
      });

      // 主题
      $('.theme-chip').click(function () {
        themeId = $(this).data('theme');
        var theme = getTheme(themeId);
        targetBg = theme.background; // 由主循环平滑过渡
        particles.setTheme(theme);
        if (starfield) starfield.setTheme(theme);
        ripple.setTheme(theme);
        spectrum.setTheme(theme);
        grid.setTheme(theme);
        if (coreLayer) coreLayer.setTheme(theme);
        djFx.setTheme(themeId); // BGM 的 BPM/调式/音色即时生效
        if (bgLayer) bgLayer.retheme(themeId); // 背景模式换色
        applyUiTheme(theme); // UI 强调色 / 面板底色同步
        $('.theme-chip').removeClass('active');
        $(this).addClass('active');
      });

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
        if (!name || !$panes.filter('[data-pane="' + name + '"]').length) name = 'tone';
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

      var saved = 'tone';
      try { saved = localStorage.getItem('uta.settingsPane') || 'tone'; } catch (e) { /* ignore */ }
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
      }, { getTheme: getTheme });
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
      // 帧率无关化：dt 为 60fps 基准倍率，dtSec 为秒
      if (!lastTs) lastTs = ts;
      var dt = (ts - lastTs) / 16.667 || 1;
      lastTs = ts;
      var dtSec = Math.min(dt / 60, 0.05);

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

      // 低频脉冲：整舞台 ±1.5%，围绕画面中心
      var pulseEnabled = $('#toggle-pulse').is(':checked');
      if (pulseEnabled && spectrumData) {
        var targetScale = lo * 0.015;
        lowFreqValue += (targetScale - lowFreqValue) * (1 - Math.exp(-8 * dtSec));
      } else {
        lowFreqValue += (0 - lowFreqValue) * (1 - Math.exp(-6 * dtSec));
      }
      stage.scale.set(1 + lowFreqValue, 1 + lowFreqValue);

      // 全局星空：通用/隐现/莫奈/漫游显示；空/穿梭自带星空，自动去重
      if (starfield) {
        var modeId = bgLayer ? bgLayer.mode : '';
        starfield.setEnabled(fx.starfield && modeId !== 'sora' && modeId !== 'warp');
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
        // 模组 bass-explode：低频上升沿（鼓点起振）触发画布中心爆发（350ms 节流）
        if (playerCard && playerCard.isModEnabled('bass-explode') && lo > 0.28 && lo - prevLo > 0.05 && ts - lastBassBurst > 350) {
          lastBassBurst = ts;
          var bp = toLocalPoint(
            windowWidth / 2 + (Math.random() - 0.5) * 180,
            windowHeight / 2 + (Math.random() - 0.5) * 180
          );
          particles.emit(bp.x, bp.y);
        }
        prevLo = lo;
      }

      particles.update(dtSec);
      ripple.update(dtSec);
      grid.update(dtSec);

      // 中心特效（流体核心 / 曼陀罗 / 星环 / 多面体）
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

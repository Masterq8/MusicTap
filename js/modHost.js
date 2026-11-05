/**
 * modHost.js — 轻量歌词模组宿主（Mini-Folium，API v1）
 * ============================================================
 * 设计目标：借鉴 Folia 的 Folium 契约，但不引入 Electron / React / 签名。
 * 模组是普通经典脚本，加载时调用：
 *
 *   UTAMods.register({
 *     id: 'sample-glow',
 *     name: '示例 · 声光',
 *     version: '0.1.0',
 *     api: 1,
 *     description: '...',
 *     settings: [ ... ],
 *     activate(folium) {
 *       folium.registries.visualizers.register({
 *         id: 'glow',
 *         label: '示例 · 声光',
 *         order: 900,
 *         mount(container, ctx) { ... return function dispose() {}; }
 *       });
 *     }
 *   });
 *
 * 宿主负责：启用/停用、设置持久化、歌词演出注册、ctx 适配、错误隔离、DOM 层清理。
 * 不负责：签名、权限沙箱、远程加载（只加载本地脚本）。
 */
var UTAMods = (function () {
  'use strict';

  var API_VERSION = 1;
  var STORAGE_KEY = 'uta.mods.v1';
  var FONT = 'PingFang SC, Microsoft YaHei, sans-serif';
  var EMPTY_BANDS = { bass: 0, lowMid: 0, mid: 0, vocal: 0, treble: 0 };

  var defs = [];      // 注册顺序
  var mods = {};      // id -> { def, active, disposers, settings, error, visualizerIds }
  var store = loadStore();
  var booted = false;
  var listeners = [];
  var appHooks = { onVisualizersChange: null, onChange: null };

  function loadStore() {
    try {
      var raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
      return {
        enabled: raw && raw.enabled ? raw.enabled : {},
        settings: raw && raw.settings ? raw.settings : {}
      };
    } catch (e) {
      return { enabled: {}, settings: {} };
    }
  }

  function saveStore() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
  }

  function log(level, msg, err) {
    var fn = console[level] || console.log;
    if (err) fn('[UTAMods] ' + msg, err);
    else fn('[UTAMods] ' + msg);
  }

  function isValidId(id) {
    return typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id);
  }

  function findMod(id) {
    return Object.prototype.hasOwnProperty.call(mods, id) ? mods[id] : null;
  }

  /* ---------------- 设置 schema ---------------- */

  function optionValues(schema) {
    if (!schema || !schema.options) return [];
    return schema.options.map(function (o) { return o && o.value != null ? String(o.value) : ''; });
  }

  function defaultValueOf(schema) {
    var v = schema.defaultValue;
    if (schema.type === 'number') {
      v = Number(v);
      if (!isFinite(v)) v = 0;
      if (schema.min != null) v = Math.max(+schema.min, v);
      if (schema.max != null) v = Math.min(+schema.max, v);
      return v;
    }
    if (schema.type === 'boolean') return !!v;
    if (schema.type === 'select') {
      var vals = optionValues(schema);
      return vals.indexOf(String(v)) >= 0 ? String(v) : (vals[0] || '');
    }
    if (schema.type === 'color') {
      return (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v.toLowerCase() : '#00f0ff';
    }
    return v == null ? '' : String(v);
  }

  function coerceValue(schema, value) {
    if (schema.type === 'number') {
      var n = Number(value);
      if (!isFinite(n)) n = defaultValueOf(schema);
      if (schema.min != null) n = Math.max(+schema.min, n);
      if (schema.max != null) n = Math.min(+schema.max, n);
      return n;
    }
    if (schema.type === 'boolean') return !!value;
    if (schema.type === 'select') {
      var vals = optionValues(schema);
      var s = String(value);
      return vals.indexOf(s) >= 0 ? s : defaultValueOf(schema);
    }
    if (schema.type === 'color') {
      return (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) ? value.toLowerCase() : defaultValueOf(schema);
    }
    return value == null ? '' : String(value);
  }

  function buildSettings(def) {
    var saved = store.settings[def.id] || {};
    var out = {};
    (def.settings || []).forEach(function (schema) {
      if (!schema || !schema.key) return;
      out[schema.key] = Object.prototype.hasOwnProperty.call(saved, schema.key)
        ? coerceValue(schema, saved[schema.key])
        : defaultValueOf(schema);
    });
    return out;
  }

  /* ---------------- 注册与启停 ---------------- */

  function register(def) {
    if (!def || !def.id) throw new Error('mod: id is required');
    if (!isValidId(def.id)) throw new Error('mod: invalid id "' + def.id + '"');
    if (def.api != null && +def.api !== API_VERSION) throw new Error('mod: unsupported api ' + def.api);
    if (typeof def.activate !== 'function') throw new Error('mod: activate(folium) is required');
    if (findMod(def.id)) throw new Error('mod: duplicate id "' + def.id + '"');

    var mod = {
      def: def,
      active: false,
      disposers: [],
      visualizerIds: [],
      settingCbs: [],
      settings: buildSettings(def),
      error: null
    };
    mods[def.id] = mod;
    defs.push(def.id);

    if (booted && store.enabled[def.id]) activate(mod);
    emit();
    return { id: def.id };
  }

  function activate(mod) {
    if (!mod || mod.active) return;
    mod.disposers.length = 0;
    mod.visualizerIds.length = 0;
    mod.error = null;
    mod.active = true;

    try {
      var folium = buildFolium(mod);
      var ret = mod.def.activate(folium);
      if (typeof ret === 'function') mod.disposers.push(ret);
    } catch (e) {
      mod.error = (e && e.message) || String(e);
      log('error', 'activate failed: ' + mod.def.id, e);
      deactivate(mod);
      return;
    }
    notifyVisualizers();
  }

  function deactivate(mod) {
    if (!mod) return;
    for (var i = mod.disposers.length - 1; i >= 0; i--) {
      try { mod.disposers[i](); } catch (e) { log('warn', 'dispose failed: ' + mod.def.id, e); }
    }
    mod.disposers.length = 0;
    mod.visualizerIds.length = 0;
    mod.settingCbs.length = 0;
    mod.active = false;
    notifyVisualizers();
  }

  function setEnabled(id, enabled) {
    var mod = findMod(id);
    if (!mod) return false;
    var v = !!enabled;
    store.enabled[id] = v;
    saveStore();
    if (v) activate(mod);
    else deactivate(mod);
    emit();
    return mod.active;
  }

  function setSetting(id, key, value) {
    var mod = findMod(id);
    if (!mod) return;
    var schema = null;
    (mod.def.settings || []).forEach(function (s) {
      if (s && s.key === key) schema = s;
    });
    if (!schema) return;
    var v = coerceValue(schema, value);
    mod.settings[key] = v;
    if (!store.settings[id]) store.settings[id] = {};
    store.settings[id][key] = v;
    saveStore();
    for (var i = 0; i < mod.settingCbs.length; i++) {
      try { mod.settingCbs[i](key, v, mod.settings); } catch (e) { log('warn', 'settings listener failed', e); }
    }
  }

  function getSettings(id) {
    var mod = findMod(id);
    return mod ? mod.settings : null;
  }

  function isEnabled(id) {
    var mod = findMod(id);
    return !!(mod && mod.active);
  }

  function list() {
    return defs.map(function (id) {
      var mod = mods[id];
      return {
        id: mod.def.id,
        name: mod.def.name || mod.def.id,
        version: mod.def.version || '0.0.0',
        author: mod.def.author || '',
        description: mod.def.description || '',
        enabled: !!mod.active,
        error: mod.error,
        settings: (mod.def.settings || []).map(function (s) {
          return {
            key: s.key,
            type: s.type,
            label: s.label || s.key,
            min: s.min,
            max: s.max,
            step: s.step,
            options: s.options || null
          };
        }),
        values: mod.settings
      };
    });
  }

  /* ---------------- folium 对象 ---------------- */

  function buildFolium(mod) {
    return {
      modId: mod.def.id,
      host: {
        name: 'uta-tap',
        version: '1.0.0',
        api: API_VERSION,
        folium: { major: 1, minor: 0 }
      },
      env: {
        context: 'main',
        reducedMotion: !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      },
      log: {
        info: function (msg) { log('info', '[' + mod.def.id + '] ' + msg); },
        warn: function (msg, err) { log('warn', '[' + mod.def.id + '] ' + msg, err); },
        error: function (msg, err) { log('error', '[' + mod.def.id + '] ' + msg, err); }
      },
      registries: {
        visualizers: {
          register: function (def) { return registerVisualizer(mod, def); }
        }
      },
      settings: {
        get: function (key) { return mod.settings[key]; },
        getAll: function () { return mod.settings; },
        onChange: function (cb) {
          mod.settingCbs.push(cb);
          return function () {
            var i = mod.settingCbs.indexOf(cb);
            if (i >= 0) mod.settingCbs.splice(i, 1);
          };
        }
      },
      lyrics: {
        normalize: function (lines, duration) { return LyricTiming.normalize(lines, duration); },
        activeIndex: function (lines, time) { return LyricTiming.activeIndex(lines, time); },
        charProgress: function (ch, time) { return LyricTiming.charProgress(ch, time); },
        lineProgress: function (line, time) { return LyricTiming.lineProgress(line, time); },
        easeOutCubic: function (t) { return LyricTiming.easeOutCubic(t); }
      },
      theme: {
        resolveFontStack: function () { return FONT; },
        resolveTranslationFontStack: function () { return FONT; },
        resolveFontWeight: function (theme, fallback) { return fallback || '300'; }
      },
      onDispose: function (cb) {
        if (typeof cb === 'function') mod.disposers.push(cb);
      }
    };
  }

  function registerVisualizer(mod, def) {
    if (!def || !def.id) throw new Error('visualizer: id is required');
    if (typeof def.mount !== 'function') throw new Error('visualizer: mount(container, ctx) is required');

    var id = 'mod:' + mod.def.id + ':' + def.id;
    var handle = VisualizerRegistry.register({
      id: id,
      label: def.label || def.id,
      order: 900 + (typeof def.order === 'number' ? def.order : 0),
      scope: def.scope === 'immersive' ? 'immersive' : 'lyric',
      create: function (opts) { return createModRenderer(mod, def, opts); }
    });

    var removed = false;
    mod.disposers.push(function () {
      if (removed) return;
      removed = true;
      handle.unregister();
    });
    mod.visualizerIds.push(id);
    notifyVisualizers();
    return { id: id, unregister: handle.unregister };
  }

  /* ---------------- 渲染适配器（DOM 层） ---------------- */

  function mapTheme(theme) {
    if (!theme) return null;
    var particles = theme.particles || [];
    var accent = theme.accent != null ? theme.accent : particles[0];
    return {
      name: theme.name || '',
      backgroundColor: theme.background,
      primaryColor: particles[0] != null ? particles[0] : accent,
      accentColor: accent != null ? accent : 0x00f0ff,
      secondaryColor: particles[1] != null ? particles[1] : accent,
      fontStyle: 'sans',
      fontWeight: '300',
      animationIntensity: 'normal',
      isDaylight: false
    };
  }

  /** 把 uta-tap 的行模型投影成 Folia 同名结构，方便模组迁移 */
  function projectLines(lines) {
    return (lines || []).map(function (l) {
      return {
        id: l.id,
        fullText: l.text || '',
        startTime: l.t,
        endTime: l.end,
        translation: l.tr || '',
        words: (l.words || []).map(function (w) {
          return { text: w.text, startTime: w.start, endTime: w.end };
        }),
        renderHints: {
          rawDuration: Math.max(0, (l.end || l.t) - l.t),
          timingClass: l.timingClass,
          renderEndTime: l.renderEndTime
        }
      };
    });
  }

  function createModRenderer(mod, def, opts) {
    var hooks = { frame: [], resize: [], change: [], time: [], dispose: [] };
    var stateRef = {
      visible: false, time: 0, duration: 0, index: -1, paused: true,
      line: null, next: null, lines: [], width: 0, height: 0,
      theme: null, audio: null, coverUrl: '', song: null
    };
    var last = { index: -2, paused: null, theme: null, cover: null };
    var themeSrc = null;
    var linesSrc = null;
    var layer = null;
    var box = null;
    var disposed = false;
    var failed = false;

    function guard(fn, what) {
      if (failed) return;
      try { fn(); } catch (e) {
        failed = true;
        log('warn', '[' + mod.def.id + '] ' + what + ' failed', e);
      }
    }

    function unsubscribe(arr, cb) {
      return function () {
        var i = arr.indexOf(cb);
        if (i >= 0) arr.splice(i, 1);
      };
    }

    // 设置变化也走 ctx.onChange，和 Folia 的契约一致
    var settingListener = function () {
      for (var i = 0; i < hooks.change.length; i++) guard(function () { hooks.change[i](); }, 'change');
    };
    mod.settingCbs.push(settingListener);

    var display = {
      showText: true,
      lyricsFontScale: 1,
      subtitleFontScale: 0.45,
      subtitleOverlayOpacity: 1,
      subtitleOverlayBackground: false,
      subtitleUpcomingLyricsBlur: 0,
      showHarmonySubtitle: false,
      harmonySubtitleBackground: false,
      showSubtitleTranslation: true,
      hideTranslationSubtitle: false,
      subtitleContentMode: 'translation',
      isPlayerChromeHidden: false,
      isPanelOpen: false,
      visualizerOpacity: 1
    };

    var ctx = {
      seed: mod.def.id,
      staticMode: false,
      staticLineIndex: -1,
      isPreview: false,
      lyricTime: {
        get: function () { return stateRef.time; },
        onLyricTime: function (cb) {
          hooks.time.push(cb);
          return unsubscribe(hooks.time, cb);
        }
      },
      // 兼容直接使用 ctx.onLyricTime 的模组（Folia 公开契约的两种写法）
      onLyricTime: function (cb) {
        hooks.time.push(cb);
        return unsubscribe(hooks.time, cb);
      },
      getDuration: function () { return stateRef.duration; },
      getLineIndex: function () { return stateRef.index; },
      isPaused: function () { return stateRef.paused; },
      getTheme: function () { return stateRef.theme; },
      getSubtitleTheme: function () { return stateRef.theme; },
      getCoverUrl: function () { return stateRef.coverUrl; },
      getDisplay: function () { return display; },
      getSettings: function () { return mod.settings; },
      getSurface: function () { return { hostBackground: false }; },
      audio: {
        getSpectrum: function () { return stateRef.audio ? stateRef.audio.spectrum : null; },
        getBands: function () { return stateRef.audio && stateRef.audio.bands ? stateRef.audio.bands : EMPTY_BANDS; },
        getPower: function () { return stateRef.audio ? (+stateRef.audio.power || 0) : 0; }
      },
      onChange: function (cb) { hooks.change.push(cb); return unsubscribe(hooks.change, cb); },
      onResize: function (cb) { hooks.resize.push(cb); return unsubscribe(hooks.resize, cb); },
      onFrame: function (cb) { hooks.frame.push(cb); return unsubscribe(hooks.frame, cb); },
      onDispose: function (cb) { hooks.dispose.push(cb); return unsubscribe(hooks.dispose, cb); }
    };

    Object.defineProperty(ctx, 'lines', {
      get: function () { return stateRef.lines; }
    });
    Object.defineProperty(ctx, 'song', {
      get: function () { return stateRef.song || { id: 0, title: '', artist: '' }; }
    });

    return {
      mount: function () {
        if (disposed) return;
        layer = document.createElement('div');
        layer.className = 'uta-mod-layer';
        layer.setAttribute('data-mod', mod.def.id);
        layer.style.cssText = 'position:fixed;inset:0;z-index:3;pointer-events:none;overflow:hidden;';
        box = document.createElement('div');
        box.style.cssText = 'position:absolute;inset:0;';
        layer.appendChild(box);
        document.body.appendChild(layer);

        guard(function () {
          var ret = def.mount(box, ctx);
          if (typeof ret === 'function') hooks.dispose.push(ret);
          else if (ret && typeof ret.then === 'function') {
            ret.then(function (d) { if (typeof d === 'function') hooks.dispose.push(d); })
              .catch(function (e) { guard(function () { throw e; }, 'async mount'); });
          }
        }, 'mount');
      },

      update: function (dt, s) {
        if (disposed) return;
        stateRef.visible = !!s.visible;
        stateRef.time = +s.time || 0;
        stateRef.duration = +s.duration || 0;
        stateRef.index = s.index;
        stateRef.line = s.line;
        stateRef.next = s.next;
        if (linesSrc !== s.lines) {
          linesSrc = s.lines;
          stateRef.lines = projectLines(s.lines);
        }
        stateRef.paused = !!s.paused;
        stateRef.width = s.width;
        stateRef.height = s.height;
        if (themeSrc !== s.theme) {
          themeSrc = s.theme;
          stateRef.theme = mapTheme(s.theme);
        }
        stateRef.audio = s.audio || null;
        stateRef.coverUrl = s.coverUrl || '';
        stateRef.song = s.song || null;

        for (var i = 0; i < hooks.time.length; i++) guard(function () { hooks.time[i](stateRef.time); }, 'lyricTime');

        var themeKey = stateRef.theme;
        if (stateRef.index !== last.index || stateRef.paused !== last.paused
          || themeKey !== last.theme || stateRef.coverUrl !== last.cover) {
          last.index = stateRef.index;
          last.paused = stateRef.paused;
          last.theme = themeKey;
          last.cover = stateRef.coverUrl;
          for (var j = 0; j < hooks.change.length; j++) guard(function () { hooks.change[j](); }, 'change');
        }

        for (var k = 0; k < hooks.frame.length; k++) guard(function () { hooks.frame[k](dt, stateRef); }, 'frame');
      },

      resize: function (w, h) {
        if (disposed) return;
        stateRef.width = w;
        stateRef.height = h;
        for (var i = 0; i < hooks.resize.length; i++) guard(function () { hooks.resize[i](w, h); }, 'resize');
      },

      dispose: function () {
        if (disposed) return;
        disposed = true;
        var si = mod.settingCbs.indexOf(settingListener);
        if (si >= 0) mod.settingCbs.splice(si, 1);
        for (var i = hooks.dispose.length - 1; i >= 0; i--) {
          try { hooks.dispose[i](); } catch (e) { log('warn', '[' + mod.def.id + '] dispose failed', e); }
        }
        hooks.dispose.length = 0;
        hooks.frame.length = 0;
        hooks.resize.length = 0;
        hooks.change.length = 0;
        hooks.time.length = 0;
        if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
        layer = null;
        box = null;
      }
    };
  }

  /* ---------------- 宿主事件 ---------------- */

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](list()); } catch (e) { log('warn', 'listener failed', e); }
    }
    if (appHooks.onChange) {
      try { appHooks.onChange(list()); } catch (e) { log('warn', 'app onChange failed', e); }
    }
  }

  function notifyVisualizers() {
    if (appHooks.onVisualizersChange) {
      try { appHooks.onVisualizersChange(); } catch (e) { log('warn', 'onVisualizersChange failed', e); }
    }
  }

  function init(opts) {
    opts = opts || {};
    appHooks.onVisualizersChange = opts.onVisualizersChange || null;
    appHooks.onChange = opts.onChange || null;
    if (booted) return;
    booted = true;
    defs.forEach(function (id) {
      if (store.enabled[id]) activate(mods[id]);
    });
    emit();
  }

  function onChange(cb) {
    listeners.push(cb);
    return function () {
      var i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  return {
    apiVersion: API_VERSION,
    register: register,
    list: list,
    init: init,
    onChange: onChange,
    enable: function (id) { return setEnabled(id, true); },
    disable: function (id) { return setEnabled(id, false); },
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    getSettings: getSettings,
    setSetting: setSetting
  };
})();

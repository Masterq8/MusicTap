/**
 * visualizerRegistry.js — 歌词演出注册表
 * ============================================================
 * 与 BgLayer.modes() / CoreLayer.modes() 的手写注册保持一致，但把
 * 「模式声明」和「实例生命周期」分开：
 *
 *   VisualizerRegistry.register({
 *     id: 'karaoke',
 *     label: '逐字点亮',
 *     order: 30,
 *     create: function (opts) { return renderer; },
 *     settings: []            // 预留：Phase 2 模组设置 schema
 *   });
 *
 * renderer 需要实现：mount(host) / update(dt, state) / resize(w, h) / dispose()
 */
var VisualizerRegistry = (function () {
  'use strict';

  var items = [];

  function indexOf(id) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) return i;
    }
    return -1;
  }

  function register(def) {
    if (!def || !def.id) throw new Error('visualizer: id is required');
    if (typeof def.create !== 'function') throw new Error('visualizer: create() is required');
    if (indexOf(def.id) >= 0) throw new Error('visualizer: duplicate id "' + def.id + '"');

    var entry = {
      id: String(def.id),
      label: def.label || def.id,
      order: typeof def.order === 'number' ? def.order : 0,
      scope: def.scope === 'immersive' ? 'immersive' : 'lyric',
      create: def.create,
      settings: def.settings || null
    };
    items.push(entry);
    items.sort(function (a, b) { return a.order - b.order; });

    return {
      id: entry.id,
      unregister: function () {
        var i = indexOf(entry.id);
        if (i >= 0) items.splice(i, 1);
      }
    };
  }

  function list() {
    return items.slice();
  }

  function get(id) {
    var i = indexOf(id);
    return i >= 0 ? items[i] : null;
  }

  function has(id) {
    return indexOf(id) >= 0;
  }

  return {
    register: register,
    list: list,
    get: get,
    has: has
  };
})();

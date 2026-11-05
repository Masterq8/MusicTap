/**
 * modLoader.js — ES Module 模组加载桥（经典脚本）
 * ============================================================
 * 原生 Folia 模组是 `client.mjs`（export default activate），而本项目是经典脚本、
 * 无构建、可直接 file:// 打开。这里用动态 import() 把 ESM 模组接进 UTAMods：
 *
 *   UTAModsESM.register({ id, entry, name, version, author, description });
 *
 * 加载成功后调用 UTAMods.register(...)，由宿主负责启用/停用与设置面板。
 * 注意：file:// 下 Chrome 会拦截 ESM import，模组会被跳过并在控制台提示；
 * 用 http://（本机或局域网）打开即可正常加载。
 */
var UTAModsESM = (function () {
  'use strict';

  var VERSION = '20261105';

  function register(meta) {
    if (!meta || !meta.id || !meta.entry) return;
    if (typeof UTAMods === 'undefined') {
      console.warn('[UTAMods] 宿主未加载，跳过模组：' + meta.id);
      return;
    }

    var url;
    try {
      url = new URL(meta.entry, document.baseURI).href;
    } catch (e) {
      url = meta.entry;
    }
    url += (url.indexOf('?') >= 0 ? '&' : '?') + 'v=' + VERSION;

    import(url).then(function (mod) {
      if (!mod || typeof mod.default !== 'function') {
        throw new Error('缺少 default export');
      }
      UTAMods.register({
        id: meta.id,
        name: meta.name || meta.id,
        version: meta.version || '0.0.0',
        author: meta.author || '',
        description: meta.description || '',
        api: 1,
        settings: [],
        activate: function (folium) { return mod.default(folium); }
      });
    }).catch(function (e) {
      console.warn('[UTAMods] 模组加载失败：' + meta.id + '（file:// 下请改用 http:// 打开）', e);
    });
  }

  return { version: VERSION, register: register };
})();

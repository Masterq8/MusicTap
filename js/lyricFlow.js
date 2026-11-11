/**
 * lyricFlow.js — 歌词演出的换行编排层
 * ============================================================
 * 13 个内置演出场景共用同一套"换行节拍"：
 *   预入场 lead → 交叉淡出 overlap → 落位 settle → 逐字点亮
 *
 * 只提供三样东西，不碰 DOM：
 *   1. TR          统一时长/缓动 token（改这里，13 个场景一起变）
 *   2. aheadIndex  把"当前句"提前到预入场窗口，解决入场动画永远迟到
 *   3. leadOf      按句间隔自适应提前量（短句少提，长句多提）
 *
 * 场景内的节点生命周期由 Scene.retire() 用音频时钟管理，
 * 不走 setTimeout —— 暂停/拖动时不会残留旧层或提前删掉新层。
 */
var LyricFlow = (function () {
  'use strict';

  var TR = {
    leadRatio: 0.22,     // 提前量 = 句间隔 × 该比例
    leadMin: 0.16,       // 最短提前（连续短句）
    leadMax: 0.52,       // 最长提前（长间奏后的第一句）
    enter: 0.34,         // 入场时长
    exit: 0.26,          // 退场时长
    overlap: 0.30,       // 交叉淡出重叠窗口
    settle: 0.22,        // 落位时长
    stagger: 0.035,      // 逐字/逐段默认错峰
    staggerMax: 0.22,    // 错峰总时长上限（避免长句尾巴拖太久）
    blurOut: 6,          // 退场模糊半径
    ease: 'cubic-bezier(.22,1,.36,1)',
    easeIn: 'cubic-bezier(.32,0,.67,0)'
  };

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  var reducedCache = null;
  function reduced() {
    if (reducedCache == null) {
      try {
        reducedCache = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch (e) { reducedCache = false; }
    }
    return reducedCache;
  }

  /** 某一行应提前多久入场：间隔越大提前越多，但压在 [leadMin, leadMax] 内 */
  function leadOf(line, prev, scale) {
    if (!line) return TR.leadMin;
    var gap = prev ? Math.max(0.4, (line.t || 0) - (prev.t || 0)) : 1.6;
    return clamp(gap * TR.leadRatio * (scale == null ? 1 : scale), TR.leadMin, TR.leadMax);
  }

  /**
   * 从真实索引 base 向前推进到"已进入预入场窗口"的索引。
   * base < 0（前奏/间奏）时，只要第一句进入窗口也会返回 0。
   */
  function aheadIndex(lines, base, time, scale) {
    if (!lines || !lines.length) return base;
    var i = base < 0 ? -1 : base;
    if (i >= lines.length - 1) return i;
    var guard = 0;
    while (i + 1 < lines.length && guard++ < 12) {
      var next = lines[i + 1];
      if (!next || next.t == null) break;
      if (next.t - leadOf(next, i >= 0 ? lines[i] : null, scale) <= time) i++;
      else break;
    }
    return i;
  }

  /** 逐字错峰延迟：总时长封顶，短句自动压缩 */
  function staggerAt(index, count, span) {
    if (!count || count < 2) return 0;
    var max = span == null ? TR.staggerMax : span;
    var step = Math.min(TR.stagger, max / count);
    return Math.min(max, index * step);
  }

  return {
    TR: TR,
    clamp: clamp,
    reduced: reduced,
    leadOf: leadOf,
    aheadIndex: aheadIndex,
    staggerAt: staggerAt
  };
})();

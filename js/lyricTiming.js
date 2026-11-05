/**
 * lyricTiming.js — 歌词演出内核（行窗口 + 逐字时序）
 * ============================================================
 * 把 lyrics.js 的 { t, text, words, tr } 规范化为演出层可直接使用的结构：
 *   { t, end, timingEnd, text, tr, words, chars, timingClass, renderEndTime }
 *
 * - end：显示结束时间（下一行开始 / 歌曲结束 / 兜底 6s）
 * - timingEnd：逐字时序窗口（长间奏时截断到 6s，避免逐字被拉得极慢）
 * - chars：与 text 的码点一一对应的逐字时间
 * - YRC / 增强 LRC 有真实逐字时直接采用；纯 LRC 按字重分配 92% 行时长
 */
(function (global) {
  'use strict';

  var MAX_TIMING_SPAN = 6;      // 纯 LRC 逐字窗口上限（秒）
  var MAX_TIMING_RATIO = 0.92;  // 只用行时长的 92%，句尾留呼吸
  var MIN_CHAR_SPAN = 0.06;
  var CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;
  var LATIN_RE = /[A-Za-z0-9]/;

  function clamp(v, a, b) {
    return v < a ? a : (v > b ? b : v);
  }

  function easeOutCubic(t) {
    t = clamp(t, 0, 1);
    return 1 - Math.pow(1 - t, 3);
  }

  /** 字符在行内的“唱念权重”：CJK 最重，拉丁字母/数字次之，标点与空格最轻 */
  function charWeight(ch) {
    if (!ch) return 0.35;
    if (/\s/.test(ch)) return 0.35;
    if (CJK_RE.test(ch)) return 1;
    if (LATIN_RE.test(ch)) return 0.75;
    return 0.45;
  }

  /** 统一逐字时间对象，保证 start < end */
  function makeChar(text, start, end) {
    if (!(end > start)) end = start + MIN_CHAR_SPAN;
    return { text: text, start: start, end: end };
  }

  /** 把 words 规范成 { text, start, end }；没有 d 时用下一个词/行尾兜底 */
  function normalizeWords(words, timingEnd) {
    var out = [];
    if (!words || !words.length) return out;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var start = +w.t;
      if (!isFinite(start)) continue;
      var end;
      if (w.d != null && +w.d > 0) {
        end = start + (+w.d);
      } else if (i + 1 < words.length && +words[i + 1].t > start) {
        end = +words[i + 1].t;
      } else {
        end = timingEnd;
      }
      if (!(end > start)) end = start + 0.12;
      out.push({ text: w.text || '', start: start, end: end });
    }
    return out;
  }

  /** 词文本与整行逐字拼接一致时，按词窗口均分到每个字符 */
  function charsFromWords(chars, words) {
    if (!words.length || !chars.length) return null;
    var joined = '';
    for (var w = 0; w < words.length; w++) joined += words[w].text;
    if (joined !== chars.join('')) return null;

    var out = [];
    for (var i = 0; i < words.length; i++) {
      var wc = Array.from(words[i].text);
      if (!wc.length) continue;
      var span = Math.max(MIN_CHAR_SPAN * wc.length, words[i].end - words[i].start);
      var per = span / wc.length;
      for (var k = 0; k < wc.length; k++) {
        out.push(makeChar(wc[k], words[i].start + per * k, words[i].start + per * (k + 1)));
      }
    }
    return out.length === chars.length ? out : null;
  }

  /** 没有逐字标记：按字重分配 92% 行时长 */
  function charsByWeight(chars, start, timingEnd) {
    var span = Math.max(0.35, Math.min(MAX_TIMING_SPAN, timingEnd - start) * MAX_TIMING_RATIO);
    var total = 0;
    var weights = new Array(chars.length);
    for (var i = 0; i < chars.length; i++) {
      weights[i] = charWeight(chars[i]);
      total += weights[i];
    }
    if (total <= 0) total = chars.length || 1;

    var t = start;
    var out = [];
    for (var j = 0; j < chars.length; j++) {
      var d = span * weights[j] / total;
      out.push(makeChar(chars[j], t, t + d));
      t += d;
    }
    return out;
  }

  /**
   * 规范化整首歌词。
   * @param {Array} lines  lyrics.js 输出：{ t, text, words?, tr? }
   * @param {number} duration 歌曲总时长（秒），未知传 0
   */
  function normalize(lines, duration) {
    if (!lines || !lines.length) return [];
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i] || {};
      var t = +raw.t;
      if (!isFinite(t)) continue;

      var nextT = i + 1 < lines.length ? +lines[i + 1].t : 0;
      var end;
      if (nextT > t) end = nextT;
      else if (duration > t) end = +duration;
      else end = t + MAX_TIMING_SPAN;

      var timingEnd = Math.min(end, t + MAX_TIMING_SPAN);
      if (timingEnd <= t) timingEnd = t + MAX_TIMING_SPAN;

      var text = raw.text || '';
      var chars = Array.from(text);
      var words = normalizeWords(raw.words || [], timingEnd);
      var timed = charsFromWords(chars, words);
      if (!timed) timed = charsByWeight(chars, t, timingEnd);

      var dur = Math.max(0.1, timingEnd - t);
      out.push({
        t: t,
        end: end,
        timingEnd: timingEnd,
        text: text,
        tr: raw.tr || '',
        words: words,
        chars: timed,
        timingClass: dur < 0.10 ? 'micro' : (dur < 0.18 ? 'short' : 'normal'),
        renderEndTime: end
      });
    }
    return out;
  }

  /** 二分查找当前行（最后一个 t <= time 的行） */
  function activeIndex(lines, time) {
    if (!lines || !lines.length) return -1;
    var lo = 0;
    var hi = lines.length - 1;
    var ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].t <= time) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  /** 单字进度 0..1 */
  function charProgress(ch, time) {
    if (!ch) return 0;
    if (time <= ch.start) return 0;
    if (time >= ch.end) return 1;
    return clamp((time - ch.start) / Math.max(0.001, ch.end - ch.start), 0, 1);
  }

  /** 整行进度 0..1（逐字关闭时使用） */
  function lineProgress(line, time) {
    if (!line) return 0;
    var last = line.chars && line.chars.length ? line.chars[line.chars.length - 1].end : line.timingEnd;
    var span = Math.max(0.2, last - line.t);
    return clamp((time - line.t) / span, 0, 1);
  }

  global.LyricTiming = {
    normalize: normalize,
    activeIndex: activeIndex,
    charProgress: charProgress,
    lineProgress: lineProgress,
    easeOutCubic: easeOutCubic,
    clamp: clamp,
    MAX_TIMING_SPAN: MAX_TIMING_SPAN
  };
})(typeof window !== 'undefined' ? window : globalThis);

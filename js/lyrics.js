/**
 * lyrics.js — 歌词解析（多格式）
 * ============================================================
 * 直接支持网易云后端能拿到的三种主流格式，并统一成同一结构：
 *
 *   LRC           [00:12.34] 一行一句
 *   Enhanced LRC  [00:12.34]<00:12.34>逐<00:12.60>字
 *   YRC           [start,dur](wStart,wDur,0)逐(wStart,wDur,0)字
 *
 * 另外合并翻译轨（tlyric），并提供关键词着色区间。
 * 逐字歌词的 words 为绝对时间（秒），没有逐字时序时 words 为 null（按行推进）。
 */
(function (global) {
  'use strict';

  var TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  var WORD_TAG_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

  function secOf(mm, ss, frac) {
    var s = parseInt(mm, 10) * 60 + parseInt(ss, 10);
    if (frac != null) {
      // 2 位=百分秒，3 位=毫秒
      s += frac.length >= 3 ? parseInt(frac, 10) / 1000 : parseFloat('0.' + frac);
    }
    return s;
  }

  // 增强型 LRC：<mm:ss.xx>word
  function splitWords(body) {
    var marks = [];
    var m;
    WORD_TAG_RE.lastIndex = 0;
    while ((m = WORD_TAG_RE.exec(body)) !== null) {
      marks.push({ t: secOf(m[1], m[2], m[3]), start: m.index, end: WORD_TAG_RE.lastIndex });
    }
    if (!marks.length) return null;
    var words = [];
    for (var i = 0; i < marks.length; i++) {
      var from = marks[i].end;
      var to = i + 1 < marks.length ? marks[i + 1].start : body.length;
      var seg = body.slice(from, to);
      if (seg) words.push({ t: marks[i].t, text: seg });
    }
    if (!words.length) return null;
    var plain = body.replace(WORD_TAG_RE, '');
    return { plain: plain, words: words };
  }

  function parseLrc(text) {
    var out = [];
    (text || '').split(/\r?\n/).forEach(function (raw) {
      var times = [];
      var m;
      TAG_RE.lastIndex = 0;
      while ((m = TAG_RE.exec(raw)) !== null) times.push(secOf(m[1], m[2], m[3]));
      var body = raw.replace(TAG_RE, '').trim();
      if (!body || !times.length) return;
      var split = splitWords(body);
      var plain = split ? split.plain : body;
      if (!plain.trim()) return;
      times.forEach(function (t) {
        out.push({ t: t, text: plain, words: split ? split.words : null });
      });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  // YRC：[start,dur](wStart,wDur,flag)word…
  function parseYrc(text) {
    var out = [];
    (text || '').split(/\r?\n/).forEach(function (raw) {
      var head = raw.match(/^\[(\d+),(\d+)\]/);
      if (!head) return;
      var t = parseInt(head[1], 10) / 1000;
      var rest = raw.slice(head[0].length);
      var words = [];
      var textOut = '';
      var re = /\((\d+),(\d+),\d+\)([^()]*)/g;
      var wm;
      while ((wm = re.exec(rest)) !== null) {
        var seg = wm[3];
        if (!seg) continue;
        words.push({
          t: parseInt(wm[1], 10) / 1000,
          d: parseInt(wm[2], 10) / 1000,
          text: seg
        });
        textOut += seg;
      }
      if (!textOut) textOut = rest.replace(/\(\d+,\d+,\d+\)/g, '');
      if (!textOut.trim()) return;
      out.push({ t: t, text: textOut, words: words.length ? words : null });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  // 翻译轨：同 LRC 结构
  function parseTranslation(text) {
    var out = [];
    (text || '').split(/\r?\n/).forEach(function (raw) {
      var times = [];
      var m;
      TAG_RE.lastIndex = 0;
      while ((m = TAG_RE.exec(raw)) !== null) times.push(secOf(m[1], m[2], m[3]));
      var body = raw.replace(TAG_RE, '').trim();
      if (!body || !times.length) return;
      times.forEach(function (t) { out.push({ t: t, text: body }); });
    });
    return out;
  }

  /**
   * 选择最优格式并合并翻译。
   * @param {{lrc?: string, yrc?: string, tlyric?: string}} raw
   */
  function build(raw) {
    raw = raw || {};
    var lines = [];
    var source = 'none';

    if (raw.yrc && /^\[\d+,\d+\]/m.test(raw.yrc)) {
      lines = parseYrc(raw.yrc);
      source = 'yrc';
    }
    if (!lines.length && raw.lrc && raw.lrc.indexOf('<') >= 0 && WORD_TAG_RE.test(raw.lrc)) {
      WORD_TAG_RE.lastIndex = 0;
      lines = parseLrc(raw.lrc);
      source = 'enhanced-lrc';
    }
    if (!lines.length && raw.lrc) {
      lines = parseLrc(raw.lrc);
      source = 'lrc';
    }
    if (lines.length && raw.tlyric) {
      var tr = parseTranslation(raw.tlyric);
      var j = 0;
      for (var i = 0; i < lines.length; i++) {
        while (j < tr.length && tr[j].t < lines[i].t - 0.4) j++;
        if (j < tr.length && Math.abs(tr[j].t - lines[i].t) <= 0.4) lines[i].tr = tr[j].text;
      }
    }
    var hasWord = lines.some(function (l) { return !!(l.words && l.words.length); });
    return { lines: lines, source: source, hasWord: hasWord };
  }

  /* ---------------- 关键词着色 ---------------- */

  var KEYWORDS = [
    '心动', '拥抱', '孤单', '自由', '永远', '思念', '温柔', '沉默', 'distance',
    '爱', '梦', '光', '夜', '风', '心', '泪', '星', '海', '火', '雨', '云', '月', '花', '天',
    '你', '我', '他', '她', '谁',
    'love', 'dream', 'night', 'light', 'fire', 'rain', 'star', 'sky', 'heart', 'fly'
  ].sort(function (a, b) { return b.length - a.length; });

  /**
   * 返回需要着色的区间（按文中出现顺序，不重叠）。
   * @returns {Array<{start:number,end:number}>}
   */
  function keywordRanges(text) {
    if (!text) return [];
    var out = [];
    var lower = text.toLowerCase();
    for (var i = 0; i < KEYWORDS.length; i++) {
      var kw = KEYWORDS[i];
      var from = 0;
      var at;
      while ((at = lower.indexOf(kw.toLowerCase(), from)) !== -1) {
        var end = at + kw.length;
        var overlap = out.some(function (r) { return at < r.end && end > r.start; });
        if (!overlap) out.push({ start: at, end: end });
        from = end;
      }
    }
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  global.Lyrics = {
    build: build,
    parseLrc: parseLrc,
    parseYrc: parseYrc,
    keywordRanges: keywordRanges
  };
})(typeof window !== 'undefined' ? window : globalThis);

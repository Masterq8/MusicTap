/**
 * player.js — 网易云播放器卡片（独立模块）
 * ============================================
 * 借鉴 folia-major 功能概念：
 *   - 在线搜索与播放（歌曲/歌手/专辑关键词 → 列表 → 播放，自动加载封面与歌词）
 *   - 智能歌词匹配（LRC 解析 + 播放时间同步滚动）
 *   - AI 主题生成（封面主色 + 歌词情绪分析 → 沉浸式背景与视觉参数）
 *   - 模组系统（歌词叠层 / 封面氛围 / 彩虹频谱等，可扩展）
 *
 * 依赖：netease.js（NeteaseBgm 实例由外部注入）
 * 面板 DOM：#player_cover / #player（index.html 提供）
 */
(function (global) {
  'use strict';

  /* ================= LRC 解析 ================= */
  function parseLrc(lrcText) {
    var lines = (lrcText || '').split('\n');
    var out = [];
    var timeRe = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    lines.forEach(function (line) {
      var m;
      var times = [];
      timeRe.lastIndex = 0;
      while ((m = timeRe.exec(line)) !== null) {
        var t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        if (m[3]) t += parseFloat('0.' + m[3]);
        times.push(t);
      }
      var text = line.replace(timeRe, '').trim();
      if (text) {
        times.forEach(function (t) { out.push({ t: t, text: text }); });
      }
    });
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  // 二分查找当前歌词行索引
  function findLrcIndex(lrc, time) {
    if (!lrc.length) return -1;
    var lo = 0, hi = lrc.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lrc[mid].t <= time) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  /* ================= 颜色工具 ================= */
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: h, s: s, l: l };
  }

  function hslToRgb(h, s, l) {
    h = ((h % 1) + 1) % 1;
    var r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      var f = function (t) {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      r = f(h + 1 / 3); g = f(h); b = f(h - 1 / 3);
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  }

  function rgbToNum(c) {
    return (c.r << 16) | (c.g << 8) | c.b;
  }

  // 由封面主色生成 6 色和谐粒子色板（HSL 旋转）
  function paletteFromColor(r, g, b) {
    var hsl = rgbToHsl(r, g, b);
    var palette = [];
    for (var i = 0; i < 6; i++) {
      var h = hsl.h + i * 0.12;              // 色相旋转
      var s = Math.min(1, Math.max(0.45, hsl.s + 0.25));
      var l = 0.45 + (i % 3) * 0.12;          // 明度交替
      palette.push(rgbToNum(hslToRgb(h, s, l)));
    }
    return palette;
  }

  /* ================= 歌词情绪分析（AI 主题生成·规则版） ================= */
  var MOOD_LEXICON = {
    energetic: ['爱', '火', '燃', '飞', '冲', '梦', '光', '追', 'heart', 'fire', 'dream', 'fly', 'run', 'shine'],
    calm: ['夜', '月', '海', '风', '静', '星', '云', '雨后', 'moon', 'sea', 'star', 'wind', 'sleep', 'sky'],
    happy: ['笑', '舞', '跳', '糖', '阳', '夏', 'happy', 'dance', 'sun', 'sweet', 'summer'],
    sad: ['泪', '雨', '离', '别', '痛', 'cry', 'rain', 'goodbye', 'alone', 'lost']
  };

  function analyzeMood(lrcLines) {
    var text = (lrcLines || []).map(function (l) { return l.text; }).join(' ');
    var scores = { energetic: 0, calm: 0, happy: 0, sad: 0 };
    Object.keys(MOOD_LEXICON).forEach(function (mood) {
      MOOD_LEXICON[mood].forEach(function (kw) {
        var idx = text.toLowerCase().indexOf(kw);
        while (idx !== -1) { scores[mood]++; idx = text.toLowerCase().indexOf(kw, idx + kw.length); }
      });
    });
    var best = 'calm', max = -1;
    Object.keys(scores).forEach(function (k) {
      if (scores[k] > max) { max = scores[k]; best = k; }
    });
    // 情绪 → 视觉参数映射
    var params = {
      energetic: { speed: 1.4, density: 1.2, trail: 1.3, brightness: 1.2, bgL: 0.10 },
      calm:      { speed: 0.7, density: 1.0, trail: 0.9, brightness: 0.9, bgL: 0.06 },
      happy:     { speed: 1.1, density: 1.3, trail: 1.1, brightness: 1.3, bgL: 0.14 },
      sad:       { speed: 0.6, density: 0.7, trail: 0.7, brightness: 0.7, bgL: 0.05 }
    };
    var p = params[best];
    p.mood = best;
    p.scores = scores;
    return p;
  }

  /* ================= 模组系统 ================= */
  var MODS = [
    { id: 'lyric-overlay', name: '歌词叠层', desc: '画布中央显示当前歌词行（卡拉OK感）', enabled: true },
    { id: 'cover-ambient', name: '封面氛围增强', desc: '按封面色板加浓氛围粒子', enabled: true },
    { id: 'rainbow-spectrum', name: '彩虹频谱', desc: '频谱雷达按主题色板循环变色', enabled: false },
    { id: 'bass-explode', name: '低音爆发', desc: '低频强时粒子喷射增益', enabled: false }
  ];

  /* ================= PlayerCard ================= */
  function PlayerCard(netease) {
    this.netease = netease;
    this.queue = [];        // 播放队列
    this.index = -1;         // 当前播放索引
    this.lrc = [];           // 解析后的歌词（时间 + 文本，供画布叠层）
    this.lrcIndex = -1;
    this.lyricInfo = null;   // { lines, source, hasWord }
    this.lyricLines = [];    // 逐行/逐字歌词
    // 播放页歌词显示选项
    this.lyricOpts = { word: true, translation: true, nextLine: true, keyword: true };
    this.playMode = 'order'; // order 顺序 | shuffle 随机 | repeat-one 单曲循环
    this.mods = MODS;
    this.theme = null;       // AI 生成的主题 { bg, palette, mood, params }
    this.onThemeChange = null; // 回调给 main.js
    this._bindMode = false;

    var self = this;
    netease.audio.addEventListener('timeupdate', function () { self._syncLyric(); });
    netease.audio.addEventListener('ended', function () { self.next(); });
  }

  /* ---------- 队列 ---------- */
  PlayerCard.prototype.setQueue = function (songs, startIndex) {
    this.queue = songs || [];
    this.index = (startIndex == null) ? 0 : startIndex;
    if (this.queue.length) this.playCurrent();
  };

  PlayerCard.prototype.addToQueue = function (song) {
    this.queue.push(song);
    if (this.index < 0) { this.index = 0; this.playCurrent(); }
  };

  PlayerCard.prototype.playAt = function (i) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    this.playCurrent();
  };

  PlayerCard.prototype.next = function () {
    if (!this.queue.length) return;
    if (this.playMode === 'repeat-one') {
      this.playAt(this.index >= 0 ? this.index : 0);
      return;
    }
    if (this.playMode === 'shuffle') {
      if (this.queue.length === 1) { this.playAt(0); return; }
      var i = this.index;
      while (i === this.index) i = Math.floor(Math.random() * this.queue.length);
      this.playAt(i);
      return;
    }
    this.playAt((this.index + 1) % this.queue.length);
  };

  // 播放模式：order 顺序 / shuffle 随机 / repeat-one 单曲循环
  PlayerCard.prototype.setPlayMode = function (mode) {
    if (['order', 'shuffle', 'repeat-one'].indexOf(mode) < 0) mode = 'order';
    this.playMode = mode;
    // 单曲循环交给 audio.loop，其余模式在 ended 时切下一首
    this.netease.audio.loop = (mode === 'repeat-one');
    return this.playMode;
  };

  PlayerCard.prototype.prev = function () {
    if (!this.queue.length) return;
    this.playAt((this.index - 1 + this.queue.length) % this.queue.length);
  };

  PlayerCard.prototype.current = function () {
    return this.queue[this.index] || null;
  };

  PlayerCard.prototype.playCurrent = function () {
    var self = this;
    var song = this.current();
    if (!song) return;
    // 换歌令牌：快速切歌时，旧歌的异步歌词/封面/主题回调凭此作废
    var token = (this._trackToken = (this._trackToken || 0) + 1);
    // 立刻清掉上一首的歌词与主题，避免面板短暂显示旧歌内容
    this.lrc = [];
    this.lyricLines = [];
    this.lyricInfo = null;
    this.lrcIndex = -1;
    this.theme = null;
    if (this.onTrackChange) this.onTrackChange(song); // 通知背景层取封面
    this._renderNowPlaying();
    this._renderLyrics();

    var startPlayback = function (blobUrl) {
      var p = blobUrl
        ? self.netease.playSongBuffer(song, blobUrl)
        : self.netease.playSong(song);
      p.then(function (ok) {
        if (ok && token === self._trackToken) self._loadSongExtras(song, token);
      }).catch(function (e) {
        console.warn('播放失败', e);
      });
    };

    // 音游模式：RhythmGame 接管选歌（先缓存 → 铺面 → 延迟开播；失败降级在线预判）
    var RG = global.RhythmGame;
    if (RG && RG.isRhythm() && !song.local && RG.handleTrack(song, startPlayback)) {
      return;   // 开播时机交给 RhythmGame
    }

    startPlayback(null);
  };

  // 播放后加载歌词 + AI 主题（搜索结果缺封面时先经 /song/detail 补全）
  PlayerCard.prototype._loadSongExtras = function (song, token) {
    var self = this;
    token = (token == null) ? this._trackToken : token;
    var stale = function () { return token !== self._trackToken; }; // 已切到别的歌
    var ready = song.coverUrl ? Promise.resolve(song) : this.netease.getSongDetail(song.id).then(function (d) {
      if (d && d.coverUrl) {
        song.coverUrl = d.coverUrl;
        if (d.album && !song.album) song.album = d.album;
        if (stale()) return song;
        self._renderNowPlaying(); // 刷新 UI 封面
        if (self.onTrackChange) self.onTrackChange(song); // 补全封面后再通知背景层
      }
      return song;
    }).catch(function () { return song; });
    ready.then(function (s) {
      if (stale()) return;
      return self.netease.getLyric(s.id).then(function (raw) {
        if (stale()) return;
        var info = (global.Lyrics && global.Lyrics.build)
          ? global.Lyrics.build(raw)
          : { lines: [], source: 'none', hasWord: false };
        self.lyricInfo = info;
        self.lyricLines = info.lines;
        // 兼容画布歌词叠层（只要时间 + 文本）
        self.lrc = info.lines.map(function (l) { return { t: l.t, text: l.text }; });
        self.lrcIndex = -1;
        self._renderLyrics();
        self._syncLyric(); // 歌词到达立即对齐当前行（含前奏点亮第一句）
        self._generateTheme(s, token);
      });
    });
  };

  /* ---------- UI 渲染钩子（由 PlayerUI 提供实现） ---------- */
  PlayerCard.prototype._renderNowPlaying = function () {
    if (global.PlayerUI) global.PlayerUI.renderNowPlaying(this);
  };
  PlayerCard.prototype._renderLyrics = function () {
    if (global.PlayerUI) global.PlayerUI.renderLyrics(this);
  };
  PlayerCard.prototype._highlightLyric = function (idx) {
    if (global.PlayerUI) global.PlayerUI.highlightLyric(this, idx);
  };

  /* ---------- AI 主题生成 ---------- */
  PlayerCard.prototype._generateTheme = function (song, token) {
    var self = this;
    if (token != null && token !== this._trackToken) return; // 已切歌，不再生成旧主题
    // 一次性取色回调（不占用 netease.onCoverColor，避免取色失败留下脏回调）
    this.netease._extractCoverColor(song.coverUrl, function (color, rgb) {
      if (token != null && token !== self._trackToken) return; // 取色期间已切歌
      var mood = analyzeMood(self.lrc);
      // 背景色：封面主色压暗（情绪决定明度）
      var bgHsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
      var bg = rgbToNum(hslToRgb(bgHsl.h, Math.min(0.6, bgHsl.s), mood.bgL));
      // 粒子色板：封面色相旋转
      var palette = paletteFromColor(rgb.r, rgb.g, rgb.b);
      self.theme = { bg: bg, palette: palette, mood: mood, params: mood };
      if (self.onThemeChange) self.onThemeChange(self.theme);
      self._renderNowPlaying(); // 更新"AI 主题"情绪标签
    });
  };

  /* ---------- 歌词 ---------- */
  PlayerCard.prototype._syncLyric = function () {
    if (!this.lrc.length) return;
    var t = this.netease.audio.currentTime || 0;
    var idx = findLrcIndex(this.lrc, t);
    if (idx === -1) idx = 0; // 前奏期间也点亮第一句，别让歌词空窗
    if (idx !== this.lrcIndex) {
      this.lrcIndex = idx;
      this._highlightLyric(idx);
    }
  };

  PlayerCard.prototype.currentLyricLine = function () {
    if (this.lrcIndex >= 0 && this.lrc[this.lrcIndex]) return this.lrc[this.lrcIndex].text;
    return '';
  };

  // 当前行对象（含逐字时序 / 翻译）
  PlayerCard.prototype.currentLine = function () {
    return (this.lrcIndex >= 0 && this.lyricLines[this.lrcIndex]) ? this.lyricLines[this.lrcIndex] : null;
  };

  // 下一句提示
  PlayerCard.prototype.nextLineText = function () {
    var i = this.lrcIndex + 1;
    var line = this.lyricLines[i];
    return line ? line.text : '';
  };

  PlayerCard.prototype.isModEnabled = function (id) {
    for (var i = 0; i < this.mods.length; i++) {
      if (this.mods[i].id === id) return this.mods[i].enabled;
    }
    return false;
  };

  PlayerCard.prototype.toggleMod = function (id) {
    for (var i = 0; i < this.mods.length; i++) {
      if (this.mods[i].id === id) { this.mods[i].enabled = !this.mods[i].enabled; return this.mods[i].enabled; }
    }
    return false;
  };

  /* ---------- 本地歌曲 + 智能歌词/封面匹配（借鉴 folia-major） ---------- */
  // 播放本地音频文件，并按文件名在线匹配歌词与封面
  PlayerCard.prototype.playLocal = function (file) {
    var self = this;
    var url = URL.createObjectURL(file);
    var name = file.name.replace(/\.[^.]+$/, ''); // 去扩展名
    var song = { id: 0, name: name, artist: '本地文件', album: '', coverUrl: '', local: true, localUrl: url };
    this.queue = [song];
    this.index = 0;
    // 清掉上一首状态 + 换新令牌（与 playCurrent 一致）
    var token = (this._trackToken = (this._trackToken || 0) + 1);
    this.lrc = [];
    this.lyricLines = [];
    this.lyricInfo = null;
    this.lrcIndex = -1;
    this.theme = null;
    if (this.onTrackChange) this.onTrackChange(song);
    this._renderNowPlaying();
    this._renderLyrics();

    var startLocal = function () {
      self.netease.playLocalFile(url);
    };
    // 音游模式：本地文件直接全曲分析（音频已在本地，无需网络缓存）
    var RG = global.RhythmGame;
    if (RG && RG.isRhythm() && RG.handleLocalTrack(song, file, startLocal)) {
      this._matchOnline(song, name, token);
      return;
    }
    startLocal();
    this._matchOnline(song, name, token);
  };

  // 智能匹配：用文件名（"歌手 - 歌名"）搜索在线歌曲 → 自动加载歌词与封面 + AI 主题
  PlayerCard.prototype._matchOnline = function (song, keyword, token) {
    var self = this;
    token = (token == null) ? this._trackToken : token;
    var stale = function () { return token !== self._trackToken; };
    var kw = keyword.replace(/_+/g, ' ').trim();
    if (!kw) return;
    this.netease.searchSongs(kw, 5).then(function (list) {
      if (!list.length || stale()) return;
      var best = list[0];
      song.matchedId = best.id;
      if (best.artist && song.artist === '本地文件') song.artist = best.artist;
      if (best.album) song.album = best.album;
      self._renderNowPlaying();
      // 封面补全（/search 结果常缺 picUrl，经 /song/detail 获取）
      var coverReady = best.coverUrl ? Promise.resolve(best) : self.netease.getSongDetail(best.id).catch(function () { return null; });
      coverReady.then(function (d) {
        if (stale()) return;
        if (d && d.coverUrl) song.coverUrl = d.coverUrl;
        self._renderNowPlaying();
        if (song.coverUrl && self.onTrackChange) self.onTrackChange(song); // 封面就绪后再通知背景层
        self._generateTheme(song, token); // 匹配封面 → 沉浸式 AI 主题
      });
      // 歌词匹配（播放进度同步沿用 timeupdate → _syncLyric）
      self.netease.getLyric(best.id).then(function (raw) {
        if (stale()) return;
        var info = (global.Lyrics && global.Lyrics.build)
          ? global.Lyrics.build(raw)
          : { lines: [], source: 'none', hasWord: false };
        self.lyricInfo = info;
        self.lyricLines = info.lines;
        self.lrc = info.lines.map(function (l) { return { t: l.t, text: l.text }; });
        self.lrcIndex = -1;
        self._renderLyrics();
        self._syncLyric(); // 歌词到达立即对齐当前行
      });
    }).catch(function (e) {
      console.warn('本地歌曲在线匹配失败', e);
    });
  };

  global.PlayerCard = PlayerCard;
  global.PlayerCardMods = MODS;
  global.parseLrc = parseLrc;
  global.ColorUtil = { rgbToHsl: rgbToHsl, hslToRgb: hslToRgb, rgbToNum: rgbToNum };
})(typeof window !== 'undefined' ? window : globalThis);

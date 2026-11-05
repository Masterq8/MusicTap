/**
 * netease.js — 网易云音乐 BGM 集成
 * ===================================
 * 依赖：本地 NeteaseCloudMusicApi 后端（默认 http://localhost:3000）
 * 功能：
 *   1) 二维码登录（login/qr/key → create → check 轮询）
 *   2) 登录后获取每日推荐 / 播放歌曲
 *   3) 封面主色提取（canvas 采样）→ 供背景调色
 *   4) audio → MediaElementSource → AnalyserNode 频谱，供粒子/雷达驱动
 */
(function (global) {
  'use strict';

  var API_BASE = 'http://localhost:3000';

  function NeteaseBgm() {
    this.cookie = localStorage.getItem('netease_cookie') || '';
    this.audio = new Audio();
    this.audio.crossOrigin = 'anonymous';
    this.audio.loop = true;
    this.audio.volume = 0.35; // BGM 音量低于点击合成音，保证节拍可闻

    this._ctx = null;
    this._analyser = null;
    this._freqData = null;
    this._mediaSrc = null;
    this._connected = false;

    this.currentSong = null; // { id, name, artist, coverUrl }
    this.onCoverColor = null; // 回调：提取到封面主色后
    this.onStateChange = null;
  }

  /* ---------------- 通用请求 ---------------- */
  // realIP：部分网络环境下登录态接口（/user/account、/recommend 等）会被风控拦截，
  // 与已验证可用的 /song/url 保持一致，统一带上
  NeteaseBgm.prototype._fetch = function (path) {
    var url = API_BASE + path;
    url += (path.indexOf('?') >= 0 ? '&' : '?') + 'realIP=116.25.146.177';
    if (this.cookie) {
      url += '&cookie=' + encodeURIComponent(this.cookie);
    }
    return fetch(url).then(function (r) { return r.json(); });
  };

  /* ---------------- 二维码登录 ---------------- */
  // 返回 { unikey, qrimg(base64) }
  NeteaseBgm.prototype.getQrKey = function () {
    var self = this;
    return this._fetch('/login/qr/key?timestamp=' + Date.now()).then(function (res) {
      self._unikey = res.data && res.data.unikey;
      return self._unikey;
    });
  };

  NeteaseBgm.prototype.getQrImage = function (key) {
    return this._fetch('/login/qr/create?key=' + key + '&qrimg=true').then(function (res) {
      return res.data && res.data.qrimg; // base64
    });
  };

  // 轮询扫码状态；返回 { status: 'waiting'|'scanned'|'expired'|'done', cookie? }
  NeteaseBgm.prototype.checkQr = function (key) {
    var self = this;
    return this._fetch('/login/qr/check?key=' + key + '&timestamp=' + Date.now()).then(function (res) {
      var code = res.code;
      if (code === 800) return { status: 'expired' };
      if (code === 801) return { status: 'waiting' };
      if (code === 802) return { status: 'scanned' };
      if (code === 803) {
        self.cookie = res.cookie;
        localStorage.setItem('netease_cookie', self.cookie);
        return { status: 'done', cookie: res.cookie };
      }
      return { status: 'waiting' };
    });
  };

  NeteaseBgm.prototype.isLoggedIn = function () {
    return !!this.cookie;
  };

  /* ---------------- 获取歌曲 ---------------- */
  // 每日推荐（需登录）
  NeteaseBgm.prototype.getRecommendSongs = function () {
    return this._fetch('/recommend/songs').then(function (res) {
      var list = res.data && res.data.dailySongs;
      if (!list || !list.length) return null;
      var s = list[0];
      return {
        id: s.id,
        name: s.name,
        artist: (s.ar || []).map(function (a) { return a.name; }).join('/'),
        coverUrl: (s.al && s.al.picUrl) || ''
      };
    });
  };

  // 每日推荐完整列表（需登录）
  NeteaseBgm.prototype.getRecommendList = function () {
    return this._fetch('/recommend/songs').then(function (res) {
      var list = (res.data && res.data.dailySongs) || [];
      return list.map(function (s) {
        return {
          id: s.id,
          name: s.name,
          artist: (s.ar || []).map(function (a) { return a.name; }).join('/'),
          coverUrl: (s.al && s.al.picUrl) || ''
        };
      });
    });
  };

  // 搜索歌曲（返回列表）
  NeteaseBgm.prototype.searchSongs = function (keyword, limit) {
    limit = limit || 30;
    return this._fetch('/search?keywords=' + encodeURIComponent(keyword) + '&limit=' + limit)
      .then(function (res) {
        var songs = (res.result && res.result.songs) || [];
        return songs.map(function (s) {
          return {
            id: s.id,
            name: s.name,
            artist: (s.artists || []).map(function (a) { return a.name; }).join('/'),
            album: (s.album && s.album.name) || '',
            coverUrl: (s.album && s.album.picUrl) || '',
            duration: s.duration || 0
          };
        });
      });
  };

  // 歌词：返回 { lrc, yrc, tlyric }。优先 /lyric/new（含逐字 YRC），失败回退 /lyric
  NeteaseBgm.prototype.getLyric = function (id) {
    function pack(res) {
      res = res || {};
      return {
        lrc: (res.lrc && res.lrc.lyric) || '',
        yrc: (res.yrc && res.yrc.lyric) || '',
        tlyric: (res.tlyric && res.tlyric.lyric) || ''
      };
    }
    return this._fetch('/lyric/new?id=' + id).then(function (res) {
      var p = pack(res);
      if (p.lrc || p.yrc) return p;
      return pack({});
    }).catch(function () {
      return { lrc: '', yrc: '', tlyric: '' };
    });
  };

  // 歌曲详情（补全封面：/search 结果只有 picId 无 picUrl）
  NeteaseBgm.prototype.getSongDetail = function (id) {
    return this._fetch('/song/detail?ids=' + id).then(function (res) {
      var s = res.songs && res.songs[0];
      if (!s) return null;
      return {
        id: s.id,
        name: s.name,
        artist: (s.ar || []).map(function (a) { return a.name; }).join('/'),
        album: (s.al && s.al.name) || '',
        coverUrl: (s.al && s.al.picUrl) || ''
      };
    });
  };

  // 用户信息（登录校验 + uid；/user/account 失败时回退 /login/status）
  NeteaseBgm.prototype.getUserAccount = function () {
    var self = this;
    return this._fetch('/user/account').then(function (res) {
      if (res.profile) {
        return { uid: res.profile.userId, nickname: res.profile.nickname };
      }
      // 回退：部分版本 /user/account 拿不到 profile，但 /login/status 可以
      return self._fetch('/login/status').then(function (r2) {
        var prof = r2 && r2.data && r2.data.profile;
        if (prof) return { uid: prof.userId, nickname: prof.nickname };
        return null;
      }).catch(function () { return null; });
    });
  };

  // 用户歌单：返回 null=未登录/cookie 失效，[]=正常但无歌单
  NeteaseBgm.prototype.getUserPlaylists = function () {
    var self = this;
    return this.getUserAccount().then(function (acc) {
      if (!acc) return null;
      return self._fetch('/user/playlist?uid=' + acc.uid + '&limit=30').then(function (res) {
        var list = (res.playlist) || [];
        return list.map(function (p) {
          return {
            id: p.id,
            name: p.name,
            coverUrl: (p.coverImgUrl) || '',
            count: p.trackCount || 0
          };
        });
      });
    });
  };

  // 歌单详情（歌曲列表）
  // 注意：binaryify API 中 /playlist/track 是"更新歌单"(POST)，获取歌单内所有歌曲是 /playlist/track/all
  NeteaseBgm.prototype.getPlaylistDetail = function (playlistId) {
    return this._fetch('/playlist/track/all?id=' + playlistId + '&limit=100').then(function (res) {
      var songs = (res.songs) || [];
      return songs.map(function (s) {
        return {
          id: s.id,
          name: s.name,
          artist: (s.ar || []).map(function (a) { return a.name; }).join('/'),
          album: (s.al && s.al.name) || '',
          coverUrl: (s.al && s.al.picUrl) || '',
          duration: s.dt || 0
        };
      });
    });
  };

  // 歌曲播放 URL
  NeteaseBgm.prototype.getSongUrl = function (id) {
    return this._fetch('/song/url?id=' + id + '&realIP=116.25.146.177').then(function (res) {
      return res.data && res.data[0] && res.data[0].url;
    });
  };

  // 搜索（备用，未登录时可手动搜）
  NeteaseBgm.prototype.search = function (keyword) {
    return this._fetch('/search?keywords=' + encodeURIComponent(keyword) + '&limit=1').then(function (res) {
      var songs = res.result && res.result.songs;
      if (!songs || !songs.length) return null;
      var s = songs[0];
      return {
        id: s.id,
        name: s.name,
        artist: (s.artists || []).map(function (a) { return a.name; }).join('/'),
        coverUrl: (s.album && s.album.picUrl) || ''
      };
    });
  };

  /* ---------------- 播放 BGM ---------------- */
  // 播放歌曲（自动获取 URL + 封面调色 + 频谱连接）
  NeteaseBgm.prototype.playSong = function (song) {
    var self = this;
    this.currentSong = song;
    if (this.onStateChange) this.onStateChange({ type: 'song', song: song });

    return this.getSongUrl(song.id).then(function (url) {
      if (!url) { console.warn('无法获取播放地址'); return false; }
      self._ensureAudioGraph();
      self.audio.src = url;
      self.audio.play().catch(function (e) {
        console.warn('播放被拦截，等待用户手势', e);
      });
      self._extractCoverColor(song.coverUrl);
      return true;
    });
  };

  // 播放本地文件（objectURL / blob）——走同一 audio 元素，频谱与歌词同步复用
  NeteaseBgm.prototype.playLocalFile = function (url) {
    this.currentSong = { id: 0, name: '本地歌曲', local: true };
    if (this.onStateChange) this.onStateChange({ type: 'song', song: this.currentSong });
    this._ensureAudioGraph();
    this.audio.src = url;
    return this.audio.play().then(function () { return true; }).catch(function () { return false; });
  };

  NeteaseBgm.prototype.pause = function () {
    this.audio.pause();
  };
  NeteaseBgm.prototype.resume = function () {
    this.audio.play().catch(function () {});
  };
  NeteaseBgm.prototype.setVolume = function (v) {
    this.audio.volume = Math.max(0, Math.min(1, v));
  };

  /* ---------------- 音频图（频谱） ---------------- */
  NeteaseBgm.prototype._ensureAudioGraph = function () {
    if (this._connected) return;
    var Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return;
    if (!this._ctx) this._ctx = new Ctx();
    try {
      this._mediaSrc = this._ctx.createMediaElementSource(this.audio);
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = 256;
      this._analyser.smoothingTimeConstant = 0.8;
      this._mediaSrc.connect(this._analyser);
      this._analyser.connect(this._ctx.destination);
      this._freqData = new Uint8Array(this._analyser.frequencyBinCount);
      this._connected = true;
    } catch (e) {
      console.warn('音频图连接失败', e);
    }
  };

  // 频谱数据（供 spectrumVisualizer / 粒子驱动）
  NeteaseBgm.prototype.getSpectrumData = function () {
    if (!this._analyser) return null;
    this._analyser.getByteFrequencyData(this._freqData);
    return this._freqData;
  };

  NeteaseBgm.prototype.isPlaying = function () {
    return !this.audio.paused;
  };

  /* ---------------- 封面主色提取 ---------------- */
  NeteaseBgm.prototype._extractCoverColor = function (url, callback) {
    var self = this;
    if (!url) return;
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () {
      try {
        var c = document.createElement('canvas');
        var size = 32;
        c.width = size; c.height = size;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        var data = ctx.getImageData(0, 0, size, size).data;
        var r = 0, g = 0, b = 0, n = 0;
        for (var i = 0; i < data.length; i += 4) {
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
        r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
        var color = (r << 16) | (g << 8) | b;
        if (callback) callback(color, { r: r, g: g, b: b });
        if (self.onCoverColor) self.onCoverColor(color, { r: r, g: g, b: b });
      } catch (e) {
        console.warn('封面取色失败（可能跨域受限）', e);
      }
    };
    img.onerror = function () { console.warn('封面加载失败', url); };
    img.src = url;
  };

  global.NeteaseBgm = NeteaseBgm;
})(typeof window !== 'undefined' ? window : globalThis);

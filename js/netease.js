/**
 * netease.js — 网易云音乐 BGM 集成
 * ===================================
 * 依赖：NeteaseCloudMusicApi 后端（默认同主机的 3000 端口）
 * 地址解析顺序：?api= 参数 > localStorage['uta.apiBase'] > 页面主机名:3000
 *   本机访问 → http://localhost:3000
 *   局域网 / 手机访问 → http://<电脑局域网 IP>:3000
 * 功能：
 *   1) 二维码登录（login/qr/key → create → check 轮询）
 *   2) 登录后获取每日推荐 / 播放歌曲
 *   3) 封面主色提取（canvas 采样）→ 供背景调色
 *   4) audio → MediaElementSource → AnalyserNode 频谱，供粒子/雷达驱动
 */
(function (global) {
  'use strict';

  function resolveApiBase() {
    var fromQuery = /[?&]api=([^&]+)/.exec(location.search);
    if (fromQuery) {
      try { return decodeURIComponent(fromQuery[1]).replace(/\/+$/, ''); } catch (e) { /* 参数非法则继续回退 */ }
    }
    try {
      var saved = localStorage.getItem('uta.apiBase');
      if (saved) return saved.replace(/\/+$/, '');
    } catch (e) { /* 隐私模式下忽略 */ }
    // 局域网访问时，localhost 指向手机自身，必须跟随页面主机名
    if (location.protocol === 'file:') return 'http://localhost:3000';
    return location.protocol + '//' + (location.hostname || 'localhost') + ':3000';
  }

  var API_BASE = resolveApiBase();

  // 网易云歌曲对象 → 播放器内部曲目结构（时长统一为秒，封面两种字段名都给）
  function toTrack(s) {
    if (!s) return null;
    var ar = s.ar || s.artists || [];
    var al = s.al || s.album || {};
    var ms = s.dt || s.duration || 0;
    var cover = al.picUrl || '';
    return {
      id: s.id,
      name: s.name || '未知曲目',
      artist: ar.map(function (a) { return a.name; }).join('/'),
      album: al.name || '',
      cover: cover,
      coverUrl: cover,
      duration: Math.round(ms / 1000)
    };
  }

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
    this._songGain = null;   // 点击 sidechain：歌曲总线增益
    this._connected = false;

    this.currentSong = null; // { id, name, artist, coverUrl }
    this.onCoverColor = null; // 回调：提取到封面主色后
    this.onStateChange = null;

    // 节拍网格（BeatGrid）：play 时启动 onset 检测，pause 时保留相位
    this.beatGrid = null;
    this._beatAnalyser = null;
    var self = this;
    this.audio.addEventListener('play', function () {
      if (self.beatGrid) self.beatGrid.start();
    });
    this.audio.addEventListener('pause', function () {
      if (self.beatGrid) {
        self.beatGrid.stop();
        // 此时 PLL 已收敛，再存一次缓存
        var st = self.beatGrid.getState();
        if (st.bpm) self._saveBpm(st.bpm, st.anchor);
      }
    });
    this.audio.addEventListener('ended', function () {
      if (self.beatGrid) {
        var st = self.beatGrid.getState();
        if (st.bpm) self._saveBpm(st.bpm, st.anchor);
      }
    });
    this.audio.addEventListener('seeked', function () {
      if (self.beatGrid) self.beatGrid.reanchor(self.audio.currentTime);
    });
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
      return list.map(toTrack).filter(Boolean);
    });
  };

  // 最近播放（需登录）：优先最近一周，为空再取全部时间
  NeteaseBgm.prototype.getRecentSongs = function () {
    var self = this;
    function pick(arr) {
      return (arr || []).map(function (item) {
        return toTrack(item.song || item.data || item);
      }).filter(Boolean);
    }
    return this.getUserAccount().then(function (acc) {
      if (!acc) return null;
      return self._fetch('/user/record?uid=' + acc.uid + '&type=1').then(function (res) {
        var list = pick(res.weekData);
        if (list.length) return list;
        return self._fetch('/user/record?uid=' + acc.uid + '&type=0').then(function (r2) {
          return pick(r2.allData);
        });
      });
    });
  };

  // 私人 FM（需登录）
  NeteaseBgm.prototype.getPersonalFm = function () {
    return this._fetch('/personal_fm?timestamp=' + Date.now()).then(function (res) {
      return (res.data || []).map(toTrack).filter(Boolean);
    });
  };

  // 搜索歌曲（返回列表）
  NeteaseBgm.prototype.searchSongs = function (keyword, limit) {
    limit = limit || 30;
    return this._fetch('/search?keywords=' + encodeURIComponent(keyword) + '&limit=' + limit)
      .then(function (res) {
        var songs = (res.result && res.result.songs) || [];
        return songs.map(toTrack).filter(Boolean);
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
            count: p.trackCount || 0,
            specialType: p.specialType || 0
          };
        });
      });
    });
  };

  // 歌单详情（歌曲列表）— 分页拉全
  // 注意：binaryify API 中 /playlist/track 是"更新歌单"(POST)，获取歌单内所有歌曲是 /playlist/track/all
  // opts.total：歌单应有曲目数（pl.count），达到即停
  // opts.onProgress(allLoaded)：每拉到一页回调一次，用于渐进渲染
  NeteaseBgm.prototype.getPlaylistDetail = function (playlistId, opts) {
    opts = opts || {};
    var self = this;
    var pageSize = opts.pageSize || 200;
    var maxPages = opts.maxPages || 25;      // 25 页 × 200 = 5000 首上限，防失控
    var expected = opts.total || 0;
    var onProgress = opts.onProgress || null;

    function fetchPage(offset) {
      var url = '/playlist/track/all?id=' + playlistId +
        '&limit=' + pageSize + '&offset=' + offset;
      return self._fetch(url).then(function (res) {
        return ((res && res.songs) || []).map(toTrack).filter(Boolean);
      });
    }

    function notify(list) {
      if (onProgress) { try { onProgress(list.slice()); } catch (e) {} }
    }

    return fetchPage(0).then(function (first) {
      var all = first.slice();
      notify(all);
      function more(offset) {
        if (expected && all.length >= expected) return all;      // 已够数
        if (offset >= maxPages * pageSize) return all;           // 防失控
        return fetchPage(offset).then(function (batch) {
          if (!batch.length) return all;                         // 到底
          all = all.concat(batch);
          notify(all);
          if (batch.length < pageSize) return all;               // 不足一页 = 末页
          return more(offset + pageSize);
        });
      }
      return more(pageSize);
    });
  };

  // 歌曲播放 URL
  NeteaseBgm.prototype.getSongUrl = function (id) {
    return this._fetch('/song/url?id=' + id + '&realIP=116.25.146.177').then(function (res) {
      return res.data && res.data[0] && res.data[0].url;
    });
  };

  /* ---------------- 音游模式：完整缓存 + 解码 + blob 播放 ---------------- */

  /**
   * 完整缓存歌曲音频（音游模式「先缓存再铺面」用）。
   * 优先命中 Cache API（uta-audio-v1，按歌 id 键控，LRU 上限 24 首）；
   * 未命中则取播放 URL → fetch 流式下载（进度回调）→ 写入缓存。
   * 失败（离线/CORS/HTTP 错误/停滞超时）reject → 调用方降级在线模式。
   */
  NeteaseBgm.prototype.fetchSongAudio = function (song, onProgress) {
    var self = this;
    var id = song && song.id;
    if (!id) return Promise.reject(new Error('no-id'));

    return this._audioCacheMatch(id).then(function (cached) {
      if (cached) {
        console.info('[Audio] 音频缓存命中 id=' + id + ' ' + (cached.byteLength / 1048576).toFixed(2) + 'MB');
        if (onProgress) { try { onProgress(100); } catch (e) {} }
        return { arrayBuffer: cached, fromCache: true };
      }
      return self.getSongUrl(id).then(function (url) {
        if (!url) throw new Error('no-url');
        console.info('[Audio] 取到播放地址，开始完整下载 id=' + id);
        return self._fetchAudioWithProgress(url, onProgress);
      }).then(function (arrayBuffer) {
        if (!arrayBuffer || arrayBuffer.byteLength < 8192) throw new Error('bad-audio');
        console.info('[Audio] 下载完成 id=' + id + ' ' + (arrayBuffer.byteLength / 1048576).toFixed(2) + 'MB');
        self._audioCachePut(id, arrayBuffer);   // best effort，失败不影响主流程
        return { arrayBuffer: arrayBuffer, fromCache: false };
      });
    }).catch(function (err) {
      console.warn('[Audio] 完整缓存失败 id=' + id + ' 原因=' + ((err && err.message) || err));
      throw err;
    });
  };

  NeteaseBgm.prototype._fetchAudioWithProgress = function (url, onProgress) {
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var stallTimer = 0;
    var armStall = function (reject) {
      if (!controller) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(function () {
        try { controller.abort(); } catch (e) {}
      }, 8000);
    };
    var fetchOpts = controller ? { signal: controller.signal } : undefined;
    return fetch(url, fetchOpts).then(function (res) {
      if (!res.ok) throw new Error('http-' + res.status);
      var total = parseInt(res.headers.get('content-length') || '0', 10);
      if (!res.body || !res.body.getReader) {
        // 老浏览器无流式读取：整块拉
        return res.arrayBuffer().then(function (ab) {
          if (onProgress) { try { onProgress(100); } catch (e) {} }
          return ab;
        });
      }
      var reader = res.body.getReader();
      var chunks = [];
      var received = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            if (stallTimer) clearTimeout(stallTimer);
            if (onProgress) { try { onProgress(100); } catch (e) {} }
            var total2 = received;
            var out = new Uint8Array(total2);
            var off = 0;
            for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
            return out.buffer;
          }
          chunks.push(r.value);
          received += r.value.length;
          if (onProgress && total) {
            try { onProgress(Math.min(99, Math.round(received / total * 100))); } catch (e) {}
          }
          if (stallTimer) clearTimeout(stallTimer);
          armStall();
          return pump();
        });
      }
      armStall();
      return pump();
    });
  };

  /** 解码 ArrayBuffer → AudioBuffer（离线铺面用） */
  NeteaseBgm.prototype.decodeArrayBuffer = function (arrayBuffer) {
    this._ensureAudioGraph();
    var ctx = this._ctx;
    if (!ctx || !ctx.decodeAudioData) return Promise.reject(new Error('no-ctx'));
    return new Promise(function (resolve, reject) {
      var p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);   // 现代浏览器返回 Promise
    });
  };

  /** 用已缓存的 blob URL 直接开播（省一次重复下载） */
  NeteaseBgm.prototype.playSongBuffer = function (song, blobUrl) {
    this.currentSong = song;
    if (this.onStateChange) this.onStateChange({ type: 'song', song: song });
    this._ensureAudioGraph();
    this._prepareBeatGrid(song);
    this.audio.src = blobUrl;
    this.audio.play().catch(function (e) {
      console.warn('播放被拦截，等待用户手势', e);
    });
    this._extractCoverColor(song.coverUrl);
    return Promise.resolve(true);
  };

  // ---- Cache API：uta-audio-v1，key = API_BASE + '/__uta-audio__/<id>' ----
  NeteaseBgm.prototype._audioCacheKey = function (id) {
    return API_BASE + '/__uta-audio__/' + id;
  };

  NeteaseBgm.prototype._audioCacheMatch = function (id) {
    if (!global.caches) return Promise.resolve(null);
    var key = this._audioCacheKey(id);
    return global.caches.open('uta-audio-v1').then(function (c) {
      return c.match(key);
    }).then(function (res) {
      if (!res) return null;
      return res.arrayBuffer();
    }).catch(function () { return null; });
  };

  NeteaseBgm.prototype._audioCachePut = function (id, arrayBuffer) {
    if (!global.caches) return;
    var self = this;
    global.caches.open('uta-audio-v1').then(function (c) {
      // 顺便更新 LRU 索引：localStorage uta.audioCache = [id1, id2, ...]（新的在尾）
      var order = [];
      try {
        order = JSON.parse(global.localStorage.getItem('uta.audioCache') || '[]');
      } catch (e) {}
      order = order.filter(function (x) { return x !== id; });
      order.push(id);
      var evicted = [];
      while (order.length > 24) evicted.push(order.shift());
      try { global.localStorage.setItem('uta.audioCache', JSON.stringify(order)); } catch (e) {}
      var puts = [c.put(self._audioCacheKey(id), new Response(arrayBuffer))];
      for (var i = 0; i < evicted.length; i++) puts.push(c.delete(self._audioCacheKey(evicted[i])));
      return Promise.all(puts);
    }).catch(function () { /* 存储满 / 隐私模式：静默放弃 */ });
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
      self._prepareBeatGrid(song);
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
    this._prepareBeatGrid(this.currentSong);
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
      // 歌曲总线：点击时短暂 duck，避免与点击音叠加爆音
      this._songGain = this._ctx.createGain();
      this._songGain.gain.value = 1;
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = 256;
      this._analyser.smoothingTimeConstant = 0.8;
      // 节拍分析：同一条图上再串一个 2048 点 analyser（30–160Hz onset）
      this._beatAnalyser = this._ctx.createAnalyser();
      this._beatAnalyser.fftSize = 2048;
      this._beatAnalyser.smoothingTimeConstant = 0.15;
      this._mediaSrc.connect(this._songGain);
      this._songGain.connect(this._beatAnalyser);
      this._beatAnalyser.connect(this._analyser);
      this._analyser.connect(this._ctx.destination);
      this._freqData = new Uint8Array(this._analyser.frequencyBinCount);
      this._connected = true;
    } catch (e) {
      console.warn('音频图连接失败', e);
    }
  };

  /**
   * 建立 / 复用歌曲节拍网格。时间基准用「插值过的」audio.currentTime，
   * 把浏览器的阶梯式 currentTime 更新外推成连续时钟，撑起 16 分音符相位。
   */
  NeteaseBgm.prototype._makeMediaClock = function () {
    var audio = this.audio;
    var ctx = this._ctx;
    var mLast = -1, mRef = 0, tRef = 0;
    return function () {
      var m = audio.currentTime;
      var t = ctx.currentTime;
      if (m !== mLast) {
        mLast = m;
        mRef = m;
        tRef = t;
        return m;
      }
      if (audio.paused) return mRef; // 暂停不外推
      return mRef + (t - tRef);       // 两个采样点之间线性外推
    };
  };

  NeteaseBgm.prototype._ensureBeatGrid = function () {
    if (!global.BeatGrid || !this._ctx || !this._beatAnalyser) return;
    var self = this;
    if (!this.beatGrid) {
      this.beatGrid = new global.BeatGrid({
        onTempo: function (bpm, anchor) { self._saveBpm(bpm, anchor); }
      });
    }
    this.beatGrid.stop();
    this.beatGrid.attach(this._ctx, this._beatAnalyser, this._makeMediaClock());
  };

  /** 换歌：清空检测状态，命中缓存则跳过 onset 检测 */
  NeteaseBgm.prototype._prepareBeatGrid = function (song) {
    this._ensureBeatGrid();
    if (!this.beatGrid) return;
    this.beatGrid.reset();
    var id = song && song.id;
    if (id) this._restoreBpm(id);
  };

  /** BPM 按歌曲 id 缓存：uta.bpm.<id> = { bpm, offset } */
  NeteaseBgm.prototype._saveBpm = function (bpm, anchorAudio) {
    var song = this.currentSong;
    if (!song || !song.id || !bpm) return;
    try {
      var beatDur = 60 / bpm;
      var offset = ((anchorAudio % beatDur) + beatDur) % beatDur;
      global.localStorage.setItem('uta.bpm.' + song.id, JSON.stringify({
        bpm: Math.round(bpm * 10) / 10,
        offset: Math.round(offset * 1000) / 1000
      }));
    } catch (e) {}
  };

  NeteaseBgm.prototype._restoreBpm = function (id) {
    if (!this.beatGrid) return false;
    try {
      var raw = global.localStorage.getItem('uta.bpm.' + id);
      if (!raw) return false;
      var data = JSON.parse(raw);
      var bpm = (typeof data === 'number') ? data : (data && data.bpm);
      if (!bpm || bpm < 60 || bpm > 200) return false;
      var offset = (data && data.offset) || 0;
      this.beatGrid.setTempo(bpm, offset, true);
      this.beatGrid.setCached(true);
      return true;
    } catch (e) {
      return false;
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

  /**
   * 点击音 sidechain：歌曲瞬时压低到 86%，90ms 后恢复。
   * 复用 _ensureAudioGraph 里的 _songGain，避免重复 createMediaElementSource。
   */
  NeteaseBgm.prototype.duckForTap = function () {
    if (!this._ctx || !this._songGain) return;
    if (this._ctx.state !== 'running') return;
    if (!this.isPlaying()) return;
    var now = this._ctx.currentTime;
    var gain = this._songGain.gain;
    try { gain.cancelScheduledValues(now); } catch (e) {}
    gain.setTargetAtTime(0.86, now, 0.02);
    gain.setTargetAtTime(1, now + 0.09, 0.08);
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

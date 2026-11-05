/**
 * player-ui.js — 播放页（玻璃 UI）DOM 绑定层
 * 区域：歌曲信息 / 主歌词（逐行·逐字·翻译·下一句·关键词着色）/ 底部控制 / 右侧设置面板
 * 依赖：jQuery、player.js、netease.js、lyrics.js、bgLayer.js（视觉模式）
 */
(function (global) {
  'use strict';

  var PlayerUI = {
    card: null,
    netease: null,
    _qrTimer: null,
    _dragging: false,
    _lastLine: -1,
    _raf: null
  };

  /* ---------------- 初始化 ---------------- */

  PlayerUI.init = function (card, netease) {
    this.card = card;
    this.netease = netease;
    var self = this;

    $('#bt_music').click(function () { self.open(); });
    $('#bt_player_close, #pc_login_close, #player_cover').click(function () { self.close(); });
    $('#pc-settings').click(function () {
      if (global.__app && global.__app.openSettings) global.__app.openSettings();
    });
    function setSide(open) {
      $('#pc-side').toggleClass('open', open);
      $('#pc-side-overlay').toggleClass('open', open);
      $('#pc-side-toggle').attr('aria-expanded', open ? 'true' : 'false')
        .attr('aria-label', open ? '关闭控制面板' : '打开控制面板');
    }
    $('#pc-side-toggle').click(function () { setSide(!$('#pc-side').hasClass('open')); });
    $('#pc-side-overlay').click(function () { setSide(false); });

    // 右侧面板切换
    $('.pc-side-tab').click(function () {
      var side = $(this).data('side');
      $('.pc-side-tab').removeClass('active').attr('aria-selected', 'false');
      $(this).addClass('active').attr('aria-selected', 'true');
      $('.pc-side-panel').hide();
      $('.pc-side-panel[data-side-panel="' + side + '"]').show();
      if (side === 'library' && !self._plLoaded) self.loadPlaylists(true);
    });

    this._bindLogin();
    this._bindControls();
    this._bindSidePanels();
    this._bindLibrary();
    this._startLoop();
    this._checkLogin();

    // 窗口 / 面板尺寸变化时重新居中歌词（跟着框大小走）
    var relayout = function () {
      self._renderActive(self.card.lrcIndex, true);
    };
    $(window).on('resize', relayout);
    if (global.ResizeObserver) {
      var host = document.getElementById('player');
      if (host) new global.ResizeObserver(relayout).observe(host);
    }
  };

  PlayerUI.open = function () {
    if ($('#player').hasClass('open')) return;
    if (global.__app && global.__app.closeSettings) global.__app.closeSettings();
    var panel = document.getElementById('player');
    if (panel) panel.setAttribute('aria-hidden', 'false');
    var focusEl = $('#pc_not_logged').is(':visible')
      ? document.getElementById('pc_login_close')
      : document.getElementById('bt_player_close');
    if (global.__app && global.__app.openWindow) {
      global.__app.openWindow('#player', '#player_cover', focusEl);
    } else {
      $('#player, #player_cover').addClass('open');
      if (focusEl) focusEl.focus();
    }
    this.renderVisualModes();
    this.renderCenterModes();
    this.renderThemes();
    this.renderLyrics(this.card);
    var self = this;
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      self._renderActive(self.card.lrcIndex, true);
    };
    $('#player').one('transitionend', function (ev) {
      if (!ev.originalEvent || ev.originalEvent.propertyName === 'opacity') finish();
    });
    setTimeout(finish, 560);
  };

  PlayerUI.close = function () {
    if (!$('#player').hasClass('open')) return;
    if (global.__app && global.__app.closeWindow) {
      global.__app.closeWindow('#player', '#player_cover');
    } else {
      $('#player, #player_cover').removeClass('open');
    }
    $('#pc-side').removeClass('open');
    $('#pc-side-overlay').removeClass('open');
    $('#pc-side-toggle').attr('aria-expanded', 'false');
  };

  /* ---------------- 登录 ---------------- */

  PlayerUI._checkLogin = function () {
    var self = this;
    if (!this.netease.isLoggedIn()) return;
    this.netease.getUserAccount().then(function (acc) {
      if (acc) self._enterLogged(acc.nickname);
      else self._clearCookie();
    }).catch(function () {});
  };

  PlayerUI._clearCookie = function () {
    localStorage.removeItem('netease_cookie');
    this.netease.cookie = '';
  };

  PlayerUI._enterLogged = function (nickname) {
    $('#pc_not_logged').hide();
    // 必须显式回到 flex，否则 jQuery show() 的 display:block 会让 .pc-page 的 flex 布局失效，
    // 歌词区高度会塌成 0
    $('#pc_logged').css('display', 'flex');
    $('#pc-status').text('已登录：' + (nickname || '网易云用户')).addClass('logged-in');
    this.renderLyrics(this.card);
    this._renderActive(this.card.lrcIndex, true);
  };

  PlayerUI._bindLogin = function () {
    var self = this;
    $('#btn-pc-login').click(function () {
      var btn = $(this);
      btn.prop('disabled', true).text('获取二维码...');
      self.netease.getQrKey().then(function (key) {
        if (!key) { btn.prop('disabled', false).text('扫码登录'); return; }
        return self.netease.getQrImage(key).then(function (qrimg) {
          if (!qrimg) return;
          $('#pc-qr').attr('src', qrimg);
          $('#pc-qr-wrap').show();
          btn.text('请扫码登录');
          self._pollQr(key);
        });
      }).catch(function (e) {
        console.error('登录流程失败', e);
        btn.prop('disabled', false).text('扫码登录');
      });
    });
  };

  PlayerUI._pollQr = function (key) {
    var self = this;
    var attempts = 0;
    if (this._qrTimer) clearInterval(this._qrTimer);
    this._qrTimer = setInterval(function () {
      if (attempts++ > 120) { clearInterval(self._qrTimer); return; }
      self.netease.checkQr(key).then(function (res) {
        if (res.status === 'done') {
          clearInterval(self._qrTimer);
          $('#pc-qr-wrap').hide();
          self.netease.getUserAccount().then(function (acc) {
            self._enterLogged(acc && acc.nickname);
          });
        } else if (res.status === 'scanned') {
          $('#pc-status').text('已扫码，请在手机上确认');
        } else if (res.status === 'expired') {
          clearInterval(self._qrTimer);
          $('#pc-qr-wrap').hide();
          $('#btn-pc-login').prop('disabled', false).text('扫码登录');
          $('#pc-status').text('二维码已过期，请重试');
        }
      });
    }, 1500);
  };

  /* ---------------- 底部控制 ---------------- */

  PlayerUI._setPlayState = function (paused) {
    // 图标是 SVG，不能用 .prop('hidden')（SVGElement 没有 hidden 反射属性）
    if (paused) {
      $('#pc-play .icon-play').removeAttr('hidden');
      $('#pc-play .icon-pause').attr('hidden', '');
    } else {
      $('#pc-play .icon-play').attr('hidden', '');
      $('#pc-play .icon-pause').removeAttr('hidden');
    }
    $('#pc-play').attr('aria-label', paused ? '播放' : '暂停');
  };

  PlayerUI._bindControls = function () {
    var self = this;
    var audio = this.netease.audio;

    $('#pc-play').click(function () {
      if (self.netease.isPlaying()) {
        self.netease.pause();
        self._setPlayState(true);
      } else {
        if (self.card.queue.length === 0) {
          self.netease.getRecommendList().then(function (list) {
            if (list.length) self.card.setQueue(list, 0);
          });
        } else {
          self.netease.resume();
        }
        self._setPlayState(false);
      }
    });

    $('#pc-prev').click(function () { self.card.prev(); });
    $('#pc-next').click(function () { self.card.next(); });

    // 播放模式：顺序 → 随机 → 单曲循环
    var MODE_SEQ = ['order', 'shuffle', 'repeat-one'];
    var MODE_UI = {
      order: { icon: 'order', title: '顺序播放' },
      shuffle: { icon: 'shuffle', title: '随机播放' },
      'repeat-one': { icon: 'repeat-one', title: '单曲循环' }
    };
    function applyMode(mode) {
      var ui = MODE_UI[mode] || MODE_UI.order;
      $('#pc-mode .pc-mode-icon').each(function () {
        if ($(this).attr('data-mode-icon') === ui.icon) $(this).removeAttr('hidden');
        else $(this).attr('hidden', '');
      });
      $('#pc-mode').attr('title', ui.title).attr('aria-label', '播放模式：' + ui.title).toggleClass('active', mode !== 'order');
    }
    self.card.setPlayMode('order');
    applyMode('order');
    $('#pc-mode').click(function () {
      var i = MODE_SEQ.indexOf(self.card.playMode);
      var mode = MODE_SEQ[(i + 1) % MODE_SEQ.length];
      self.card.setPlayMode(mode);
      applyMode(mode);
    });

    // 进度条：拖动时不被 timeupdate 覆盖
    $('#pc-progress').on('input', function () {
      self._dragging = true;
      var d = audio.duration || 0;
      if (d > 0) audio.currentTime = (parseFloat($(this).val()) / 1000) * d;
    }).on('change', function () { self._dragging = false; });

    // 音量（与设置面板一致：网易云额外乘 0.35）
    $('#pc-volume').on('input', function () {
      var v = parseFloat($(this).val());
      self.netease.setVolume(v * 0.35);
      $('#slider-volume').val(v);
    });

    audio.addEventListener('timeupdate', function () { self._syncLyric(); });
    audio.addEventListener('ended', function () { self.card.next(); });
  };

  PlayerUI._syncLyric = function () {
    var card = this.card;
    if (!card) return;
    card._syncLyric();
    this._renderActive(card.lrcIndex);
  };

  /* ---------------- 右侧面板 ---------------- */

  PlayerUI._bindSidePanels = function () {
    var self = this;

    // 视觉模式
    $('#pc-visual-grid').on('click', '.pc-chip', function () {
      var id = $(this).data('mode');
      if (global.__bgLayer) global.__bgLayer.setMode(id);
      $('#pc-visual-grid .pc-chip').removeClass('active');
      $(this).addClass('active');
    });

    // 中心特效
    $('#pc-center-grid').on('click', '.pc-chip', function () {
      var id = $(this).data('center');
      if (global.__app && global.__app.setCenterMode) global.__app.setCenterMode(id);
      else if (global.__coreLayer) global.__coreLayer.setMode(id);
      $('#pc-center-grid .pc-chip').removeClass('active');
      $(this).addClass('active');
    });

    // AI 主题
    $('#pc-ai-toggle').change(function () {
      if (global.__app) global.__app.setAiThemeEnabled($(this).is(':checked'));
    });

    // 歌词选项
    var opts = this.card.lyricOpts;
    $('#pc-opt-word').prop('checked', opts.word).change(function () {
      opts.word = $(this).is(':checked');
      self.renderLyrics(self.card);
    });
    $('#pc-opt-tr').prop('checked', opts.translation).change(function () {
      opts.translation = $(this).is(':checked');
      self.renderLyrics(self.card);
    });
    $('#pc-opt-next').prop('checked', opts.nextLine).change(function () {
      opts.nextLine = $(this).is(':checked');
      $('#pc-lyrics-next').toggle(opts.nextLine);
    });
    $('#pc-opt-kw').prop('checked', opts.keyword).change(function () {
      opts.keyword = $(this).is(':checked');
      self.renderLyrics(self.card);
    });

    // 主题
    $('#pc-theme-grid').on('click', '.pc-theme-item', function () {
      var id = $(this).data('theme');
      $('.theme-chip[data-theme="' + id + '"]').trigger('click');
      $('#pc-theme-grid .pc-theme-item').removeClass('active');
      $(this).addClass('active');
    });
  };

  PlayerUI.renderVisualModes = function () {
    var $grid = $('#pc-visual-grid');
    if ($grid.children().length || !global.BgLayer) return;
    var bg = global.__bgLayer;
    global.BgLayer.modes().forEach(function (m) {
      var $chip = $('<div class="pc-chip"></div>').attr('data-mode', m.id).text(m.name);
      if (bg && bg.mode === m.id) $chip.addClass('active');
      $grid.append($chip);
    });
  };

  PlayerUI.renderCenterModes = function () {
    var $grid = $('#pc-center-grid');
    if ($grid.children().length || !global.CoreLayer) return;
    var cl = global.__coreLayer;
    var active = cl ? cl.mode : global.CoreLayer.defaultMode;
    global.CoreLayer.modes().forEach(function (m) {
      var $chip = $('<div class="pc-chip"></div>').attr('data-center', m.id).text(m.name);
      if (m.id === active) $chip.addClass('active');
      $grid.append($chip);
    });
  };

  PlayerUI.renderThemes = function () {
    var $grid = $('#pc-theme-grid');
    if ($grid.children().length || !global.THEMES) return;
    var active = $('#theme-list .theme-chip.active').data('theme');
    Object.keys(global.THEMES).forEach(function (id) {
      var t = global.THEMES[id];
      var $item = $('<div class="pc-theme-item"></div>')
        .attr('data-theme', id)
        .css('background', 'linear-gradient(135deg, #' + ('000000' + t.background.toString(16)).slice(-6) + ', #' + ('000000' + t.accent.toString(16)).slice(-6) + ')')
        .text(t.name);
      if (id === active) $item.addClass('active');
      $grid.append($item);
    });
  };

  /* ---------------- 曲库：搜索 / 本地 / 歌单 ---------------- */

  PlayerUI._bindLibrary = function () {
    var self = this;

    function doSearch() {
      var kw = $('#pc-search-input').val().trim();
      if (!kw) return;
      $('#pc-playlist-list, #pc-playlist-detail, #pc-playlist-back').hide();
      $('#pc-search-result').html('<p class="netease-hint">搜索中...</p>');
      self.netease.searchSongs(kw, 30).then(function (list) {
        self._renderSongList($('#pc-search-result'), list, function (songs, i) {
          self.card.setQueue(songs, i);
        });
      }).catch(function () {
        $('#pc-search-result').html('<p class="netease-hint">搜索失败，请检查 API 服务</p>');
      });
    }

    $('#pc-search-btn').click(doSearch);
    $('#pc-search-input').keydown(function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
    });

    $('#pc-local-btn').click(function () { $('#pc-local-file').click(); });
    $('#pc-local-file').change(function () {
      var f = this.files && this.files[0];
      if (f) self.card.playLocal(f);
      $(this).val('');
    });

    $('#pc-pl-btn').click(function () { self.loadPlaylists(); });
  };

  PlayerUI.loadPlaylists = function (silent) {
    var self = this;
    this._plLoaded = true;
    $('#pc-search-result').empty();
    $('#pc-playlist-detail').hide().empty();
    $('#pc-playlist-back').hide();
    $('#pc-playlist-list').show().html('<p class="netease-hint">加载中...</p>');
    this.netease.getUserPlaylists().then(function (list) {
      var $box = $('#pc-playlist-list').empty();
      if (list === null) {
        self._clearCookie();
        $('#pc_logged').hide();
        $('#pc_not_logged').show();
        $('#pc-status').text('登录已过期，请重新扫码').removeClass('logged-in');
        return;
      }
      if (!list.length) { $box.html('<p class="netease-hint">账号暂无歌单</p>'); return; }
      list.forEach(function (pl) {
        var $item = $('<div class="pc-song-item pc-playlist-item"></div>')
          .append('<img class="pc-song-cover" src="' + (pl.coverUrl || '') + '?param=48y48" onerror="this.style.visibility=\'hidden\'">')
          .append($('<div class="pc-song-meta"></div>')
            .append($('<div class="pc-song-name"></div>').text(pl.name))
            .append($('<div class="pc-song-artist"></div>').text(pl.count + ' 首')));
        $item.click(function () { self._openPlaylist(pl); });
        $box.append($item);
      });
    }).catch(function () {
      if (silent) return;
      $('#pc-playlist-list').html('<p class="netease-hint">加载歌单失败</p>');
    });
  };

  PlayerUI._openPlaylist = function (pl) {
    var self = this;
    $('#pc-playlist-list').hide();
    $('#pc-playlist-back').show();
    var $detail = $('#pc-playlist-detail').show().html('<p class="netease-hint">加载中...</p>');
    $('#pc-playlist-back').off('click').click(function () {
      $detail.hide().empty();
      $('#pc-playlist-back').hide();
      $('#pc-playlist-list').show();
    });
    this.netease.getPlaylistDetail(pl.id).then(function (songs) {
      self._renderSongList($detail, songs, function (list, i) {
        self.card.setQueue(list, i);
      });
    });
  };

  PlayerUI._renderSongList = function ($box, songs, onPlay) {
    $box.empty();
    if (!songs.length) { $box.html('<p class="netease-hint">没有找到歌曲</p>'); return; }
    songs.forEach(function (s, i) {
      var $item = $('<div class="pc-song-item"></div>')
        .attr('data-song-key', PlayerUI._songKey(s))
        .append('<img class="pc-song-cover" src="' + (s.coverUrl || '') + '?param=48y48" onerror="this.style.visibility=\'hidden\'">')
        .append($('<div class="pc-song-meta"></div>')
          .append($('<div class="pc-song-name"></div>').text(s.name))
          .append($('<div class="pc-song-artist"></div>').text(s.artist + (s.album ? ' · ' + s.album : ''))));
      $item.click(function () { onPlay(songs, i); });
      $box.append($item);
    });
    PlayerUI.markPlaying();
  };

  /* ---------------- 模组 ---------------- */

  PlayerUI.renderMods = function () {
    var self = this;
    var $box = $('#pc-mods').empty();
    this.card.mods.forEach(function (mod) {
      var $item = $('<div class="pc-mod-item"></div>')
        .append($('<div class="pc-mod-text"></div>')
          .append($('<div class="pc-song-name"></div>').text(mod.name))
          .append($('<div class="netease-hint"></div>').text(mod.desc)))
        .append('<span class="pc-mod-state">' + (mod.enabled ? 'ON' : 'OFF') + '</span>');
      $item.click(function () {
        self.card.toggleMod(mod.id);
        $item.find('.pc-mod-state').text(mod.enabled ? 'ON' : 'OFF');
        $item.toggleClass('enabled', mod.enabled);
      });
      $item.toggleClass('enabled', mod.enabled);
      $box.append($item);
    });
  };

  /* ---------------- 歌曲信息 / 队列 ---------------- */

  PlayerUI.renderNowPlaying = function (card) {
    var song = card.current();
    if (!song) return;
    var $cover = $('#pc-cover');
    if (song.coverUrl) $cover.attr('src', song.coverUrl + '?param=200y200');
    else $cover.removeAttr('src');
    $('#pc-name').text(song.name);
    $('#pc-artist').text(song.artist || '—');
    $('#pc-album').text(song.album || '');
    var stageCover = song.coverUrl ? song.coverUrl + '?param=600y600' : '';
    $('#pc-stage-bg').css('background-image', stageCover ? 'url("' + stageCover + '")' : '');
    this._setPlayState(!card.netease.isPlaying());
    if (card.theme) {
      var names = { energetic: '激昂', calm: '宁静', happy: '欢快', sad: '深情' };
      $('#pc-mood').text('AI 主题 · ' + (names[card.theme.mood.mood] || card.theme.mood.mood));
    }
    this.markPlaying(card);
  };

  // 歌曲唯一键：优先用网易云 id（本地文件匹配到在线歌曲后也可命中），否则「歌名|歌手」
  PlayerUI._songKey = function (song) {
    if (!song) return '';
    var id = song.matchedId || song.id;
    if (id) return 'id:' + id;
    return 'n:' + (song.name || '') + '|' + (song.artist || '');
  };

  // 把曲库/搜索结果里正在播放的那一首标记为选中（呼吸灯）
  PlayerUI.markPlaying = function (card) {
    var key = PlayerUI._songKey((card || this.card).current());
    $('.pc-list .pc-song-item').each(function () {
      $(this).toggleClass('playing', !!key && $(this).attr('data-song-key') === key);
    });
  };

  /* ---------------- 歌词渲染 ---------------- */

  function hasKeyword(text) {
    if (!global.Lyrics) return false;
    return global.Lyrics.keywordRanges(text).length > 0;
  }

  function lineToHtml(line, opts) {
    var $wrap = $('<span></span>');
    if (opts.word && line.words && line.words.length) {
      line.words.forEach(function (w) {
        var cls = 'w' + (opts.keyword && hasKeyword(w.text) ? ' kw' : '');
        $wrap.append($('<span></span>').addClass(cls).attr('data-t', w.t).text(w.text));
      });
      return $wrap;
    }
    var text = line.text || '';
    if (opts.keyword && global.Lyrics) {
      var ranges = global.Lyrics.keywordRanges(text);
      if (ranges.length) {
        var pos = 0;
        ranges.forEach(function (r) {
          if (r.start > pos) $wrap.append(document.createTextNode(text.slice(pos, r.start)));
          $wrap.append($('<span class="kw"></span>').text(text.slice(r.start, r.end)));
          pos = r.end;
        });
        if (pos < text.length) $wrap.append(document.createTextNode(text.slice(pos)));
        return $wrap;
      }
    }
    $wrap.text(text);
    return $wrap;
  }

  PlayerUI.renderLyrics = function (card) {
    if (!card) return;
    var $list = $('#pc-lyrics-list').empty();
    var lines = card.lyricLines || [];
    var opts = card.lyricOpts;
    this._lastLine = -1;

    if (!lines.length) {
      $list.html('<p class="netease-hint">暂无歌词</p>');
      $('#pc-lyrics-next').text('');
      $('#pc-lyric-source').text('来源：无');
      return;
    }

    var accent = (card.theme && card.theme.palette && card.theme.palette[0]) || 0x7ef0ff;
    $('#player_in')[0].style.setProperty('--pc-accent', '#' + ('000000' + accent.toString(16)).slice(-6));

    lines.forEach(function (line, i) {
      var $line = $('<div class="pc-lrc-line"></div>').attr('data-i', i);
      $line.append(lineToHtml(line, opts));
      if (opts.translation && line.tr) {
        $line.append($('<span class="pc-lrc-tr"></span>').text(line.tr));
      }
      $list.append($line);
    });

    var srcName = { lrc: 'LRC 逐行', 'enhanced-lrc': '增强 LRC 逐字', yrc: 'YRC 逐字', none: '无' };
    $('#pc-lyric-source').text('来源：' + (srcName[card.lyricInfo && card.lyricInfo.source] || '—'));
    $('#pc-lyrics-next').toggle(!!opts.nextLine);

    this._renderActive(card.lrcIndex);
  };

  PlayerUI._renderActive = function (idx, force) {
    var $lines = $('#pc-lyrics-list .pc-lrc-line');
    if (!$lines.length) return;
    if (!force && idx === this._lastLine) return;
    this._lastLine = idx;

    var $list = $('#pc-lyrics-list');
    $lines.removeClass('active');
    var $cur = (idx >= 0 && idx < $lines.length) ? $lines.eq(idx).addClass('active') : null;

    // 先读一次布局，再决定是"整块居中"还是"当前行居中"
    var listH = $list.outerHeight() || 0;
    var boxH = $('#pc-lyrics').height() || 0;
    if ($cur && listH > boxH * 0.92) {
      var center = $cur[0].offsetTop + $cur[0].offsetHeight / 2;
      $list.css('transform', 'translateY(' + (-center) + 'px)');
    } else {
      // 内容不足一屏：整块垂直居中，避免歌词堆在顶部
      $list.css('transform', 'translateY(' + (-listH / 2) + 'px)');
    }

    var card = this.card;
    if (card && card.lyricOpts.nextLine) {
      $('#pc-lyrics-next').text(card.nextLineText() || '');
    }
  };

  // 兼容旧接口
  PlayerUI.highlightLyric = function (card, idx) {
    PlayerUI._renderActive(idx);
  };

  /* ---------------- 逐字推进 / 时间 / 进度 ---------------- */

  PlayerUI._startLoop = function () {
    var self = this;
    function loop() {
      self._raf = requestAnimationFrame(loop);
      if (!$('#player').hasClass('open')) return;
      var audio = self.netease.audio;
      self._updateTime(audio);
      self._updateWords(audio);
    }
    loop();
  };

  PlayerUI._updateTime = function (audio) {
    var cur = audio.currentTime || 0;
    var dur = audio.duration || 0;
    if (!this._dragging && $('#pc-progress').length) {
      $('#pc-progress').val(dur > 0 ? Math.round((cur / dur) * 1000) : 0);
    }
    $('#pc-time-cur').text(fmt(cur));
    $('#pc-time-dur').text(fmt(dur));
    this._setPlayState(audio.paused);
  };

  PlayerUI._updateWords = function (audio) {
    var card = this.card;
    if (!card || !card.lyricLines || !card.lyricLines.length) return;
    if (audio.paused) return;
    var t = audio.currentTime || 0;
    var lines = card.lyricLines;

    // 二分查找当前行
    var lo = 0, hi = lines.length - 1, idx = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx !== this._lastLine) {
      card.lrcIndex = idx;
      this._renderActive(idx);
    }
    if (!card.lyricOpts.word || idx < 0) return;

    // 当前行逐字点亮
    var $cur = $('#pc-lyrics-list .pc-lrc-line').eq(idx);
    var $ws = $cur.find('.w');
    if (!$ws.length) return;
    $ws.each(function () {
      var wt = parseFloat(this.getAttribute('data-t'));
      $(this).toggleClass('on', t >= wt);
    });
  };

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  global.PlayerUI = PlayerUI;
})(typeof window !== 'undefined' ? window : globalThis);

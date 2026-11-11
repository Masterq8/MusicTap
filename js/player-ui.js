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
    _raf: null,
    // 网易云真实数据（登录后由 refreshLibrary 填充）
    _loggedIn: false,
    _loadingLib: false,
    _data: { recommend: [], playlists: [], recent: [], loaded: false }
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
      self._enterView($('.pc-side-panel[data-side-panel="' + side + '"]'));
      if (side === 'queue') self._syncQueueFromCard();
    });

    this._bindLogin();
    this._bindControls();
    this._bindSidePanels();
    this._bindLyricDrag();
    this._bindMusicPanels();
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

  /* 视图切换淡入：先完成 display 切换（布局立即可测量，歌词渲染不受影响），
     再让新视图从 pc-in 起点态（透明 + 上移 6px）滑入。
     showFn 负责把元素显示出来；默认清掉内联 display，
     让样式表值（如 .pc-page 的 flex）正确生效，规避 jQuery .show() 的 display:block 陷阱。 */
  PlayerUI._enterView = function ($show, showFn) {
    if (!$show || !$show.length) return $show;
    if (showFn) showFn($show);
    else $show.css('display', '');
    $show.addClass('pc-fx pc-in');
    $show.each(function () { void this.offsetWidth; });
    $show.removeClass('pc-in');
    return $show;
  };

  // 切视觉模式时整卡轻微收缩回弹
  PlayerUI._flashCard = function () {
    var el = document.getElementById('player_in');
    if (!el) return;
    el.classList.remove('is-switching');
    void el.offsetWidth;
    el.classList.add('is-switching');
    clearTimeout(this._switchTimer);
    this._switchTimer = setTimeout(function () { el.classList.remove('is-switching'); }, 480);
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
    this._loggedIn = true;
    $('#pc_not_logged').css('display', 'none');
    // 必须显式回到 flex，否则会让 .pc-page 的 flex 布局失效，
    // 歌词区高度会塌成 0；display 先行、淡入随后，渲染测量不受影响
    this._enterView($('#pc_logged'), function ($el) { $el.css('display', 'flex'); });
    $('#pc-status').text('已登录：' + (nickname || '网易云用户')).addClass('logged-in');
    this.renderLyrics(this.card);
    this._renderActive(this.card.lrcIndex, true);
    this.refreshLibrary();
  };

  // 拉取网易云真实数据：每日推荐 / 我的歌单 / 最近播放
  PlayerUI.refreshLibrary = function () {
    var self = this;
    if (!this._loggedIn || this._loadingLib) return;
    this._loadingLib = true;
    if (!this._data.loaded) {
      $('#pc-recommend-list').html(this._emptyHint('加载中...'));
      $('#pc-recent-list').html(this._emptyHint('加载中...'));
      $('#pc-playlist-grid').html(this._emptyHint('加载中...'));
    }
    Promise.all([
      this.netease.getRecommendList().catch(function () { return []; }),
      this.netease.getUserPlaylists().catch(function () { return undefined; }),
      this.netease.getRecentSongs().catch(function () { return []; })
    ]).then(function (res) {
      self._loadingLib = false;
      // 歌单接口返回 null 说明 cookie 失效
      if (res[1] === null) {
        self._loggedIn = false;
        self._data = { recommend: [], playlists: [], recent: [], loaded: false };
        self._clearCookie();
        $('#pc_logged').css('display', 'none');
        $('#pc_not_logged').css('display', 'flex');
        $('#pc-status').text('登录已过期，请重新扫码').removeClass('logged-in');
        self._renderRecommend();
        self._renderPlaylists();
        self._renderRecent();
        return;
      }
      self._data.recommend = res[0] || [];
      self._data.playlists = res[1] || [];
      self._data.recent = res[2] || [];
      self._data.loaded = true;
      self._renderRecommend();
      self._renderPlaylists();
      self._renderRecent();
    });
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
          self._enterView($('#pc-qr-wrap'));
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
    $('#pc-play').attr('aria-label', paused ? '播放' : '暂停').toggleClass('is-playing', !paused);
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
      $(this).css('--p', (parseFloat($(this).val()) / 10).toFixed(2) + '%');
      if (d > 0) audio.currentTime = (parseFloat($(this).val()) / 1000) * d;
    }).on('change', function () { self._dragging = false; });

    // 音量（与设置面板一致：网易云额外乘 0.35）
    $('#pc-volume').on('input', function () {
      var v = parseFloat($(this).val());
      self.netease.setVolume(v * 0.35);
      $('#slider-volume').val(v);
    });

    // 注意：timeupdate / ended 不在这里重复注册——
    // player.js 构造时已挂过一次（歌词同步 + 自动切下一首），
    // 重复注册会让 ended 触发两次 next()，歌曲播完直接跳两首。
  };

  PlayerUI._syncLyric = function () {
    var card = this.card;
    if (!card || this._lrcDragging) return; // 拖拽中由拖拽逻辑接管高亮
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
      self._flashCard();
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
        $('#pc_logged').css('display', 'none');
        self._enterView($('#pc_not_logged'));
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
      self._plCurrentId = null; // 迟到的分页数据不再渲染
      $detail.hide().empty();
      $('#pc-playlist-back').hide();
      $('#pc-playlist-list').show();
    });
    var loaded = [];
    var rendered = 0;
    this._plCurrentId = pl.id;
    this.netease.getPlaylistDetail(pl.id, {
      total: pl.count || 0,
      onProgress: function (partial) {
        if (self._plCurrentId !== pl.id) return;
        loaded.length = 0;
        loaded.push.apply(loaded, partial);
        if ($detail.find('.netease-hint').length) $detail.empty();
        for (var i = rendered; i < loaded.length; i++) {
          $detail.append(self._songRow(loaded[i], i, loaded, function (list, idx) {
            self.card.setQueue(list, idx);
          }));
        }
        rendered = loaded.length;
        PlayerUI.markPlaying();
      }
    }).then(function (songs) {
      if (self._plCurrentId !== pl.id) return;
      if (!songs.length) $detail.html('<p class="netease-hint">歌单是空的</p>');
    }).catch(function () {
      if (self._plCurrentId === pl.id) {
        $detail.html('<p class="netease-hint">加载歌单失败</p>');
      }
    });
  };

  // 单行曲目（曲库列表用）；songs 传同一个数组引用，点击时拿到的是加载全量
  PlayerUI._songRow = function (s, i, songs, onPlay) {
    var $item = $('<div class="pc-song-item"></div>')
      .attr('data-song-key', PlayerUI._songKey(s))
      .append('<img class="pc-song-cover" src="' + (s.coverUrl || '') + '?param=48y48" onerror="this.style.visibility=\'hidden\'">')
      .append($('<div class="pc-song-meta"></div>')
        .append($('<div class="pc-song-name"></div>').text(s.name))
        .append($('<div class="pc-song-artist"></div>').text(s.artist + (s.album ? ' · ' + s.album : ''))));
    $item.click(function () { onPlay(songs, i); });
    return $item;
  };

  PlayerUI._renderSongList = function ($box, songs, onPlay) {
    $box.empty();
    if (!songs.length) { $box.html('<p class="netease-hint">没有找到歌曲</p>'); return; }
    songs.forEach(function (s, i) {
      $box.append(PlayerUI._songRow(s, i, songs, onPlay));
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
      this._syncAccent(card);
    } else {
      // 换歌后主题尚未生成：清掉旧歌情绪，避免控件与当前歌曲不匹配
      $('#pc-mood').text('AI 主题 · 分析中…');
    }
    this.markPlaying(card);
    this._refreshTrackHighlight(song);
  };

  // 换歌后同步所有曲目列表（推荐 / 最近 / 队列）的 is-current 高亮
  PlayerUI._refreshTrackHighlight = function (song) {
    var id = (song && song.id != null) ? String(song.id) : null;
    this._currentTrackId = id;
    if (!id) return;
    $('#pc-recommend-list .pc-track, #pc-recent-list .pc-track, #pc-queue-list .pc-track')
      .each(function () {
        $(this).toggleClass('is-current', $(this).attr('data-id') === id);
      });
  };

  // AI 主题强调色 → 播放页 CSS 变量（与 renderLyrics 保持一致）
  PlayerUI._syncAccent = function (card) {
    var accent = (card.theme && card.theme.palette && card.theme.palette[0]) || 0x7ef0ff;
    var el = document.getElementById('player_in');
    if (el) el.style.setProperty('--pc-accent', '#' + ('000000' + accent.toString(16)).slice(-6));
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
    $('.pc-list .pc-song-item, .pc-pl-detail .pc-song-item').each(function () {
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
    this._lrcDragging = false; // 换歌重置拖拽态
    $list.removeClass('dragging');
    this._hideSeekTip();

    if (!lines.length) {
      var song = card.current();
      if (!song) {
        // 全新空状态：还没播过歌 → 居中引导（参考网易云/Apple Music 的空态设计）
        $list.html(
          '<div class="pc-lrc-empty">' +
            '<div class="pc-lrc-empty-glyph" aria-hidden="true">♪</div>' +
            '<div class="pc-lrc-empty-title">还没有正在播放的歌曲</div>' +
            '<div class="pc-lrc-empty-sub">从右侧推荐或歌单中选一首，歌词会在这里逐字点亮</div>' +
          '</div>');
        $('#pc-lyrics-next').text('');
        $('#pc-lyric-source').text('');
        $list.css('transform', 'translateY(-50%)'); // 空态提示整体居中
        return;
      }
      // 有歌：lyricInfo 为空 = 歌词还在加载；已有 lyricInfo 但没行 = 真的没有歌词
      var loading = !card.lyricInfo;
      $list.html(
        '<div class="pc-lrc-empty">' +
          (loading
            ? '<div class="pc-lrc-empty-glyph pc-lrc-spinner" aria-hidden="true"></div>' +
              '<div class="pc-lrc-empty-title">歌词加载中</div>' +
              '<div class="pc-lrc-empty-sub">正在匹配逐字时序…</div>'
            : '<div class="pc-lrc-empty-glyph" aria-hidden="true">♪</div>' +
              '<div class="pc-lrc-empty-title">暂无歌词</div>' +
              '<div class="pc-lrc-empty-sub">尽情享受旋律吧</div>') +
        '</div>');
      $('#pc-lyrics-next').text('');
      $('#pc-lyric-source').text('来源：' + (loading ? '—' : '无'));
      // 提示整体垂直居中，别沿用上一首的滚动偏移
      $list.css('transform', 'translateY(-50%)');
      return;
    }

    this._syncAccent(card);

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
    var $prev = $lines.filter('.active');
    $lines.removeClass('active near far entering leaving');

    var $cur = (idx >= 0 && idx < $lines.length) ? $lines.eq(idx) : null;

    // 相邻行 35% / 更远 18%，当前行由 CSS 放大 1.06 倍并转青
    $lines.each(function (i) {
      var d = Math.abs(i - idx);
      if (d === 1) $(this).addClass('near');
      else if (d >= 2 || idx < 0) $(this).addClass('far');
    });

    if ($cur) {
      $cur.addClass('active');
      if (!force) {
        if ($prev.length && $prev[0] !== $cur[0]) {
          $prev.addClass('leaving');
          setTimeout(function () { $prev.removeClass('leaving'); }, 320);
        }
        $cur.addClass('entering');
        void $cur[0].offsetWidth;
        requestAnimationFrame(function () { $cur.removeClass('entering'); });
      }
    }

    // 先读一次布局，再决定是"整块居中"还是"当前行居中"
    // （拖拽中由 _bindLyricDrag 接管 transform，这里跳过自动滚动）
    if (!this._lrcDragging) {
      var listH = $list.outerHeight() || 0;
      var boxH = $('#pc-lyrics').height() || 0;
      if ($cur && listH > boxH * 0.92) {
        var center = $cur[0].offsetTop + $cur[0].offsetHeight / 2;
        $list.css('transform', 'translateY(' + (-center) + 'px)');
      } else {
        // 内容不足一屏：整块垂直居中，避免歌词堆在顶部
        $list.css('transform', 'translateY(' + (-listH / 2) + 'px)');
      }
    }

    var card = this.card;
    if (card && card.lyricOpts.nextLine) {
      $('#pc-lyrics-next').text(card.nextLineText() || '');
    }
  };

  // 兼容旧接口
  PlayerUI.highlightLyric = function (card, idx) {
    if (PlayerUI._lrcDragging) return; // 拖拽中不抢高亮
    PlayerUI._renderActive(idx);
  };

  /* ---------------- 歌词拖拽 seek（拖到哪行松手就跳到哪句） ---------------- */

  PlayerUI._lrcDragging = false;

  PlayerUI._bindLyricDrag = function () {
    var self = this;
    var $box = $('#pc-lyrics');
    var $list = $('#pc-lyrics-list');
    if (!$box.length) return;
    var drag = null;

    // 拖拽可用的 translateY 范围：第一行中心 ↔ 最后一行中心经过视口中心
    function lineRange() {
      var $lines = $list.children('.pc-lrc-line');
      if (!$lines.length) return null;
      var first = $lines.first()[0];
      var last = $lines.last()[0];
      return {
        yMax: -(first.offsetTop + first.offsetHeight / 2),
        yMin: -(last.offsetTop + last.offsetHeight / 2)
      };
    }

    // 列表平移 y 时，中心线落在哪一行（列表 top:50% + translateY，距中心 = y + 行中心偏移）
    function lineAtCenter(y) {
      var best = -1, bestD = Infinity;
      $list.children('.pc-lrc-line').each(function (i) {
        var d = Math.abs(y + this.offsetTop + this.offsetHeight / 2);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    }

    $box.on('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (!$list.children('.pc-lrc-line').length) return;
      var m = /translateY\(([-\d.]+)px\)/.exec($list[0].style.transform || '');
      drag = { y0: e.clientY, t0: m ? parseFloat(m[1]) : 0, moved: false };
      try { $box[0].setPointerCapture(e.pointerId); } catch (err) { /* 旧浏览器忽略 */ }
      e.preventDefault(); // 防止拖出文本选区
    });

    $box.on('pointermove', function (e) {
      if (!drag) return;
      var dy = e.clientY - drag.y0;
      if (!drag.moved && Math.abs(dy) < 6) return; // 6px 内不算拖拽
      drag.moved = true;
      self._lrcDragging = true;
      $box.add($list).addClass('dragging');
      var y = drag.t0 + dy;
      var range = lineRange();
      if (range) y = Math.max(range.yMin, Math.min(range.yMax, y));
      drag.y = y;
      $list.css('transform', 'translateY(' + y + 'px)');
      var idx = lineAtCenter(y);
      var lines = (self.card && self.card.lyricLines) || [];
      if (idx >= 0 && lines[idx]) {
        self._renderActive(idx, true); // 只更新高亮，transform 由拖拽接管
        self._showSeekTip(lines[idx].t);
      }
    });

    function finish() {
      if (!drag) return;
      var moved = drag.moved;
      var y = (drag.y != null) ? drag.y : drag.t0;
      drag = null;
      self._lrcDragging = false;
      $box.add($list).removeClass('dragging');
      self._hideSeekTip();
      if (!moved) return;
      var lines = (self.card && self.card.lyricLines) || [];
      var line = lines[lineAtCenter(y)];
      if (!line) return;
      var audio = self.netease.audio;
      if (!audio || !isFinite(audio.duration) || !audio.duration) return;
      var t = Math.max(0, Math.min(line.t, audio.duration - 0.2));
      try { audio.currentTime = t; } catch (err) { return; }
      // 立即对齐高亮与逐字状态（seeked 事件后 timeupdate 会再校准）
      var seekIdx = lineAtCenter(y);
      self.card.lrcIndex = seekIdx;
      self._renderActive(seekIdx, true);
    }
    $box.on('pointerup pointercancel lostpointercapture', finish);
  };

  // 拖拽时的中心指示线 + 时间气泡
  PlayerUI._showSeekTip = function (t) {
    var $tip = $('#pc-lrc-seek');
    if (!$tip.length) {
      $tip = $('<div id="pc-lrc-seek" aria-hidden="true"></div>');
      $('#pc-lyrics').append($tip);
    }
    $tip.attr('data-time', fmt(Math.max(0, t || 0))).addClass('show');
  };

  PlayerUI._hideSeekTip = function () {
    $('#pc-lrc-seek').removeClass('show');
  };

  /* ---------------- 音乐内容面板：推荐 / 歌单 / 最近 / 队列 ---------------- */

  function applyCover($el, cover) {
    if (!cover) return;
    if (/^(https?:|data:)/i.test(cover)) $el.css('background-image', 'url("' + cover + '")');
    else $el.css('background', cover);
  }

  PlayerUI._fmtDuration = function (sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  };

  PlayerUI._trackRow = function (track, index, opts) {
    opts = opts || {};
    var self = this;
    var id = String(track.id);
    var $row = $('<div class="pc-track"></div>')
      .attr('data-id', id)
      .toggleClass('is-current', id === String(this._currentTrackId));
    if (opts.draggable) $row.attr('draggable', 'true');

    var $idx = $('<div class="pc-track-idx"></div>');
    $idx.append($('<span class="pc-track-num"></span>').text(index < 9 ? '0' + (index + 1) : String(index + 1)));
    $idx.append($('<span class="pc-bars"><i></i><i></i><i></i></span>'));
    $row.append($idx);

    var $cover = $('<div class="pc-track-cover"></div>');
    applyCover($cover, track.cover);
    $row.append($cover);

    var $info = $('<div class="pc-track-info"></div>');
    $info.append($('<div class="pc-track-name"></div>').text(track.name || '未知曲目'));
    var sub = [track.artist, track.album].filter(Boolean).join(' · ');
    $info.append($('<div class="pc-track-sub"></div>').text(sub || '—'));
    $row.append($info);

    $row.append($('<div class="pc-track-time"></div>').text(self._fmtDuration(track.duration)));

    if (opts.remove) $row.append('<button class="pc-track-remove" type="button">移除</button>');

    $row.on('click', function (e) {
      if ($(e.target).closest('.pc-track-remove').length) return;
      if (self._suppressRowClick) return;
      self._playFromList(opts.list || [track], index);
    });

    return $row;
  };

  // 曲目 → 可播放歌曲对象（player.js 需要 coverUrl）
  function toSong(t) {
    return {
      id: t.id,
      name: t.name,
      artist: t.artist,
      album: t.album || '',
      duration: t.duration || 0,
      cover: t.cover || t.coverUrl || '',
      coverUrl: t.coverUrl || t.cover || ''
    };
  }

  PlayerUI._emptyHint = function (text) {
    return '<p class="pc-empty">' + text + '</p>';
  };

  // 用给定列表建立播放队列，并从 index 开始播放
  PlayerUI._playFromList = function (list, index) {
    if (!list || !list.length) return;
    var songs = list.map(toSong);
    var i = index == null ? 0 : index;
    if (i < 0 || i >= songs.length) i = 0;
    this.card.setQueue(songs, i);
    this._syncQueueFromCard();
    this._renderRecommend();
    this._renderRecent();
  };

  // 打开歌单：取详情后整单播放（保留给"播放全部"按钮用）
  PlayerUI._loadPlaylist = function (pl) {
    var self = this;
    if (!pl) return;
    this.netease.getPlaylistDetail(pl.id, { total: pl.count || 0 }).then(function (songs) {
      if (!songs || !songs.length) return;
      self._playFromList(songs, 0);
      self._flashCard();
    }).catch(function () {});
  };

  // 侧栏歌单：点击卡片 → 进入曲目列表（不自动播放）；点曲目行才播
  PlayerUI._openSidePlaylist = function (pl) {
    var self = this;
    if (!pl) return;
    var $panel = $('[data-side-panel="playlists"]');
    if (!this._plDetail) {
      this._plDetail = $('<div class="pc-pl-detail" hidden></div>');
      $panel.append(this._plDetail);
    }
    var $detail = this._plDetail;

    // 组装头部：返回 / 标题 / 播放全部
    var $title = $('<span></span>').text(pl.name + ' · ' + (pl.count || 0) + ' 首');
    var $head = $('<div class="pc-sec-head pc-pl-detail-head"></div>')
      .append($('<button class="pc-text-btn" type="button">返回</button>'))
      .append($title)
      .append($('<button class="pc-text-btn" type="button">播放全部</button>'));
    var $list = $('<div class="pc-song-list"></div>')
      .html('<p class="pc-empty">加载中...</p>');
    $detail.empty().append($head).append($list);

    var $home = $panel.find('#pc-liked-entry, #pc-playlist-grid').add($panel.find('.pc-sec-head').not($head));
    $home.hide();
    self._enterView($detail, function ($el) { $el.removeAttr('hidden'); });

    function goBack() {
      self._plCurrentId = null; // 迟到的分页数据不再渲染
      $detail.attr('hidden', '');
      self._enterView($home);
    }
    $head.find('.pc-text-btn').first().on('click', goBack);
    $head.find('.pc-text-btn').last().on('click', function () {
      self._playFromList(self._plLoadedTracks, 0);
      self._flashCard();
    });

    // 渐进渲染：每页到达就追加，点击行从该首起播（队列 = 已加载部分）
    var loaded = (this._plLoadedTracks = []);
    var rendered = 0;
    this._plCurrentId = pl.id; // 先设标记，防止上一单的迟到数据串台
    this.netease.getPlaylistDetail(pl.id, {
      total: pl.count || 0,
      onProgress: function (partial) {
        // 已切走（用户点了返回或换了歌单）就不再渲染
        if (!$detail.is(':visible') || self._plCurrentId !== pl.id) return;
        loaded.length = 0;
        loaded.push.apply(loaded, partial);
        if ($list.find('.pc-empty').length) $list.empty(); // 首页到达后清掉“加载中”占位
        for (var i = rendered; i < loaded.length; i++) {
          $list.append(self._trackRow(loaded[i], i, { list: loaded }));
        }
        rendered = loaded.length;
        $title.text(pl.name + ' · ' + rendered + (pl.count ? ' / ' + pl.count : '') + ' 首');
      }
    }).then(function (songs) {
      if (!$detail.is(':visible') || self._plCurrentId !== pl.id) return;
      if (!songs.length) $list.html('<p class="pc-empty">歌单是空的</p>');
    }).catch(function () {
      if ($detail.is(':visible') && self._plCurrentId === pl.id) {
        $list.html('<p class="pc-empty">加载失败，请检查 API 服务</p>');
      }
    });
  };

  PlayerUI._renderRecommend = function () {
    var $list = $('#pc-recommend-list');
    if (!$list.length) return;
    $list.empty();
    var list = this._data.recommend || [];
    $('#pc-recommend-count').text('今日推荐 · ' + list.length + ' 首');
    if (!list.length) {
      $list.html(this._emptyHint(this._loggedIn ? '今日推荐为空' : '登录网易云后查看每日推荐'));
      return;
    }
    var self = this;
    list.forEach(function (t, i) {
      $list.append(self._trackRow(t, i, { list: list }));
    });
  };

  PlayerUI._renderRecent = function () {
    var $list = $('#pc-recent-list');
    if (!$list.length) return;
    $list.empty();
    var list = this._data.recent || [];
    if (!list.length) {
      $list.html(this._emptyHint(this._loggedIn ? '还没有最近播放' : '登录网易云后查看最近播放'));
      return;
    }
    var self = this;
    list.forEach(function (t, i) {
      $list.append(self._trackRow(t, i, { remove: true, list: list }));
    });
  };

  PlayerUI._renderPlaylists = function () {
    var $grid = $('#pc-playlist-grid');
    if (!$grid.length) return;
    $grid.empty();
    var list = this._data.playlists || [];
    var liked = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].specialType === 5) { liked = list[i]; break; }
    }
    if (!liked && list.length) liked = list[0];
    this._likedPlaylist = liked;
    $('#pc-liked-count').text(liked ? liked.count + ' 首' : (this._loggedIn ? '0 首' : '未登录'));
    if (!list.length) {
      $grid.html(this._emptyHint(this._loggedIn ? '暂无歌单' : '登录网易云后查看我的歌单'));
      return;
    }
    var self = this;
    list.forEach(function (pl) {
      var $card = $('<div class="pc-playlist-card"></div>');
      var $cover = $('<div class="pc-playlist-cover"></div>');
      applyCover($cover, pl.coverUrl || '');
      $card.append($cover);
      $card.append($('<div class="pc-playlist-name"></div>').text(pl.name));
      $card.append($('<div class="pc-playlist-count"></div>').text(pl.count + ' 首'));
      $card.on('click', function () { self._openSidePlaylist(pl); });
      $grid.append($card);
    });
  };

  PlayerUI._renderQueue = function () {
    var $list = $('#pc-queue-list');
    if (!$list.length) return;
    $list.empty();
    $('#pc-queue-count').text('共 ' + this._queue.length + ' 首');
    if (!this._queue.length) {
      $list.append('<p class="pc-empty">队列为空</p>');
      return;
    }
    var self = this;
    var queue = this._queue;
    this._queue.forEach(function (t, i) { $list.append(self._trackRow(t, i, { draggable: true, list: queue })); });
  };

  PlayerUI._syncQueueFromCard = function () {
    var card = this.card;
    if (!card) return;
    this._queue = (card.queue || []).map(function (s) {
      return {
        id: s.id,
        name: s.name,
        artist: s.artist,
        album: s.album || '',
        duration: s.duration || 0,
        cover: s.coverUrl || s.cover || ''
      };
    });
    var cur = card.current && card.current();
    this._currentTrackId = cur ? cur.id : null;
    this._renderQueue();
  };

  PlayerUI._setFMMode = function (on) {
    on = !!on;
    if (on === this.isFMMode) return;
    if (on && !this._loggedIn) { this._flashCard(); return; } // 私人 FM 需要登录
    this.isFMMode = on;

    $('#player_in').toggleClass('fm-mode', on);
    if (on) $('#pc-fm-badge').removeAttr('hidden');
    else $('#pc-fm-badge').attr('hidden', '');

    var $toggle = $('#pc-fm-toggle');
    $toggle.attr('aria-label', on ? '退出私人 FM' : '播放私人 FM');
    if (on) {
      $toggle.find('.pc-fm-play').attr('hidden', '');
      $toggle.find('.pc-fm-pause').removeAttr('hidden');
      this._queueBackup = this._queue.slice();
      var self = this;
      this.netease.getPersonalFm().then(function (list) {
        if (!self.isFMMode || !list || !list.length) return;
        self._playFromList(list, 0);
      }).catch(function () {});
    } else {
      $toggle.find('.pc-fm-play').removeAttr('hidden');
      $toggle.find('.pc-fm-pause').attr('hidden', '');
      var backup = this._queueBackup || [];
      this._queue = backup.slice();
      this.card.queue = backup.map(toSong);
      this.card.index = 0;
      this._currentTrackId = this._queue.length ? this._queue[0].id : null;
      this._renderQueue();
    }
  };

  PlayerUI._applyQueueOrder = function () {
    var ids = [];
    $('#pc-queue-list .pc-track').each(function () { ids.push($(this).attr('data-id')); });
    this._queue.sort(function (a, b) {
      return ids.indexOf(String(a.id)) - ids.indexOf(String(b.id));
    });
    // 同步 card 的播放队列，否则拖动后点播的索引会对不上
    var card = this.card;
    if (card && card.queue) {
      var cur = card.current();
      card.queue.sort(function (a, b) {
        return ids.indexOf(String(a.id)) - ids.indexOf(String(b.id));
      });
      if (cur) card.index = ids.indexOf(String(cur.id));
    }
    this._renderQueue();
  };

  PlayerUI._bindMusicPanels = function () {
    var self = this;

    // 私人 FM 入口
    $('#pc-fm-card').on('click', function () {
      if (!self.isFMMode) self._setFMMode(true);
    });
    $('#pc-fm-toggle').on('click', function (e) {
      e.stopPropagation();
      self._setFMMode(!self.isFMMode);
    });
    $('#pc-fm-badge').on('click', function () {
      self._setFMMode(false);
    });

    // 全部播放（每日推荐）
    $('#pc-recommend-playall').on('click', function () {
      self._playFromList(self._data.recommend, 0);
    });

    // 我喜欢的音乐入口：进入曲目列表，不自动播放
    $('#pc-liked-entry').on('click', function () { self._openSidePlaylist(self._likedPlaylist); });
    $('#pc-liked-entry').on('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        self._openSidePlaylist(self._likedPlaylist);
      }
    });

    // 最近：移除（仅从当前列表移除）/ 清空
    $('#pc-recent-list').on('click', '.pc-track-remove', function (e) {
      e.stopPropagation();
      var id = $(this).closest('.pc-track').attr('data-id');
      self._data.recent = self._data.recent.filter(function (t) { return String(t.id) !== id; });
      self._renderRecent();
    });
    $('#pc-recent-clear').on('click', function () {
      self._data.recent = [];
      self._renderRecent();
    });

    // 队列：清空（同时清掉播放器队列）
    $('#pc-queue-clear').on('click', function () {
      self._queue = [];
      if (self.card) { self.card.queue = []; self.card.index = -1; }
      self._currentTrackId = null;
      self._renderQueue();
    });

    // 队列：原生拖拽排序
    var $queue = $('#pc-queue-list');
    $queue.on('dragstart', '.pc-track', function (e) {
      self._dragId = $(this).attr('data-id');
      $(this).addClass('dragging');
      self._suppressRowClick = true;
      if (e.originalEvent && e.originalEvent.dataTransfer) {
        e.originalEvent.dataTransfer.effectAllowed = 'move';
        try { e.originalEvent.dataTransfer.setData('text/plain', self._dragId); } catch (err) {}
      }
    });
    $queue.on('dragover', '.pc-track', function (e) {
      if (!self._dragId) return;
      e.preventDefault();
      var $dragged = $queue.children('.pc-track.dragging');
      if (!$dragged.length) return;
      var rect = this.getBoundingClientRect();
      var after = ((e.originalEvent && e.originalEvent.clientY) || e.clientY) - rect.top > rect.height / 2;
      if (after) $dragged.insertAfter(this);
      else $dragged.insertBefore(this);
    });
    $queue.on('drop', function (e) { e.preventDefault(); });
    $queue.on('dragend', '.pc-track', function () {
      self._dragId = null;
      $queue.children('.pc-track').removeClass('dragging');
      self._applyQueueOrder();
      setTimeout(function () { self._suppressRowClick = false; }, 60);
    });

    this._renderRecommend();
    this._renderPlaylists();
    this._renderRecent();
    this._renderQueue();
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
    if ($('#pc-progress').length) {
      var pct = dur > 0 ? (cur / dur) * 100 : 0;
      $('#pc-progress').css('--p', pct.toFixed(2) + '%');
      if (!this._dragging) $('#pc-progress').val(dur > 0 ? Math.round((cur / dur) * 1000) : 0);
    }
    $('#pc-time-cur').text(fmt(cur));
    $('#pc-time-dur').text(fmt(dur));
    this._setPlayState(audio.paused);
  };

  PlayerUI._updateWords = function (audio) {
    var card = this.card;
    if (!card || !card.lyricLines || !card.lyricLines.length) return;
    if (audio.paused || this._lrcDragging) return; // 拖拽中暂停自动跟随
    var t = audio.currentTime || 0;
    var lines = card.lyricLines;

    // 二分查找当前行
    var lo = 0, hi = lines.length - 1, idx = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx === -1) idx = 0; // 前奏期间也点亮第一句
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

  /* ---------------- 初始状态 ----------------
   * 曲目数据全部来自网易云 API（登录后由 refreshLibrary 拉取），
   * 未登录时各面板显示登录提示。
   */
  PlayerUI.isFMMode = false;
  PlayerUI._queue = [];
  PlayerUI._currentTrackId = null;
  PlayerUI._queueBackup = null;
  PlayerUI._dragId = null;
  PlayerUI._suppressRowClick = false;
  PlayerUI._likedPlaylist = null;

  global.PlayerUI = PlayerUI;
})(typeof window !== 'undefined' ? window : globalThis);

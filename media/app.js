/* =========================================================
 * 番茄小说 Webview 前端（纯 JS，无框架）
 * 所有网络请求都通过 postMessage 转发到扩展宿主执行。
 * ========================================================= */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  /** 宿主类型：'panel'=编辑器标签页，'sidebar'=侧边栏视图 */
  var IS_SIDEBAR = document.body && document.body.dataset.host === 'sidebar';

  /** 侧边栏点击书籍 → 在编辑器标签页中打开阅读器（itemId 可选：续读历史章节） */
  function openBookInEditor(bookId, itemId) {
    var payload = { bookId: bookId, mode: 'reader' };
    if (itemId) payload.itemId = itemId;
    call('open-editor-book', payload).catch(function () { /* ignore */ });
  }

  /* ---------------- 消息封装 ---------------- */
  var msgId = 0;
  var pending = new Map();
  function call(type, payload) {
    return new Promise(function (resolve, reject) {
      var id = ++msgId;
      pending.set(id, { resolve: resolve, reject: reject });
      var m = { type: type, id: id };
      if (payload) Object.keys(payload).forEach(function (k) { m[k] = payload[k]; });
      vscode.postMessage(m);
      setTimeout(function () {
        if (pending.has(id)) { pending.delete(id); reject(new Error('请求超时，请重试')); }
      }, 90000);
    });
  }

  /* ---------------- 状态 ---------------- */
  var state = {
    view: 'bookstore',
    user: null,
    loggedIn: false,
    settings: { fontSize: 19, lineHeight: 1.9, theme: 'night' },
    // 书城
    rankCats: [],
    rankCatsLoaded: false,
    rankType: 3,
    rankGender: 'male',
    rankCat: '',
    rankBooks: [],
    rankOffset: 0,
    rankLoading: false,
    rankHasMore: false,
    // 搜索
    query: '',
    searchPage: 0,
    searchBooks: [],
    searchTotal: 0,
    searching: false,
    // 书籍
    book: null,
    directory: null,
    // 阅读器
    inReader: false,
    readerBookId: null,
    readerBookTitle: '',
    chapters: [],
    chapterIdx: -1,
    chapter: null,
    pages: [],
    pageIdx: 0,
    readerLoading: false,
    readerError: null,
    // 抽屉
    drawer: null, // 'catalog' | 'comments' | null
    commentsKind: 'book',
    comments: [],
    commentsLoading: false,
    commentsError: null,
    settingsOpen: false,
    // 书架
    shelfLocal: [],
    shelfRemote: [],
    shelfLoading: false,
    // 登录
    qrSession: 0,
    qrUrl: null,
    qrText: null,
    qrStatusText: '未登录',
    qrStatusClass: '',
    qrWorking: false,
  };


  function saveState() {
    try { vscode.setState(state); } catch (e) { /* ignore */ }
  }
  var prevState = vscode.getState();
  // 只恢复安全的标量字段（settings），避免旧结构覆盖新结构
  if (prevState && prevState.settings) {
    state.settings = Object.assign(state.settings, prevState.settings);
  }

  /* ---------------- DOM 工具 ---------------- */
  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fmtWord(n) {
    n = Number(n || 0);
    if (!n) return '';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万字';
    return n + '字';
  }
  function fmtCount(n) {
    n = Number(n || 0);
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return String(n);
  }
  function coverFallback(e) {
    e.onerror = null;
    e.src = '';
    e.style.background = 'linear-gradient(135deg,#ff6b3d,#ff3d2e)';
  }
  function statusText(cs) {
    if (cs === '0') return '完结';
    if (cs === '1') return '连载';
    if (cs === '4') return '断更';
    return '';
  }

  /* ---------------- 全局渲染 ---------------- */
  var app = document.getElementById('app');

  function applySettings() {
    document.documentElement.dataset.theme = state.settings.theme;
    var root = document.documentElement;
    root.style.setProperty('--reader-font-size', state.settings.fontSize + 'px');
    root.style.setProperty('--reader-line-height', String(state.settings.lineHeight));
  }

  function render() {
    applySettings();
    if (state.view === 'reader') {
      renderReader();
      return;
    }
    var nav = el('div', 'navbar');
    nav.appendChild(el('span', 'brand', '🍅 番茄小说'));
    var tab = function (id, label) {
      var b = el('button', 'nav-tab' + (state.view === id ? ' active' : ''), label);
      b.dataset.nav = id;
      return b;
    };
    nav.appendChild(tab('bookstore', '书城'));
    nav.appendChild(tab('search', '搜索'));
    nav.appendChild(tab('shelf', '书架'));
    nav.appendChild(el('span', 'spacer'));
    var userBtn = el('div', 'nav-user');
    userBtn.dataset.nav = 'login';
    if (state.user) {
      if (state.user.avatar) {
        var img = el('img');
        img.src = state.user.avatar;
        img.onerror = function () { img.style.display = 'none'; };
        userBtn.appendChild(img);
      } else {
        userBtn.appendChild(el('span', 'avatar-fallback', (state.user.name || '?').slice(0, 1)));
      }
      userBtn.appendChild(el('span', null, state.user.name || '已登录'));
    } else {
      userBtn.appendChild(el('span', 'avatar-fallback', '登'));
      userBtn.appendChild(el('span', null, '登录'));
    }
    nav.appendChild(userBtn);

    app.innerHTML = '';
    app.appendChild(nav);
    var view = el('div', 'view');
    view.id = 'view';
    app.appendChild(view);

    renderView();
  }


  function rerenderLogin() {
    var v = $('#view');
    if (v) v.innerHTML = '';
    renderView();
  }
  function renderView() {
    var view = $('#view');
    if (!view) return;
    view.innerHTML = '';
    switch (state.view) {
      case 'bookstore': renderBookstore(view); break;
      case 'search': renderSearch(view); break;
      case 'shelf': renderShelf(view); break;
      case 'login': renderLogin(view); break;
    }
  }

  /* ---------------- 书城 ---------------- */
  function renderBookstore(view) {
    if (!state.rankCatsLoaded) {
      view.appendChild(el('div', 'loading', '加载中…'));
      call('rank-categories', {}).then(function (cats) {
        state.rankCats = cats || [];
        state.rankCatsLoaded = true;
        renderView();
      }).catch(function (e) {
        view.innerHTML = '';
        view.appendChild(errBox(e.message));
      });
      return;
    }
    // 性别与榜单类型
    var genders = [{ v: 'male', l: '男频' }, { v: 'female', l: '女频' }];
    var types = [{ v: 3, l: '推荐' }, { v: 1, l: '热读' }, { v: 6, l: '新书' }, { v: 4, l: '完结' }, { v: 5, l: '更新' }];
    var chips = el('div', 'chips');
    genders.forEach(function (g) {
      var c = el('button', 'chip' + (state.rankGender === g.v ? ' active' : ''), g.l);
      c.dataset.gender = g.v;
      chips.appendChild(c);
    });
    chips.appendChild(el('span', 'spacer'));
    types.forEach(function (t) {
      var c = el('button', 'chip' + (state.rankType === t.v ? ' active' : ''), t.l);
      c.dataset.rankType = String(t.v);
      chips.appendChild(c);
    });
    view.appendChild(chips);
    // 分类
    var cats = state.rankCats.filter(function (c) { return c.group && c.group.indexOf(state.rankGender) >= 0; });
    if (cats.length) {
      var catChips = el('div', 'chips');
      var all = el('button', 'chip' + (!state.rankCat ? ' active' : ''), '全部');
      all.dataset.cat = '';
      catChips.appendChild(all);
      cats.slice(0, 24).forEach(function (c) {
        var b = el('button', 'chip' + (state.rankCat === c.id ? ' active' : ''), c.name);
        b.dataset.cat = c.id;
        catChips.appendChild(b);
      });
      view.appendChild(catChips);
    }
    var title = el('div', 'section-title', '排行榜');
    view.appendChild(title);
    var grid = el('div', 'book-grid');
    grid.id = 'rankGrid';
    view.appendChild(grid);
    renderRankGrid(grid);
    if (state.rankHasMore) {
      var more = el('button', 'btn secondary load-more', '加载更多');
      more.id = 'rankMore';
      view.appendChild(more);
    }
  }

  function renderRankGrid(grid) {
    if (state.rankLoading) {
      grid.innerHTML = '';
      grid.appendChild(el('div', 'loading', '加载中…'));
      return;
    }
    if (!state.rankBooks.length) {
      grid.innerHTML = '';
      grid.appendChild(el('div', 'empty', '暂无书籍'));
      return;
    }
    grid.innerHTML = '';
    state.rankBooks.forEach(function (b) {
      var card = el('div', 'book-card');
      card.dataset.bookId = b.bookId;
      var img = el('img', 'cover');
      img.loading = 'lazy';
      if (b.thumbUri) { img.src = b.thumbUri; img.onerror = coverFallback; }
      else img.style.background = 'linear-gradient(135deg,#ff6b3d,#ff3d2e)';
      var info = el('div', 'info');
      info.appendChild(el('div', 'title', b.bookName || '未知书名'));
      info.appendChild(el('div', 'meta', (b.author || '') + (Number(b.readCount) > 0 ? ' · ' + fmtCount(b.readCount) + '人在读' : '')));
      card.appendChild(img);
      card.appendChild(info);
      grid.appendChild(card);
    });
  }

  function loadRank(reset) {
    if (state.rankLoading) return;
    if (reset) { state.rankBooks = []; state.rankOffset = 0; }
    state.rankLoading = true;
    renderView();
    call('rank-list', {
      rankListType: state.rankType,
      categoryId: state.rankCat,
      gender: state.rankGender,
      offset: state.rankOffset,
      limit: 24,
    }).then(function (r) {
      var list = (r && r.book_list) || [];
      state.rankBooks = reset ? list : state.rankBooks.concat(list);
      state.rankOffset = state.rankBooks.length;
      state.rankHasMore = list.length >= 24;
      state.rankLoading = false;
      renderView();
    }).catch(function (e) {
      state.rankLoading = false;
      var grid = $('#rankGrid');
      if (grid) { grid.innerHTML = ''; grid.appendChild(errBox(e.message)); }
    });
  }

  /* ---------------- 搜索 ---------------- */
  function renderSearch(view) {
    var bar = el('div', 'search-bar');
    var input = el('input');
    input.id = 'searchInput';
    input.placeholder = '输入书名 / 作者，回车搜索';
    input.value = state.query;
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') doSearch(true);
    });
    var btn = el('button', 'btn', '搜索');
    btn.addEventListener('click', function () { doSearch(true); });
    bar.appendChild(input);
    bar.appendChild(btn);
    view.appendChild(bar);

    if (state.searching) {
      view.appendChild(el('div', 'loading', '搜索中…'));
      return;
    }
    if (state.searchBooks.length) {
      var list = el('div', 'search-list');
      state.searchBooks.forEach(function (b) {
        var row = el('div', 'row');
        row.dataset.bookId = b.book_id;
        var img = el('img', 'cover');
        if (b.thumb_url) { img.src = b.thumb_url; img.onerror = coverFallback; }
        else img.style.background = 'linear-gradient(135deg,#ff6b3d,#ff3d2e)';
        var right = el('div');
        right.style.flex = '1';
        right.style.minWidth = '0';
        var t = el('div', 't', b.book_name);
        var tags = el('div');
        var st = statusText(b.creation_status);
        if (st) tags.appendChild(el('span', 'tag', st));
        if (b.score) tags.appendChild(el('span', 'tag', '评分 ' + b.score));
        if (b.category) tags.appendChild(el('span', 'tag', b.category));
        var a = el('div', 'a', (b.author || '') + (fmtWord(b.word_number) ? ' · ' + fmtWord(b.word_number) : '') + (b.serial_count ? ' · ' + b.serial_count + '章' : ''));
        right.appendChild(t);
        right.appendChild(tags);
        right.appendChild(a);
        if (b.abstract) right.appendChild(el('div', 'abs', b.abstract));
        row.appendChild(img);
        row.appendChild(right);
        list.appendChild(row);
      });
      view.appendChild(list);
      if (state.searchBooks.length < state.searchTotal) {
        var more = el('button', 'btn secondary load-more', '加载更多');
        more.id = 'searchMore';
        view.appendChild(more);
      }
    } else if (state.query) {
      view.appendChild(el('div', 'empty', '没有找到相关书籍'));
    } else {
      view.appendChild(el('div', 'empty', '输入关键词开始搜索'));
    }
  }

  function doSearch(reset) {
    var input = $('#searchInput');
    if (input) state.query = input.value.trim();
    if (!state.query) return;
    if (reset) { state.searchPage = 0; state.searchBooks = []; }
    state.searching = true;
    renderView();
    call('search', { query: state.query, page: state.searchPage, pageSize: 10 }).then(function (r) {
      state.searchBooks = reset ? r.books : state.searchBooks.concat(r.books);
      state.searchTotal = r.total;
      state.searchPage = reset ? 1 : state.searchPage + 1;
      state.searching = false;
      renderView();
    }).catch(function (e) {
      state.searching = false;
      var view = $('#view');
      if (view) { view.innerHTML = ''; view.appendChild(errBox(e.message)); }
    });
  }

  /* ---------------- 书架 ---------------- */
  // 工具：本地书架按 lastReadAt 倒序（最近阅读的排最前）
  function sortShelfLocal() {
    state.shelfLocal.sort(function (a, b) {
      return (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0);
    });
  }
  function renderShelf(view) {
    state.shelfLoading = true;
    Promise.all([
      call('shelf-local-get', {}),
      call('shelf-remote-get', {}),
    ]).then(function (rs) {
      state.shelfLocal = rs[0] || [];
      // 按最近阅读时间倒序（最近打开的排最前）
      sortShelfLocal();
      state.shelfRemote = (rs[1] && rs[1].entries) || [];
      state.shelfLoading = false;
      view.innerHTML = '';
      var sec = el('div', 'section-title', '本地书架');
      view.appendChild(sec);
      var grid = el('div', 'shelf-grid');
      if (state.shelfLocal.length) {
        state.shelfLocal.forEach(function (it) {
          var item = el('div', 'shelf-item');
          // 整个 .shelf-item 自己就是点击目标（不再依赖子元素选择器）
          item.dataset.bookId = it.bookId;
          item.dataset.itemId = it.lastReadItemId || '';
          item.dataset.action = 'open';
          item.title = '点击继续阅读';
          var img = el('img', 'cover');
          if (it.coverUrl) { img.src = it.coverUrl; img.onerror = coverFallback; }
          else img.style.background = 'linear-gradient(135deg,#ff6b3d,#ff3d2e)';
          var rm = el('button', 'remove', '✕');
          rm.dataset.remove = it.bookId;
          var title = el('div', 'title', it.title || it.bookId);
          if (it.lastReadChapterTitle) {
            var rd = el('div', 'reading', '读到：' + it.lastReadChapterTitle);
            item.appendChild(rm);
            item.appendChild(img);
            item.appendChild(title);
            item.appendChild(rd);
          } else {
            var meta = el('div', 'meta', it.author || '');
            item.appendChild(rm);
            item.appendChild(img);
            item.appendChild(title);
            item.appendChild(meta);
          }
          grid.appendChild(item);
        });
      } else {
        grid.appendChild(el('div', 'empty', '书架为空，在书城或搜索中添加书籍'));
      }
      view.appendChild(grid);
      if (state.loggedIn) {
        view.appendChild(el('div', 'section-title', '云端书架'));
        var grid2 = el('div', 'shelf-grid');
        if (state.shelfRemote.length) {
          state.shelfRemote.forEach(function (it) {
            var item = el('div', 'shelf-item');
            // 整块可点
            item.dataset.bookId = it.book_id;
            item.dataset.itemId = it.last_read_item_id || '';
            item.dataset.action = 'open';
            item.title = '点击继续阅读';
            var img = el('img', 'cover');
            if (it.cover_url) { img.src = it.cover_url; img.onerror = coverFallback; }
            else img.style.background = 'linear-gradient(135deg,#888,#aaa)';
            var t = el('div', 'title', it.title || it.book_id);
            item.appendChild(img);
            item.appendChild(t);
            if (it.current_chapter_title) {
              var rd = el('div', 'reading', '读到：' + it.current_chapter_title);
              item.appendChild(rd);
            } else if (it.author) {
              item.appendChild(el('div', 'meta', it.author));
            }
            grid2.appendChild(item);
          });
        } else {
          grid2.appendChild(el('div', 'empty', '云端书架为空'));
        }
        view.appendChild(grid2);
      } else {
        view.appendChild(el('div', 'section-title', '云端书架'));
        view.appendChild(el('div', 'empty', '登录后可同步云端书架'));
      }
    }).catch(function (e) {
      view.innerHTML = '';
      view.appendChild(errBox(e.message));
    });
  }

  /* ---------------- 登录 / 个人信息 ---------------- */
  function renderLogin(view) {
    var wrap = el('div', 'login-wrap');
    wrap.appendChild(el('h2', null, state.loggedIn ? '个人信息' : '登录番茄小说'));
    if (state.loggedIn && state.user) {
      var card = el('div', 'user-card');
      if (state.user.avatar) {
        var img = el('img');
        img.src = state.user.avatar;
        img.onerror = function () { img.style.display = 'none'; };
        card.appendChild(img);
      }
      var right = el('div');
      right.appendChild(el('div', 'name', state.user.name || '已登录'));
      if (state.user.desc) right.appendChild(el('div', 'desc', state.user.desc));
      card.appendChild(right);
      wrap.appendChild(card);
      var logout = el('button', 'btn secondary', '退出登录');
      logout.id = 'logoutBtn';
      wrap.appendChild(logout);
    } else {
      wrap.appendChild(renderQrLogin());
    }
    view.appendChild(wrap);
    renderHistory(view);
  }

  /* ---------------- 历史记录（本地） ---------------- */
  function renderHistory(view) {
    var sec = el('div', 'history-sec');
    sec.appendChild(el('div', 'section-title', '历史记录'));
    var box = el('div', 'history-list');
    box.id = 'historyList';
    box.appendChild(el('div', 'loading', '加载中…'));
    sec.appendChild(box);
    view.appendChild(sec);
    call('history-get', {}).then(function (items) {
      box.innerHTML = '';
      if (!items || !items.length) {
        box.appendChild(el('div', 'empty', '暂无历史记录，打开一本书开始记录'));
        return;
      }
      // 兜底按 readAt 倒序（防止旧持久化数据顺序错乱）
      items.sort(function (a, b) { return (b.readAt || 0) - (a.readAt || 0); });
      items.forEach(function (h) {
        var row = el('div', 'history-item');
        var img = el('img', 'cover');
        if (h.coverUrl) { img.src = h.coverUrl; img.onerror = coverFallback; }
        else img.style.background = 'linear-gradient(135deg,#ff6b3d,#ff3d2e)';
        var info = el('div', 'hi-info');
        info.appendChild(el('div', 'title', h.title || h.bookId));
        if (h.chapterTitle) info.appendChild(el('div', 'chap', '读到：' + h.chapterTitle));
        else if (h.author) info.appendChild(el('div', 'meta', h.author));
        var time = el('div', 'time', fmtTime(h.readAt));
        row.appendChild(img);
        row.appendChild(info);
        row.appendChild(time);
        row.dataset.bookId = h.bookId;
        row.dataset.itemId = h.itemId || '';
        box.appendChild(row);
      });
    }).catch(function (e) {
      box.innerHTML = '';
      box.appendChild(errBox(e.message));
    });
  }

  /* ---------------- 扫码登录 ---------------- */
  function renderQrLogin() {
    var box = el('div');
    var sub = el('div', 'sub', '使用抖音 / 番茄小说 App 扫码，即可同步书架与阅读进度');
    box.appendChild(sub);
    var qrBox = el('div', 'qr-box');
    qrBox.id = 'qrBox';
    if (state.qrUrl) {
      var img = el('img');
      img.id = 'qrImg';
      img.src = state.qrUrl;
      img.onerror = function () { img.style.display = 'none'; showQrFallback(qrBox); };
      qrBox.appendChild(img);
    } else if (state.qrText) {
      renderQrText(qrBox, state.qrText);
    } else {
      qrBox.appendChild(el('div', 'placeholder', '点击下方按钮生成二维码'));
    }
    box.appendChild(qrBox);
    var status = el('div', 'qr-status' + (state.qrStatusClass ? ' ' + state.qrStatusClass : ''), state.qrStatusText);
    status.id = 'qrStatus';
    box.appendChild(status);
    var actions = el('div');
    var startBtn = el('button', 'btn', state.qrWorking ? '生成中…' : '开始扫码登录');
    startBtn.id = 'qrStart';
    if (state.qrWorking) startBtn.disabled = true;
    var refreshBtn = el('button', 'btn ghost', '刷新二维码');
    refreshBtn.id = 'qrRefresh';
    actions.appendChild(startBtn);
    actions.appendChild(refreshBtn);
    box.appendChild(actions);
    return box;
  }

  function renderQrText(box, text) {
    try {
      if (typeof qrcode !== 'function') throw new Error('no qrcode lib');
      var qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      var img = el('img');
      img.src = qr.createDataURL(8, 8);
      box.appendChild(img);
    } catch (e) {
      box.appendChild(el('div', 'placeholder', '二维码内容：' + text));
    }
  }
  function showQrFallback(box) {
    if (state.qrText) renderQrText(box, state.qrText);
    else {
      box.innerHTML = '';
      box.appendChild(el('div', 'placeholder', '二维码图片加载失败，请刷新'));
    }
  }

  function startQr() {
    state.qrWorking = true;
    state.qrUrl = null;
    state.qrText = null;
    state.qrStatusText = '正在获取二维码…';
    state.qrStatusClass = '';
    renderView();
    call('qr-start', {}).then(function (r) {
      state.qrSession = r.session || (state.qrSession || 0) + 1;
      state.qrWorking = false;
      state.qrUrl = r.qrUrl || null;
      state.qrText = r.qrText || null;
      state.qrStatusText = '请使用抖音 / 番茄小说 App 扫码，并在手机上确认登录';
      renderView();
    }).catch(function (e) {
      state.qrWorking = false;
      state.qrStatusText = e.message;
      state.qrStatusClass = 'err';
      renderView();
    });
  }

  /* ---------------- 书籍详情 ---------------- */
  /** 是否已加书架（任一来源） */
  function isInShelf(bookId) {
    if (!bookId) return false;
    if (state.shelfLocal.some(function (i) { return i.bookId === bookId; })) return true;
    if (state.shelfRemote.some(function (i) { return i.book_id === bookId; })) return true;
    return false;
  }
  /** 根据当前状态刷新指定按钮文案/标题 */
  function applyShelfBtnState(btn, bookId) {
    if (!btn) return;
    var inShelf = isInShelf(bookId);
    btn.dataset.inShelf = inShelf ? '1' : '';
    btn.textContent = inShelf ? '已在书架（点移除）' : '加入书架';
    btn.title = inShelf ? '点击从书架移除' : '加入书架（含云端）';
  }
  /** 异步刷一下云端书架（不阻塞 UI） */
  function refreshShelfRemote() {
    return call('shelf-remote-get', {}).then(function (r) {
      state.shelfRemote = (r && r.entries) || [];
      return state.shelfRemote;
    }).catch(function () { return state.shelfRemote; });
  }
  function showBookModal(bookId) {
    var mask = el('div', 'modal-mask');
    mask.id = 'bookModal';
    var modal = el('div', 'modal');
    modal.appendChild(el('div', 'loading', '加载中…'));
    mask.appendChild(modal);
    document.body.appendChild(mask);
    call('book-detail', { bookId: bookId }).then(function (b) {
      modal.innerHTML = '';
      var top = el('div', 'top');
      var img = el('img', 'cover');
      if (b.thumb_url) { img.src = b.thumb_url; img.onerror = coverFallback; }
      else img.style.background = 'linear-gradient(135deg,#ff6b3d,#ff3d2e)';
      var right = el('div');
      right.style.flex = '1';
      right.style.minWidth = '0';
      right.appendChild(el('div', 'title', b.book_name));
      var meta = el('div', 'meta');
      var st = statusText(b.creation_status);
      var parts = [];
      if (st) parts.push('状态：' + st);
      if (b.author) parts.push('作者：' + b.author);
      if (fmtWord(b.word_number)) parts.push(fmtWord(b.word_number));
      if (b.serial_count) parts.push(b.serial_count + '章');
      if (b.score) parts.push('评分：' + b.score);
      meta.textContent = parts.join(' · ');
      right.appendChild(meta);
      top.appendChild(img);
      top.appendChild(right);
      modal.appendChild(top);
      if (b.abstract) modal.appendChild(el('div', 'abstract', b.abstract));
      var actions = el('div', 'actions');
      var read = el('button', 'btn', '开始阅读');
      read.id = 'readBtn';
      read.dataset.bookId = b.book_id;
      var shelfBtn = el('button', 'btn secondary', '加入书架');
      shelfBtn.id = 'shelfAddBtn';
      shelfBtn.dataset.bookId = b.book_id;
      applyShelfBtnState(shelfBtn, b.book_id);
      actions.appendChild(read);
      actions.appendChild(shelfBtn);
      modal.appendChild(actions);
      state.bookCoverUrl = b.thumb_url || '';
    }).catch(function (e) {
      modal.innerHTML = '';
      modal.appendChild(errBox(e.message));
    });
  }

  /* ---------------- 阅读器 ---------------- */
  function enterReader(bookId, bookTitle, resumeItemId) {
    state.view = 'reader';
    state.inReader = true;
    state.readerBookId = bookId;
    state.readerBookTitle = bookTitle || state.readerBookTitle || '';
    state.chapter = null;
    state.pages = [];
    state.pageIdx = 0;
    state.chapters = [];
    state.chapterIdx = -1;
    state.readerError = null;
    state.drawer = null;
    state.settingsOpen = false;
    render();
    // 异步刷新云端书架，确保阅读器顶栏按钮状态最新
    refreshShelfRemote().catch(function () { /* ignore */ });
    // 加载目录
    call('directory', { bookId: bookId }).then(async function (d) {
      state.directory = d;
      var chapters = [];
      (d.volumes || []).forEach(function (v) {
        (v.chapters || []).forEach(function (c) {
          c.volume_name = v.volume_name;
          chapters.push(c);
        });
      });
      if (!chapters.length) {
        (d.allItemIds || []).forEach(function (id, i) { chapters.push({ itemId: id, title: '第' + (i + 1) + '章' }); });
      }
      state.chapters = chapters;
      // 刷新本地书架，保证续读数据最新
      try {
        var freshShelf = await call('shelf-local-get', {});
        state.shelfLocal = freshShelf || [];
        sortShelfLocal();
      } catch (e) { /* 失败继续用旧数据 */ }
      // 恢复进度：历史续读优先，其次本地书架，再本地历史记录
      var resume = null;
      if (resumeItemId) {
        var hidx = chapters.findIndex(function (c) { return c.itemId === resumeItemId; });
        if (hidx >= 0) resume = { idx: hidx, itemId: resumeItemId };
      }
      if (!resume) {
        var shelfItem = state.shelfLocal.find(function (i) { return i.bookId === bookId; });
        if (shelfItem && shelfItem.lastReadItemId) {
          var idx = chapters.findIndex(function (c) { return c.itemId === shelfItem.lastReadItemId; });
          if (idx >= 0) resume = { idx: idx, itemId: shelfItem.lastReadItemId };
        }
      }
      if (!resume) {
        try {
          var hist = await call('history-get', {});
          var h = (hist || []).find(function (x) { return x.bookId === bookId; });
          if (h && h.itemId) {
            var hidx2 = chapters.findIndex(function (c) { return c.itemId === h.itemId; });
            if (hidx2 >= 0) resume = { idx: hidx2, itemId: h.itemId };
          }
        } catch (e) { /* 可选兜底 */ }
      }
      if (resume) {
        state.chapterIdx = resume.idx;
        openChapter(resume.itemId, resume.idx, false);
      } else if (chapters.length) {
        state.chapterIdx = 0;
        openChapter(chapters[0].itemId, 0, false);
      } else {
        state.readerError = '目录为空';
        renderReader();
      }
    }).catch(function (e) {
      state.readerError = e.message;
      renderReader();
    });
  }

  var chapterCache = new Map();

  function openChapter(itemId, idx, needRender) {
    state.readerLoading = true;
    state.readerError = null;
    // 抽屉打开时不要 renderReader（避免抽屉闪烁/重画）
    if (needRender !== false && !state.drawer && !state.settingsOpen) renderReader();
    else renderPage();
    var cached = chapterCache.get(itemId);
    var p = cached ? Promise.resolve(cached) : call('chapter', { itemId: itemId }).then(function (c) {
      chapterCache.set(itemId, c);
      return c;
    });
    p.then(function (c) {
      state.chapter = c;
      if (idx >= 0) state.chapterIdx = idx;
      state.pages = paginate(c.paragraphs || []);
      state.pageIdx = 0;
      state.readerLoading = false;
      saveReadingProgress(c);
      // 数据就绪：重建 reader 重画顶栏章节名 + 进度条；如果抽屉开着就只更新 chrome
      if (state.drawer || state.settingsOpen) {
        // 取消挂载抽屉的 rAF（避免重复挂载）
        if (state._syncDrawersRaf) { cancelAnimationFrame(state._syncDrawersRaf); state._syncDrawersRaf = 0; }
        updateReaderChrome();
        renderPage();
      } else {
        renderReader();
      }
      prefetchNext(c);
    }).catch(function (e) {
      state.readerLoading = false;
      state.readerError = e.message;
      if (state.drawer || state.settingsOpen) {
        // 错误也只更新 chrome（不重画整页避免抽屉闪烁）
        var errEl = document.getElementById('readerLoading');
        if (errEl) errEl.remove();
        var content = document.getElementById('readerContent');
        if (content) {
          var oldErr = content.querySelector('.reader-loading');
          if (oldErr) oldErr.remove();
          var eb = errBox(e.message);
          eb.className = 'err-box reader-loading';
          eb.style.position = 'absolute';
          content.appendChild(eb);
        }
      } else {
        renderReader();
      }
    });
  }

  // 翻章/翻页后更新顶栏章节名 + 目录高亮（不重建 reader，不重画抽屉）
  function updateReaderChrome() {
    var bar = document.getElementById('readerBar');
    if (bar) {
      var bt = bar.querySelector('.bt');
      var bs = bar.querySelector('.bs');
      var chapTitle = (state.chapter && state.chapter.title) || state.readerBookTitle || '加载中…';
      if (bt) bt.textContent = chapTitle;
      if (bs) {
        var sub = (state.readerBookTitle || '') +
          (state.chapter && state.chapter.realChapterOrder ? ' · 第' + state.chapter.realChapterOrder + '章' : '') +
          (state.chapter && state.chapter.chapterWordNumber ? ' · ' + fmtWord(state.chapter.chapterWordNumber) : '');
        bs.textContent = sub;
      }
    }
    // 目录抽屉当前章节高亮
    var drawer = document.getElementById('catalogDrawer');
    if (drawer && state.chapter) {
      var cur = state.chapter.itemId;
      var chaps = drawer.querySelectorAll('.chap');
      chaps.forEach(function (n) { n.classList.toggle('active', n.dataset.itemId === cur); });
    }
  }

  function prefetchNext(c) {
    if (c && c.nextItemId && !chapterCache.has(c.nextItemId)) {
      setTimeout(function () {
        call('chapter', { itemId: c.nextItemId }).then(function (nc) { chapterCache.set(nc.itemId, nc); }).catch(function () { /* ignore */ });
      }, 2500);
    }
  }

  function saveReadingProgress(c) {
    if (!state.readerBookId) return;
    var idx = state.shelfLocal.findIndex(function (i) { return i.bookId === state.readerBookId; });
    var cover = state.bookCoverUrl || (idx >= 0 ? state.shelfLocal[idx].coverUrl : '') || '';
    var now = Date.now();
    var item = {
      bookId: state.readerBookId,
      title: state.readerBookTitle || c.bookName || state.readerBookId,
      author: c.author || '',
      coverUrl: cover,
      addedAt: idx >= 0 ? state.shelfLocal[idx].addedAt : now,
      lastReadItemId: c.itemId,
      lastReadChapterTitle: c.title,
      lastReadAt: now,
    };
    if (idx >= 0) {
      // 已存在：更新字段并移到最前
      state.shelfLocal.splice(idx, 1);
    }
    state.shelfLocal.unshift(item);
    // 兜底按 lastReadAt 倒序排（防止存储里的旧数据顺序错乱）
    sortShelfLocal();
    // 同步把排好序的写回后端（保证 shelf-local-get 拿回来顺序一致）
    var sorted = state.shelfLocal.slice();
    call('shelf-local-set', { items: sorted }).catch(function () { /* ignore */ });
    // 记录历史（本地，无需登录）
    call('history-record', {
      bookId: state.readerBookId,
      title: state.readerBookTitle || c.bookName || state.readerBookId,
      author: c.author || '',
      coverUrl: cover,
      itemId: c.itemId,
      chapterTitle: c.title,
      order: Number(c.realChapterOrder || c.order || 0),
    }).catch(function () { /* ignore */ });
    if (state.loggedIn) {
      call('progress-update', {
        bookId: state.readerBookId,
        itemId: c.itemId,
        order: Number(c.realChapterOrder || c.order || 0),
      }).catch(function () { /* ignore */ });
    }
  }

  function renderReader() {
    applySettings();
    // 1.2.2+ 阅读器只保留沉浸式（章节名横条作为最顶栏 + 全屏正文），不再有"完整工具栏"模式
    app.innerHTML = '';

    var reader = el('div', 'reader');
    reader.id = 'reader';
    reader.classList.add('immersive'); // 永远沉浸

    // 最顶栏：返回 + 章节名(居中) + 目录 + 书评 + 加入书架 + 设置
    // 翻页秃瓢放在章节名左右
    var bar = el('div', 'reader-bar minimal');
    bar.id = 'readerBar';
    // 左侧：返回 + 翻页（上章/上页）
    var leftGroup = el('div', 'reader-bar-group');
    var back = el('button', 'reader-bar-icon');
    back.id = 'readerBack';
    back.title = '返回';
    back.textContent = '‹';
    leftGroup.appendChild(back);
    var prevC = el('button', 'reader-bar-icon');
    prevC.id = 'prevChapter';
    prevC.title = '上一章';
    prevC.textContent = '«';
    var prevP = el('button', 'reader-bar-icon');
    prevP.id = 'prevPage';
    prevP.title = '上一页';
    prevP.textContent = '‹';
    leftGroup.appendChild(prevC);
    leftGroup.appendChild(prevP);
    bar.appendChild(leftGroup);
    // 中间：章节名(居中)
    var titles = el('div', 'titles');
    var chapTitle = (state.chapter && state.chapter.title) || state.readerBookTitle || '加载中…';
    titles.appendChild(el('div', 'bt', chapTitle));
    var sub = (state.readerBookTitle || '') +
      (state.chapter && state.chapter.realChapterOrder ? ' · 第' + state.chapter.realChapterOrder + '章' : '') +
      (state.chapter && state.chapter.chapterWordNumber ? ' · ' + fmtWord(state.chapter.chapterWordNumber) : '');
    if (sub) titles.appendChild(el('div', 'bs', sub));
    bar.appendChild(titles);
    // 右侧：翻页（下页/下章）+ 目录 + 书评 + 加入书架 + 设置
    var rightGroup = el('div', 'reader-bar-group');
    var nextP = el('button', 'reader-bar-icon');
    nextP.id = 'nextPage';
    nextP.title = '下一页';
    nextP.textContent = '›';
    var nextC = el('button', 'reader-bar-icon');
    nextC.id = 'nextChapter';
    nextC.title = '下一章';
    nextC.textContent = '»';
    rightGroup.appendChild(nextP);
    rightGroup.appendChild(nextC);
    bar.appendChild(rightGroup);
    var toolGroup = el('div', 'reader-bar-group');
    var catalogBtn = el('button', 'reader-bar-icon');
    catalogBtn.id = 'catalogBtn';
    catalogBtn.title = '目录';
    catalogBtn.textContent = '☰';
    toolGroup.appendChild(catalogBtn);
    var cmtBtn = el('button', 'reader-bar-icon');
    cmtBtn.id = 'bookCommentsBtn';
    cmtBtn.title = '书评';
    cmtBtn.textContent = '💬';
    toolGroup.appendChild(cmtBtn);
    var shelfBtn = el('button', 'reader-bar-icon');
    shelfBtn.id = 'shelfAddInReaderBtn';
    shelfBtn.title = '加入书架（云端）';
    shelfBtn.textContent = '+';
    // 根据当前书架状态初始化（先看本地，云端回来后再补一次）
    if (state.readerBookId && isInShelf(state.readerBookId)) {
      shelfBtn.textContent = '✓';
      shelfBtn.title = '已在书架（点移除）';
      shelfBtn.dataset.inShelf = '1';
    }
    toolGroup.appendChild(shelfBtn);
    // 异步：根据云端结果二次校正（解决"刚加完进 reader 仍显示 +"的问题）
    if (state.readerBookId) {
      var bid = state.readerBookId;
      var shelfBtnRef = shelfBtn;
      var fixBtn = function () {
        var inShelf = isInShelf(bid);
        if (inShelf && shelfBtnRef.dataset.inShelf !== '1') {
          shelfBtnRef.textContent = '✓';
          shelfBtnRef.title = '已在书架（点移除）';
          shelfBtnRef.dataset.inShelf = '1';
        } else if (!inShelf && shelfBtnRef.dataset.inShelf === '1') {
          shelfBtnRef.textContent = '+';
          shelfBtnRef.title = '加入书架（云端）';
          shelfBtnRef.dataset.inShelf = '';
        }
      };
      refreshShelfRemote().then(fixBtn).catch(function () { /* ignore */ });
    }
    var setBtn = el('button', 'reader-bar-icon');
    setBtn.id = 'settingsBtn';
    setBtn.title = '设置';
    setBtn.textContent = '⚙';
    toolGroup.appendChild(setBtn);
    bar.appendChild(toolGroup);

    reader.appendChild(bar);
    var content = el('div', 'reader-content');
    content.id = 'readerContent';
    reader.appendChild(content);
    // 底部页码指示（极小，不占翻页区）
    var pageInfo = el('div', 'reader-pageinfo');
    pageInfo.id = 'pageInfo';
    pageInfo.textContent = '-- / --';
    reader.appendChild(pageInfo);
    app.appendChild(reader);
    renderPage();

    if (state.readerLoading) {
      var ld = el('div', 'reader-loading', '加载中…');
      ld.id = 'readerLoading';
      content.appendChild(ld);
    } else if (state.readerError) {
      var eb = errBox(state.readerError);
      eb.className = 'err-box reader-loading';
      eb.style.position = 'absolute';
      content.appendChild(eb);
    }
    // 抽屉/设置面板独立挂在 document.body，reader 重建不影响
  }

  /** 重新挂载所有开启的抽屉/设置面板（如果被外部移除的话）—— 一般不需要调 */
  function syncDrawers() {
    if (state.drawer === 'catalog' && !document.getElementById('catalogDrawer')) renderCatalogDrawer();
    if (state.drawer === 'comments' && !document.getElementById('commentsDrawer')) renderCommentsDrawer();
    if (state.settingsOpen && !document.getElementById('settingsPop')) renderSettingsPop();
  }

  /** 分页：把段落列表切分为适合一屏的页 */
  function paginate(paragraphs) {
    if (!paragraphs || !paragraphs.length) return [];
    var content = $('#readerContent');
    if (!content) return [paragraphs.map(function (p, i) { return { text: p, idx: i }; })];
    var pageH = content.clientHeight - 22;
    if (pageH < 100) pageH = 400;
    // 测量容器：与真实页同宽同样式
    var wrap = el('div', 'page-wrap');
    wrap.style.position = 'absolute';
    wrap.style.visibility = 'hidden';
    wrap.style.pointerEvents = 'none';
    wrap.style.left = '0';
    wrap.style.right = '0';
    wrap.style.top = '0';
    var page = el('div', 'page');
    page.style.minHeight = '0';
    page.style.height = 'auto';
    wrap.appendChild(page);
    content.appendChild(wrap);

    var paras = paragraphs.map(function (t, i) { return { text: t, idx: i }; });
    var pages = [];
    var fits = function (list) {
      page.innerHTML = '';
      list.forEach(function (p) {
        var pe = el('p', 'para-click');
        pe.textContent = p.text;
        page.appendChild(pe);
      });
      return page.scrollHeight <= pageH;
    };
    var fitsChar = function (text) {
      page.innerHTML = '';
      var pe = el('p', 'para-click');
      pe.textContent = text;
      page.appendChild(pe);
      return page.scrollHeight <= pageH;
    };
    var i = 0;
    var n = paras.length;
    while (i < n) {
      var lo = i + 1, hi = n, best = i;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (fits(paras.slice(i, mid))) { best = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (best > i) {
        pages.push(paras.slice(i, best));
        i = best;
      } else {
        // 单个段落超长：按字符切分
        var text = paras[i].text;
        var idx = paras[i].idx;
        var start = 0;
        while (start < text.length) {
          var a = start + 1, b = text.length, bestC = start;
          while (a <= b) {
            var midc = (a + b) >> 1;
            if (fitsChar(text.slice(start, midc))) { bestC = midc; a = midc + 1; }
            else b = midc - 1;
          }
          if (bestC <= start) bestC = start + 1;
          pages.push([{ text: text.slice(start, bestC), idx: idx }]);
          start = bestC;
        }
        i++;
      }
    }
    wrap.remove();
    return pages;
  }

  function renderPage() {
    var content = $('#readerContent');
    if (!content) return;
    // 清除非页面元素
    $$('.page-wrap', content).forEach(function (w) { w.remove(); });
    $$('.reader-loading', content).forEach(function (w) { w.remove(); });
    var pages = state.pages;
    if (!pages.length) {
      var eb = errBox('章节内容为空');
      eb.className = 'err-box reader-loading';
      eb.style.position = 'absolute';
      content.appendChild(eb);
      return;
    }
    var pIdx = Math.max(0, Math.min(state.pageIdx, pages.length - 1));
    state.pageIdx = pIdx;
    var wrap = el('div', 'page-wrap');
    wrap.id = 'pageWrap';
    var page = el('div', 'page');
    var cur = pages[pIdx] || [];
    cur.forEach(function (p) {
      var pe = el('p', 'para-click');
      pe.textContent = p.text;
      pe.dataset.paraIdx = String(p.idx);
      page.appendChild(pe);
    });
    wrap.appendChild(page);
    content.appendChild(wrap);
    wrap.scrollTop = 0;
    var info = $('#pageInfo');
    if (info) info.textContent = (pIdx + 1) + ' / ' + pages.length;
  }

  function navPage(delta) {
    if (state.readerLoading || !state.pages.length) return;
    var next = state.pageIdx + delta;
    if (next < 0) {
      prevChapter();
      return;
    }
    if (next >= state.pages.length) {
      nextChapter();
      return;
    }
    state.pageIdx = next;
    renderPage();
  }

  function prevChapter() {
    if (state.chapterIdx > 0 && state.chapters.length) {
      state.chapterIdx--;
      openChapter(state.chapters[state.chapterIdx].itemId, state.chapterIdx);
    } else if (state.chapter && state.chapter.preItemId) {
      openChapter(state.chapter.preItemId, -1);
    }
  }

  function nextChapter() {
    if (state.chapterIdx >= 0 && state.chapterIdx < state.chapters.length - 1) {
      state.chapterIdx++;
      openChapter(state.chapters[state.chapterIdx].itemId, state.chapterIdx);
    } else if (state.chapter && state.chapter.nextItemId) {
      openChapter(state.chapter.nextItemId, -1);
    }
  }

  /* ---------------- 目录抽屉 ---------------- */
  // 抽屉挂到 document.body —— reader 重建不重画，render() 重建也不重画，绝对不"刷新"
  function renderCatalogDrawer() {
    var drawer = el('div', 'drawer');
    drawer.id = 'catalogDrawer';
    var head = el('div', 'drawer-head');
    head.appendChild(el('span', null, '目录（' + (state.chapters.length || 0) + '章）'));
    var close = el('button', null, '✕');
    close.id = 'closeDrawer';
    head.appendChild(close);
    drawer.appendChild(head);
    var body = el('div', 'drawer-body');
    var vols = state.directory ? state.directory.volumes : [];
    if (vols.length) {
      vols.forEach(function (v) {
        body.appendChild(el('div', 'volume', v.volume_name || '正文'));
        v.chapters.forEach(function (c) {
          var d = el('div', 'chap' + (c.itemId === (state.chapter && state.chapter.itemId) ? ' active' : ''),
            (c.needPay ? '🔒 ' : '') + c.title);
          d.dataset.itemId = c.itemId;
          body.appendChild(d);
        });
      });
    } else {
      state.chapters.forEach(function (c) {
        var d = el('div', 'chap' + (c.itemId === (state.chapter && state.chapter.itemId) ? ' active' : ''), c.title);
        d.dataset.itemId = c.itemId;
        body.appendChild(d);
      });
    }
    drawer.appendChild(body);
    document.body.appendChild(drawer);
    requestAnimationFrame(function () { drawer.classList.add('open'); });
  }

  /* ---------------- 书评 ---------------- */
  // 缓存已加载过的评论（按 bookId 索引），避免重复打开时重新拉取
  var _commentsCache = Object.create(null);
  function loadBookComments(force) {
    var bookId = state.readerBookId;
    if (!force && _commentsCache[bookId] && !_commentsCache[bookId].loading) {
      state.comments = _commentsCache[bookId].comments || [];
      state.commentsLoading = false;
      state.commentsError = _commentsCache[bookId].error || null;
      renderCommentsDrawer();
      return;
    }
    _commentsCache[bookId] = { loading: true, comments: [], error: null };
    state.commentsLoading = true;
    state.commentsError = null;
    renderCommentsDrawer();
    var p = call('book-comments', { bookId: bookId, limit: 12 });
    p.then(function (r) {
      state.comments = (r && r.comments) || [];
      state.commentsLoading = false;
      _commentsCache[bookId] = { loading: false, comments: state.comments, error: null };
      renderCommentsDrawer();
    }).catch(function (e) {
      state.commentsLoading = false;
      state.commentsError = e.message;
      _commentsCache[bookId] = { loading: false, comments: state.comments, error: e.message };
      renderCommentsDrawer();
    });
  }

  function renderCommentsDrawer() {
    var old = $('#commentsDrawer');
    if (old) old.remove();
    var drawer = el('div', 'drawer comment-drawer');
    drawer.id = 'commentsDrawer';
    var head = el('div', 'drawer-head');
    head.appendChild(el('span', null, '书评'));
    var close = el('button', null, '✕');
    close.id = 'closeDrawer';
    head.appendChild(close);
    drawer.appendChild(head);
    var body = el('div', 'drawer-body');
    if (state.commentsLoading) {
      body.appendChild(el('div', 'loading', '加载评论中…'));
    } else if (state.commentsError) {
      var eb = errBox(state.commentsError);
      body.appendChild(eb);
    } else if (!state.comments.length) {
      body.appendChild(el('div', 'empty', '暂无评论'));
    } else {
      state.comments.forEach(function (c) {
        var item = el('div', 'comment-item');
        var head2 = el('div', 'c-head');
        if (c.avatar) {
          var av = el('img', 'c-avatar');
          av.src = c.avatar;
          av.onerror = function () { av.style.display = 'none'; };
          head2.appendChild(av);
        }
        head2.appendChild(el('span', 'c-name', c.nick_name || '匿名'));
        head2.appendChild(el('span', 'c-time', fmtTime(c.create_time)));
        item.appendChild(head2);
        item.appendChild(el('div', 'c-text', c.text));
        var stat = [];
        if (c.book_title) stat.push('评论《' + c.book_title + '》');
        if (c.score) stat.push('评分 ' + c.score);
        if (c.digg_count) stat.push('👍 ' + fmtCount(c.digg_count));
        if (c.reply_count) stat.push('💬 ' + fmtCount(c.reply_count));
        if (stat.length) item.appendChild(el('div', 'c-stat', stat.join(' · ')));
        body.appendChild(item);
      });
    }
    drawer.appendChild(body);
    document.body.appendChild(drawer);
    requestAnimationFrame(function () { drawer.classList.add('open'); });
  }

  /* ---------------- 设置 ---------------- */
  function renderSettingsPop() {
    var old = $('#settingsPop');
    if (old) old.remove();
    var pop = el('div', 'settings-pop');
    pop.id = 'settingsPop';
    var s = state.settings;
    var row1 = el('div', 'row');
    row1.appendChild(el('span', null, '字号'));
    var fs = el('input');
    fs.type = 'range';
    fs.min = '13';
    fs.max = '28';
    fs.step = '1';
    fs.value = String(s.fontSize);
    fs.id = 'fontSizeRange';
    row1.appendChild(fs);
    pop.appendChild(row1);
    var row2 = el('div', 'row');
    row2.appendChild(el('span', null, '行距'));
    var lh = el('input');
    lh.type = 'range';
    lh.min = '1.4';
    lh.max = '2.6';
    lh.step = '0.1';
    lh.value = String(s.lineHeight);
    lh.id = 'lineHeightRange';
    row2.appendChild(lh);
    pop.appendChild(row2);
    var row3 = el('div', 'row');
    row3.appendChild(el('span', null, '主题'));
    var sw = el('div', 'theme-switch');
    [['sepia', '羊皮纸'], ['day', '白天'], ['night', '夜间']].forEach(function (t) {
      var c = el('button', 'chip' + (s.theme === t[0] ? ' active' : ''), t[1]);
      c.dataset.theme = t[0];
      sw.appendChild(c);
    });
    row3.appendChild(sw);
    pop.appendChild(row3);
    var hint = el('div', 'key-hint', '键盘：←/→ 翻页 · Ctrl+←/→ 切换章节 · 点击正文：左 30% 上一页 / 右 30% 下一页');
    pop.appendChild(hint);
    document.body.appendChild(pop);
  }

  /* ---------------- 事件委托 ---------------- */
  function removeReaderOverlays() {
    ['#catalogDrawer', '#commentsDrawer', '#settingsPop'].forEach(function (sel) {
      var e = $(sel);
      if (e) e.remove();
    });
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    // 调试日志：点中 .shelf-item / .history-item / #readerContent 时输出
    try {
      if (t && t.closest) {
        if (t.closest('.shelf-item')) console.log('[fanqie] click shelf-item, view=', state.view, 'bookId=', t.closest('.shelf-item').dataset && t.closest('.shelf-item').dataset.bookId);
        if (t.closest('.history-item')) console.log('[fanqie] click history-item, view=', state.view, 'bookId=', t.closest('.history-item').dataset && t.closest('.history-item').dataset.bookId);
        if (t.closest('#readerContent')) console.log('[fanqie] click readerContent');
      }
    } catch (e) {}
    var nav = t.closest ? t.closest('[data-nav]') : null;
    if (nav) {
      var target = nav.dataset.nav;
      if (target === 'login') {
        state.view = 'login';
        render();
        return;
      }
      if (state.view === 'reader' && target !== 'bookstore') {
        // 阅读器内切换到其他视图
        state.inReader = false;
        state.view = target;
        render();
        return;
      }
      state.view = target;
      // 用 render() 全量重建（含 navbar），保证选中状态同步切换
      render();
      if (target === 'shelf') renderShelf($('#view'));
      if (target === 'bookstore' && !state.rankBooks.length && !state.rankLoading) loadRank(true);
      return;
    }
    var gender = t.closest ? t.closest('[data-gender]') : null;
    if (gender) {
      state.rankGender = gender.dataset.gender;
      state.rankCat = '';
      loadRank(true);
      return;
    }
    var rankType = t.closest ? t.closest('[data-rankType]') : null;
    if (rankType) {
      state.rankType = Number(rankType.dataset.rankType);
      loadRank(true);
      return;
    }
    var cat = t.closest ? t.closest('[data-cat]') : null;
    if (cat) {
      state.rankCat = cat.dataset.cat;
      loadRank(true);
      return;
    }
    var more = t.closest ? t.closest('#rankMore') : null;
    if (more) { loadRank(false); return; }
    var searchMore = t.closest ? t.closest('#searchMore') : null;
    if (searchMore) { doSearch(false); return; }
    var card = t.closest ? t.closest('.book-card') : null;
    if (card) {
      if (IS_SIDEBAR) { openBookInEditor(card.dataset.bookId); } else { showBookModal(card.dataset.bookId); }
      return;
    }
    var row = t.closest ? t.closest('.search-list .row') : null;
    if (row) {
      if (IS_SIDEBAR) { openBookInEditor(row.dataset.bookId); } else { showBookModal(row.dataset.bookId); }
      return;
    }
    // 书架：.shelf-item 整块可点（沉浸下也要可读）
    var shelfItem = t.closest ? t.closest('.shelf-item') : null;
    if (shelfItem && state.view === 'shelf') {
      // 删除按钮优先
      if (t.closest && t.closest('[data-remove]')) {
        ev.stopPropagation();
        var rb = t.closest('[data-remove]');
        call('shelf-remove', { bookId: rb.dataset.remove }).then(function () {
          state.shelfLocal = state.shelfLocal.filter(function (i) { return i.bookId !== rb.dataset.remove; });
          renderShelf($('#view'));
          refreshShelfRemote().catch(function () { /* ignore */ });
        });
        return;
      }
      var bookId = shelfItem.dataset.bookId;
      var resumeId = shelfItem.dataset.itemId || '';
      if (IS_SIDEBAR) { openBookInEditor(bookId, resumeId); return; }
      var local = state.shelfLocal.find(function (i) { return i.bookId === bookId; });
      enterReader(bookId, local ? local.title : bookId, resumeId);
      return;
    }
    // 历史记录：点击条目续读
    var histItem = t.closest ? t.closest('.history-item') : null;
    if (histItem && state.view === 'login') {
      var hBookId = histItem.dataset.bookId;
      var hItemId = histItem.dataset.itemId;
      if (IS_SIDEBAR) {
        openBookInEditor(hBookId, hItemId);
      } else {
        enterReader(hBookId, '', hItemId);
      }
      return;
    }
    // 书籍弹窗
    if (t.id === 'readBtn') {
      document.getElementById('bookModal') && document.getElementById('bookModal').remove();
      if (IS_SIDEBAR) {
        openBookInEditor(t.dataset.bookId);
      } else {
        enterReader(t.dataset.bookId, '');
      }
      return;
    }
    if (t.id === 'shelfAddBtn') {
      var sb = t;
      var bookId = sb.dataset.bookId;
      var inShelf = sb.dataset.inShelf === '1';
      sb.disabled = true;
      var orig = sb.textContent;
      sb.textContent = inShelf ? '移除中…' : '添加中…';
      var p = inShelf
        ? call('shelf-remove', { bookId: bookId }).then(function () { return { removed: true }; })
        : call('shelf-add', { bookId: bookId });
      p.then(function (r) {
        if (r && r.removed) {
          // remove 后端不返回 local 数组，前端自己改
          state.shelfLocal = state.shelfLocal.filter(function (i) { return i.bookId !== bookId; });
          sortShelfLocal();
        } else {
          // add 后端只返回计数，不返回 local 内容；为防止状态错位，强制重拉 local
          return call('shelf-local-get', {}).then(function (fresh) {
            state.shelfLocal = fresh || [];
            sortShelfLocal();
          });
        }
      }).then(function () {
        // 无论 add/remove 都再刷一次云端，避免状态错位
        return refreshShelfRemote();
      }).then(function (remote) {
        var nowIn = state.shelfLocal.some(function (i) { return i.bookId === bookId; })
          || remote.some(function (i) { return i.book_id === bookId; });
        sb.dataset.inShelf = nowIn ? '1' : '';
        sb.textContent = nowIn ? '已在书架（点移除）' : '加入书架';
        sb.title = nowIn ? '点击从书架移除' : '加入书架（含云端）';
      }).catch(function (e) {
        sb.textContent = (inShelf ? '移除失败：' : '添加失败：') + e.message;
      }).then(function () {
        setTimeout(function () { try { sb.disabled = false; } catch (e) {} }, 600);
      });
      return;
    }
    var modalMask = t.closest ? t.closest('#bookModal') : null;
    if (modalMask && t === modalMask) modalMask.remove();

    // 阅读器
    if (state.view === 'reader') {
      // 抽屉/设置面板关闭按钮
      if (t.id === 'closeDrawer') {
        state.drawer = null;
        state.settingsOpen = false;
        removeReaderOverlays();
        return;
      }
      // 目录抽屉内点击章节项：跳转章节
      var chap = t.closest ? t.closest('.drawer .chap') : null;
      if (chap) {
        var itemId = chap.dataset.itemId;
        var idx = state.chapters.findIndex(function (c) { return c.itemId === itemId; });
        state.chapterIdx = idx;
        state.drawer = null;
        state.pageIdx = 0;
        openChapter(itemId, idx);
        return;
      }
      // 抽屉/设置面板内的其他点击：早返回（不触发翻页/重渲染）
      if (t.closest && (t.closest('#commentsDrawer') || t.closest('#catalogDrawer') || t.closest('#settingsPop'))) {
        return;
      }
      if (t.id === 'readerBack') {
        state.inReader = false;
        state.view = 'bookstore';
        render();
        if (!state.rankBooks.length && !state.rankLoading) loadRank(true);
        return;
      }
      if (t.id === 'catalogBtn') {
        // 局部开合目录抽屉（抽屉挂在 document.body，reader 重建不影响）
        if (state.drawer === 'catalog') { state.drawer = null; removeReaderOverlays(); }
        else {
          state.drawer = 'catalog';
          state.settingsOpen = false;
          removeReaderOverlays();
          renderCatalogDrawer();
        }
        return;
      }
      if (t.id === 'bookCommentsBtn') {
        // 局部开合书评抽屉（不重复加载：复用缓存）
        if (state.drawer === 'comments') { state.drawer = null; removeReaderOverlays(); }
        else {
          state.drawer = 'comments';
          state.settingsOpen = false;
          removeReaderOverlays();
          // 直接从缓存渲染（不重置已有评论）
          var cached = _commentsCache[state.readerBookId];
          if (cached && !cached.loading) {
            state.comments = cached.comments || [];
            state.commentsLoading = false;
            state.commentsError = cached.error || null;
          } else {
            state.comments = [];
            state.commentsLoading = true;
            state.commentsError = null;
          }
          renderCommentsDrawer();
          loadBookComments(false);
        }
        return;
      }
      if (t.id === 'settingsBtn') {
        // 局部开合设置面板（设置面板挂在 document.body）
        if (state.settingsOpen) { state.settingsOpen = false; removeReaderOverlays(); }
        else {
          state.settingsOpen = true;
          state.drawer = null;
          removeReaderOverlays();
          renderSettingsPop();
        }
        return;
      }
      if (t.id === 'shelfAddInReaderBtn') {
        // 阅读器内：toggle 加入/移除云端书架
        var b = state.readerBookId;
        if (!b) return;
        var bk = t;
        var inShelf = isInShelf(b);
        bk.disabled = true;
        bk.textContent = '…';
        var p = inShelf
          ? call('shelf-remove', { bookId: b }).then(function () {
              state.shelfLocal = state.shelfLocal.filter(function (i) { return i.bookId !== b; });
              sortShelfLocal();
              return { removed: true };
            })
          : call('shelf-add', { bookId: b });
        p.then(function (r) {
          if (!r || !r.removed) {
            // add 成功后端不返回 local 数组，强制重拉
            return call('shelf-local-get', {}).then(function (fresh) {
              state.shelfLocal = fresh || [];
              sortShelfLocal();
            });
          }
        }).then(function () {
          return refreshShelfRemote();
        }).then(function (remote) {
          var nowIn = state.shelfLocal.some(function (i) { return i.bookId === b; })
            || remote.some(function (i) { return i.book_id === b; });
          bk.dataset.inShelf = nowIn ? '1' : '';
          bk.textContent = nowIn ? '✓' : '+';
          bk.title = nowIn ? '已在书架（点移除）' : '加入书架（云端）';
        }).catch(function (e) {
          bk.textContent = inShelf ? '−' : '+';
          bk.title = (inShelf ? '移除失败：' : '加入失败：') + e.message;
        }).then(function () {
          setTimeout(function () { try { bk.disabled = false; } catch (e) {} }, 800);
        });
        return;
      }
      if (t.id === 'closeDrawer') {
        state.drawer = null;
        state.settingsOpen = false;
        removeReaderOverlays();
        return;
      }
      var chap = t.closest ? t.closest('.drawer .chap') : null;
      if (chap) {
        var itemId = chap.dataset.itemId;
        var idx = state.chapters.findIndex(function (c) { return c.itemId === itemId; });
        state.chapterIdx = idx;
        state.drawer = null;
        state.pageIdx = 0;
        openChapter(itemId, idx);
        return;
      }
      if (t.id === 'prevPage') { navPage(-1); return; }
      if (t.id === 'nextPage') { navPage(1); return; }
      if (t.id === 'prevChapter') { prevChapter(); return; }
      if (t.id === 'nextChapter') { nextChapter(); return; }
      var themeChip = t.closest ? t.closest('[data-theme]') : null;
      if (themeChip) {
        state.settings.theme = themeChip.dataset.theme;
        saveSettings();
        renderReader();
        return;
      }
      // 点击正文：左右两侧翻页（沉浸式快速翻页）
      // 委托到 #readerContent：点中正文（无论 .page-wrap / .page / .para-click）即触发
      // 沉浸模式无"中间切工具栏"——中间点击无副作用
      var bodyArea = t.closest ? (t.closest('#readerContent') || t.closest('.page-wrap') || t.closest('.page') || t.closest('.para-click')) : null;
      if (bodyArea && !t.closest('.drawer') && !t.closest('.settings-pop') && !t.closest('.reader-bar') && !t.closest('.reader-footer')) {
        var rect = bodyArea.getBoundingClientRect();
        var x = ev.clientX - rect.left;
        var w = rect.width || 1;
        if (x < w * 0.3) { navPage(-1); return; }
        if (x > w * 0.7) { navPage(1); return; }
        return; // 中间区域：无操作
      }
    }

    // 登录
    if (t.id === 'qrStart') { startQr(); return; }
    if (t.id === 'qrRefresh') { startQr(); return; }
    // 登录
    if (t.id === 'logoutBtn') {
      call('logout', {}).then(function () {
        state.user = null;
        state.loggedIn = false;
        render();
      });
      return;
    }
  });

  // 设置控件 & 登录输入
  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (t.id === 'fontSizeRange') {
      state.settings.fontSize = Number(t.value);
      saveSettings();
      if (state.view === 'reader') {
        // 只更新字体与分页，不重建阅读器（避免面板闪烁）
        applySettings();
        rePaginate();
      }
    }
    if (t.id === 'lineHeightRange') {
      state.settings.lineHeight = Number(t.value);
      saveSettings();
      if (state.view === 'reader') {
        applySettings();
        rePaginate();
      }
    }
  });

  function saveSettings() {
    call('settings-set', { settings: state.settings }).catch(function () { /* ignore */ });
  }

  // 键盘
  document.addEventListener('keydown', function (ev) {
    if (state.view !== 'reader') return;
    if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;
    var ctrl = ev.ctrlKey || ev.metaKey;
    if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') { ev.preventDefault(); navPage(-1); }
    else if (ev.key === 'ArrowRight' || ev.key === 'PageDown' || ev.key === ' ') { ev.preventDefault(); navPage(1); }
    else if (ev.key === 'Home') { ev.preventDefault(); state.pageIdx = 0; renderPage(); }
    else if (ev.key === 'End') { ev.preventDefault(); state.pageIdx = state.pages.length - 1; renderPage(); }
    else if (ctrl && ev.key === 'ArrowLeft') { ev.preventDefault(); prevChapter(); }
    else if (ctrl && ev.key === 'ArrowRight') { ev.preventDefault(); nextChapter(); }
    else if (ev.key === 'Escape') {
      if (state.drawer || state.settingsOpen) {
        state.drawer = null;
        state.settingsOpen = false;
        removeReaderOverlays();
      }
    }
  });

  /* ---------------- 消息监听 ---------------- */
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m) return;
    if (m.type === 'resp') {
      var p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        if (m.ok) p.resolve(m.data);
        else p.reject(new Error(m.error || '未知错误'));
      }
      return;
    }
    if (m.type === 'init') {
      state.user = m.user;
      state.loggedIn = !!m.loggedIn;
      if (m.settings) state.settings = Object.assign(state.settings, m.settings);
      state.view = state.view || 'bookstore';
      render();
      if (state.view === 'bookstore' && !state.rankBooks.length && !state.rankLoading) loadRank(true);
      return;
    }
    if (m.type === 'nav') {
      state.view = m.view;
      state.inReader = false;
      render();
      if (m.view === 'bookstore' && !state.rankBooks.length && !state.rankLoading) loadRank(true);
      if (m.view === 'shelf') renderShelf($('#view'));
      return;
    }
    if (m.type === 'login-changed') {
      state.user = m.user;
      state.loggedIn = !!m.loggedIn;
      saveState();
      render();
      if (state.view === 'shelf') renderShelf($('#view'));
      return;
    }
    if (m.type === 'qr-status') {
      // 只接受当前会话的状态
      if (m.session !== undefined && m.session !== state.qrSession) return;
      var s = m.status || {};
      state.qrStatusText = s.message || '';
      state.qrStatusClass = s.stage === 'success' ? 'ok' : (s.stage === 'error' ? 'err' : '');
      if (s.stage === 'waiting' && s.qrUrl && !state.qrUrl) {
        state.qrUrl = s.qrUrl;
        state.qrText = s.qrText || state.qrText;
      }
      if (state.view === 'login') {
        var statusEl = $('#qrStatus');
        if (statusEl) {
          statusEl.textContent = state.qrStatusText;
          statusEl.className = 'qr-status' + (state.qrStatusClass ? ' ' + state.qrStatusClass : '');
        }
        if (s.stage === 'success') {
          // 登录完成会收到 login-changed，这里只更新提示
          state.qrWorking = false;
        }
      }
      return;
    }
    if (m.type === 'open-book') {
      showBookModal(m.bookId);
      return;
    }
    if (m.type === 'open-book-reader') {
      // 侧边栏/命令请求：直接在阅读器中打开书籍（itemId 可选：续读历史章节）
      if (IS_SIDEBAR) {
        // 侧边栏收到此消息说明面板已打开，这里无操作（面板处理）
      } else {
        enterReader(m.bookId, '', m.itemId || '');
      }
      return;
    }
  });

  /* ---------------- 工具 ---------------- */
  function errBox(message) {
    var box = el('div', 'err-box');
    box.textContent = message || '操作失败';
    return box;
  }

  function refreshShelfCache() {
    call('shelf-local-get', {}).then(function (items) {
      state.shelfLocal = items || [];
      sortShelfLocal();
    }).catch(function () { /* ignore */ });
  }

  // 重新分页（按当前容器尺寸重算，state.pageIdx 尽量保持在原章节内同一相对位置）
  function rePaginate() {
    if (!state.chapter) return;
    var oldPages = state.pages;
    var oldPageIdx = state.pageIdx;
    state.pages = paginate(state.chapter.paragraphs || []);
    if (!state.pages.length) { state.pageIdx = 0; renderPage(); return; }
    // 按"段落在全书中的累计位置"折算新页：找到旧页里第一个段落 idx，再在新页里定位到包含同一 idx 的页
    var keepIdx = oldPageIdx;
    if (oldPages.length && oldPages[oldPageIdx] && oldPages[oldPageIdx][0]) {
      var anchorPara = oldPages[oldPageIdx][0].idx;
      for (var i = 0; i < state.pages.length; i++) {
        if (state.pages[i].some(function (p) { return p.idx === anchorPara; })) {
          keepIdx = i; break;
        }
      }
    }
    state.pageIdx = Math.max(0, Math.min(keepIdx, state.pages.length - 1));
    renderPage();
  }

  // 初始渲染
  applySettings();
  render();
  // 窗口尺寸变化时（webview 高度可能因为编辑器拖拽、侧边栏显隐、状态栏高度等变化）重新分页
  var _resizeRaf = 0;
  function _onResize() {
    if (_resizeRaf) return;
    _resizeRaf = requestAnimationFrame(function () {
      _resizeRaf = 0;
      if (state.view === 'reader' && state.chapter) rePaginate();
    });
  }
  window.addEventListener('resize', _onResize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', _onResize);
  }
  call('login-status', {}).then(function (r) {
    state.user = r.user;
    state.loggedIn = !!r.loggedIn;
    render();
    if (state.view === 'bookstore' && !state.rankBooks.length && !state.rankLoading) loadRank(true);
  }).catch(function () { /* ignore */ });
  call('settings-get', {}).then(function (s) {
    if (s) { state.settings = Object.assign(state.settings, s); applySettings(); }
  }).catch(function () { /* ignore */ });
})();

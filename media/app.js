/* =========================================================
 * 番茄小说 Webview 前端（纯 JS，无框架）
 * 所有网络请求都通过 postMessage 转发到扩展宿主执行。
 * ========================================================= */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  /** 宿主类型：'panel'=编辑器标签页，'sidebar'=侧边栏视图 */
  var IS_SIDEBAR = document.body && document.body.dataset.host === 'sidebar';

  /** 所有阅读入口都交给宿主的原生只读编辑器，不在 Webview 中排版正文。 */
  function openBookInEditor(bookId, itemId) {
    var payload = { bookId: bookId, mode: 'reader' };
    if (itemId) payload.itemId = itemId;
    var oldError = document.getElementById('readerOpenError');
    if (oldError) oldError.remove();
    return call('open-editor-book', payload).catch(function (error) {
      var box = errBox('打开章节失败：' + error.message + '。可再次点击书籍重试。');
      box.id = 'readerOpenError';
      box.setAttribute('role', 'alert');
      app.prepend(box);
    });
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
      // A multi-chapter open reports its own native progress and per-request failures.
      // Do not show a false Webview timeout while a large page is still loading.
      if (type !== 'open-editor-book') setTimeout(function () {
        if (pending.has(id)) { pending.delete(id); reject(new Error('请求超时，请重试')); }
      }, 90000);
    });
  }

  /* ---------------- 状态 ---------------- */
  var state = {
    view: 'bookstore',
    user: null,
    loggedIn: false,
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
    // 书评（只在用户主动打开时显示）
    commentsBookId: null,
    comments: [],
    commentsLoading: false,
    commentsError: null,
    // 书架
    shelfLocal: [],
    shelfRemote: [],
    shelfLoading: false,
    shelfTab: null, // 'local' | 'remote' | null（null 时按登录态自动选：登录=remote，未登录=local）
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
  // 仅恢复书城的安全导航状态；旧版 reader 状态不再恢复。
  if (prevState && ['bookstore', 'search', 'shelf', 'login'].indexOf(prevState.view) >= 0) {
    state.view = prevState.view;
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

  function render() {
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
      view.appendChild(renderShelfTabs());
      view.appendChild(renderShelfContent());
    }).catch(function (e) {
      view.innerHTML = '';
      view.appendChild(errBox(e.message));
    });
  }

  /** 当前应展示的书架 tab（登录=remote，未登录=local） */
  function getActiveShelfTab() {
    if (state.shelfTab === 'remote' && !state.loggedIn) return 'local';
    if (state.shelfTab === 'local' || state.shelfTab === 'remote') return state.shelfTab;
    return state.loggedIn ? 'remote' : 'local';
  }

  /** 顶部 tabs —— 登录时显示 [云端 | 本地]；未登录只显示 [本地] */
  function renderShelfTabs() {
    var wrap = el('div', 'shelf-tabs');
    var localBtn = el('button', 'shelf-tab' + (getActiveShelfTab() === 'local' ? ' active' : ''), '本地书架');
    localBtn.id = 'shelfTabLocal';
    wrap.appendChild(localBtn);
    if (state.loggedIn) {
      var remoteBtn = el('button', 'shelf-tab' + (getActiveShelfTab() === 'remote' ? ' active' : ''), '云端书架');
      remoteBtn.id = 'shelfTabRemote';
      wrap.appendChild(remoteBtn);
    }
    return wrap;
  }

  /** 当前 tab 下的内容区 */
  function renderShelfContent() {
    var active = getActiveShelfTab();
    if (active === 'remote') return renderShelfRemoteGrid();
    return renderShelfLocalGrid();
  }

  /** 单本"读到：xxx" 行：有进度=显示章节名；无进度=显示 author（与 2026.8.22 一致），颜色统一灰黑 */
  function renderReadingLine(lastChapterTitle, fallback) {
    if (lastChapterTitle) return el('div', 'reading', '读到：' + lastChapterTitle);
    return el('div', 'reading', fallback || '');
  }

  function renderShelfLocalGrid() {
    var grid = el('div', 'shelf-grid');
    if (!state.shelfLocal.length) {
      grid.appendChild(el('div', 'empty', '书架为空，在书城或搜索中添加书籍'));
      return grid;
    }
    state.shelfLocal.forEach(function (it) {
      var item = el('div', 'shelf-item');
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
      // 与 2026.8.22 一致：有进度显示"读到：xxx"；无进度显示 author
      var line = it.lastReadChapterTitle
        ? el('div', 'reading', '读到：' + it.lastReadChapterTitle)
        : el('div', 'meta', it.author || '');
      item.appendChild(rm);
      item.appendChild(img);
      item.appendChild(title);
      item.appendChild(line);
      grid.appendChild(item);
    });
    return grid;
  }

  function renderShelfRemoteGrid() {
    var grid = el('div', 'shelf-grid');
    if (!state.loggedIn) {
      grid.appendChild(el('div', 'empty', '登录后可同步云端书架'));
      return grid;
    }
    if (!state.shelfRemote.length) {
      grid.appendChild(el('div', 'empty', '云端书架为空'));
      return grid;
    }
    state.shelfRemote.forEach(function (it) {
      var item = el('div', 'shelf-item');
      item.dataset.bookId = it.book_id;
      item.dataset.itemId = it.last_read_item_id || '';
      item.dataset.action = 'open';
      item.title = '点击继续阅读';
      var img = el('img', 'cover');
      if (it.cover_url) { img.src = it.cover_url; img.onerror = coverFallback; }
      else img.style.background = 'linear-gradient(135deg,#888,#aaa)';
      var title = el('div', 'title', it.title || it.book_id);
      // 与 2026.8.22 一致：有进度显示"读到：xxx"；无进度显示 author
      var line = it.current_chapter_title
        ? el('div', 'reading', '读到：' + it.current_chapter_title)
        : el('div', 'meta', it.author || '');
      item.appendChild(img);
      item.appendChild(title);
      item.appendChild(line);
      grid.appendChild(item);
    });
    return grid;
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

  /* ---------------- 书评 ---------------- */
  // 缓存已加载过的评论（按 bookId 索引），避免重复打开时重新拉取
  var _commentsCache = Object.create(null);
  function loadBookComments(force) {
    var bookId = state.commentsBookId;
    if (!bookId) return;
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
      var comments = (r && r.comments) || [];
      _commentsCache[bookId] = { loading: false, comments: comments, error: null };
      if (state.commentsBookId !== bookId) return;
      state.comments = comments;
      state.commentsLoading = false;
      renderCommentsDrawer();
    }).catch(function (e) {
      _commentsCache[bookId] = { loading: false, comments: [], error: e.message };
      if (state.commentsBookId !== bookId) return;
      state.comments = [];
      state.commentsLoading = false;
      state.commentsError = e.message;
      renderCommentsDrawer();
    });
  }

  function renderCommentsDrawer() {
    if (!state.commentsBookId) return;
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

  /* ---------------- 事件委托 ---------------- */
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var nav = t.closest ? t.closest('[data-nav]') : null;
    if (nav) {
      var target = nav.dataset.nav;
      var comments = document.getElementById('commentsDrawer');
      if (comments) comments.remove();
      state.commentsBookId = null;
      if (target === 'login') {
        state.view = 'login';
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
    // 书架 tab 切换
    if (t.id === 'shelfTabLocal' || t.id === 'shelfTabRemote') {
      state.shelfTab = t.id === 'shelfTabLocal' ? 'local' : 'remote';
      renderShelf($('#view'));
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
      openBookInEditor(bookId, resumeId);
      return;
    }
    // 历史记录：点击条目续读
    var histItem = t.closest ? t.closest('.history-item') : null;
    if (histItem && state.view === 'login') {
      var hBookId = histItem.dataset.bookId;
      var hItemId = histItem.dataset.itemId;
      openBookInEditor(hBookId, hItemId);
      return;
    }
    // 书籍弹窗
    if (t.id === 'readBtn') {
      document.getElementById('bookModal') && document.getElementById('bookModal').remove();
      openBookInEditor(t.dataset.bookId);
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

    if (t.id === 'closeDrawer') {
      state.commentsBookId = null;
      var drawer = document.getElementById('commentsDrawer');
      if (drawer) drawer.remove();
      return;
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
    if (m.type === 'nav') {
      state.commentsBookId = null;
      var drawer = document.getElementById('commentsDrawer');
      if (drawer) drawer.remove();
      state.view = m.view;
      render();
      if (m.view === 'bookstore' && !state.rankBooks.length && !state.rankLoading) loadRank(true);
      if (m.view === 'shelf') renderShelf($('#view'));
      return;
    }
    if (m.type === 'login-changed') {
      state.user = m.user;
      state.loggedIn = !!m.loggedIn;
      // 登出后强制把 tab 拉回 local，避免登入时还在 remote 但本地缓存陈旧
      if (!state.loggedIn) state.shelfTab = 'local';
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
    if (m.type === 'open-book-comments') {
      state.commentsBookId = m.bookId;
      loadBookComments(false);
      return;
    }
    if (m.type === 'reading-progress-changed') {
      refreshShelfCache();
      if (state.view === 'shelf') renderShelf($('#view'));
      if (state.view === 'login') {
        var section = $('.history-sec');
        if (section) section.remove();
        renderHistory($('#view'));
      }
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

  // 首次渲染后通过 ready 消息握手，宿主收到就绪事件才投递导航。
  render();
  call('ready', {}).then(function (r) {
    state.user = r.user;
    state.loggedIn = !!r.loggedIn;
    render();
    if (state.view === 'bookstore' && !state.rankBooks.length && !state.rankLoading) loadRank(true);
  }).catch(function () { /* ignore */ });
})();

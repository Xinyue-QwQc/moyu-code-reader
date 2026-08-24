/**
 * Webview 消息路由：面板与侧边栏视图共用。
 * 处理前端消息，转发到 API / 认证层；负责登录状态推送。
 */
import * as vscode from 'vscode';
import * as api from '../api/fanqie';
import { BookComment } from '../api/fanqie';
import { logout, QrStatus, startQrLogin, pollQrLogin, finalizeLogin, QrTicket } from '../auth/qr';
import {
  getLocalShelf,
  setLocalShelf,
  LocalShelfItem,
  getUser,
  getReaderSettings,
  setReaderSettings,
  ReaderSettings,
  getReadHistory,
  setReadHistory,
  HistoryItem,
} from '../net/store';
import { HttpError } from '../net/http';
import { getUserInfo } from '../api/fanqie';

/** 当前正在进行的扫码登录（用于中断） */
let currentQr: { cancel: () => void } | null = null;

/** 扫码会话序号：前端据此忽略过期轮询推送 */
let qrSessionSeq = 0;

/** 所有已挂载的 webview（面板 + 侧边栏），用于广播登录状态变化等 */
const liveWebviews = new Set<vscode.Webview>();

/** 由扩展入口注册：把书籍打开到编辑器标签页（面板） */
let openBookInEditorHandler:
  | ((bookId: string, mode: 'modal' | 'reader', itemId?: string) => void)
  | undefined;

export function setOpenBookInEditorHandler(
  fn: (bookId: string, mode: 'modal' | 'reader', itemId?: string) => void
): void {
  openBookInEditorHandler = fn;
}

export function broadcast(msg: any): void {
  for (const w of liveWebviews) {
    try {
      w.postMessage(msg);
    } catch {
      /* ignore */
    }
  }
}

async function handleMessage(webview: vscode.Webview, msg: any): Promise<void> {
  const id = msg?.id;
  const post = (ok: boolean, data?: any, error?: string) => {
    webview.postMessage({ type: 'resp', id, ok, data, error });
  };

  switch (msg?.type) {
    /* ------------------------------ 认证 ------------------------------ */
    case 'login-status': {
      const user = await getUser();
      post(true, { user, loggedIn: !!user });
      break;
    }
    case 'qr-start': {
      const session = ++qrSessionSeq;
      const onStatus = (s: QrStatus) => webview.postMessage({ type: 'qr-status', session, status: s });
      let cancelled = false;
      currentQr = {
        cancel: () => {
          cancelled = true;
        },
      };
      const checkCancel = () => {
        if (cancelled) throw new HttpError('已取消', 0, '', '');
      };
      const ticket = await startQrLogin(onStatus);
      checkCancel();
      post(true, { qrUrl: ticket.qrUrl, qrText: ticket.qrText, strategy: ticket.strategy, session });
      // 开始轮询（结果通过 qr-status 推送）
      void pollAndFinalize(ticket, onStatus, webview).catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'qr-status', session, status: { stage: 'error', message } });
      });
      break;
    }
    case 'qr-cancel': {
      currentQr?.cancel();
      post(true);
      break;
    }
    case 'logout': {
      await logout();
      post(true);
      broadcast({ type: 'login-changed', user: null, loggedIn: false });
      break;
    }

    /* ------------------------------ 书城 ------------------------------ */
    case 'rank-categories': {
      const cats = await api.getRankCategories();
      post(true, cats);
      break;
    }
    case 'rank-list': {
      const r = await api.getRankList({
        rankListType: Number(msg.rankListType ?? 3),
        categoryId: String(msg.categoryId ?? ''),
        gender: String(msg.gender ?? ''),
        offset: Number(msg.offset ?? 0),
        limit: Number(msg.limit ?? 20),
      });
      post(true, r);
      break;
    }
    case 'editor-list': {
      const list = await api.getEditorList();
      post(true, list);
      break;
    }

    /* ------------------------------ 搜索 ------------------------------ */
    case 'search': {
      const r = await api.searchBooks(String(msg.query ?? ''), Number(msg.page ?? 0), Number(msg.pageSize ?? 10));
      post(true, r);
      break;
    }

    /* ------------------------------ 书籍 / 阅读 ------------------------------ */
    case 'book-detail': {
      const d = await api.getBookDetail(String(msg.bookId ?? ''));
      post(true, d);
      break;
    }
    case 'directory': {
      const d = await api.getDirectory(String(msg.bookId ?? ''));
      post(true, d);
      break;
    }
    case 'chapter': {
      const c = await api.getChapter(String(msg.itemId ?? ''));
      post(true, c);
      break;
    }
    case 'progress-update': {
      await api.updateReadProgress(
        String(msg.bookId ?? ''),
        String(msg.itemId ?? ''),
        Number(msg.order ?? 0)
      );
      post(true);
      break;
    }

    /* ------------------------------ 书架 ------------------------------ */
    case 'shelf-local-get': {
      const items = await getLocalShelf();
      // 补全缺失封面/书名（旧数据无封面，用 simple/info 稳定接口补齐并写回）
      const missing = items.filter(i => !i.coverUrl || !i.title);
      if (missing.length) {
        try {
          const info = await api.getBookSimpleInfo(missing.map(m => m.bookId));
          const map = new Map(info.map(b => [b.book_id, b]));
          let changed = false;
          for (const it of items) {
            const b = map.get(it.bookId);
            if (b) {
              if (!it.coverUrl && b.thumb_url) { it.coverUrl = b.thumb_url; changed = true; }
              if (!it.title && b.book_name) { it.title = b.book_name; changed = true; }
              if (!it.author && b.author_name) { it.author = b.author_name; changed = true; }
            }
          }
          if (changed) await setLocalShelf(items);
        } catch {
          /* 网络失败不影响返回 */
        }
      }
      post(true, items);
      break;
    }
    case 'shelf-local-set': {
      await setLocalShelf(msg.items ?? []);
      post(true);
      break;
    }
    case 'shelf-remote-get': {
      const user = await getUserInfo();
      let entries: any[] = [];
      try {
        entries = await api.getRemoteBookshelf();
      } catch {
        entries = []; // 未登录或接口失败时静默返回空，不阻塞本地书架
      }
      post(true, { entries, loggedIn: !!user });
      break;
    }
    case 'shelf-add': {
      const bookId = String(msg.bookId ?? '');
      const local = await getLocalShelf();
      // 封面优先用 simple/info（稳定 CDN 图，非签名 URL），失败再退回详情接口
      let title = '', author = '', coverUrl = '';
      const si = await api.getBookSimpleInfo([bookId]);
      if (si[0] && si[0].book_name) {
        title = si[0].book_name;
        author = si[0].author_name;
        coverUrl = si[0].thumb_url;
      } else {
        try {
          const detail = await api.getBookDetail(bookId);
          title = detail.book_name;
          author = detail.author;
          coverUrl = detail.thumb_url;
        } catch {
          /* 保持空，前端显示渐变占位 */
        }
      }
      const item: LocalShelfItem = {
        bookId,
        title,
        author,
        coverUrl,
        addedAt: Date.now(),
      };
      if (!local.some(i => i.bookId === bookId)) {
        local.unshift(item);
        await setLocalShelf(local);
      }
      let remoteOk = false;
      if (msg.syncRemote !== false) {
        try {
          await api.addToRemoteBookshelf(bookId);
          remoteOk = true;
        } catch {
          remoteOk = false;
        }
      }
      post(true, { local: local.length, remoteOk });
      break;
    }
    case 'shelf-remove': {
      const bookId = String(msg.bookId ?? '');
      const local = await getLocalShelf();
      await setLocalShelf(local.filter(i => i.bookId !== bookId));
      let remoteOk = false;
      try {
        await api.removeFromRemoteBookshelf(bookId);
        remoteOk = true;
      } catch {
        remoteOk = false;
      }
      post(true, { remoteOk });
      break;
    }

    /* ------------------------------ 评论 ------------------------------ */
    case 'book-comments': {
      // 书籍书评：从 SEO 页面收集评论链接，再逐个拉取（登录不需要）
      const bookId = String(msg.bookId ?? '');
      const links = await api.collectBookCommentLinks(bookId);
      const limit = Math.min(Number(msg.limit ?? 10), 20);
      const comments: BookComment[] = [];
      for (const link of links.slice(0, limit)) {
        try {
          const c = await api.getBookComment(link.bookId, link.commentId);
          if (c && c.text) comments.push(c);
        } catch {
          /* skip */
        }
      }
      post(true, { comments });
      break;
    }

    /* ------------------------------ 历史记录（本地） ------------------------------ */
    case 'history-get': {
      const items = await getReadHistory();
      // 补全缺失封面/书名（历史条目可能来自无封面来源）
      const missing = items.filter(i => !i.coverUrl || !i.title);
      if (missing.length) {
        try {
          const info = await api.getBookSimpleInfo(missing.map(m => m.bookId));
          const map = new Map(info.map(b => [b.book_id, b]));
          let changed = false;
          for (const it of items) {
            const b = map.get(it.bookId);
            if (b) {
              if (!it.coverUrl && b.thumb_url) { it.coverUrl = b.thumb_url; changed = true; }
              if (!it.title && b.book_name) { it.title = b.book_name; changed = true; }
              if (!it.author && b.author_name) { it.author = b.author_name; changed = true; }
            }
          }
          if (changed) await setReadHistory(items);
        } catch {
          /* 网络失败不影响返回 */
        }
      }
      post(true, items);
      break;
    }
    case 'history-record': {
      const bookId = String(msg.bookId ?? '');
      if (bookId) {
        const entry: HistoryItem = {
          bookId,
          title: String(msg.title ?? ''),
          author: String(msg.author ?? ''),
          coverUrl: String(msg.coverUrl ?? ''),
          itemId: String(msg.itemId ?? ''),
          chapterTitle: String(msg.chapterTitle ?? ''),
          order: Number(msg.order ?? 0),
          readAt: Date.now(),
        };
        const rest = (await getReadHistory()).filter(i => i.bookId !== bookId);
        rest.unshift(entry);
        await setReadHistory(rest.slice(0, 100));
      }
      post(true);
      break;
    }

    /* ------------------------------ 设置 ------------------------------ */
    case 'settings-get': {
      post(true, getReaderSettings());
      break;
    }
    case 'settings-set': {
      await setReaderSettings(msg.settings as ReaderSettings);
      post(true);
      break;
    }

    /* ------------------------------ 其他 ------------------------------ */
    case 'open-external': {
      void vscode.env.openExternal(vscode.Uri.parse(String(msg.url ?? '')));
      post(true);
      break;
    }
    case 'open-editor-book': {
      // 侧边栏请求：在编辑器标签页中打开书籍阅读器（可携带 itemId 续读历史章节）
      openBookInEditorHandler?.(
        String(msg.bookId ?? ''),
        msg.mode === 'modal' ? 'modal' : 'reader',
        msg.itemId ? String(msg.itemId) : undefined
      );
      post(true);
      break;
    }
    default:
      post(false, undefined, `未知消息类型: ${msg?.type}`);
  }
}

async function pollAndFinalize(ticket: QrTicket, onStatus: (s: QrStatus) => void, webview: vscode.Webview) {
  const redirectUrl = await pollQrLogin(ticket, onStatus);
  const user = await finalizeLogin(redirectUrl, onStatus);
  broadcast({ type: 'login-changed', user, loggedIn: true });
}

/**
 * 为某个 webview 挂载消息路由，并推送初始状态。
 * 返回 dispose：卸载路由并从广播集合移除。
 */
export function attachRouter(webview: vscode.Webview): vscode.Disposable {
  liveWebviews.add(webview);
  const disp = webview.onDidReceiveMessage((msg: any) => {
    void handleMessage(webview, msg).catch(err => {
      const message = err instanceof Error ? err.message : String(err);
      webview.postMessage({ type: 'resp', id: msg?.id, ok: false, error: message });
    });
  });
  void (async () => {
    const user = await getUser();
    webview.postMessage({ type: 'init', user, settings: getReaderSettings(), loggedIn: !!user });
  })();
  return {
    dispose: () => {
      liveWebviews.delete(webview);
      disp.dispose();
    },
  };
}

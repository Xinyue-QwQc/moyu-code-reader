import * as vscode from 'vscode';
import * as api from '../api/fanqie';
import { chapterText, CHAPTER_EXTENSION, chaptersPerPage, isBookId, MAX_CHAPTERS_PER_PAGE, positionKey, ReadingPage, readingPage, READER_SCHEME, safeLabel } from './content';

export interface ChapterAddress { bookId: string; itemId: string; itemIds: string[]; pageSize: number }

export function chapterAddress(uri: vscode.Uri): ChapterAddress | undefined {
  if (uri.scheme !== READER_SCHEME || !uri.path.endsWith(CHAPTER_EXTENSION)) return;
  const params = new URLSearchParams(uri.query);
  const bookId = params.get('bookId') ?? '';
  const itemId = params.get('itemId') ?? '';
  const itemIds = params.has('itemIds') ? params.get('itemIds')!.split(',') : [itemId];
  const pageSize = params.has('pageSize') ? Number(params.get('pageSize')) : itemIds.length;
  if (!isBookId(bookId) || !isBookId(itemId) || itemIds[0] !== itemId || !itemIds.every(isBookId)) return;
  if (!itemIds.length || itemIds.length > MAX_CHAPTERS_PER_PAGE || new Set(itemIds).size !== itemIds.length) return;
  if (!Number.isInteger(pageSize) || pageSize < itemIds.length || pageSize > MAX_CHAPTERS_PER_PAGE) return;
  return { bookId, itemId, itemIds, pageSize };
}

export function pageUri(bookId: string, chapters: api.ChapterData[], bookName?: string, count = chapters.length): vscode.Uri {
  const first = chapters[0];
  const last = chapters[chapters.length - 1];
  const title = chapters.length === 1 ? first.title : first.title + ' ～ ' + last.title;
  const query = new URLSearchParams({ bookId, itemId: first.itemId });
  if (chapters.length > 1) query.set('itemIds', chapters.map(chapter => chapter.itemId).join(','));
  if (count > 1) query.set('pageSize', String(chaptersPerPage(count)));
  return vscode.Uri.from({
    scheme: READER_SCHEME,
    path: '/' + safeLabel(bookName || first.bookName, bookId) + '/' + safeLabel(title, first.itemId) + CHAPTER_EXTENSION,
    query: query.toString(),
  });
}

export function chapterUri(bookId: string, chapter: api.ChapterData, bookName?: string): vscode.Uri {
  return pageUri(bookId, [chapter], bookName, 1);
}

/** Real readonly VS Code files; a URI describes exactly which chapters are in the document. */
export class ChapterFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly cache = new Map<string, api.ChapterData>();
  private readonly pending = new Map<string, Promise<api.ChapterData>>();
  private readonly pages = new Map<string, ReadingPage>();
  private readonly pendingPages = new Map<string, Promise<ReadingPage>>();
  private readonly createdAt = Date.now();

  peek(uri: vscode.Uri): api.ChapterData | undefined { return this.peekPage(uri)?.chapters[0]; }
  peekPage(uri: vscode.Uri): ReadingPage | undefined { return this.pages.get(uri.toString()); }

  async chapter(bookId: string, itemId: string): Promise<api.ChapterData> {
    if (!isBookId(bookId) || !isBookId(itemId)) throw new Error('无效的书籍或章节 ID。');
    const key = positionKey(bookId, itemId);
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
    const running = this.pending.get(key);
    if (running) return running;
    const request = api.getChapter(itemId).then(chapter => {
      if (chapter.itemId !== itemId || (chapter.bookId && chapter.bookId !== bookId)) throw new Error('返回的章节与请求不一致，未打开错误的正文。');
      chapterText(chapter);
      this.cache.set(key, chapter);
      const openKeys = new Set(vscode.workspace.textDocuments.flatMap(document => {
        const address = chapterAddress(document.uri);
        return address ? address.itemIds.map(id => positionKey(address.bookId, id)) : [];
      }));
      for (const oldKey of this.cache.keys()) {
        if (this.cache.size <= 64) break;
        if (!openKeys.has(oldKey) && oldKey !== key) this.cache.delete(oldKey);
      }
      return chapter;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  /** At most four requests concurrently, preserving catalog order even if responses arrive out of order. */
  async chapters(bookId: string, itemIds: readonly string[]): Promise<api.ChapterData[]> {
    if (!itemIds.length || itemIds.length > MAX_CHAPTERS_PER_PAGE) throw new Error('每页应包含 1–50 章。');
    const result = new Array<api.ChapterData>(itemIds.length);
    let next = 0;
    let failed = false;
    await Promise.all(Array.from({ length: Math.min(4, itemIds.length) }, async () => {
      while (!failed && next < itemIds.length) {
        const index = next++;
        try { result[index] = await this.chapter(bookId, itemIds[index]); }
        catch (error) { failed = true; throw error; }
      }
    }));
    return result;
  }

  async page(uri: vscode.Uri): Promise<ReadingPage> {
    const key = uri.toString();
    const cached = this.pages.get(key);
    if (cached) return cached;
    const pending = this.pendingPages.get(key);
    if (pending) return pending;
    const address = chapterAddress(uri);
    if (!address) throw vscode.FileSystemError.FileNotFound(uri);
    const request = this.chapters(address.bookId, address.itemIds).then(chapters => {
      const page = readingPage(chapters);
      this.pages.set(key, page);
      const openKeys = new Set(vscode.workspace.textDocuments.map(document => document.uri.toString()));
      for (const oldKey of this.pages.keys()) {
        if (this.pages.size <= 16) break;
        if (!openKeys.has(oldKey) && oldKey !== key) this.pages.delete(oldKey);
      }
      return page;
    }).finally(() => this.pendingPages.delete(key));
    this.pendingPages.set(key, request);
    return request;
  }

  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
  stat(uri: vscode.Uri): vscode.FileStat {
    if (!uri.path.endsWith(CHAPTER_EXTENSION)) return { type: vscode.FileType.Directory, ctime: this.createdAt, mtime: this.createdAt, size: 0 };
    if (!chapterAddress(uri)) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: this.createdAt, mtime: this.createdAt,
      size: Buffer.byteLength(this.peekPage(uri)?.text ?? '', 'utf8'), permissions: vscode.FilePermission.Readonly };
  }
  readDirectory(): [string, vscode.FileType][] { return []; }
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    if (!chapterAddress(uri)) throw vscode.FileSystemError.FileNotFound(uri);
    try { return Buffer.from((await this.page(uri)).text, 'utf8'); }
    catch (error) { throw vscode.FileSystemError.Unavailable(error instanceof Error ? error.message : String(error)); }
  }
  private readOnly(): never { throw vscode.FileSystemError.NoPermissions('小说章节为只读，请使用原生复制/查找功能。'); }
  writeFile(): never { return this.readOnly(); }
  createDirectory(): never { return this.readOnly(); }
  delete(): never { return this.readOnly(); }
  rename(): never { return this.readOnly(); }
  dispose(): void { this.changes.dispose(); this.cache.clear(); this.pages.clear(); }
}

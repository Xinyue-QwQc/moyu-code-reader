import * as vscode from 'vscode';
import * as api from '../api/fanqie';
import { getLocalShelf, getReadHistory, getUser, setLocalShelf, setReadHistory } from '../net/store';
import { canonicalLine, chapterProgress, chaptersPerPage, displayLine, paragraphSpacing, flattenDirectory, isBookId, pageChapterIds, positionKey, READER_LANGUAGE, READER_SCHEME, SavedPosition, sectionAtLine } from './content';
import { chapterAddress, ChapterFileSystem, pageUri } from './documents';
import { ReaderHighlights } from './highlights';
import { showReaderAppearance } from './appearance';
import type { AgentReadingContext } from '../agent/types';

const POSITIONS_KEY = 'fanqie.nativeReader.positions.v1';
interface Book { info?: api.BookInfo; chapters: api.ChapterItem[]; loadedAt: number }
interface ReaderActions {
  openLibrary(view?: string): Promise<void>;
  openDetails(bookId: string): Promise<void>;
  openComments(bookId: string): Promise<void>;
  onProgressChanged(): void;
}

export class NativeReader implements vscode.Disposable {
  private readonly files = new ChapterFileSystem();
  private readonly highlights = new ReaderHighlights(uri => this.files.peekPage(uri));
  private readonly disposables: vscode.Disposable[] = [];
  private readonly books = new Map<string, Book>();
  private readonly pendingBooks = new Map<string, Promise<Book>>();
  private positions: Record<string, SavedPosition>;
  private readonly restoring = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private positionWrites = Promise.resolve();
  private progressWrites = Promise.resolve();
  private remoteWrites = Promise.resolve();
  private configurationTask = Promise.resolve();
  private lastRecorded = '';
  private openSequence = 0;
  private navigating = false;
  private disposed = false;
  private lastAgentContext: AgentReadingContext | undefined;
  private previousEditor: vscode.TextEditor | undefined;
  private readonly menu: vscode.StatusBarItem;
  private readonly previous: vscode.StatusBarItem;
  private readonly catalog: vscode.StatusBarItem;
  private readonly next: vscode.StatusBarItem;
  private readonly pageCount: vscode.StatusBarItem;
  private readonly settings: vscode.StatusBarItem;

  constructor(private readonly context: vscode.ExtensionContext, private readonly actions: ReaderActions) {
    this.positions = context.globalState.get<Record<string, SavedPosition>>(POSITIONS_KEY, {});
    this.disposables.push(vscode.workspace.registerFileSystemProvider(READER_SCHEME, this.files, { isReadonly: true, isCaseSensitive: true }));
    this.disposables.push(vscode.languages.registerDocumentSymbolProvider({ scheme: READER_SCHEME, language: READER_LANGUAGE }, {
      provideDocumentSymbols: async document => (await this.files.page(document.uri)).sections.map(section => {
        const heading = document.lineAt(section.startLine).range;
        return new vscode.DocumentSymbol(section.title, '', vscode.SymbolKind.Module,
          new vscode.Range(heading.start, document.lineAt(section.endLine).range.end), heading);
      }),
    }));
    const status = (id: string, priority: number, text: string, tooltip: string, command: string) => {
      const item = vscode.window.createStatusBarItem(id, vscode.StatusBarAlignment.Right, priority);
      item.name = tooltip;
      item.text = text;
      item.tooltip = tooltip;
      item.command = command;
      this.disposables.push(item);
      return item;
    };
    this.menu = status('fanqie.reader.menu', 114, '$(book) 阅读', '阅读菜单：书城、书架、详情、书评', 'fanqie.reader.menu');
    this.previous = status('fanqie.reader.previous', 113, '$(chevron-left)', '上一页（Ctrl+Alt+PageUp）', 'fanqie.reader.previousChapter');
    this.catalog = status('fanqie.reader.catalog', 112, '$(list-ordered) 目录', '章节目录 / 阅读进度', 'fanqie.reader.catalog');
    this.next = status('fanqie.reader.next', 111, '$(chevron-right)', '下一页（Ctrl+Alt+PageDown）', 'fanqie.reader.nextChapter');
    this.pageCount = status('fanqie.reader.pageSize', 110, '$(files) 每页 1 章', '设置一个虚拟文件合并展示几章', 'fanqie.reader.pageSize');
    this.settings = status('fanqie.reader.settings', 109, '$(settings-gear) 设置', '阅读设置：每页章节数、字体、行间距、段间距、配色、高亮与缩略图', 'fanqie.reader.appearance');
    const register = (command: string, action: (...args: any[]) => unknown) => this.disposables.push(
      vscode.commands.registerCommand(command, async (...args: any[]) => {
        try { return await action(...args); }
        catch (error) { await vscode.window.showErrorMessage('番茄小说：' + this.errorText(error)); }
      }));
    register('fanqie.reader.menu', () => this.showMenu());
    register('fanqie.reader.catalog', () => this.showCatalog());
    register('fanqie.reader.previousChapter', () => this.navigate(-1));
    register('fanqie.reader.nextChapter', () => this.navigate(1));
    register('fanqie.reader.pageSize', (value?: number) => this.choosePageSize(value));
    register('fanqie.reader.appearance', () => showReaderAppearance(vscode.window.activeTextEditor?.document.uri));
    register('fanqie.reader.settings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:zwb8926.fanqie-novel'));
    register('fanqie.reader.toggleHighlight', () => this.toggleHighlight());
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (this.previousEditor) { this.savePosition(this.previousEditor); this.captureAgentContext(this.previousEditor); }
        this.previousEditor = editor;
        this.refreshStatus();
        if (editor && chapterAddress(editor.document.uri)) void this.activated(editor);
        else this.lastRecorded = '';
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges(event => {
        this.savePosition(event.textEditor);
        if (event.textEditor === vscode.window.activeTextEditor) { this.refreshStatus(); this.recordVisibleChapter(event.textEditor); }
      }),
      vscode.window.onDidChangeTextEditorSelection(event => { this.savePosition(event.textEditor); this.captureAgentContext(event.textEditor); }),
      vscode.workspace.onDidChangeConfiguration(event => {
        const editor = vscode.window.activeTextEditor;
        const address = editor && chapterAddress(editor.document.uri);
        if (editor && address && (event.affectsConfiguration('fanqie.reader.chaptersPerPage', editor.document.uri) || event.affectsConfiguration('fanqie.reader.paragraphSpacing', editor.document.uri))) {
          const section = this.currentSection(editor);
          this.savePosition(editor);
          const oldTab = vscode.window.tabGroups.activeTabGroup.activeTab;
          this.configurationTask = this.openBook(address.bookId, section?.itemId ?? address.itemId).then(async () => {
            const current = vscode.window.activeTextEditor;
            if (oldTab && vscode.window.tabGroups.all.some(group => group.tabs.includes(oldTab)) && current && current.document.uri.toString() !== editor.document.uri.toString()
              && chapterAddress(current.document.uri)?.bookId === address.bookId) await vscode.window.tabGroups.close(oldTab, true);
          }).catch(error => { void vscode.window.showErrorMessage('调整阅读布局失败：' + this.errorText(error)); });
        }
        this.refreshStatus();
      }),
    );
    this.previousEditor = vscode.window.activeTextEditor;
    this.refreshStatus();
    if (this.previousEditor && chapterAddress(this.previousEditor.document.uri)) void this.activated(this.previousEditor);
  }

  private errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  private size(uri?: vscode.Uri): number { return chaptersPerPage(vscode.workspace.getConfiguration('fanqie.reader', uri).get('chaptersPerPage', 1)); }
  private currentSection(editor: vscode.TextEditor) {
    const page = this.files.peekPage(editor.document.uri);
    return page && sectionAtLine(page.sections, editor.visibleRanges[0]?.start.line ?? 0);
  }

  private async book(bookId: string, refresh = false): Promise<Book> {
    const cached = this.books.get(bookId);
    if (!refresh && cached && Date.now() - cached.loadedAt < 5 * 60 * 1000) return cached;
    const pending = this.pendingBooks.get(bookId);
    if (pending) return pending;
    const request = Promise.all([api.getDirectory(bookId), api.getBookDetail(bookId).catch(() => undefined)])
      .then(([directory, info]) => {
        const book = { info, chapters: flattenDirectory(directory), loadedAt: Date.now() };
        this.books.set(bookId, book);
        return book;
      }).finally(() => this.pendingBooks.delete(bookId));
    this.pendingBooks.set(bookId, request);
    return request;
  }

  /** All library/sidebar/history entry points use this exact same native multi-chapter document. */
  async openBook(bookId: string, itemId?: string): Promise<void> {
    if (!isBookId(bookId) || (itemId && !isBookId(itemId))) throw new Error('请输入有效的书籍 / 章节 ID（至少 10 位数字）。');
    const sequence = ++this.openSequence;
    const count = this.size();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: '番茄小说：打开阅读页…' }, async () => {
      const book = await this.book(bookId).catch(error => {
        if (itemId && count === 1) return { chapters: [], loadedAt: 0 } as Book;
        throw error;
      });
      if (!itemId) {
        const [history, shelf] = await Promise.all([getReadHistory(), getLocalShelf()]);
        const savedHistory = history.find(entry => entry.bookId === bookId);
        const savedShelf = shelf.find(entry => entry.bookId === bookId);
        const candidates = [
          { id: savedHistory?.itemId, time: savedHistory?.readAt ?? 0 },
          { id: savedShelf?.lastReadItemId, time: savedShelf?.lastReadAt ?? 0 },
        ].sort((a, b) => b.time - a.time);
        itemId = candidates.find(candidate => book.chapters.some(chapter => chapter.itemId === candidate.id))?.id ?? book.chapters[0]?.itemId;
      }
      if (!itemId) throw new Error('这本书暂时没有可读章节。');
      const ids = pageChapterIds(book.chapters, itemId, count);
      const chapters = await this.files.chapters(bookId, ids);
      if (this.disposed || sequence !== this.openSequence) return;
      const uri = pageUri(bookId, chapters, book.info?.book_name, count, paragraphSpacing(vscode.workspace.getConfiguration('fanqie.reader').get('paragraphSpacing', 0)));
      const page = await this.files.page(uri);
      const section = page.sections.find(section => section.itemId === itemId)!;
      const targetChapter = chapters.find(chapter => chapter.itemId === itemId)!;
      const saved = this.positions[positionKey(bookId, itemId)];
      this.restoring.add(uri.toString());
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        if (this.disposed || sequence !== this.openSequence) return;
        const editor = await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Active });
        if (this.disposed || sequence !== this.openSequence) return;
        const relative = (line: number) => displayLine(section, Math.max(0, line || 0));
        const cursor = document.validatePosition(new vscode.Position(relative(saved?.line ?? 0), Math.max(0, saved?.character ?? 0)));
        const top = document.validatePosition(new vscode.Position(relative(saved?.topLine ?? 0), Math.max(0, saved?.topCharacter ?? 0)));
        // Retain native view state where possible (including split editors and soft-wrap pixel offsets).
        // AtTop inserts sticky-scroll padding, so use native editorScroll only when relocation is needed.
        if (!editor.selection.active.isEqual(cursor) || this.currentSection(editor)?.itemId !== itemId) {
          editor.selection = new vscode.Selection(cursor, cursor);
          await vscode.commands.executeCommand('editorScroll', { to: 'up', by: 'line', value: document.lineCount, revealCursor: false });
          if (vscode.window.activeTextEditor === editor) await vscode.commands.executeCommand('editorScroll', { to: 'down', by: 'line', value: top.line, revealCursor: false });
        }
        this.highlights.apply(editor);
        this.refreshStatus();
        await this.recordChapter(bookId, targetChapter);
        if (chapters.some(chapter => chapter.isChapterLock)) void vscode.window.showInformationMessage('本页含官方返回的试读章节；完整章节请在官方平台登录并取得阅读权限。');
      } finally { this.restoring.delete(uri.toString()); }
    });
  }

  private async activated(editor: vscode.TextEditor): Promise<void> {
    const address = chapterAddress(editor.document.uri);
    if (!address) return;
    try {
      await this.files.page(editor.document.uri);
      if (this.disposed || vscode.window.activeTextEditor !== editor) return;
      this.highlights.apply(editor);
      this.refreshStatus();
      this.recordVisibleChapter(editor);
      await this.book(address.bookId);
      if (vscode.window.activeTextEditor === editor) this.refreshStatus();
    } catch (error) { console.warn('[fanqie reader]', this.errorText(error)); }
  }

  private async navigate(direction: -1 | 1): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const address = editor && chapterAddress(editor.document.uri);
    if (!editor || !address || this.navigating) return;
    this.navigating = true;
    try {
      const page = await this.files.page(editor.document.uri);
      let book = await this.book(address.bookId).catch(() => undefined);
      const adjacent = () => {
        const first = book?.chapters.findIndex(entry => entry.itemId === address.itemId) ?? -1;
        if (first >= 0) return book?.chapters[direction === 1 ? first + address.itemIds.length : first - address.pageSize]?.itemId;
        return direction === 1 ? page.chapters[page.chapters.length - 1].nextItemId : page.chapters[0].preItemId;
      };
      let nextId = adjacent();
      if (!nextId) { book = await this.book(address.bookId, true).catch(() => book); nextId = adjacent(); }
      if (vscode.window.activeTextEditor !== editor) return;
      if (!nextId) { await vscode.window.showInformationMessage(direction === 1 ? '已经是最后一页。' : '已经是第一页。'); return; }
      this.savePosition(editor);
      await this.openBook(address.bookId, nextId);
    } finally { this.navigating = false; }
  }

  private async choosePageSize(value?: number): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (value === undefined) {
      const current = this.size(uri);
      const picked = await vscode.window.showQuickPick([
        ...[1, 3, 5, 10, 20, 50].map(value => ({ label: '每页 ' + value + ' 章', description: value === current ? '当前设置' : '', value })),
        { label: '自定义章节数…', description: '1–50 章；整章合并到同一个原生文档', value: 0 },
      ], { title: '每页展示几章', placeHolder: '修改后立即重组当前阅读页，保持正在阅读的章节与位置' });
      if (!picked) return;
      value = picked.value;
      if (!value) {
        const input = await vscode.window.showInputBox({ title: '每页章节数', value: String(current), prompt: '输入 1–50 的整数。最后一页只显示剩余章节。',
          validateInput: text => /^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= 50 ? undefined : '请输入 1–50 的整数。' });
        if (input === undefined) return;
        value = Number(input);
      }
    }
    if (!Number.isInteger(value) || value < 1 || value > 50) throw new Error('每页章节数应为 1–50 的整数。');
    const config = vscode.workspace.getConfiguration('fanqie.reader', uri);
    const inspected = config.inspect<number>('chaptersPerPage');
    const target = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update('chaptersPerPage', value, target);
    await this.configurationTask;
  }

  private async showCatalog(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const address = editor && chapterAddress(editor.document.uri);
    if (!editor || !address) return;
    const currentId = this.currentSection(editor)?.itemId ?? address.itemId;
    const book = await this.book(address.bookId, true);
    const picked = await vscode.window.showQuickPick(book.chapters.map((chapter, index) => ({
      label: (chapter.itemId === currentId ? '$(check) ' : '') + chapter.title,
      description: String(index + 1) + ' / ' + book.chapters.length + (chapter.needPay ? ' · 需官方阅读权限' : ''),
      detail: chapter.volume_name, itemId: chapter.itemId,
    })), { title: (book.info?.book_name || '番茄小说') + ' · 目录', placeHolder: '输入章节名或序号，跳到所在阅读页中的该章节', matchOnDescription: true, matchOnDetail: true });
    if (picked) { this.savePosition(editor); await this.openBook(address.bookId, picked.itemId); }
  }

  private async showMenu(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const address = editor && chapterAddress(editor.document.uri);
    if (!editor || !address) return this.actions.openLibrary();
    const items = [
      { label: '$(settings-gear) 阅读设置', description: '每页章节数、字体、配色、高亮、缩略图', run: () => showReaderAppearance(editor.document.uri) },
      { label: '$(files) 每页章节数', run: () => this.choosePageSize() },
      { label: '$(list-ordered) 章节目录', run: () => this.showCatalog() },
      { label: '$(library) 书城 / 搜索', run: () => this.actions.openLibrary('bookstore') },
      { label: '$(bookmark) 书架', run: () => this.actions.openLibrary('shelf') },
      { label: '$(info) 本书详情 / 加入云端书架', run: () => this.actions.openDetails(address.bookId) },
      { label: '$(comment-discussion) 书评', run: () => this.actions.openComments(address.bookId) },
      { label: '$(word-wrap) 切换自动换行', description: 'VS Code 原生 Alt+Z；只影响当前编辑器', run: () => vscode.commands.executeCommand('editor.action.toggleWordWrap') },
      { label: '$(symbol-color) 开关全部阅读高亮', run: () => this.toggleHighlight() },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: '番茄小说 · 阅读菜单' });
    if (picked) await picked.run();
  }

  private async toggleHighlight(): Promise<void> {
    const config = vscode.workspace.getConfiguration('fanqie.reader.highlight', vscode.window.activeTextEditor?.document.uri);
    const inspected = config.inspect<boolean>('enabled');
    const target = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update('enabled', !config.get('enabled', true), target);
  }

  private refreshStatus(): void {
    const editor = vscode.window.activeTextEditor;
    const address = editor && chapterAddress(editor.document.uri);
    const items = [this.menu, this.previous, this.catalog, this.next, this.pageCount, this.settings];
    if (!editor || !address) { items.forEach(item => item.hide()); return; }
    this.captureAgentContext(editor);
    const page = this.files.peekPage(editor.document.uri);
    const section = this.currentSection(editor);
    const chapter = page?.chapters.find(chapter => chapter.itemId === section?.itemId);
    const book = this.books.get(address.bookId);
    const first = book?.chapters.findIndex(entry => entry.itemId === address.itemId) ?? -1;
    const total = book?.chapters.length || Number(chapter?.serialCount) || '?';
    const start = first >= 0 ? first + 1 : page?.chapters[0]?.realChapterOrder || '?';
    const last = first >= 0 ? first + address.itemIds.length : page?.chapters[page.chapters.length - 1]?.realChapterOrder || '?';
    const ranges = editor.visibleRanges;
    const percentage = chapterProgress(ranges[0]?.start.line ?? 0, ranges[ranges.length - 1]?.end.line ?? 0, editor.document.lineCount);
    this.menu.tooltip = [book?.info?.book_name || chapter?.bookName, chapter?.title, '阅读菜单：书城、书架、详情、书评'].filter(Boolean).join('\n');
    this.catalog.text = '$(list-ordered) ' + start + (address.itemIds.length > 1 ? '–' + last : '') + '/' + total + ' · ' + percentage + '%';
    this.catalog.tooltip = (chapter?.title || '当前章节') + '\n点击打开目录；百分比为本页整个虚拟文件的滚动位置';
    this.pageCount.text = '$(files) 每页 ' + this.size(editor.document.uri) + ' 章';
    this.pageCount.tooltip = '当前文件实际包含 ' + address.itemIds.length + ' 章。点击调整每页章节数（1–50）。';
    items.forEach(item => item.show());
  }

  private savePosition(editor: vscode.TextEditor): void {
    const address = chapterAddress(editor.document.uri);
    const section = this.currentSection(editor);
    if (!address || !section || this.disposed || !editor.visibleRanges.length || this.restoring.has(editor.document.uri.toString())) return;
    const top = editor.visibleRanges[0].start;
    const cursor = editor.selection.active;
    const cursorHere = cursor.line >= section.startLine && cursor.line <= section.endLine;
    this.positions[positionKey(address.bookId, section.itemId)] = {
      line: canonicalLine(section, cursorHere ? cursor.line : top.line),
      character: cursorHere ? cursor.character : top.character,
      topLine: canonicalLine(section, top.line), topCharacter: top.character, updatedAt: Date.now(),
    };
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.flush().catch(error => console.warn('[fanqie positions]', error)); }, 300);
  }

  private recordVisibleChapter(editor: vscode.TextEditor): void {
    const address = chapterAddress(editor.document.uri);
    const section = this.currentSection(editor);
    const chapter = this.files.peekPage(editor.document.uri)?.chapters.find(chapter => chapter.itemId === section?.itemId);
    if (address && chapter && !this.restoring.has(editor.document.uri.toString())) void this.recordChapter(address.bookId, chapter);
  }

  private recordChapter(bookId: string, chapter: api.ChapterData): Promise<void> {
    const key = positionKey(bookId, chapter.itemId);
    if (this.lastRecorded === key) return this.progressWrites;
    this.lastRecorded = key;
    this.progressWrites = this.progressWrites.then(async () => {
      const [history, shelf] = await Promise.all([getReadHistory(), getLocalShelf()]);
      const previous = shelf.find(item => item.bookId === bookId);
      const oldHistory = history.find(item => item.bookId === bookId);
      const book = this.books.get(bookId);
      const index = book?.chapters.findIndex(item => item.itemId === chapter.itemId) ?? -1;
      const now = Date.now();
      const entry = {
        bookId, itemId: chapter.itemId, chapterTitle: chapter.title,
        title: book?.info?.book_name || chapter.bookName || previous?.title || oldHistory?.title || bookId,
        author: book?.info?.author || chapter.author || previous?.author || oldHistory?.author || '',
        coverUrl: book?.info?.thumb_url || previous?.coverUrl || oldHistory?.coverUrl || '',
        order: Number(chapter.realChapterOrder) || Math.max(0, index + 1), readAt: now,
      };
      await setReadHistory([entry, ...history.filter(item => item.bookId !== bookId)].slice(0, 100));
      await setLocalShelf([{
        bookId, title: entry.title, author: entry.author, coverUrl: entry.coverUrl,
        addedAt: previous?.addedAt ?? now, lastReadItemId: entry.itemId, lastReadChapterTitle: entry.chapterTitle, lastReadAt: now,
      }, ...shelf.filter(item => item.bookId !== bookId)]);
      this.actions.onProgressChanged();
      if (await getUser()) this.remoteWrites = this.remoteWrites.then(() => api.updateReadProgress(bookId, entry.itemId, entry.order)).catch(error => console.warn('[fanqie remote progress]', error));
    }).catch(error => { this.lastRecorded = ''; console.warn('[fanqie progress]', error); });
    return this.progressWrites;
  }

  /** Read-only data access for extension tools; it never opens tabs or modifies reading history. */
  getAgentContext(): AgentReadingContext | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor) this.captureAgentContext(editor);
    return this.lastAgentContext && { ...this.lastAgentContext,
      active: !!editor && editor.document.uri.toString() === this.lastAgentContext.uri && !!chapterAddress(editor.document.uri) };
  }

  async getAgentDirectory(bookId: string): Promise<{ title: string; chapters: api.ChapterItem[] }> {
    if (!isBookId(bookId)) throw new Error('无效的书籍 ID。');
    const book = await this.book(bookId);
    return { title: book.info?.book_name ?? bookId, chapters: book.chapters };
  }

  getAgentChapters(bookId: string, itemIds: string[]): Promise<api.ChapterData[]> { return this.files.chapters(bookId, itemIds); }

  private captureAgentContext(editor: vscode.TextEditor): void {
    if (editor.document.isClosed) return;
    const address = chapterAddress(editor.document.uri);
    const page = this.files.peekPage(editor.document.uri);
    if (!address || !page) return;
    const visible = editor.visibleRanges;
    const start = Math.min(editor.document.lineCount - 1, visible[0]?.start.line ?? 0);
    const end = Math.min(editor.document.lineCount - 1, visible[visible.length - 1]?.end.line ?? start);
    const section = sectionAtLine(page.sections, start)!;
    this.lastAgentContext = {
      active: editor === vscode.window.activeTextEditor,
      capturedAt: new Date().toISOString(), uri: editor.document.uri.toString(), bookId: address.bookId,
      bookTitle: this.books.get(address.bookId)?.info?.book_name || page.chapters[0].bookName || address.bookId,
      currentChapterId: section.itemId, currentChapterTitle: section.title,
      chapters: page.sections.map(section => ({ itemId: section.itemId, title: section.title, startLine: section.startLine + 1, endLine: section.endLine + 1 })),
      visible: { startLine: start + 1, endLine: end + 1, text: editor.document.getText(new vscode.Range(start, 0, end, editor.document.lineAt(end).text.length)) },
      selection: { startLine: editor.selection.start.line + 1, endLine: editor.selection.end.line + 1, text: editor.document.getText(editor.selection) },
      text: editor.document.getText(),
    };
  }

  async flush(): Promise<void> {
    await this.configurationTask;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    this.positions = Object.fromEntries(Object.entries(this.positions).sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, 200));
    const snapshot = { ...this.positions };
    this.positionWrites = this.positionWrites.catch(error => console.warn('[fanqie positions]', error))
      .then(async () => { await this.context.globalState.update(POSITIONS_KEY, snapshot); });
    await Promise.all([this.positionWrites, this.progressWrites]);
  }

  dispose(): void {
    if (this.disposed) return;
    if (vscode.window.activeTextEditor) this.savePosition(vscode.window.activeTextEditor);
    this.disposed = true;
    this.openSequence++;
    void this.flush().catch(error => console.warn('[fanqie dispose]', error));
    this.disposables.forEach(disposable => disposable.dispose());
    this.highlights.dispose();
    this.files.dispose();
  }
}

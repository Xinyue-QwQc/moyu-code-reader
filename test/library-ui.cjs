const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const { BOOK_ID, ITEMS, book, chapters, OTHER_BOOK_ID, OTHER_ITEMS, otherChapters } = require('./fixtures.cjs');
const { until, connectWebview } = require('./devtools.cjs');
const { listInstalledFonts, fontsForLanguage } = require('../out/reader/fonts');
const { setReaderFont } = require('../out/reader/appearance');
const { ChapterFileSystem, pageUri, chapterAddress } = require('../out/reader/documents');
const { codexAvailable, attachNovelSelection } = require('../out/agent/codex');
const store = require('../out/net/store');
const api = require('../out/api/fanqie');
const { broadcast } = require('../out/webview/router');

exports.run = async ({ reader, devtools, artifacts, report, check, set, fixtures }) => {
  async function clickWorkbench(expression) {
    const point = await until(() => devtools.evaluate(`(() => { const e = ${expression}; if (!e) return null; const r = e.getBoundingClientRect(); return r.height > 0 && {x:r.x+r.width/2,y:r.y+r.height/2}; })()`), 'workbench click target');
    await devtools.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await devtools.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  const filterPicker = text => devtools.evaluate(`(() => { const input = document.querySelector('.quick-input-widget .quick-input-box input'); input.value=${JSON.stringify(text)}; input.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);

  await reader.openBook(BOOK_ID, ITEMS[0]);
  await check('installed-font picker filters Chinese by actual glyphs, then a click changes only novel fonts', async () => {
    const fonts = await listInstalledFonts();
    const chinese = fontsForLanguage(fonts, 'chinese');
    assert.ok(chinese.length > 0 && chinese.length < fonts.length);
    assert.ok(!chinese.some(font => font.family === 'Consolas'));
    const preferred = chinese.find(font => font.family === 'Microsoft YaHei') || chinese[0];
    const ordinary = vscode.workspace.getConfiguration('editor', { languageId: 'json' }).get('fontFamily');
    const choosing = vscode.commands.executeCommand('fanqie.reader.font');
    await until(() => devtools.evaluate("document.querySelector('.quick-input-widget')?.textContent.includes('小说字体 · 中文')"), 'Chinese font picker');
    await until(() => devtools.evaluate("document.querySelector('.quick-input-widget input')?.placeholder.includes('已筛选')"), 'font list loaded');
    await filterPicker(preferred.displayName);
    await until(() => devtools.evaluate(`!![...document.querySelectorAll('.quick-input-widget .monaco-list-row')].find(e => e.textContent.includes(${JSON.stringify(preferred.displayName)}))`), 'chosen installed font');
    await devtools.screenshot(artifacts, 'font-picker-chinese');
    await clickWorkbench(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].find(e => e.textContent.includes(${JSON.stringify(preferred.displayName)}))`);
    await choosing;
    assert.equal(vscode.workspace.getConfiguration('editor', { languageId: 'fanqie-novel' }).get('fontFamily'), '"' + preferred.family + '"');
    assert.equal(vscode.workspace.getConfiguration('editor', { languageId: 'json' }).get('fontFamily'), ordinary);
    await until(async () => (await devtools.editor())?.fontFamily.includes(preferred.family), 'chosen font rendered');
    report.evidence.fonts = { installed: fonts.length, chinese: chinese.length, nonChinese: fontsForLanguage(fonts, 'other').length, clicked: preferred.family };
  });

  await check('non-Chinese novels get alphabetic fonts and cancelling a selector does not alter the font', async () => {
    otherChapters[0].paragraphs = ['A traveller opened the book beneath a quiet evening sky. '.repeat(30)];
    await reader.openBook(OTHER_BOOK_ID, OTHER_ITEMS[0]);
    const previous = vscode.workspace.getConfiguration('editor', { languageId: 'fanqie-novel' }).get('fontFamily');
    const choosing = vscode.commands.executeCommand('fanqie.reader.font');
    await until(() => devtools.evaluate("document.querySelector('.quick-input-widget')?.textContent.includes('小说字体 · 非中文')"), 'non-Chinese font picker');
    await filterPicker('Arial');
    await until(() => devtools.evaluate("[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].some(e=>e.textContent.includes('Arial'))"), 'alphabetic font available');
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await choosing;
    assert.equal(vscode.workspace.getConfiguration('editor', { languageId: 'fanqie-novel' }).get('fontFamily'), previous);
    await setReaderFont('fontFamily', undefined);
    await reader.openBook(BOOK_ID, ITEMS[0]);
  });

  await check('reader refresh refetches the complete page exactly once and preserves URI, cursor and position', async () => {
    await vscode.commands.executeCommand('fanqie.reader.pageSize', 3);
    const editor = vscode.window.activeTextEditor;
    const uri = editor.document.uri.toString();
    editor.selection = new vscode.Selection(64, 3, 64, 3);
    await vscode.commands.executeCommand('editorScroll', { to: 'up', by: 'line', value: editor.document.lineCount, revealCursor: false });
    await vscode.commands.executeCommand('editorScroll', { to: 'down', by: 'line', value: 60, revealCursor: false });
    await until(() => editor.visibleRanges[0]?.start.line === 60, 'refresh test initial position');
    await reader.flush();
    const before = ITEMS.slice(0, 3).map(id => fixtures.calls.get(id) || 0);
    const original = chapters[0].paragraphs[0];
    chapters[0].paragraphs[0] = '【已刷新】' + original;
    await Promise.all([vscode.commands.executeCommand('fanqie.reader.refresh'), vscode.commands.executeCommand('fanqie.reader.refresh')]);
    await until(() => editor.document.getText().includes('【已刷新】'), 'native readonly document refetched');
    assert.equal(vscode.window.activeTextEditor.document.uri.toString(), uri);
    assert.equal(editor.selection.active.line, 64);
    assert.equal(editor.selection.active.character, 3);
    await until(() => editor.visibleRanges[0]?.start.line === 60, 'refresh kept viewport');
    assert.deepEqual(ITEMS.slice(0, 3).map(id => fixtures.calls.get(id)), before.map(value => value + 1));
    assert.equal(vscode.workspace.fs.isWritableFileSystem('fanqie'), false);
    chapters[0].paragraphs[0] = original;
  });

  await check('failed refresh never publishes a partially fetched page or discards the cached original', async () => {
    const files = new ChapterFileSystem();
    const uri = pageUri(BOOK_ID, chapters.slice(0, 3), book.book_name, 3, 1);
    const original = await files.page(uri);
    fixtures.failures.set(ITEMS[1], 1);
    await assert.rejects(files.refresh(uri), /暂时不可用/);
    assert.equal((await files.page(uri)).text, original.text);
    const recovered = await files.refresh(uri);
    assert.equal(recovered.text, original.text);
    files.dispose();
  });

  await check('hidden text caret stays invisible after text clicks; current-line highlight disappears but pointer and selection work', async () => {
    const editor = vscode.window.activeTextEditor;
    const before = vscode.workspace.getConfiguration('workbench').inspect('colorCustomizations');
    const editorConfig = vscode.workspace.getConfiguration('editor', { languageId: 'fanqie-novel' });
    const originalLineStyle = editorConfig.inspect('renderLineHighlight').workspaceLanguageValue;
    const ordinaryDocument = await vscode.workspace.openTextDocument(path.join(artifacts, 'workspace', 'reference.json'));
    await vscode.commands.executeCommand('fanqie.reader.hideTextCursor');
    await until(() => vscode.workspace.getConfiguration('workbench').get('colorCustomizations')?.['editorCursor.foreground'] === '#00000000', 'caret overlay installed');
    for (let index = 0; index < 2; index++) await clickWorkbench("[...document.querySelectorAll('.monaco-editor .view-line')].find(e=>e.getBoundingClientRect().height>0)");
    await vscode.commands.executeCommand('cursorDown');
    await vscode.commands.executeCommand('cursorRight');
    assert.equal(vscode.workspace.getConfiguration('editor', { languageId: 'fanqie-novel' }).get('renderLineHighlight'), 'none');
    const invisible = await until(() => devtools.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.monaco-editor')].find(e=>e.getBoundingClientRect().height>80 && e.querySelector('.view-line'));
      if (!editor) return null;
      const cursor = editor.querySelector('.cursors-layer .cursor');
      const line = editor.querySelector('.current-line');
      if (!cursor) return null;
      const caretStyle=getComputedStyle(cursor), lineStyle=line ? getComputedStyle(line) : {backgroundColor:'rgba(0, 0, 0, 0)',borderColor:'rgba(0, 0, 0, 0)',borderWidth:'0px',borderStyle:'none'};
      const highlights=[...editor.querySelectorAll('.current-line')].map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {height:r.height,width:r.width,display:s.display,background:s.backgroundColor,borderWidth:s.borderWidth,borderStyle:s.borderStyle};});
      return {highlights, cursor:caretStyle.backgroundColor,border:caretStyle.borderColor,lineBackground:lineStyle.backgroundColor,lineBorder:lineStyle.borderColor,lineBorderWidth:lineStyle.borderWidth,lineBorderStyle:lineStyle.borderStyle,pointer:getComputedStyle(editor.querySelector('.view-lines')).cursor};
    })()`), 'hidden caret rendered');
    assert.ok(invisible.cursor.endsWith(', 0)'), JSON.stringify(invisible));
    assert.ok(invisible.border.endsWith(', 0)'), JSON.stringify(invisible));
    assert.ok(invisible.lineBackground.endsWith(', 0)'), JSON.stringify(invisible));
    assert.ok(invisible.lineBorder.endsWith(', 0)') || invisible.lineBorderWidth === '0px' || invisible.lineBorderStyle === 'none', JSON.stringify(invisible));
    assert.notEqual(invisible.pointer, 'none');
    assert.ok(invisible.highlights.every(line => line.width === 0 || line.height === 0 || line.display === 'none' || (line.background.endsWith(', 0)') && (line.borderWidth === '0px' || line.borderStyle === 'none'))), JSON.stringify(invisible.highlights));
    editor.selection = new vscode.Selection(2, 0, 2, 12);
    await until(() => !editor.selection.isEmpty, 'hidden caret still allows selection');
    const clipboard = await vscode.env.clipboard.readText();
    await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
    await until(async () => await vscode.env.clipboard.readText() === editor.document.getText(editor.selection), 'selection still copies');
    await vscode.env.clipboard.writeText(clipboard);
    await devtools.screenshot(artifacts, 'reader-hidden-text-caret');
    await vscode.window.showTextDocument(ordinaryDocument, { preview: false });
    await until(() => JSON.stringify(vscode.workspace.getConfiguration('workbench').inspect('colorCustomizations').workspaceValue) === JSON.stringify(before.workspaceValue), 'code editor original colors restored');
    await vscode.window.showTextDocument(editor.document, { preview: false });
    await until(() => vscode.workspace.getConfiguration('workbench').get('colorCustomizations')?.['editorCursor.foreground'] === '#00000000', 'novel hide mode retained');
    await vscode.commands.executeCommand('fanqie.reader.nextChapter');
    assert.equal(vscode.workspace.getConfiguration('editor', { languageId: 'fanqie-novel' }).get('renderLineHighlight'), 'none');
    await until(() => vscode.workspace.getConfiguration('workbench').get('colorCustomizations')?.['editorCursor.foreground'] === '#00000000', 'cursor hidden in next chapter');
    await vscode.commands.executeCommand('fanqie.reader.previousChapter');
    await vscode.commands.executeCommand('fanqie.reader.showTextCursor');
    await until(() => JSON.stringify(vscode.workspace.getConfiguration('workbench').inspect('colorCustomizations').workspaceValue) === JSON.stringify(before.workspaceValue), 'show cursor restores exact color settings');
    assert.equal(vscode.workspace.getConfiguration('fanqie.reader').get('hideTextCursor'), false);
    assert.equal(editorConfig.inspect('renderLineHighlight').workspaceLanguageValue, originalLineStyle);
    report.evidence.hiddenCaret = invisible;
  });

  await check('showing the cursor restores theme-specific colors without discarding unrelated user edits', async () => {
    const config = vscode.workspace.getConfiguration('workbench');
    const original = config.inspect('colorCustomizations').workspaceValue;
    const themeKey = '[' + config.get('colorTheme') + ']';
    const custom = { 'editorCursor.foreground': '#cceeaa', [themeKey]: { 'editorCursor.foreground': '#aaccee', 'editorLineNumber.foreground': '#778899' } };
    await config.update('colorCustomizations', custom, vscode.ConfigurationTarget.Workspace);
    try {
      await vscode.commands.executeCommand('fanqie.reader.hideTextCursor');
      const hidden = config.inspect('colorCustomizations').workspaceValue;
      assert.equal(hidden[themeKey]['editorCursor.foreground'], '#00000000');
      assert.equal(hidden[themeKey]['editorLineNumber.foreground'], '#778899');
      await config.update('colorCustomizations', { ...hidden, 'terminal.foreground': '#aabbcc' }, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('fanqie.reader.showTextCursor');
      assert.deepEqual(config.inspect('colorCustomizations').workspaceValue, { ...custom, 'terminal.foreground': '#aabbcc' });
    } finally {
      await vscode.commands.executeCommand('fanqie.reader.showTextCursor');
      await config.update('colorCustomizations', original, vscode.ConfigurationTarget.Workspace);
    }
  });

  await check('Codex action is absent when Codex is not installed and no selection file is generated', async () => {
    assert.equal(codexAvailable(), false);
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(2, 0, 2, 10);
    await assert.rejects(attachNovelSelection({}), /未检测到/);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    editor.revealRange(editor.selection);
    await vscode.commands.executeCommand('editor.action.showContextMenu');
    const menu = await until(() => devtools.menuText(), 'reader context menu');
    assert.ok(menu.includes('刷新当前阅读页'), menu);
    assert.ok(menu.includes('选择小说字体'), menu);
    assert.ok(!menu.includes('发送选中文字到 Codex'), menu);
    await devtools.screenshot(artifacts, 'reader-context-menu-no-codex');
    await devtools.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await devtools.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  });

  const user = { id: '9000000000', name: '智慧之神正在凝视你的测试用户', avatar: book.thumb_url, desc: '用于窄栏测试的个人签名', isVip: false };
  await store.setUser(user);
  const history = Array.from({ length: 16 }, (_, index) => ({ bookId: String(BigInt(BOOK_ID) + BigInt(index * 1000)), itemId: ITEMS[0], title: book.book_name + ' · ' + (index + 1), chapterTitle: chapters[0].title, author: '测试作者', coverUrl: book.thumb_url, readAt: Date.now() - index * 100000, order: 1 }));
  await store.setReadHistory(history);
  await store.setLocalShelf(history.map(item => ({ bookId: item.bookId, title: item.title, author: item.author, coverUrl: item.coverUrl, addedAt: item.readAt, lastReadAt: item.readAt, lastReadItemId: item.itemId, lastReadChapterTitle: item.chapterTitle })));
  let remoteCalls = 0;
  api.getUserInfo = async () => user;
  api.getRemoteBookshelf = async () => { remoteCalls++; return history.map(item => ({ book_id: item.bookId, title: item.title, author: item.author, cover_url: item.coverUrl, last_read_item_id: item.itemId, current_chapter_title: item.chapterTitle })); };
  await vscode.commands.executeCommand('fanqie.main.focus');
  const webview = await connectWebview(devtools, 'sidebar');
  const evaluate = webview.evaluate;
  await until(() => evaluate("document.querySelector('.nav-user')?.title.includes('智慧')"), 'logged-in sidebar ready');
  report.evidence.sidebarRegions = await devtools.evaluate("[...document.querySelectorAll('.part.sidebar, .monaco-sash.vertical')].map(e=>{const r=e.getBoundingClientRect();return {className:e.className,x:r.x,y:r.y,width:r.width,height:r.height}})");

  async function resizeSidebar(width) {
    const before = await evaluate('window.innerWidth');
    if (Math.abs(before - width) <= 3) return;
    const point = await devtools.evaluate(`(() => {
      const sidebar = document.querySelector('.part.sidebar').getBoundingClientRect();
      const edge = sidebar.right;
      const sashes = [...document.querySelectorAll('.monaco-sash.vertical')].map(e=>e.getBoundingClientRect()).filter(r=>r.height>200 && r.width>0);
      const sash = sashes.sort((a,b)=>Math.abs(a.x+a.width/2-edge)-Math.abs(b.x+b.width/2-edge))[0];
      return {x:sash.x+sash.width/2,y:sash.y+Math.min(150,sash.height/2)};
    })()`);
    await devtools.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await devtools.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await devtools.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + width - before, y: point.y, button: 'left', buttons: 1 });
    await devtools.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + width - before, y: point.y, button: 'left', clickCount: 1 });
    await until(async () => Math.abs(await evaluate('window.innerWidth') - width) <= 3, 'sidebar width ' + width);
  }
  async function nav(view) {
    await evaluate(`document.querySelector('[data-nav="${view}"]').click(); true`);
    await until(() => evaluate(`document.querySelector('#view')?.dataset.view === '${view}'`), 'sidebar navigation ' + view);
    if (view === 'login') await until(() => evaluate("document.querySelectorAll('.history-item').length === 16"), 'history loaded');
    if (view === 'shelf') await until(() => evaluate("document.querySelectorAll('.shelf-item').length === 16"), 'shelf loaded');
  }
  await check('sidebar stays readable at 200/260/360/480 px: horizontal navigation, search, account and history fit', async () => {
    report.evidence.widths = [];
    for (const width of [200, 260, 360, 480]) {
      await resizeSidebar(width);
      for (const view of ['search', 'login', 'shelf', 'bookstore']) {
        await nav(view);
        const layout = await evaluate(`(() => {
          const view = document.getElementById('view');
          const rects = [...document.querySelectorAll('.navbar button, .search-bar input, .search-bar .btn, .user-card, .history-item')].map(e=>{ const r=e.getBoundingClientRect(); return {text:e.textContent, x:r.x,right:r.right,width:r.width,height:r.height}; });
          return {width:innerWidth, bodyWidth:document.body.scrollWidth, viewWidth:view.clientWidth, scrollWidth:view.scrollWidth, navbarHeight:document.querySelector('.navbar').getBoundingClientRect().height, tabs:[...document.querySelectorAll('.nav-tab')].map(e=>e.getBoundingClientRect().height), rects};
        })()`);
        assert.ok(layout.navbarHeight < 100, JSON.stringify(layout));
        assert.ok(layout.tabs.every(height => height <= 36), 'navigation labels never vertical');
        assert.ok(layout.scrollWidth <= layout.viewWidth + 1, JSON.stringify(layout));
        assert.ok(layout.rects.every(rect => rect.x >= -1 && rect.right <= layout.width + 1), JSON.stringify(layout));
        if (view === 'search') assert.ok(layout.rects.find(rect => rect.text === '搜索' && rect.width > 0));
        report.evidence.widths.push({ width: layout.width, view, headerHeight: layout.navbarHeight, overflow: layout.scrollWidth - layout.viewWidth });
        if (width === 260 && ['search', 'login'].includes(view)) await devtools.screenshot(artifacts, 'sidebar-narrow-' + view);
      }
    }
  });

  await check('sidebar keeps search drafts and its document across hiding/showing instead of automatically reloading', async () => {
    await nav('search');
    await evaluate("globalThis.__persistentDocument = 'same-webview'; const input=document.getElementById('searchInput'); input.value='尚未提交的搜索草稿'; input.dispatchEvent(new Event('input',{bubbles:true})); input.focus(); true");
    const before = remoteCalls;
    await vscode.commands.executeCommand('workbench.view.explorer');
    await vscode.commands.executeCommand('fanqie.main.focus');
    assert.equal(await evaluate('globalThis.__persistentDocument'), 'same-webview');
    assert.equal(await evaluate("document.getElementById('searchInput').value"), '尚未提交的搜索草稿');
    assert.equal(remoteCalls, before);
  });

  await check('focus switches and chapter-progress notifications patch history in place with no cloud refetch or scroll reset', async () => {
    await nav('login');
    await evaluate("globalThis.__historyNode=document.getElementById('historyList'); globalThis.__rowNode=document.querySelector('.history-item'); globalThis.__progressMessages=[]; window.addEventListener('message', e=>{if(e.data?.type==='reading-progress-changed')globalThis.__progressMessages.push(e.data)}); document.getElementById('view').scrollTop=160; true");
    const before = remoteCalls;
    for (let index = 0; index < 5; index++) {
      await vscode.commands.executeCommand('fanqie.main.focus');
      await vscode.window.showTextDocument(vscode.window.activeTextEditor?.document || await vscode.workspace.openTextDocument(pageUri(BOOK_ID, chapters.slice(0, 3), book.book_name, 3, 1)), { preview: false });
    }
    await reader.flush();
    const messagesBefore = await evaluate('globalThis.__progressMessages.length');
    await reader.openBook(BOOK_ID, ITEMS[2]);
    await reader.flush();
    await until(() => evaluate(`document.querySelector('.history-item[data-book-id="${BOOK_ID}"]').dataset.itemId === '${ITEMS[2]}'`), 'history progress patched');
    assert.equal(remoteCalls, before);
    assert.equal(await evaluate("globalThis.__historyNode === document.getElementById('historyList')"), true);
    assert.equal(await evaluate("globalThis.__rowNode === document.querySelector('.history-item')"), true);
    assert.equal(await evaluate("document.getElementById('view').scrollTop"), 160);
    assert.equal(messagesBefore, 0, 'changing focus alone must not broadcast a new reading update');
    assert.equal(await evaluate('globalThis.__progressMessages.length'), 1);
  });

  await check('explicit library refresh does one requested fetch and retains current navigation', async () => {
    await nav('shelf');
    const origin = await devtools.evaluate("(() => { const r=document.querySelector('.part.sidebar').getBoundingClientRect(); return {x:r.x,y:r.y}; })()");
    await devtools.send('Input.dispatchMouseEvent', { type:'mousePressed',x:origin.x+40,y:origin.y+140,button:'right',clickCount:1 });
    await devtools.send('Input.dispatchMouseEvent', { type:'mouseReleased',x:origin.x+40,y:origin.y+140,button:'right',clickCount:1 });
    const contextMenu = await until(async () => { const text=await devtools.menuText(); return text.includes('番茄小说：刷新') && text; }, 'library native refresh context menu');
    report.evidence.libraryContextMenu = contextMenu;
    await devtools.screenshot(artifacts, 'sidebar-refresh-context-menu');
    await devtools.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await devtools.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    const before = remoteCalls;
    await vscode.commands.executeCommand('fanqie.library.refresh', { fanqieHost: 'sidebar' });
    await until(() => remoteCalls === before + 1, 'manual cloud shelf refresh');
    await until(() => evaluate("!document.getElementById('refreshView').disabled"), 'manual refresh complete');
    assert.equal(await evaluate("document.getElementById('view').dataset.view"), 'shelf');
    assert.equal(remoteCalls, before + 1);
    report.evidence.refresh = { cloudRequests: remoteCalls, automaticProgressRefetch: 0 };
  });
};

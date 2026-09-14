const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');
const { BOOK_ID, ITEMS, chapters, OTHER_BOOK_ID, OTHER_ITEMS, otherChapters, installFixtures } = require('./fixtures.cjs');
const { connect, until } = require('./devtools.cjs');
const { chapterText, readingPage, displayLine } = require('../out/reader/content');
const { chapterUri, chapterAddress, pageUri, ChapterFileSystem } = require('../out/reader/documents');
const api = require('../out/api/fanqie');
const store = require('../out/net/store');
const { setReaderFont } = require('../out/reader/appearance');

exports.run = async function run() {
  const artifacts = process.env.FANQIE_TEST_ARTIFACTS;
  const phase = process.env.FANQIE_TEST_PHASE || 'main';
  const fixtures = phase === 'live' ? undefined : installFixtures(api);
  const report = { phase, vscode: vscode.version, node: process.version, startedAt: new Date().toISOString(), tests: [], evidence: {} };
  let devtools;
  const check = async (name, action) => {
    try { await action(); report.tests.push({ name, passed: true }); console.log('PASS: ' + name); }
    catch (error) { report.tests.push({ name, passed: false, error: error.stack }); throw error; }
  };
  const config = vscode.workspace.getConfiguration();
  const set = (key, value) => config.update(key, value, vscode.ConfigurationTarget.Global);
  const scrollTo = async line => {
    const editor = vscode.window.activeTextEditor;
    await vscode.commands.executeCommand('editorScroll', { to: 'up', by: 'line', value: editor.document.lineCount, revealCursor: false });
    if (line > 0) await vscode.commands.executeCommand('editorScroll', { to: 'down', by: 'line', value: line, revealCursor: false });
  };
  const rendered = text => until(async () => {
    const editor = await devtools.editor();
    return editor && editor.lines.some(line => line.includes(text)) && editor;
  }, '正文已渲染：' + text);
  const colored = (text, color, opacity) => until(async () => {
    const editor = await devtools.editor();
    return editor?.spans.some(span => span.text.includes(text) && span.color === color && (opacity === undefined || span.opacity === opacity));
  }, '高亮实时更新：' + text + ' / ' + color);

  try {
    const extension = vscode.extensions.getExtension('zwb8926.fanqie-novel');
    assert.ok(extension, 'development extension was discovered');
    const reader = await extension.activate();
    devtools = await connect(process.env.FANQIE_TEST_DEBUG_PORT);
    await devtools.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');

    if (phase === 'codex') {
      await reader.openBook(BOOK_ID, ITEMS[0]);
      const codex = vscode.extensions.getExtension('openai.chatgpt');
      assert.ok(codex, 'installed Codex extension must be included explicitly');
      await check('reader attaches a real context file through the installed Codex command without submitting chat', async () => {
        const file = await vscode.commands.executeCommand('fanqie.agent.attachCodex');
        assert.ok(file && file.scheme === 'file');
        assert.ok((await fs.readFile(file.fsPath, 'utf8')).includes('reader.cjs'));
        report.evidence.codex = { version: codex.packageJSON.version, attachmentPath: file.fsPath,
          command: 'chatgpt.addFileToThread', modelRequestSent: false };
        const target = await until(async () => {
          const targets = await devtools.send('Target.getTargets');
          return targets.targetInfos.find(target => target.type === 'iframe' && target.url.includes('vscode-webview'));
        }, 'Codex Webview 初始化');
        const session = await devtools.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        await devtools.send('Runtime.enable', {}, session.sessionId);
        const frame = await until(async () => {
          const tree = await devtools.send('Page.getFrameTree', {}, session.sessionId);
          return tree.frameTree.childFrames?.[0]?.frame;
        }, 'Codex 内层内容框架');
        const isolated = await devtools.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'fanqie-test-receipt' }, session.sessionId);
        const evaluate = async expression => {
          const result = await devtools.send('Runtime.evaluate', { expression, contextId: isolated.executionContextId, returnByValue: true }, session.sessionId);
          if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
          return result.result.value;
        };
        const body = await until(() => evaluate('document.body.innerText.trim()'), 'Codex 登录页 / 聊天页渲染');
        report.evidence.codexPage = body;
        await evaluate("globalThis.__fanqieAttachments = []; window.addEventListener('message', event => { if (event.data?.type === 'add-context-file') globalThis.__fanqieAttachments.push(event.data.file); }); true");
        await vscode.commands.executeCommand('fanqie.agent.attachCodex');
        const received = await until(() => evaluate('globalThis.__fanqieAttachments[0]'), 'Codex 界面收到阅读上下文附件');
        assert.equal(received.fsPath, file.fsPath);
        assert.equal(received.label, 'current.md');
        report.evidence.attachmentDeliveredToCodexWebview = true;
        const targets = await (await fetch('http://127.0.0.1:' + process.env.FANQIE_TEST_DEBUG_PORT + '/json/list')).json();
        report.evidence.targets = targets.map(target => ({ type: target.type, title: target.title, url: target.url }));
        await devtools.screenshot(artifacts, 'codex-context-attachment');
      });
      return;
    }

    if (phase === 'live') {
      await check('real public Fanqie chapter opens as a native readonly document', async () => {
        await reader.openBook('7576659101376072728', '7576659313758831128');
        const editor = vscode.window.activeTextEditor;
        assert.equal(editor.document.uri.scheme, 'fanqie');
        assert.equal(editor.document.languageId, 'fanqie-novel');
        assert.ok(editor.document.lineCount > 5);
        assert.ok(!/[\uE000-\uF8FF]/.test(editor.document.getText()), 'chapter must be decoded, not PUA text');
        assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputText);
        report.evidence.live = { title: editor.document.lineAt(0).text, lines: editor.document.lineCount, readonly: !vscode.workspace.fs.isWritableFileSystem('fanqie') };
        await rendered(editor.document.lineAt(0).text);
        await devtools.screenshot(artifacts, 'reader-live-public-chapter');
      });
      await check('plugin agent interface fetches a real non-displayed chapter without changing the visible page', async () => {
        const currentUri = vscode.window.activeTextEditor.document.uri.toString();
        const directory = await reader.agent.invoke('directory', { bookId: '7576659101376072728', limit: 3 });
        const otherId = directory.chapters.find(chapter => chapter.itemId !== '7576659313758831128').itemId;
        const content = await reader.agent.invoke('read', { bookId: '7576659101376072728', itemIds: [otherId], limit: 2000 });
        assert.ok(content.text.length > 100);
        assert.equal(content.chapters[0].itemId, otherId);
        assert.equal(vscode.window.activeTextEditor.document.uri.toString(), currentUri);
        assert.ok(!Array.from(content.text).some(char => char.codePointAt(0) >= 0xE000 && char.codePointAt(0) <= 0xF8FF));
        report.evidence.liveAgentRead = { itemId: otherId, title: content.chapters[0].title, returnedCharacters: content.text.length, hasMore: content.hasMore };
      });
      await check('experimental code camouflage also renders a real public chapter without altering its content', async () => {
        const editor = vscode.window.activeTextEditor;
        const before = editor.document.getText();
        await set('fanqie.reader.experimental.codeCamouflage', 'dense');
        const css = await until(async () => {
          const css = await devtools.editor();
          return css && new Set(css.spans.map(span => span.color)).size >= 6 && css;
        }, '真实小说的实验多色渲染');
        assert.equal(editor.document.getText(), before);
        report.evidence.liveCamouflage = { colors: [...new Set(css.spans.map(span => span.color))], unchangedText: true };
        await devtools.screenshot(artifacts, 'reader-live-camouflage');
      });
      return;
    }

    if (phase === 'restore') {
      const expected = JSON.parse(await fs.readFile(path.join(artifacts, 'restore-expected.json'), 'utf8'));
      await check('cold provider opens persisted chapter URI after an extension-host restart', async () => {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(expected.uri));
        assert.equal(document.getText(), readingPage(expected.itemIds.map(id => chapters.find(chapter => chapter.itemId === id))).text);
        assert.equal(document.languageId, 'fanqie-novel');
        assert.equal(fixtures.calls.get(ITEMS[0]), 1);
        assert.equal(vscode.workspace.fs.isWritableFileSystem('fanqie'), false);
      });
      await check('reading history, cursor and top visible line survive a real VS Code restart', async () => {
        await reader.openBook(BOOK_ID);
        const editor = vscode.window.activeTextEditor;
        assert.equal(editor.document.uri.toString(), expected.uri);
        assert.equal(editor.selection.active.line, expected.line);
        assert.equal(editor.selection.active.character, expected.character);
        await until(() => Math.abs(editor.visibleRanges[0]?.start.line - expected.topLine) <= 1, '跨进程恢复滚动位置');
        await reader.flush();
        report.evidence.restored = { uri: editor.document.uri.toString(), line: editor.selection.active.line, topLine: editor.visibleRanges[0].start.line };
        await devtools.screenshot(artifacts, 'reader-after-restart');
      });
      return;
    }

    await check('extension registers native reading commands and filesystem', async () => {
      const commands = await vscode.commands.getCommands(true);
      for (const name of ['fanqie.openBook', 'fanqie.reader.menu', 'fanqie.reader.catalog', 'fanqie.reader.previousChapter', 'fanqie.reader.nextChapter', 'fanqie.reader.settings', 'fanqie.reader.toggleHighlight']) assert.ok(commands.includes(name), name);
      assert.equal(vscode.workspace.fs.isWritableFileSystem('fanqie'), false);
    });

    await check('a full chapter opens as a pinned native text tab, not a Webview', async () => {
      await reader.openBook(BOOK_ID, ITEMS[0]);
      const editor = vscode.window.activeTextEditor;
      assert.equal(editor.document.uri.scheme, 'fanqie');
      assert.equal(editor.document.languageId, 'fanqie-novel');
      assert.equal(editor.document.getText(), chapterText(chapters[0]));
      assert.equal(editor.document.lineCount, chapters[0].paragraphs.length + 3);
      assert.equal(editor.document.isDirty, false);
      assert.equal(editor.document.isUntitled, false);
      assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputText);
      assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab.isPreview, false);
      await rendered('第一章');
    });

    await check('readonly is enforced for normal editor input and filesystem writes', async () => {
      const editor = vscode.window.activeTextEditor;
      const original = editor.document.getText();
      // VS Code intentionally lets extension APIs edit readonly models; test the user's native input path.
      await vscode.commands.executeCommand('type', { text: 'SHOULD_NOT_APPEAR' });
      await assert.rejects(vscode.workspace.fs.writeFile(editor.document.uri, Buffer.from('SHOULD_NOT_APPEAR')));
      assert.equal(editor.document.getText(), original);
      assert.equal(editor.document.isDirty, false);
    });

    await check('rendered novel font, line height, background and editor chrome match an ordinary code tab', async () => {
      const novel = await devtools.editor();
      assert.ok(novel.hasLineNumbers);
      assert.ok(novel.hasMinimap);
      const reference = await vscode.workspace.openTextDocument(path.join(artifacts, 'workspace', 'reference.json'));
      await vscode.window.showTextDocument(reference, { preview: false });
      const code = await rendered('editor-layout-reference');
      for (const key of ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'background', 'hasLineNumbers', 'hasMinimap']) assert.deepEqual(novel[key], code[key], key);
      report.evidence.appearance = { code: Object.fromEntries(Object.entries(code).filter(([key]) => !['lines', 'spans'].includes(key))), novel: Object.fromEntries(Object.entries(novel).filter(([key]) => !['lines', 'spans'].includes(key))) };
      await devtools.screenshot(artifacts, 'code-reference-dark');
      await reader.openBook(BOOK_ID, ITEMS[0]);
      await rendered('第一章');
      report.evidence.statusItems = await devtools.evaluate("[...document.querySelectorAll('.statusbar-item')].map(el => ({id: el.id, text: el.textContent, visible: el.getBoundingClientRect().width > 0}))");
      await devtools.screenshot(artifacts, 'reader-dark');
    });

    await check('editor font changes propagate live without reflowing or paginating chapter text', async () => {
      const document = vscode.window.activeTextEditor.document;
      await set('editor.fontSize', 22);
      await set('editor.lineHeight', 34);
      await until(async () => { const css = await devtools.editor(); return css?.fontSize === '22px' && css?.lineHeight === '34px'; }, '原生字号行距实时继承');
      assert.equal(document.lineCount, chapters[0].paragraphs.length + 3);
      assert.equal(document.getText(), chapterText(chapters[0]));
      await set('editor.fontSize', 18);
      await set('editor.lineHeight', 27);
      await until(async () => { const css = await devtools.editor(); report.evidence.fontReset = css && {fontSize: css.fontSize, lineHeight: css.lineHeight}; return css?.fontSize === '18px' && css?.lineHeight === '27px'; }, '恢复编辑器字号行距');
    });

    await check('novel-specific family, size and line height use native overrides without changing code', async () => {
      const uri = vscode.window.activeTextEditor.document.uri;
      const ordinary = vscode.workspace.getConfiguration('editor', vscode.Uri.file(path.join(artifacts, 'workspace', 'reference.json')));
      const baseline = { family: ordinary.get('fontFamily'), size: ordinary.get('fontSize'), height: ordinary.get('lineHeight') };
      await setReaderFont('fontFamily', '"Courier New", "Microsoft YaHei", monospace', uri);
      await setReaderFont('fontSize', 23, uri);
      await setReaderFont('lineHeight', 36, uri);
      await until(async () => { const css = await devtools.editor(); return css?.fontSize === '23px' && css?.lineHeight === '36px' && css?.fontFamily.startsWith('"Courier New"'); }, '小说字体专属设置');
      const native = vscode.workspace.getConfiguration('editor', { uri, languageId: 'fanqie-novel' });
      assert.equal(native.get('fontSize'), 23);
      assert.equal(native.inspect('fontSize').globalLanguageValue, 23);
      const reference = await vscode.workspace.openTextDocument(path.join(artifacts, 'workspace', 'reference.json'));
      await vscode.window.showTextDocument(reference, { preview: false });
      const code = await rendered('editor-layout-reference');
      assert.equal(code.fontSize, '18px');
      assert.equal(code.lineHeight, '27px');
      assert.ok(code.fontFamily.startsWith('Consolas'));
      assert.deepEqual({ family: ordinary.get('fontFamily'), size: ordinary.get('fontSize'), height: ordinary.get('lineHeight') }, baseline);
      await reader.openBook(BOOK_ID, ITEMS[0]);
      await until(async () => (await devtools.editor())?.fontSize === '23px', '自定义字体返回后保持');
      await devtools.screenshot(artifacts, 'reader-custom-font');
      for (const option of ['fontFamily', 'fontSize', 'lineHeight']) await setReaderFont(option, undefined, uri);
      await until(async () => { const css = await devtools.editor(); return css?.fontSize === '18px' && css?.lineHeight === '27px' && css?.fontFamily.startsWith('Consolas'); }, '字体恢复原生继承');
    });

    await check('status-bar appearance menu exposes font and color controls, not a JSON-only setup', async () => {
      const appearance = vscode.commands.executeCommand('fanqie.reader.appearance');
      await until(() => devtools.evaluate("[...document.querySelectorAll('.quick-input-widget')].some(el => el.getBoundingClientRect().height > 0 && el.textContent.includes('字体与配色'))"), '阅读外观菜单');
      await devtools.screenshot(artifacts, 'reader-appearance-menu');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await appearance;
    });

    await check('palette, text color and optional line background only affect novel text', async () => {
      await set('fanqie.reader.appearance.preset', 'warm');
      await colored('雨停的时候', 'rgb(216, 206, 191)');
      await colored('你终于到了', 'rgb(221, 186, 140)');
      await set('fanqie.reader.appearance.foreground', '#BDD8C2');
      await set('fanqie.reader.appearance.lineBackground', '#242C31');
      await colored('雨停的时候', 'rgb(189, 216, 194)');
      await until(() => devtools.evaluate("[...document.querySelectorAll('.monaco-editor .cdr')].some(el => getComputedStyle(el).backgroundColor === 'rgb(36, 44, 49)')"), '可选正文行底色');
      await devtools.screenshot(artifacts, 'reader-custom-palette');
      const reference = await vscode.workspace.openTextDocument(path.join(artifacts, 'workspace', 'reference.json'));
      await vscode.window.showTextDocument(reference, { preview: false });
      const code = await rendered('editor-layout-reference');
      assert.equal(code.background, report.evidence.appearance.code.background);
      assert.ok(!code.spans.some(span => ['rgb(189, 216, 194)', 'rgb(221, 186, 140)'].includes(span.color)));
      assert.equal(await devtools.evaluate("[...document.querySelectorAll('.monaco-editor .cdr')].some(el => getComputedStyle(el).backgroundColor === 'rgb(36, 44, 49)')"), false);
      await reader.openBook(BOOK_ID, ITEMS[0]);
      for (const key of ['preset', 'foreground', 'lineBackground']) await set('fanqie.reader.appearance.' + key, undefined);
      await colored('你终于到了', 'rgb(206, 145, 120)');
    });

    await check('default dialogue highlighting is visible, with narration unchanged', async () => {
      await colored('你终于到了', 'rgb(206, 145, 120)');
      const css = await devtools.editor();
      assert.ok(css.spans.some(span => span.text.includes('雨停的时候') && span.color !== 'rgb(206, 145, 120)'));
    });

    await check('dialogue color/opacity, inner quotes and literal character names update immediately', async () => {
      await set('fanqie.reader.highlight.dialogue.color', '#8AD6B1');
      await set('fanqie.reader.highlight.dialogue.opacity', 0.7);
      await set('fanqie.reader.highlight.innerQuotes.enabled', true);
      await set('fanqie.reader.highlight.innerQuotes.color', '#C0A6EE');
      await set('fanqie.reader.highlight.keywords.words', ['林舟']);
      await set('fanqie.reader.highlight.keywords.color', '#E3C18D');
      await colored('你终于到了', 'rgb(138, 214, 177)', '0.7');
      await colored('如果明天放晴', 'rgb(192, 166, 238)');
      await colored('林舟', 'rgb(227, 193, 141)');
      await devtools.screenshot(artifacts, 'reader-custom-highlights');
    });

    await check('the highlight master switch removes every optional decoration', async () => {
      await vscode.commands.executeCommand('fanqie.reader.toggleHighlight');
      assert.equal(vscode.workspace.getConfiguration('fanqie.reader.highlight').get('enabled'), false);
      await until(async () => {
        const css = await devtools.editor();
        return css && !css.spans.some(span => ['rgb(138, 214, 177)', 'rgb(192, 166, 238)', 'rgb(227, 193, 141)'].includes(span.color));
      }, '关闭全部高亮');
      await devtools.screenshot(artifacts, 'reader-no-highlights');
      await vscode.commands.executeCommand('fanqie.reader.toggleHighlight');
      await colored('你终于到了', 'rgb(138, 214, 177)', '0.7');
      for (const key of ['dialogue.color', 'dialogue.opacity', 'innerQuotes.enabled', 'innerQuotes.color', 'keywords.words', 'keywords.color']) await set('fanqie.reader.highlight.' + key, undefined);
    });

    await check('default highlight colors follow light and dark themes with native backgrounds', async () => {
      await set('workbench.colorTheme', 'Default Light Modern');
      await colored('你终于到了', 'rgb(163, 21, 21)');
      await devtools.screenshot(artifacts, 'reader-light');
      await set('workbench.colorTheme', 'Default Dark Modern');
      await colored('你终于到了', 'rgb(206, 145, 120)');
    });

    await check('code camouflage is off by default and is directly discoverable from the status-bar settings', async () => {
      assert.equal(vscode.workspace.getConfiguration('fanqie.reader.experimental').get('codeCamouflage'), 'off');
      const appearance = vscode.commands.executeCommand('fanqie.reader.appearance');
      await until(() => devtools.evaluate("[...document.querySelectorAll('.quick-input-widget')].some(el => el.getBoundingClientRect().height > 0 && el.textContent.includes('实验性代码伪装配色'))"), '实验配色设置入口');
      await devtools.screenshot(artifacts, 'reader-camouflage-settings-entry');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await appearance;
      const chooser = vscode.commands.executeCommand('fanqie.reader.camouflage');
      await until(() => devtools.evaluate("[...document.querySelectorAll('.quick-input-widget')].some(el => el.getBoundingClientRect().height > 0 && el.textContent.includes('强伪装'))"), '平衡与强伪装两档');
      await devtools.screenshot(artifacts, 'reader-camouflage-options');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await chooser;
    });

    await check('balanced camouflage colors narrative phrases with real syntax tokens and a colorful native minimap', async () => {
      const editor = vscode.window.activeTextEditor;
      const original = { text: editor.document.getText(), uri: editor.document.uri.toString(), lines: editor.document.lineCount,
        selection: editor.selection, css: await devtools.editor() };
      const beforeMinimap = await devtools.minimapColors();
      await set('fanqie.reader.experimental.codeCamouflage', 'balanced');
      const styled = await until(async () => {
        const css = await devtools.editor();
        return css && new Set(css.spans.map(span => span.color)).size >= 6 && css;
      }, '叙述正文使用多种代码语法色');
      await colored('你终于到了', 'rgb(206, 145, 120)');
      const minimap = await until(async () => { const colors = await devtools.minimapColors(); return colors.length >= 4 && colors; }, '原生缩略图同步多色语法标记');
      assert.equal(editor.document.getText(), original.text);
      assert.equal(editor.document.uri.toString(), original.uri);
      assert.equal(editor.document.lineCount, original.lines);
      assert.deepEqual(editor.selection, original.selection);
      for (const key of ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'background']) assert.equal(styled[key], original.css[key], key);
      report.evidence.camouflage = { balancedColors: [...new Set(styled.spans.map(span => span.color))], minimapColorBuckets: minimap.length, normalMinimapColorBuckets: beforeMinimap.length };
      await devtools.screenshot(artifacts, 'reader-camouflage-balanced-dark');
    });

    await check('dense camouflage subdivides dialogue too, remains stable after scrolling and leaves code files untouched', async () => {
      const before = await devtools.editor();
      await set('fanqie.reader.experimental.codeCamouflage', 'dense');
      const dense = await until(async () => {
        const css = await devtools.editor();
        return css && css.spans.length > before.spans.length && !css.spans.some(span => span.text.includes('你终于到了')) && css;
      }, '对白细分多色');
      report.evidence.camouflage.denseColors = [...new Set(dense.spans.map(span => span.color))];
      await devtools.screenshot(artifacts, 'reader-camouflage-dense-dark');
      const initial = dense.spans;
      await scrollTo(100);
      await until(() => vscode.window.activeTextEditor.visibleRanges[0]?.start.line >= 99, '实验配色滚动');
      await scrollTo(0);
      await rendered('第一章');
      const returned = await devtools.editor();
      assert.deepEqual(returned.spans, initial, 'no random recoloring after scrolling');
      const reference = await vscode.workspace.openTextDocument(path.join(artifacts, 'workspace', 'reference.json'));
      await vscode.window.showTextDocument(reference, { preview: false });
      const code = await rendered('editor-layout-reference');
      assert.equal(code.fontSize, report.evidence.appearance.code.fontSize);
      assert.equal(code.background, report.evidence.appearance.code.background);
      assert.equal(vscode.workspace.getConfiguration('editor', { uri: reference.uri, languageId: 'json' }).inspect('semanticHighlighting.enabled').globalLanguageValue, undefined);
      await reader.openBook(BOOK_ID, ITEMS[0]);
      await rendered('第一章');
    });

    await check('experimental syntax uses the actual light-theme palette and retains explicit keyword overrides', async () => {
      await set('fanqie.reader.highlight.keywords.words', ['林舟']);
      await set('fanqie.reader.highlight.keywords.color', '#E3C18D');
      await colored('林舟', 'rgb(227, 193, 141)');
      await set('workbench.colorTheme', 'Default Light Modern');
      const css = await until(async () => {
        const css = await devtools.editor();
        return css && css.background !== report.evidence.appearance.code.background && new Set(css.spans.map(span => span.color)).size >= 6 && css;
      }, '实验代码色适配浅色主题');
      assert.ok(!css.spans.some(span => span.color === 'rgb(206, 145, 120)'), 'do not hardcode dark-theme string colors');
      await devtools.screenshot(artifacts, 'reader-camouflage-dense-light');
      await set('workbench.colorTheme', 'Default Dark Modern');
      for (const key of ['keywords.words', 'keywords.color']) await set('fanqie.reader.highlight.' + key, undefined);
    });

    await check('master switch pauses camouflage; disabling the experiment restores original custom reading colors', async () => {
      await set('fanqie.reader.highlight.dialogue.color', '#8AD6B1');
      await set('fanqie.reader.appearance.foreground', '#BDD8C2');
      await vscode.commands.executeCommand('fanqie.reader.toggleHighlight');
      await colored('雨停的时候', 'rgb(189, 216, 194)');
      assert.equal(vscode.workspace.getConfiguration('fanqie.reader.experimental').get('codeCamouflage'), 'dense');
      await vscode.commands.executeCommand('fanqie.reader.toggleHighlight');
      await until(async () => (await devtools.editor())?.spans.every(span => !span.text.includes('你终于到了')), '高亮总开关恢复实验配色');
      await set('fanqie.reader.experimental.codeCamouflage', 'off');
      await colored('你终于到了', 'rgb(138, 214, 177)');
      await colored('雨停的时候', 'rgb(189, 216, 194)');
      assert.equal(vscode.window.activeTextEditor.document.getText(), chapterText(chapters[0]));
      await devtools.screenshot(artifacts, 'reader-camouflage-disabled-restored');
      await set('fanqie.reader.highlight.dialogue.color', undefined);
      await set('fanqie.reader.appearance.foreground', undefined);
      await colored('你终于到了', 'rgb(206, 145, 120)');
      await until(async () => (await devtools.minimapColors()).length <= report.evidence.camouflage.normalMinimapColorBuckets + 1, '退出实验后缩略图恢复');
    });

    await check('a native semantic-highlighting opt-out falls back to normal reading colors instead of blanking highlights', async () => {
      const uri = vscode.window.activeTextEditor.document.uri;
      const native = vscode.workspace.getConfiguration('editor', { uri, languageId: 'fanqie-novel' });
      await set('fanqie.reader.experimental.codeCamouflage', 'dense');
      await native.update('semanticHighlighting.enabled', false, vscode.ConfigurationTarget.Global, true);
      await colored('你终于到了', 'rgb(206, 145, 120)');
      assert.equal(vscode.workspace.getConfiguration('fanqie.reader.experimental').get('codeCamouflage'), 'dense');
      await native.update('semanticHighlighting.enabled', undefined, vscode.ConfigurationTarget.Global, true);
      await until(async () => (await devtools.editor())?.spans.every(span => !span.text.includes('你终于到了')), '恢复原生语义高亮后继续实验配色');
      await set('fanqie.reader.experimental.codeCamouflage', 'off');
      await colored('你终于到了', 'rgb(206, 145, 120)');
    });

    await check('native selection, find, PageDown and scrolling keep one complete chapter open', async () => {
      const editor = vscode.window.activeTextEditor;
      const uri = editor.document.uri.toString();
      await vscode.commands.executeCommand('editor.action.selectAll');
      assert.equal(editor.document.getText(editor.selection), chapterText(chapters[0]));
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      await vscode.commands.executeCommand('actions.find');
      await until(() => devtools.evaluate("!!document.querySelector('.find-widget.visible')"), '原生查找组件');
      await vscode.commands.executeCommand('closeFindWidget');
      await vscode.commands.executeCommand('cursorPageDown');
      assert.ok(editor.selection.active.line > 0);
      await scrollTo(180);
      await until(() => editor.visibleRanges[0]?.start.line >= 179, '章节内原生滚动');
      assert.equal(editor.document.uri.toString(), uri);
      assert.equal(editor.document.getText(), chapterText(chapters[0]));
    });

    await check('next/previous chapter commands preserve cursor and scroll per chapter', async () => {
      let editor = vscode.window.activeTextEditor;
      editor.selection = new vscode.Selection(86, 4, 86, 4);
      await scrollTo(80);
      await until(() => editor.visibleRanges[0]?.start.line === 80, '记录章节内阅读位置');
      await reader.flush();
      await vscode.commands.executeCommand('fanqie.reader.nextChapter');
      assert.equal(vscode.window.activeTextEditor.document.getText(), chapterText(chapters[1]));
      await vscode.commands.executeCommand('fanqie.reader.previousChapter');
      editor = vscode.window.activeTextEditor;
      assert.equal(editor.selection.active.line, 86);
      assert.equal(editor.selection.active.character, 4);
      await until(() => Math.abs(editor.visibleRanges[0]?.start.line - 80) <= 1, '切章返回滚动位置');
      assert.equal(editor.document.getText(), chapterText(chapters[0]));
    });

    await check('failed chapter loads are retryable and do not replace the current document', async () => {
      const uri = vscode.window.activeTextEditor.document.uri.toString();
      fixtures.failures.set(ITEMS[2], 1);
      await assert.rejects(reader.openBook(BOOK_ID, ITEMS[2]), /测试网络暂时不可用/);
      assert.equal(vscode.window.activeTextEditor.document.uri.toString(), uri);
      await reader.openBook(BOOK_ID, ITEMS[2]);
      assert.equal(vscode.window.activeTextEditor.document.getText(), chapterText(chapters[2]));
      assert.equal(fixtures.calls.get(ITEMS[2]), 2);
    });

    await check('a slower earlier request cannot overwrite the later chapter selection', async () => {
      const release = fixtures.defer(ITEMS[3]);
      const earlier = reader.openBook(BOOK_ID, ITEMS[3]);
      try {
        await until(() => fixtures.calls.get(ITEMS[3]) === 1, '慢请求已启动');
        await reader.openBook(BOOK_ID, ITEMS[4]);
      } finally { release(); }
      await earlier;
      assert.equal(vscode.window.activeTextEditor.document.getText(), chapterText(chapters[4]));
    });

    await check('parallel filesystem reads share a fetch and reject mismatched chapter data', async () => {
      const uri = chapterUri(BOOK_ID, chapters[5]);
      const [one, two] = await Promise.all([vscode.workspace.fs.readFile(uri), vscode.workspace.fs.readFile(uri)]);
      assert.equal(Buffer.from(one).toString(), chapterText(chapters[5]));
      assert.equal(Buffer.from(two).toString(), chapterText(chapters[5]));
      assert.equal(fixtures.calls.get(ITEMS[5]), 1);
      fixtures.mismatches.add(ITEMS[6]);
      await assert.rejects(reader.openBook(BOOK_ID, ITEMS[6]), /不一致/);
      fixtures.mismatches.delete(ITEMS[6]);
      await reader.openBook(BOOK_ID, ITEMS[6]);
      assert.equal(fixtures.calls.get(ITEMS[6]), 2);
      await assert.rejects(reader.openBook('not-a-book'), /有效/);
    });

    await check('an incomplete multi-chapter fetch never exposes a partial page and succeeds on retry', async () => {
      const provider = new ChapterFileSystem();
      const uri = pageUri(BOOK_ID, chapters.slice(6), undefined, 3);
      const active = vscode.window.activeTextEditor.document.uri.toString();
      fixtures.failures.set(ITEMS[7], 1);
      try {
        await assert.rejects(provider.readFile(uri), /测试网络暂时不可用/);
        assert.equal(provider.peekPage(uri), undefined);
        const bytes = await provider.readFile(uri);
        assert.equal(Buffer.from(bytes).toString(), readingPage(chapters.slice(6)).text);
        assert.equal(vscode.window.activeTextEditor.document.uri.toString(), active);
        for (const query of [
          'bookId=' + BOOK_ID + '&itemId=' + ITEMS[0] + '&itemIds=' + ITEMS[0] + ',' + ITEMS[0],
          'bookId=' + BOOK_ID + '&itemId=' + ITEMS[0] + '&pageSize=51',
          'bookId=' + BOOK_ID + '&itemId=' + ITEMS[0] + '&itemIds=' + ITEMS[1],
        ]) assert.equal(chapterAddress(uri.with({ query })), undefined);
      } finally { provider.dispose(); }
    });

    await check('catalog uses a native searchable Quick Pick and selecting a chapter opens text', async () => {
      const catalog = vscode.commands.executeCommand('fanqie.reader.catalog');
      await until(() => devtools.evaluate("[...document.querySelectorAll('.quick-input-widget')].some(el => el.getBoundingClientRect().height > 0 && el.textContent.includes('目录'))"), '原生章节目录');
      await devtools.screenshot(artifacts, 'reader-catalog');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await catalog;
      assert.equal(vscode.window.activeTextEditor.document.getText(), chapterText(chapters[0]));
    });

    await check('the status-bar settings command opens discoverable, real VS Code settings', async () => {
      await vscode.commands.executeCommand('fanqie.reader.settings');
      await until(() => devtools.evaluate("[...document.querySelectorAll('.settings-editor')].some(el => el.getBoundingClientRect().height > 0 && el.textContent.includes('高亮'))"), '原生高亮设置页面');
      await devtools.screenshot(artifacts, 'reader-settings');
      await reader.openBook(BOOK_ID, ITEMS[0]);
    });

    await check('library initialization waits for the actual Webview ready message', async () => {
      await vscode.commands.executeCommand('fanqie.search');
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(tab.input instanceof vscode.TabInputWebview);
      assert.equal(tab.label, '番茄书城');
      await vscode.commands.executeCommand('fanqie.openBook', BOOK_ID, ITEMS[0]);
      assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputText);
      assert.equal(vscode.window.activeTextEditor.document.getText(), chapterText(chapters[0]));
    });

    await check('history and shelf update locally, and closing/reopening resumes the latest chapter', async () => {
      await reader.flush();
      await until(async () => (await store.getReadHistory())[0]?.itemId === ITEMS[0], '本地历史更新');
      const shelf = await store.getLocalShelf();
      assert.equal(shelf.find(book => book.bookId === BOOK_ID).lastReadItemId, ITEMS[0]);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await reader.openBook(BOOK_ID);
      assert.equal(vscode.window.activeTextEditor.document.getText(), chapterText(chapters[0]));
    });

    await check('status-bar page size immediately groups complete chapters into a single readonly file', async () => {
      await vscode.commands.executeCommand('fanqie.reader.pageSize', 3);
      await until(() => chapterAddress(vscode.window.activeTextEditor?.document.uri)?.itemIds.length === 3, '状态栏每页三章生效');
      const editor = vscode.window.activeTextEditor;
      assert.deepEqual(chapterAddress(editor.document.uri).itemIds, ITEMS.slice(0, 3));
      assert.equal(editor.document.getText(), readingPage(chapters.slice(0, 3)).text);
      assert.equal(editor.document.isDirty, false);
      const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', editor.document.uri);
      assert.equal(symbols.length, 3);
      assert.deepEqual(symbols.map(symbol => symbol.name), chapters.slice(0, 3).map(chapter => chapter.title));
      await until(() => devtools.evaluate("[...document.querySelectorAll('.statusbar-item')].some(el => el.textContent.includes('每页 3 章') && el.getBoundingClientRect().width > 0)"), '底部每页章节数入口');
      await devtools.screenshot(artifacts, 'reader-three-chapters');
    });

    await check('the native minimap remains available for novel pages even when ordinary editors disable it', async () => {
      await set('editor.minimap.enabled', false);
      await until(async () => (await devtools.editor())?.hasMinimap, '小说原生缩略图保留');
      const uri = vscode.window.activeTextEditor.document.uri;
      assert.equal(vscode.workspace.getConfiguration('editor', { uri, languageId: 'fanqie-novel' }).get('minimap.enabled'), true);
      const reference = await vscode.workspace.openTextDocument(path.join(artifacts, 'workspace', 'reference.json'));
      await vscode.window.showTextDocument(reference, { preview: false });
      await rendered('editor-layout-reference');
      await until(async () => !(await devtools.editor())?.hasMinimap, '不改普通代码缩略图设置');
      await set('editor.minimap.enabled', true);
      await reader.openBook(BOOK_ID, ITEMS[0]);
    });

    await check('multi-chapter next/previous pages have no omissions and the last page has only remaining chapters', async () => {
      await vscode.commands.executeCommand('fanqie.reader.nextChapter');
      assert.deepEqual(chapterAddress(vscode.window.activeTextEditor.document.uri).itemIds, ITEMS.slice(3, 6));
      assert.equal(vscode.window.activeTextEditor.document.getText(), readingPage(chapters.slice(3, 6)).text);
      await vscode.commands.executeCommand('fanqie.reader.nextChapter');
      assert.deepEqual(chapterAddress(vscode.window.activeTextEditor.document.uri).itemIds, ITEMS.slice(6));
      assert.equal(vscode.window.activeTextEditor.document.getText(), readingPage(chapters.slice(6)).text);
      await vscode.commands.executeCommand('fanqie.reader.previousChapter');
      assert.deepEqual(chapterAddress(vscode.window.activeTextEditor.document.uri).itemIds, ITEMS.slice(3, 6));
    });

    await check('scrolling within a combined file records the visible chapter, not always its first chapter', async () => {
      await reader.openBook(BOOK_ID, ITEMS[0]);
      const page = readingPage(chapters.slice(0, 3));
      const editor = vscode.window.activeTextEditor;
      const top = page.sections[1].startLine + 80;
      editor.selection = new vscode.Selection(top + 6, 4, top + 6, 4);
      await scrollTo(top);
      await until(() => editor.visibleRanges[0]?.start.line === top, '滚到合并文件第二章');
      await reader.flush();
      await until(async () => (await store.getReadHistory())[0]?.itemId === ITEMS[1], '合并页记录实际章节');
    });

    await check('changing page size preserves chapter-relative reading position across new page boundaries', async () => {
      await vscode.commands.executeCommand('fanqie.reader.pageSize', 1);
      await until(() => chapterAddress(vscode.window.activeTextEditor.document.uri).itemIds.length === 1, '改回单章文件');
      let editor = vscode.window.activeTextEditor;
      assert.equal(chapterAddress(editor.document.uri).itemId, ITEMS[1]);
      assert.equal(editor.selection.active.line, 86);
      await until(() => editor.visibleRanges[0]?.start.line === 80, '合并页拆分后位置不丢失');
      await vscode.commands.executeCommand('fanqie.reader.pageSize', 5);
      await until(() => chapterAddress(vscode.window.activeTextEditor.document.uri).itemIds.length === 5, '改成五章文件');
      editor = vscode.window.activeTextEditor;
      const section = readingPage(chapters.slice(0, 5)).sections[1];
      assert.equal(editor.selection.active.line, section.startLine + 86);
      await until(() => editor.visibleRanges[0]?.start.line === section.startLine + 80, '合并五章后保持同一阅读位置');
      await vscode.commands.executeCommand('fanqie.reader.pageSize', 3);
      await until(() => chapterAddress(vscode.window.activeTextEditor.document.uri).itemIds.length === 3, '恢复三章布局');
    });

    await check('jumping to an interior chapter locates its text rather than the beginning of its grouped file', async () => {
      await reader.openBook(BOOK_ID, ITEMS[2]);
      const section = readingPage(chapters.slice(0, 3)).sections[2];
      const editor = vscode.window.activeTextEditor;
      assert.equal(chapterAddress(editor.document.uri).itemId, ITEMS[0]);
      assert.ok(editor.selection.active.line >= section.startLine);
      await until(() => editor.visibleRanges[0]?.start.line >= section.startLine, '跳转页内第三章');
      await devtools.screenshot(artifacts, 'reader-third-chapter-in-one-file');
    });

    await check('paragraph spacing is a separate setting that preserves text and canonical reading position', async () => {
      await reader.openBook(BOOK_ID, ITEMS[1]);
      const before = readingPage(chapters.slice(0, 3));
      const start = before.sections[1].startLine;
      let editor = vscode.window.activeTextEditor;
      editor.selection = new vscode.Selection(start + 86, 4, start + 86, 4);
      await scrollTo(start + 80);
      await until(() => editor.visibleRanges[0]?.start.line === start + 80, '准备段间距变更');
      await reader.flush();
      await set('fanqie.reader.paragraphSpacing', 2);
      await until(() => chapterAddress(vscode.window.activeTextEditor.document.uri)?.paragraphSpacing === 2, '独立段间距生效');
      editor = vscode.window.activeTextEditor;
      const spaced = readingPage(chapters.slice(0, 3), 2);
      const section = spaced.sections[1];
      assert.equal(editor.document.getText(), spaced.text);
      assert.equal(editor.selection.active.line, displayLine(section, 86));
      await until(() => editor.visibleRanges[0]?.start.line === displayLine(section, 80), '段间距修改后位置保持');
      assert.equal((await devtools.editor()).lineHeight, '27px', 'line spacing remains independent');
      await devtools.screenshot(artifacts, 'reader-paragraph-spacing');
      await set('fanqie.reader.paragraphSpacing', 0);
      await until(() => chapterAddress(vscode.window.activeTextEditor.document.uri)?.paragraphSpacing === 0, '恢复段间距');
    });

    await check('plugin-owned native agent tools are registered and return current editor context', async () => {
      const names = ['fanqie_reading_context', 'fanqie_search_books', 'fanqie_book_directory', 'fanqie_read_chapters'];
      for (const name of names) assert.ok(vscode.lm.tools.some(tool => tool.name === name), name);
      const editor = vscode.window.activeTextEditor;
      const line = editor.selection.active.line;
      editor.selection = new vscode.Selection(line, 0, line, editor.document.lineAt(line).text.length);
      const result = await vscode.lm.invokeTool('fanqie_reading_context', { input: { scope: 'selection' }, toolInvocationToken: undefined });
      const context = JSON.parse(result.content[0].value);
      assert.equal(context.available, true);
      assert.equal(context.active, true);
      assert.equal(context.bookId, BOOK_ID);
      assert.equal(context.text, editor.document.getText(editor.selection));
      assert.equal(context.scope, 'selection');
    });

    await check('agents can search, list and read a completely different unopened book without changing tabs or history', async () => {
      await reader.flush();
      const uri = vscode.window.activeTextEditor.document.uri.toString();
      const history = await store.getReadHistory();
      const search = await reader.agent.invoke('search', { query: '港口' });
      assert.equal(search.books[0].bookId, OTHER_BOOK_ID);
      const directory = await reader.agent.invoke('directory', { bookId: OTHER_BOOK_ID, limit: 1 });
      assert.equal(directory.total, 2);
      assert.equal(directory.nextOffset, 1);
      assert.equal(directory.chapters[0].itemId, OTHER_ITEMS[0]);
      const tool = await vscode.lm.invokeTool('fanqie_read_chapters', { input: { bookId: OTHER_BOOK_ID, startChapter: 2 }, toolInvocationToken: undefined });
      const content = JSON.parse(tool.content[0].value);
      assert.equal(content.text, chapterText(otherChapters[1]));
      assert.equal(content.complete, true);
      assert.equal(vscode.window.activeTextEditor.document.uri.toString(), uri);
      await reader.flush();
      // Native editor focus/layout events may refresh readAt while a tool runs. Only book/chapter state is invariant.
      const readingState = items => items.map(({ readAt, ...state }) => state);
      assert.deepEqual(readingState(await store.getReadHistory()), readingState(history));
      const partial = await reader.agent.invoke('context', { scope: 'page', limit: 100 });
      assert.equal(partial.hasMore, true);
      assert.equal(partial.complete, false);
      const continuation = await reader.agent.invoke('context', { scope: 'page', offset: partial.nextOffset, limit: 100 });
      assert.equal(partial.text + continuation.text, vscode.window.activeTextEditor.document.getText().slice(0, 200));
    });

    await check('file-based agents get a real context file and can fetch unseen chapters through the bundled client', async () => {
      const file = await reader.agent.contextFile();
      assert.equal(file.scheme, 'file');
      const text = await fs.readFile(file.fsPath, 'utf8');
      assert.ok(text.includes(BOOK_ID));
      assert.ok(text.includes('reader.cjs'));
      assert.ok(text.includes('未展示章节'));
      const client = path.join(path.dirname(file.fsPath), 'reader.cjs');
      const result = await new Promise((resolve, reject) => {
        const child = spawn('node', [client, 'read', '--book-id', OTHER_BOOK_ID, '--start-chapter', '1'], { windowsHide: true });
        let output = '', error = '';
        child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
        child.on('error', reject); child.on('exit', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
      });
      assert.equal(result.text, chapterText(otherChapters[0]));
      const descriptor = JSON.parse(await fs.readFile(path.join(path.dirname(file.fsPath), 'bridge.json'), 'utf8'));
      assert.ok(!text.includes(descriptor.token));
      assert.ok(!text.includes('fanqie.cookies'));
      report.evidence.agentBridge = { localFile: true, clientReadUnopenedBook: true, nativeToolNames: vscode.lm.tools.filter(tool => tool.name.startsWith('fanqie_')).map(tool => tool.name) };
      const reference = await vscode.workspace.openTextDocument(path.join(artifacts, 'workspace', 'reference.json'));
      await vscode.window.showTextDocument(reference, { preview: false });
      const previous = await reader.agent.invoke('context', { scope: 'page', limit: 100 });
      assert.equal(previous.active, false);
      assert.equal(previous.bookId, BOOK_ID);
      assert.ok(!previous.text.includes('editor-layout-reference'));
      await reader.openBook(BOOK_ID, ITEMS[1]);
    });

    await check('AI access can be disabled without exposing stale context or mutating agent configuration', async () => {
      const file = await reader.agent.contextFile();
      await set('fanqie.reader.agent.enabled', false);
      await assert.rejects(reader.agent.invoke('context'), /已关闭/);
      await until(async () => { try { await fs.access(file.fsPath); return false; } catch { return true; } }, '关闭AI访问后删除本次上下文副本');
      await set('fanqie.reader.agent.enabled', true);
      assert.ok((await reader.agent.invoke('context')).available);
    });

    await check('persist a cursor and viewport for an independent cold-start verification', async () => {
      await reader.openBook(BOOK_ID, ITEMS[1]);
      const editor = vscode.window.activeTextEditor;
      const start = readingPage(chapters.slice(0, 3)).sections[1].startLine;
      editor.selection = new vscode.Selection(start + 86, 4, start + 86, 4);
      await scrollTo(start + 80);
      await until(() => editor.visibleRanges[0]?.start.line === start + 80, '写入跨进程恢复位置');
      await reader.flush();
      await fs.writeFile(path.join(artifacts, 'restore-expected.json'), JSON.stringify({ uri: editor.document.uri.toString(), itemIds: ITEMS.slice(0, 3), line: start + 86, character: 4, topLine: start + 80 }));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await reader.flush();
    });
  } catch (error) {
    report.error = error.stack;
    try { if (devtools) await devtools.screenshot(artifacts, phase + '-failure'); } catch (captureError) { report.evidence.captureError = captureError.message; }
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(artifacts, phase + '-results.json'), JSON.stringify(report, null, 2));
    devtools?.close();
  }
};

/** 番茄小说：书城用 Webview，正文使用真正的 VS Code 只读代码编辑器。 */
import * as vscode from 'vscode';
import { initStore, loadPersisted, getUser } from './net/store';
import { openPanel, disposePanel, openBookInPanel } from './webview/panel';
import { FanqieSidebarProvider } from './webview/sidebar';
import { broadcast, setOpenBookInEditorHandler } from './webview/router';
import { NativeReader } from './reader/reader';
import { chapterAddress } from './reader/documents';
import { ReaderAgentAccess } from './agent/access';

let reader: NativeReader | undefined;
let agentAccess: ReaderAgentAccess | undefined;

export async function activate(context: vscode.ExtensionContext) {
  initStore(context);
  await loadPersisted();
  reader = new NativeReader(context, {
    openLibrary: view => openPanel(context, view),
    openDetails: bookId => openBookInPanel(context, bookId),
    openComments: bookId => openBookInPanel(context, bookId, 'comments'),
    onProgressChanged: () => broadcast({ type: 'reading-progress-changed' }),
  });
  agentAccess = new ReaderAgentAccess(context, reader);
  context.subscriptions.push(reader, agentAccess);
  const nativeReader = reader;
  setOpenBookInEditorHandler((bookId, mode, itemId) => mode === 'reader'
    ? nativeReader.openBook(bookId, itemId)
    : openBookInPanel(context, bookId));

  const sidebarProvider = new FanqieSidebarProvider(context.extensionUri);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(FanqieSidebarProvider.viewType, sidebarProvider));
  const register = (cmd: string, fn: (...args: any[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(cmd, async (...args: any[]) => {
      try { return await fn(...args); }
      catch (error) { await vscode.window.showErrorMessage('番茄小说：' + (error instanceof Error ? error.message : String(error))); }
    }));
  };
  register('fanqie.open', () => openPanel(context));
  register('fanqie.search', () => openPanel(context, 'search'));
  register('fanqie.login', () => openPanel(context, 'login'));
  register('fanqie.openBook', async (id?: string, itemId?: string) => {
    const bookId = id ?? await vscode.window.showInputBox({
      prompt: '输入番茄小说书籍 ID，直接在原生编辑器中阅读（自动续读）',
      placeHolder: '例如 7576659101376072728',
      validateInput: value => /^\d{10,}$/.test(value.trim()) ? undefined : '请输入合法的书籍 ID（纯数字）',
    });
    if (bookId) await nativeReader.openBook(bookId.trim(), itemId);
  });

  // The library entry remains available when no novel is active; reader controls own this space otherwise.
  const statusItem = vscode.window.createStatusBarItem('fanqie.library', vscode.StatusBarAlignment.Right, 100);
  statusItem.name = '番茄小说书城';
  statusItem.command = 'fanqie.open';
  context.subscriptions.push(statusItem);
  const refreshStatus = async () => {
    const user = await getUser();
    statusItem.text = '$(book) 番茄小说';
    statusItem.tooltip = user ? '番茄小说：' + user.name + '（点击打开书城）' : '番茄小说（点击打开书城，未登录）';
    if (vscode.window.activeTextEditor && chapterAddress(vscode.window.activeTextEditor.document.uri)) statusItem.hide();
    else statusItem.show();
  };
  void refreshStatus();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => void refreshStatus()),
    vscode.window.onDidChangeWindowState(() => void refreshStatus()),
    { dispose: disposePanel },
  );
  return { openBook: (bookId: string, itemId?: string) => nativeReader.openBook(bookId, itemId), flush: () => nativeReader.flush(),
    agent: { invoke: (action: string, input?: unknown) => agentAccess!.service.invoke(action, input), contextFile: () => agentAccess!.contextFile() } };
}

export async function deactivate(): Promise<void> {
  setOpenBookInEditorHandler(undefined);
  agentAccess?.dispose();
  await agentAccess?.stop();
  agentAccess = undefined;
  reader?.dispose();
  await reader?.flush();
  reader = undefined;
  disposePanel();
}

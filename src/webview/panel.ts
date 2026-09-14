/** The Webview now hosts only the library, account, book details and reviews. */
import * as vscode from 'vscode';
import { buildHtml } from './html';
import { attachRouter } from './router';

let current: { panel: vscode.WebviewPanel; ready: Promise<boolean> } | undefined;

async function revealPanel(context: vscode.ExtensionContext): Promise<vscode.WebviewPanel | undefined> {
  if (!current) {
    const panel = vscode.window.createWebviewPanel('fanqie', '番茄书城', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    let ready!: (value: boolean) => void;
    const state = { panel, ready: new Promise<boolean>(resolve => { ready = resolve; }) };
    current = state;
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'fanqie.svg');
    // Register the handshake before assigning HTML. No arbitrary 350/400ms opening race.
    const router = attachRouter(panel.webview, () => ready(true));
    panel.onDidDispose(() => {
      router.dispose();
      ready(false);
      if (current === state) current = undefined;
    });
    panel.webview.html = buildHtml(panel.webview, context.extensionUri, 'panel');
  } else {
    current.panel.reveal(vscode.ViewColumn.Active);
  }
  const state = current;
  return await state.ready && current === state ? state.panel : undefined;
}

export async function openPanel(context: vscode.ExtensionContext, view?: string): Promise<void> {
  const panel = await revealPanel(context);
  if (view) await panel?.webview.postMessage({ type: 'nav', view });
}

export async function openBookInPanel(context: vscode.ExtensionContext, bookId: string, mode: 'modal' | 'comments' = 'modal'): Promise<void> {
  const panel = await revealPanel(context);
  await panel?.webview.postMessage({ type: mode === 'comments' ? 'open-book-comments' : 'open-book', bookId });
}

export function disposePanel(): void { current?.panel.dispose(); current = undefined; }

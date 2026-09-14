/**
 * 侧边栏视图（活动栏入口）：与面板共用同一套 SPA 与消息路由。
 */
import * as vscode from 'vscode';
import { buildHtml } from './html';
import { attachRouter } from './router';

export class FanqieSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'fanqie.main';

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    const disp = attachRouter(view.webview);
    view.webview.html = buildHtml(view.webview, this.extensionUri, 'sidebar');
    view.onDidDispose(() => disp.dispose());
  }
}

/**
 * 生成 Webview HTML：CSP 严格限制，仅允许本地脚本/样式与 HTTPS 图片。
 */
import * as vscode from 'vscode';

export function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri, host: 'panel' | 'sidebar' = 'panel'): string {
  const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
  const csp = [
    "default-src 'none'",
    `script-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} https: data:`,
    `font-src ${webview.cspSource} https: data:`,
    `connect-src https:`,
  ].join('; ');
  // 资源版本号：每次扩展加载时变一下，强制 webview 拉新资源（避免更新 vsix 后旧 app.js / style.css 被缓存）
  const v = String(Date.now());

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>fanqie</title>
<link rel="stylesheet" href="${media('style.css')}?v=${v}">
</head>
<body data-host="${host}" data-vscode-context='{"webviewSection":"fanqieLibrary","fanqieHost":"${host}"}'>
<div id="app">
  <div id="loading" class="loading">加载中…</div>
</div>
<script src="${media('vendor/qrcode.js')}?v=${v}"></script>
<script src="${media('app.js')}?v=${v}"></script>
</body>
</html>`;
}

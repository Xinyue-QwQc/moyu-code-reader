// CDP is restricted to the isolated development host launched by test-vscode.mjs.
// It verifies rendered CSS and captures evidence; it never connects to the user's VS Code window.
const fs = require('node:fs/promises');
const path = require('node:path');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(condition, label, timeout = 15000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeout) {
    try { const result = await condition(); if (result) return result; }
    catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error('等待验证条件失败：' + label + (lastError ? '\n' + lastError.stack : ''));
}

async function connect(port, choose) {
  const target = await until(async () => {
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    return targets.find(choose || (target => target.type === 'page' && target.url.includes('workbench.html')));
  }, '独立 VS Code DevTools target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP response missing: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  return {
    send, evaluate,
    async editor() {
      return evaluate(`(() => {
        const editor = [...document.querySelectorAll('.monaco-editor')].find(el => el.getBoundingClientRect().width > 100 && el.getBoundingClientRect().height > 80 && el.querySelector('.view-line'));
        if (!editor) return null;
        const lines = editor.querySelector('.view-lines');
        const line = editor.querySelector('.view-line');
        const style = getComputedStyle(lines);
        const background = editor.querySelector('.monaco-editor-background');
        return {
          fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: getComputedStyle(line).lineHeight,
          letterSpacing: style.letterSpacing, background: background ? getComputedStyle(background).backgroundColor : '',
          hasMinimap: !!editor.querySelector('.minimap')?.getBoundingClientRect().width, hasLineNumbers: !!editor.querySelector('.line-numbers'),
          lines: [...lines.querySelectorAll('.view-line')].map(el => el.textContent.split(String.fromCharCode(160)).join(' ')),
          spans: [...lines.querySelectorAll('.view-line span')].filter(el => el.textContent).map(el => ({ text: el.textContent, color: getComputedStyle(el).color, opacity: getComputedStyle(el).opacity })),
        };
      })()`);
    },
    async screenshot(directory, name) {
      await send('Page.enable');
      const image = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      await fs.mkdir(directory, { recursive: true });
      const filename = path.join(directory, name + '.png');
      await fs.writeFile(filename, Buffer.from(image.data, 'base64'));
      return filename;
    },
    close() { socket.close(); },
  };
}
module.exports = { connect, until, delay };

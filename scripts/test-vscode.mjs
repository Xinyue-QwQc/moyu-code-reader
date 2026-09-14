import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';

// Codex / Electron-based terminals may export Node mode; the test host must be a real GUI process.
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.VSCODE_IPC_HOOK_CLI;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const artifacts = path.join(root, '.test-data', 'run-' + runId);
const workspace = path.join(artifacts, 'workspace');
mkdirSync(workspace, { recursive: true });
if (process.env.FANQIE_CODEX_EXTENSION) mkdirSync(path.join(artifacts, 'isolated-codex-home'), { recursive: true });
writeFileSync(path.join(root, '.test-data', 'latest-run.json'), JSON.stringify({ artifacts, startedAt: new Date().toISOString() }, null, 2));
writeFileSync(path.join(workspace, 'reference.json'), JSON.stringify({
  name: 'editor-layout-reference', version: '1.0.0',
  packages: Object.fromEntries(Array.from({ length: 60 }, (_, index) => ['node_modules/example-' + index, {
    version: '1.0.2', resolved: 'https://example.test/reference-only/example-' + index,
    integrity: 'layout-comparison-no-network-request', dev: true, license: 'MIT', dependencies: { example: '^1.0.0' },
  }])),
}, null, 2));
mkdirSync(path.join(artifacts, 'user-data', 'User'), { recursive: true });
writeFileSync(path.join(artifacts, 'user-data', 'User', 'settings.json'), JSON.stringify({
  'telemetry.telemetryLevel': 'off', 'window.menuStyle': 'custom', 'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
  'window.titleBarStyle': 'custom', 'workbench.colorTheme': 'Default Dark Modern',
  'workbench.editor.enablePreview': false, 'editor.fontFamily': 'Consolas, "Courier New", monospace',
  'editor.fontSize': 18, 'editor.lineHeight': 27, 'editor.minimap.enabled': true,
  'editor.unicodeHighlight.ambiguousCharacters': false, 'editor.lineNumbers': 'on', 'editor.wordWrap': 'off', 'editor.smoothScrolling': false,
  'chat.disableAIFeatures': true, 'git.openRepositoryInParentFolders': 'never', 'git.autoRepositoryDetection': false,
  'files.autoSave': 'off', 'security.workspace.trust.enabled': false,
  'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false,
}, null, 2));

// Check shipped defaults in a separate profile before the flat-layout regression suite.
mkdirSync(path.join(artifacts, 'defaults-user-data', 'User'), { recursive: true });
writeFileSync(path.join(artifacts, 'defaults-user-data', 'User', 'settings.json'), readFileSync(path.join(artifacts, 'user-data', 'User', 'settings.json')));

mkdirSync(path.join(artifacts, 'ui-user-data', 'User'), { recursive: true });
writeFileSync(path.join(artifacts, 'ui-user-data', 'User', 'settings.json'), readFileSync(path.join(artifacts, 'user-data', 'User', 'settings.json')));

let executable = process.env.VSCODE_EXECUTABLE_PATH;
if (!executable && !process.env.VSCODE_VERSION && process.platform === 'win32') {
  const installed = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  if (existsSync(installed)) executable = installed;
}
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}

// Extension-test mode deliberately uses in-memory Memento storage. A tiny, local driver
// extension runs the tests in ordinary development hosts so restart persistence is real.
if (!executable) executable = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
const driver = path.join(artifacts, 'driver');
mkdirSync(driver, { recursive: true });
writeFileSync(path.join(driver, 'package.json'), JSON.stringify({
  name: 'fanqie-local-test-driver', displayName: 'Local Reader Test Driver', publisher: 'local-test', version: '0.0.1',
  engines: { vscode: '^1.90.0' }, activationEvents: ['onStartupFinished'], main: './index.cjs',
}));
writeFileSync(path.join(driver, 'index.cjs'), `
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
exports.activate = async function () {
  let result;
  try { const extension = vscode.extensions.getExtension('zwb8926.fanqie-novel'); await require(path.join(extension.extensionPath, 'test', 'integration.cjs').replace(/^[A-Z]:/, drive => drive.toLowerCase())).run(); result = { passed: true }; }
  catch (error) { result = { passed: false, error: error.stack }; console.error(error); }
  fs.writeFileSync(path.join(process.env.FANQIE_TEST_ARTIFACTS, process.env.FANQIE_TEST_PHASE + '-completed.json'), JSON.stringify(result));
  await vscode.commands.executeCommand('workbench.action.quit');
};
`);
for (const phase of process.env.FANQIE_CODEX_EXTENSION ? ['codex'] : process.env.FANQIE_LIVE_ONLY ? ['live'] : process.env.FANQIE_UI_ONLY ? ['ui'] : ['ui', 'defaults', 'main', 'restore']) {
  const debugPort = await port();
  console.log('\n=== Real VS Code integration: ' + phase + ' ===');
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(executable, [workspace,
      '--extensionDevelopmentPath=' + root, '--extensionDevelopmentPath=' + driver,
      ...(process.env.FANQIE_CODEX_EXTENSION ? ['--extensionDevelopmentPath=' + process.env.FANQIE_CODEX_EXTENSION] : []),
      '--disable-telemetry', '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-workspace-trust',
      '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion',
      '--user-data-dir=' + path.join(artifacts, phase === 'defaults' ? 'defaults-user-data' : phase === 'ui' ? 'ui-user-data' : 'user-data'), '--extensions-dir=' + path.join(artifacts, 'extensions'),
      '--remote-debugging-port=' + debugPort,
    ], { windowsHide: true, env: { ...process.env,
      ...(phase === 'codex' ? { CODEX_HOME: path.join(artifacts, 'isolated-codex-home') } : {}),
      FANQIE_TEST_PHASE: phase, FANQIE_TEST_ARTIFACTS: artifacts, FANQIE_TEST_DEBUG_PORT: String(debugPort),
    } });
    child.stdout.on('data', chunk => process.stdout.write(chunk));
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('exit', (code, signal) => { child.stdout.destroy(); child.stderr.destroy(); resolve({ code, signal }); });
  });
  if (exit.code !== 0) throw new Error('Development host exited abnormally: ' + JSON.stringify(exit));
  const result = JSON.parse(readFileSync(path.join(artifacts, phase + '-completed.json'), 'utf8'));
  if (!result.passed) throw new Error(result.error);
}
console.log('\n' + (process.env.FANQIE_CODEX_EXTENSION ? 'Installed Codex attachment test passed (no model request). ' : process.env.FANQIE_LIVE_ONLY ? 'Live native-reader smoke test passed. ' : 'Integration tests and restart restoration passed. ') + 'Evidence: ' + artifacts);

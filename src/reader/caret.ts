import * as vscode from 'vscode';
import { READER_LANGUAGE, READER_SCHEME } from './content';
import { updateMemento } from '../net/state';

const STATE_KEY = 'fanqie.hiddenCaret.restore.v1';
const LINE_STATE_KEY = 'fanqie.hiddenCaret.lineHighlight.restore.v1';
const TRANSPARENT = '#00000000';
const COLORS = ['editorCursor.foreground', 'editorCursor.background', 'editorMultiCursor.primary.foreground',
  'editorMultiCursor.primary.background', 'editorMultiCursor.secondary.foreground', 'editorMultiCursor.secondary.background',
  'editor.lineHighlightBackground', 'editor.lineHighlightBorder'];
type Colors = Record<string, string | Record<string, string>>;
interface Patch { target: vscode.ConfigurationTarget; original?: Colors; applied: Colors }
interface LinePatch { target: vscode.ConfigurationTarget; original?: string }

function hiddenColors(original: Colors = {}): Colors {
  const result: Colors = { ...original };
  for (const key of COLORS) result[key] = TRANSPARENT;
  // Theme-specific overrides take precedence over generic color values.
  for (const [theme, value] of Object.entries(original)) {
    if (theme.startsWith('[') && value && typeof value === 'object') {
      result[theme] = { ...value, ...Object.fromEntries(COLORS.map(key => [key, TRANSPARENT])) };
    }
  }
  return result;
}

/** Remove only values still owned by this feature; retain color edits made while reading. */
function restoredColors(current: Colors = {}, patch: Patch): Colors | undefined {
  const result: Colors = { ...current };
  const restore = (colors: Record<string, unknown>, original: Record<string, unknown>, applied: Record<string, unknown>) => {
    for (const key of COLORS) {
      if (colors[key] !== applied[key]) continue;
      if (key in original) colors[key] = original[key]; else delete colors[key];
    }
  };
  restore(result, patch.original || {}, patch.applied);
  for (const [theme, value] of Object.entries(patch.applied)) {
    if (!theme.startsWith('[') || !value || typeof value !== 'object') continue;
    const currentTheme = result[theme];
    if (!currentTheme || typeof currentTheme !== 'object') continue;
    const originalTheme = patch.original?.[theme];
    const restored = { ...currentTheme };
    restore(restored, typeof originalTheme === 'object' ? originalTheme : {}, value);
    if (!Object.keys(restored).length && originalTheme === undefined) delete result[theme];
    else result[theme] = restored;
  }
  return Object.keys(result).length || patch.original !== undefined ? result : undefined;
}

/**
 * VS Code exposes cursor colors (not a per-editor "hidden" cursor style). Apply a reversible
 * workspace-local color overlay only while a novel is the active editor, and restore on code
 * focus/deactivation. Mouse cursor CSS, selection, font, and editor files are never touched.
 */
export class ReaderCaret implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly storage: vscode.Memento;
  private task = Promise.resolve();
  private patch: Patch | undefined;
  private linePatch: LinePatch | undefined;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.storage = vscode.workspace.workspaceFolders?.length || vscode.workspace.workspaceFile ? context.workspaceState : context.globalState;
    this.patch = this.storage.get<Patch>(STATE_KEY);
    this.linePatch = this.storage.get<LinePatch>(LINE_STATE_KEY);
  }

  async start(): Promise<void> {
    // Recover a previous session interrupted while the overlay was active.
    await this.restore();
    await this.lineHighlight(false);
    const update = () => { void this.update().catch(error => console.warn('[fanqie caret]', error)); };
    this.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(update), vscode.window.tabGroups.onDidChangeTabs(update),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('fanqie.reader.hideTextCursor')) update(); }),
      vscode.commands.registerCommand('fanqie.reader.hideTextCursor', () => this.setHidden(true)),
      vscode.commands.registerCommand('fanqie.reader.showTextCursor', () => this.setHidden(false)));
    await this.update();
  }

  private async setHidden(hidden: boolean): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme !== READER_SCHEME) return;
    const config = vscode.workspace.getConfiguration('fanqie.reader', uri);
    const inspected = config.inspect<boolean>('hideTextCursor');
    const target = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update('hideTextCursor', hidden, target);
    await this.update();
  }

  private update(): Promise<void> {
    this.task = this.task.catch(error => console.warn('[fanqie caret]', error)).then(async () => {
      const editor = vscode.window.activeTextEditor;
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const uri = editor?.document.uri ?? (tab?.input instanceof vscode.TabInputText ? tab.input.uri : undefined);
      const preference = !this.disposed && vscode.workspace.getConfiguration('fanqie.reader').get('hideTextCursor', false);
      // A language-scoped override cannot affect code editors. Keep it throughout hide mode,
      // rather than briefly re-enabling current-line highlights between two novel tabs.
      await this.lineHighlight(preference);
      const hidden = preference && uri?.scheme === READER_SCHEME;
      if (!hidden) { await this.restore(); return; }
      if (this.patch) return;
      const config = vscode.workspace.getConfiguration('workbench');
      const target = vscode.workspace.workspaceFolders?.length || vscode.workspace.workspaceFile ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      const inspected = config.inspect<Colors>('colorCustomizations');
      const original = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
      // Include inherited theme sections without losing their other colors.
      const base: Colors = { ...original };
      for (const [key, value] of Object.entries(config.get<Colors>('colorCustomizations') || {})) {
        if (key.startsWith('[') && typeof value === 'object' && !base[key]) base[key] = {};
      }
      const applied = hiddenColors(base);
      const patch = { target, original, applied };
      await updateMemento(this.storage, STATE_KEY, patch);
      this.patch = patch;
      await config.update('colorCustomizations', applied, target);
    });
    return this.task;
  }

  private async restore(): Promise<void> {
    if (!this.patch) return;
    const config = vscode.workspace.getConfiguration('workbench');
    const inspected = config.inspect<Colors>('colorCustomizations');
    const patch = this.patch;
    const current = patch.target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
    // If another command removed this overlay already, do not recreate it.
    if (current) {
      let restored = restoredColors(current, patch);
      if (JSON.stringify(current) === JSON.stringify(patch.applied)) restored = patch.original;
      await config.update('colorCustomizations', restored, patch.target);
    }
    this.patch = undefined;
    await updateMemento(this.storage, STATE_KEY, undefined);
  }

  private async lineHighlight(hidden: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('editor', { languageId: READER_LANGUAGE });
    const inspected = config.inspect<string>('renderLineHighlight');
    if (hidden) {
      if (this.linePatch) return;
      const target = vscode.workspace.workspaceFolders?.length || vscode.workspace.workspaceFile ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      const original = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceLanguageValue : inspected?.globalLanguageValue;
      this.linePatch = { target, original };
      await updateMemento(this.storage, LINE_STATE_KEY, this.linePatch);
      await config.update('renderLineHighlight', 'none', target, true);
    } else if (this.linePatch) {
      const { target, original } = this.linePatch;
      const current = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceLanguageValue : inspected?.globalLanguageValue;
      if (current === 'none') await config.update('renderLineHighlight', original, target, true);
      this.linePatch = undefined;
      await updateMemento(this.storage, LINE_STATE_KEY, undefined);
    }
  }

  async stop(): Promise<void> { this.disposed = true; this.subscriptions.forEach(item => item.dispose()); await this.update(); }
  dispose(): void { void this.stop().catch(error => console.warn('[fanqie caret]', error)); }
}

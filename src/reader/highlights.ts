import * as vscode from 'vscode';
import { chapterAddress } from './documents';
import { findKeywords, findPageQuotes, findQuotes, subtractSpans, TextSpan } from './quotes';
import type { ReadingPage } from './content';
import { effectiveCamouflage } from './camouflageProvider';
import { readingPalette, validColor } from './palette';

type HighlightKind = 'dialogue' | 'innerQuotes' | 'keywords';
interface Style { enabled: boolean; color: string; opacity: number }
interface HighlightState {
  signature: string;
  version: number;
  types: Record<HighlightKind, vscode.TextEditorDecorationType>;
  spans: Record<HighlightKind, TextSpan[]>;
  body?: vscode.TextEditorDecorationType;
  background?: vscode.TextEditorDecorationType;
  bodySpans: TextSpan[];
}

/** Color decorations remain document-local; fonts and spacing use native language settings instead. */
export class ReaderHighlights implements vscode.Disposable {
  private readonly states = new Map<string, HighlightState>();
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly page: (uri: vscode.Uri) => ReadingPage | undefined) {
    this.disposables = [
      vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach(editor => this.apply(editor))),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('fanqie.reader.highlight') || event.affectsConfiguration('fanqie.reader.appearance')
          || event.affectsConfiguration('fanqie.reader.experimental') || event.affectsConfiguration('editor.semanticHighlighting.enabled')) {
          this.clear();
          vscode.window.visibleTextEditors.forEach(editor => this.apply(editor));
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => { this.clear(); vscode.window.visibleTextEditors.forEach(editor => this.apply(editor)); }),
      vscode.workspace.onDidCloseTextDocument(document => this.remove(document.uri.toString())),
    ];
    vscode.window.visibleTextEditors.forEach(editor => this.apply(editor));
  }

  apply(editor: vscode.TextEditor): void {
    if (!chapterAddress(editor.document.uri)) return;
    const config = vscode.workspace.getConfiguration('fanqie.reader.highlight', editor.document.uri);
    const enabled = config.get<boolean>('enabled', true);
    const appearance = vscode.workspace.getConfiguration('fanqie.reader.appearance', editor.document.uri);
    const theme = vscode.window.activeColorTheme.kind;
    const palette = readingPalette(appearance.get<string>('preset', 'theme'),
      theme === vscode.ColorThemeKind.Light || theme === vscode.ColorThemeKind.HighContrastLight,
      theme === vscode.ColorThemeKind.HighContrast || theme === vscode.ColorThemeKind.HighContrastLight);
    const camouflage = effectiveCamouflage(editor.document.uri);
    const foreground = camouflage === 'off' ? validColor(appearance.get('foreground')) || palette.foreground : undefined;
    const background = validColor(appearance.get('lineBackground'));
    const styles = Object.fromEntries((['dialogue', 'innerQuotes', 'keywords'] as const).map(kind => {
      const color = validColor(config.get(kind + '.color')) || palette[kind] || '';
      const rawOpacity = config.get<number>(kind + '.opacity', 1);
      return [kind, {
        enabled: enabled && (camouflage === 'off' || kind === 'keywords') && config.get<boolean>(kind + '.enabled', kind !== 'innerQuotes'),
        color,
        opacity: Number.isFinite(rawOpacity) ? Math.max(0.3, Math.min(1, rawOpacity)) : 1,
      }];
    })) as Record<HighlightKind, Style>;
    const configuredWords = config.get<unknown>('keywords.words', []);
    const words = (Array.isArray(configuredWords) ? configuredWords : [])
      .filter((word): word is string => typeof word === 'string').slice(0, 200).map(word => word.slice(0, 80));
    const signature = JSON.stringify({ styles, words, foreground, background, camouflage });
    const key = editor.document.uri.toString();
    let state = this.states.get(key);
    if (!state || state.signature !== signature || state.version !== editor.document.version) {
      this.remove(key);
      const text = editor.document.getText();
      const page = this.page(editor.document.uri);
      const quotes = page ? findPageQuotes(page) : findQuotes(text);
      const keywords = styles.keywords.enabled ? findKeywords(text, words) : [];
      const innerQuotes = styles.innerQuotes.enabled ? subtractSpans(quotes.innerQuotes, keywords) : [];
      const dialogue = styles.dialogue.enabled ? subtractSpans(quotes.dialogue, [...innerQuotes, ...keywords]) : [];
      const types = Object.fromEntries((Object.keys(styles) as HighlightKind[]).map(kind => [kind,
        vscode.window.createTextEditorDecorationType({
          color: styles[kind].color || new vscode.ThemeColor('fanqie.' + kind + 'Foreground'),
          opacity: String(styles[kind].opacity),
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        }),
      ])) as Record<HighlightKind, vscode.TextEditorDecorationType>;
      state = {
        signature, version: editor.document.version, types, spans: { dialogue, innerQuotes, keywords },
        body: foreground ? vscode.window.createTextEditorDecorationType({ color: foreground }) : undefined,
        background: background ? vscode.window.createTextEditorDecorationType({ backgroundColor: background, isWholeLine: true }) : undefined,
        bodySpans: foreground ? subtractSpans([{ start: 0, end: text.length }], [...dialogue, ...innerQuotes, ...keywords]) : [],
      };
      this.states.set(key, state);
    }
    if (state.background) editor.setDecorations(state.background, [new vscode.Range(0, 0, editor.document.lineCount - 1, 0)]);
    if (state.body) editor.setDecorations(state.body, state.bodySpans.map(span =>
      new vscode.Range(editor.document.positionAt(span.start), editor.document.positionAt(span.end))));
    for (const kind of Object.keys(state.types) as HighlightKind[]) {
      editor.setDecorations(state.types[kind], state.spans[kind].map(span =>
        new vscode.Range(editor.document.positionAt(span.start), editor.document.positionAt(span.end))));
    }
  }

  private remove(key: string): void {
    const state = this.states.get(key);
    if (state) { Object.values(state.types).forEach(type => type.dispose()); state.body?.dispose(); state.background?.dispose(); }
    this.states.delete(key);
  }

  private clear(): void { [...this.states.keys()].forEach(key => this.remove(key)); }
  dispose(): void { this.disposables.forEach(disposable => disposable.dispose()); this.clear(); }
}

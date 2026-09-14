import * as vscode from 'vscode';
import { CAMOUFLAGE_TOKEN_TYPES, camouflageMode, camouflageTokens } from './camouflage';
import { ReadingPage, READER_LANGUAGE, READER_SCHEME } from './content';
import { chapterAddress } from './documents';
import { findPageQuotes, findQuotes } from './quotes';

export function effectiveCamouflage(uri: vscode.Uri) {
  const enabled = vscode.workspace.getConfiguration('fanqie.reader.highlight', uri).get('enabled', true);
  // Respect an explicit native semantic-highlighting opt-out; don't erase normal colors in that case.
  const semantic = vscode.workspace.getConfiguration('editor', { uri, languageId: READER_LANGUAGE }).get('semanticHighlighting.enabled');
  return enabled && semantic !== false
    ? camouflageMode(vscode.workspace.getConfiguration('fanqie.reader.experimental', uri).get('codeCamouflage', 'off')) : 'off';
}

/** Native semantic tokens color the actual text AND the native minimap; no fake code or CSS overlay. */
export class CamouflageProvider implements vscode.DocumentSemanticTokensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeSemanticTokens = this.changed.event;
  private readonly cache = new Map<string, { version: number; mode: string; tokens: vscode.SemanticTokens }>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly page: (uri: vscode.Uri) => ReadingPage | undefined) {
    const legend = new vscode.SemanticTokensLegend([...CAMOUFLAGE_TOKEN_TYPES], []);
    this.subscriptions = [
      vscode.languages.registerDocumentSemanticTokensProvider({ scheme: READER_SCHEME, language: READER_LANGUAGE }, this, legend),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('fanqie.reader.experimental') || event.affectsConfiguration('fanqie.reader.highlight.enabled')
          || event.affectsConfiguration('editor.semanticHighlighting.enabled')) {
          this.cache.clear(); this.changed.fire();
        }
      }),
      vscode.workspace.onDidCloseTextDocument(document => this.cache.delete(document.uri.toString())),
    ];
  }

  provideDocumentSemanticTokens(document: vscode.TextDocument, cancellation: vscode.CancellationToken): vscode.SemanticTokens | undefined {
    if (!chapterAddress(document.uri) || cancellation.isCancellationRequested) return;
    const mode = effectiveCamouflage(document.uri);
    const key = document.uri.toString();
    const cached = this.cache.get(key);
    if (cached && cached.mode === mode && cached.version === document.version) return cached.tokens;
    const builder = new vscode.SemanticTokensBuilder();
    if (mode !== 'off') {
      const text = document.getText();
      const page = this.page(document.uri);
      const quotes = page ? findPageQuotes(page) : findQuotes(text);
      for (const token of camouflageTokens(text, mode, quotes)) {
        if (cancellation.isCancellationRequested) return;
        builder.push(token.line, token.character, token.end - token.start, CAMOUFLAGE_TOKEN_TYPES.indexOf(token.kind), 0);
      }
    }
    const tokens = builder.build();
    this.cache.set(key, { version: document.version, mode, tokens });
    return tokens;
  }

  dispose(): void { this.subscriptions.forEach(item => item.dispose()); this.changed.dispose(); this.cache.clear(); }
}

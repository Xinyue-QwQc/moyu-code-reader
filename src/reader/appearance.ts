import * as vscode from 'vscode';
import { READER_LANGUAGE } from './content';
import { validColor } from './palette';
import { camouflageMode, CamouflageMode } from './camouflage';

type FontOption = 'fontFamily' | 'fontSize' | 'lineHeight';
const fontLabels: Record<FontOption, string> = { fontFamily: '字体', fontSize: '字号', lineHeight: '行间距（行高）' };
const paletteLabels: Record<string, string> = { theme: '跟随主题', soft: '柔和', warm: '暖色', cool: '冷色' };

function fontConfig(uri?: vscode.Uri) {
  return vscode.workspace.getConfiguration('editor', { uri, languageId: READER_LANGUAGE });
}

/** Native language overrides are supported by VS Code and affect only novel documents. */
export async function setReaderFont(option: FontOption, value: string | number | undefined, uri?: vscode.Uri): Promise<void> {
  if (option === 'fontFamily' && value !== undefined && (typeof value !== 'string' || /[\r\n]/.test(value))) throw new Error('字体名称须为单行文字。');
  if (option !== 'fontFamily' && value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < (option === 'fontSize' ? 6 : 0) || value > 100)) throw new Error('请输入有效的字号 / 行高（最大 100）。');
  const config = fontConfig(uri);
  const inspected = config.inspect(option);
  const levels = [
    { value: inspected?.workspaceFolderLanguageValue, target: vscode.ConfigurationTarget.WorkspaceFolder },
    { value: inspected?.workspaceLanguageValue, target: vscode.ConfigurationTarget.Workspace },
    { value: inspected?.globalLanguageValue, target: vscode.ConfigurationTarget.Global },
  ];
  if (value === undefined || value === '') {
    // Remove only this novel-language option, never editor.* or unrelated language settings.
    for (const level of levels) if (level.value !== undefined) await config.update(option, undefined, level.target, true);
  } else {
    await config.update(option, value, levels.find(level => level.value !== undefined)?.target ?? vscode.ConfigurationTarget.Global, true);
  }
}

async function setOption(section: string, key: string, value: unknown, uri?: vscode.Uri): Promise<void> {
  const config = vscode.workspace.getConfiguration(section, uri);
  const inspected = config.inspect(key);
  const target = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
    : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await config.update(key, value, target);
}

function fontDescription(option: FontOption, uri?: vscode.Uri): string {
  const config = fontConfig(uri);
  const inspected = config.inspect(option);
  const custom = inspected?.workspaceFolderLanguageValue ?? inspected?.workspaceLanguageValue ?? inspected?.globalLanguageValue;
  const value = config.get(option);
  return custom === undefined ? '跟随 VS Code · ' + value : String(value);
}

async function editFont(option: FontOption, uri?: vscode.Uri): Promise<void> {
  const config = fontConfig(uri);
  const inspected = config.inspect(option);
  const custom = inspected?.workspaceFolderLanguageValue ?? inspected?.workspaceLanguageValue ?? inspected?.globalLanguageValue;
  const family = option === 'fontFamily';
  const value = await vscode.window.showInputBox({
    title: '小说专属' + fontLabels[option],
    prompt: family ? '填写字体名称或逗号分隔的字体列表。留空恢复跟随 VS Code；不修改普通代码字体。'
      : option === 'fontSize' ? '字号（像素，6–100）。留空恢复跟随 VS Code。'
        : '行高：大于等于 8 为像素，小于 8 为字号倍数，0 为自动。留空跟随 VS Code。',
    value: custom === undefined ? '' : String(custom),
    placeHolder: family ? '例如：Consolas, "Microsoft YaHei", monospace' : String(config.get(option)),
    validateInput: text => {
      if (!text.trim()) return undefined;
      if (family) return /[\r\n]/.test(text) ? '请输入单行字体名称。' : undefined;
      const number = Number(text);
      return Number.isFinite(number) && number >= (option === 'fontSize' ? 6 : 0) && number <= 100 ? undefined : '请输入有效数值（最大 100），或留空跟随编辑器。';
    },
  });
  if (value !== undefined) await setReaderFont(option, value.trim() ? family ? value.trim() : Number(value) : undefined, uri);
}

async function editColor(section: string, key: string, title: string, uri?: vscode.Uri): Promise<void> {
  const current = vscode.workspace.getConfiguration(section, uri).get<string>(key, '');
  const value = await vscode.window.showInputBox({
    title, prompt: '输入 #RRGGBB 或 #RRGGBBAA。留空使用配色方案 / VS Code 主题默认。',
    placeHolder: '例如 #B8C9D9', value: current,
    validateInput: input => !input.trim() || validColor(input.trim()) ? undefined : '请输入有效颜色，例如 #B8C9D9 或 #B8C9D980。',
  });
  if (value !== undefined) await setOption(section, key, value.trim(), uri);
}

const camouflageLabels: Record<CamouflageMode, string> = { off: '关闭（正常阅读）', balanced: '平衡（词组多色，保留对白）', dense: '强伪装（对白也分段配色）' };

export async function chooseCamouflage(uri?: vscode.Uri): Promise<void> {
  const current = camouflageMode(vscode.workspace.getConfiguration('fanqie.reader.experimental', uri).get('codeCamouflage'));
  const picked = await vscode.window.showQuickPick((['off', 'balanced', 'dense'] as const).map(mode => ({
    label: camouflageLabels[mode], value: mode, description: mode === current ? '当前模式' : '',
    detail: mode === 'off' ? '立即恢复原来的正文 / 对话配色，不丢失自定义设置。'
      : mode === 'balanced' ? '按词组、数字、连接词和标点模拟代码语法；牺牲少量阅读舒适度。'
        : '更短的词组、更频繁的语法色变化，叙述和对白均强制多色；更像代码但更分散注意力。',
  })), { title: '实验性代码伪装配色', placeHolder: '只改颜色，不改文字；使用当前代码主题并同步缩略图。开启将打开小说高亮总开关 / 语义高亮。', matchOnDetail: true });
  if (!picked) return;
  if (picked.value !== 'off') {
    await setOption('fanqie.reader.highlight', 'enabled', true, uri);
    const editor = fontConfig(uri);
    if (editor.get('semanticHighlighting.enabled') === false) {
      const inspected = editor.inspect('semanticHighlighting.enabled');
      const target = inspected?.workspaceFolderLanguageValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
        : inspected?.workspaceLanguageValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await editor.update('semanticHighlighting.enabled', true, target, true);
    }
  }
  await setOption('fanqie.reader.experimental', 'codeCamouflage', picked.value, uri);
}

/** Keep customization in native Quick Pick / Input Box controls, with no toolbar over the chapter. */
export async function showReaderAppearance(uri?: vscode.Uri): Promise<void> {
  while (true) {
    const appearance = vscode.workspace.getConfiguration('fanqie.reader.appearance', uri);
    const items: Array<vscode.QuickPickItem & { run?: () => Promise<unknown>; leave?: boolean }> = [
      { label: '阅读页', kind: vscode.QuickPickItemKind.Separator },
      { label: '每页章节数', description: String(vscode.workspace.getConfiguration('fanqie.reader', uri).get('chaptersPerPage', 1)) + ' 章 / 虚拟文件',
        run: () => Promise.resolve(vscode.commands.executeCommand('fanqie.reader.pageSize')) },
      { label: '缩略图', description: fontConfig(uri).get('minimap.enabled') ? '已开启（右侧原生缩略图）' : '已关闭，点击开启', run: async () => {
        const config = fontConfig(uri);
        const inspected = config.inspect('minimap.enabled');
        const target = inspected?.workspaceFolderLanguageValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
          : inspected?.workspaceLanguageValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await config.update('minimap.enabled', !config.get('minimap.enabled'), target, true);
      } },
      { label: '字体（仅小说）', kind: vscode.QuickPickItemKind.Separator },
      ...(['fontFamily', 'fontSize', 'lineHeight'] as const).map(option => ({
        label: fontLabels[option], description: fontDescription(option, uri), run: () => editFont(option, uri),
      })),
      { label: '段间距', description: String(vscode.workspace.getConfiguration('fanqie.reader', uri).get('paragraphSpacing', 0)) + ' 个空行', run: async () => {
        const picked = await vscode.window.showQuickPick([0, 1, 2, 3, 4, 5].map(value => ({ label: value === 0 ? '不额外空行（代码页默认）' : '段落之间空 ' + value + ' 行', value })), {
          title: '段间距（独立于行间距）', placeHolder: '原生编辑器按空行分隔段落；自动换行形成的行仍使用行间距',
        });
        if (picked) await setOption('fanqie.reader', 'paragraphSpacing', picked.value, uri);
      } },
      { label: '恢复字体跟随 VS Code', description: '保留代码字体及小说的其他设置', run: async () => {
        for (const option of ['fontFamily', 'fontSize', 'lineHeight'] as const) await setReaderFont(option, undefined, uri);
      } },
      { label: '配色（仅小说）', kind: vscode.QuickPickItemKind.Separator },
      { label: '配色方案', description: paletteLabels[appearance.get<string>('preset', 'theme')] || '跟随主题', run: async () => {
        const chosen = await vscode.window.showQuickPick(Object.entries(paletteLabels).map(([value, label]) => ({ label, value })), {
          title: '小说配色方案', placeHolder: '只调整正文 / 高亮前景色；留空的自定义颜色随方案变化',
        });
        if (chosen) await setOption('fanqie.reader.appearance', 'preset', chosen.value, uri);
      } },
      { label: '$(beaker) 实验性代码伪装配色', description: camouflageLabels[camouflageMode(vscode.workspace.getConfiguration('fanqie.reader.experimental', uri).get('codeCamouflage'))],
        detail: '不止引号：按词组强制多色，缩略图同步；关闭后恢复原配色。', run: () => chooseCamouflage(uri) },
      { label: '正文文字颜色', description: appearance.get<string>('foreground') || '跟随配色方案', run: () => editColor('fanqie.reader.appearance', 'foreground', '正文文字颜色', uri) },
      { label: '正文行底色', description: appearance.get<string>('lineBackground') || '透明（原生背景）', detail: '仅正文行，不改变行号、缩略图、空白区和其他代码页的背景。', run: () => editColor('fanqie.reader.appearance', 'lineBackground', '正文行底色（仅正文行）', uri) },
      ...([['dialogue', '对话颜色'], ['innerQuotes', '单引号 / 内心独白颜色'], ['keywords', '人物 / 关键词颜色']] as const).map(([kind, label]) => ({
        label, description: vscode.workspace.getConfiguration('fanqie.reader.highlight', uri).get<string>(kind + '.color') || '跟随配色方案',
        run: () => editColor('fanqie.reader.highlight', kind + '.color', label, uri),
      })),
      { label: '恢复配色跟随 VS Code', description: '清除正文底色与自定义颜色，并退出实验配色', run: async () => {
        await setOption('fanqie.reader.experimental', 'codeCamouflage', 'off', uri);
        await setOption('fanqie.reader.appearance', 'preset', 'theme', uri);
        for (const key of ['foreground', 'lineBackground']) await setOption('fanqie.reader.appearance', key, '', uri);
        for (const kind of ['dialogue', 'innerQuotes', 'keywords']) await setOption('fanqie.reader.highlight', kind + '.color', '', uri);
      } },
      { label: 'AI 阅读上下文', description: '提供当前上下文给 Codex / 按需读取其他章节', leave: true,
        run: () => Promise.resolve(vscode.commands.executeCommand('fanqie.agent.context')) },
      { label: '更多设置：高亮开关、强度、关键词', leave: true, run: () => Promise.resolve(vscode.commands.executeCommand('fanqie.reader.settings')) },
      { label: '原生小说语言设置', description: '自动换行、缩略图、字体等', leave: true, run: () => Promise.resolve(vscode.commands.executeCommand('workbench.action.openSettings', '@lang:' + READER_LANGUAGE)) },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: '阅读设置 · 字体与配色 / 每页章节数', placeHolder: '留空跟随编辑器；调整实时生效，不影响普通代码页', matchOnDescription: true });
    if (!picked) return;
    await picked.run?.();
    if (picked.leave) return;
  }
}

import { execFile } from 'node:child_process';
import * as path from 'node:path';

export type ReadingLanguage = 'chinese' | 'other';
export interface InstalledFont { family: string; displayName: string; chinese: boolean; latin: boolean }

/** Only two buckets for now. Kana/Hangul distinguish Japanese/Korean from Chinese Han text. */
export function readingLanguage(text: string): ReadingLanguage {
  const sample = text.slice(0, 16000);
  const han = (sample.match(/\p{Script=Han}/gu) || []).length;
  const kanaOrHangul = (sample.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  const letters = (sample.match(/\p{Letter}/gu) || []).length;
  return !letters || (han > 0 && han / letters >= 0.2 && kanaOrHangul < han * 0.1) ? 'chinese' : 'other';
}

export function parseFonts(value: unknown): InstalledFont[] {
  if (!Array.isArray(value)) throw new Error('系统未返回有效字体列表。');
  const fonts = new Map<string, InstalledFont>();
  for (const row of value) {
    if (!row || typeof row.family !== 'string' || !row.family.trim() || /[\r\n\x00]/.test(row.family)) continue;
    const family = row.family.trim();
    const key = family.toLocaleLowerCase('en-US');
    const previous = fonts.get(key);
    fonts.set(key, { family, displayName: typeof row.displayName === 'string' && row.displayName.trim() ? row.displayName.trim() : family,
      chinese: row.chinese === true || previous?.chinese === true, latin: row.latin === true || previous?.latin === true });
  }
  return [...fonts.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
}

/** Non-Chinese currently means alphabetic text; CJK fonts supporting Latin are also usable. */
export function fontsForLanguage(fonts: readonly InstalledFont[], language: ReadingLanguage): InstalledFont[] {
  return fonts.filter(font => language === 'chinese' ? font.chinese : font.latin);
}

export function fontFamilySetting(family: string): string {
  return '"' + family.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function run(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error('无法读取系统字体，请重试。' + error.message)); else resolve(stdout.replace(/^\uFEFF/, '').trim());
    });
  });
}

let cached: Promise<InstalledFont[]> | undefined;
export function listInstalledFonts(refresh = false): Promise<InstalledFont[]> {
  if (refresh) cached = undefined;
  if (!cached) cached = enumerate().catch(error => { cached = undefined; throw error; });
  return cached;
}

async function enumerate(): Promise<InstalledFont[]> {
  if (process.platform === 'win32') {
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = path.join(__dirname, '..', '..', 'media', 'list-fonts.ps1');
    return parseFonts(JSON.parse(await run(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script])));
  }
  if (process.platform === 'darwin') {
    const script = `ObjC.import('AppKit');
      const manager = $.NSFontManager.sharedFontManager;
      JSON.stringify(ObjC.deepUnwrap(manager.availableFontFamilies).map(family => {
        const font = manager.fontWithFamilyTraitsWeightSize(family, 0, 5, 12);
        const covers = text => Array.from(text).every(c => font.coveredCharacterSet.longCharacterIsMember(c.codePointAt(0)));
        return { family, displayName: family, chinese: covers('中文小说阅读天地人心'), latin: covers('AZaz09') };
      }));`;
    return parseFonts(JSON.parse(await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script])));
  }
  const output = await run('fc-list', ['--format=%{family[0]}\t%{lang}\n']);
  return parseFonts(output.split('\n').map(line => {
    const [family, languages = ''] = line.split('\t');
    return { family, displayName: family, chinese: /(?:^|\|)zh(?:-|\||$)/i.test(languages), latin: /(?:^|\|)en(?:-|\||$)/i.test(languages) };
  }));
}

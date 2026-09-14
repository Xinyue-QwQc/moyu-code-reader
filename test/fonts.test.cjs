const test = require('node:test');
const assert = require('node:assert/strict');
const { readingLanguage, parseFonts, fontsForLanguage, fontFamilySetting } = require('../out/reader/fonts');

test('font language filtering distinguishes Chinese novels and non-Chinese body text, not file extension', () => {
  assert.equal(readingLanguage('第一章\n林舟放下书，向窗外望去。Hello，老朋友。'), 'chinese');
  assert.equal(readingLanguage('Chapter One\nThe traveller opened the door and stepped into the quiet room.'), 'other');
  assert.equal(readingLanguage('第一章\n' + 'A long English paragraph about travelling home. '.repeat(20)), 'other');
  assert.equal(readingLanguage('彼女は窓から外を見た。遠くの山には雪が残っていた。'), 'other');
  assert.equal(readingLanguage('한국어 소설을 읽습니다.'), 'other');
  assert.equal(readingLanguage(''), 'chinese', 'no current novel defaults to this Chinese reader');
});

test('fonts are filtered by probed glyph coverage, deduplicated and never guessed from their names', () => {
  const fonts = parseFonts([
    { family: 'Consolas', chinese: false, latin: true },
    { family: 'Noto Sans SC', displayName: '思源黑体', chinese: true, latin: true },
    { family: 'chinese-sounding-name', chinese: false, latin: true },
    { family: '符号字体', chinese: false, latin: false },
    { family: 'noto sans sc', displayName: '思源黑体', chinese: true, latin: true },
    { family: 'bad\nname', chinese: true, latin: true }, null,
  ]);
  assert.equal(fonts.length, 4);
  assert.equal(fontsForLanguage(fonts, 'chinese').length, 1);
  assert.equal(fontsForLanguage(fonts, 'chinese')[0].displayName, '思源黑体');
  assert.equal(fontsForLanguage(fonts, 'other').length, 3);
  assert.ok(!fontsForLanguage(fonts, 'other').some(font => font.family === '符号字体'));
  assert.throws(() => parseFonts({}), /字体列表/);
});

test('font families containing punctuation are quoted as a single font rather than a fallback list', () => {
  assert.equal(fontFamilySetting('Microsoft YaHei'), '"Microsoft YaHei"');
  assert.equal(fontFamilySetting('Family, Name'), '"Family, Name"');
  assert.equal(fontFamilySetting('Family "Name"'), '"Family \\"Name\\""'.replaceAll('\\\\', '\\'));
});

test('reader and library context menus are scoped and Codex selection actions require installed capability', () => {
  const { contributes } = require('../package.json');
  const menu = contributes.menus['editor/context'];
  const selection = menu.find(item => item.command === 'fanqie.agent.sendSelectionToCodex');
  for (const condition of ['resourceScheme == fanqie', 'editorHasSelection', 'fanqie.codexAvailable']) assert.ok(selection.when.includes(condition));
  assert.ok(menu.find(item => item.command === 'fanqie.reader.refresh').when.includes('resourceScheme == fanqie'));
  assert.equal(contributes.menus['webview/context'][0].when, 'webviewSection == fanqieLibrary');
});

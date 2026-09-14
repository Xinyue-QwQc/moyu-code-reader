const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chapterText, safeLabel, flattenDirectory, chapterProgress, isBookId } = require('../out/reader/content');
const { findQuotes, findKeywords, mergeSpans, subtractSpans } = require('../out/reader/quotes');
const slices = (text, spans) => spans.map(span => text.slice(span.start, span.end));

test('one chapter = title and full paragraphs, with no generated code/pagination/indentation', () => {
  assert.equal(chapterText({ title: ' 第一章 ', paragraphs: ['第一段。', '“第二段。”', '  保留原有缩进\r\n与原有换行'] }), '第一章\n\n第一段。\n“第二段。”\n  保留原有缩进\n与原有换行\n');
  const paragraphs = Array.from({ length: 2000 }, (_, i) => '第' + i + '段。' + '长句'.repeat(100));
  const text = chapterText({ title: '完整章节', paragraphs });
  assert.equal(text.split('\n').length, 2003);
  assert.ok(text.includes(paragraphs[1999]));
});

test('empty / whitespace-only chapter is a retryable error, not a blank reading page', () => {
  for (const paragraphs of [[], [''], [' ', '\t']]) assert.throws(() => chapterText({ title: '标题', paragraphs }), /正文为空/);
});

test('Chinese, Japanese-style and ASCII dialogue quotes, including emoji offsets', () => {
  const text = '😀他说：“你好。” 旁白。「一起走。」 『好。』 "OK"';
  assert.deepEqual(slices(text, findQuotes(text).dialogue), ['“你好。”', '「一起走。」', '『好。』', '"OK"']);
  assert.deepEqual(findQuotes(text).innerQuotes, []);
});

test('nested single quotes can be styled without overwriting dialogue', () => {
  const text = '他说：“她只说‘回家’，就走了。” 他想：‘会再见吗？’';
  const quotes = findQuotes(text);
  assert.deepEqual(slices(text, quotes.dialogue), ['“她只说‘回家’，就走了。”']);
  assert.deepEqual(slices(text, quotes.innerQuotes), ['‘回家’', '‘会再见吗？’']);
  assert.deepEqual(slices(text, subtractSpans(quotes.dialogue, quotes.innerQuotes)), ['“她只说', '，就走了。”']);
});

test('balanced multi-line speech is retained; blank paragraphs recover unmatched quotes', () => {
  const text = '“第一行，\n还有第二行。”\n未闭合“\n\n旁白\n「恢复。」';
  assert.deepEqual(slices(text, findQuotes(text).dialogue), ['“第一行，\n还有第二行。”', '「恢复。」']);
  assert.deepEqual(findQuotes('他抬头：“还没说完\n后面的旁白').dialogue, []);
});

test('escape-aware ASCII quotes, contractions, and unmatched closers', () => {
  // Construct separately to keep the expected literal quotes unambiguous.
  const speech = '"hello, ' + '\\"' + 'world' + '\\"' + '."';
  assert.deepEqual(slices(speech, findQuotes(speech).dialogue), [speech]);
  assert.deepEqual(findQuotes('It’s fine. don\'t. ”').dialogue, []);
});

test('nested corner quotation marks produce a single dialogue range', () => {
  const text = '「他回答『是』。」';
  assert.deepEqual(slices(text, findQuotes(text).dialogue), [text]);
});

test('literal keywords, longest name wins, no regexp injection, offsets remain UTF-16', () => {
  const text = '😀林舟和林舟远去了C++街，[a].*不代表正则。林舟。';
  assert.deepEqual(slices(text, findKeywords(text, ['林舟', '林舟远', 'C++', '[a].*', '林舟', ' '])), ['林舟', '林舟远', 'C++', '[a].*', '林舟']);
  assert.deepEqual(findKeywords(text, []), []);
  assert.deepEqual(findKeywords('abc ABC', ['ABC']), [{ start: 4, end: 7 }]);
});

test('range subtraction handles overlaps, abutting cuts and enclosing cuts without mutation', () => {
  const source = [{ start: 0, end: 20 }, { start: 30, end: 40 }];
  const cuts = [{ start: 3, end: 5 }, { start: 5, end: 8 }, { start: 10, end: 11 }, { start: 15, end: 35 }];
  assert.deepEqual(subtractSpans(source, cuts), [{ start: 0, end: 3 }, { start: 8, end: 10 }, { start: 11, end: 15 }, { start: 35, end: 40 }]);
  assert.equal(source[0].end, 20);
  assert.deepEqual(mergeSpans([{ start: 1, end: 3 }, { start: 2, end: 4 }]), [{ start: 1, end: 4 }]);
});

test('catalog uses canonical ID ordering, keeps volume labels and missing-title fallbacks', () => {
  const directory = { bookId: '1234567890', allItemIds: ['a', 'b', 'c', 'a'], chapterTotal: 3, volumes: [{ volume_name: '第一卷', chapters: [{ itemId: 'b', title: '第二章' }, { itemId: 'a', title: '第一章' }, { itemId: 'b', title: '重复' }] }] };
  const chapters = flattenDirectory(directory);
  assert.deepEqual(chapters.map(c => c.itemId), ['a', 'b', 'c']);
  assert.equal(chapters[0].volume_name, '第一卷');
  assert.equal(chapters[1].title, '第二章');
  assert.equal(chapters[2].title, '第3章');
  assert.deepEqual(flattenDirectory({ ...directory, volumes: [], allItemIds: [] }), []);
});

test('safe labels and identifiers handle URI punctuation without changing text content', () => {
  assert.equal(safeLabel('标题/\\\n正文', '默认'), '标题   正文');
  assert.equal(safeLabel('', '默认'), '默认');
  assert.equal(isBookId('7576659101376072728'), true);
  for (const id of ['../../secret', '123', '', '1234567890?x=1']) assert.equal(isBookId(id), false);
});

test('chapter progress is bounded and represents scroll position, not artificial page numbers', () => {
  assert.equal(chapterProgress(0, 25, 100), 0);
  assert.equal(chapterProgress(30, 55, 100), 30);
  assert.equal(chapterProgress(60, 99, 100), 100);
  assert.equal(chapterProgress(0, 0, 1), 0);
});

test('manifest exposes every highlight option and never overrides native editor appearance', () => {
  const manifest = require('../package.json');
  assert.ok(manifest.activationEvents.includes('onFileSystem:fanqie'));
  assert.ok(manifest.contributes.languages.some(language => language.id === 'fanqie-novel'));
  assert.deepEqual(manifest.contributes.configurationDefaults, { '[fanqie-novel]': { 'editor.minimap.enabled': true } });
  const properties = manifest.contributes.configuration.properties;
  for (const kind of ['dialogue', 'innerQuotes', 'keywords']) {
    for (const suffix of ['enabled', 'color', 'opacity']) assert.ok(properties['fanqie.reader.highlight.' + kind + '.' + suffix]);
  }
  assert.equal(properties['fanqie.reader.highlight.dialogue.enabled'].default, true);
  assert.equal(properties['fanqie.reader.highlight.innerQuotes.enabled'].default, false);
  assert.deepEqual(properties['fanqie.reader.highlight.keywords.words'].default, []);
  assert.ok(manifest.contributes.keybindings.filter(binding => binding.command.startsWith('fanqie.reader.')).every(binding => binding.when.includes('editorTextFocus') && binding.when.includes('resourceScheme == fanqie') && binding.key.includes('ctrl+alt+')));
  const front = fs.readFileSync(path.join(__dirname, '../media/app.js'), 'utf8');
  assert.doesNotMatch(front, /function (paginate|renderReader|enterReader)|navPage\(|--reader-font-size/);
  assert.match(front, /call\('open-editor-book'/);
  assert.match(front, /call\('ready'/);
});

const { readingPalette, validColor } = require('../out/reader/palette');

test('default and high-contrast palettes preserve the native theme', () => {
  assert.deepEqual(readingPalette('theme', false), {});
  assert.deepEqual(readingPalette('theme', true), {});
  assert.deepEqual(readingPalette('warm', false, true), {});
  assert.deepEqual(readingPalette('unknown', false), {});
});

test('reading presets provide valid dark/light foreground-only colors', () => {
  for (const name of ['soft', 'warm', 'cool']) {
    const dark = readingPalette(name, false);
    const light = readingPalette(name, true);
    for (const key of ['foreground', 'dialogue', 'innerQuotes', 'keywords']) {
      assert.ok(validColor(dark[key]));
      assert.ok(validColor(light[key]));
      assert.notEqual(dark[key], light[key]);
    }
    assert.equal(dark.background, undefined);
  }
});

test('custom colors accept only hex RGB/RGBA, never injected CSS', () => {
  for (const color of ['#AABBCC', '#aabbcc', '#AABBCC80']) assert.equal(validColor(color), color);
  for (const color of ['', 'red', '#abc', '#FFFFFG', 'url(https://example.test)', null, 123]) assert.equal(validColor(color), '');
});

test('safe labels never split an emoji surrogate pair when truncating a tab title', () => {
  const title = 'x'.repeat(159) + '😀' + 'tail';
  assert.equal(safeLabel(title, 'title'), 'x'.repeat(159) + '😀');
});

const { chaptersPerPage, pageChapterIds, readingPage, sectionAtLine } = require('../out/reader/content');

test('page counts default to one and remain bounded whole numbers', () => {
  for (const input of [null, undefined, '5', 2.5, NaN, Infinity]) assert.equal(chaptersPerPage(input), 1);
  assert.equal(chaptersPerPage(3), 3);
  assert.equal(chaptersPerPage(-4), 1);
  assert.equal(chaptersPerPage(100), 50);
});

test('multi-chapter files use stable catalog groups including an incomplete final page', () => {
  const chapters = Array.from({ length: 8 }, (_, i) => ({ itemId: String(i + 1) }));
  assert.deepEqual(pageChapterIds(chapters, '1', 3), ['1', '2', '3']);
  assert.deepEqual(pageChapterIds(chapters, '3', 3), ['1', '2', '3']);
  assert.deepEqual(pageChapterIds(chapters, '5', 3), ['4', '5', '6']);
  assert.deepEqual(pageChapterIds(chapters, '8', 3), ['7', '8']);
  assert.deepEqual(pageChapterIds(chapters, '8', 1), ['8']);
  assert.deepEqual(pageChapterIds(chapters, 'unlisted', 3), ['unlisted']);
});

test('combined documents contain every complete chapter and track exact section line offsets', () => {
  const chapters = [
    { itemId: 'a', title: '第一章', paragraphs: ['正文一', '“对话。”'] },
    { itemId: 'b', title: '第二章', paragraphs: ['正文二\n段内换行'] },
    { itemId: 'c', title: '第三章', paragraphs: ['正文三'] },
  ];
  const page = readingPage(chapters);
  assert.equal(page.text, chapters.map(chapterText).join('\n'));
  const lines = page.text.split('\n');
  for (const section of page.sections) assert.equal(lines[section.startLine], section.title);
  assert.equal(sectionAtLine(page.sections, page.sections[1].startLine).itemId, 'b');
  assert.equal(sectionAtLine(page.sections, page.sections[0].endLine).itemId, 'a');
  assert.equal(sectionAtLine(page.sections, lines.length - 1).itemId, 'c');
  assert.equal(readingPage([chapters[0]]).text, chapterText(chapters[0]));
  assert.throws(() => readingPage([]), /没有可展示/);
});

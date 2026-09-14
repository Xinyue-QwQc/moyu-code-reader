const test = require('node:test');
const assert = require('node:assert/strict');
const { camouflageMode, camouflageTokens, CAMOUFLAGE_TOKEN_TYPES } = require('../out/reader/camouflage');
const { chapterText, readingPage } = require('../out/reader/content');
const { findPageQuotes } = require('../out/reader/quotes');

const prose = '雨停的时候，站台只剩下一盏灯。林舟收起伞，沿着青石路慢慢往前走。\n“你终于到了。”门口的人抬起头，声音和信里写的一样平静。\n如果他看见那3个人，就会打开门。';
function tokenPairs(text, mode) { return camouflageTokens(text, mode).map(token => [text.slice(token.start, token.end), token.kind]); }

test('experimental code camouflage is strictly opt-in with two explicit densities', () => {
  for (const value of [undefined, null, true, 'random', 'strong', 2, 'off']) assert.equal(camouflageMode(value), 'off');
  assert.equal(camouflageMode('balanced'), 'balanced');
  assert.equal(camouflageMode('dense'), 'dense');
  assert.deepEqual(camouflageTokens(prose, 'off'), []);
  const properties = require('../package.json').contributes.configuration.properties;
  assert.equal(properties['fanqie.reader.experimental.codeCamouflage'].default, 'off');
});

test('narrative text gets several code-like roles rather than only coloring dialogue', () => {
  const tokens = camouflageTokens(prose, 'balanced');
  const kinds = new Set(tokens.filter(token => token.line === 0).map(token => token.kind));
  assert.ok(kinds.size >= 4);
  assert.ok(tokens.some(token => prose.slice(token.start, token.end) === '如果' && token.kind === 'keyword'));
  assert.ok(tokens.some(token => prose.slice(token.start, token.end) === '3' && token.kind === 'number'));
  assert.ok(tokens.every(token => CAMOUFLAGE_TOKEN_TYPES.includes(token.kind)));
});

test('balanced mode keeps speech whole; dense mode diversifies speech and produces finer segmentation', () => {
  const speech = '“你终于到了。我们等了很久，雨后的路比想象中更长。”';
  const balanced = camouflageTokens(speech, 'balanced');
  assert.deepEqual(balanced.map(token => [speech.slice(token.start, token.end), token.kind]), [[speech, 'string']]);
  const dense = camouflageTokens(speech, 'dense');
  assert.ok(new Set(dense.map(token => token.kind)).size >= 4);
  assert.ok(camouflageTokens(prose, 'dense').length > camouflageTokens(prose, 'balanced').length);
});

test('tokens are deterministic and independent of page offsets, paragraph spacing, and scroll position', () => {
  assert.deepEqual(camouflageTokens(prose, 'dense'), camouflageTokens(prose, 'dense'));
  const line = prose.split('\n')[0];
  const alone = tokenPairs(line, 'dense');
  for (const before of ['', '\n\n', '别的章节标题\n\n旧段落\n']) {
    const combined = before + line + '\n\n';
    const spans = camouflageTokens(combined, 'dense').filter(token => token.start >= before.length && token.end <= before.length + line.length);
    assert.deepEqual(spans.map(token => [combined.slice(token.start, token.end), token.kind]), alone);
  }
  const chapter = { itemId: 'one', title: '第一章', paragraphs: prose.split('\n') };
  const normal = readingPage([chapter]);
  const spaced = readingPage([chapter], 3);
  const pairs = page => camouflageTokens(page.text, 'balanced', findPageQuotes(page)).map(token => [page.text.slice(token.start, token.end), token.kind]);
  assert.deepEqual(pairs(spaced), pairs(normal));
});

test('tokens do not split Unicode graphemes, overlap, span newlines or alter the source text', () => {
  const text = '林舟😀说：“咖啡e\u0301，👨‍👩‍👧‍👦在那边。”\r\n𠮷野与🇨🇳队伍来到山下；横线——与……也在。';
  const grapheme = new Intl.Segmenter('zh', { granularity: 'grapheme' });
  const boundaries = new Set([text.length, ...Array.from(grapheme.segment(text), part => part.index)]);
  for (const mode of ['balanced', 'dense']) {
    const tokens = camouflageTokens(text, mode);
    let end = 0;
    for (const token of tokens) {
      assert.ok(token.start >= end && token.end > token.start);
      assert.ok(boundaries.has(token.start) && boundaries.has(token.end), 'whole grapheme boundaries');
      assert.ok(!/[\r\n]/.test(text.slice(token.start, token.end)));
      const lineStart = text.lastIndexOf('\n', token.start - 1) + 1;
      assert.equal(token.character, token.start - lineStart);
      end = token.end;
    }
    assert.equal(tokens.map(token => text.slice(token.start, token.end)).join(''), text.replace(/\s/g, ''));
  }
});

test('blank paragraphs and chapter boundaries retain quote recovery in experimental mode', () => {
  const chapters = [
    { itemId: 'a', title: '第一章', paragraphs: ['“第一段', '第二段。”', '没有闭合的“'] },
    { itemId: 'b', title: '第二章', paragraphs: ['不是上章的对白”', '「独立说话。」'] },
  ];
  const page = readingPage(chapters, 2);
  const tokens = camouflageTokens(page.text, 'balanced', findPageQuotes(page));
  for (const content of ['“第一段', '第二段。”', '「独立说话。」']) assert.ok(tokens.some(token => page.text.slice(token.start, token.end) === content && token.kind === 'string'));
  assert.equal(page.text, chapters.map(chapter => chapterText(chapter, 2)).join('\n'));
});

test('long multi-chapter text remains complete and practical to tokenize', () => {
  const text = Array.from({ length: 1500 }, () => prose).join('\n');
  const start = performance.now();
  const tokens = camouflageTokens(text, 'dense');
  assert.ok(tokens.length > 20000);
  assert.ok(tokens[tokens.length - 1].end === text.length);
  assert.ok(performance.now() - start < 5000, 'linear segmentation should not stall the editor');
});

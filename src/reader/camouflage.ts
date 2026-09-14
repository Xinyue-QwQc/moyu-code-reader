import { QuoteSpans, findQuotes } from './quotes';

export const CAMOUFLAGE_TOKEN_TYPES = ['property', 'string', 'keyword', 'function', 'type', 'number', 'comment', 'operator'] as const;
export type CamouflageKind = typeof CAMOUFLAGE_TOKEN_TYPES[number];
export type CamouflageMode = 'off' | 'balanced' | 'dense';
export interface CamouflageToken {
  /** UTF-16 offsets, as required by native VS Code tokenization. */
  start: number;
  end: number;
  line: number;
  character: number;
  kind: CamouflageKind;
}

export function camouflageMode(value: unknown): CamouflageMode {
  return value === 'balanced' || value === 'dense' ? value : 'off';
}

const words = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const keyword = /^(如果|否则|但是|然而|于是|只是|因为|所以|直到|仍然|已经|没有|不再|并且|而且|是否|假如|即使|虽然|然后|终于|一旦|无论|只有|不过|原来|else|if|return|true|false|null)$/i;
const number = /^(?:\d+(?:[.,]\d+)*|[零〇一二三四五六七八九十百千万亿两]+)(?:年|月|日|天|人|个|里|岁|次|秒|分|章|点|%|％)?$/u;
const callable = /^(说|说道|说着|问|问道|回答|喊|笑|叹|点头|摇头|回头|抬头|看|看见|发现|打开|关上|走|走进|想|想到|转身|起身|望向|伸手)$/;
const punctuation = /^[\p{P}\p{S}]+$/u;
const grouping = ['property', 'function', 'type', 'string', 'property', 'comment'] as const;

/** Content-derived variation stays stable after scrolling, regrouping chapters and adding blank lines. */
function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
}

/**
 * Deliberately synthetic syntax, not linguistic analysis. Keep words/graphemes intact rather than
 * assigning a random color to every character. Returns sorted, disjoint, single-line native tokens.
 * The same logical paragraph always gets the same token boundaries and roles, independently of page size.
 */
export function camouflageTokens(text: string, mode: CamouflageMode, quotes: QuoteSpans = findQuotes(text)): CamouflageToken[] {
  if (mode === 'off') return [];
  const result: CamouflageToken[] = [];
  const dialogue = quotes.dialogue;
  let quoteIndex = 0;
  let line = 0;
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    const end = newline < 0 ? text.length : newline;
    const value = text.slice(lineStart, end).replace(/\r$/, '');
    const seed = hash(value);
    let group = 0;
    let part: { start: number; end: number; units: number; quoted: boolean } | undefined;
    const target = () => mode === 'dense' ? 3 + ((seed + group) % 3) : 7 + ((seed + group) % 5);
    const append = (start: number, finish: number, kind: CamouflageKind) => {
      if (finish <= start) return;
      const previous = result[result.length - 1];
      if (previous && previous.line === line && previous.kind === kind && previous.end === lineStart + start) previous.end = lineStart + finish;
      else result.push({ start: lineStart + start, end: lineStart + finish, line, character: start, kind });
    };
    const flush = () => {
      if (!part) return;
      const kind = part.quoted && mode === 'balanced' ? 'string' : grouping[(seed + group) % grouping.length];
      append(part.start, part.end, kind);
      group++;
      part = undefined;
    };
    for (const segment of words.segment(value)) {
      const start = segment.index;
      const finish = start + segment.segment.length;
      const absolute = lineStart + start;
      while (quoteIndex < dialogue.length && dialogue[quoteIndex].end <= absolute) quoteIndex++;
      const quoted = quoteIndex < dialogue.length && dialogue[quoteIndex].start <= absolute && dialogue[quoteIndex].end >= lineStart + finish;
      if (/^\s+$/u.test(segment.segment)) { flush(); continue; }
      // Balanced mode keeps entire speech blocks together, including their punctuation and numbers.
      if (quoted && mode === 'balanced') {
        if (part && !part.quoted) flush();
        if (!part) part = { start, end: finish, units: 0, quoted: true };
        else part.end = finish;
        continue;
      }
      let special: CamouflageKind | undefined;
      if (keyword.test(segment.segment)) special = 'keyword';
      else if (number.test(segment.segment)) special = 'number';
      else if (callable.test(segment.segment)) special = 'function';
      else if (punctuation.test(segment.segment)) special = 'operator';
      if (special) { flush(); append(start, finish, special); continue; }
      if (part && part.quoted !== quoted) flush();
      if (!part) part = { start, end: finish, units: 0, quoted };
      part.end = finish;
      part.units += Array.from(segment.segment).length;
      if (part.units >= target()) flush();
    }
    flush();
    if (newline < 0) break;
    lineStart = newline + 1;
    line++;
  }
  return result;
}

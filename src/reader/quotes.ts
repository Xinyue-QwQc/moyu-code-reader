import { chapterText, displayLine, ReadingPage } from './content';

/** UTF-16 offsets match VS Code's document.positionAt, including text with emoji. */
export interface TextSpan { start: number; end: number }
export interface QuoteSpans { dialogue: TextSpan[]; innerQuotes: TextSpan[] }

const quotePairs: Record<string, string> = { '“': '”', '「': '」', '『': '』', '"': '"', '‘': '’' };

export function mergeSpans(spans: TextSpan[]): TextSpan[] {
  const result: TextSpan[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const previous = result[result.length - 1];
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else result.push({ ...span });
  }
  return result;
}

/** Balanced quotation marks only; unmatched quotes never tint the rest of a chapter. */
export function findQuotes(text: string): QuoteSpans {
  const result: QuoteSpans = { dialogue: [], innerQuotes: [] };
  const stack: Array<{ open: string; close: string; start: number }> = [];
  let backslashes = 0;
  let lineHasText = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const escaped = backslashes % 2 === 1;
    backslashes = char === '\\' ? backslashes + 1 : 0;
    if (char === '\n') {
      if (!lineHasText) stack.length = 0;
      lineHasText = false;
      continue;
    }
    if (!/\s/.test(char)) lineHasText = true;
    if (escaped) continue;
    const top = stack[stack.length - 1];
    if (top && char === top.close) {
      stack.pop();
      result[top.open === '‘' ? 'innerQuotes' : 'dialogue'].push({ start: top.start, end: index + 1 });
    } else if (quotePairs[char]) {
      stack.push({ open: char, close: quotePairs[char], start: index });
    }
  }
  return { dialogue: mergeSpans(result.dialogue), innerQuotes: mergeSpans(result.innerQuotes) };
}

/** Literal keywords, never executable regular expressions. Prefer the longest overlapping name. */
export function findKeywords(text: string, words: readonly string[]): TextSpan[] {
  const unique = [...new Set(words.map(word => word.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!unique.length) return [];
  const pattern = unique.map(word => word.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&')).join('|');
  const expression = new RegExp(pattern, 'gu');
  return Array.from(text.matchAll(expression), match => ({ start: match.index!, end: match.index! + match[0].length }));
}

/** Give inner quotes / explicit names deterministic precedence, without overlapping color rules. */
export function subtractSpans(source: TextSpan[], exclusions: TextSpan[]): TextSpan[] {
  const cuts = mergeSpans(exclusions);
  const result: TextSpan[] = [];
  let cutIndex = 0;
  for (const span of mergeSpans(source)) {
    let start = span.start;
    while (cutIndex < cuts.length && cuts[cutIndex].end <= start) cutIndex++;
    for (let index = cutIndex; index < cuts.length && cuts[index].start < span.end; index++) {
      const cut = cuts[index];
      if (cut.start > start) result.push({ start, end: Math.min(cut.start, span.end) });
      start = Math.max(start, cut.end);
      if (start >= span.end) break;
    }
    if (start < span.end) result.push({ start, end: span.end });
  }
  return result;
}

/** Parse original paragraphs, then map offsets to a spaced page; presentation blanks aren't punctuation. */
export function findPageQuotes(page: ReadingPage): QuoteSpans {
  const lineStarts = (text: string) => {
    const starts = [0];
    for (let index = 0; index < text.length; index++) if (text[index] === '\n') starts.push(index + 1);
    return starts;
  };
  const displayed = lineStarts(page.text);
  const result: QuoteSpans = { dialogue: [], innerQuotes: [] };
  page.chapters.forEach((chapter, index) => {
    const source = chapterText(chapter);
    const starts = lineStarts(source);
    const section = page.sections[index];
    const offset = (value: number) => {
      let low = 0, high = starts.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (starts[mid] <= value) low = mid; else high = mid - 1;
      }
      return displayed[displayLine(section, low)] + value - starts[low];
    };
    const quotes = findQuotes(source);
    for (const kind of ['dialogue', 'innerQuotes'] as const) result[kind].push(...quotes[kind].map(span => ({ start: offset(span.start), end: offset(span.end) })));
  });
  return result;
}

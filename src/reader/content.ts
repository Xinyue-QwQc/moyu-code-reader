import type { ChapterData, ChapterItem, Directory } from '../api/fanqie';

export const READER_SCHEME = 'fanqie';
export const READER_LANGUAGE = 'fanqie-novel';
export const CHAPTER_EXTENSION = '.fanqie';
export const MAX_CHAPTERS_PER_PAGE = 50;

/** No fake code, pagination, reflow, or injected indentation: one paragraph per logical line. */
export function chapterText(chapter: Pick<ChapterData, 'title' | 'paragraphs'>): string {
  const normalize = (text: string) => text.replace(/\r\n?/g, '\n');
  const body = chapter.paragraphs.map(normalize).join('\n');
  if (!body.trim()) throw new Error('章节正文为空，请重试或在番茄官方平台检查章节权限。');
  return normalize(chapter.title).trim() + '\n\n' + body + '\n';
}

export function safeLabel(value: string, fallback: string): string {
  return Array.from((value || fallback).replace(/[\x00-\x1f\x7f/\\]/g, ' ').trim()).slice(0, 160).join('') || fallback;
}

export function isBookId(value: string): boolean {
  return /^\d{10,}$/.test(value);
}

export function flattenDirectory(directory: Directory): ChapterItem[] {
  const byId = new Map<string, ChapterItem>();
  for (const volume of directory.volumes) {
    for (const chapter of volume.chapters) {
      if (chapter.itemId && !byId.has(chapter.itemId)) {
        byId.set(chapter.itemId, { ...chapter, volume_name: volume.volume_name });
      }
    }
  }
  // allItemIds is the authoritative ordering when the service supplies it.
  const ids = [...new Set([...directory.allItemIds, ...byId.keys()])].filter(Boolean);
  return ids.map((itemId, index) => byId.get(itemId) ?? { itemId, title: '第' + (index + 1) + '章' });
}

export interface SavedPosition {
  line: number;
  character: number;
  topLine: number;
  topCharacter: number;
  updatedAt: number;
}

export function positionKey(bookId: string, itemId: string): string {
  return bookId + ':' + itemId;
}

export function chapterProgress(topLine: number, bottomLine: number, lineCount: number): number {
  if (topLine <= 0) return 0;
  if (bottomLine >= lineCount - 1) return 100;
  return Math.min(99, Math.max(0, Math.round(topLine / Math.max(1, lineCount - 1) * 100)));
}

export interface ChapterSection {
  itemId: string;
  title: string;
  startLine: number;
  endLine: number;
}

export interface ReadingPage {
  text: string;
  chapters: ChapterData[];
  sections: ChapterSection[];
}

export function chaptersPerPage(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(1, Math.min(MAX_CHAPTERS_PER_PAGE, value)) : 1;
}

/** Stable, non-overlapping groups: 1–3, 4–6, etc. The last group can contain fewer chapters. */
export function pageChapterIds(chapters: readonly ChapterItem[], itemId: string, count: number): string[] {
  const index = chapters.findIndex(chapter => chapter.itemId === itemId);
  if (index < 0) return [itemId];
  const size = chaptersPerPage(count);
  const start = Math.floor(index / size) * size;
  return chapters.slice(start, start + size).map(chapter => chapter.itemId);
}

/** A page is a single real document; blank lines separate complete, unmodified chapter texts. */
export function readingPage(chapters: ChapterData[]): ReadingPage {
  if (!chapters.length) throw new Error('没有可展示的章节。');
  const sections: ChapterSection[] = [];
  const parts: string[] = [];
  let startLine = 0;
  for (const chapter of chapters) {
    const text = chapterText(chapter);
    const lineCount = text.split('\n').length;
    sections.push({ itemId: chapter.itemId, title: chapter.title, startLine, endLine: startLine + lineCount - 1 });
    parts.push(text);
    startLine += lineCount;
  }
  return { text: parts.join('\n'), chapters, sections };
}

export function sectionAtLine(sections: readonly ChapterSection[], line: number): ChapterSection | undefined {
  return sections.find(section => section.startLine <= line && section.endLine >= line)
    ?? (line < 0 ? sections[0] : sections[sections.length - 1]);
}

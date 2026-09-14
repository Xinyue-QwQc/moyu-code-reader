export interface AgentReadingContext {
  active: boolean;
  capturedAt: string;
  uri: string;
  bookId: string;
  bookTitle: string;
  currentChapterId: string;
  currentChapterTitle: string;
  chapters: Array<{ itemId: string; title: string; startLine: number; endLine: number }>;
  visible: { startLine: number; endLine: number; text: string };
  selection: { startLine: number; endLine: number; text: string };
  text: string;
}

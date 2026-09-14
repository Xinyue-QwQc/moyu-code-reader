// Original, synthetic prose for deterministic offline tests. Never shipped in the VSIX.
const BOOK_ID = '9000000000000000000';
const ITEMS = Array.from({ length: 8 }, (_, index) => String(BigInt(BOOK_ID) + BigInt(index + 1)));
const cover = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="80"><rect width="60" height="80" fill="#304659"/></svg>').toString('base64');
const book = {
  book_id: BOOK_ID, book_name: '远山来信 · 原生阅读验证样章', author: '测试文本',
  abstract: '用于验证原生编辑器的原创样章，不来自远端书籍。', thumb_url: cover,
  creation_status: '0', word_number: 16000, serial_count: ITEMS.length,
  last_chapter_item_id: ITEMS.at(-1), last_chapter_title: '第八章 归途', category: '小说', score: '9.0', read_count: 0,
};
const beginnings = [
  '雨停的时候，站台只剩下一盏灯。林舟收起伞，沿着青石路慢慢往前走。',
  '“你终于到了。”门口的人抬起头，声音和信里写的一样平静。',
  '林舟说：“我想来看看，那封信里提到的山，究竟是什么样子。”',
  '屋里没有开灯。窗外的河流映着微光，像一条缓缓展开的银色丝带。',
  '他望向远处，心想：‘如果明天放晴，就沿着河边走到桥头。’',
  '「先坐一会儿吧。」她把杯子放下，「路还很长，不必急着出发。」',
  '桌上摊着一本旧地图。林舟指向一条细线，问：“这里也有路？”',
  '“有。”她回答，“只不过很少有人走了。”',
];
const chapters = ITEMS.map((itemId, index) => ({
  itemId, bookId: BOOK_ID, bookName: book.book_name, author: book.author,
  title: ['第一章 雨后的站台', '第二章 河边的路', '第三章 迟来的信', '第四章 远山', '第五章 灯火', '第六章 重逢', '第七章 旧地图', '第八章 归途'][index],
  preItemId: ITEMS[index - 1] || '', nextItemId: ITEMS[index + 1] || '',
  needPay: 0, isChapterLock: false, content: '',
  paragraphs: Array.from({ length: 210 }, (_, paragraph) => beginnings[paragraph % beginnings.length] + (paragraph >= 8 ? '（测试段落 ' + (paragraph + 1) + '）' : '')),
  chapterWordNumber: '8000', realChapterOrder: String(index + 1), serialCount: String(ITEMS.length), source: 'api',
}));

const OTHER_BOOK_ID = '9000000000000001000';
const OTHER_ITEMS = ['9000000000000001001', '9000000000000001002'];
const otherBook = { ...book, book_id: OTHER_BOOK_ID, book_name: '未打开的书 · 港口', serial_count: 2 };
const otherChapters = OTHER_ITEMS.map((itemId, index) => ({ ...chapters[0], itemId, bookId: OTHER_BOOK_ID,
  bookName: otherBook.book_name, title: '港口 第' + (index + 1) + '章', realChapterOrder: String(index + 1),
  paragraphs: ['这是当前阅读页之外的另一本书。', '“船已经靠岸。”她说。', '另一章的独立内容。'] }));

function installFixtures(api) {
  const calls = new Map();
  const failures = new Map();
  const gates = new Map();
  const mismatches = new Set();
  api.getBookDetail = async id => { if (id === OTHER_BOOK_ID) return { ...otherBook }; if (id !== BOOK_ID) throw new Error('未知测试书籍'); return { ...book }; };
  api.getDirectory = async (id = BOOK_ID) => ({ bookId: id, volumes: [{ volume_name: '第一卷', chapters: (id === OTHER_BOOK_ID ? otherChapters : chapters).map(c => ({ itemId: c.itemId, title: c.title, realChapterOrder: c.realChapterOrder })) }], allItemIds: id === OTHER_BOOK_ID ? OTHER_ITEMS : ITEMS, chapterTotal: id === OTHER_BOOK_ID ? OTHER_ITEMS.length : ITEMS.length });
  api.getChapter = async id => {
    calls.set(id, (calls.get(id) || 0) + 1);
    if (gates.has(id)) await gates.get(id).promise;
    if (failures.get(id)) { failures.set(id, failures.get(id) - 1); throw new Error('测试网络暂时不可用'); }
    const chapter = [...chapters, ...otherChapters].find(c => c.itemId === id);
    if (!chapter) throw new Error('未知测试章节');
    return { ...chapter, bookId: mismatches.has(id) ? '8999999999999999999' : chapter.bookId, paragraphs: [...chapter.paragraphs] };
  };
  api.getUserInfo = async () => null;
  api.getRemoteBookshelf = async () => [];
  api.getBookSimpleInfo = async () => [{ book_id: BOOK_ID, book_name: book.book_name, author_name: book.author, thumb_url: cover }];
  api.getRankCategories = async () => [{ id: 'all', name: '全部', group: ['male', 'female'] }];
  api.getRankList = async () => ({ book_list: [{ bookId: BOOK_ID, bookName: book.book_name, author: book.author, abstract: book.abstract, thumbUri: cover, readCount: '0', currentPos: 1, rankPosDiff: 0, lastChapterTitle: book.last_chapter_title }], total_num: 1, rankTypeText: '测试榜单' });
  api.getEditorList = async () => [];
  api.searchBooks = async () => ({ books: [otherBook], total: 1 });
  api.collectBookCommentLinks = async () => [{ bookId: BOOK_ID, commentId: '9000000000000000011' }];
  api.getBookComment = async () => ({ comment_id: '9000000000000000011', user_id: '0', nick_name: '测试读者', avatar: '', text: '正文由原生编辑器显示，书评只在书城中出现。', create_time: 0, digg_count: 0, reply_count: 0, score: 9 });
  api.updateReadProgress = async () => {};
  return {
    calls, failures, mismatches,
    defer(id) {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      gates.set(id, { promise });
      return () => { gates.delete(id); release(); };
    },
  };
}
module.exports = { BOOK_ID, ITEMS, book, chapters, OTHER_BOOK_ID, OTHER_ITEMS, otherChapters, installFixtures };

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AppError } = require('./model-store.cjs');

const MAX_LIBRARIES = 50;
const MAX_DOCUMENTS = 100;
const MAX_CONTENT = 100000;
const MAX_TOTAL = 5000000;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]/u;
const STOP_WORDS = new Set('的 了 是 在 和 与 及 或 有 为 这 那 我 你 他 她 它 吗 呢 啊 吧 请 什么 如何 怎么 哪个 哪些 是否 一个 一种 关于 the a an and or of to in is are was were how what which please'.split(' '));
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });

function field(value, label, max, trim = true) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) {
    throw new AppError(400, `${label}须为非空文本，不能包含二进制或控制字符，且最多 ${max} 个字符。`);
  }
  return trim ? value.trim() : value;
}

// Chunks are exact source substrings. The 80-character overlap retains context at boundaries.
function splitDocument(document) {
  const chunks = [];
  let start = 0;
  while (start < document.content.length) {
    let end = Math.min(start + 600, document.content.length);
    if (end < document.content.length && /[\ud800-\udbff]/.test(document.content[end - 1])) end--;
    chunks.push({ id: `${document.id}:${chunks.length}`, index: chunks.length, text: document.content.slice(start, end) });
    if (end === document.content.length) break;
    start = end - 80;
    if (/[\udc00-\udfff]/.test(document.content[start])) start++;
  }
  return chunks;
}

function frequencies(text) {
  const result = new Map();
  const add = word => {
    if (word && !STOP_WORDS.has(word)) result.set(word, (result.get(word) || 0) + 1);
  };
  const normalized = text.normalize('NFKC').toLowerCase();
  for (const part of segmenter.segment(normalized)) {
    if (part.isWordLike) add(part.segment);
  }
  // Character terms handle unknown Chinese words; bigrams retain specificity across segmentation differences.
  for (const match of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const chars = Array.from(match[0]);
    for (let i = 0; i < chars.length; i++) {
      add(chars[i]);
      if (i + 1 < chars.length) add(chars[i] + chars[i + 1]);
    }
  }
  return result;
}

function documentSummary(document) {
  return { id: document.id, name: document.name, charCount: document.content.length, chunkCount: document.chunks.length, updatedAt: document.updatedAt };
}

function librarySummary(library) {
  return { id: library.id, name: library.name, documentCount: library.documents.length,
    chunkCount: library.documents.reduce((sum, document) => sum + document.chunks.length, 0), updatedAt: library.updatedAt };
}

function libraryDetail(library) {
  return { ...librarySummary(library), documents: library.documents.map(documentSummary) };
}

function createKnowledgeStore({ filePath = path.join(__dirname, '..', '.local', 'knowledge.json') } = {}) {
  let libraries = [];
  const indexes = new Map();

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.libraries) || parsed.libraries.length > MAX_LIBRARIES) throw new Error();
    const ids = new Set();
    let total = 0;
    function identity(item) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error();
      const id = field(item.id, '标识', 200);
      if (id !== item.id || ids.has(id) || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) throw new Error();
      ids.add(id);
      return { id, name: field(item.name, '名称', 200), updatedAt: item.updatedAt };
    }
    libraries = parsed.libraries.map(item => {
      const library = identity(item);
      if (!Array.isArray(item.documents) || item.documents.length > MAX_DOCUMENTS) throw new Error();
      library.documents = item.documents.map(source => {
        const document = { ...identity(source), content: field(source.content, '文档内容', MAX_CONTENT, false) };
        total += document.content.length;
        document.chunks = splitDocument(document);
        return document;
      });
      return library;
    });
    if (total > MAX_TOTAL) throw new Error();
  } catch (error) {
    if (error.code !== 'ENOENT') throw new AppError(500, '知识库文件读取失败或数据损坏，请检查文件；原文件未修改。');
  }

  function findLibrary(id) {
    const library = libraries.find(item => item.id === id);
    if (!library) throw new AppError(404, '知识库不存在。');
    return library;
  }

  function findDocument(library, id) {
    const document = library.documents.find(item => item.id === id);
    if (!document) throw new AppError(404, '文档不存在。');
    return document;
  }

  function commit(next) {
    const data = JSON.stringify({ version: 1, libraries: next.map(library => ({
      id: library.id, name: library.name, updatedAt: library.updatedAt,
      documents: library.documents.map(({ id, name, content, updatedAt }) => ({ id, name, content, updatedAt })),
    })) });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, filePath);
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* Only remove this operation's temporary file. */ }
      throw new AppError(500, '知识库保存失败，原有数据未改变。');
    }
    libraries = next;
    indexes.clear();
  }

  function replaceLibrary(library) {
    commit(libraries.map(item => item.id === library.id ? library : item));
  }

  function indexFor(library) {
    if (indexes.has(library.id)) return indexes.get(library.id);
    const entries = [];
    const documentFrequency = new Map();
    let totalLength = 0;
    for (const document of library.documents) {
      for (const chunk of document.chunks) {
        const terms = frequencies(chunk.text);
        const length = [...terms.values()].reduce((sum, count) => sum + count, 0);
        totalLength += length;
        entries.push({ document, chunk, terms, length });
        for (const term of terms.keys()) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
      }
    }
    const index = { entries, documentFrequency, averageLength: entries.length ? totalLength / entries.length || 1 : 1 };
    indexes.set(library.id, index);
    return index;
  }

  return {
    list: () => libraries.map(librarySummary),
    get: id => libraryDetail(findLibrary(id)),
    save(body, id) {
      const old = id === undefined ? null : findLibrary(id);
      const name = field(body?.name, '知识库名称', 200);
      if (!old && libraries.length >= MAX_LIBRARIES) throw new AppError(400, '知识库最多允许 50 个。');
      const library = { id: old?.id || randomUUID(), name, documents: old?.documents || [], updatedAt: new Date().toISOString() };
      if (old) replaceLibrary(library); else commit([...libraries, library]);
      return libraryDetail(library);
    },
    remove(id) {
      findLibrary(id);
      commit(libraries.filter(item => item.id !== id));
    },
    saveDocument(kbId, body, docId) {
      const library = findLibrary(kbId);
      const old = docId === undefined ? null : findDocument(library, docId);
      const name = field(body?.name, '文档名称', 200);
      const content = field(body?.content, '文档内容', MAX_CONTENT, false);
      if (!old && library.documents.length >= MAX_DOCUMENTS) throw new AppError(400, '每个知识库最多允许 100 篇文档。');
      const total = libraries.reduce((sum, item) => sum + item.documents.reduce((count, document) => count + document.content.length, 0), 0);
      if (total - (old?.content.length || 0) + content.length > MAX_TOTAL) throw new AppError(400, '知识库文本总量不能超过 500 万字符。');
      const updatedAt = new Date().toISOString();
      const document = { id: old?.id || randomUUID(), name, content, updatedAt };
      document.chunks = splitDocument(document);
      replaceLibrary({ ...library, updatedAt, documents: old ? library.documents.map(item => item.id === docId ? document : item) : [...library.documents, document] });
      return documentSummary(document);
    },
    getDocument(kbId, docId) {
      const document = findDocument(findLibrary(kbId), docId);
      return { ...documentSummary(document), content: document.content, chunks: document.chunks.map(chunk => ({ ...chunk })) };
    },
    removeDocument(kbId, docId) {
      const library = findLibrary(kbId);
      findDocument(library, docId);
      replaceLibrary({ ...library, updatedAt: new Date().toISOString(), documents: library.documents.filter(item => item.id !== docId) });
    },
    search(kbId, options = {}) {
      const library = findLibrary(kbId);
      const query = field(options?.query, '检索问题', 10000);
      const topK = options?.topK === undefined ? 3 : options.topK;
      if (!Number.isInteger(topK) || topK < 1 || topK > 10) throw new AppError(400, '检索片段数量须为 1 到 10 的整数。');
      const queryTerms = frequencies(query);
      const { entries, documentFrequency, averageLength } = indexFor(library);
      const hits = [];
      for (const entry of entries) {
        let score = 0;
        for (const term of queryTerms.keys()) {
          const tf = entry.terms.get(term);
          if (!tf) continue;
          const df = documentFrequency.get(term);
          const idf = Math.log(1 + (entries.length - df + 0.5) / (df + 0.5));
          score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * entry.length / averageLength));
        }
        if (score > 0) hits.push({ documentId: entry.document.id, documentName: entry.document.name,
          chunkId: entry.chunk.id, chunkIndex: entry.chunk.index, text: entry.chunk.text, score });
      }
      hits.sort((a, b) => b.score - a.score);
      return { knowledgeId: library.id, knowledgeName: library.name, query, hits: hits.slice(0, topK) };
    },
  };
}

module.exports = { createKnowledgeStore };

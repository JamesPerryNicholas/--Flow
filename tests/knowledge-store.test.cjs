const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createKnowledgeStore } = require('../lib/knowledge-store.cjs');
const { AppError } = require('../lib/model-store.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'knowledge.json');
  return { directory, filePath, store: createKnowledgeStore({ filePath }) };
}
function fails(fn, status = 400) {
  assert.throws(fn, error => error instanceof AppError && error.status === status && /[\u3400-\u9fff]/.test(error.message));
}
function diskLibrary(id, documents = []) {
  return { id, name: id, updatedAt: '2026-01-01T00:00:00.000Z', documents };
}
function diskDocument(id, content = '有效内容') {
  return { id, name: id, content, updatedAt: '2026-01-01T00:00:00.000Z' };
}
function seed(filePath, libraries) {
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, libraries }));
  return createKnowledgeStore({ filePath });
}

test('持久化 CRUD、重载、元数据与搜索索引同步', t => {
  const { filePath, store } = fixture(t);
  assert.deepEqual(store.list(), []);
  const library = store.save({ name: ' 开发知识 ' });
  assert.equal(library.name, '开发知识');
  const document = store.saveDocument(library.id, { name: '手册', content: ' 苹果栽培需要充足阳光。\nNode.js streams support backpressure. ' });
  assert.equal(document.chunkCount, 1);
  assert.equal(store.get(library.id).documentCount, 1);
  assert.equal('content' in store.get(library.id).documents[0], false);
  assert.equal('documents' in store.list()[0], false);
  let reopened = createKnowledgeStore({ filePath });
  assert.equal(reopened.getDocument(library.id, document.id).content, ' 苹果栽培需要充足阳光。\nNode.js streams support backpressure. ');
  assert.equal(reopened.search(library.id, { query: 'backpressure' }).hits[0].documentId, document.id);
  assert.equal(store.save({ name: '新版' }, library.id).documents.length, 1);
  assert.equal(store.saveDocument(library.id, { name: '更新', content: '香蕉生长在热带。' }, document.id).id, document.id);
  assert.deepEqual(store.search(library.id, { query: 'backpressure' }).hits, []);
  reopened = createKnowledgeStore({ filePath });
  assert.equal(reopened.get(library.id).name, '新版');
  assert.equal(reopened.getDocument(library.id, document.id).content, '香蕉生长在热带。');
  reopened.removeDocument(library.id, document.id);
  assert.equal(createKnowledgeStore({ filePath }).get(library.id).chunkCount, 0);
  reopened.remove(library.id);
  assert.deepEqual(createKnowledgeStore({ filePath }).list(), []);
  fails(() => reopened.get(library.id), 404);
});

test('BM25 中文问句、英文关键词、排序与无命中', t => {
  const { store } = fixture(t);
  const kb = store.save({ name: '技术' });
  const target = store.saveDocument(kb.id, { name: '数据库', content: '数据库索引可以提高查询速度。建立复合索引能优化数据库查询。PostgreSQL transaction isolation protects concurrent updates.' });
  store.saveDocument(kb.id, { name: '食谱', content: '番茄炒蛋需要鸡蛋和番茄。做饭时控制火候。Cooking recipes use vegetables and eggs.' });
  assert.equal(store.search(kb.id, { query: '如何优化数据库索引查询速度？' }).hits[0].documentId, target.id);
  assert.equal(store.search(kb.id, { query: 'POSTGRESQL isolation', topK: 1 }).hits[0].documentId, target.id);
  assert.deepEqual(store.search(kb.id, { query: '袋鼠量子 zzznonexistent' }).hits, []);
  assert.deepEqual(store.search(kb.id, { query: '的 是 和 the' }).hits, []);
  const result = store.search(kb.id, { query: '索引' });
  assert.ok(result.hits.every(hit => Number.isFinite(hit.score) && hit.score > 0));
  assert.equal(result.knowledgeName, '技术');
  // Changing a document invalidates cached term frequencies and corpus statistics.
  store.removeDocument(kb.id, target.id);
  assert.deepEqual(store.search(kb.id, { query: '索引' }).hits, []);
});

test('长文切片均来自原文、80 字交叠、重载标识稳定', t => {
  const { filePath, store } = fixture(t);
  const kb = store.save({ name: '切片' });
  const content = Array.from({ length: 1700 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('');
  const doc = store.saveDocument(kb.id, { name: '长文', content });
  const full = store.getDocument(kb.id, doc.id);
  assert.equal(full.chunks.length, 4);
  assert.equal(full.charCount, content.length);
  for (let i = 0; i < full.chunks.length; i++) {
    const chunk = full.chunks[i];
    assert.equal(chunk.index, i);
    assert.equal(chunk.text, content.slice(i * 520, i * 520 + 600));
    if (i) assert.equal(full.chunks[i - 1].text.slice(-80), chunk.text.slice(0, 80));
  }
  const hit = store.search(kb.id, { query: content.slice(1100, 1110), topK: 1 }).hits[0];
  assert.equal(hit.text, full.chunks[hit.chunkIndex].text);
  assert.equal(hit.chunkId, full.chunks[hit.chunkIndex].id);
  assert.deepEqual(createKnowledgeStore({ filePath }).getDocument(kb.id, doc.id), full);
  const emoji = store.saveDocument(kb.id, { name: '表情', content: '甲'.repeat(599) + '😀'.repeat(400) });
  for (const chunk of store.getDocument(kb.id, emoji.id).chunks) {
    assert.ok(!/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(chunk.text));
  }
});

test('特殊标题作为普通文本，所有返回对象均不能修改内部状态', t => {
  const { directory, store } = fixture(t);
  const name = '<img src=x onerror=alert(1)>../../文件';
  const kb = store.save({ name });
  const doc = store.saveDocument(kb.id, { name, content: '<script>alert(1)</script> 数据库' });
  assert.equal(store.get(kb.id).name, name);
  assert.deepEqual(fs.readdirSync(directory), ['knowledge.json']);
  kb.name = '污染'; kb.documents.push({ id: '伪造' });
  doc.name = '污染';
  const listed = store.list(); listed[0].name = '污染';
  const detail = store.get(kb.id); detail.documents[0].name = '污染';
  const full = store.getDocument(kb.id, doc.id); full.content = '污染'; full.chunks[0].text = '污染';
  const result = store.search(kb.id, { query: '数据库' }); result.hits[0].text = '污染';
  assert.equal(store.get(kb.id).name, name);
  assert.equal(store.get(kb.id).documents[0].name, name);
  assert.equal(store.get(kb.id).documents.length, 1);
  assert.equal(store.getDocument(kb.id, doc.id).chunks[0].text, '<script>alert(1)</script> 数据库');
});

test('字段、控制字符、query、topK 和不存在对象的校验', t => {
  const { store } = fixture(t);
  for (const name of [null, undefined, 1, '', '  ', 'x'.repeat(201), 'a\u0000b', 'a\u0085b']) fails(() => store.save({ name }));
  fails(() => store.save(null));
  const kb = store.save({ name: '合法' });
  for (const content of [null, undefined, 1, {}, '', ' \n\t', 'x'.repeat(100001), 'a\u0000b', 'a\u001bb', '\ufffd']) {
    fails(() => store.saveDocument(kb.id, { name: '文档', content }));
  }
  store.saveDocument(kb.id, { name: '正常', content: '允许\n换行\r\n和\ttab' });
  for (const query of [null, undefined, '', '  ', 1, 'x'.repeat(10001), '\u0000']) fails(() => store.search(kb.id, { query }));
  fails(() => store.search(kb.id, null));
  for (const topK of [0, 11, -1, 1.2, '3', null, NaN]) fails(() => store.search(kb.id, { query: '换行', topK }));
  assert.equal(store.search(kb.id, { query: '换行', topK: 10 }).hits.length, 1);
  fails(() => store.saveDocument('missing', {}), 404);
  fails(() => store.getDocument(kb.id, 'missing'), 404);
  fails(() => store.removeDocument(kb.id, 'missing'), 404);
  fails(() => store.save({ name: '更新' }, 'missing'), 404);
  fails(() => store.saveDocument(kb.id, { name: '更新', content: '正文' }, 'missing'), 404);
  fails(() => store.search('missing', { query: '查询' }), 404);
});

test('库数、文档数、单篇与总文本边界，包括替换文档的容量计算', t => {
  const { filePath } = fixture(t);
  let store = seed(filePath, Array.from({ length: 50 }, (_, i) => diskLibrary(`kb${i}`)));
  fails(() => store.save({ name: '第51库' }));
  assert.equal(store.save({ name: '允许更新' }, 'kb0').name, '允许更新');
  store = seed(filePath, [diskLibrary('full', Array.from({ length: 100 }, (_, i) => diskDocument(`doc${i}`)))]);
  fails(() => store.saveDocument('full', { name: '第101篇', content: '正文' }));
  assert.equal(store.saveDocument('full', { name: '允许更新', content: '正文' }, 'doc0').id, 'doc0');
  store = seed(filePath, [diskLibrary('capacity', Array.from({ length: 50 }, (_, i) => diskDocument(`max${i}`, '甲'.repeat(100000))))]);
  fails(() => store.saveDocument('capacity', { name: '超总量', content: '乙' }));
  assert.equal(store.saveDocument('capacity', { name: '等量更新', content: '乙'.repeat(100000) }, 'max0').charCount, 100000);
  store.saveDocument('capacity', { name: '缩短', content: '乙' }, 'max0');
  assert.equal(store.saveDocument('capacity', { name: '可再增加', content: '丙' }).charCount, 1);
});

test('损坏文件拒绝加载且不覆盖', t => {
  const { filePath } = fixture(t);
  const malformed = [
    '{broken', '[]', JSON.stringify({ version: 2, libraries: [] }),
    JSON.stringify({ version: 1, libraries: [diskLibrary('dup'), diskLibrary('dup')] }),
    JSON.stringify({ version: 1, libraries: [diskLibrary('bad', [diskDocument('doc', '\u0000')])] }),
    JSON.stringify({ version: 1, libraries: [{ ...diskLibrary('bad'), updatedAt: 'invalid' }] }),
    JSON.stringify({ version: 1, libraries: Array.from({ length: 51 }, (_, i) => diskLibrary(`kb${i}`)) }),
  ];
  for (const data of malformed) {
    fs.writeFileSync(filePath, data);
    fails(() => createKnowledgeStore({ filePath }), 500);
    assert.equal(fs.readFileSync(filePath, 'utf8'), data);
  }
});

test('原子写失败不改变内存或已有源文件、不残留临时文件', t => {
  const { filePath, directory, store } = fixture(t);
  const kb = store.save({ name: '保留' });
  const original = fs.readFileSync(filePath, 'utf8');
  const backup = path.join(directory, 'backup.json');
  fs.renameSync(filePath, backup);
  fs.mkdirSync(filePath);
  fails(() => store.save({ name: '不应生效' }, kb.id), 500);
  fails(() => store.saveDocument(kb.id, { name: '不应生效', content: '数据' }), 500);
  fails(() => store.remove(kb.id), 500);
  assert.equal(store.get(kb.id).name, '保留');
  assert.equal(store.get(kb.id).documentCount, 0);
  assert.equal(fs.readFileSync(backup, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['backup.json', 'knowledge.json']);
  fs.rmdirSync(filePath);
  fs.renameSync(backup, filePath);
  assert.deepEqual(createKnowledgeStore({ filePath }).list(), store.list());
});

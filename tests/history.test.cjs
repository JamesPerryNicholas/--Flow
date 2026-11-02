const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../public/run-history.js');
const KEY = 'lingjing-runs-v1';
function memory() {
  const values = new Map();
  return { getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, value) };
}

test('知识检索来源持久化并约束条数、字段和正文长度',()=>{
  const storage=memory(),store=createStore(storage),id=store.start({flowId:'knowledge'});
  const source={documentId:'d',documentName:'<img src=x>',chunkId:'c',chunkIndex:1,text:'资料'.repeat(1000),score:1.2,apiKey:'secret'};
  store.append(id,{type:'knowledge',knowledgeId:'kb',knowledgeName:'库',sources:[null,{...source,score:NaN},source,...Array(15).fill(source)]});store.finish(id,{status:'success'});
  const log=createStore(storage).get(id).logs[0];assert.equal(log.knowledgeName,'库');assert.equal(log.sources.length,8);assert.equal(log.sources[0].documentName,'<img src=x>');assert.ok(log.sources[0].text.endsWith('[内容过长，已截断]'));assert.ok(!JSON.stringify(log).includes('secret'));
});
test('persists records, clones returned values and isolates flows', () => {
  const storage = memory(), store = createStore(storage);
  const id = store.start({ flowId: 'a', flowName: 'A', mode: 'mock', input: 'hello' });
  store.append(id, { id: 'n1', input: 'hello', output: 'world', decision: '包含关键词：是', elapsedMs: 12 });
  store.finish(id, { status: 'success', output: 'world', skipped: ['n2'] });
  const other = store.start({ flowId: 'b', input: 'B' }); store.finish(other, { status: 'cancelled' });
  const reload = createStore(storage);
  assert.equal(reload.list('a').length, 1);
  const record = reload.get(id);
  assert.equal(record.status, 'success'); assert.equal(record.logs[0].output, 'world'); assert.equal(record.logs[0].decision, '包含关键词：是');
  assert.equal(record.output, 'world'); assert.ok(record.endedAt >= record.startedAt); assert.ok(record.elapsedMs >= 0);
  record.logs[0].output = 'changed'; assert.equal(reload.get(id).logs[0].output, 'world');
  reload.clear('a'); assert.equal(reload.list('a').length, 0); assert.equal(reload.list('b').length, 1);
});
test('reload interrupts running records and never resumes or claims success', () => {
  const storage = memory(), store = createStore(storage), id = store.start({ flowId: 'a' });
  store.append(id, { output: 'partial' });
  const saved = JSON.parse(storage.getItem(KEY)); saved.savedAt = saved.records[0].startedAt + 10;
  storage.setItem(KEY, JSON.stringify(saved));
  const reload = createStore(storage), record = reload.get(id);
  assert.equal(record.status, 'interrupted'); assert.match(record.error, /中断/); assert.equal(record.elapsedMs, 10);
  reload.finish(id, { status: 'success' }); assert.equal(reload.get(id).status, 'interrupted');
  assert.equal(createStore(storage).get(id).status, 'interrupted');
});
test('retains 20 per flow and 100 globally in newest-first order', () => {
  const store = createStore(memory()); let latest;
  for (let i = 0; i < 25; i++) latest = store.start({ flowId: 'same', input: String(i) });
  assert.equal(store.list('same').length, 20); assert.equal(store.list('same')[0].id, latest);
  for (let f = 0; f < 10; f++) for (let i = 0; i < 20; i++) store.start({ flowId: String(f) });
  assert.equal(store.list('same').length, 0);
  assert.equal(Array.from({ length: 10 }, (_, f) => store.list(String(f)).length).reduce((a, b) => a + b), 100);
});
test('bounds strings, logs and total capacity with explicit truncation markers', () => {
  const storage = memory(), store = createStore(storage), huge = '长'.repeat(50000);
  const id = store.start({ flowId: 'a', input: huge });
  for (let i = 0; i < 120; i++) store.append(id, { id: String(i), input: huge, output: huge, prompt: huge, error: huge });
  store.finish(id, { status: 'error', output: huge, error: huge });
  const record = store.get(id); assert.match(record.input, /已截断/); assert.match(record.output, /已截断/);
  assert.ok(record.logs.length < 100); assert.ok(record.omittedLogs > 0); assert.match(record.logs[0].output, /已截断/);
  for (let i = 0; i < 100; i++) {
    const next = store.start({ flowId: 'flow' + i, input: huge }); store.append(next, { output: huge }); store.finish(next, { status: 'success', output: huge });
  }
  assert.ok(storage.getItem(KEY).length < 1000000);
});
test('unknown fields and invalid value types cannot persist', () => {
  const storage = memory(), store = createStore(storage);
  const id = store.start({ flowId: 'a', apiKey: 'START_SECRET', input: { apiKey: 'NESTED_SECRET' } });
  store.append(id, { output: 'safe', apiKey: 'LOG_SECRET', model: { apiKey: 'MODEL_SECRET' }, elapsedMs: Infinity, prompt: { value: 'BAD_PROMPT' } });
  store.finish(id, { status: 'success', apiKey: 'FINISH_SECRET', output: { value: 'BAD_OUTPUT' } });
  const raw = storage.getItem(KEY); assert.doesNotMatch(raw, /SECRET|BAD_PROMPT|BAD_OUTPUT|apiKey|Infinity/);
  assert.equal(store.get(id).logs[0].output, 'safe'); assert.equal(store.get(id).logs[0].elapsedMs, undefined);
  assert.throws(() => store.start({ flowId: {} }), /ID/);
  store.append('missing', { output: 'x' }); store.finish('missing', { status: 'success' });
});
test('storage write errors notify and keep an operable memory store', () => {
  const errors = [], store = createStore({ getItem: () => null, setItem: () => { throw Error('quota'); } }, msg => errors.push(msg));
  let changes = 0; const unsubscribe = store.subscribe(() => changes++);
  const id = store.start({ flowId: 'a' }); store.append(id, { output: 'ok' }); unsubscribe(); store.finish(id, { status: 'success' });
  assert.equal(store.get(id).status, 'success'); assert.equal(changes, 2); assert.ok(errors.length >= 1); assert.match(errors[0], /内存/);
});
test('corrupt or structurally invalid storage is never overwritten', () => {
  for (const raw of ['{bad', JSON.stringify({ version: 1, records: [{ id: 'x' }] }), JSON.stringify({ version: 2, records: [] })]) {
    const storage = memory(); storage.setItem(KEY, raw); const errors = [], store = createStore(storage, msg => errors.push(msg));
    assert.equal(errors.length, 1); assert.match(errors[0], /原始数据已保留/);
    const id = store.start({ flowId: 'a' }); store.finish(id, { status: 'success' }); store.clear('a');
    assert.equal(storage.getItem(KEY), raw);
  }
});
test('storage read errors notify without writing over unknown data', () => {
  let writes = 0, reports = 0;
  const store = createStore({ getItem() { throw Error('denied'); }, setItem() { writes++; } }, () => reports++);
  const id = store.start({ flowId: 'a' }); assert.ok(store.get(id)); assert.equal(reports, 1); assert.equal(writes, 0);
});

test('HTTP request and response metadata survive reload, credential values are excluded', () => {
  const storage=memory(),store=createStore(storage),id=store.start({flowId:'http'});
  store.append(id,{id:'tool',type:'http',request:'POST https://example.com\n\n{"q":"query"}',httpStatus:201,contentType:'application/json',output:'result',secret:'SECRET',headers:{Authorization:'SECRET'}});
  store.finish(id,{status:'success',output:'result'});
  const record=createStore(storage).get(id);
  assert.equal(record.logs[0].httpStatus,201);assert.equal(record.logs[0].contentType,'application/json');assert.match(record.logs[0].request,/POST https:/);
  assert.doesNotMatch(storage.getItem(KEY),/SECRET|Authorization|headers/);
});

test('JSON output declarations survive history reload and invalid types are discarded', () => {
  const storage = memory(), store = createStore(storage), id = store.start({ flowId: 'json' });
  store.append(id, { id: 'json', output: '{"count":0,"enabled":false}', outputType: 'json' });
  store.append(id, { id: 'text', output: 'text', outputType: 'text' });
  store.append(id, { id: 'invalid', output: 'text', outputType: { type: 'json' } });
  store.finish(id, { status: 'success' });
  const logs = createStore(storage).get(id).logs;
  assert.equal(logs[0].outputType, 'json');
  assert.equal(logs[0].output, '{"count":0,"enabled":false}');
  assert.equal(logs[1].outputType, 'text');
  assert.equal(logs[2].outputType, undefined);
});

test('batch child metadata and nested positions survive reload, unsafe indexes are dropped',()=>{
  const storage=memory(),store=createStore(storage),id=store.start({flowId:'root'});
  store.append(id,{id:'child',batchNodeId:'batch',workflowId:'worker',workflowName:'单项流程',iterationIndex:2,iterationTotal:5,iterationPath:[1,2],output:'false',status:'success'});
  store.append(id,{iterationIndex:-1,iterationTotal:101,iterationPath:[Infinity]});
  store.finish(id,{status:'success'});
  const logs=createStore(storage).get(id).logs;
  assert.equal(logs[0].batchNodeId,'batch');assert.equal(logs[0].iterationIndex,2);assert.deepEqual(logs[0].iterationPath,[1,2]);assert.equal(logs[0].workflowName,'单项流程');
  assert.equal(logs[1].iterationIndex,undefined);assert.equal(logs[1].iterationTotal,undefined);assert.equal(logs[1].iterationPath,undefined);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationStore } = require('../lib/conversation-store.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { filePath: path.join(dir, 'conversations.json') };
  return { dir, options, store: createConversationStore(options) };
}
const turn = (input = '问题', output = '回答') => ({ input, output, runId: 'run-1' });
const status = code => error => error.status === code;

test('固定应用、版本和模式；详情引用隔离、持久重载与删除', t => {
  const { store, options } = fixture(t);
  const first = store.create('app', 1, 'live');
  store.create('app', 2, 'live'); store.create('app', 1, 'simulation'); store.create('other', 1, 'live');
  assert.equal(store.list('app', 1, 'live').length, 1);
  first.mode = 'simulation';
  const detail = store.append('app', first.id, { ...turn(), appId: 'other', version: 2, mode: 'simulation' });
  assert.equal(detail.mode, 'live'); assert.equal(detail.version, 1); assert.equal(detail.appId, 'app');
  detail.turns[0].output = '污染';
  assert.equal(store.get('app', first.id).turns[0].output, '回答');
  const listing = store.list('app', 1, 'live');
  assert.equal(listing[0].turnCount, 1); assert.equal(listing[0].turns, undefined);
  listing[0].appId = 'other';
  assert.equal(store.get('app', first.id).appId, 'app');
  assert.throws(() => store.get('other', first.id), status(404));
  assert.throws(() => store.remove('other', first.id), status(404));
  assert.throws(() => store.append('other', first.id, turn()), status(404));
  assert.throws(() => store.context('other', first.id), status(404));
  const restart = createConversationStore(options);
  assert.deepEqual(restart.get('app', first.id), store.get('app', first.id));
  restart.remove('app', first.id);
  assert.throws(() => createConversationStore(options).get('app', first.id), status(404));
});

test('ID、版本、模式与输入边界，特殊名字不会访问对象原型', t => {
  const { store } = fixture(t);
  for (const id of ['', '../app', '__proto__', 'a'.repeat(101), {}, null]) {
    assert.throws(() => store.create(id, 1, 'live'), status(400));
    assert.throws(() => store.get('app', id), status(400));
  }
  for (const version of [0, -1, 1.1, '1', Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => store.create('app', version, 'live'), status(400));
  assert.throws(() => store.create('app', 1, 'bad'), status(400));
  assert.throws(() => store.list('app', 0, 'live'), status(400));
  const row = store.create('constructor', 1, 'simulation');
  assert.throws(() => store.get('constructor', 'constructor'), status(404));
  for (const value of [null, {}, turn(4), turn('x'.repeat(10001)), turn('', null), { ...turn(), runId: '__proto__' }]) assert.throws(() => store.append('constructor', row.id, value), status(400));
  const accepted = store.append('constructor', row.id, turn('x'.repeat(10000), 'x'.repeat(100000)));
  assert.equal(accepted.turns[0].outputTruncated, false);
});

test('保留20轮及250000字符，截断输出标识与省略计数持久化', t => {
  const { store, options } = fixture(t), row = store.create('app', 1, 'live');
  for (let i = 0; i < 22; i++) store.append('app', row.id, turn(String(i), '答'));
  let detail = store.get('app', row.id);
  assert.equal(detail.turns.length, 20); assert.equal(detail.omittedTurns, 2); assert.equal(detail.turns[0].input, '2');
  for (let i = 0; i < 3; i++) detail = store.append('app', row.id, turn('x'.repeat(10000), 'y'.repeat(100001)));
  assert.equal(detail.turns.length, 2); assert.equal(detail.omittedTurns, 23);
  assert.equal(detail.turns[0].output.length, 100000); assert.equal(detail.turns[0].outputTruncated, true);
  assert.deepEqual(createConversationStore(options).get('app', row.id), detail);
});

test('上下文最多最新10对、60000字符，不跨越截断或预算边界', t => {
  const { store } = fixture(t), row = store.create('app', 1, 'live');
  for (let i = 0; i < 12; i++) store.append('app', row.id, turn(String(i), `答${i}`));
  let context = store.context('app', row.id);
  assert.equal(context.length, 20); assert.deepEqual(context[0], { role: 'user', content: '2' });
  assert.deepEqual(context.at(-1), { role: 'assistant', content: '答11' });
  context[0].content = '污染'; assert.equal(store.context('app', row.id)[0].content, '2');
  store.append('app', row.id, turn('', 'x'.repeat(100001)));
  assert.deepEqual(store.context('app', row.id), []);
  store.append('app', row.id, turn('新问题', '新回答'));
  assert.deepEqual(store.context('app', row.id), [{ role: 'user', content: '新问题' }, { role: 'assistant', content: '新回答' }]);
  store.append('app', row.id, turn('', 'x'.repeat(60001)));
  assert.deepEqual(store.context('app', row.id), []);
  store.append('app', row.id, turn('', 'x'.repeat(30000)));
  store.append('app', row.id, turn('', 'y'.repeat(30000)));
  context = store.context('app', row.id);
  assert.equal(context.length, 4); assert.equal(context[1].content.length + context[3].content.length, 60000);
});

test('100会话上限拒绝新建，原有会话不删除', t => {
  const { store, options } = fixture(t);
  const first = store.create('app', 1, 'live');
  for (let i = 1; i < 100; i++) store.create('app', 1, 'live');
  const before = fs.readFileSync(options.filePath, 'utf8');
  assert.throws(() => store.create('other', 1, 'simulation'), /100/);
  assert.equal(fs.readFileSync(options.filePath, 'utf8'), before);
  assert.equal(store.get('app', first.id).id, first.id);
  store.remove('app', first.id); store.create('other', 1, 'simulation');
});

test('损坏、篡改、重复、特殊字段、超限文件拒绝读取且不覆盖', t => {
  const { store, options } = fixture(t), row = store.create('app', 1, 'live');
  store.append('app', row.id, turn());
  const original = fs.readFileSync(options.filePath, 'utf8');
  const mutations = [
    value => { value.schema = 2; },
    value => { value.conversations.push(value.conversations[0]); },
    value => { value.conversations[0].mode = 'other'; },
    value => { value.conversations[0].version = 0; },
    value => { value.conversations[0].omittedTurns = -1; },
    value => { value.conversations[0].createdAt = 'bad'; },
    value => { value.conversations[0].turns[0].createdAt = '2000-01-01T00:00:00.000Z'; },
    value => { value.conversations[0].turns[0].outputTruncated = true; },
    value => { value.conversations[0].turns[0].input = 'x'.repeat(10001); },
    value => { value.conversations[0].turns[0].output = 'x'.repeat(100001); },
    value => { value.conversations[0].turns = Array(21).fill(value.conversations[0].turns[0]); },
    value => { value.conversations[0].turns = Array(3).fill({ ...value.conversations[0].turns[0], output: 'x'.repeat(100000) }); },
    value => { value.conversations = Array(101).fill(value.conversations[0]); },
    value => { Object.defineProperty(value.conversations[0], '__proto__', { value: {}, enumerable: true }); },
    value => { value.conversations[0].turns[0].constructor = {}; },
  ];
  const cases = ['{broken', original.replace('"schema":1', '"__proto__":{},"schema":1'), ' '.repeat(10 * 1024 * 1024 + 1)];
  for (const mutate of mutations) { const value = JSON.parse(original); mutate(value); cases.push(JSON.stringify(value)); }
  for (const content of cases) {
    fs.writeFileSync(options.filePath, content);
    assert.throws(() => createConversationStore(options), /拒绝覆盖/);
    assert.equal(fs.readFileSync(options.filePath, 'utf8'), content);
  }
});

test('保存失败保留内存，清理临时文件；删除失败同样不提交', t => {
  const { store, options, dir } = fixture(t), row = store.create('app', 1, 'live');
  const before = store.get('app', row.id);
  fs.unlinkSync(options.filePath); fs.mkdirSync(options.filePath);
  assert.throws(() => store.append('app', row.id, turn()), /保存失败/);
  assert.deepEqual(store.get('app', row.id), before);
  assert.throws(() => store.remove('app', row.id), /保存失败/);
  assert.deepEqual(store.get('app', row.id), before);
  assert.throws(() => store.create('app', 1, 'live'), /保存失败/);
  assert.equal(store.list('app', 1, 'live').length, 1);
  assert.deepEqual(fs.readdirSync(dir), ['conversations.json']);
});

test('序列化10MB上限拒绝提交，内存与磁盘保持一致', t => {
  const { store, options } = fixture(t);
  let failed = false;
  for (let i = 0; i < 12 && !failed; i++) {
    const row = store.create('app', 1, 'live');
    for (let j = 0; j < 2; j++) {
      const before = fs.readFileSync(options.filePath, 'utf8'), detail = store.get('app', row.id);
      try { store.append('app', row.id, turn('', '\u0000'.repeat(100000))); }
      catch (error) {
        assert.equal(error.status, 400); assert.match(error.message, /10 MB/);
        assert.deepEqual(store.get('app', row.id), detail);
        assert.equal(fs.readFileSync(options.filePath, 'utf8'), before);
        failed = true; break;
      }
    }
  }
  assert.equal(failed, true);
  assert.deepEqual(createConversationStore(options).list('app', 1, 'live'), store.list('app', 1, 'live'));
});

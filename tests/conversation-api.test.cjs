const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const E = require('../public/engine.js');
const B = require('../public/workflow-bundle.js');
const { createApp } = require('../server.cjs');
const { createPublishedStore } = require('../lib/published-store.cjs');
const { createConversationStore } = require('../lib/conversation-store.cjs');
const { createPublishedRunner } = require('../lib/published-runner.cjs');
const { chat } = require('../lib/model-client.cjs');
const model = { enabled: true, model: 'fake', baseUrl: 'https://model.example/v1', apiKey: '' };
const store = { get: () => model };
const response = output => new Response(JSON.stringify({ choices: [{ message: { content: output } }] }));
function chain(...types) {
  const nodes = ['start', ...types, 'end'].map(type => E.makeNode(type, 0, 0));
  for (const n of nodes) if (['agent', 'llm'].includes(n.type)) n.config.modelId = 'model';
  return { id: E.uid(), name: '多轮助手', nodes, edges: nodes.slice(1).map((n, i) => ({ id: E.uid(), from: nodes[i].id, to: n.id, branch: 'yes' })) };
}
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const conversationStoreOptions = { filePath: path.join(dir, 'conversations.json') };
  const conversations = createConversationStore(conversationStoreOptions);
  const published = createPublishedStore({ filePath: path.join(dir, 'published.json') });
  const server = http.createServer(createApp({ store, conversationStore: conversations, publishedStore: published, ...options }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(url, method = 'GET', body, headers = {}) {
    const r = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  }
  async function publish(flow, dependencies = []) {
    const r = await api('/api/published', 'POST', { bundle: B.exportBundle(flow, [flow, ...dependencies]) });
    assert.equal(r.status, 201); return '/api/published/' + r.body.app.id;
  }
  return { api, publish, conversations, conversationStoreOptions, base };
}

test('多轮模型消息顺序、旧调用兼容、服务器重载及会话隔离', async t => {
  const received = [];
  const { api, publish, conversationStoreOptions } = await fixture(t, { fetchImpl: async (_url, options) => {
    received.push(JSON.parse(options.body).messages); return response('回答' + received.length);
  } });
  const flow = chain('agent'), url = await publish(flow);
  const created = await api(url + '/conversations', 'POST', { version: 1 });
  assert.equal(created.status, 201); const id = created.body.conversation.id;
  const run = input => api(url + '/run', 'POST', { version: 1, input, conversationId: id });
  assert.equal((await run('我叫小林')).body.conversationSaved, true);
  const second = await run('我叫什么？');
  assert.equal(second.body.contextTurns, 1);
  assert.deepEqual(received[1], [{ role: 'system', content: flow.nodes[1].config.prompt }, { role: 'user', content: '我叫小林' }, { role: 'assistant', content: '回答1' }, { role: 'user', content: '我叫什么？' }]);
  assert.equal(createConversationStore(conversationStoreOptions).get(created.body.conversation.appId, id).turns.length, 2);
  const listing = await api(url + '/conversations?version=1&mode=live');
  assert.equal(listing.body.conversations[0].turnCount, 2); assert.equal(listing.body.conversations[0].turns, undefined);
  assert.equal((await api(url + '/conversations/' + id)).body.conversation.turns[1].output, '回答2');
  const independent = await api(url + '/run', 'POST', { input: '独立' });
  assert.equal(independent.body.conversationId, undefined); assert.equal(received[2].length, 2);
  const fresh = (await api(url + '/conversations', 'POST', { mode: 'live' })).body.conversation.id;
  await api(url + '/run', 'POST', { input: '新对话', conversationId: fresh }); assert.equal(received[3].length, 2);
  assert.equal((await api(url + '/conversations/' + id, 'DELETE')).status, 200);
  assert.equal((await api(url + '/conversations/' + id)).status, 404);
});

test('会话绑定应用、固定版本与模式，非法及跨站请求无副作用', async t => {
  let calls = 0;
  const { api, publish } = await fixture(t, { fetchImpl: async () => { calls++; return response('好'); } });
  const flow = chain('llm'), url = await publish(flow), other = await publish(chain('llm'));
  const id = (await api(url + '/conversations', 'POST', { version: 1 })).body.conversation.id;
  await publish(flow);
  assert.equal((await api(url + '/run', 'POST', { input: '', conversationId: id })).status, 409);
  assert.equal((await api(url + '/run', 'POST', { input: '', version: 1, mode: 'simulation', conversationId: id })).status, 409);
  assert.equal((await api(other + '/run', 'POST', { input: '', conversationId: id })).status, 404);
  assert.equal((await api(other + '/conversations/' + id, 'DELETE')).status, 404);
  for (const conversationId of ['', 1, null, {}, '../bad']) assert.equal((await api(url + '/run', 'POST', { input: '', conversationId })).status, 400);
  for (const body of [{ version: '1' }, { version: 0 }, { version: 1, mode: 'bad' }]) assert.equal((await api(url + '/conversations', 'POST', body)).status, 400);
  assert.equal((await api(url + '/conversations', 'POST', { version: 999 })).status, 404);
  for (const suffix of ['', '?version=1.5', '?version=1&mode=bad']) assert.equal((await api(url + '/conversations' + suffix)).status, 400);
  assert.equal((await api(url + '/conversations?version=1', 'GET', undefined, { Origin: 'https://evil.example' })).status, 403);
  await api(url, 'PUT', { enabled: false });
  assert.equal((await api(url + '/conversations', 'POST', {})).status, 409);
  assert.equal((await api(url + '/conversations/' + id)).status, 200);
  assert.equal(calls, 0);
});

test('失败不进入上下文，本地模拟与真实对话分开保存', async t => {
  let fail = true; const messages = [];
  const { api, publish } = await fixture(t, { fetchImpl: async (_url, options) => {
    messages.push(JSON.parse(options.body).messages);
    return fail ? new Response('', { status: 500 }) : response('成功回答');
  } });
  const url = await publish(chain('agent'));
  const id = (await api(url + '/conversations', 'POST', {})).body.conversation.id;
  const run = await api(url + '/run', 'POST', { input: '失败问题', conversationId: id });
  assert.equal(run.body.status, 'error'); assert.equal(run.body.conversationSaved, false);
  assert.equal((await api(url + '/conversations/' + id)).body.conversation.turns.length, 0);
  fail = false;
  await api(url + '/run', 'POST', { input: '新的问题', conversationId: id }); assert.equal(messages[1].length, 2);
  const sim = (await api(url + '/conversations', 'POST', { mode: 'simulation' })).body.conversation.id;
  const simulated = await api(url + '/run', 'POST', { input: '模拟', mode: 'simulation', conversationId: sim });
  assert.equal(simulated.body.conversationSaved, true); assert.equal(simulated.body.contextTurns, 0); assert.equal(messages.length, 2);
  assert.equal((await api(url + '/conversations?version=1&mode=live')).body.conversations.length, 1);
  assert.equal((await api(url + '/conversations?version=1&mode=simulation')).body.conversations.length, 1);
});

test('会话并发与删除保护，超时不写历史且释放锁', async t => {
  let started; const entered = new Promise(resolve => started = resolve); let slow = true;
  const { api, publish } = await fixture(t, { runTimeoutMs: 200, fetchImpl: async (_url, { signal }) => {
    if (!slow) return response('恢复'); started();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
  } });
  const url = await publish(chain('agent')), id = (await api(url + '/conversations', 'POST', {})).body.conversation.id;
  const pending = api(url + '/run', 'POST', { input: '慢请求', conversationId: id }); await entered;
  assert.equal((await api(url + '/run', 'POST', { input: '重复', conversationId: id })).status, 409);
  assert.equal((await api(url + '/conversations/' + id, 'DELETE')).status, 409);
  assert.equal((await pending).body.status, 'cancelled');
  assert.equal((await api(url + '/conversations/' + id)).body.conversation.turns.length, 0);
  slow = false; assert.equal((await api(url + '/run', 'POST', { input: '恢复', conversationId: id })).body.conversationSaved, true);
  assert.equal((await api(url + '/conversations/' + id, 'DELETE')).status, 200);
});

test('主流程收到对话，批处理子流程每项上下文保持独立', async t => {
  const messages = [];
  const { api, publish } = await fixture(t, { fetchImpl: async (_url, options) => { messages.push(JSON.parse(options.body).messages); return response('答复'); } });
  const flow = chain('agent', 'batch'), child = chain('agent');
  flow.nodes[2].config.workflowId = child.id; flow.nodes[2].config.inputTemplate = '[1,2]';
  const url = await publish(flow, [child]), id = (await api(url + '/conversations', 'POST', {})).body.conversation.id;
  for (const input of ['第一轮', '第二轮']) assert.equal((await api(url + '/run', 'POST', { input, conversationId: id })).body.status, 'success');
  assert.deepEqual(messages.map(m => m.length), [2, 2, 2, 4, 2, 2]);
});

test('会话保存失败返回已完成结果和明确提示，不伪装执行失败', async () => {
  const runner = createPublishedRunner({ getStore: () => store, getConversationStore: () => ({ get: () => ({ id: 'session', version: 1, mode: 'live' }), context: () => [], append() { throw Error('disk failure'); } }) });
  const flow = chain(), result = await runner.run('app', { version: 1, bundle: B.exportBundle(flow, [flow]) }, { input: '完成', conversationId: 'session' });
  assert.equal(result.status, 'success'); assert.equal(result.output, '完成'); assert.equal(result.conversationSaved, false); assert.match(result.warning, /保存失败/);
});

test('模型已返回但后续字段校验失败，整轮不写入会话', async t => {
  const { api, publish } = await fixture(t, { fetchImpl: async () => response('{"ok":false}') });
  const flow = chain('agent'); flow.nodes.at(-1).config.outputType = 'json'; flow.nodes.at(-1).config.outputSchema = '{"type":"object","properties":{"ok":{"const":true}}}';
  const url = await publish(flow), id = (await api(url + '/conversations', 'POST', {})).body.conversation.id;
  const result = await api(url + '/run', 'POST', { input: '不会完成的一轮', conversationId: id });
  assert.equal(result.body.status, 'error'); assert.equal(result.body.nodeId, flow.nodes.at(-1).id);
  assert.equal((await api(url + '/conversations/' + id)).body.conversation.turns.length, 0);
});

test('客户端断开取消会话运行，迟到的模型返回不追加对话', async () => {
  const records = []; let entered, release;
  const ready = new Promise(resolve => entered = resolve), held = new Promise(resolve => release = resolve);
  const runner = createPublishedRunner({ getStore: () => store,
    getConversationStore: () => ({ get: () => ({ id: 'session', version: 1, mode: 'live' }), context: () => [], append: (...args) => records.push(args) }),
    fetchImpl: async () => { entered(); await held; return response('迟到的回答'); },
  });
  const flow = chain('agent'), snapshot = { version: 1, bundle: B.exportBundle(flow, [flow]) }, controller = new AbortController();
  const pending = runner.run('app', snapshot, { input: '取消', conversationId: 'session' }, controller.signal);
  await ready; controller.abort();
  assert.equal((await pending).status, 'cancelled'); release();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(records.length, 0);
  assert.equal((await runner.run('app', snapshot, { input: '可继续', conversationId: 'session' })).status, 'success');
  assert.equal(records.length, 1);
});

test('模型历史严格角色、配对和总长度校验，保持系统提示在首位', async () => {
  let sent;
  const fetchImpl = async (_url, options) => { sent = JSON.parse(options.body); return response('输出'); };
  const options = { input: '当前', prompt: '系统', fetchImpl };
  for (const history of [null, {}, [{ role: 'user', content: '未配对' }], [{ role: 'system', content: '篡改' }, { role: 'assistant', content: '答' }], [{ role: 'user', content: 1 }, { role: 'assistant', content: '答' }]]) await assert.rejects(chat(model, { ...options, history }), /上下文/);
  await assert.rejects(chat(model, { ...options, history: [{ role: 'user', content: 'x'.repeat(200000) }, { role: 'assistant', content: '答' }] }), /总长度/);
  assert.equal(sent, undefined);
  await chat(model, { ...options, history: [{ role: 'user', content: '问' }, { role: 'assistant', content: '答', unexpected: 'discard' }] });
  assert.deepEqual(sent.messages, [{ role: 'system', content: '系统' }, { role: 'user', content: '问' }, { role: 'assistant', content: '答' }, { role: 'user', content: '当前' }]);
});

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
const { createPublishedRunner } = require('../lib/published-runner.cjs');
function chain(...types) {
  const nodes = ['start', ...types, 'end'].map(type => E.makeNode(type, 0, 0));
  return { id: E.uid(), name: '发布测试', nodes, edges: nodes.slice(1).map((n, i) => ({ id: E.uid(), from: nodes[i].id, to: n.id, branch: 'yes' })) };
}
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'published-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const publishedStore = createPublishedStore({ filePath: path.join(dir, 'published.json') });
  const server = http.createServer(createApp({ publishedStore, ...options }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(url, method = 'GET', body, headers = {}) {
    const response = await fetch(base + url, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  return { api, base, publishedStore };
}
const model = { id: 'm', name: '模型', model: 'fake', enabled: true, baseUrl: 'https://model.example/v1', apiKey: 'fake-key-private' };
const store = { get(id) { assert.equal(id, 'm'); return model; } };
function modelResponse(output) { return new Response(JSON.stringify({ choices: [{ message: { content: output } }] })); }

test('API发版/详情/选旧版运行/下架/恢复及输入跨站校验', async t => {
  const { api } = await fixture(t), flow = chain();
  flow.nodes[1].config.template = '第一版';
  const first = await api('/api/published', 'POST', { bundle: B.exportBundle(flow, [flow]) });
  assert.equal(first.status, 201); const id = first.body.app.id, url = '/api/published/' + id;
  flow.nodes[1].config.template = '第二版';
  await api('/api/published', 'POST', { bundle: B.exportBundle(flow, [flow]) });
  assert.equal((await api('/api/published')).body.apps.length, 1);
  assert.equal((await api(url)).body.app.latestVersion, 2);
  assert.equal((await api(url + '/versions/1')).body.version.name, flow.name);
  assert.equal((await api(url + '/versions/1.5')).status, 400);
  assert.equal((await api(url + '/versions/999')).status, 404);
  const run = await api(url + '/run', 'POST', { input: '', version: 1 });
  assert.equal(run.body.output, '第一版'); assert.equal(run.body.status, 'success');
  assert.equal(run.body.logs.length, 2); assert.ok(run.body.logs.every(l => Number.isFinite(l.elapsedMs)));
  const rerun = await api(url + '/run', 'POST', { input: '' });
  assert.equal(rerun.body.output, '第二版'); assert.notEqual(rerun.body.runId, run.body.runId);
  await api(url, 'PUT', { enabled: false });
  assert.equal((await api(url + '/run', 'POST', { input: 'x' })).status, 409);
  assert.equal((await api(url)).body.app.versions.length, 2);
  await api(url, 'PUT', { enabled: true });
  for (const body of [{ input: 1 }, { input: 'x'.repeat(10001) }, { input: '', mode: 'wrong' }, { input: '', version: '1' }]) assert.equal((await api(url + '/run', 'POST', body)).status, 400);
  assert.equal((await api(url, 'PUT', { enabled: 'false' })).status, 400);
  assert.equal((await api(url, 'GET', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await api(url + '/run', 'POST', { input: '' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});
test('模型/HTTP/知识/批处理融合与仿真无上游、来源逐项日志', async t => {
  let modelCalls = 0, httpCalls = 0, knowledgeCalls = 0;
  const knowledgeStore = { get: () => ({ chunkCount: 1 }), search: () => { knowledgeCalls++; return { knowledgeName: '文档库', hits: [{ documentId: 'd', documentName: '参考', chunkId: 'c', chunkIndex: 0, text: '知识内容', score: 1, secret: 'unexpected' }] }; } };
  const { api } = await fixture(t, { store, knowledgeStore, fetchImpl: async () => { modelCalls++; return modelResponse('模型结果'); }, httpFetchImpl: async () => { httpCalls++; return new Response('{"result":"工具结果"}', { headers: { 'Content-Type': 'application/json' } }); } });
  const flow = chain('batch'), child = chain('llm', 'http', 'knowledge');
  flow.nodes[1].config.workflowId = child.id;
  child.nodes[1].config.modelId = 'm'; child.nodes[2].config.url = 'https://tool.example/search';
  child.nodes[3].config.knowledgeId = 'kb';
  const result = await api('/api/published', 'POST', { bundle: B.exportBundle(flow, [flow, child]) });
  assert.equal(result.status, 201); assert.equal(modelCalls + httpCalls + knowledgeCalls, 0);
  const url = '/api/published/' + result.body.app.id + '/run';
  const run = await api(url, 'POST', { input: '["甲","乙"]' });
  assert.equal(run.body.status, 'success'); assert.deepEqual([modelCalls, httpCalls, knowledgeCalls], [2, 2, 2]);
  assert.equal(run.body.logs.filter(l => l.workflowId === child.id).length, 10);
  assert.deepEqual(run.body.logs.filter(l => l.type === 'knowledge').map(l => l.iterationPath), [[0], [1]]);
  assert.ok(run.body.logs.find(l => l.type === 'knowledge').sources[0].documentId);
  assert.ok(!JSON.stringify(run.body).includes('unexpected'));
  const sim = await api(url, 'POST', { input: '["甲"]', mode: 'simulation' });
  assert.equal(sim.body.status, 'success'); assert.deepEqual([modelCalls, httpCalls, knowledgeCalls], [2, 2, 3]);
});
test('配置预检无副作用、失效模型运行失败且停止下游、空知识库和HTTP凭据来源', async t => {
  let calls = 0, enabled = true;
  const { api } = await fixture(t, { store: { get: () => ({ ...model, enabled }) }, toolCredentialStore: { get: () => ({ origin: 'https://allowed.example' }) }, knowledgeStore: { get: () => ({ chunkCount: 0 }) }, fetchImpl: async () => { calls++; return new Response('', { status: 401 }); } });
  const flow = chain('llm', 'llm'); flow.nodes[1].config.modelId = flow.nodes[2].config.modelId = 'm';
  const result = await api('/api/published', 'POST', { bundle: B.exportBundle(flow, [flow]) });
  assert.equal(result.status, 201); assert.equal(calls, 0);
  const url = '/api/published/' + result.body.app.id + '/run';
  const failed = await api(url, 'POST', { input: '输入' });
  assert.equal(failed.status, 200); assert.equal(failed.body.status, 'error'); assert.equal(failed.body.nodeId, flow.nodes[1].id); assert.equal(calls, 1);
  enabled = false; assert.equal((await api(url, 'POST', { input: 'x' })).body.status, 'error'); assert.equal(calls, 1);
  assert.equal((await api('/api/published', 'POST', { bundle: B.exportBundle(flow, [flow]) })).status, 400);
  const kb = chain('knowledge'); kb.nodes[1].config.knowledgeId = 'kb';
  assert.equal((await api('/api/published', 'POST', { bundle: B.exportBundle(kb, [kb]) })).status, 400);
  const tool = chain('http'); tool.nodes[1].config.url = 'https://other.example'; tool.nodes[1].config.credentialId = 'cred';
  assert.equal((await api('/api/published', 'POST', { bundle: B.exportBundle(tool, [tool]) })).status, 400);
});
test('总超时/取消释放槽位、三并发上限、下游不执行', async t => {
  let calls = 0;
  const fetchImpl = async (_url, { signal }) => { calls++; return new Promise((_, reject) => { const abort = () => reject(Error('cancel')); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }); };
  const { api, base } = await fixture(t, { store, fetchImpl, runTimeoutMs: 150 });
  const flow = chain('llm', 'llm'); flow.nodes[1].config.modelId = flow.nodes[2].config.modelId = 'm';
  const published = await api('/api/published', 'POST', { bundle: B.exportBundle(flow, [flow]) });
  const url = '/api/published/' + published.body.app.id + '/run';
  const pending = [1, 2, 3].map(() => api(url, 'POST', { input: 'x' }));
  while (calls < 3) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await api(url, 'POST', { input: 'x' })).status, 429);
  const results = await Promise.all(pending); assert.ok(results.every(r => r.body.status === 'cancelled' && /超时/.test(r.body.error))); assert.equal(calls, 3);
  const controller = new AbortController();
  const cancelled = fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'x' }), signal: controller.signal });
  while (calls < 4) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(); await assert.rejects(cancelled);
  const next = await api(url, 'POST', { input: 'x' }); assert.equal(next.status, 200); assert.equal(calls, 5);
});
test('运行日志白名单、单条长度和总量受限', async () => {
  const flow = chain('batch'), child = chain('llm'); flow.nodes[1].config.workflowId = child.id; child.nodes[1].config.modelId = 'm'; child.nodes[1].config.template = 'x'.repeat(9000);
  const runner = createPublishedRunner({ getStore: () => store });
  const result = await runner.run('app', { version: 1, bundle: B.exportBundle(flow, [flow, child]) }, { input: JSON.stringify(Array(100).fill('x')), mode: 'simulation' });
  assert.ok(result.omittedLogs > 0); assert.ok(result.logs.length <= 500); assert.ok(Buffer.byteLength(JSON.stringify(result.logs)) < 270000);
  assert.ok(result.logs.every(l => !l.output || l.output.length <= 4000));
  assert.ok(!JSON.stringify(result.logs).includes('prompt'));
});

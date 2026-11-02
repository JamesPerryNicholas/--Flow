const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const E = require('../public/engine.js');
const B = require('../public/workflow-bundle.js');
const { createPublishedStore } = require('../lib/published-store.cjs');
const { createPublishedRunner } = require('../lib/published-runner.cjs');
const { createApp } = require('../server.cjs');
const link = (a, b, branch = 'yes') => ({ id: E.uid(), from: a.id, to: b.id, branch });
function chain(...types) {
  const nodes = ['start', ...types, 'end'].map(t => E.makeNode(t, 0, 0));
  return { id: E.uid(), name: '字段校验', nodes, edges: nodes.slice(1).map((n, i) => link(nodes[i], n)) };
}
function rules(node, schema) { node.config.outputType = 'json'; node.config.outputSchema = JSON.stringify(schema); }
const at = (node, pattern) => error => error.nodeId === node.id && pattern.test(error.message);

test('规则草稿保存与包往返不丢失，拒绝类型及超长配置，旧文本流程兼容', () => {
  const f = chain(), start = f.nodes[0];
  start.config.outputSchema = '{尚未写完';
  const restored = B.importBundle(JSON.parse(JSON.stringify(B.exportBundle(f, [f])))).workflow;
  assert.equal(restored.nodes[0].config.outputSchema, start.config.outputSchema);
  assert.equal(E.executionPlan(restored, '原输入').output, '原输入');
  restored.nodes[0].config.outputType = 'json';
  assert.throws(() => E.executionPlan(restored, '{}'), /JSON 字段规则/);
  for (const raw of [null, {}, 5, ' '.repeat(50001)]) {
    start.config.outputSchema = raw;
    assert.throws(() => E.validateFlow(f), /字段规则/);
    assert.throws(() => E.checkExecution(f), at(start, /字段规则/));
  }
});

test('开始字段错误阻止下游调用，规则不插值、不转换、保留原始JSON文本', async () => {
  const f = chain('llm'), start = f.nodes[0];
  rules(start, { type: 'object', properties: { count: { type: 'integer', minimum: 1 }, note: { const: '{{input}}' } }, required: ['count', 'note'], additionalProperties: false });
  let calls = 0;
  const options = { invokeModel: async (n, input) => { calls++; return input; } };
  await assert.rejects(E.runFlow(f, '{"count":"2","note":"{{input}}"}', options), at(start, /count/));
  assert.equal(calls, 0);
  const text = ' { "count": 2, "note": "{{input}}" } ';
  assert.equal((await E.runFlow(f, text, options)).output, text);
  assert.equal(calls, 1);
});

test('两个条件分支的规则在执行前检查，错误定位到规则所属节点', async () => {
  const f = chain('condition'), condition = f.nodes[1], yes = f.nodes[2], no = E.makeNode('end', 0, 0);
  f.nodes.push(no); f.edges.push(link(condition, no, 'no'));
  rules(no, { type: 'string', format: 'email' });
  let started = 0;
  await assert.rejects(E.runFlow(f, '创作', { onNodeStart() { started++; } }), at(no, /format/));
  assert.equal(started, 0);
  no.config.outputSchema = 'true';
  assert.equal((await E.runFlow(f, '创作')).logs.at(-1).id, yes.id);
});

test('模型实际输出不合规则时中断，失败节点不产生成功日志', async () => {
  const f = chain('llm', 'llm'), model = f.nodes[1];
  rules(model, { type: 'object', properties: { items: { type: 'array', items: { type: 'object', required: ['title'] } } }, required: ['items'] });
  let calls = 0; const logs = [], starts = [];
  await assert.rejects(E.runFlow(f, '', {
    invokeModel: async () => { calls++; return '{"items":[{}]}'; },
    onNode: log => logs.push(log), onNodeStart: n => starts.push(n.id),
  }), at(model, /items\/0.*title/));
  assert.equal(calls, 1); assert.deepEqual(logs.map(l => l.id), [f.nodes[0].id]);
  assert.deepEqual(starts, [f.nodes[0].id, model.id]);
});

test('HTTP提取后的数据与结束模板实际结果接受相同字段校验', async () => {
  const f = chain('http'), tool = f.nodes[1], end = f.nodes[2];
  tool.config.url = 'https://example.test/data'; tool.config.responsePath = '/data';
  tool.config.template = '{"data":{"count":0}}';
  rules(tool, { type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 1 } } });
  assert.throws(() => E.executionPlan(f, ''), at(tool, /count/));
  await assert.rejects(E.runFlow(f, '', { invokeHttp: async () => ({ output: '{"data":{"count":0}}' }) }), at(tool, /count/));
  tool.config.template = '{"data":{"count":2}}';
  rules(end, { type: 'array' });
  assert.throws(() => E.executionPlan(f, ''), at(end, /JSON 字段校验失败/));
  end.config.outputSchema = '{"type":"object"}';
  assert.equal(E.executionPlan(f, '').output, '{"count":2}');
});

test('批处理汇总校验与子流程预检、运行错误保留归因', async () => {
  const root = chain('batch'), child = chain(), batch = root.nodes[1], start = child.nodes[0];
  batch.config.workflowId = child.id;
  child.nodes[1].config.template = '{{start.input#/item}}'; batch.config.resultType = 'json';
  rules(batch, { type: 'array', minItems: 2, items: { type: 'integer' } });
  const options = { workflows: [child] };
  assert.equal(E.executionPlan(root, '[1,2]', options).output, '[1,2]');
  assert.throws(() => E.executionPlan(root, '[1]', options), at(batch, /JSON 字段校验失败/));
  assert.throws(() => E.executionPlan(root, '[1,false]', options), at(batch, /\/1/));
  rules(start, { type: 'object', properties: { item: { type: 'integer' } } });
  await assert.rejects(E.runFlow(root, '[1,"x"]', options), error => /item/.test(error.message) && (error.detailNodeId === start.id || error.nodeId === start.id));
  start.config.outputSchema = '{'; let started = 0;
  await assert.rejects(E.runFlow(root, '[]', { ...options, onNodeStart() { started++; } }), /JSON 字段规则/);
  assert.equal(started, 0);
});

test('发布规则随版本固定并持久化，独立运行器拒绝不合输入且拒绝发布坏规则', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-schema-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { filePath: path.join(dir, 'published.json') }, store = createPublishedStore(options), f = chain();
  const runner = createPublishedRunner();
  rules(f.nodes[0], { type: 'object', required: ['title'] });
  const first = store.publish(B.exportBundle(f, [f]), '', runner.preflight);
  const id = first.app.id;
  f.nodes[0].config.outputSchema = '{"type":"array"}';
  store.publish(B.exportBundle(f, [f]), '', runner.preflight);
  const reloaded = createPublishedStore(options);
  const old = await runner.run(id, reloaded.snapshot(id, 1), { input: '{}', mode: 'simulation' });
  assert.equal(old.status, 'error'); assert.equal(old.nodeId, f.nodes[0].id); assert.match(old.error, /title/);
  assert.equal((await runner.run(id, reloaded.snapshot(id, 1), { input: '{"title":"标题"}', mode: 'simulation' })).status, 'success');
  assert.equal((await runner.run(id, reloaded.snapshot(id, 2), { input: '[]', mode: 'simulation' })).status, 'success');
  f.nodes[0].config.outputSchema = '{"type":"object","$ref":"https://example.test/schema"}';
  assert.throws(() => store.publish(B.exportBundle(f, [f]), '', runner.preflight), /\$ref/);
  assert.equal(store.get(id).latestVersion, 2);
});

test('浏览器加载顺序与Node模块执行保持一致', () => {
  const context = vm.createContext({});
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.indexOf('src="/json-schema.js"') < html.indexOf('src="/engine.js"'));
  for (const file of ['json-schema.js', 'engine.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), context);
  const f = chain(); rules(f.nodes[0], { type: 'object', required: ['title'] });
  context.flow = JSON.parse(JSON.stringify(f));
  assert.throws(() => vm.runInContext('FlowEngine.executionPlan(flow, "{}")', context), /title/);
});

test('HTTP发布与运行API使用字段规则，静态脚本可加载', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-schema-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const publishedStore = createPublishedStore({ filePath: path.join(dir, 'published.json') });
  const server = http.createServer(createApp({ publishedStore }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = async (url, data) => {
    const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  const asset = await fetch(base + '/json-schema.js');
  assert.equal(asset.status, 200); assert.match(asset.headers.get('content-type'), /javascript/);
  assert.match(await asset.text(), /FlowSchema/);
  const f = chain(); rules(f.nodes[0], { type: 'object', required: ['title'] });
  const published = await api('/api/published', { bundle: B.exportBundle(f, [f]) });
  assert.equal(published.status, 201);
  const url = '/api/published/' + published.body.app.id + '/run';
  const invalid = await api(url, { input: '{}', mode: 'simulation' });
  assert.equal(invalid.status, 200); assert.equal(invalid.body.status, 'error');
  assert.equal(invalid.body.nodeId, f.nodes[0].id); assert.match(invalid.body.error, /\/title/);
  assert.equal(invalid.body.logs.some(log => log.status === 'success'), false);
  const valid = await api(url, { input: '{"title":"主题"}', mode: 'simulation' });
  assert.equal(valid.status, 200); assert.equal(valid.body.status, 'success');
  f.nodes[0].config.outputSchema = '{"items":[]}';
  assert.equal((await api('/api/published', { bundle: B.exportBundle(f, [f]) })).status, 400);
});

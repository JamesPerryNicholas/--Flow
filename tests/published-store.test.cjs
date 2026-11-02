const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const E = require('../public/engine.js');
const B = require('../public/workflow-bundle.js');
const { createPublishedStore } = require('../lib/published-store.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'published-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { filePath: path.join(dir, 'published.json') };
  const flow = E.sample(); flow.nodes.splice(1, 1); flow.edges = [{ id: 'e', from: flow.nodes[0].id, to: flow.nodes[1].id, branch: 'yes' }];
  return { dir, options, flow, store: createPublishedStore(options) };
}
test('版本固定、引用隔离、重新启动持久化、详情不泄漏bundle、下架再发布启用', t => {
  const { store, flow, options } = fixture(t);
  flow.nodes[1].config.template = 'v1';
  const first = store.publish(B.exportBundle(flow, [flow]), '说明');
  flow.nodes[1].config.template = 'v2';
  const second = store.publish(B.exportBundle(flow, [flow]));
  assert.equal(second.app.id, first.app.id); assert.equal(second.version.version, 2);
  const snapshot = store.snapshot(first.app.id, 1); snapshot.bundle.workflow.name = '污染';
  assert.equal(store.snapshot(first.app.id, 1).bundle.workflow.nodes[1].config.template, 'v1');
  const restart = createPublishedStore(options);
  assert.deepEqual(restart.get(first.app.id).versions.map(v => v.version), [2, 1]);
  assert.equal(restart.version(first.app.id, 1).description, '说明');
  assert.ok(!JSON.stringify(restart.get(first.app.id)).includes('bundle'));
  restart.setEnabled(first.app.id, false);
  assert.throws(() => restart.snapshot(first.app.id), e => e.status === 409);
  assert.equal(restart.publish(B.exportBundle(flow, [flow])).app.enabled, true);
  assert.throws(() => restart.publish(B.exportBundle(flow, [flow]), 'x'.repeat(501)), /500/);
});
test('清洗字段、依赖固定及不重映射ID', t => {
  const { store, flow } = fixture(t), child = structuredClone(flow); child.id = 'child'; child.name = '子流程';
  const batch = E.makeNode('batch', 0, 0); batch.config.workflowId = child.id;
  flow.nodes.splice(1, 0, batch); flow.edges = flow.nodes.slice(1).map((n, i) => ({ id: String(i), from: flow.nodes[i].id, to: n.id, branch: 'yes' }));
  flow.secret = 'TOP_SECRET'; batch.config.apiKey = 'TOP_SECRET'; batch.config.model = 'TOP_SECRET';
  const bundle = B.exportBundle(flow, [flow, child]); bundle.secret = 'TOP_SECRET';
  const result = store.publish(bundle), snapshot = store.snapshot(result.app.id);
  assert.equal(snapshot.bundle.workflow.id, flow.id);
  assert.equal(snapshot.bundle.dependencies[0].id, child.id);
  assert.ok(!JSON.stringify(snapshot).includes('TOP_SECRET'));
  child.nodes[1].config.template = 'changed';
  assert.notEqual(snapshot.bundle.dependencies[0].nodes[1].config.template, 'changed');
  assert.throws(() => store.publish({ ...bundle, dependencies: [...bundle.dependencies, { ...child, id: 'extra' }] }), /无关/);
});
test('损坏文件拒绝覆盖，写失败不改变内存', t => {
  const { options, flow, store, dir } = fixture(t);
  fs.writeFileSync(options.filePath, '{broken');
  assert.throws(() => createPublishedStore(options), /拒绝覆盖/);
  assert.equal(fs.readFileSync(options.filePath, 'utf8'), '{broken');
  fs.unlinkSync(options.filePath); fs.mkdirSync(options.filePath);
  assert.throws(() => store.publish(B.exportBundle(flow, [flow])), /保存失败/);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(fs.readdirSync(dir), ['published.json']);
});
test('每应用20版本和50应用上限不删除旧版本', t => {
  const { store, flow } = fixture(t); let app;
  for (let i = 0; i < 20; i++) app = store.publish(B.exportBundle(flow, [flow])).app;
  assert.throws(() => store.publish(B.exportBundle(flow, [flow])), /20/);
  assert.equal(store.version(app.id, 1).version, 1);
  for (let i = 1; i < 50; i++) { flow.id = 'app-' + i; store.publish(B.exportBundle(flow, [flow])); }
  flow.id = 'excess'; assert.throws(() => store.publish(B.exportBundle(flow, [flow])), /50/);
});
test('10MB总文件上限拒绝且不改变持久化内容', t => {
  const { store, flow, options } = fixture(t);
  const app = store.publish(B.exportBundle(flow, [flow])).app;
  const before = fs.readFileSync(options.filePath, 'utf8');
  for (let i = 0; i < 220; i++) { const node = E.makeNode('llm', 0, 0); node.config.template = 'x'.repeat(50000); flow.nodes.push(node); }
  assert.throws(() => store.publish(B.exportBundle(flow, [flow])), /10 MB/);
  assert.equal(store.get(app.id).latestVersion, 1);
  assert.equal(fs.readFileSync(options.filePath, 'utf8'), before);
});

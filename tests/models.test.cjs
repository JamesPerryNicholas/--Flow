const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../server.cjs');
const { createModelStore, dpapiCodec, validateBaseUrl } = require('../lib/model-store.cjs');

function codec() {
  const key = crypto.randomBytes(32);
  return {
    encrypt(value) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); const out = Buffer.concat([c.update(value), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]); },
    decrypt(value) { const c = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); c.setAuthTag(value.subarray(12, 28)); return Buffer.concat([c.update(value.subarray(28)), c.final()]); },
  };
}
function tempStore(t, chosenCodec = codec()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingjing-models-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { filePath: path.join(dir, 'models.enc'), codec: chosenCodec };
  return { store: createModelStore(options), options };
}
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function api(base, url, method = 'GET', body, headers = {}) {
  const response = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
const config = { name: '测试配置', baseUrl: 'https://example.com/v1', model: 'custom-model', apiKey: 'fake-secret-for-tests' };

test('模型CRUD不回传Key、空白保留、改源重填、停用和删除', async t => {
  const { store } = tempStore(t), base = await listen(t, createApp({ store }));
  assert.deepEqual((await api(base, '/api/models')).body, { models: [] });
  const created = await api(base, '/api/models', 'POST', config);
  assert.equal(created.status, 201); assert.equal(created.body.model.hasKey, true);
  const id = created.body.model.id;
  assert.ok(!JSON.stringify(created).includes(config.apiKey)); assert.ok(!('apiKey' in created.body.model));
  assert.equal((await api(base, `/api/models/${id}`, 'PUT', { ...config, apiKey: '  ', name: '改名' })).status, 200);
  assert.equal(store.get(id).apiKey, config.apiKey);
  const changedOrigin = { ...config, baseUrl: 'https://other.example/v1', apiKey: '' };
  assert.equal((await api(base, `/api/models/${id}`, 'PUT', changedOrigin)).status, 400);
  assert.equal((await api(base, `/api/models/${id}`, 'PUT', { ...changedOrigin, apiKey: 'new-fake', enabled: false })).status, 200);
  assert.equal((await api(base, '/api/chat', 'POST', { modelId: id, prompt: '', input: '' })).status, 400);
  const listing = await api(base, '/api/models'); assert.equal(listing.body.models.length, 1); assert.ok(!JSON.stringify(listing).includes('new-fake'));
  assert.deepEqual((await api(base, `/api/models/${id}`, 'DELETE')).body, { ok: true });
  assert.equal((await api(base, `/api/models/${id}`, 'DELETE')).status, 404);
  assert.deepEqual(store.list(), []);
});

test('加密持久化可重载，磁盘无明文Key，损坏配置拒绝加载', t => {
  const { store, options } = tempStore(t); const model = store.save(config);
  assert.ok(!fs.readFileSync(options.filePath).includes(Buffer.from(config.apiKey)));
  assert.equal(createModelStore(options).get(model.id).apiKey, config.apiKey);
  fs.writeFileSync(options.filePath, 'corrupt'); assert.throws(() => createModelStore(options), /读取失败/);
});

test('Windows真实DPAPI加密与解密', { skip: process.platform !== 'win32' }, t => {
  const { store, options } = tempStore(t, dpapiCodec()); const saved = store.save(config);
  assert.ok(!fs.readFileSync(options.filePath).includes(Buffer.from(config.apiKey)));
  assert.equal(createModelStore({ filePath: options.filePath }).get(saved.id).apiKey, config.apiKey);
});

test('fake上游验证真实chat结构、完整端点、无Key本地模型与连接测试', async t => {
  const received = [];
  const upstream = await listen(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ path: req.url, auth: req.headers.authorization, contentType: req.headers['content-type'], body: JSON.parse(Buffer.concat(chunks)) });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '测试输出' } }] }));
  });
  const { store } = tempStore(t), base = await listen(t, createApp({ store }));
  const saved = store.save({ ...config, baseUrl: `${upstream}/v1` });
  const result = await api(base, '/api/chat', 'POST', { modelId: saved.id, prompt: '系统提示', input: '用户输入' });
  assert.deepEqual(result, { status: 200, body: { output: '测试输出', model: 'custom-model' } });
  assert.deepEqual(received[0], { path: '/v1/chat/completions', auth: `Bearer ${config.apiKey}`, contentType: 'application/json', body: { model: 'custom-model', messages: [{ role: 'system', content: '系统提示' }, { role: 'user', content: '用户输入' }], stream: false } });
  const local = store.save({ ...config, baseUrl: `${upstream}/v1/chat/completions/`, apiKey: '' });
  const tested = await api(base, `/api/models/${local.id}/test`, 'POST', {});
  assert.equal(tested.status, 200); assert.equal(tested.body.ok, true); assert.equal(typeof tested.body.elapsedMs, 'number');
  assert.equal(received[1].path, '/v1/chat/completions'); assert.equal(received[1].auth, undefined);
});

test('上游认证、限流、服务器和格式错误经过脱敏，拒绝重定向', async t => {
  let mode = '401', redirected = 0;
  const target = await listen(t, (req, res) => { redirected++; res.end('unexpected'); });
  const upstream = await listen(t, (req, res) => {
    if (mode === 'redirect') { res.writeHead(302, { Location: target }).end(); return; }
    if (mode === 'json') { res.end('not json'); return; }
    if (mode === 'shape') { res.end('{}'); return; }
    if (mode === 'echo') { res.end(JSON.stringify({ choices: [{ message: { content: `echo ${config.apiKey}` } }] })); return; }
    res.writeHead(Number(mode)).end(config.apiKey);
  });
  const { store } = tempStore(t), model = store.save({ ...config, baseUrl: upstream });
  const base = await listen(t, createApp({ store }));
  for (mode of ['401', '403', '429', '500', 'json', 'shape', 'redirect']) {
    const result = await api(base, '/api/chat', 'POST', { modelId: model.id, prompt: '', input: '' });
    assert.equal(result.status, 502, mode); assert.ok(result.body.error); assert.ok(!JSON.stringify(result).includes(config.apiKey));
  }
  assert.equal(redirected, 0);
  mode = 'echo';
  const echoed = await api(base, '/api/chat', 'POST', { modelId: model.id, prompt: '', input: '' });
  assert.equal(echoed.status, 200); assert.ok(!JSON.stringify(echoed).includes(config.apiKey));
});

test('上游超时返回504，客户端取消会中止上游连接', async t => {
  let resolveStarted, resolveClosed;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  let requests = 0;
  const upstream = await listen(t, (req, res) => { requests++; if (requests === 2) { res.once('close', resolveClosed); resolveStarted(); } });
  const { store } = tempStore(t), model = store.save({ ...config, baseUrl: upstream });
  const shortBase = await listen(t, createApp({ store, timeoutMs: 40 }));
  assert.equal((await api(shortBase, '/api/chat', 'POST', { modelId: model.id, prompt: '', input: '' })).status, 504);
  const base = await listen(t, createApp({ store, timeoutMs: 5000 }));
  const controller = new AbortController();
  const pending = fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId: model.id, prompt: '', input: '' }), signal: controller.signal }).catch(e => e);
  await started; controller.abort(); await pending;
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('upstream not cancelled')), 1500); timer.unref(); })]);
});

test('地址、JSON、字段、请求大小、Host与跨站访问校验', async t => {
  for (const value of ['http://example.com/v1', 'ftp://localhost/v1', 'https://user:secret@example.com', 'https://example.com?q=1', 'https://example.com/#x']) assert.throws(() => validateBaseUrl(value));
  assert.equal(validateBaseUrl('http://localhost:1234/v1/'), 'http://localhost:1234/v1');
  const { store } = tempStore(t), base = await listen(t, createApp({ store }));
  for (const headers of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'null' }]) assert.equal((await api(base, '/api/models', 'GET', undefined, headers)).status, 403);
  // Node fetch normalizes Host, so use the raw HTTP client to exercise rebinding checks.
  for (const host of ['evil.example', 'localhost:1']) {
    const status = await new Promise((resolve, reject) => {
      http.get(base + '/api/models', { headers: { Host: host } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403);
  }
  assert.equal((await api(base, '/api/models', 'GET', undefined, { Origin: base, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.equal((await fetch(base + '/api/models', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(base + '/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  for (const body of [[], null, {}, { ...config, enabled: 'yes' }, { ...config, apiKey: 'bad\nkey' }]) assert.equal((await api(base, '/api/models', 'POST', body)).status, 400);
  const huge = await api(base, '/api/models', 'POST', { ...config, name: 'x'.repeat(530000) }); assert.equal(huge.status, 413);
  assert.equal((await api(base, '/api/chat', 'POST', { modelId: 'missing', prompt: '', input: '' })).status, 404);
});

test('静态首页、脚本、HEAD及安全路径保持有效', async t => {
  const { store } = tempStore(t), base = await listen(t, createApp({ store }));
  const page = await fetch(base + '/'); assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/); assert.match(await page.text(), /<html/);
  assert.equal((await fetch(base + '/engine.js')).status, 200);
  assert.equal((await fetch(base + '/', { method: 'HEAD' })).status, 200);
  for (const url of ['/server.cjs', '/.local/models.enc', '/%2e%2e%5cserver.cjs', '/%00', '/%zz']) assert.ok([400, 403, 404].includes((await fetch(base + url)).status), url);
});

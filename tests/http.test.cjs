const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../server.cjs');
const { createToolCredentialStore, validateHeaderName } = require('../lib/tool-credentials.cjs');
const { dpapiCodec } = require('../lib/model-store.cjs');
const { requestHttp, validateToolUrl, forbiddenAddress, safeLookup } = require('../lib/http-client.cjs');
const secret = 'Bearer fake-tool-secret';

function tempStore(t, selectedCodec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const codec = {
    encrypt(value) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(value), c.final(), c.getAuthTag()]); },
    decrypt(value) { const c = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); c.setAuthTag(value.subarray(-16)); return Buffer.concat([c.update(value.subarray(12, -16)), c.final()]); },
  };
  const options = { filePath: path.join(dir, 'tool-credentials.enc'), codec: selectedCodec || codec };
  return { store: createToolCredentialStore(options), options };
}
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function api(base, route, method = 'GET', body, headers = {}) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}

test('工具认证CRUD加密、公开脱敏、空值保留、来源和头变更重填', async t => {
  const { store, options } = tempStore(t), base = await listen(t, createApp({ toolCredentialStore: store }));
  const config = { name: '本机工具', origin: 'http://localhost:1234', secret };
  assert.deepEqual((await api(base, '/api/tool-credentials')).body, { credentials: [] });
  const created = await api(base, '/api/tool-credentials', 'POST', config);
  assert.equal(created.status, 201);
  const row = created.body.credential, route = `/api/tool-credentials/${row.id}`;
  assert.deepEqual(row, { id: row.id, name: config.name, origin: config.origin, headerName: 'Authorization', hasSecret: true });
  assert.ok(!fs.readFileSync(options.filePath).includes(Buffer.from(secret)));
  assert.equal(createToolCredentialStore(options).get(row.id).secret, secret);
  assert.equal((await api(base, route, 'PUT', { ...config, secret: '', name: '新名' })).status, 200);
  assert.equal(store.get(row.id).secret, secret);
  for (const change of [{ origin: 'https://example.com' }, { headerName: 'X-Api-Key' }]) {
    assert.equal((await api(base, route, 'PUT', { ...config, ...change, secret: '' })).status, 400);
  }
  assert.equal((await api(base, route, 'PUT', { ...config, headerName: 'X-Api-Key', secret: 'new-secret' })).status, 200);
  const listing = await api(base, '/api/tool-credentials');
  assert.ok(!JSON.stringify(listing).includes('new-secret'));
  assert.equal((await api(base, route, 'DELETE')).status, 200);
  assert.equal((await api(base, route, 'DELETE')).status, 404);
  assert.deepEqual(store.list(), []);
  fs.writeFileSync(options.filePath, 'broken');
  assert.throws(() => createToolCredentialStore(options), /读取失败/);
  assert.equal(fs.readFileSync(options.filePath, 'utf8'), 'broken');
});

test('认证输入与存储失败保持原记录，协议控制请求头被拒绝', t => {
  const { store, options } = tempStore(t);
  for (const header of ['Host', 'Cookie', 'Content-Length', 'Content-Type', 'Connection', 'Transfer-Encoding', 'Proxy-Authorization', 'Sec-Fetch-Site', 'x\r\nevil']) assert.throws(() => validateHeaderName(header));
  assert.equal(validateHeaderName('X-Api-Key'), 'X-Api-Key');
  const config = { name: '工具', origin: 'https://example.com', secret };
  for (const bad of [{ secret: '' }, { secret: 'bad\r\nvalue' }, { secret: '中' }, { origin: 'https://example.com/path' }, { origin: 'https://example.com/?x=1' }]) assert.throws(() => store.save({ ...config, ...bad }));
  const row = store.save(config);
  options.codec.encrypt = () => { throw new Error(secret); };
  assert.throws(() => store.save({ ...config, name: 'changed' }, row.id), /保存失败/);
  assert.equal(store.get(row.id).name, config.name);
});

test('工具凭据真实Windows DPAPI持久化往返', { skip: process.platform !== 'win32' }, t => {
  const { store, options } = tempStore(t, dpapiCodec());
  const row = store.save({ name: 'DPAPI工具', origin: 'https://example.com', secret });
  assert.ok(!fs.readFileSync(options.filePath).includes(Buffer.from(secret)));
  assert.equal(createToolCredentialStore({ filePath: options.filePath }).get(row.id).secret, secret);
});

test('认证公开字段白名单及加载数量、长度、结构限制', t => {
  const { store, options } = tempStore(t);
  const row = store.save({ name: '工具', origin: 'https://example.com', secret });
  const internal = { ...store.get(row.id), unexpectedSecret: 'do-not-expose' };
  const write = data => fs.writeFileSync(options.filePath, options.codec.encrypt(Buffer.from(JSON.stringify(data))));
  write([internal]);
  assert.deepEqual(createToolCredentialStore(options).list(), [row]);
  for (const invalid of [Array.from({ length: 101 }, (_, i) => ({ ...internal, id: `id-${i}` })), [{ ...internal, name: 'x'.repeat(201) }], [{ ...internal, secret: 'x'.repeat(8193) }], [{ ...internal, id: 'x'.repeat(101) }], [internal, internal], [{}]]) {
    write(invalid); assert.throws(() => createToolCredentialStore(options), /读取失败/);
  }
  fs.writeFileSync(options.filePath, Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.throws(() => createToolCredentialStore(options), /读取失败/);
});

test('DNS连接解析阻止元数据、链路本地和localhost重绑定，保留正常解析', async () => {
  const resolve = (hostname, addresses, all = false) => new Promise((success, failure) => safeLookup(hostname, { all }, (error, result) => error ? failure(error) : success(result), (name, options, callback) => {
    assert.equal(name, hostname); assert.equal(options.all, true); callback(null, addresses);
  }));
  for (const address of ['169.254.169.254', 'fe80::1', '::ffff:a9fe:a9fe', 'fd00:ec2::254', '168.63.129.16']) await assert.rejects(resolve('tool.example', [{ address, family: address.includes(':') ? 6 : 4 }]));
  await assert.rejects(resolve('localhost', [{ address: '192.0.2.1', family: 4 }]));
  await assert.rejects(resolve('tool.example', [{ address: '192.0.2.1', family: 4 }, { address: '169.254.169.254', family: 4 }]));
  assert.equal(await resolve('tool.example', [{ address: '192.0.2.1', family: 4 }]), '192.0.2.1');
  assert.deepEqual(await resolve('localhost', [{ address: '127.0.0.1', family: 4 }], true), [{ address: '127.0.0.1', family: 4 }]);
});

test('工具执行真实JSON文本、查询、完整认证头、GET与DELETE不带正文', async t => {
  const received = [];
  const upstream = await listen(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString(), auth: req.headers.authorization, contentType: req.headers['content-type'] });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ message: '工具响应' }));
  });
  const { store } = tempStore(t), row = store.save({ name: '工具', origin: upstream, secret });
  const base = await listen(t, createApp({ toolCredentialStore: store }));
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const result = await api(base, '/api/http', 'POST', { url: upstream + '/run?q=1', method, body: '{"input":1}', credentialId: row.id });
    assert.deepEqual(result, { status: 200, body: { output: '{"message":"工具响应"}', status: 200, contentType: 'application/json' } });
    const actual = received.at(-1);
    assert.equal(actual.method, method); assert.equal(actual.url, '/run?q=1'); assert.equal(actual.auth, secret);
    assert.equal(actual.body, ['GET', 'DELETE'].includes(method) ? '' : '{"input":1}');
    assert.equal(actual.contentType, ['GET', 'DELETE'].includes(method) ? undefined : 'application/json');
  }
  const plain = await listen(t, (req, res) => { assert.equal(req.headers.authorization, undefined); res.end('纯文本'); });
  assert.equal((await api(base, '/api/http', 'POST', { url: plain })).body.output, '纯文本');
});

test('工具URL、来源、方法、JSON与超时字段在连接之前校验', async t => {
  for (const url of ['http://example.com', 'ftp://localhost', 'https://a:b@example.com', 'https://example.com/#part', 'https://example.com/#', 'https://169.254.169.254', 'https://[fe80::1]', 'https://[::ffff:169.254.169.254]', 'https://metadata.google.internal']) assert.throws(() => validateToolUrl(url), url);
  for (const url of ['http://localhost:8000', 'http://127.0.0.1:8000', 'http://[::1]:8000', 'https://example.com/path?q=1']) assert.ok(validateToolUrl(url));
  for (const address of ['169.254.1.2', '0.0.0.0', '100.100.100.200', 'fe80::a', '::ffff:a9fe:a9fe', 'fd00:ec2::254']) assert.equal(forbiddenAddress(address), true);
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('ok'); };
  for (const bad of [{ method: 'HEAD' }, { method: 'get' }, { method: 1 }, { method: 'POST', body: '{}' + secret }, { method: 'POST', body: {} }, { timeoutMs: 999 }, { timeoutMs: 60001 }, { timeoutMs: '1000' }]) await assert.rejects(requestHttp({ url: 'https://example.com', ...bad }, { fetchImpl }), e => e.status === 400);
  await assert.rejects(requestHttp({ url: 'https://other.example' }, { credential: { origin: 'https://example.com', secret, headerName: 'Authorization' }, fetchImpl }), /来源不一致/);
  assert.equal(calls, 0);
  const { store } = tempStore(t), base = await listen(t, createApp({ toolCredentialStore: store, httpFetchImpl: fetchImpl }));
  assert.equal((await api(base, '/api/http', 'POST', { url: 'https://example.com', credentialId: 'missing' })).status, 404);
  assert.equal((await api(base, '/api/http', 'POST', { url: 'https://example.com', credentialId: {} })).status, 400);
  for (const headers of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await api(base, '/api/http', 'POST', { url: 'https://example.com' }, headers)).status, 403);
    assert.equal((await api(base, '/api/tool-credentials', 'GET', undefined, headers)).status, 403);
  }
  assert.equal(calls, 0);
});

test('响应超限、非2xx、重定向及上游错误不泄露认证，成功回显也脱敏', async t => {
  let mode = 'echo', redirected = 0;
  const target = await listen(t, (req, res) => { redirected++; res.end('unexpected'); });
  const upstream = await listen(t, (req, res) => {
    if (mode === 'redirect') return res.writeHead(302, { Location: target }).end();
    if (mode === 'large') return res.end('x'.repeat(1024 * 1024 + 1));
    if (mode === 'long') return res.end('x'.repeat(100001));
    if (mode === 'echo') { res.setHeader('Content-Type', secret); return res.end('echo ' + secret + ' token-only: ' + secret.slice(7)); }
    res.writeHead(Number(mode)).end(secret);
  });
  const { store } = tempStore(t), row = store.save({ name: '工具', origin: upstream, secret });
  const base = await listen(t, createApp({ toolCredentialStore: store }));
  for (mode of ['echo', '401', '403', '429', '500', 'redirect', 'large', 'long']) {
    const result = await api(base, '/api/http', 'POST', { url: upstream, credentialId: row.id });
    assert.equal(result.status, mode === 'echo' ? 200 : 502, mode);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(result).includes(secret.slice(7)));
  }
  assert.equal(redirected, 0);
  await assert.rejects(requestHttp({ url: upstream }, { fetchImpl: async () => { throw new Error(secret); } }), e => !e.message.includes(secret) && e.status === 502);
  const basic = 'dXNlcjpwYXNz';
  const basicResponse = await requestHttp({ url: upstream }, { credential: { origin: upstream, headerName: 'Authorization', secret: 'Basic ' + basic }, fetchImpl: async () => new Response(basic) });
  assert.ok(!basicResponse.output.includes(basic));
});

test('工具超时及客户端断开取消上游，不自动重试', async t => {
  let calls = 0, startedResolve, closedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const closed = new Promise(resolve => { closedResolve = resolve; });
  const upstream = await listen(t, (req, res) => { calls++; if (calls === 2) { res.once('close', closedResolve); startedResolve(); } });
  const base = await listen(t, createApp());
  assert.equal((await api(base, '/api/http', 'POST', { url: upstream, timeoutMs: 1000 })).status, 504);
  const controller = new AbortController();
  const pending = fetch(base + '/api/http', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: upstream }), signal: controller.signal }).catch(error => error);
  await started; controller.abort(); await pending;
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('not cancelled')), 2000); timer.unref(); })]);
  assert.equal(calls, 2);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(requestHttp({ url: upstream }, { signal: alreadyAborted.signal }), e => e.status === 499);
});

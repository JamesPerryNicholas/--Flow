const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileKeyCodec } = require('../lib/file-key-codec.cjs');
const { createModelStore } = require('../lib/model-store.cjs');
const { createToolCredentialStore } = require('../lib/tool-credentials.cjs');
const unix = { skip: process.platform === 'win32' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingjing-codec-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, keyPath: path.join(dir, 'secrets.key') };
}
const config = { name: '测试', model: 'fake', baseUrl: 'https://fake.example/v1', apiKey: 'fake-private-api-key' };

test('Unix默认模型和工具凭据AES-GCM持久化，重启重载且磁盘无明文密钥', unix, t => {
  const { dir } = fixture(t), modelOptions = { filePath: path.join(dir, 'models.enc') }, credentialOptions = { filePath: path.join(dir, 'tool-credentials.enc') };
  const models = createModelStore(modelOptions), saved = models.save(config);
  const credentials = createToolCredentialStore(credentialOptions), credential = credentials.save({ name: '工具', origin: 'https://tool.example', secret: 'Bearer fake-tool-secret' });
  assert.equal(createModelStore(modelOptions).get(saved.id).apiKey, config.apiKey);
  assert.equal(createToolCredentialStore(credentialOptions).get(credential.id).secret, 'Bearer fake-tool-secret');
  assert.equal(fs.statSync(path.join(dir, 'secrets.key')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(modelOptions.filePath).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(modelOptions.filePath).includes(Buffer.from(config.apiKey)));
  assert.ok(!fs.readFileSync(credentialOptions.filePath).includes(Buffer.from('fake-tool-secret')));
});

test('每次加密使用不同随机nonce，篡改头部、密文或认证标签拒绝解密', unix, t => {
  const { keyPath } = fixture(t), codec = fileKeyCodec({ keyPath }), text = Buffer.from('private value');
  const a = codec.encrypt(text), b = codec.encrypt(text);
  assert.notDeepEqual(a, b); assert.deepEqual(codec.decrypt(a), text);
  for (const offset of [0, 4, 17, a.length - 1]) { const bad = Buffer.from(a); bad[offset] ^= 1; assert.throws(() => codec.decrypt(bad)); }
  assert.throws(() => codec.decrypt(Buffer.from('short')));
});

test('丢失密钥或跨机器密钥不能读取已有配置，拒绝生成新密钥或覆盖密文', unix, t => {
  const { dir, keyPath } = fixture(t), options = { filePath: path.join(dir, 'models.enc') };
  const models = createModelStore(options); models.save(config); const before = fs.readFileSync(options.filePath);
  fs.unlinkSync(keyPath);
  assert.throws(() => createModelStore(options), /密钥丢失/); assert.ok(!fs.existsSync(keyPath));
  assert.throws(() => createToolCredentialStore({ filePath: path.join(dir, 'tool-credentials.enc') }), /密钥丢失/); assert.ok(!fs.existsSync(keyPath));
  assert.deepEqual(fs.readFileSync(options.filePath), before);
  fileKeyCodec({ keyPath });
  assert.throws(() => createModelStore(options), /读取失败/); assert.deepEqual(fs.readFileSync(options.filePath), before);
});

test('拒绝宽松权限、符号链接、硬链接和异常长度密钥，不自动更改已有文件', unix, t => {
  const { dir, keyPath } = fixture(t); fileKeyCodec({ keyPath });
  fs.chmodSync(keyPath, 0o644); assert.throws(() => fileKeyCodec({ keyPath }), /0600/); assert.equal(fs.statSync(keyPath).mode & 0o777, 0o644);
  fs.chmodSync(keyPath, 0o600);
  const link = path.join(dir, 'link'); fs.symlinkSync(keyPath, link); assert.throws(() => fileKeyCodec({ keyPath: link })); fs.unlinkSync(link);
  fs.linkSync(keyPath, link); assert.throws(() => fileKeyCodec({ keyPath }), /独立普通文件/); fs.unlinkSync(link);
  fs.writeFileSync(keyPath, Buffer.alloc(31)); assert.throws(() => fileKeyCodec({ keyPath }), /32 字节/);
  fs.chmodSync(dir, 0o755); assert.throws(() => fileKeyCodec({ keyPath }), /0700/);
});

test('密钥目录不能通过符号链接替换，创建后无临时密钥文件残留', unix, t => {
  const { dir } = fixture(t), privateDir = path.join(dir, 'private'), linkedDir = path.join(dir, 'linked');
  fs.mkdirSync(privateDir, { mode: 0o700 }); fs.symlinkSync(privateDir, linkedDir);
  assert.throws(() => fileKeyCodec({ keyPath: path.join(linkedDir, 'secrets.key') }), /符号链接/);
  fileKeyCodec({ keyPath: path.join(privateDir, 'secrets.key') });
  assert.deepEqual(fs.readdirSync(privateDir), ['secrets.key']);
});

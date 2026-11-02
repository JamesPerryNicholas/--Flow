const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { fileKeyCodec } = require('./file-key-codec.cjs');

class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function dpapiCodec() {
  if (process.platform !== 'win32') throw new Error('默认密钥存储需要 Windows DPAPI；其他平台请注入安全存储。');
  function transform(value, decrypt) {
    const script = `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[System.Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: Buffer.from(value).toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0 || !result.stdout.trim()) throw new AppError(500, '无法访问本机加密模型配置。');
    return Buffer.from(result.stdout.trim(), 'base64');
  }
  return { encrypt: value => transform(value, false), decrypt: value => transform(value, true) };
}

function validateBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new AppError(400, '请输入有效的模型 API 地址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new AppError(400, 'API 地址需使用 HTTPS（本机允许 HTTP），且不能包含凭据、查询或片段。');
  }
  return url.href.replace(/\/$/, '');
}

function defaultCodec(filePath) {
  if (process.platform === 'win32') return dpapiCodec();
  const dir = path.dirname(filePath);
  const existing = [filePath, path.join(dir, 'models.enc'), path.join(dir, 'tool-credentials.enc')].some(file => fs.existsSync(file));
  try { return fileKeyCodec({ keyPath: path.join(dir, 'secrets.key'), allowCreate: !existing }); }
  catch (error) { throw new AppError(500, `无法访问本机加密存储：${error.message}`); }
}

function textField(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(400, `${label}不能为空或超过 ${max} 个字符。`);
  return value.trim();
}

function publicModel({ apiKey, ...model }) { return { ...model, hasKey: Boolean(apiKey) }; }

function createModelStore({ filePath = path.join(__dirname, '..', '.local', 'models.enc'), codec } = {}) {
  codec ||= defaultCodec(filePath);
  let models = [];
  if (fs.existsSync(filePath)) {
    try { models = JSON.parse(codec.decrypt(fs.readFileSync(filePath)).toString('utf8')); if (!Array.isArray(models)) throw new Error(); }
    catch { throw new AppError(500, '模型配置读取失败，请检查本机账户和配置文件。'); }
  }
  function commit(next) {
    const encrypted = codec.encrypt(Buffer.from(JSON.stringify(next)));
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, encrypted, { mode: 0o600 }); fs.renameSync(temp, filePath); }
    catch { try { fs.unlinkSync(temp); } catch {} throw new AppError(500, '模型配置保存失败。'); }
    models = next;
  }
  function get(id) { const model = models.find(item => item.id === id); if (!model) throw new AppError(404, '模型配置不存在。'); return model; }
  return {
    list: () => models.map(publicModel),
    get,
    save(body, id) {
      const old = id ? get(id) : null;
      const name = textField(body.name, '显示名称');
      const baseUrl = validateBaseUrl(textField(body.baseUrl, 'API 地址', 2000));
      const model = textField(body.model, '模型标识');
      if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 8192 || /[\r\n]/.test(body.apiKey))) throw new AppError(400, 'API Key 格式无效。');
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new AppError(400, '启用状态必须为布尔值。');
      const suppliedKey = body.apiKey?.trim();
      if (old?.apiKey && new URL(old.baseUrl).origin !== new URL(baseUrl).origin && !suppliedKey) throw new AppError(400, '修改 API 地址域名或端口时，请重新输入 API Key。');
      const next = { id: old?.id || randomUUID(), name, baseUrl, model, apiKey: suppliedKey || old?.apiKey || '', enabled: body.enabled ?? old?.enabled ?? true };
      commit(old ? models.map(item => item.id === id ? next : item) : [...models, next]);
      return publicModel(next);
    },
    remove(id) { get(id); commit(models.filter(item => item.id !== id)); },
  };
}

module.exports = { AppError, createModelStore, dpapiCodec, defaultCodec, validateBaseUrl };

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const { AppError } = require('./model-store.cjs');

function forbiddenAddress(address) {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return a === 0 || a === 169 && b === 254 || a >= 224 || value === '100.100.100.200' || value === '168.63.129.16';
  }
  if (net.isIP(value) === 6) {
    // Mapped IPv4 and transition formats can bypass IPv4 filtering; tools use native addresses.
    return value === '::' || /^f[ef][89ab]/.test(value) || value.startsWith('ff') || value.startsWith('::ffff:') || value.startsWith('64:ff9b:') || value.startsWith('2002:') || value === 'fd00:ec2::254';
  }
  return false;
}

function validateToolUrl(value) {
  let url;
  try { if (typeof value !== 'string' || value.length > 8192) throw new Error(); url = new URL(value); } catch { throw new AppError(400, '请输入有效的 HTTP 工具地址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.hash || value.includes('#') || forbiddenAddress(url.hostname)) {
    throw new AppError(400, '工具地址需使用 HTTPS（本机允许 HTTP），不能包含认证、片段或链路本地地址。');
  }
  if (['metadata.google.internal', 'metadata.goog'].includes(url.hostname)) throw new AppError(400, '不允许访问元数据地址。');
  return url;
}

// Resolve and validate within the actual connection lookup, avoiding a second DNS lookup (rebinding).
function safeLookup(hostname, options, callback, lookup = dns.lookup) {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => forbiddenAddress(address) || hostname === 'localhost' && !['127.0.0.1', '::1'].includes(address))) return callback(new Error('Blocked address'));
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function nativeFetch(url, options) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method: options.method, headers: options.headers, signal: options.signal, lookup: safeLookup, agent: false }, response => {
      resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, headers: { get: key => response.headers[key.toLowerCase()] || '' }, body: response });
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

async function requestHttp(body, { credential, signal, fetchImpl = nativeFetch } = {}) {
  const url = validateToolUrl(body.url);
  const method = body.method === undefined ? 'GET' : body.method;
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new AppError(400, '不支持的 HTTP 请求方法。');
  const timeoutMs = body.timeoutMs === undefined ? 30000 : body.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new AppError(400, '超时须为 1000 至 60000 毫秒的整数。');
  if (credential && url.origin !== credential.origin) throw new AppError(400, '工具地址与认证配置允许的来源不一致。');
  const headers = Object.create(null); let payload;
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    if (body.body !== undefined && body.body !== '') {
      if (typeof body.body !== 'string') throw new AppError(400, '请求正文必须为 JSON 文本。');
      try { JSON.parse(body.body); } catch { throw new AppError(400, '请求正文不是有效的 JSON。'); }
      payload = body.body;
    }
    headers['Content-Type'] = 'application/json';
  }
  if (credential?.secret) headers[credential.headerName] = credential.secret;
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  const sensitive = credential?.secret ? [credential.secret] : [];
  if (credential?.headerName.toLowerCase() === 'authorization') {
    const match = /^(?:Bearer|Basic)\s+(.+)$/i.exec(credential.secret);
    if (match) sensitive.push(match[1]);
  }
  const redact = value => sensitive.reduce((text, item) => text.replaceAll(item, '[已隐藏认证信息]'), value);
  try {
    const response = await fetchImpl(url, { method, headers, body: payload, redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      if (response.body?.cancel) await response.body.cancel(); else response.body?.destroy();
      throw new AppError(502, response.status >= 300 && response.status < 400 ? '工具服务重定向已被拒绝。' : `工具服务返回错误（HTTP ${response.status}）。`);
    }
    const chunks = []; let size = 0;
    if (response.body) for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024) { abort(); throw new AppError(502, '工具响应超过 1 MB。'); }
      chunks.push(Buffer.from(chunk));
    }
    const output = redact(Buffer.concat(chunks).toString('utf8'));
    if (output.length > 100000) throw new AppError(502, '工具输出超过 100000 个字符。');
    return { output, status: response.status, contentType: redact(String(response.headers.get('content-type') || '')) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (timedOut) throw new AppError(504, '工具请求超时，请稍后重试。');
    if (signal?.aborted) throw new AppError(499, '请求已取消。');
    throw new AppError(502, '无法连接工具服务，请检查地址和网络。');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

module.exports = { requestHttp, validateToolUrl, forbiddenAddress, safeLookup };

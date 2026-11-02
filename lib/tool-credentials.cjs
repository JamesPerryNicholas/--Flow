const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AppError, defaultCodec } = require('./model-store.cjs');
const { validateToolUrl } = require('./http-client.cjs');

function validateHeaderName(value = 'Authorization') {
  if (typeof value !== 'string' || value.length > 100 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value) || /^(host|cookie|set-cookie|content-.*|accept-encoding|connection|keep-alive|transfer-encoding|te|trailer|upgrade|expect|proxy-.*|sec-.*|origin|referer)$/i.test(value)) throw new AppError(400, '认证请求头名称无效或属于受限请求头。');
  return value;
}
function validateOrigin(value) {
  const url = validateToolUrl(value);
  if (url.pathname !== '/' || url.search) throw new AppError(400, '认证来源只能包含协议、域名和端口。');
  return url.origin;
}
function publicRow({ id, name, origin, headerName, secret }) { return { id, name, origin, headerName, hasSecret: Boolean(secret) }; }

function createToolCredentialStore({ filePath = path.join(__dirname, '..', '.local', 'tool-credentials.enc'), codec } = {}) {
  codec ||= defaultCodec(filePath);
  let rows = [];
  if (fs.existsSync(filePath)) {
    try {
      if (fs.statSync(filePath).size > 2 * 1024 * 1024) throw new Error();
      rows = JSON.parse(codec.decrypt(fs.readFileSync(filePath)).toString('utf8'));
      if (!Array.isArray(rows) || rows.length > 100 || rows.some(row => !row || typeof row.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(row.id) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 || typeof row.secret !== 'string' || !row.secret.trim() || /[^\t\x20-\x7e\x80-\xff]/.test(row.secret) || row.secret.length > 8192 || validateHeaderName(row.headerName) !== row.headerName || validateOrigin(row.origin) !== row.origin) || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error();
    } catch { throw new AppError(500, '工具认证配置读取失败，请检查本机账户和配置文件。'); }
  }
  function get(id) { const row = rows.find(item => item.id === id); if (!row) throw new AppError(404, '工具认证配置不存在。'); return { ...row }; }
  function commit(next) {
    const temp = `${filePath}.${randomUUID()}.tmp`;
    try {
      const encrypted = codec.encrypt(Buffer.from(JSON.stringify(next)));
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, encrypted, { mode: 0o600 }); fs.renameSync(temp, filePath);
    } catch { try { fs.unlinkSync(temp); } catch {} throw new AppError(500, '工具认证配置保存失败。'); }
    rows = next;
  }
  return {
    list: () => rows.map(publicRow), get,
    save(body, id) {
      const old = id ? get(id) : null;
      if (!old && rows.length >= 100) throw new AppError(400, '最多保存 100 项工具认证配置。');
      if (!body || typeof body !== 'object' || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200) throw new AppError(400, '认证名称不能为空或超过 200 个字符。');
      const headerName = validateHeaderName(body.headerName ?? old?.headerName);
      const origin = validateOrigin(body.origin);
      if (body.secret !== undefined && (typeof body.secret !== 'string' || body.secret.length > 8192 || /[^\t\x20-\x7e\x80-\xff]/.test(body.secret))) throw new AppError(400, '认证值格式无效。');
      const supplied = body.secret?.trim();
      if (old && (old.origin !== origin || old.headerName.toLowerCase() !== headerName.toLowerCase()) && !supplied) throw new AppError(400, '修改认证来源或请求头时，请重新输入认证值。');
      const secret = supplied || old?.secret;
      if (!secret) throw new AppError(400, '请输入认证值。');
      const row = { id: old?.id || randomUUID(), name: body.name.trim(), origin, headerName, secret };
      commit(old ? rows.map(item => item.id === id ? row : item) : [...rows, row]);
      return publicRow(row);
    },
    remove(id) { get(id); commit(rows.filter(row => row.id !== id)); },
  };
}

module.exports = { createToolCredentialStore, validateHeaderName, validateOrigin };

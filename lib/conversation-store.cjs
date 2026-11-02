const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AppError } = require('./model-store.cjs');

const MAX_BYTES = 10 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value);
const validVersion = value => Number.isSafeInteger(value) && value > 0;
const validMode = value => value === 'live' || value === 'simulation';
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const size = turns => turns.reduce((total, turn) => total + turn.input.length + turn.output.length, 0);
function summary({ turns, ...metadata }) { return { ...metadata, turnCount: turns.length }; }

function createConversationStore({ filePath = path.join(__dirname, '..', '.local', 'conversations.json') } = {}) {
  let conversations = [];
  if (fs.existsSync(filePath)) {
    try {
      if (fs.statSync(filePath).size > MAX_BYTES) throw Error();
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!fields(data, ['schema', 'conversations']) || data.schema !== 1 || !Array.isArray(data.conversations) || data.conversations.length > 100) throw Error();
      const ids = new Set();
      for (const row of data.conversations) {
        if (!fields(row, ['id', 'appId', 'version', 'mode', 'createdAt', 'updatedAt', 'turns', 'omittedTurns']) || !validId(row.id) || ids.has(row.id) || !validId(row.appId) || !validVersion(row.version) || !validMode(row.mode) || !validDate(row.createdAt) || !validDate(row.updatedAt) || row.updatedAt < row.createdAt || !Number.isSafeInteger(row.omittedTurns) || row.omittedTurns < 0 || !Array.isArray(row.turns) || row.turns.length > 20) throw Error();
        ids.add(row.id);
        let previous = row.createdAt;
        for (const turn of row.turns) {
          if (!fields(turn, ['input', 'output', 'runId', 'createdAt', 'outputTruncated']) || typeof turn.input !== 'string' || turn.input.length > 10000 || typeof turn.output !== 'string' || turn.output.length > 100000 || !validId(turn.runId) || !validDate(turn.createdAt) || turn.createdAt < previous || turn.createdAt > row.updatedAt || typeof turn.outputTruncated !== 'boolean' || (turn.outputTruncated && turn.output.length !== 100000)) throw Error();
          previous = turn.createdAt;
        }
        if (size(row.turns) > 250000) throw Error();
      }
      conversations = data.conversations;
    } catch { throw new AppError(500, '会话文件读取失败，已拒绝覆盖，请检查本机文件。'); }
  }
  function commit(next) {
    const bytes = JSON.stringify({ schema: 1, conversations: next });
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new AppError(400, '会话文件最多 10 MB，请删除部分会话。');
    const temp = `${filePath}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, filePath);
    } catch { try { fs.unlinkSync(temp); } catch {} throw new AppError(500, '会话文件保存失败。'); }
    conversations = next;
  }
  function validateBinding(appId, version, mode) {
    if (!validId(appId) || !validVersion(version) || !validMode(mode)) throw new AppError(400, '会话应用、版本或运行模式无效。');
  }
  function find(appId, id) {
    if (!validId(appId) || !validId(id)) throw new AppError(400, '会话 ID 无效。');
    const row = conversations.find(item => item.appId === appId && item.id === id);
    if (!row) throw new AppError(404, '会话不存在。');
    return row;
  }
  return {
    create(appId, version, mode) {
      validateBinding(appId, version, mode);
      if (conversations.length >= 100) throw new AppError(400, '最多保留 100 个会话，请先删除部分会话。');
      const now = new Date().toISOString();
      const row = { id: randomUUID(), appId, version, mode, createdAt: now, updatedAt: now, turns: [], omittedTurns: 0 };
      commit([...conversations, row]);
      return clone(row);
    },
    list(appId, version, mode) {
      validateBinding(appId, version, mode);
      return clone(conversations.filter(row => row.appId === appId && row.version === version && row.mode === mode).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary));
    },
    get(appId, id) { return clone(find(appId, id)); },
    remove(appId, id) {
      find(appId, id);
      commit(conversations.filter(row => row.id !== id));
    },
    append(appId, id, value) {
      const old = find(appId, id);
      if (!value || typeof value.input !== 'string' || value.input.length > 10000 || typeof value.output !== 'string' || !validId(value.runId)) throw new AppError(400, '会话输入最多 10000 个字符，输出和运行 ID 必须有效。');
      const now = new Date(Math.max(Date.now(), Date.parse(old.updatedAt))).toISOString();
      const turns = [...old.turns, { input: value.input, output: value.output.slice(0, 100000), runId: value.runId, createdAt: now, outputTruncated: value.output.length > 100000 }];
      let omittedTurns = old.omittedTurns;
      while (turns.length > 20 || size(turns) > 250000) { turns.shift(); omittedTurns++; }
      const row = { ...old, updatedAt: now, turns, omittedTurns };
      commit(conversations.map(item => item.id === id ? row : item));
      return clone(row);
    },
    context(appId, id) {
      const turns = find(appId, id).turns, selected = [];
      let total = 0;
      for (let i = turns.length - 1; i >= 0 && selected.length < 10; i--) {
        const turn = turns[i], length = turn.input.length + turn.output.length;
        if (turn.outputTruncated || total + length > 60000) break;
        selected.unshift(turn); total += length;
      }
      return selected.flatMap(turn => [{ role: 'user', content: turn.input }, { role: 'assistant', content: turn.output }]);
    },
  };
}
module.exports = { createConversationStore };

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { AppError, createModelStore } = require('./lib/model-store.cjs');
const { chat } = require('./lib/model-client.cjs');
const { createToolCredentialStore } = require('./lib/tool-credentials.cjs');
const { requestHttp } = require('./lib/http-client.cjs');
const { createKnowledgeStore } = require('./lib/knowledge-store.cjs');
const { createPublishedStore } = require('./lib/published-store.cjs');
const { createPublishedRunner } = require('./lib/published-runner.cjs');
const { createConversationStore } = require('./lib/conversation-store.cjs');
const { createAgentRuntime, runAgent } = require('./lib/agent-runner.cjs');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, status, data) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new AppError(415, '请使用 JSON 请求。');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 512 * 1024) throw new AppError(413, '请求内容过大。');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new AppError(400, 'JSON 请求格式无效。'); }
}

function checkRequest(req) {
  const host = req.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host) || Number(host.split(':').pop()) !== req.socket.localPort) throw new AppError(403, '不允许的访问地址。');
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new AppError(403, '不允许跨站访问。');
  if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new AppError(403, '不允许跨站访问。');
}

function createApp({ store, storeOptions, toolCredentialStore, toolCredentialStoreOptions, knowledgeStore, knowledgeStoreOptions, publishedStore, publishedStoreOptions, conversationStore, conversationStoreOptions, runTimeoutMs, httpFetchImpl, publicRoot = path.join(__dirname, 'public'), timeoutMs, fetchImpl } = {}) {
  // Keep static pages available even when local encrypted storage is unavailable.
  const getStore = () => store ||= createModelStore(storeOptions);
  const getToolStore = () => toolCredentialStore ||= createToolCredentialStore(toolCredentialStoreOptions);
  const getKnowledgeStore = () => knowledgeStore ||= createKnowledgeStore(knowledgeStoreOptions);
  const getPublishedStore = () => publishedStore ||= createPublishedStore(publishedStoreOptions);
  const getConversationStore = () => conversationStore ||= createConversationStore(conversationStoreOptions);
  const agentRuntime = createAgentRuntime({ getToolStore, getKnowledgeStore, httpFetchImpl });
  let activeAgents = 0;
  const runner = createPublishedRunner({ getStore, getToolStore, getKnowledgeStore, getConversationStore, fetchImpl, httpFetchImpl, timeoutMs, runTimeoutMs });
  const root = path.resolve(publicRoot);
  return async (req, res) => {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    try {
      checkRequest(req);
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { throw new AppError(400, '请求地址无效。'); }
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/published' && req.method === 'GET') return json(res, 200, { apps: getPublishedStore().list() });
        if (pathname === '/api/published' && req.method === 'POST') {
          const body = await readJson(req);
          return json(res, 201, getPublishedStore().publish(body.bundle, body.description, runner.preflight));
        }
        const conversationMatch = /^\/api\/published\/([a-zA-Z0-9-]+)\/conversations(?:\/([a-zA-Z0-9-]{1,100}))?$/.exec(pathname);
        if (conversationMatch) {
          const [, appId, id] = conversationMatch;
          const published = getPublishedStore(); published.get(appId);
          if (id && req.method === 'GET') return json(res, 200, { conversation: getConversationStore().get(appId, id) });
          if (id && req.method === 'DELETE') { runner.removeConversation(appId, id); return json(res, 200, { ok: true }); }
          if (!id && req.method === 'POST') {
            const body = await readJson(req), mode = body.mode ?? 'live';
            if (body.version !== undefined && (!Number.isSafeInteger(body.version) || body.version < 1)) throw new AppError(400, '版本号必须为正整数。');
            const snapshot = published.snapshot(appId, body.version);
            return json(res, 201, { conversation: getConversationStore().create(appId, snapshot.version, mode) });
          }
          if (!id && req.method === 'GET') {
            const params = new URL(req.url, 'http://localhost').searchParams, raw = params.get('version');
            if (!/^[1-9]\d*$/.test(raw || '') || !Number.isSafeInteger(Number(raw))) throw new AppError(400, '版本号必须为正整数。');
            published.version(appId, Number(raw));
            return json(res, 200, { conversations: getConversationStore().list(appId, Number(raw), params.get('mode') ?? 'live') });
          }
        }
        const publishedMatch = /^\/api\/published\/([a-zA-Z0-9-]+)(?:\/(run|versions)(?:\/([^/]+))?)?$/.exec(pathname);
        if (publishedMatch) {
          const [, id, section, versionText] = publishedMatch, published = getPublishedStore();
          if (!section && req.method === 'GET') return json(res, 200, { app: published.get(id) });
          if (!section && req.method === 'PUT') return json(res, 200, { app: published.setEnabled(id, (await readJson(req)).enabled) });
          if (section === 'versions' && req.method === 'GET') {
            const version = Number(versionText);
            if (!/^[1-9]\d*$/.test(versionText || '') || !Number.isSafeInteger(version)) throw new AppError(400, '版本号必须为正整数。');
            return json(res, 200, { version: published.version(id, version) });
          }
          if (section === 'run' && !versionText && req.method === 'POST') {
            const body = await readJson(req);
            if (body.version !== undefined && (!Number.isSafeInteger(body.version) || body.version < 1)) throw new AppError(400, '版本号必须为正整数。');
            const snapshot = published.snapshot(id, body.version);
            return json(res, 200, await runner.run(id, snapshot, body, controller.signal));
          }
        }
        if (pathname === '/api/knowledge' && req.method === 'GET') return json(res, 200, { libraries: getKnowledgeStore().list() });
        if (pathname === '/api/knowledge' && req.method === 'POST') return json(res, 201, { library: getKnowledgeStore().save(await readJson(req)) });
        const knowledgeMatch = /^\/api\/knowledge\/([a-zA-Z0-9-]+)(?:\/(search|documents)(?:\/([a-zA-Z0-9-]+))?)?$/.exec(pathname);
        if (knowledgeMatch) {
          const [, id, section, docId] = knowledgeMatch, knowledge = getKnowledgeStore();
          if (!section && req.method === 'GET') return json(res, 200, { library: knowledge.get(id) });
          if (!section && req.method === 'PUT') return json(res, 200, { library: knowledge.save(await readJson(req), id) });
          if (!section && req.method === 'DELETE') { knowledge.remove(id); return json(res, 200, { ok: true }); }
          if (section === 'search' && !docId && req.method === 'POST') return json(res, 200, knowledge.search(id, await readJson(req)));
          if (section === 'documents' && !docId && req.method === 'POST') return json(res, 201, { document: knowledge.saveDocument(id, await readJson(req)) });
          if (section === 'documents' && docId && req.method === 'GET') return json(res, 200, { document: knowledge.getDocument(id, docId) });
          if (section === 'documents' && docId && req.method === 'PUT') return json(res, 200, { document: knowledge.saveDocument(id, await readJson(req), docId) });
          if (section === 'documents' && docId && req.method === 'DELETE') { knowledge.removeDocument(id, docId); return json(res, 200, { ok: true }); }
        }
        if (pathname === '/api/tool-credentials' && req.method === 'GET') return json(res, 200, { credentials: getToolStore().list() });
        if (pathname === '/api/tool-credentials' && req.method === 'POST') return json(res, 201, { credential: getToolStore().save(await readJson(req)) });
        const credentialMatch = /^\/api\/tool-credentials\/([a-zA-Z0-9-]+)$/.exec(pathname);
        if (credentialMatch && req.method === 'PUT') return json(res, 200, { credential: getToolStore().save(await readJson(req), credentialMatch[1]) });
        if (credentialMatch && req.method === 'DELETE') { getToolStore().remove(credentialMatch[1]); return json(res, 200, { ok: true }); }
        if (pathname === '/api/http' && req.method === 'POST') {
          const body = await readJson(req);
          if (body.credentialId !== undefined && typeof body.credentialId !== 'string') throw new AppError(400, '认证配置标识无效。');
          const credential = body.credentialId ? getToolStore().get(body.credentialId) : undefined;
          return json(res, 200, await requestHttp(body, { credential, signal: controller.signal, fetchImpl: httpFetchImpl }));
        }
        if (pathname === '/api/models' && req.method === 'GET') return json(res, 200, { models: getStore().list() });
        if (pathname === '/api/models' && req.method === 'POST') return json(res, 201, { model: getStore().save(await readJson(req)) });
        const match = /^\/api\/models\/([a-zA-Z0-9-]+)(\/test)?$/.exec(pathname);
        if (match) {
          const [, id, testing] = match;
          if (testing && req.method === 'POST') {
            await readJson(req);
            const start = Date.now();
            await chat(getStore().get(id), { prompt: 'Reply briefly.', input: 'Reply OK.', signal: controller.signal, timeoutMs, fetchImpl });
            return json(res, 200, { ok: true, message: '模型连接成功。', elapsedMs: Date.now() - start });
          }
          if (!testing && req.method === 'PUT') return json(res, 200, { model: getStore().save(await readJson(req), id) });
          if (!testing && req.method === 'DELETE') { getStore().remove(id); return json(res, 200, { ok: true }); }
        }
        if (pathname === '/api/agent' && req.method === 'POST') {
          const body = await readJson(req);
          if (activeAgents >= 3) throw new AppError(429, '同时最多运行 3 个智能体请求。');
          activeAgents++;
          try {
            return json(res, 200, await runAgent(getStore().get(body.modelId), { prompt: body.prompt, input: body.input, tools: body.tools, maxToolRounds: body.maxToolRounds, signal: controller.signal, timeoutMs, fetchImpl, runtime: agentRuntime }));
          } finally { activeAgents--; }
        }
        if (pathname === '/api/chat' && req.method === 'POST') {
          const body = await readJson(req);
          const model = getStore().get(body.modelId);
          const output = await chat(model, { prompt: body.prompt, input: body.input, signal: controller.signal, timeoutMs, fetchImpl });
          return json(res, 200, { output, model: model.model });
        }
        throw new AppError(404, '接口不存在。');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new AppError(405, '不支持的请求方法。');
      let file = path.resolve(root, '.' + pathname);
      if (file === root) file = path.join(root, 'index.html');
      if (!file.startsWith(root + path.sep)) throw new AppError(403, '不允许访问此路径。');
      // Symlinks must not expose files outside the public directory.
      try { file = await fs.promises.realpath(file); } catch { throw new AppError(404, '文件不存在。'); }
      if (!file.startsWith(root + path.sep)) throw new AppError(403, '不允许访问此路径。');
      let data;
      try { data = await fs.promises.readFile(file); } catch { throw new AppError(404, '文件不存在。'); }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) { json(res, error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : '服务器处理失败，请稍后重试。', ...(error instanceof AppError && error.agentSteps ? { agentSteps: error.agentSteps } : {}) }); }
    finally { req.removeListener('aborted', abort); res.removeListener('close', abort); }
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 4173);
  http.createServer(createApp()).listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
}
module.exports = { createApp };

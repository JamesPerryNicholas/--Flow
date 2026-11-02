const { randomUUID } = require('node:crypto');
const E = require('../public/engine.js');
const { AppError } = require('./model-store.cjs');
const { chat } = require('./model-client.cjs');
const { requestHttp, validateToolUrl } = require('./http-client.cjs');

function createPublishedRunner({ getStore, getToolStore, getKnowledgeStore, fetchImpl, httpFetchImpl, timeoutMs, runTimeoutMs = 120000, maxConcurrent = 3 } = {}) {
  let active = 0;
  function adapters(bundle, live) {
    return {
      workflows: bundle.dependencies,
      validateModel(n) { const model = getStore().get(n.config.modelId); if (!model.enabled) throw Error('所选模型已停用。'); },
      validateKnowledge(n) { const kb = getKnowledgeStore().get(n.config.knowledgeId); if (!kb.chunkCount) throw Error('所选知识库为空，请先添加文档。'); },
      validateHttp(n) {
        const url = validateToolUrl(n.config.url.replace(/\{\{[\s\S]*?\}\}/g, 'variable'));
        if (n.config.credentialId && getToolStore().get(n.config.credentialId).origin !== url.origin) throw Error('工具地址与认证配置允许的来源不一致。');
      },
      invokeKnowledge: (n, input) => getKnowledgeStore().search(n.config.knowledgeId, { query: input, topK: Number(n.config.topK ?? 3) }),
      ...(live ? {
        invokeModel: (n, input, signal, context) => chat(getStore().get(n.config.modelId), { input, prompt: context.prompt, signal, timeoutMs, fetchImpl }),
        invokeHttp: (n, request, signal) => requestHttp(request, { credential: n.config.credentialId ? getToolStore().get(n.config.credentialId) : undefined, signal, fetchImpl: httpFetchImpl }),
      } : {}),
    };
  }
  function preflight(bundle) { E.checkExecution(bundle.workflow, true, { ...adapters(bundle, true), requireInvokers: true }); }
  return {
    preflight,
    async run(appId, snapshot, body, signal) {
      if (typeof body.input !== 'string' || body.input.length > 10000) throw new AppError(400, '运行输入必须是最多 10000 个字符的文本。');
      const mode = body.mode ?? 'live';
      if (!['live', 'simulation'].includes(mode)) throw new AppError(400, '运行模式无效。');
      if (active >= maxConcurrent) throw new AppError(429, '同时最多运行 3 个请求，请稍后重试。');
      active++;
      const started = Date.now(), controller = new AbortController(), logs = [], starts = new Map();
      let timedOut = false, omittedLogs = 0, logBytes = 0, current;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => { timedOut = true; abort(); }, runTimeoutMs);
      const base = { appId, version: snapshot.version, mode, runId: randomUUID() };
      const rootContext = { workflowId: snapshot.bundle.workflow.id, workflowName: snapshot.bundle.workflow.name };
      const safeText = value => typeof value === 'string' ? value.slice(0, 4000) : undefined;
      const add = log => {
        const bytes = Buffer.byteLength(JSON.stringify(log));
        if (logs.length >= 500 || logBytes + bytes > 256 * 1024) { omittedLogs++; return; }
        logs.push(log); logBytes += bytes;
      };
      const key = (id, path) => JSON.stringify([id, path || []]);
      const start = (node, path = [], context = {}) => {
        current = { nodeId: node.id, name: node.name, type: node.type, iterationPath: path, ...rootContext, ...context };
        starts.set(key(node.id, path), Date.now());
      };
      const complete = (log, path = [], context = {}) => add({ id: log.id, nodeId: log.id, name: log.name, type: log.type,
        status: 'success', input: safeText(log.input), output: safeText(log.output), outputType: log.outputType,
        elapsedMs: Date.now() - (starts.get(key(log.id, path)) || Date.now()), iterationPath: path, ...rootContext, ...context,
        ...(log.httpStatus !== undefined ? { httpStatus: log.httpStatus } : {}),
        ...(log.knowledgeId ? { knowledgeId: log.knowledgeId, knowledgeName: safeText(log.knowledgeName), sources: (log.sources || []).slice(0, 10).map(s => ({ documentId: safeText(s.documentId), documentName: safeText(s.documentName), chunkId: safeText(s.chunkId), chunkIndex: s.chunkIndex, score: s.score, text: safeText(s.text) })) } : {}) });
      let removeAbort;
      try {
        const options = adapters(snapshot.bundle, mode === 'live');
        const execution = E.runFlow(snapshot.bundle.workflow, body.input, { ...options, signal: controller.signal,
          onNodeStart: n => start(n), onNode: log => complete(log),
          onIteration(event) {
            const context = { workflowId: event.workflowId, workflowName: event.workflowName, batchNodeId: event.batchNodeId, index: event.index, total: event.total };
            if (event.kind === 'node-start') start(event.node, event.path, context);
            if (event.kind === 'node-complete') complete(event.log, event.path, context);
          },
        });
        const cancelled = new Promise((_, reject) => {
          removeAbort = () => { const error = Error(timedOut ? '运行总超时。' : '运行已取消。'); error.name = 'AbortError'; reject(error); };
          if (controller.signal.aborted) removeAbort(); else controller.signal.addEventListener('abort', removeAbort, { once: true });
        });
        const result = await Promise.race([execution, cancelled]);
        return { ...base, status: 'success', output: result.output, logs, elapsedMs: Date.now() - started, ...(omittedLogs ? { omittedLogs } : {}) };
      } catch (error) {
        const message = safeText(controller.signal.aborted ? (timedOut ? '运行总超时。' : '运行已取消。') : error.message);
        const nodeId = error.detailNodeId || error.nodeId || current?.nodeId;
        add({ ...current, nodeId, status: controller.signal.aborted ? 'cancelled' : 'error', error: message, elapsedMs: current ? Date.now() - (starts.get(key(current.nodeId, current.iterationPath)) || started) : 0 });
        return { ...base, status: controller.signal.aborted ? 'cancelled' : 'error', error: message, nodeId, logs, elapsedMs: Date.now() - started, ...(omittedLogs ? { omittedLogs } : {}) };
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (removeAbort) controller.signal.removeEventListener('abort', removeAbort);
        active--;
      }
    },
  };
}
module.exports = { createPublishedRunner };

const E = require('../public/engine.js');
const { AppError } = require('./model-store.cjs');
const { completion, validateInput } = require('./model-client.cjs');
const { requestHttp, validateToolUrl } = require('./http-client.cjs');

function createAgentRuntime({ getToolStore, getKnowledgeStore, httpFetchImpl } = {}) {
  const adapters = {
    validateKnowledge(n) {
      if (!getKnowledgeStore().get(n.config.knowledgeId).chunkCount) throw new AppError(400, '所选知识库为空，请先添加文档。');
    },
    invokeKnowledge: (n, input) => getKnowledgeStore().search(n.config.knowledgeId, { query: input, topK: Number(n.config.topK ?? 3) }),
    validateHttp(n) {
      const url = validateToolUrl(n.config.url.replace(/\{\{[\s\S]*?\}\}/g, 'variable'));
      if (n.config.credentialId && getToolStore().get(n.config.credentialId).origin !== url.origin) throw new AppError(400, '工具地址与认证配置允许的来源不一致。');
    },
    invokeHttp: (n, request, signal) => requestHttp(request, { credential: n.config.credentialId ? getToolStore().get(n.config.credentialId) : undefined, signal, fetchImpl: httpFetchImpl }),
  };
  function prepare(tools) {
    try {
      if (!Array.isArray(tools) || !tools.length || tools.length > 8) throw new AppError(400, '智能体需要选择 1 到 8 个工具。');
      const ids = new Set();
      return tools.map(tool => {
        if (!tool || !['knowledge', 'http'].includes(tool.type) || ids.has(tool.id)) throw new AppError(400, '智能体工具无效或重复。');
        ids.add(tool.id);
        const flow = E.validateFlow(E.agentToolFlow(tool)), target = flow.nodes[1];
        E.agentTools({ nodes: [target] }, { config: { toolNodeIds: JSON.stringify([target.id]) } });
        E.checkExecution(flow, true, { ...adapters, requireInvokers: true });
        return { flow, target };
      });
    } catch (error) {
      throw error instanceof AppError ? error : new AppError(400, error.message);
    }
  }
  return { prepare, execute: (prepared, query, signal) => E.runFlow(prepared.flow, query, { ...adapters, signal }) };
}

async function runAgent(model, { prompt, input, history = [], tools, maxToolRounds = '4', signal, timeoutMs, fetchImpl, runtime, totalTimeoutMs = 120000 }) {
  const steps = [], controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; abort(); }, totalTimeoutMs);
  const checkAbort = () => {
    if (controller.signal.aborted) throw new AppError(timedOut ? 504 : 499, timedOut ? '智能体运行总超时。' : '请求已取消。');
  };
  try {
    checkAbort(); validateInput(model, { prompt, input, history });
    let rounds;
    try { rounds = E.agentConfig({ maxToolRounds }).rounds; }
    catch (error) { throw new AppError(400, error.message); }
    // All allowlisted tools are validated before the first model request.
    const prepared = runtime.prepare(tools);
    const definitions = prepared.map(({ target }, i) => ({ type: 'function', function: {
      name: `tool_${i}`, description: `${target.name}（${target.type === 'knowledge' ? '检索知识库' : 'HTTP GET 只读查询'}）`,
      parameters: { type: 'object', properties: { query: { type: 'string', description: '检索或查询文本，作为工具节点的输入。', maxLength: 10000 } }, required: ['query'], additionalProperties: false },
    } }));
    const messages = [{ role: 'system', content: prompt }, ...history.map(m => ({ role: m.role, content: m.content })), { role: 'user', content: input }];
    const usedIds = new Set();
    for (let round = 0; round <= rounds; round++) {
      checkAbort();
      const message = await completion(model, { messages, tools: definitions, toolChoice: round === rounds ? 'none' : 'auto', signal: controller.signal, timeoutMs, fetchImpl });
      checkAbort();
      if (message.tool_calls != null && !Array.isArray(message.tool_calls)) throw new AppError(502, '模型返回的工具调用格式无效。');
      const calls = message.tool_calls || [];
      if (!calls.length) {
        if (typeof message.content !== 'string' || !message.content.trim()) throw new AppError(502, '智能体未返回有效回答。');
        if (message.content.length > 100000) throw new AppError(502, '智能体输出超过 100000 个字符。');
        return { output: message.content, steps };
      }
      if (round === rounds) throw new AppError(422, '智能体达到工具轮数上限，模型仍请求工具，请调整任务或增加上限。');
      if (calls.length > 8 || steps.length + calls.length > 20) throw new AppError(422, '智能体最多执行 20 次工具调用，每轮最多 8 次。');
      // Validate the entire round before executing even its first call.
      const parsed = calls.map(call => {
        if (!call || call.type !== 'function' || typeof call.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(call.id) || usedIds.has(call.id)) throw new AppError(502, '模型返回的工具调用 ID 无效或重复。');
        usedIds.add(call.id);
        const index = definitions.findIndex(d => d.function.name === call.function?.name);
        if (index < 0) throw new AppError(502, '模型请求了未授权的工具。');
        let args;
        try {
          if (typeof call.function.arguments !== 'string' || call.function.arguments.length > 65000) throw Error();
          args = JSON.parse(call.function.arguments);
          if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || typeof args.query !== 'string' || args.query.length > 10000 || !args.query.trim()) throw Error();
        } catch { throw new AppError(502, '模型工具参数需要包含唯一的非空 query 文本，最多 10000 字符。'); }
        const query = model.apiKey ? args.query.replaceAll(model.apiKey, '[已隐藏 API Key]') : args.query;
        return { call: { ...call, function: { name: call.function.name, arguments: JSON.stringify({ query }) } }, index, query };
      });
      messages.push({ role: 'assistant', content: typeof message.content === 'string' ? message.content : null, tool_calls: parsed.map(({ call }) => ({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } })) });
      for (const { call, index, query } of parsed) {
        checkAbort();
        const started = Date.now(), tool = prepared[index];
        const step = { name: tool.target.name, toolNodeId: tool.target.id, type: tool.target.type, round: round + 1, query: query.slice(0, 2000), status: 'running' };
        steps.push(step);
        try {
          const result = await runtime.execute(tool, query, controller.signal);
          checkAbort();
          const output = model.apiKey ? result.output.replaceAll(model.apiKey, '[已隐藏 API Key]') : result.output;
          // Bounded observations are data, never instructions or templates.
          const clipped = output.length > 12000 ? output.slice(0, 12000) + '\n…[工具结果已截断]' : output;
          step.output = clipped.length > 1200 ? clipped.slice(0, 1200) + '\n…[日志已截断]' : clipped;
          step.status = 'success';
          messages.push({ role: 'tool', tool_call_id: call.id, content: clipped });
        } catch (error) {
          step.status = controller.signal.aborted ? 'cancelled' : 'error';
          step.error = controller.signal.aborted ? '工具调用已取消。' : error instanceof AppError || error.nodeId ? error.message : '工具执行失败。';
          throw error;
        } finally { step.elapsedMs = Date.now() - started; }
      }
    }
  } catch (error) {
    const safe = controller.signal.aborted ? new AppError(timedOut ? 504 : 499, timedOut ? '智能体运行总超时。' : '请求已取消。') : error instanceof AppError ? error : new AppError(error.nodeId ? 400 : 500, error.nodeId ? error.message : '智能体执行失败，请检查工具配置。');
    // Tool subflows have their own node IDs. Let the caller attribute failure
    // to the agent node; the actual tool remains identified in the trace.
    delete safe.nodeId; delete safe.detailNodeId;
    safe.agentSteps = steps;
    throw safe;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

module.exports = { createAgentRuntime, runAgent };

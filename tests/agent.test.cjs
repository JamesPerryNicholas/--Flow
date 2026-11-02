const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const E = require('../public/engine.js');
const B = require('../public/workflow-bundle.js');
const H = require('../public/run-history.js');
const { AppError } = require('../lib/model-store.cjs');
const { createKnowledgeStore } = require('../lib/knowledge-store.cjs');
const { createPublishedStore } = require('../lib/published-store.cjs');
const { createConversationStore } = require('../lib/conversation-store.cjs');
const { createAgentRuntime, runAgent } = require('../lib/agent-runner.cjs');
const { createApp } = require('../server.cjs');
const model = { id: 'm', name: '测试', model: 'fake', enabled: true, baseUrl: 'https://fake.example/v1', apiKey: 'agent-test-secret' };
const response = message => new Response(JSON.stringify({ choices: [{ message }] }));
const toolCall = (id, query = '退款', name = 'tool_0') => ({ id, type: 'function', function: { name, arguments: JSON.stringify({ query }) } });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const knowledge = createKnowledgeStore({ filePath: path.join(dir, 'knowledge.json') });
  const library = knowledge.save({ name: '售后手册' });
  knowledge.saveDocument(library.id, { name: '退款规则', content: '退款规则：购买后七天内可申请退款。' });
  const tool = E.makeNode('knowledge', 0, 0); tool.name = '查询退款规则'; tool.config.knowledgeId = library.id;
  const runtime = createAgentRuntime({ getKnowledgeStore: () => knowledge });
  const options = { prompt: '根据资料回答并引用来源。', input: '我能退款吗？', tools: [tool], runtime };
  const flow = E.sample(); flow.nodes[1].config = { ...flow.nodes[1].config, modelId: 'm', toolNodeIds: JSON.stringify([tool.id]) }; flow.nodes.push(tool);
  return { dir, knowledge, tool, runtime, options, flow };
}
async function listen(t, options) {
  const server = http.createServer(createApp(options));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (url, body, headers = {}) => {
    const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
}

test('智能体自主检索、多轮工具消息配对与来源，旧角色模型不变', async t => {
  const { options } = fixture(t), requests = [];
  const result = await runAgent(model, { ...options, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    if (requests.length === 1) {
      assert.equal(body.parallel_tool_calls, false); assert.equal(body.tools[0].function.name, 'tool_0');
      assert.match(body.tools[0].function.description, /查询退款规则/);
      return response({ content: null, tool_calls: [toolCall('c1')] });
    }
    assert.equal(body.messages[2].role, 'assistant');
    assert.equal(body.messages[3].role, 'tool'); assert.equal(body.messages[3].tool_call_id, 'c1');
    assert.match(body.messages[3].content, /退款规则.*片段/); assert.match(body.messages[3].content, /七天/);
    return response({ content: '七天内可退款 [1]。' });
  } });
  assert.equal(result.output, '七天内可退款 [1]。'); assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].status, 'success'); assert.equal(result.steps[0].round, 1);
  assert.ok(result.steps[0].elapsedMs >= 0);
});

test('选择的工具并非必须调用，直接回答不执行任何工具', async t => {
  const { options, runtime } = fixture(t); runtime.execute = () => assert.fail('unexpected tool');
  const result = await runAgent(model, { ...options, fetchImpl: async () => response({ content: '你好', tool_calls: null }) });
  assert.equal(result.output, '你好'); assert.deepEqual(result.steps, []);
});

test('轮数上限后强制回答，拒绝继续工具调用且不产生额外查询', async t => {
  const { options, runtime } = fixture(t); let requests = 0, tools = 0;
  const execute = runtime.execute; runtime.execute = (...args) => { tools++; return execute(...args); };
  const result = await runAgent(model, { ...options, maxToolRounds: '1', fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); requests++;
    if (requests === 1) return response({ content: null, tool_calls: [toolCall('first')] });
    assert.equal(body.tool_choice, 'none'); return response({ content: '最终答复' });
  } });
  assert.equal(result.output, '最终答复'); assert.equal(tools, 1);
  requests = 0;
  await assert.rejects(runAgent(model, { ...options, maxToolRounds: '1', fetchImpl: async () => response({ tool_calls: [toolCall('limit' + (++requests))] }) }), error => {
    assert.equal(error.status, 422); assert.equal(error.agentSteps.length, 1); return true;
  });
  assert.equal(tools, 2);
});

test('整轮未知工具、参数、重复ID先校验，首个合法调用也不提前执行', async t => {
  const { options, runtime } = fixture(t); runtime.execute = () => assert.fail('validation should precede all tools');
  const invalid = [
    toolCall('other', 'q', 'unlisted'), { ...toolCall('other'), type: 'other' }, toolCall('same'),
    { ...toolCall('other'), function: { name: 'tool_0', arguments: '{' } },
    { ...toolCall('other'), function: { name: 'tool_0', arguments: '{"query":"x","url":"https://evil.example"}' } },
    toolCall('other', ''), toolCall('other', 'x'.repeat(10001)), { ...toolCall('other'), id: 'bad id' },
  ];
  for (const call of invalid) {
    await assert.rejects(runAgent(model, { ...options, fetchImpl: async () => response({ content: null, tool_calls: [toolCall('same'), call] }) }), error => error.status === 502 && error.agentSteps.length === 0);
  }
});

test('全部工具配置在模型请求前预检，拒绝写接口、动态来源和跨节点变量', async t => {
  const { options, tool } = fixture(t); let calls = 0;
  const fetchImpl = async () => { calls++; return response({ content: '不应调用' }); };
  const cases = [[], [tool, tool], [E.makeNode('llm', 0, 0)], Array(9).fill(tool)];
  for (const config of [
    { method: 'POST', url: 'https://tools.example/search' },
    { method: 'GET', url: 'https://{{input}}/search' },
    { method: 'GET', url: 'https://tools.example?q={{nodes.other.output}}' },
    { method: 'GET', url: 'http://169.254.169.254/' },
  ]) { const n = E.makeNode('http', 0, 0); Object.assign(n.config, config); cases.push([tool, n]); }
  for (const tools of cases) await assert.rejects(runAgent(model, { ...options, tools, fetchImpl }), e => e.status === 400);
  for (const maxToolRounds of ['0', '11', 'x', '1.1']) await assert.rejects(runAgent(model, { ...options, maxToolRounds, fetchImpl }), e => e.status === 400);
  assert.equal(calls, 0);
});

test('GET工具固定来源、查询自动编码、来源绑定凭据及响应字段提取', async t => {
  const { options } = fixture(t), tool = E.makeNode('http', 0, 0); let requests = 0, httpCalls = 0;
  Object.assign(tool.config, { url: 'https://tools.example/search?q={{input}}', credentialId: 'cred', responsePath: '/answer' });
  const secret = 'Bearer test-credential';
  const runtime = createAgentRuntime({ getToolStore: () => ({ get: () => ({ origin: 'https://tools.example', headerName: 'Authorization', secret }) }), httpFetchImpl: async (url, init) => {
    httpCalls++; assert.equal(url.origin, 'https://tools.example'); assert.equal(url.searchParams.get('q'), 'a&next=https://evil.example');
    assert.equal(init.headers.Authorization, secret); assert.equal(init.method, 'GET');
    return new Response(JSON.stringify({ answer: '答案 ' + secret }));
  } });
  const result = await runAgent(model, { ...options, tools: [tool], runtime, fetchImpl: async (_url, init) => {
    if (++requests === 1) return response({ tool_calls: [toolCall('http1', 'a&next=https://evil.example')] });
    const body = JSON.parse(init.body); assert.match(body.messages.at(-1).content, /答案/); assert.ok(!JSON.stringify(body).includes(secret));
    return response({ content: '查询完成' });
  } });
  assert.equal(httpCalls, 1); assert.equal(result.steps[0].type, 'http'); assert.ok(!JSON.stringify(result).includes(secret));
});

test('工具失败保留已执行过程，阻止下一个工具和后续模型调用', async t => {
  const { options, runtime } = fixture(t); let models = 0, tools = 0;
  runtime.execute = async () => { tools++; throw new AppError(502, '工具服务返回错误（HTTP 503）。'); };
  await assert.rejects(runAgent(model, { ...options, fetchImpl: async () => { models++; return response({ tool_calls: [toolCall('a'), toolCall('b')] }); } }), error => {
    assert.equal(error.agentSteps[0].status, 'error'); assert.match(error.agentSteps[0].error, /503/); return true;
  });
  assert.equal(models, 1); assert.equal(tools, 1);
});

test('取消在请求前及工具返回后生效，迟到结果不能继续调用模型', async t => {
  const { options, runtime } = fixture(t); const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(runAgent(model, { ...options, signal: cancelled.signal, fetchImpl: () => assert.fail('request after cancel') }), e => e.status === 499);
  const controller = new AbortController(); let models = 0;
  runtime.execute = async () => { controller.abort(); return { output: 'late result' }; };
  await assert.rejects(runAgent(model, { ...options, signal: controller.signal, fetchImpl: async () => { models++; return response({ tool_calls: [toolCall('late')] }); } }), e => e.status === 499 && e.agentSteps[0].status === 'cancelled');
  assert.equal(models, 1);
});

test('总超时中止模型请求，公开响应和工具参数不泄漏模型密钥', async t => {
  const { options } = fixture(t);
  await assert.rejects(runAgent(model, { ...options, totalTimeoutMs: 20, fetchImpl: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })) }), e => e.status === 504);
  let calls = 0;
  const result = await runAgent(model, { ...options, fetchImpl: async () => ++calls === 1 ? response({ tool_calls: [toolCall('echo', model.apiKey)] }) : response({ content: 'echo ' + model.apiKey }) });
  assert.ok(!JSON.stringify(result).includes(model.apiKey));
  const unusual = { ...model, apiKey: 'fake\"quoted\\key' }; let round = 0;
  const redacted = await runAgent(unusual, { ...options, fetchImpl: async (_url, init) => {
    if (++round === 1) return response({ tool_calls: [toolCall('quoted', unusual.apiKey)] });
    assert.equal(JSON.parse(JSON.parse(init.body).messages[2].tool_calls[0].function.arguments).query, '[已隐藏 API Key]');
    return response({ content: 'safe' });
  } });
  assert.equal(redacted.steps[0].query, '[已隐藏 API Key]');
});

test('限制20次调用、单轮8次、空回答及超长工具观测', async t => {
  const { options, runtime } = fixture(t); let count = 0;
  runtime.execute = async () => ({ output: 'z'.repeat(15000) });
  await assert.rejects(runAgent(model, { ...options, fetchImpl: async () => {
    count++; return response({ tool_calls: Array.from({ length: 8 }, (_, i) => toolCall(`c${count}_${i}`)) });
  } }), e => e.status === 422 && e.agentSteps.length === 16);
  await assert.rejects(runAgent(model, { ...options, fetchImpl: async () => response({ tool_calls: Array.from({ length: 9 }, (_, i) => toolCall('r' + i)) }) }), e => e.status === 422 && e.agentSteps.length === 0);
  await assert.rejects(runAgent(model, { ...options, fetchImpl: async () => response({ content: '' }) }), e => e.status === 502);
  count = 0;
  const result = await runAgent(model, { ...options, fetchImpl: async (_url, init) => {
    if (++count === 1) return response({ tool_calls: [toolCall('large')] });
    const text = JSON.parse(init.body).messages.at(-1).content;
    assert.ok(text.length < 12100); assert.match(text, /工具结果已截断/); return response({ content: '完成' });
  } });
  assert.ok(result.steps[0].output.length < 1300); assert.match(result.steps[0].output, /日志已截断/);
});

test('草稿导入导出保留工具引用，缺失工具预检阻止前置模型，模拟保持无工具请求', async t => {
  const { flow, tool } = fixture(t), imported = B.importBundle(B.exportBundle(flow, [flow])).workflow;
  assert.deepEqual(E.agentTools(imported, imported.nodes[1]).map(n => n.id), [tool.id]);
  let invoked = 0;
  const options = { invokeModel: async () => { invoked++; return 'unexpected'; }, invokeAgent: async () => { invoked++; return { output: '自主结果', steps: [] }; }, invokeKnowledge: async () => assert.fail('tool should run server-side') };
  const result = await E.runFlow(imported, 'input', { ...options, invokeModel: undefined }); assert.equal(result.output, '自主结果'); assert.equal(invoked, 1);
  for(const key of ['toolNodeIds','maxToolRounds']) {const invalid = JSON.parse(JSON.stringify(imported));invalid.nodes[1].config[key]=[];assert.throws(()=>E.validateFlow(invalid),/配置必须为文本/);}
  imported.nodes = imported.nodes.filter(n => n.id !== tool.id);
  await assert.rejects(E.runFlow(imported, 'input', options), e => e.nodeId === imported.nodes[1].id);
  assert.equal(invoked, 1);
  const sim = await E.runFlow(imported, '模拟'); assert.match(sim.output, /模拟/);
});

test('智能体工具过程按白名单持久化，历史重载不丢失、未知字段被移除', t => {
  fixture(t); let saved = null; const storage = { getItem: () => saved, setItem: (_k, v) => { saved = v; } };
  const store = H.createStore(storage), id = store.start({ flowId: 'f', flowName: 'test', input: 'x' });
  store.append(id, { id: 'a', type: 'agent', status: 'success', agentSteps: [{ name: '查询', toolNodeId: 't', type: 'knowledge', round: 1, query: 'q', output: 'a', status: 'success', elapsedMs: 3, secret: 'must-drop' }] });
  store.finish(id, { status: 'success', output: 'a' });
  assert.ok(!saved.includes('must-drop'));
  const log = H.createStore(storage).list('f')[0].logs[0]; assert.equal(log.agentSteps[0].query, 'q');
  assert.match(H.formatAgentSteps(log.agentSteps), /第 1 轮.*成功/);
});

test('工作台API与发布应用/固定版本/对话记忆串联执行自主工具', async t => {
  const { dir, flow, knowledge, tool } = fixture(t); let requests = 0; const seen = [];
  const api = await listen(t, {
    store: { get: () => model }, knowledgeStore: knowledge,
    publishedStore: createPublishedStore({ filePath: path.join(dir, 'published.json') }),
    conversationStore: createConversationStore({ filePath: path.join(dir, 'conversations.json') }),
    fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); seen.push(body); return ++requests % 2 ? response({ tool_calls: [toolCall('c' + requests)] }) : response({ content: '七天内可退 [1]。' }); },
  });
  const live = await api('/api/agent', { modelId: 'm', prompt: '', input: '退款？', tools: [tool], maxToolRounds: '2' });
  assert.equal(live.status, 200); assert.equal(live.body.steps[0].status, 'success');
  const pub = await api('/api/published', { bundle: B.exportBundle(flow, [flow]) }); assert.equal(pub.status, 201);
  const root = '/api/published/' + pub.body.app.id;
  const conversation = (await api(root + '/conversations', { version: 1 })).body.conversation;
  const run = await api(root + '/run', { input: '能退款吗？', version: 1, conversationId: conversation.id });
  assert.equal(run.body.status, 'success'); assert.equal(run.body.conversationSaved, true);
  assert.equal(run.body.logs.find(l => l.type === 'agent').agentSteps[0].toolNodeId, tool.id);
  await api(root + '/run', { input: '再确认一下', version: 1, conversationId: conversation.id });
  assert.deepEqual(seen[4].messages.slice(1, 3), [{ role: 'user', content: '能退款吗？' }, { role: 'assistant', content: '七天内可退 [1]。' }]);
  const sim = await api(root + '/run', { input: '模拟', version: 1, mode: 'simulation' });
  assert.equal(sim.body.status, 'success'); assert.equal(requests, 6);
  const cross = await api('/api/agent', { modelId: 'm', prompt: '', input: 'x', tools: [tool] }, { Origin: 'https://evil.example' });
  assert.equal(cross.status, 403); assert.equal(requests, 6);
});

test('API工具失败返回过程，非法配置与模型停用不发出外部请求', async t => {
  const { tool, knowledge } = fixture(t); let requests = 0;
  const api = await listen(t, { store: { get: () => model }, knowledgeStore: knowledge, fetchImpl: async () => { requests++; return response({ tool_calls: [toolCall('bad', '无匹配')] }); } });
  const body = { modelId: 'm', prompt: '', input: 'x', tools: [tool], maxToolRounds: '1' };
  assert.equal((await api('/api/agent', { ...body, maxToolRounds: '0' })).status, 400); assert.equal(requests, 0);
  const failed = await api('/api/agent', body); assert.equal(failed.status, 422); assert.equal(failed.body.agentSteps.length, 1);
  const disabledApi = await listen(t, { store: { get: () => ({ ...model, enabled: false }) }, knowledgeStore: knowledge, fetchImpl: () => assert.fail('disabled model request') });
  assert.equal((await disabledApi('/api/agent', body)).status, 400);
});

test('批处理子流程智能体每项独立工具循环，不携带根会话上下文', async t => {
  const { dir, flow: child, knowledge, tool } = fixture(t);
  const parent = E.sample(); parent.nodes[1] = E.makeNode('batch', 0, 0); parent.nodes[1].config.workflowId = child.id;
  parent.edges = [{ id: E.uid(), from: parent.nodes[0].id, to: parent.nodes[1].id, branch: 'yes' }, { id: E.uid(), from: parent.nodes[1].id, to: parent.nodes[2].id, branch: 'yes' }];
  let calls = 0;
  const api = await listen(t, { store: { get: () => model }, knowledgeStore: knowledge,
    publishedStore: createPublishedStore({ filePath: path.join(dir, 'published.json') }), conversationStore: createConversationStore({ filePath: path.join(dir, 'conversations.json') }),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); calls++;
      assert.ok(!body.messages.some(m => m.content === '不应传入子流程的历史'));
      return calls % 2 ? response({ tool_calls: [toolCall('batch' + calls)] }) : response({ content: '单项处理完毕' });
    },
  });
  const published = await api('/api/published', { bundle: B.exportBundle(parent, [parent, child]) }); assert.equal(published.status, 201);
  const root = '/api/published/' + published.body.app.id;
  const conversation = (await api(root + '/conversations', { version: 1 })).body.conversation;
  await api(root + '/run', { input: '["不应传入子流程的历史"]', version: 1, conversationId: conversation.id });
  const run = await api(root + '/run', { input: '["甲","乙"]', version: 1, conversationId: conversation.id });
  assert.equal(run.body.status, 'success'); assert.equal(calls, 6);
  const agents = run.body.logs.filter(log => log.type === 'agent');
  assert.deepEqual(agents.map(log => log.iterationPath), [[0], [1]]);
  assert.ok(agents.every(log => log.agentSteps[0].toolNodeId === tool.id));
});

test('工作台智能体并发上限拒绝第四个请求，完成后释放槽位', { timeout: 2000 }, async t => {
  const { tool, knowledge } = fixture(t); let count = 0, ready;
  const started = new Promise(resolve => { ready = resolve; }), pending = [];
  const api = await listen(t, { store: { get: () => model }, knowledgeStore: knowledge, fetchImpl: async () => {
    count++; if (count >= 3) ready();
    return new Promise(resolve => pending.push(() => resolve(response({ content: '完成' }))));
  } });
  const body = { modelId: 'm', prompt: '', input: 'x', tools: [tool] };
  const runs = [api('/api/agent', body), api('/api/agent', body), api('/api/agent', body)];
  await started;
  const fourth = await api('/api/agent', body); assert.equal(fourth.status, 429); assert.equal(count, 3);
  pending.splice(0).forEach(resolve => resolve());
  assert.ok((await Promise.all(runs)).every(result => result.status === 200));
  const next = api('/api/agent', body);
  while (count < 4) await new Promise(resolve => setImmediate(resolve));
  pending.splice(0).forEach(resolve => resolve()); assert.equal((await next).status, 200);
});

test('智能体已完成工具但输出字段校验失败时，保留过程并归因到智能体', async t => {
  const { flow, tool } = fixture(t), agent = flow.nodes[1];
  agent.config.outputType = 'json'; agent.config.outputSchema = '{"type":"object","required":["answer"]}';
  const trace = [{ name: tool.name, toolNodeId: tool.id, type: 'knowledge', round: 1, query: '退款', output: '七天', status: 'success', elapsedMs: 1 }];
  await assert.rejects(E.runFlow(flow, '输入', { invokeAgent: async () => ({ output: '{}', steps: trace }), invokeKnowledge() {} }), e => {
    assert.equal(e.nodeId, agent.id); assert.deepEqual(e.agentSteps, trace); assert.match(e.message, /字段校验/); return true;
  });
  const { runtime, options } = fixture(t);
  runtime.execute = async () => { const e = new AppError(502, '工具失败'); e.nodeId = tool.id; throw e; };
  await assert.rejects(runAgent(model, { ...options, fetchImpl: async () => response({ tool_calls: [toolCall('fail')] }) }), e => {
    assert.equal(e.nodeId, undefined); assert.equal(e.agentSteps[0].status, 'error'); return true;
  });
});

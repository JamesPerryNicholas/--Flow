(function (root) {
  'use strict';
  const Schema = typeof module === 'object' && module.exports ? require('./json-schema.js') : root.FlowSchema;
  const types = {
    start: { name: '开始', description: '工作流的起点，接收输入', icon: 'play', color: '#65a593', bg: '#eaf5ef', category: '基础节点' },
    end: { name: '结束', description: '输出工作流的最终结果', icon: 'stop', color: '#d27e8c', bg: '#fbedf0', category: '基础节点' },
    agent: { name: '智能体', description: '赋予角色，自主处理任务', icon: 'bot', color: '#8b72cf', bg: '#f1ecfb', category: '智能能力' },
    llm: { name: '大模型', description: '理解、推理与内容生成', icon: 'sparkles', color: '#6887cf', bg: '#edf2fe', category: '智能能力' },
    knowledge: { name: '知识库', description: '检索自定义的知识内容', icon: 'book', color: '#c19b57', bg: '#faf3e6', category: '智能能力' },
    http: { name: 'HTTP 请求', description: '调用外部接口，连接业务服务', icon: 'globe', color: '#579eaa', bg: '#eaf6f7', category: '工具与服务' },
    batch: { name: '循环批处理', description: '遍历数组并逐项执行子工作流', icon: 'repeat', color: '#c29455', bg: '#fcf3e7', category: '流程控制' },
    condition: { name: '条件分支', description: '根据条件，选择执行路径', icon: 'branch', color: '#c29455', bg: '#fcf3e7', category: '流程控制' }
  };
  const uid = () => globalThis.crypto?.randomUUID?.() || 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  function makeNode(type, x, y) {
    return { id: uid(), type, name: types[type].name, x, y, config: {
      ...(!['start', 'end'].includes(type) ? { inputTemplate: '{{input}}' } : {}),
      ...(type === 'agent' || type === 'llm' ? { modelId: '', prompt: type === 'agent' ? '你是一位专业的内容创作助手。请根据用户的需求，提供清晰、有创意的内容建议。' : '请理解用户的输入，并给出清晰、准确的回答。', template: '创作建议：{{input}}\n\n这是本地模板模拟结果。' } : {}),
      ...(type === 'start' ? { variable: 'input' } : {}),
      ...(type === 'end' ? { template: '{{input}}' } : {}),
      ...(type === 'knowledge' ? { sourceMode: 'library', knowledgeId: '', topK: '3', content: '' } : {}),
      ...(type === 'http' ? { method: 'GET', url: '', bodyTemplate: '{"input":"{{input}}"}', credentialId: '', timeoutMs: '30000', responsePath: '', template: '{"result":"本地模拟响应"}' } : {}),
      ...(type === 'batch' ? { workflowId: '', maxItems: '100', resultType: 'text', outputType: 'json' } : {}),
      ...(type === 'condition' ? { keyword: '创作' } : {})
    } };
  }
  function sample() {
    const nodes = [makeNode('start', 70, 230), makeNode('agent', 400, 180), makeNode('end', 730, 230)];
    nodes[1].name = '内容创作助手';
    return { id: uid(), name: '我的第一个智能体', nodes, edges: [
      { id: uid(), from: nodes[0].id, to: nodes[1].id, branch: 'yes' },
      { id: uid(), from: nodes[1].id, to: nodes[2].id, branch: 'yes' }
    ], view: { x: 40, y: 60, zoom: 1 } };
  }
  function validateFlow(value) {
    if (!value || typeof value !== 'object' || typeof value.name !== 'string' || value.name.length > 60 || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || value.nodes.length > 300 || value.edges.length > 1000) throw Error('文件格式不正确，最多支持 300 个节点、1000 条连线');
    const ids = new Set();
    const nodes = value.nodes.map(n => {
      if (!n || !Object.hasOwn(types, n.type) || typeof n.id !== 'string' || !n.id || n.id.length > 100 || ids.has(n.id) || !Number.isFinite(n.x) || !Number.isFinite(n.y) || Math.abs(n.x) > 1e6 || Math.abs(n.y) > 1e6 || typeof n.name !== 'string' || n.name.length > 100) throw Error('节点信息无效或 ID 重复');
      ids.add(n.id);
      const config = {};
      for (const key of ['model', 'modelId', 'prompt', 'template', 'inputTemplate', 'variable', 'content', 'keyword', 'method', 'url', 'bodyTemplate', 'credentialId', 'timeoutMs', 'responsePath', 'outputType', 'workflowId', 'maxItems', 'resultType', 'sourceMode', 'knowledgeId', 'topK']) {
        if (typeof n.config?.[key] === 'string') config[key] = n.config[key].slice(0, 50000);
      }
      if (n.config?.outputSchema !== undefined) {
        if (typeof n.config.outputSchema !== 'string' || n.config.outputSchema.length > 50000) throw Error('JSON 字段规则必须是最多 50000 个字符的文本');
        config.outputSchema = n.config.outputSchema;
      }
      if (n.config?.outputType !== undefined && !['text', 'json'].includes(n.config.outputType)) throw Error('节点输出类型必须是 text 或 json');
      if (n.type === 'batch') { batchConfig(config); config.outputType = 'json'; }
      if (n.type === 'knowledge') knowledgeConfig(config);
      return { id: n.id, type: n.type, name: n.name, x: n.x, y: n.y, config };
    });
    const edgeIds = new Set();
    const edges = value.edges.map(e => {
      if (!e || typeof e.id !== 'string' || edgeIds.has(e.id) || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to || !['yes', 'no'].includes(e.branch)) throw Error('连线数据无效');
      edgeIds.add(e.id);
      return { id: e.id, from: e.from, to: e.to, branch: e.branch };
    });
    return { id: typeof value.id === 'string' ? value.id : uid(), name: value.name, nodes, edges, view: { x: 40, y: 60, zoom: 1 } };
  }
  function connectionError(flow, from, to, branch = 'yes') {
    const a = flow.nodes.find(n => n.id === from), b = flow.nodes.find(n => n.id === to);
    if (!a || !b || from === to) return '不能连接到自身';
    if (a.type === 'end' || b.type === 'start') return '结束节点不能输出，开始节点不能接收输入';
    if (!['yes', 'no'].includes(branch) || (branch === 'no' && a.type !== 'condition')) return '只有条件节点可以使用否分支';
    if (flow.edges.some(e => e.from === from && e.branch === branch)) return '这个出口已有连线，请先删除原连线';
    if (flow.edges.some(e => e.to === to)) return '每个节点只接收一条输入连线';
    const seen = new Set();
    function reaches(id) { if (id === from) return true; if (seen.has(id)) return false; seen.add(id); return flow.edges.filter(e => e.from === id).some(e => reaches(e.to)); }
    if (reaches(to)) return '不能创建循环连接';
    return '';
  }
  // The editor currently accepts one incoming edge per node. Every ancestor on
  // that chain is therefore guaranteed to execute before this node.
  function getVariables(flow, nodeId) {
    const upstream = flow.nodes.find(n => n.id === flow.edges.find(e => e.to === nodeId)?.from);
    const result = [{ token: '{{input}}', label: '上游输入', description: '直接连接的前一个节点的输出', type: upstream?.type === 'batch' ? 'json' : upstream?.config.outputType || 'text' }];
    const target = flow.nodes.find(n => n.id === nodeId);
    if (!target || target.type === 'start') return [];
    const start = flow.nodes.find(n => n.type === 'start');
    if (start) result.push({ token: '{{start.input}}', label: '开始 · ' + (start.config.variable || 'input'), description: '本次运行的原始输入', type: start.config.outputType || 'text' });
    const seen = new Set([nodeId]);
    let id = nodeId;
    while (true) {
      const edge = flow.edges.find(e => e.to === id);
      if (!edge || seen.has(edge.from)) break;
      seen.add(edge.from);
      const n = flow.nodes.find(n => n.id === edge.from);
      if (!n) break;
      if (n.type !== 'start') result.push({ token: '{{nodes.' + encodeURIComponent(n.id) + '.output}}', label: n.name + ' · 输出', description: types[n.type].name + '节点的执行结果', nodeId: n.id, type: n.type === 'batch' ? 'json' : n.config.outputType || 'text' });
      id = n.id;
    }
    return result;
  }
  function templateTokens(template) {
    return [...String(template).matchAll(/\{\{([\s\S]*?)\}\}/g)].map(match => match[1].trim());
  }
  function variableMap(flow, node, input, original, outputs) {
    const values = new Map([['input', input], ['start.input', original]]);
    for (const variable of getVariables(flow, node.id)) if (variable.nodeId && outputs.has(variable.nodeId)) values.set(variable.token.slice(2, -2), outputs.get(variable.nodeId));
    return values;
  }
  // Split only on literal #; encodeURIComponent keeps # in node IDs as %23.
  function parseReference(key) {
    const index = key.indexOf('#');
    if (index < 0) return { base: key, path: undefined };
    const base = key.slice(0, index), path = key.slice(index + 1);
    pointerParts(path);
    return { base, path };
  }
  function resolveReference(key, values, nodeName = '') {
    const { base, path } = parseReference(key);
    if (!values.has(base)) throw Error('「' + nodeName + '」引用的变量不可用：{{' + key + '}}，请选择当前节点的上游变量');
    const text = values.get(base);
    if (path === undefined) return text;
    let value;
    try { value = JSON.parse(text); } catch { throw Error('「' + nodeName + '」引用的变量不是有效 JSON：{{' + key + '}}'); }
    return readPointer(value, path);
  }
  function referenceText(value) {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  function interpolate(template, values, nodeName = '', transform = value => value) {
    const result = String(template).replace(/\{\{([\s\S]*?)\}\}/g, (_, key) => transform(referenceText(resolveReference(key.trim(), values, nodeName))));
    if (result.length > 100000) throw Error('「' + nodeName + '」的内容过长，请减少模板或输入长度');
    return result;
  }
  function validateVariables(flow, nodes, live) {
    for (const n of nodes) {
      if (n.type === 'start') continue;
      const allowed = new Set(getVariables(flow, n.id).map(v => v.token.slice(2, -2)));
      const fields = n.type === 'end' ? ['template'] : ['inputTemplate', ...(['llm', 'agent'].includes(n.type) ? ['prompt', ...(!live ? ['template'] : [])] : []), ...(n.type === 'http' ? (live ? ['url', ...(['POST','PUT','PATCH'].includes(n.config.method) ? ['bodyTemplate'] : [])] : ['template']) : [])];
      for (const field of fields) {
        let templates = [n.config[field] || ''];
        if (field === 'bodyTemplate') {
          // Validate decoded JSON string values, exactly as runtime sees them.
          // Escaped braces/quotes must not bypass the preflight checks.
          try {
            templates = [];
            JSON.stringify(JSON.parse(n.config[field] || '{}'), (key, value) => {
              if (typeof value === 'string') templates.push(value);
              return value;
            });
          } catch { templates = [n.config[field] || '']; } // httpConfig reports invalid JSON.
        }
        for (const key of templates.flatMap(templateTokens)) {
          let base;
          try { base = parseReference(key).base; } catch (error) { error.nodeId = n.id; error.message = '「' + n.name + '」：' + error.message; throw error; }
          if (!allowed.has(base)) { const error = Error('「' + n.name + '」引用的变量不可用：{{' + key + '}}，请选择当前节点的上游变量'); error.nodeId = n.id; throw error; }
        }
      }
    }
  }
  function pointerParts(path) {
    if (typeof path !== 'string' || path.length > 1000 || (path !== '' && !path.startsWith('/')) || /~(?![01])/u.test(path) || path.includes('{{') || path.includes('}}')) throw Error('响应字段路径需使用 /data/items/0/title 格式，~ 和 / 分别写作 ~0 和 ~1');
    const parts = path === '' ? [] : path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw Error('响应中找不到字段：禁止访问原型字段');
    return parts;
  }
  function extractResponse(text, path = '') {
    if (!path) return text;
    let value;
    try { value = JSON.parse(text); } catch { throw Error('响应不是有效 JSON，无法提取指定字段'); }
    return referenceText(readPointer(value, path));
  }
  function readPointer(value, path) {
    for (const part of pointerParts(path)) {
      if (value === null || typeof value !== 'object' || (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(part)) || !Object.hasOwn(value, part)) throw Error('响应中找不到字段：' + path);
      value = value[part];
    }
    return value;
  }
  function httpConfig(config) {
    const method = config.method || 'GET';
    if (!['GET','POST','PUT','PATCH','DELETE'].includes(method)) throw Error('请选择有效的 HTTP 请求方法');
    const template = config.url || '';
    let url;
    try { url = new URL(template.replace(/\{\{[\s\S]*?\}\}/g, 'variable')); } catch { throw Error('请填写完整的 HTTP 请求地址'); }
    const origin = template.match(/^[a-z]+:\/\/[^/?#]+/i)?.[0] || '';
    if (origin.includes('{{')) throw Error('请求地址的协议、主机与端口不能使用变量，请仅在路径或查询参数中引用变量');
    if (url.username || url.password || url.hash || !['https:','http:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw Error('远程工具请使用 HTTPS，本机工具可使用 HTTP；地址不能含内嵌认证或片段');
    const timeoutMs = config.timeoutMs === undefined || config.timeoutMs === '' ? 30000 : Number(config.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw Error('请求超时需为 1000 到 60000 毫秒');
    if (['POST','PUT','PATCH'].includes(method)) {
      try { JSON.parse(config.bodyTemplate || '{}'); } catch { throw Error('请求正文必须是有效 JSON，请把变量放在 JSON 字符串值中'); }
      JSON.stringify(JSON.parse(config.bodyTemplate || '{}'), (key,value) => {
        if (templateTokens(key).length) throw Error('JSON 正文的字段名不能使用变量，请在字符串值中引用变量');
        return value;
      });
    }
    return { method, timeoutMs };
  }
  function resolveJsonBody(template, values, name) {
    // Parse before substitution so quotes/newlines in a variable remain data.
    const parsed = JSON.parse(template || '{}');
    // Walk only template-owned strings. Inserted JSON is data and must never
    // be visited by the templating pass (including strings containing {{...}}).
    function resolve(value) {
      if (typeof value === 'string') {
        const match = value.match(/^\{\{((?:(?!\{\{|\}\})[\s\S])*?)\}\}$/);
        if (match && parseReference(match[1].trim()).path !== undefined) return resolveReference(match[1].trim(), values, name);
        return interpolate(value, values, name);
      }
      if (Array.isArray(value)) return value.map(resolve);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
      return value;
    }
    return JSON.stringify(resolve(parsed));
  }
  function httpRequest(config, values, name) {
    const { method, timeoutMs } = httpConfig(config);
    const url = new URL(interpolate(config.url, values, name, encodeURIComponent)).href;
    const body = ['POST','PUT','PATCH'].includes(method) ? resolveJsonBody(config.bodyTemplate, values, name) : '';
    if (body.length > 100000) throw Error('请求正文过长，请减少输入和正文内容');
    return { url, method, body, timeoutMs, credentialId: config.credentialId || '' };
  }
  function checkSingle(flow, live = false) {
    const starts = flow.nodes.filter(n => n.type === 'start');
    if (starts.length !== 1) throw Error('请保留一个开始节点');
    if (!flow.nodes.some(n => n.type === 'end')) throw Error('请添加结束节点');
    const incremental = { nodes: flow.nodes, edges: [] };
    for (const edge of flow.edges) {
      const error = connectionError(incremental, edge.from, edge.to, edge.branch);
      if (error) throw Error('连线无效：' + error);
      incremental.edges.push(edge);
    }
    const reachable = new Set();
    function check(node) {
      if (reachable.has(node.id)) return;
      reachable.add(node.id);
      if (node.type === 'end') return;
      if (node.type === 'condition' && !node.config.keyword?.trim()) { const error = Error('请设置「' + node.name + '」的判断关键词'); error.nodeId = node.id; throw error; }
      for (const branch of node.type === 'condition' ? ['yes', 'no'] : ['yes']) {
        const edge = flow.edges.find(e => e.from === node.id && e.branch === branch);
        if (!edge) { const error = Error('「' + node.name + '」的' + (node.type === 'condition' ? (branch === 'yes' ? '是' : '否') + '分支' : '输出') + '尚未连接结束路径'); error.nodeId = node.id; throw error; }
        check(flow.nodes.find(n => n.id === edge.to));
      }
    }
    check(starts[0]);
    const nodes = flow.nodes.filter(n => reachable.has(n.id));
    for (const n of nodes) if (n.config.outputType !== undefined && !['text', 'json'].includes(n.config.outputType)) { const error = Error('节点输出类型必须是 text 或 json'); error.nodeId = n.id; throw error; }
    validateVariables(flow, nodes, live);
    for (const n of nodes) if (n.type === 'http') {
      try { pointerParts(n.config.responsePath || ''); if (live) httpConfig(n.config); }
      catch (error) { error.message = '「' + n.name + '」：' + error.message; error.nodeId = n.id; throw error; }
    }
    return { start: starts[0], reachable: nodes };
  }
  function knowledgeConfig(config) {
    if (config.sourceMode !== undefined && !['inline', 'library'].includes(config.sourceMode)) throw Error('知识来源必须是 inline 或 library');
    const topK = Number(config.topK ?? 3);
    if (!Number.isInteger(topK) || topK < 1 || topK > 10) throw Error('检索片段数必须为 1 到 10 的整数');
    return topK;
  }
  function batchConfig(config) {
    const max = config.maxItems === undefined || config.maxItems === '' ? 100 : Number(config.maxItems);
    if (!Number.isInteger(max) || max < 1 || max > 100) throw Error('批处理数量上限必须为 1 到 100 的整数');
    if (config.resultType !== undefined && !['text', 'json'].includes(config.resultType)) throw Error('批处理结果类型必须是 text 或 json');
    if (config.outputType !== undefined && config.outputType !== 'json') throw Error('批处理必须使用 JSON 输出类型');
    return max;
  }
  function batchError(error, node, target, index, path, results) {
    if (!error.detailNodeId) error.detailNodeId = error.nodeId || node.id;
    error.nodeId = node.id;
    if (error.iterationIndex === undefined && index !== undefined) error.iterationIndex = index;
    if (!error.iterationPath) error.iterationPath = path;
    error.completedResults = results.slice();
    error.message = '「' + node.name + '」 → ' + (target?.name || node.config.workflowId || '未选择子工作流') + (index === undefined ? '' : ' 第 ' + (index + 1) + ' 项') + '：' + error.message;
    return error;
  }
  // Validate every reachable child and both condition paths before any side effect.
  function checkExecution(flow, live = false, options = {}) {
    const workflows = options.workflows || [];
    const outputValidators = new Map();
    // Completed subtrees are acyclic. Cache by depth as well as object so a
    // shared workflow is still checked against every remaining depth budget.
    const checked = new Map();
    function visit(current, ancestors, depth) {
      const cached = checked.get(current)?.get(depth);
      if (cached) return cached;
      const plan = checkSingle(current, live);
      for (const n of plan.reachable) {
        try {
          if (n.config.outputSchema !== undefined && (typeof n.config.outputSchema !== 'string' || n.config.outputSchema.length > 50000)) throw Error('JSON 字段规则必须是最多 50000 个字符的文本');
          if ((n.config.outputType === 'json' || n.type === 'batch') && n.config.outputSchema?.trim() && !outputValidators.has(n)) {
            try { outputValidators.set(n, Schema.compile(n.config.outputSchema)); }
            catch (error) { error.message = '「' + n.name + '」JSON 字段规则：' + error.message; throw error; }
          }
          if (n.type === 'knowledge') {
            knowledgeConfig(n.config);
            if (n.config.sourceMode === 'library') {
              if (!n.config.knowledgeId) throw Error('请为知识库节点选择文档库');
              if (!options.invokeKnowledge) throw Error('文档库检索需要异步运行与检索调用器');
              options.validateKnowledge?.(n);
            }
          }
          if (live && ['agent', 'llm'].includes(n.type)) {
            if (!options.invokeModel && options.requireInvokers) throw Error('真实运行缺少模型调用器');
            options.validateModel?.(n);
          }
          if (live && n.type === 'http') {
            if (!options.invokeHttp && options.requireInvokers) throw Error('真实运行缺少 HTTP 调用器');
            options.validateHttp?.(n);
          }
          if (n.type === 'batch') {
            let target;
            try {
              batchConfig(n.config);
              if (ancestors.some(f => f.id && f.id === n.config.workflowId)) throw Error('禁止工作流直接或间接自调用');
              target = workflows.find(f => f.id === n.config.workflowId);
              if (!target) throw Error('找不到引用的子工作流');
              if (ancestors.some(f => f === target || (f.id && f.id === target.id))) throw Error('禁止工作流直接或间接自调用');
              if (depth >= 5) throw Error('子工作流嵌套最多 5 层');
              visit(target, [...ancestors, target], depth + 1);
            } catch (error) { throw batchError(error, n, target, undefined, [], []); }
          }
        } catch (error) { if (!error.nodeId) error.nodeId = n.id; throw error; }
      }
      if (!checked.has(current)) checked.set(current, new Map());
      checked.get(current).set(depth, plan);
      return plan;
    }
    return { ...visit(flow, [flow], 0), outputValidators };
  }
  function* executionSteps(flow, input, live, options, budget, iteration) {
    const start = flow.nodes.find(n => n.type === 'start');
    const logs = [], visited = new Set(), outputs = new Map();
    let current = start, output = input;
    while (current) {
      const node = current, config = node.config;
      try {
      if (++budget.steps > 2000) throw Error('本次运行超过 2000 个节点步骤上限');
      if (visited.has(current.id)) throw Error('检测到循环连接');
      visited.add(current.id);
      const resolve = (template, values) => interpolate(template, values, node.name);
      let values = variableMap(flow, node, output, input, outputs);
      const nodeInput = node.type === 'start' || node.type === 'end' ? output : resolve(config.inputTemplate ?? '{{input}}', values);
      values = variableMap(flow, node, nodeInput, input, outputs);
      const prompt = ['agent', 'llm'].includes(node.type) ? resolve(config.prompt || '', values) : '';
      let request, response;
      if (node.type === 'http' && live) request = httpRequest(config, values, node.name);
      output = nodeInput;
      const requestText = request ? request.method + ' ' + request.url + (request.body ? '\n\n' + request.body : '') : '';
      yield { kind: 'before', node, input: nodeInput, prompt, request: requestText, iteration };
      let branch = 'yes';
      if (node.type === 'agent' || node.type === 'llm') output = live ? yield { kind: 'model', node, input: nodeInput, prompt, iteration } : resolve(config.template || '{{input}}', values);
      if (node.type === 'http') {
        response = live ? yield { kind: 'http', node, request, iteration } : { output: resolve(config.template || '', values) };
        output = extractResponse(response.output, config.responsePath || '');
      }
      if (node.type === 'batch') {
        const results = [], target = options.workflows.find(f => f.id === config.workflowId);
        let index;
        let path = iteration?.path || [];
        let context;
        try {
          let items;
          try { items = JSON.parse(nodeInput); } catch { throw Error('批处理输入必须是有效 JSON 数组'); }
          if (!Array.isArray(items)) throw Error('批处理输入必须是 JSON 数组');
          if (items.length > batchConfig(config)) throw Error('批处理数组超过数量上限 ' + batchConfig(config));
          for (index = 0; index < items.length; index++) {
            path = [...(iteration?.path || []), index];
            context = { batchNodeId: iteration?.batchNodeId || node.id, workflowId: target.id, workflowName: target.name, index, total: items.length, path };
            yield { kind: 'iteration-start', ...context };
            const result = yield* executionSteps(target, JSON.stringify({ item: items[index], index, total: items.length }), live, options, budget, context);
            let itemOutput = result.output;
            if (config.resultType === 'json') {
              try { itemOutput = JSON.parse(itemOutput); } catch { const error = Error('子工作流结果不是有效 JSON'); error.nodeId = node.id; throw error; }
            }
            results.push(itemOutput);
            yield { kind: 'iteration-complete', ...context, output: itemOutput };
          }
          output = JSON.stringify(results);
        } catch (error) {
          batchError(error, node, target, index, path, results);
          if (context) yield { kind: 'iteration-error', ...context, error: error.message };
          throw error;
        }
      }
      if (node.type === 'end') output = resolve(config.template || '{{input}}', values);
      if (node.type === 'knowledge') {
        if (config.sourceMode === 'library') {
          response = yield { kind: 'knowledge', node, input: nodeInput, iteration };
          const result = { knowledgeId: config.knowledgeId, knowledgeName: response.knowledgeName, query: nodeInput, hits: response.hits };
          output = config.outputType === 'json' ? JSON.stringify(result) : (response.hits.length ? response.hits.map((hit,i)=>`[${i+1}] ${hit.documentName} · 片段 ${hit.chunkIndex+1}\n${hit.text}`).join('\n\n') : '未找到匹配知识，请调整检索问题或补充文档。');
        } else {
        const words = output.toLowerCase().split(/[\s，。！？、,.;!?]+/).filter(Boolean);
        const lines = (config.content || '').split('\n').filter(Boolean);
        const matches = lines.filter(line => words.some(word => line.toLowerCase().includes(word)));
        output = matches.length ? matches.join('\n') : '未找到匹配知识，请调整输入关键词。';
        }
      }
      if (node.type === 'condition') branch = output.includes(config.keyword) ? 'yes' : 'no';
      if (output.length > 100000) throw Error('输出内容过长，请减少模板或输入长度');
      if (config.outputType === 'json' || node.type === 'batch') {
        let data;
        try { data = JSON.parse(output); } catch { throw Error('「' + node.name + '」声明 JSON 输出，但结果不是有效 JSON'); }
        try { options.outputValidators.get(node)?.(data); }
        catch (error) { error.message = '「' + node.name + '」JSON 字段校验失败：' + error.message; throw error; }
      }
      outputs.set(node.id, output);
      logs.push({ id: node.id, name: node.name, type: node.type, input: nodeInput, prompt, modelId: config.modelId || '', output, outputType: node.type === 'batch' ? 'json' : config.outputType || 'text', branch, ...(node.type === 'knowledge' && config.sourceMode === 'library' ? { knowledgeId: config.knowledgeId, knowledgeName: response.knowledgeName, sources: response.hits } : {}), ...(node.type === 'http' ? { request: requestText, httpStatus: response.status || 0, contentType: response.contentType || '' } : {}), ...(node.type === 'condition' ? { decision: `包含「${config.keyword}」：${branch === 'yes' ? '是' : '否'}` } : {}) });
      yield { kind: 'after', node, log: logs[logs.length - 1], iteration };
      if (node.type === 'end') return { logs, output, skipped: flow.nodes.length - visited.size };
      const next = flow.edges.find(e => e.from === node.id && e.branch === branch);
      current = flow.nodes.find(n => n.id === next.to);
      } catch (error) { if (!error.nodeId) error.nodeId = node.id; throw error; }
    }
    throw Error('流程未到达结束节点');
  }
  function executionPlan(flow, input, options = {}) {
    const { outputValidators } = checkExecution(flow, false, options);
    const steps = executionSteps(flow, input, false, { ...options, outputValidators, workflows: options.workflows || [] }, { steps: 0 });
    let state = steps.next();
    while (!state.done) {
      const step = state.value;
      if (step.kind.startsWith('iteration-')) options.onIteration?.(step);
      else if (step.iteration && ['before', 'after'].includes(step.kind)) options.onIteration?.({ ...step.iteration, kind: step.kind === 'before' ? 'node-start' : 'node-complete', node: step.node, ...(step.kind === 'before' ? { context: { input: step.input, prompt: step.prompt, request: step.request } } : {}), ...(step.log ? { log: step.log } : {}) });
      state = steps.next();
    }
    return state.value;
  }
  async function runFlow(flow, input, options = {}) {
    const abort = () => { if (options.signal?.aborted) { const error = Error('运行已取消'); error.name = 'AbortError'; throw error; } };
    abort();
    const live = !!(options.invokeModel || options.invokeHttp);
    const { outputValidators } = checkExecution(flow, live, { ...options, requireInvokers: true });
    const steps = executionSteps(flow, input, live, { ...options, outputValidators, workflows: options.workflows || [] }, { steps: 0 });
    let state = steps.next();
    while (!state.done) {
      const step = state.value;
      let result;
      try {
        if (step.kind !== 'iteration-error') abort();
        if (step.kind.startsWith('iteration-')) await options.onIteration?.(step);
        if (step.kind === 'before') {
          if (step.iteration) await options.onIteration?.({ ...step.iteration, kind: 'node-start', node: step.node, context: { input: step.input, prompt: step.prompt, request: step.request } });
          else await options.onNodeStart?.(step.node, { input: step.input, prompt: step.prompt, request: step.request });
        }
        if (step.kind === 'model') {
          result = await options.invokeModel(step.node, step.input, options.signal, { prompt: step.prompt, ...(step.iteration ? { iteration: step.iteration } : {}) });
          if (typeof result !== 'string') throw Error('模型未返回文本结果');
        }
        if (step.kind === 'knowledge') {
          result = await options.invokeKnowledge(step.node, step.input, options.signal);
          if (!result || typeof result.knowledgeName !== 'string' || !Array.isArray(result.hits) || result.hits.length > knowledgeConfig(step.node.config) || result.hits.some(hit=>!hit || typeof hit.documentId!=='string' || typeof hit.documentName!=='string' || typeof hit.chunkId!=='string' || !Number.isInteger(hit.chunkIndex) || hit.chunkIndex<0 || typeof hit.text!=='string' || !Number.isFinite(hit.score))) throw Error('知识库未返回有效的检索结果');
        }
        if (step.kind === 'http') {
          result = await options.invokeHttp(step.node, step.request, options.signal);
          if (!result || typeof result.output !== 'string') throw Error('HTTP 服务未返回文本响应');
        }
        if (step.kind === 'after') {
          if (step.iteration) await options.onIteration?.({ ...step.iteration, kind: 'node-complete', node: step.node, log: step.log });
          else await options.onNode?.(step.log);
        }
        if (step.kind !== 'iteration-error') abort();
      } catch (error) { state = steps.throw(error); continue; }
      state = steps.next(result);
    }
    return state.value;
  }
  const api = { types, uid, makeNode, sample, validateFlow, connectionError, executionPlan, checkExecution, runFlow, getVariables, interpolate, extractResponse, parseReference };
  if (typeof module !== 'undefined') module.exports = api;
  else root.FlowEngine = api;
})(globalThis);

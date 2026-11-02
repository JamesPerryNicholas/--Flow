(() => {
  'use strict';
  const E = FlowEngine, $ = id => document.getElementById(id);
  const paths = {
    grid:'M3 3h6v6H3z M15 3h6v6h-6z M3 15h6v6H3z M15 15h6v6h-6z',
    bot:'M12 3v3 M10 3h4 M5 7h14a2 2 0 0 1 2 2v10H3V9a2 2 0 0 1 2-2 M8 12v2 M16 12v2 M9 17h6 M1 11v4 M23 11v4',
    book:'M4 3h7a2 2 0 0 1 2 2v16a4 4 0 0 0-4-2H3V3z M13 5a2 2 0 0 1 2-2h6v16h-4a4 4 0 0 0-4 2',
    globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18 M12 3c-5 5-5 13 0 18',
    workflow:'M3 3h6v6H3z M15 15h6v6h-6z M6 9v9h9 M9 6h9v9',
    sparkles:'m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3L12 3z M20 2v4 M18 4h4',
    help:'M9.1 8a3 3 0 0 1 5.8 1c0 2-3 2-3 4 M12 17h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    plus:'M12 5v14 M5 12h14',minus:'M5 12h14',close:'m6 6 12 12 M18 6 6 18',history:'M3 11a9 9 0 1 1 2.6 7 M3 4v7h7 M12 7v6l4 2',
    download:'M12 3v12 m-5-5 5 5 5-5 M4 15v6h16v-6', upload:'M12 15V3 m-5 5 5-5 5 5 M4 15v6h16v-6',
    save:'M4 3h13l4 4v14H3V3z M7 3v6h9V3 M7 21v-8h10v8',play:'m8 4 12 8-12 8V4z',stop:'M6 6h12v12H6z',
    search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3z m-4 9 3 3 5-6',
    branch:'M6 3v14a3 3 0 1 0 3 3 M6 11h9a3 3 0 0 0 3-3V3 m-3 3 3-3 3 3 M3 6l3-3 3 3',repeat:'m16 3 4 4-4 4 M4 11V7h16 M8 21l-4-4 4-4 M20 13v4H4',
    undo:'M3 10h11a6 6 0 0 1 0 12 M3 10l5-5 M3 10l5 5',redo:'M21 10H10a6 6 0 0 0 0 12 M21 10l-5-5 M21 10l-5 5',
    fit:'M3 9V3h6 M15 3h6v6 M21 15v6h-6 M9 21H3v-6',copy:'M9 9h12v12H9z M5 15H3V3h12v2',trash:'M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',settings:'M4 7h16 M4 17h16 M8 4v6 M16 14v6',chevron:'m9 5 7 7-7 7'
  };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.grid}"/></svg>`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const typeStyle = t => `--type-color:${E.types[t].color};--type-bg:${E.types[t].bg}`;
  const typeIcon = t => `<span class="type-icon" style="${typeStyle(t)}">${icon(E.types[t].icon)}</span>`;
  document.querySelectorAll('[data-icon]').forEach(el => el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)));
  let flows = [], activeId, selected = null, undo = [], redo = [], connecting = null, drag = null, runMode = false, running = false, runToken = 0, saveTimer, toastTimer, lastRunInput = '帮我策划一期关于生活美学的创作内容';
  let storageAvailable = true, hadSavedData = false;
  let models = [], modelsLoaded = false, modelLoadError = '', runKind = 'live', runController = null;
  let knowledgeLibraries = [], knowledgeLoaded = false, knowledgeLoadError = '';
  let runRecord = null, currentRunNode = null, currentRunContext = null, nodeStarted = 0;
  let credentials = [], credentialsLoaded = false, credentialError = '';
  let parentNavigation = [], currentBatchChild = null;
  try {
    const saved = JSON.parse(localStorage.getItem('lingjing-flows-v1') || 'null');
    if (saved) {
      hadSavedData = true;
      if (!Array.isArray(saved.flows) || saved.flows.length > 100) throw Error('无效的本地数据');
      flows = saved.flows.map(f => ({ ...E.validateFlow(f), view: f.view && [f.view.x,f.view.y,f.view.zoom].every(Number.isFinite) && f.view.zoom >= .2 && f.view.zoom <= 2 ? f.view : { x:40,y:60,zoom:1 } }));
      activeId = saved.activeId;
    }
  } catch (error) { console.warn('无法读取本地数据：', error.message); setTimeout(() => toast('本地数据无法读取，已打开示例。原数据未主动清除。'), 300); }
  if (!flows.length) flows = [E.sample()];
  if (!flows.some(f => f.id === activeId)) activeId = flows[0].id;
  const flow = () => flows.find(f => f.id === activeId);
  const node = () => flow().nodes.find(n => n.id === selected);
  function toast(message) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3000); }
  function save(silent = true) {
    clearTimeout(saveTimer);
    try { localStorage.setItem('lingjing-flows-v1', JSON.stringify({ flows, activeId })); storageAvailable = true; $('save-state').textContent = '所有更改已保存在本机'; if (!silent) toast('已保存到当前浏览器'); }
    catch { storageAvailable = false; $('save-state').textContent = '保存失败，请导出工作流备份'; if (!silent) toast('浏览器存储不可用或空间已满，请导出备份'); }
  }
  function persist() { $('save-state').textContent = '正在保存…'; clearTimeout(saveTimer); saveTimer = setTimeout(save, 350); }
  function snapshot() { undo.push(JSON.stringify(flow())); if (undo.length > 60) undo.shift(); redo = []; cancelRun(); updateHistory(); }
  function cancelRun() { if ($('run-input')) lastRunInput=$('run-input').value; runToken++; runController?.abort(); runController=null; const wasRunning = running; running = false; if(runRecord){appendInterruptedNode('cancelled','运行已取消');runStore.finish(runRecord,{status:'cancelled',error:'运行已取消'});runRecord=null;} document.querySelectorAll('.node.running,.node.success,.node.error').forEach(el => el.classList.remove('running','success','error')); if (wasRunning && $('execute')) { $('execute').disabled=false; $('execute').innerHTML=icon('play')+'重新运行'; $('stop-run').hidden=true; $('run-kind').disabled=false; $('run-results')?.insertAdjacentHTML('beforeend',runKind==='live' ? '<p class="field-description">运行已取消。已发送的请求可能产生费用或写入数据。</p>' : '<p class="field-description">模拟运行已取消。</p>'); } }
  function appendInterruptedNode(status,error){$('batch-progress')?.remove();if(!runRecord)return;if(currentBatchChild){const child=currentBatchChild;runStore.append(runRecord,{id:child.node.id,name:child.node.name,type:child.node.type,...child.context,...child.meta,status,error,elapsedMs:Math.max(0,performance.now()-child.started)});currentBatchChild=null;}if(!currentRunNode)return;runStore.append(runRecord,{id:currentRunNode.id,name:currentRunNode.name,type:currentRunNode.type,modelId:currentRunNode.config.modelId||'',...currentRunContext,status,error,elapsedMs:Math.max(0,performance.now()-nodeStarted)});currentRunNode=null;currentRunContext=null;}
  function updateHistory() { $('undo').disabled = !undo.length; $('redo').disabled = !redo.length; }
  function historyAction(reverse) {
    const from = reverse ? redo : undo, to = reverse ? undo : redo;
    if (!from.length) return;
    cancelRun(); to.push(JSON.stringify(flow())); const restored = JSON.parse(from.pop()); flows[flows.findIndex(f => f.id === activeId)] = restored;
    selected = null; connecting = null; runMode = false; render(); persist();
  }
  function renderLibrary() {
    const query = $('search').value.toLowerCase();
    let category = '';
    $('node-list').innerHTML = Object.entries(E.types).filter(([key,t]) => `${key}${t.name}${t.description}`.toLowerCase().includes(query)).map(([key,t]) => {
      let heading = ''; if (category !== t.category) { category = t.category; heading = `<div class="category-title">${category}</div>`; }
      return heading + `<button class="node-library-card" draggable="true" data-type="${key}" title="拖入画布或点击添加${t.name}">${typeIcon(key)}<div><b>${t.name}</b><small>${t.description}</small></div><span class="add-icon">+</span></button>`;
    }).join('') || '<p class="field-description">没有找到匹配的节点</p>';
  }
  function renderFlows() {
    $('flow-list').innerHTML = flows.map(f => `<div class="flow-item ${f.id === activeId ? 'current' : ''}"><button data-flow="${esc(f.id)}">${icon('workflow')}${esc(f.name)}</button><button class="delete-flow" data-delete-flow="${esc(f.id)}" title="删除工作流" aria-label="删除 ${esc(f.name)}">${icon('trash')}</button></div>`).join('');
  }
  function renderNodes() {
    $('node-count').textContent = `${flow().nodes.length} 个节点`;
    $('empty-canvas').hidden = !!flow().nodes.length;
    $('nodes').innerHTML = flow().nodes.map(n => {
      const c = n.config;
      let body = '';
      if (n.type === 'start') body = `<p>工作流从这里开始</p><div class="node-field"><span>输入</span><span class="variable-chip"><em>${c.outputType==='json'?'json':'str'}</em>${esc(c.variable || 'input')}</span></div>`;
      if (n.type === 'agent' || n.type === 'llm') { const m=models.find(m=>m.id===c.modelId); body = `<p>${esc(c.prompt || '点击设置角色与提示词')}</p><div class="node-field"><span class="model-chip">✦ ${esc(m?.name || (c.modelId ? '模型不可用' : '请选择模型'))}</span><span class="variable-chip">${m ? (m.enabled ? '已接入' : '已停用') : '待配置'}</span></div>`; }
      if (n.type === 'agent') { let count = 0; try { count = E.agentConfig({toolNodeIds:c.toolNodeIds}).ids.length; } catch {} if (count) body += `<div class="agent-tools-chip">${count} 个自主工具 · 最多 ${esc(c.maxToolRounds || '4')} 轮</div>`; }
      if (n.type === 'knowledge') { const library=knowledgeLibraries.find(k=>k.id===c.knowledgeId);body=c.sourceMode==='library'?`<p>${esc(library?.name || '选择文档库')}</p><div class="node-field"><span>${library?library.documentCount+' 篇文档':'统一知识库'}</span><span class="variable-chip">Top ${esc(c.topK || '3')}</span></div>`:`<p>${esc(c.content || '点击添加知识内容')}</p><div class="node-field"><span>内联知识</span><span class="variable-chip">${(c.content || '').split('\n').filter(Boolean).length} 条</span></div>`; }
      if (n.type === 'http') body = `<p>${esc(c.url || '点击配置接口地址')}</p><div class="node-field"><span class="http-method">${esc(c.method || 'GET')}</span><span class="variable-chip">${c.credentialId ? esc(credentials.find(v=>v.id===c.credentialId)?.name || '凭据不可用') : '无需认证'}</span></div>`;
      if (n.type === 'batch') body = `<p>${esc(flows.find(f=>f.id===c.workflowId)?.name || '选择单项处理流程')}</p><div class="node-field"><span>逐项执行 · 上限 ${esc(c.maxItems || '100')}</span><span class="variable-chip">JSON 数组</span></div>`;
      if (n.type === 'condition') body = `<p>输入是否包含「${esc(c.keyword || '未设置')}」</p><div class="node-field"><span class="variable-chip">是 → 上方出口</span><span class="variable-chip">否 → 下方出口</span></div>`;
      if (n.type === 'end') body = `<p>返回工作流的执行结果</p><div class="node-field"><span>输出</span><span class="variable-chip"><em>${c.outputType==='json'?'json':'str'}</em>output</span></div>`;
      return `<article class="node ${selected === n.id ? 'selected' : ''}" data-id="${esc(n.id)}" style="left:${n.x}px;top:${n.y}px" tabindex="0" aria-label="${esc(n.name)}节点"><div class="node-header">${typeIcon(n.type)}<b>${esc(n.name)}</b><button class="node-more" title="编辑节点" aria-label="编辑${esc(n.name)}">···</button></div><div class="node-body">${body}</div><div class="node-foot"><span>${E.types[n.type].name}</span><span>${n.type === 'start' ? '起点' : n.type === 'end' ? '终点' : c.outputType==='json'?'JSON 输出':'可配置'}</span></div>${n.type !== 'start' ? `<button class="port in" data-port="in" title="输入连接点" aria-label="输入连接点"></button>` : ''}${n.type !== 'end' ? `<button class="port out ${connecting?.id === n.id && connecting.branch === 'yes' ? 'connecting' : ''}" data-port="out" data-branch="yes" title="${n.type === 'condition' ? '是分支' : '输出连接点'}" aria-label="输出连接点"></button>` : ''}${n.type === 'condition' ? '<button class="port out branch-port" data-port="out" data-branch="no" title="否分支" aria-label="否分支连接点"></button>' : ''}</article>`;
    }).join('');
    renderEdges(); applyView();
  }
  const portPos = (n, out, branch) => ({ x:n.x + (out ? 240 : 0), y:n.y + (branch === 'no' ? 116 : 78) });
  const curve = (a,b) => { const d = Math.max(65,Math.abs(b.x-a.x)*.45); return `M${a.x},${a.y} C${a.x+d},${a.y} ${b.x-d},${b.y} ${b.x},${b.y}`; };
  function renderEdges(pointer) {
    let markup = flow().edges.map(e => {
      const a = flow().nodes.find(n => n.id === e.from), b = flow().nodes.find(n => n.id === e.to);
      if (!a || !b) return '';
      const p = portPos(a,true,e.branch), q = portPos(b,false), d = curve(p,q);
      return `<g class="edge-group" data-edge="${esc(e.id)}"><title>点击删除连接</title><path class="edge-hit" d="${d}"/><path class="edge-path" d="${d}"/>${a.type === 'condition' ? `<text class="edge-label" x="${p.x+18}" y="${p.y-8}">${e.branch === 'yes' ? '是' : '否'}</text>` : ''}</g>`;
    }).join('');
    for (const agent of flow().nodes.filter(n=>n.type==='agent')) {
      let tools = []; try { tools = E.agentTools(flow(),agent); } catch { continue; }
      for (const tool of tools) {
        const a={x:agent.x+120,y:agent.y+160},b={x:tool.x+120,y:tool.y},mid=(a.y+b.y)/2;
        markup += `<g class="agent-tool-edge" aria-label="${esc(agent.name)}的工具：${esc(tool.name)}"><path d="M${a.x},${a.y} C${a.x},${mid} ${b.x},${mid} ${b.x},${b.y}"/><text x="${(a.x+b.x)/2}" y="${mid-8}">工具</text></g>`;
      }
    }
    if (connecting && pointer) { const n = flow().nodes.find(n => n.id === connecting.id); if (n) markup += `<path class="edge-path" style="stroke:#7268e3;stroke-dasharray:5 4" d="${curve(portPos(n,true,connecting.branch),pointer)}"/>`; }
    $('edges').innerHTML = markup;
  }
  function applyView() {
    const v = flow().view;
    $('world').style.transform = `translate(${v.x}px,${v.y}px) scale(${v.zoom})`;
    $('canvas').style.backgroundSize = `${20*v.zoom}px ${20*v.zoom}px`;
    $('canvas').style.backgroundPosition = `${v.x}px ${v.y}px`;
    $('zoom-value').textContent = `${Math.round(v.zoom*100)}%`;
    renderMinimap();
  }
  function bounds() {
    const ns = flow().nodes;
    return ns.length ? { x: Math.min(...ns.map(n=>n.x))-40,y:Math.min(...ns.map(n=>n.y))-40,w:Math.max(...ns.map(n=>n.x+240))-Math.min(...ns.map(n=>n.x))+80,h:Math.max(...ns.map(n=>n.y+160))-Math.min(...ns.map(n=>n.y))+80 } : {x:0,y:0,w:900,h:500};
  }
  function renderMinimap() {
    const b = bounds(), s = Math.min(180/b.w,100/b.h), ox = (180-b.w*s)/2, oy = (100-b.h*s)/2;
    const v = flow().view, canvas = $('canvas');
    $('minimap').innerHTML = `<defs><clipPath id="mini-clip"><rect width="180" height="100"/></clipPath></defs><g clip-path="url(#mini-clip)">${flow().nodes.map(n=>`<rect x="${(n.x-b.x)*s+ox}" y="${(n.y-b.y)*s+oy}" width="${240*s}" height="${140*s}" rx="3" fill="${E.types[n.type].bg}" stroke="${E.types[n.type].color}" stroke-width=".7"/>`).join('')}<rect x="${(-v.x/v.zoom-b.x)*s+ox}" y="${(-v.y/v.zoom-b.y)*s+oy}" width="${canvas.clientWidth/v.zoom*s}" height="${canvas.clientHeight/v.zoom*s}" rx="3" fill="#8d82db0b" stroke="#9f98d3" stroke-width=".7"/></g>`;
  }
  function field(label, key, value, textarea = false, description = '', references = false) {
    return `<label class="field"><span>${label}${key === 'prompt' ? '<small>角色设定</small>' : ''}</span>${textarea ? `<textarea data-config="${key}" maxlength="50000">${esc(value)}</textarea>` : `<input data-config="${key}" value="${esc(value)}" maxlength="${key === 'name' ? 100 : 1000}">`}${description ? `<div class="field-description">${description}</div>` : ''}</label>${references ? `<label class="variable-picker"><span>＋ 引用变量</span><select data-insert-variable="${key}" aria-label="向${label}插入变量"><option value="">选择上游变量…</option>${E.getVariables(flow(),selected).map(v=>`<option value="${esc(v.token)}" title="${esc(v.description)}">${esc(v.label)}${v.type==='json'?' · JSON':''}</option>`).join('')}</select></label><button type="button" class="structured-picker-button" data-open-variable="${key}">选择 JSON 字段…</button>` : ''}`;
  }
  function renderSchemaStatus() {
    const status = $('schema-status'), input = $('inspector').querySelector('[data-config="outputSchema"]');
    if (!status || !input) return;
    let message = '未启用字段规则，仅检查 JSON 格式。', invalid = false;
    if (input.value.trim()) {
      try { FlowSchema.compile(input.value); message = '规则有效，执行时将检查实际数据。'; }
      catch (error) { message = error.message; invalid = true; }
    }
    status.textContent = message;
    status.classList.toggle('run-model-error', invalid);
    input.setAttribute('aria-invalid', String(invalid));
    input.setAttribute('aria-describedby', 'schema-status');
  }
  function renderInspector() {
    if (runMode) { renderRun(); return; }
    const n = node();
    if (!n) { $('inspector').innerHTML = `<div class="inspector-heading">节点配置 ${icon('settings')}</div><div class="empty-inspector"><div class="empty-orbit">${icon('workflow')}</div><h3>让每个节点，各司其职</h3><p>选择画布中的节点，<br>在这里配置它的能力与参数。</p></div><div class="inspector-bottom">${icon('shield')} 所有编辑内容自动保存在本机</div>`; return; }
    const c = n.config;
    let content = field('节点名称','name',n.name);
    if (n.type === 'agent' || n.type === 'llm') {
      const current=models.find(m=>m.id===c.modelId), unavailable=c.modelId && (!current || !current.enabled);
      content += `<label class="field"><span>调用模型 <small>统一模型库</small></span><select data-config="modelId" aria-label="调用模型"><option value="">${models.some(m=>m.enabled) ? '请选择模型' : '请先添加模型'}</option>${unavailable ? `<option selected disabled value="${esc(c.modelId)}">${esc(current?.name || '原模型已删除或不在本机')} · 不可用</option>` : ''}${models.filter(m=>m.enabled).map(m=>`<option value="${esc(m.id)}" ${m.id===c.modelId ? 'selected' : ''}>${esc(m.name)} · ${esc(m.model)}</option>`).join('')}</select></label><button class="model-manage-link" data-open-models>＋ 管理与接入模型</button>${modelLoadError ? '<p class="run-model-error">模型配置加载失败，请打开模型管理重试。</p>' : ''}` + field('用户输入','inputTemplate',c.inputTemplate ?? '{{input}}',true,'默认使用上游输出，也可以组合多个上游变量。',true) + field('系统提示词','prompt',c.prompt || '',true,'作为模型的系统提示词发送，支持引用变量。',true) + field('模拟输出模板','template',c.template || '',true,'仅本地模拟使用，{{input}} 为当前节点解析后的用户输入。',true);
    }
    if (n.type === 'agent') {
      let selectedTools = [];
      try { selectedTools = E.agentConfig({toolNodeIds:c.toolNodeIds}).ids; } catch { /* Show invalid draft below. */ }
      const availableTools = flow().nodes.filter(t => t.type === 'knowledge' && t.config.sourceMode === 'library' || t.type === 'http' && (t.config.method || 'GET') === 'GET');
      const missingTools = selectedTools.filter(id => !availableTools.some(t => t.id === id));
      content += '<hr class="section-divider"><div class="section-label">自主工具调用</div><p class="field-description">选择本画布中的知识库或 GET 工具，智能体会按任务自行选择并多次调用。工具无需连接主路径；请给工具起清楚的名称。</p>';
      content += availableTools.length ? '<div class="agent-tool-list">' + availableTools.map(t => `<label class="agent-tool-option"><input type="checkbox" data-agent-tool="${esc(t.id)}" ${selectedTools.includes(t.id) ? 'checked' : ''}><span><b>${esc(t.name)}</b><small>${t.type === 'knowledge' ? '知识库检索' : 'HTTP GET'}</small></span></label>`).join('') + '</div>' : '<p class="field-description">先从左侧添加知识库或 HTTP GET 节点，配置后即可在这里选择。</p>';
      if (missingTools.length) content += '<p class="run-model-error">部分已选工具被删除或类型变更，运行前请清除失效选择。</p><button class="model-manage-link" id="clear-agent-tools">清除全部工具选择</button>';
      content += field('最多工具轮数', 'maxToolRounds', c.maxToolRounds ?? '4', false, '1–10；每次运行最多调用 20 次工具，达到轮数后要求模型直接回答。模拟模式仅使用输出模板。');
      content += '<p class="field-description">工具收到模型生成的 query 文本。工具中的 {{input}} 和 {{start.input}} 都指该 query，不能引用主流程的其他节点。HTTP 查询变量会编码，模型不能更改接口来源。</p>';
    }
    if (n.type === 'knowledge' || n.type === 'condition') content += field('用户输入','inputTemplate',c.inputTemplate ?? '{{input}}',true,'选择用于检索或判断的输入内容。',true);
    if (n.type === 'http') {
      const missing=c.credentialId&&!credentials.some(v=>v.id===c.credentialId);
      content += `<label class="field"><span>请求方法</span><select data-config="method" aria-label="请求方法">${['GET','POST','PUT','PATCH','DELETE'].map(method=>`<option ${method===(c.method||'GET')?'selected':''}>${method}</option>`).join('')}</select></label>`;
      content += field('请求地址','url',c.url||'',true,'远程接口使用 HTTPS；本机可用 HTTP。查询或路径中的变量会自动编码。勿在地址中放密钥。',true);
      content += `<label class="field"><span>工具凭据 <small>服务端加密保存</small></span><select data-config="credentialId" aria-label="工具凭据"><option value="">无需认证</option>${missing?`<option selected disabled value="${esc(c.credentialId)}">原凭据不可用，请重新选择</option>`:''}${credentials.map(v=>`<option value="${esc(v.id)}" ${v.id===c.credentialId?'selected':''}>${esc(v.name)} · ${esc(v.origin)}</option>`).join('')}</select></label><button class="model-manage-link" data-open-credentials>＋ 管理工具凭据</button>${credentialError?'<p class="run-model-error">工具凭据加载失败，请打开凭据管理重试。</p>':''}`;
      content += field('用户输入','inputTemplate',c.inputTemplate??'{{input}}',true,'{{input}} 在请求地址和正文中表示这里解析后的文本。',true);
      if (['POST','PUT','PATCH'].includes(c.method)) content += field('JSON 正文','bodyTemplate',c.bodyTemplate||'{}',true,'把变量放在 JSON 字符串值中，例如 {"query":"{{input}}"}，引号与换行会自动转义。使用“选择 JSON 字段”插入的独立引用保留原始 JSON 类型。',true);
      content += field('响应字段路径','responsePath',c.responsePath||'',false,'留空返回完整响应。填写 /data/items/0/title 可提取 JSON 字段；数组下标从 0 开始。');
      content += field('超时时间（毫秒）','timeoutMs',c.timeoutMs??'30000',false,'1000–60000；失败即停止流程，不自动重试。');
      content += field('模拟响应','template',c.template??'',true,'仅模拟模式使用，不发送请求；同样按响应字段路径提取内容。',true);
    }
    if (n.type === 'knowledge') {
      content += `<label class="field"><span>知识来源</span><select data-config="sourceMode" aria-label="知识来源"><option value="library" ${c.sourceMode==='library'?'selected':''}>文档库 · 分段全文检索</option><option value="inline" ${c.sourceMode!=='library'?'selected':''}>内联文本 · 兼容旧流程</option></select></label>`;
      if(c.sourceMode==='library'){
        const current=knowledgeLibraries.find(k=>k.id===c.knowledgeId);
        content += `<label class="field"><span>选择文档库</span><select data-config="knowledgeId" aria-label="选择文档库"><option value="">请选择文档库</option>${c.knowledgeId&&!current?`<option selected disabled value="${esc(c.knowledgeId)}">原文档库不可用</option>`:''}${knowledgeLibraries.map(k=>`<option value="${esc(k.id)}" ${k.id===c.knowledgeId?'selected':''}>${esc(k.name)} · ${k.documentCount} 篇</option>`).join('')}</select></label><button class="model-manage-link" data-open-knowledge>＋ 管理文档与测试检索</button>${knowledgeLoadError?'<p class="run-model-error">知识库加载失败，请打开知识库管理重试。</p>':''}` + field('返回片段数','topK',c.topK || '3',false,'1–10；按相关性排序，未匹配时返回空结果。');
        content += '<p class="field-description">文本输出包含编号、文档名和片段；JSON 输出包含 hits 数组，可通过字段变量读取。检索使用本地全文索引，模拟模式也会查询文档库。</p>';
      } else content += field('知识内容','content',c.content || '',true,'每行一条知识，使用输入关键词进行本地文本匹配。');
    }
    if (n.type === 'condition') content += field('包含关键词','keyword',c.keyword || '',false,'区分大小写。上方出口为「是」，下方出口为「否」。');
    if (n.type === 'start') content += field('输入显示名称','variable',c.variable || 'input',false,'试运行中的文本为原始输入，下游使用 {{start.input}} 引用。');
    if (n.type === 'end') content += field('输出模板','template',c.template || '{{input}}',true,'可组合原始输入与前面节点的输出。',true);
    if (n.type === 'batch') {
      const child = flows.find(f=>f.id===c.workflowId);
      content += field('数组输入','inputTemplate',c.inputTemplate??'{{input}}',true,'输入必须是 JSON 数组。每一项按顺序执行所选流程，空数组直接输出 []。',true);
      content += `<label class="field"><span>单项处理流程</span><select data-config="workflowId" aria-label="单项处理流程"><option value="">请选择工作流</option>${c.workflowId&&!child?`<option selected disabled value="${esc(c.workflowId)}">原流程已不存在</option>`:''}${flows.filter(f=>f.id!==activeId).map(f=>`<option value="${esc(f.id)}" ${f.id===c.workflowId?'selected':''}>${esc(f.name)}</option>`).join('')}</select></label><div class="batch-flow-actions"><button class="button full" id="open-batch-flow" ${!child?'disabled':''}>编辑单项流程 →</button><button class="model-manage-link" id="new-batch-flow">＋ 新建单项处理流程</button></div><p class="field-description">单项流程收到 JSON：<code>{"item":当前项,"index":从0开始,"total":总数}</code>。用 <code>{{start.input#/item}}</code> 读取当前项。禁止递归引用。</p>`;
      content += field('最大处理项数','maxItems',c.maxItems??'100',false,'1–100；超出上限在执行单项流程前报错。');
      content += `<label class="field"><span>汇总结果类型</span><select data-config="resultType" aria-label="汇总结果类型"><option value="text" ${c.resultType!=='json'?'selected':''}>字符串数组 · 保留单项输出文本</option><option value="json" ${c.resultType==='json'?'selected':''}>JSON 数组 · 解析每项输出</option></select><div class="field-description">输出固定为 JSON 数组；JSON 模式要求每项最终输出是有效 JSON。失败或停止后不再执行后续项。</div></label>`;
    } else content += `<label class="field"><span>${n.type==='start'?'输入类型':'输出类型'}</span><select data-config="outputType" aria-label="${n.type==='start'?'输入类型':'输出类型'}"><option value="text" ${c.outputType!=='json'?'selected':''}>文本 String</option><option value="json" ${c.outputType==='json'?'selected':''}>JSON · 对象、数组或基础值</option></select><div class="field-description">${n.type==='start'?'选择 JSON 后，试运行输入必须是有效 JSON。':'选择 JSON 后会校验实际输出；格式无效时停止，不执行后续节点。模型需通过提示词约定 JSON 格式。'}</div></label>`;
    if (c.outputType === 'json' || n.type === 'batch') {
      content += field('JSON 字段规则（可选）','outputSchema',c.outputSchema || '',true,'填写 JSON Schema。支持 type、properties、required、additionalProperties、items、enum、const 和数值/长度/数量上下限；不支持的关键字会报错。留空仅检查 JSON 格式。') + '<p id="schema-status" class="field-description" role="status"></p><button class="model-manage-link" id="schema-example">填入对象规则示例</button><p class="field-description">切回文本后暂停字段校验并保留规则。规则草稿可保存；运行和发布前检查所有可达分支。</p>';
    }
    $('inspector').innerHTML = `<div class="inspector-heading">节点配置<button class="icon-button" id="close-inspector" title="取消选择" aria-label="取消选择">${icon('close')}</button></div><div class="inspector-content"><div class="inspector-node-title">${typeIcon(n.type)}<div><b>${E.types[n.type].name}</b><small>${E.types[n.type].description}</small></div></div>${content}<hr class="section-divider"><details class="available-variables"><summary class="section-label">${icon('workflow')} ${n.type==='start'?'输出变量':'可引用变量 · '+E.getVariables(flow(),n.id).length}</summary>${n.type==='start'?`<div class="variable-row"><span class="variable-chip">${c.outputType==='json'?'json':'str'}</span><code>start.input</code><span>${c.outputType==='json'?'JSON':'String'}</span></div>`:E.getVariables(flow(),n.id).map(v=>`<div class="available-variable"><b>${esc(v.label)} <span class="variable-value-type">${v.type==='json'?'JSON':'String'}</span></b><code>${esc(v.token)}</code></div>`).join('')}</details><div class="inspector-note">${n.type === 'agent' || n.type === 'llm' ? '✦ 同一个模型可供多个工作流使用。每个智能体和大模型节点可独立选择模型。' : '连接节点后，上游输出会自动作为当前节点的输入。'}</div><div class="inspector-actions"><button class="button" id="duplicate-node">${icon('copy')}复制节点</button><button class="button danger" id="delete-node">${icon('trash')}删除节点</button></div></div>`;
    renderSchemaStatus();
  }
  function render() { $('workflow-name').value = flow().name; const parent=parentNavigation.at(-1),back=$('return-parent');back.hidden=!parent;back.textContent=parent?'← 返回 '+(flows.find(f=>f.id===parent.flowId)?.name||'父流程'):'';renderNodes(); renderInspector(); renderFlows(); updateHistory(); }
  function openFlow(id,nodeId=null) { save();cancelRun();activeId=id;resetSelection();selected=nodeId;render();persist(); }
  function editBatchFlow(create) {
    const n=node();if(n?.type!=='batch')return;
    if(create){
      if(flows.length>=100)return toast('最多保存 100 个工作流');
      const start=E.makeNode('start',40,120),model=E.makeNode('llm',380,120),end=E.makeNode('end',720,120);
      start.config.outputType='json';model.config.inputTemplate='{{start.input#/item}}';model.config.prompt='请处理当前输入。当前为第 {{start.input#/index}} 项（从 0 开始），共 {{start.input#/total}} 项。';model.config.template='已处理：{{input}}';
      if(n.config.resultType==='json'){model.config.inputTemplate='{{start.input}}';model.config.prompt='请处理 JSON 输入中的 item。当前为第 {{start.input#/index}} 项（从 0 开始），共 {{start.input#/total}} 项。只返回有效 JSON。';model.config.template='{{input}}';model.config.outputType='json';end.config.outputType='json';}
      const child={id:E.uid(),name:(flow().name.slice(0,48)+' · 单项处理'),nodes:[start,model,end],edges:[{id:E.uid(),from:start.id,to:model.id,branch:'yes'},{id:E.uid(),from:model.id,to:end.id,branch:'yes'}],view:{x:40,y:60,zoom:1}};
      snapshot();flows.push(child);n.config.workflowId=child.id;
    }
    const child=flows.find(f=>f.id===n.config.workflowId);if(!child)return toast('请先选择单项处理流程');
    parentNavigation.push({flowId:activeId,nodeId:n.id});openFlow(child.id);fit();
  }
  $('return-parent').onclick=()=>{const parent=parentNavigation.pop();if(parent&&flows.some(f=>f.id===parent.flowId))openFlow(parent.flowId,parent.nodeId);else{parentNavigation=[];render();}};
  function select(id) { cancelRun(); selected = id; runMode = false; renderNodes(); renderInspector(); }
  function addNode(type,x,y) {
    if (flow().nodes.length >= 300) { toast('最多支持 300 个节点'); return; }
    snapshot(); const v = flow().view, canvas = $('canvas');
    const n = E.makeNode(type,x ?? (canvas.clientWidth/2-v.x)/v.zoom-120,y ?? (canvas.clientHeight/2-v.y)/v.zoom-65);
    flow().nodes.push(n); selected = n.id; runMode = false; render(); persist(); toast(`已添加${E.types[type].name}节点`);
  }
  function deleteNode() { if (!node()) return; snapshot(); flow().nodes = flow().nodes.filter(n=>n.id!==selected); flow().edges = flow().edges.filter(e=>e.from!==selected && e.to!==selected); selected=null; connecting=null; render(); persist(); }
  function duplicateNode() { const n=node(); if (!n) return; if (flow().nodes.length>=300) return toast('最多支持 300 个节点'); snapshot(); const copy=JSON.parse(JSON.stringify(n)); copy.id=E.uid(); copy.x+=45; copy.y+=55; copy.name=(copy.name.slice(0,90)+' 副本'); flow().nodes.push(copy); selected=copy.id; render(); persist(); }
  function connect(to) {
    if (!connecting) return;
    const {id,branch}=connecting, error=E.connectionError(flow(),id,to,branch);
    connecting=null;
    if (error) { renderNodes(); toast(error); return; }
    snapshot(); flow().edges.push({id:E.uid(),from:id,to,branch}); renderNodes(); persist(); toast('节点已连接');
  }
  function worldPoint(event) { const r=$('canvas').getBoundingClientRect(),v=flow().view; return {x:(event.clientX-r.left-v.x)/v.zoom,y:(event.clientY-r.top-v.y)/v.zoom}; }
  function zoom(factor, point) {
    const v=flow().view,r=$('canvas').getBoundingClientRect(),cx=point ? point.clientX-r.left : r.width/2,cy=point ? point.clientY-r.top : r.height/2;
    const z=Math.min(2,Math.max(.2,v.zoom*factor)); v.x=cx-(cx-v.x)*z/v.zoom; v.y=cy-(cy-v.y)*z/v.zoom; v.zoom=z; applyView(); persist();
  }
  function fit() { const b=bounds(),c=$('canvas'),v=flow().view; v.zoom=Math.min(1.1,Math.max(.2,Math.min((c.clientWidth-90)/b.w,(c.clientHeight-150)/b.h))); v.x=(c.clientWidth-b.w*v.zoom)/2-b.x*v.zoom; v.y=(c.clientHeight-b.h*v.zoom)/2-b.y*v.zoom; applyView(); persist(); }
  $('node-list').addEventListener('click',e=>{ const el=e.target.closest('[data-type]'); if(el) addNode(el.dataset.type); });
  $('node-list').addEventListener('dragstart',e=>{ const el=e.target.closest('[data-type]'); if(el) {e.dataTransfer.setData('application/lingjing-node',el.dataset.type);e.dataTransfer.effectAllowed='copy';} });
  $('canvas').addEventListener('dragover',e=>e.preventDefault());
  $('canvas').addEventListener('drop',e=>{ e.preventDefault(); const t=e.dataTransfer.getData('application/lingjing-node'); if(Object.hasOwn(E.types,t)){const p=worldPoint(e);addNode(t,p.x-120,p.y-25);} });
  $('canvas').addEventListener('pointerdown',e=>{
    if(e.button!==0 && e.button!==1) return;
    if(e.target.closest('[data-edge]')) return;
    const el=e.target.closest('.node'),port=e.target.closest('[data-port]');
    if(port){e.preventDefault();e.stopPropagation(); if(port.dataset.port==='in'){if(connecting)connect(el.dataset.id);else toast('请先从上游节点的右侧出口开始连接');}else{connecting={id:el.dataset.id,branch:port.dataset.branch};drag={kind:'connection',x:e.clientX,y:e.clientY};renderNodes();}return;}
    if(el && e.button===0){e.preventDefault();cancelRun();const n=flow().nodes.find(n=>n.id===el.dataset.id);selected=n.id;runMode=false;renderInspector();document.querySelectorAll('.node').forEach(el=>el.classList.toggle('selected',el.dataset.id===n.id));drag={kind:'node',id:n.id,x:e.clientX,y:e.clientY,startX:n.x,startY:n.y,moved:false};}
    else { if(connecting){connecting=null;renderEdges();}drag={kind:'pan',x:e.clientX,y:e.clientY,startX:flow().view.x,startY:flow().view.y,moved:false};$('canvas').classList.add('panning'); }
    $('canvas').focus({preventScroll:true});
  });
  window.addEventListener('pointermove',e=>{
    if(connecting)renderEdges(worldPoint(e));
    if(!drag)return;
    const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
    if(drag.kind==='node'){
      if(!drag.moved && Math.hypot(dx,dy)>3){snapshot();drag.moved=true;}
      if(drag.moved){const n=flow().nodes.find(n=>n.id===drag.id);if(!n)return;n.x=drag.startX+dx/flow().view.zoom;n.y=drag.startY+dy/flow().view.zoom;const el=document.querySelector(`.node[data-id="${CSS.escape(n.id)}"]`);el.style.left=n.x+'px';el.style.top=n.y+'px';renderEdges();renderMinimap();}
    }else if(drag.kind==='pan'){if(Math.hypot(dx,dy)>3)drag.moved=true;flow().view.x=drag.startX+dx;flow().view.y=drag.startY+dy;applyView();}
  });
  window.addEventListener('pointerup',e=>{
    if(!drag)return;
    if(drag.kind==='connection' && Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>4){const port=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-port="in"]');if(port)connect(port.closest('.node').dataset.id);else{connecting=null;renderNodes();toast('连线已取消，请拖到节点左侧圆点');}}
    if(drag.kind==='pan'&&!drag.moved){cancelRun();selected=null;runMode=false;renderNodes();renderInspector();}
    if(drag.moved)persist();drag=null;$('canvas').classList.remove('panning');
  });
  window.addEventListener('pointercancel',()=>{drag=null;connecting=null;$('canvas').classList.remove('panning');renderNodes();persist();});
  $('canvas').addEventListener('wheel',e=>{e.preventDefault();if(e.ctrlKey||e.metaKey)zoom(Math.exp(-e.deltaY*.003),e);else{flow().view.x-=e.deltaX;flow().view.y-=e.deltaY;applyView();persist();}},{passive:false});
  $('edges').addEventListener('click',e=>{const el=e.target.closest('[data-edge]');if(el){snapshot();flow().edges=flow().edges.filter(edge=>edge.id!==el.dataset.edge);renderEdges();persist();toast('连线已删除，可按 Ctrl+Z 撤销');}});
  $('inspector').addEventListener('focusin',e=>{if(e.target.dataset.config){e.target.dataset.before=e.target.value;}});
  $('inspector').addEventListener('input',e=>{
    const key=e.target.dataset.config,n=node();if(!key||!n||e.target.tagName==='SELECT')return;
    if(e.target.dataset.recorded!=='yes'){snapshot();e.target.dataset.recorded='yes';}
    if(key==='name')n.name=e.target.value;else n.config[key]=e.target.value;
    if(key==='outputSchema')renderSchemaStatus();
    renderNodes();persist();
  });
  $('inspector').addEventListener('focusout',e=>{if(e.target.dataset.config)delete e.target.dataset.recorded;});
  $('inspector').addEventListener('click',e=>{
    if(!e.target.closest('#schema-example'))return;
    const input=$('inspector').querySelector('[data-config="outputSchema"]');
    if(!input)return;
    if(input.value.trim())return toast('请先清空已有规则，再填入示例');
    input.value=JSON.stringify({type:'object',properties:{title:{type:'string',minLength:1},tags:{type:'array',items:{type:'string'}}},required:['title'],additionalProperties:false},null,2);
    input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();
  });
  $('inspector').addEventListener('click',e=>{
    if(e.target.closest('#clear-agent-tools') && node()?.type==='agent'){snapshot();node().config.toolNodeIds='[]';renderInspector();persist();}
  });
  $('inspector').addEventListener('change',e=>{
    if(e.target.dataset.agentTool && node()?.type==='agent'){
      const ids=E.agentConfig({toolNodeIds:node().config.toolNodeIds}).ids.filter(id=>id!==e.target.dataset.agentTool);
      if(e.target.checked)ids.push(e.target.dataset.agentTool);
      if(ids.length>8){e.target.checked=false;return toast('每个智能体最多选择 8 个工具');}
      snapshot();node().config.toolNodeIds=JSON.stringify(ids);renderNodes();persist();
    }
    if(e.target.dataset.insertVariable&&e.target.value){const target=$('inspector').querySelector(`[data-config="${e.target.dataset.insertVariable}"]`);if(target){target.setRangeText(e.target.value,target.selectionStart,target.selectionEnd,'end');target.dispatchEvent(new Event('input',{bubbles:true}));target.focus();}e.target.value='';}
    if(['modelId','credentialId','method','outputType','workflowId','resultType','sourceMode','knowledgeId'].includes(e.target.dataset.config)&&node()){const key=e.target.dataset.config; snapshot();node().config[key]=e.target.value;renderNodes();if(['method','outputType','workflowId','sourceMode'].includes(key))renderInspector();persist();}
    if(e.target.id==='run-kind'){cancelRun();lastRunInput=$('run-input').value;runKind=e.target.value;renderRun();}
  });
  $('inspector').addEventListener('click',e=>{if(e.target.closest('[data-open-models]'))modelManager.open();if(e.target.closest('[data-open-credentials]'))toolCredentials.open();if(e.target.closest('[data-open-knowledge]'))knowledgeManager.open(node()?.config.knowledgeId);if(e.target.closest('#stop-run'))cancelRun();if(e.target.closest('#open-batch-flow'))editBatchFlow(false);if(e.target.closest('#new-batch-flow'))editBatchFlow(true);});
  $('inspector').addEventListener('click',e=>{if(e.target.closest('#close-inspector'))select(null);if(e.target.closest('#duplicate-node'))duplicateNode();if(e.target.closest('#delete-node'))deleteNode();if(e.target.closest('#execute'))execute();if(e.target.closest('#close-run')){cancelRun();runMode=false;renderNodes();renderInspector();}if(e.target.closest('#copy-result')){navigator.clipboard?.writeText($('final-result')?.textContent||'').then(()=>toast('已复制结果')).catch(()=>toast('当前浏览器不支持复制，请手动选择结果'));}});
  $('workflow-name').addEventListener('input',()=>{if($('workflow-name').dataset.recorded!=='yes'){snapshot();$('workflow-name').dataset.recorded='yes';}flow().name=$('workflow-name').value.slice(0,60);renderFlows();persist();});
  $('workflow-name').addEventListener('blur',()=>{delete $('workflow-name').dataset.recorded;flow().name=$('workflow-name').value.trim()||'未命名工作流';$('workflow-name').value=flow().name;renderFlows();persist();});
  $('search').addEventListener('input',renderLibrary);
  document.querySelectorAll('[data-tab]').forEach(el=>el.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(t=>t.classList.toggle('selected',t===el));$('node-library').hidden=el.dataset.tab!=='nodes';$('flow-library').hidden=el.dataset.tab!=='flows';});
  $('flow-list').addEventListener('click',e=>{
    const del=e.target.closest('[data-delete-flow]'),item=e.target.closest('[data-flow]');
    if(del){const dependents=flows.filter(f=>f.id!==del.dataset.deleteFlow&&f.nodes.some(n=>n.type==='batch'&&n.config.workflowId===del.dataset.deleteFlow));if(dependents.length)return toast('请先解除批处理引用：'+dependents.slice(0,3).map(f=>f.name).join('、'));if(!confirm('删除此工作流？此操作无法撤销，请先导出备份。'))return;cancelRun();parentNavigation=[];flows=flows.filter(f=>f.id!==del.dataset.deleteFlow);if(!flows.length)flows=[{id:E.uid(),name:'未命名工作流',nodes:[],edges:[],view:{x:40,y:60,zoom:1}}];if(!flows.some(f=>f.id===activeId))activeId=flows[0].id;resetSelection();render();persist();}
    else if(item){parentNavigation=[];openFlow(item.dataset.flow);}
  });
  function resetSelection(){selected=null;undo=[];redo=[];runMode=false;connecting=null;drag=null;}
  $('new-flow').onclick=()=>{if(flows.length>=100)return toast('最多保存 100 个工作流，请先导出备份');save();cancelRun();parentNavigation=[];const f={id:E.uid(),name:'未命名工作流',nodes:[],edges:[],view:{x:40,y:60,zoom:1}};flows.push(f);activeId=f.id;resetSelection();render();persist();};
  $('import').onclick=()=>$('import-file').click();
  $('import-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>2*1024*1024)throw Error('文件不能超过 2MB');const imported=WorkflowBundle.importBundle(JSON.parse(await file.text()));if(flows.length+imported.flows.length>100)throw Error('导入后将超过 100 个工作流');save();cancelRun();parentNavigation=[];flows.push(...imported.flows);activeId=imported.workflow.id;resetSelection();render();fit();persist();toast('已导入 '+imported.flows.length+' 个工作流（含依赖）');}catch(error){toast('导入失败：'+error.message);}finally{e.target.value='';}};
  $('export').onclick=()=>{try{const data=WorkflowBundle.exportBundle(flow(),flows),blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=(flow().name.replace(/[<>:"/\\|?*]/g,'_')||'workflow')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出工作流及 '+data.dependencies.length+' 个依赖流程');}catch(error){toast('导出失败：'+error.message);}};
  $('save').onclick=()=>save(false);$('undo').onclick=()=>historyAction(false);$('redo').onclick=()=>historyAction(true);$('zoom-in').onclick=()=>zoom(1.2);$('zoom-out').onclick=()=>zoom(1/1.2);$('zoom-value').onclick=()=>zoom(1/flow().view.zoom);$('fit').onclick=fit;$('add-start').onclick=()=>addNode('start');
  $('minimap').onclick=e=>{const b=bounds(),r=$('minimap').getBoundingClientRect(),s=Math.min(180/b.w,100/b.h),ox=(180-b.w*s)/2,oy=(100-b.h*s)/2;const wx=((e.clientX-r.left)*180/r.width-ox)/s+b.x,wy=((e.clientY-r.top)*100/r.height-oy)/s+b.y;flow().view.x=$('canvas').clientWidth/2-wx*flow().view.zoom;flow().view.y=$('canvas').clientHeight/2-wy*flow().view.zoom;applyView();persist();};
  const showHelp=()=>{if(!$('help-dialog').open)$('help-dialog').showModal();};
  ['help','help-nav','shortcuts'].forEach(id=>$(id).onclick=showHelp);document.querySelectorAll('.close-dialog').forEach(el=>el.onclick=()=>$('help-dialog').close());
  $('workspace-nav').onclick=()=>{document.querySelector('[data-tab="flows"]').click();};$('agents-nav').onclick=()=>{document.querySelector('[data-tab="nodes"]').click();$('search').value='智能体';renderLibrary();};
  window.addEventListener('keydown',e=>{
    if($('published-dialog')?.open){if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s')e.preventDefault();return;}
    if($('tool-credentials-dialog')?.open){if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if(!$('credential-save').disabled)$('credential-form').requestSubmit();}return;}
    if($('history-dialog')?.open||$('variable-dialog')?.open)return;
    if($('models-dialog').open){if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();$('model-form').requestSubmit();}return;}
    const editing=e.target.matches('input,textarea,select,[contenteditable=true]');
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();save(false);return;}
    if($('knowledge-dialog').open){if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();(document.activeElement.closest('form')||$('kb-library-form')).requestSubmit();}return;}
    if(editing||$('help-dialog').open)return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();historyAction(e.shiftKey);}
    else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='d'){e.preventDefault();duplicateNode();}
    else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();deleteNode();}
    else if(e.key==='Escape'){connecting=null;select(null);}
    else if(e.key==='?')showHelp();
  });
  function renderRun(){
    const live=runKind==='live';
    $('inspector').innerHTML=`<div class="inspector-heading">试运行<button class="icon-button" id="close-run" aria-label="关闭试运行">${icon('close')}</button></div><div class="inspector-content"><label class="field"><span>运行方式</span><select id="run-kind" class="run-mode-select"><option value="live" ${live?'selected':''}>真实执行 · 调用模型与工具</option><option value="simulation" ${live?'':'selected'}>本地模拟 · 使用输出模板</option></select></label><div class="run-banner ${live?'live':''}">✦ ${live?'真实执行模式<br>向已配置的模型和工具服务发送请求，可能产生费用或写入数据。':'本地模拟模式<br>使用模板验证流程和数据传递，角色提示词不参与生成。'}</div>${live&&!models.some(m=>m.enabled)?'<button class="model-manage-link" data-open-models>＋ 先接入模型，再为节点选择</button>':''}<label class="field"><span>输入内容 <small>${flow().nodes.find(n=>n.type==='start')?.config.outputType==='json'?'JSON':'String'}</small></span><textarea class="run-input" id="run-input" maxlength="10000">${esc(lastRunInput)}</textarea></label><div class="run-controls"><button class="button primary" id="execute">${icon('play')}运行工作流</button><button class="button" id="stop-run" hidden>${icon('stop')}停止</button></div><div id="run-results" aria-live="polite"></div></div>`;
  }
  $('run').onclick=()=>{if(runMode && running)return;runMode=true;renderInspector();};
  function appendRunLog(log,elapsedMs,live,label='') {
    $('run-log')?.insertAdjacentHTML('beforeend',`<details class="log-entry run-node-detail ${label?'batch-child-log':''}"><summary class="log-title">${label?`<span class="batch-log-context">${esc(label)}</span>`:''}${esc(log.name)}<small>${(elapsedMs/1000).toFixed(2)}s · ${live?'执行完成':'模拟完成'}</small></summary><div class="run-io"><b>输入</b><pre>${esc(log.input)}</pre>${log.prompt?`<b>系统提示词</b><pre>${esc(log.prompt)}</pre>`:''}${log.request?`<b>HTTP 请求</b><pre>${esc(log.request)}</pre>`:''}${log.httpStatus?`<b>HTTP 状态</b><pre>${log.httpStatus} · ${esc(log.contentType)}</pre>`:''}<b>输出${log.outputType==='json'?' · JSON':''}</b><pre>${esc(log.output)}</pre>${log.sources?`<div class="knowledge-source-list"><b>检索来源 · ${esc(log.knowledgeName)}</b>${log.sources.length?log.sources.map((h,i)=>`<p>[${i+1}] ${esc(h.documentName)} · 片段 ${h.chunkIndex+1} · 相关分 ${Number(h.score).toFixed(3)}</p>`).join(''):'<p>未匹配到片段</p>'}</div>`:''}${log.agentSteps?.length?`<b>自主工具调用 · ${log.agentSteps.length} 次</b><pre>${esc(FlowHistory.formatAgentSteps(log.agentSteps))}</pre>`:''}${log.decision?`<b>判断结果</b><pre>${esc(log.decision)}</pre>`:''}</div></details>`);
  }
  async function execute(){
    if(running)return;
    lastRunInput=$('run-input').value;
    if(!lastRunInput.trim())return toast('请输入运行内容');
    const results=$('run-results'),live=runKind==='live',executionWorkflows=JSON.parse(JSON.stringify(flows)),executionFlow=executionWorkflows.find(f=>f.id===activeId),childStarts=new Map();
    running=true;const token=++runToken;runController=new AbortController();const signal=runController.signal;
    const recordId=runRecord=runStore.start({flowId:executionFlow.id,flowName:executionFlow.name,mode:runKind,input:lastRunInput});currentRunNode=null;currentRunContext=null;currentBatchChild=null;
    $('execute').disabled=true;$('execute').textContent=live?'正在运行…':'正在模拟…';$('stop-run').hidden=false;$('run-kind').disabled=true;
    results.innerHTML='<div class="run-log" id="run-log"></div>';
    document.querySelectorAll('.node').forEach(el=>el.classList.remove('success','running','error'));
    let currentNode=null;const started=performance.now();
    try {
      const plan=await E.runFlow(executionFlow,lastRunInput,{
        signal,workflows:executionWorkflows,
        validateKnowledge(n){if(!knowledgeLoaded||knowledgeLoadError)throw Error('知识库配置尚未加载，请打开知识库管理重试');const k=knowledgeLibraries.find(k=>k.id===n.config.knowledgeId);if(!k)throw Error(`「${n.name}」引用的文档库不存在，请重新选择`);if(!k.documentCount)throw Error(`文档库「${k.name}」尚无文档`);},
        invokeKnowledge(n,query,signal){return ModelManager.request('/api/knowledge/'+encodeURIComponent(n.config.knowledgeId)+'/search',{method:'POST',body:{query,topK:Number(n.config.topK || 3)},signal});},
        ...(live?{
          validateModel(n){const m=models.find(m=>m.id===n.config.modelId);if(!modelsLoaded||modelLoadError)throw Error('模型配置尚未加载，请打开模型管理重试');if(!m||!m.enabled)throw Error(`请为「${n.name}」选择一个已启用的模型`);},
          invokeAgent(n,input,signal,context){return ModelManager.request('/api/agent',{method:'POST',body:{modelId:n.config.modelId,prompt:context.prompt,input,tools:context.tools,maxToolRounds:n.config.maxToolRounds},signal});},
          async invokeModel(n,input,signal,context){return (await ModelManager.request('/api/chat',{method:'POST',body:{modelId:n.config.modelId,prompt:context.prompt,input},signal})).output;},
          validateHttp(n){if(n.config.credentialId){if(!credentialsLoaded||credentialError)throw Error('工具凭据尚未加载，请打开工具凭据管理重试');const credential=credentials.find(c=>c.id===n.config.credentialId);if(!credential)throw Error(`请为「${n.name}」选择一个可用的工具凭据`);if(new URL(n.config.url.replace(/\{\{[\s\S]*?\}\}/g,'variable')).origin!==credential.origin)throw Error(`「${n.name}」请求来源与凭据绑定来源不一致，请重新选择凭据`);}},
          invokeHttp(n,request,signal){return ModelManager.request('/api/http',{method:'POST',body:request,signal});}
        }:{}),
        async onNodeStart(n,context){currentNode=currentRunNode=n;currentRunContext=context;nodeStarted=performance.now();document.querySelector(`.node[data-id="${CSS.escape(n.id)}"]`)?.classList.add('running');if(!live)await new Promise(resolve=>setTimeout(resolve,180));},
        onNode(log){if(token!==runToken)return;const elapsedMs=Math.max(0,performance.now()-nodeStarted);runStore.append(recordId,{...log,status:'success',elapsedMs});currentRunNode=null;currentRunContext=null;const el=document.querySelector(`.node[data-id="${CSS.escape(log.id)}"]`);el?.classList.remove('running');el?.classList.add('success');for(const step of log.agentSteps || [])if(step.status==='success')document.querySelector(`.node[data-id="${CSS.escape(step.toolNodeId)}"]`)?.classList.add('success');appendRunLog(log,elapsedMs,live);},
        async onIteration(event){
          if(token!==runToken)return;
          const {batchNodeId,workflowId,workflowName,index,total,path}=event,meta={batchNodeId,workflowId,workflowName,iterationIndex:index,iterationTotal:total,iterationPath:path};
          const key=JSON.stringify([workflowId,path,event.node?.id]);
          if(event.kind==='iteration-start'){
            let progress=$('batch-progress');if(!progress){progress=document.createElement('div');progress.id='batch-progress';progress.className='batch-progress';results.prepend(progress);}progress.textContent=`${workflowName} · 第 ${path.map(i=>i+1).join(' / ')} 项 · 本层共 ${total} 项`;
          } else if(event.kind==='node-start'){
            currentBatchChild={node:event.node,context:event.context,meta,started:performance.now()};childStarts.set(key,currentBatchChild);
            if(!live)await new Promise(resolve=>setTimeout(resolve,40));
          } else if(event.kind==='node-complete'){
            const child=childStarts.get(key),elapsedMs=child?Math.max(0,performance.now()-child.started):0;childStarts.delete(key);currentBatchChild=[...childStarts.values()].at(-1)||null;
            runStore.append(recordId,{...event.log,...meta,status:'success',elapsedMs});appendRunLog(event.log,elapsedMs,live,workflowName+' · 第 '+path.map(i=>i+1).join(' / ')+' 项');
          } else if(event.kind==='iteration-error'&&currentBatchChild){
            const child=currentBatchChild;runStore.append(recordId,{id:child.node.id,name:child.node.name,type:child.node.type,...child.context,...child.meta,status:signal.aborted?'cancelled':'error',error:event.error,elapsedMs:Math.max(0,performance.now()-child.started)});currentBatchChild=null;childStarts.clear();
          }
        }
      });
      if(token!==runToken)return;
      const executedIds=new Set(plan.logs.flatMap(log=>[log.id,...(log.agentSteps || []).filter(step=>step.status==='success').map(step=>step.toolNodeId)]));runStore.finish(recordId,{status:'success',output:plan.output,skipped:executionFlow.nodes.filter(n=>!executedIds.has(n.id)).map(n=>n.name)});runRecord=null;
      results.insertAdjacentHTML('beforeend',`<div class="run-summary">✓ ${live?'执行':'模拟'}完成 · ${plan.logs.length} 个主流程节点 · ${((performance.now()-started)/1000).toFixed(1)}s${plan.skipped?' · '+plan.skipped+' 个未执行':''}</div><hr class="section-divider"><div class="section-label">最终输出</div><div class="log-entry"><pre id="final-result">${esc(plan.output)}</pre></div><button class="button full" id="copy-result">${icon('copy')}复制结果</button>`);
    } catch(error) {
      if(token!==runToken)return;
      const preflight=!currentNode;
      if(error.nodeId)currentNode=executionFlow.nodes.find(n=>n.id===error.nodeId)||currentNode;
      if(error.agentSteps){if(currentBatchChild)currentBatchChild.context={...currentBatchChild.context,agentSteps:error.agentSteps};else currentRunContext={...currentRunContext,agentSteps:error.agentSteps};}
      appendInterruptedNode(error.name==='AbortError'?'cancelled':'error',error.message);runStore.finish(recordId,{status:error.name==='AbortError'?'cancelled':'error',error:error.message,failedNodeId:currentNode?.id||''});runRecord=null;
      if(currentNode){const el=document.querySelector(`.node[data-id="${CSS.escape(currentNode.id)}"]`);el?.classList.remove('running');el?.classList.add('error');}
      $('run-log')?.insertAdjacentHTML('beforeend',`<div class="log-entry error"><div class="log-title">${preflight?'运行检查未通过':'运行中断'}</div><pre>${esc(error.name==='AbortError'?'运行已取消':error.message)}</pre></div>`);
    } finally {
      if(token===runToken){currentBatchChild=null;running=false;runController=null;$('batch-progress')?.remove();$('execute').disabled=false;$('execute').innerHTML=icon('play')+'再次运行';$('stop-run').hidden=true;$('run-kind').disabled=false;}
    }
  }
  const runStore=FlowHistory.createStore({getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)},message=>setTimeout(()=>toast(message),0));
  const structuredPicker=StructuredVariables.init({
    getVariables:()=>E.getVariables(flow(),selected),
    getSample(variable){
      const sourceId=variable.nodeId || (variable.token==='{{input}}' ? flow().edges.find(e=>e.to===selected)?.from : flow().nodes.find(n=>n.type==='start')?.id);
      if(!sourceId)return null;
      for(const record of runStore.list(activeId)){
        const log=record.logs.find(log=>log.id===sourceId&&!log.batchNodeId&&log.status==='success');
        if(log&&typeof log.output==='string')return {text:log.output,note:'字段来自 '+new Date(record.startedAt).toLocaleString('zh-CN')+' 的'+(record.mode==='live'?'真实执行':'本地模拟')+'，仅供参考。'};
      }
      return null;
    },
    onInsert(target,token){
      if(!target||target.nodeId!==selected)return;
      const field=$('inspector').querySelector(`[data-config="${target.key}"]`);
      if(!field)return;
      field.setRangeText(token,target.start,target.end,'end');field.dispatchEvent(new Event('input',{bubbles:true}));field.focus();
    }
  });
  $('inspector').addEventListener('click',e=>{
    const button=e.target.closest('[data-open-variable]');if(!button)return;
    const field=$('inspector').querySelector(`[data-config="${button.dataset.openVariable}"]`);
    if(field)structuredPicker.open({nodeId:selected,key:button.dataset.openVariable,start:field.selectionStart,end:field.selectionEnd});
  });
  const runHistory=FlowHistory.mount({store:runStore,getFlowId:()=>activeId,onOpen:cancelRun,onReplay(record){cancelRun();lastRunInput=record.input;runKind=record.mode==='live'?'live':'simulation';runMode=true;renderInspector();toast('已填入历史输入，点击运行后才会执行。');}});
  $('history-open').onclick=()=>runHistory.open();
  const modelManager=ModelManager.init({onOpen:cancelRun,onChange(list,error){models=list;modelsLoaded=!error;modelLoadError=error;renderNodes();if(!runMode)renderInspector();}});
  const toolCredentials=ToolCredentials.init({onOpen:cancelRun,onChange(list,error){credentials=list;credentialsLoaded=!error;credentialError=error;renderNodes();if(!runMode)renderInspector();}});
  const publishedManager=PublishedManager.init({getDraft:()=>({id:flow().id,name:flow().name,nodeCount:flow().nodes.length}),getBundle:()=>WorkflowBundle.exportBundle(flow(),flows),onOpen:cancelRun});
  const knowledgeManager=KnowledgeManager.init({onOpen:cancelRun,onChange(list,error){knowledgeLibraries=list;knowledgeLoaded=!error;knowledgeLoadError=error;renderNodes();if(!runMode)renderInspector();}});
  $('credentials-open').onclick=()=>toolCredentials.open();
  window.addEventListener('beforeunload',()=>{runToken++;runController?.abort();if(storageAvailable)save();});
  new ResizeObserver(()=>applyView()).observe($('canvas'));
  renderLibrary();render();
  if(!hadSavedData)fit();
})();


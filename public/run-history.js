(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FlowHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const KEY = 'lingjing-runs-v1', MAX_CHARS = 950000, MAX_RECORD = 150000;
  const MARK = '\n…[内容过长，已截断]';
  const statuses = ['running', 'success', 'error', 'cancelled', 'interrupted'];
  const strings = ['id', 'name', 'type', 'input', 'output', 'prompt', 'modelId', 'branch', 'decision', 'status', 'error', 'request', 'contentType', 'batchNodeId', 'workflowId', 'workflowName', 'knowledgeId', 'knowledgeName'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  function clip(value, limit = 8000) { return value.length > limit ? value.slice(0, limit) + MARK : value; }
  function cleanLog(value) {
    const log = {};
    if (!value || typeof value !== 'object') return log;
    for (const key of strings) if (typeof value[key] === 'string') log[key] = clip(value[key], ['input', 'output', 'prompt', 'error', 'request'].includes(key) ? 8000 : 200);
    if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) log.httpStatus=value.httpStatus;
    if (['text','json'].includes(value.outputType)) log.outputType=value.outputType;
    if (finite(value.elapsedMs)) log.elapsedMs = value.elapsedMs;
    if (Number.isInteger(value.iterationIndex) && value.iterationIndex >= 0 && value.iterationIndex < 100) log.iterationIndex=value.iterationIndex;
    if (Number.isInteger(value.iterationTotal) && value.iterationTotal >= 1 && value.iterationTotal <= 100) log.iterationTotal=value.iterationTotal;
    if (Array.isArray(value.iterationPath) && value.iterationPath.length <= 5 && value.iterationPath.every(i=>Number.isInteger(i)&&i>=0&&i<100)) log.iterationPath=[...value.iterationPath];
    if (Array.isArray(value.sources)) log.sources=value.sources.slice(0,10).filter(h=>h&&typeof h.documentId==='string'&&typeof h.documentName==='string'&&typeof h.chunkId==='string'&&Number.isInteger(h.chunkIndex)&&h.chunkIndex>=0&&Number.isFinite(h.score)).map(h=>({documentId:clip(h.documentId,200),documentName:clip(h.documentName,200),chunkId:clip(h.chunkId,200),chunkIndex:h.chunkIndex,score:h.score,text:typeof h.text==='string'?clip(h.text,1200):''}));
    return log;
  }
  function createStore(storage, onError) {
    let records = [], blocked = false;
    const listeners = new Set();
    function report(message) { if (typeof onError === 'function') { try { onError(message); } catch (_) { /* Observer must not stop runs. */ } } }
    function trim() {
      const counts = new Map();
      records = records.filter(r => { const count = (counts.get(r.flowId) || 0) + 1; counts.set(r.flowId, count); return count <= 20; }).slice(0, 100);
      for (const r of records) {
        while (r.logs.length && JSON.stringify(r).length > MAX_RECORD) { r.logs.shift(); r.omittedLogs++; }
      }
      while (records.length > 1 && JSON.stringify(records).length > MAX_CHARS) records.pop();
    }
    function persist() {
      trim();
      if (blocked) return;
      try { storage.setItem(KEY, JSON.stringify({ version: 1, savedAt: Date.now(), records })); }
      catch (_) { report('运行历史无法保存到浏览器，本次历史仅保留在内存中。'); }
    }
    function change() { persist(); for (const fn of listeners) { try { fn(); } catch (_) { /* Isolate UI observers. */ } } }
    try {
      const raw = storage.getItem(KEY);
      if (raw !== null && raw !== undefined) {
        if (typeof raw !== 'string' || raw.length > 2000000) throw Error('invalid history');
        const saved = JSON.parse(raw);
        if (!saved || saved.version !== 1 || !Array.isArray(saved.records) || saved.records.length > 100) throw Error('invalid history');
        const seen = new Set();
        records = saved.records.map(r => {
          if (!r || typeof r.id !== 'string' || !r.id || r.id.length > 200 || seen.has(r.id) || typeof r.flowId !== 'string' || !r.flowId || r.flowId.length > 200 || !statuses.includes(r.status) || !finite(r.startedAt) || !Array.isArray(r.logs) || r.logs.length > 100 || (r.status !== 'running' && !finite(r.endedAt))) throw Error('invalid record');
          seen.add(r.id);
          const copy = { id: r.id, flowId: r.flowId, flowName: '', mode: '', input: '', status: r.status, startedAt: r.startedAt, logs: r.logs.map(cleanLog), omittedLogs: finite(r.omittedLogs) ? Math.floor(r.omittedLogs) : 0 };
          for (const key of ['flowName', 'mode', 'input', 'output', 'error', 'failedNodeId']) if (typeof r[key] === 'string') copy[key] = clip(r[key], ['input', 'output', 'error'].includes(key) ? 12000 : 200);
          if (Array.isArray(r.skipped)) copy.skipped = r.skipped.slice(0, 300).filter(x => typeof x === 'string').map(x => clip(x, 200));
          if (finite(r.endedAt)) copy.endedAt = r.endedAt;
          if (finite(r.elapsedMs)) copy.elapsedMs = r.elapsedMs;
          return copy;
        });
        // The last observed activity is the only known end time after a reload.
        let interrupted = false;
        for (const r of records) if (r.status === 'running') {
          r.status = 'interrupted'; r.endedAt = finite(saved.savedAt) ? Math.max(r.startedAt, saved.savedAt) : r.startedAt;
          r.elapsedMs = r.endedAt - r.startedAt; r.error = '上次页面关闭或刷新，运行已中断；耗时截至最后保存。'; interrupted = true;
        }
        trim();
        if (interrupted) persist();
      }
    } catch (_) { records = []; blocked = true; report('运行历史读取失败或数据已损坏，原始数据已保留；新历史仅保存在内存中。'); }
    return {
      start(value = {}) {
        if (typeof value.flowId !== 'string' || !value.flowId || value.flowId.length > 200) throw Error('工作流 ID 无效');
        const id = globalThis.crypto?.randomUUID?.() || 'run-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
        records.unshift({ id, flowId: value.flowId, flowName: typeof value.flowName === 'string' ? clip(value.flowName, 200) : '', mode: typeof value.mode === 'string' ? clip(value.mode, 200) : '', input: typeof value.input === 'string' ? clip(value.input, 12000) : '', status: 'running', startedAt: Date.now(), logs: [], omittedLogs: 0 });
        change(); return id;
      },
      append(id, log) {
        const r = records.find(r => r.id === id && r.status === 'running'); if (!r) return;
        r.logs.push(cleanLog(log));
        if (r.logs.length > 100) { r.logs.shift(); r.omittedLogs++; }
        change();
      },
      finish(id, value = {}) {
        const r = records.find(r => r.id === id && r.status === 'running');
        if (!r || !['success', 'error', 'cancelled'].includes(value.status)) return;
        r.status = value.status; r.endedAt = Date.now(); r.elapsedMs = Math.max(0, r.endedAt - r.startedAt);
        for (const key of ['output', 'error', 'failedNodeId']) if (typeof value[key] === 'string') r[key] = clip(value[key], key === 'failedNodeId' ? 200 : 12000);
        if (Array.isArray(value.skipped)) r.skipped = value.skipped.slice(0, 300).filter(x => typeof x === 'string').map(x => clip(x, 200));
        change();
      },
      list(flowId) { return clone(records.filter(r => r.flowId === flowId)); },
      get(id) { const r = records.find(r => r.id === id); return r ? clone(r) : null; },
      clear(flowId) { records = records.filter(r => r.flowId !== flowId); change(); },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    };
  }
  function mount({ store, getFlowId, onReplay, onOpen }) {
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const dialog = el('dialog', 'history-dialog'); dialog.id = 'history-dialog'; dialog.setAttribute('aria-labelledby', 'history-title');
    const head = el('header', 'history-header'), title = el('h2', '', '运行历史'); title.id = 'history-title';
    const close = el('button', 'history-close'); close.type = 'button'; close.setAttribute('aria-label', '关闭运行历史');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', 'M6 6l12 12M18 6L6 18'); svg.append(path); close.append(svg); close.onclick = () => dialog.close();
    const intro = el('div'); intro.append(title, el('p', '', '输入和输出仅保存在当前浏览器本机，请留意敏感内容。')); head.append(intro, close);
    const toolbar = el('div', 'history-toolbar'), clear = el('button', 'history-clear', '清空当前流程历史'); clear.type = 'button'; toolbar.append(el('span', '', '每个流程保留最近 20 次运行'), clear);
    const body = el('div', 'history-body'), list = el('nav', 'history-list'), detail = el('section', 'history-detail'); list.setAttribute('aria-label', '运行记录'); body.append(list, detail); dialog.append(head, toolbar, body); document.body.append(dialog);
    let selected = null;
    const labels = { running: '运行中', success: '成功', error: '失败', cancelled: '已取消', interrupted: '已中断' };
    const time = n => new Date(n).toLocaleString('zh-CN');
    const duration = n => Number.isFinite(n) ? (n / 1000).toFixed(2) + ' 秒' : '—';
    function block(parent, label, value) { if (value === undefined) return; parent.append(el('h4', '', label), el('pre', '', value)); }
    function render() {
      const rows = store.list(getFlowId()); list.replaceChildren(); detail.replaceChildren(); clear.disabled = !rows.length;
      if (!rows.length) { body.classList.add('is-empty'); detail.append(el('p', 'history-empty', '还没有运行记录。完成一次试运行后，可在这里查看输入与输出。')); return; }
      body.classList.remove('is-empty');
      if (!rows.some(r => r.id === selected)) selected = rows[0].id;
      for (const r of rows) {
        const button = el('button', 'history-record' + (r.id === selected ? ' selected' : '')); button.type = 'button'; button.setAttribute('aria-current', r.id === selected ? 'true' : 'false');
        button.append(el('strong', '', labels[r.status]), el('span', '', time(r.startedAt)), el('small', '', (r.mode === 'live' ? '真实执行' : r.mode === 'simulation' || r.mode === 'mock' ? '本地模拟' : r.mode) + ' · ' + duration(r.elapsedMs)));
        button.onclick = () => { selected = r.id; render(); }; list.append(button);
      }
      const r = rows.find(r => r.id === selected);
      const top = el('div', 'history-detail-top'), replay = el('button', 'history-replay', '将输入用于试运行'); replay.type = 'button'; replay.onclick = () => { if (onReplay) onReplay(clone(r)); dialog.close(); };
      top.append(el('h3', '', r.flowName || '工作流'), replay); detail.append(top, el('p', 'history-meta', labels[r.status] + ' · ' + time(r.startedAt) + (r.endedAt ? ' → ' + time(r.endedAt) : '') + ' · ' + duration(r.elapsedMs)));
      block(detail, '运行输入', r.input);
      if (r.omittedLogs) detail.append(el('p', 'history-warning', '为控制存储大小，较早的 ' + r.omittedLogs + ' 条节点日志已省略。'));
      for (const log of r.logs) {
        const node = el('details', 'history-node'); node.open = log.status === 'error' || log.status === 'cancelled'; node.append(el('summary', '', (log.name || log.id || '节点') + ' · ' + duration(log.elapsedMs) + (log.status ? ' · ' + (labels[log.status] || log.status) : '')));
        if(log.batchNodeId)node.append(el('p','history-meta',(log.workflowName||'单项流程')+' · 第 '+(log.iterationPath?.length?log.iterationPath.map(i=>i+1).join(' / '):String((log.iterationIndex||0)+1))+' 项'+(log.iterationTotal?' · 本层共 '+log.iterationTotal+' 项':'')));
        if(log.sources){block(node,'检索文档库',log.knowledgeName);block(node,'检索来源',log.sources.length?log.sources.map((h,i)=>`[${i+1}] ${h.documentName} · 片段 ${h.chunkIndex+1} · 相关分 ${h.score.toFixed(3)}\n${h.text}`).join('\n\n'):'未匹配到片段');}
        block(node, '输入', log.input); if (log.prompt) block(node, '提示词', log.prompt); if(log.request)block(node,'HTTP 请求',log.request); if(log.httpStatus)block(node,'HTTP 状态',String(log.httpStatus));if(log.contentType)block(node,'响应类型',log.contentType); block(node, log.outputType==='json'?'输出 · JSON':'输出', log.output); block(node, '错误', log.error); block(node, '判断结果', log.decision); if (log.type === 'condition' && log.branch) block(node, '执行分支', log.branch === 'yes' ? '是' : '否'); detail.append(node);
      }
      block(detail, '最终输出', r.output); block(detail, '运行错误', r.error);
      const failedName = r.logs.find(log => log.id === r.failedNodeId && !log.batchNodeId)?.name;
      if (failedName) block(detail, '失败节点', failedName);
      if (r.skipped?.length) block(detail, '未执行节点', r.skipped.join('、'));
    }
    clear.onclick = () => { if (globalThis.confirm('确定清空当前流程的运行历史？此操作无法恢复。')) { store.clear(getFlowId()); render(); } };
    const unsubscribe = store.subscribe(() => { if (dialog.open) render(); });
    return { open() { if (onOpen) onOpen(); selected = null; render(); if (!dialog.open) dialog.showModal(); }, destroy() { unsubscribe(); dialog.remove(); } };
  }
  return { createStore, mount };
});


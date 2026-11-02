const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AppError } = require('./model-store.cjs');
const E = require('../public/engine.js');
const B = require('../public/workflow-bundle.js');
const MAX_BYTES = 10 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));

function cleanBundle(value) {
  try {
    if (!value || value.version !== 2 || !Array.isArray(value.dependencies) || value.dependencies.length > 99) throw Error('发布需要版本 2 的完整工作流包');
    const all = [value.workflow, ...value.dependencies];
    if (all.some(f => !f || typeof f.id !== 'string' || !f.id || f.id.length > 100) || new Set(all.map(f => f.id)).size !== all.length) throw Error('工作流 ID 无效或重复');
    const result = B.exportBundle(value.workflow, all);
    if (result.dependencies.length !== value.dependencies.length) throw Error('包含无关依赖流程');
    for (const f of [result.workflow, ...result.dependencies]) for (const n of f.nodes) delete n.config.model;
    return clone(result);
  } catch (error) { throw new AppError(400, error.message); }
}
function metadata(row) {
  const flows = [row.bundle.workflow, ...row.bundle.dependencies];
  return { version: row.version, name: flows[0].name, description: row.description, createdAt: row.createdAt,
    inputType: flows[0].nodes.find(n => n.type === 'start')?.config.outputType || 'text',
    nodeCount: flows.reduce((sum, f) => sum + f.nodes.length, 0), workflowCount: flows.length };
}
function summary(app) {
  return { id: app.id, sourceWorkflowId: app.sourceWorkflowId, name: app.versions.at(-1).bundle.workflow.name,
    enabled: app.enabled, latestVersion: app.versions.length, createdAt: app.createdAt, updatedAt: app.updatedAt };
}
const detail = app => ({ ...summary(app), versions: app.versions.map(metadata).reverse() });

function createPublishedStore({ filePath = path.join(__dirname, '..', '.local', 'published.json') } = {}) {
  let apps = [];
  if (fs.existsSync(filePath)) {
    try {
      if (fs.statSync(filePath).size > MAX_BYTES) throw Error();
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.schema !== 1 || !Array.isArray(data.apps) || data.apps.length > 50) throw Error();
      const ids = new Set(), sources = new Set();
      apps = data.apps.map(app => {
        if (!app || typeof app.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(app.id) || ids.has(app.id) || typeof app.sourceWorkflowId !== 'string' || sources.has(app.sourceWorkflowId) || typeof app.enabled !== 'boolean' || !Array.isArray(app.versions) || !app.versions.length || app.versions.length > 20 || !Number.isFinite(Date.parse(app.createdAt)) || !Number.isFinite(Date.parse(app.updatedAt))) throw Error();
        ids.add(app.id); sources.add(app.sourceWorkflowId);
        const versions = app.versions.map((row, i) => {
          if (row.version !== i + 1 || typeof row.description !== 'string' || row.description.length > 500 || !Number.isFinite(Date.parse(row.createdAt))) throw Error();
          const bundle = cleanBundle(row.bundle);
          if (bundle.workflow.id !== app.sourceWorkflowId) throw Error();
          E.checkExecution(bundle.workflow, false, { workflows: bundle.dependencies, invokeKnowledge() {} });
          return { version: row.version, description: row.description, createdAt: row.createdAt, bundle };
        });
        return { id: app.id, sourceWorkflowId: app.sourceWorkflowId, enabled: app.enabled, createdAt: app.createdAt, updatedAt: app.updatedAt, versions };
      });
    } catch { throw new AppError(500, '发布文件读取失败，已拒绝覆盖，请检查本机文件。'); }
  }
  function commit(next) {
    const bytes = JSON.stringify({ schema: 1, apps: next });
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new AppError(400, '发布文件最多 10 MB，请减少工作流内容。');
    const temp = `${filePath}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, filePath);
    } catch { try { fs.unlinkSync(temp); } catch {} throw new AppError(500, '发布文件保存失败。'); }
    apps = next;
  }
  function find(id) { const app = apps.find(a => a.id === id); if (!app) throw new AppError(404, '发布应用不存在。'); return app; }
  return {
    list: () => apps.map(summary),
    get: id => detail(find(id)),
    version(id, version) {
      const row = find(id).versions.find(v => v.version === version);
      if (!row) throw new AppError(404, '发布版本不存在。');
      return metadata(row);
    },
    snapshot(id, version) {
      const app = find(id);
      if (!app.enabled) throw new AppError(409, '该应用已下架。');
      const row = app.versions.find(v => v.version === (version ?? app.versions.length));
      if (!row) throw new AppError(404, '发布版本不存在。');
      return { version: row.version, bundle: clone(row.bundle) };
    },
    setEnabled(id, enabled) {
      if (typeof enabled !== 'boolean') throw new AppError(400, '启用状态必须为布尔值。');
      const app = { ...find(id), enabled, updatedAt: new Date().toISOString() };
      commit(apps.map(a => a.id === id ? app : a)); return detail(app);
    },
    publish(value, description = '', validate) {
      if (typeof description !== 'string' || description.length > 500) throw new AppError(400, '发布说明最多 500 个字符。');
      const bundle = cleanBundle(value);
      try { E.checkExecution(bundle.workflow, false, { workflows: bundle.dependencies, invokeKnowledge() {} }); validate?.(bundle); }
      catch (error) { throw new AppError(400, error.message); }
      const old = apps.find(a => a.sourceWorkflowId === bundle.workflow.id);
      if (!old && apps.length >= 50) throw new AppError(400, '最多发布 50 个应用。');
      if (old?.versions.length >= 20) throw new AppError(400, '每个应用最多发布 20 个版本。');
      const now = new Date().toISOString(), row = { version: (old?.versions.length || 0) + 1, description, createdAt: now, bundle };
      const app = { id: old?.id || randomUUID(), sourceWorkflowId: bundle.workflow.id, enabled: true, createdAt: old?.createdAt || now, updatedAt: now, versions: [...(old?.versions || []), row] };
      commit(old ? apps.map(a => a.id === old.id ? app : a) : [...apps, app]);
      return { app: detail(app), version: metadata(row) };
    },
  };
}
module.exports = { createPublishedStore, cleanBundle };

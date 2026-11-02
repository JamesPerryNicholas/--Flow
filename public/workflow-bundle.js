(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.WorkflowBundle = factory(root.FlowEngine);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';
  // Include drafts as well as reachable nodes, so editing a branch after import is safe.
  function collect(workflow, workflows) {
    const registry = new Map();
    for (const f of workflows) {
      if (registry.has(f.id)) throw Error('工作流 ID 重复，无法打包');
      registry.set(f.id, f);
    }
    registry.set(workflow.id, workflow);
    const result = [], done = new Set(), visiting = new Set();
    function visit(f) {
      if (visiting.has(f.id)) throw Error('批处理流程存在递归引用，请先解除循环');
      if (done.has(f.id)) return;
      visiting.add(f.id);
      const clean = E.validateFlow(f);
      result.push(clean);
      if (result.length > 100) throw Error('工作流包最多包含 100 个流程');
      for (const n of clean.nodes.filter(n => n.type === 'batch')) {
        if (!n.config.workflowId) throw Error('请为「' + n.name + '」选择单项处理流程后再导出');
        const child = registry.get(n.config.workflowId);
        if (!child) throw Error('「' + n.name + '」引用的单项处理流程不存在');
        visit(child);
      }
      visiting.delete(f.id); done.add(f.id);
    }
    visit(workflow);
    return result;
  }
  function exportBundle(workflow, workflows) {
    const all = collect(workflow, workflows);
    return {version: 2, workflow: all[0], dependencies: all.slice(1)};
  }
  function importBundle(value) {
    if (!value || typeof value !== 'object') throw Error('无效的工作流文件');
    const root = E.validateFlow(value.workflow || value);
    if (value.dependencies !== undefined && (!Array.isArray(value.dependencies) || value.dependencies.length > 99)) throw Error('无效的依赖流程列表');
    const all = [root, ...(value.dependencies || []).map(f => E.validateFlow(f))];
    const reachable = collect(root, all);
    if (reachable.length !== all.length) throw Error('工作流包包含无关的依赖流程');
    const ids = new Map(all.map(f => [f.id, E.uid()]));
    for (const f of all) {
      f.id = ids.get(f.id);
      for (const n of f.nodes) if (n.type === 'batch') n.config.workflowId = ids.get(n.config.workflowId);
    }
    return {workflow: root, flows: all};
  }
  return {exportBundle, importBundle};
});

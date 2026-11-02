const {test} = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/engine.js');
const B = require('../public/workflow-bundle.js');
const make = id => ({id,name:id,nodes:[],edges:[],view:{x:0,y:0,zoom:1}});
const link = (f,id) => {const n=E.makeNode('batch',0,0);n.config.workflowId=id;f.nodes.push(n);return n;};

test('bundle exports all transitive draft dependencies once and remaps imports independently',()=>{
  const root=make('root'), child=make('child'), leaf=make('leaf');
  link(root,'child');link(root,'leaf');link(child,'leaf');
  root.secret='must not export';
  const bundle=B.exportBundle(root,[root,child,leaf]);
  assert.equal(bundle.dependencies.length,2);assert.equal(bundle.workflow.secret,undefined);
  const imported=B.importBundle(bundle), again=B.importBundle(bundle);
  assert.equal(imported.flows.length,3);assert.notEqual(imported.workflow.id,root.id);
  assert.notEqual(imported.workflow.id,again.workflow.id);
  assert.equal(imported.workflow.nodes[0].config.workflowId,imported.flows[1].id);
  assert.equal(imported.flows[1].nodes[0].config.workflowId,imported.flows[2].id);
  assert.equal(bundle.workflow.nodes[0].config.workflowId,'child');
});
test('bundle supports legacy single workflow and rejects incomplete or ambiguous packages',()=>{
  const root=make('root'),child=make('child');
  assert.equal(B.importBundle(root).flows.length,1);
  assert.equal(B.importBundle({version:1,workflow:root}).flows.length,1);
  link(root,'child');
  assert.throws(()=>B.exportBundle(root,[root]),/不存在/);
  assert.throws(()=>B.importBundle({workflow:root,dependencies:[child,child]}),/重复/);
  assert.throws(()=>B.importBundle({workflow:make('solo'),dependencies:[child]}),/无关/);
  assert.throws(()=>B.importBundle({workflow:root,dependencies:{}}),/依赖/);
});
test('bundle rejects recursive dependencies without changing original workflows',()=>{
  const a=make('a'),b=make('b');link(a,'b');link(b,'a');
  const before=JSON.stringify([a,b]);
  assert.throws(()=>B.exportBundle(a,[a,b]),/递归/);
  assert.equal(JSON.stringify([a,b]),before);
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/engine.js');
const link = (a,b,branch='yes') => ({id:E.uid(),from:a.id,to:b.id,branch});
function chain(...types) {
  const nodes=['start',...types,'end'].map(t=>E.makeNode(t,0,0));
  return {id:E.uid(),name:'流程',nodes,edges:nodes.slice(1).map((n,i)=>link(nodes[i],n))};
}
function fixture(...childTypes) {
  const root=chain('batch'),child=chain(...childTypes),batch=root.nodes[1];
  root.name='根流程';child.name='子流程';batch.config.workflowId=child.id;
  child.nodes.at(-1).config.template='{{start.input#/item}}';
  return {root,child,batch,options:{workflows:[child]}};
}

test('批处理默认配置、导入白名单及输出变量类型',()=>{
  const {root,batch}=fixture();
  assert.deepEqual(batch.config,{inputTemplate:'{{input}}',workflowId:batch.config.workflowId,maxItems:'100',resultType:'text',outputType:'json'});
  batch.config.secret='secret';
  const imported=E.validateFlow(root).nodes[1];
  assert.equal(imported.config.secret,undefined);assert.equal(imported.config.workflowId,batch.config.workflowId);
  assert.equal(imported.config.resultType,'text');assert.equal(imported.config.maxItems,'100');
  delete batch.config.outputType;
  assert.equal(E.validateFlow(root).nodes[1].config.outputType,'json');
  assert.ok(E.getVariables(root,root.nodes[2].id).filter(v=>v.token!=='{{start.input}}').every(v=>v.type==='json'));
  batch.config.outputType='text';assert.throws(()=>E.validateFlow(root),/JSON 输出/);
});

test('数组项保留原始类型，默认结果为字符串，JSON结果按类型聚合',async()=>{
  const {root,child,batch,options}=fixture();
  const items=['中文',0,false,null,{a:1},[2]],events=[];
  child.nodes.at(-1).config.template='{{input}}';batch.config.resultType='json';
  const result=await E.runFlow(root,JSON.stringify(items),{...options,onIteration:e=>events.push(e)});
  assert.deepEqual(JSON.parse(result.output),items.map((item,index)=>({item,index,total:items.length})));
  child.nodes.at(-1).config.template='{{start.input#/item}}';batch.config.resultType='text';
  assert.deepEqual(JSON.parse(E.executionPlan(root,JSON.stringify(items),options).output),['中文','0','false','null','{"a":1}','[2]']);
  assert.equal(events.filter(e=>e.kind==='iteration-start').length,6);
  assert.equal(events.filter(e=>e.kind==='node-complete').length,12);
  assert.ok(events.every(e=>e.batchNodeId===batch.id&&e.workflowId===child.id));
});

test('空数组不执行子流程，输入和数量限制严格检查',async()=>{
  const {root,options,batch}=fixture('llm');let calls=0;
  assert.equal((await E.runFlow(root,'[]',{...options,invokeModel:async()=>{calls++;return 'x';}})).output,'[]');
  assert.equal(calls,0);
  for(const input of ['{}','null','123','"x"','not-json'])assert.throws(()=>E.executionPlan(root,input,options),/JSON 数组/);
  for(const maxItems of ['0','101','2.5','NaN']){batch.config.maxItems=maxItems;assert.throws(()=>E.executionPlan(root,'[]',options),/1 到 100/);}
  batch.config.maxItems='1';assert.throws(()=>E.executionPlan(root,'[1,2]',options),/数量上限/);
  batch.config.maxItems='';assert.equal(E.executionPlan(root,'[]',options).output,'[]');
  batch.config.resultType='invalid';assert.throws(()=>E.checkExecution(root,false,options),/结果类型/);
});

test('子流程完整顺序执行多个节点、变量及分支，单项上下文隔离',async()=>{
  const {root,child,options}=fixture('llm','llm');const [start,a,b,end]=child.nodes;
  const condition=E.makeNode('condition',0,0),no=E.makeNode('end',0,0);
  condition.config.keyword='first';child.nodes.push(condition,no);
  child.edges=[link(start,a),link(a,b),link(b,condition),link(condition,end),link(condition,no,'no')];
  a.config.inputTemplate='{{start.input#/item}}';
  b.config.inputTemplate='{{nodes.'+a.id+'.output}}';end.config.template='是:{{input}}';no.config.template='否:{{start.input#/item}}';
  const calls=[],roots=[],events=[];
  const result=await E.runFlow(root,'["first","second"]',{...options,invokeModel:async(n,input)=>{calls.push([n.id,input]);return input+'!';},onNodeStart:n=>roots.push(n.id),onIteration:e=>events.push(e)});
  assert.deepEqual(calls,[[a.id,'first'],[b.id,'first!'],[a.id,'second'],[b.id,'second!']]);
  assert.deepEqual(JSON.parse(result.output),['是:first!!','否:second']);
  assert.deepEqual(roots,root.nodes.map(n=>n.id));assert.equal(result.logs.length,3);
  assert.deepEqual(events.filter(e=>e.kind==='iteration-complete').map(e=>e.index),[0,1]);
});

test('嵌套批处理保留最外层batch标识及完整迭代路径，同步异步一致',async()=>{
  const {root,child,batch,options}=fixture('batch');const leaf=chain();leaf.name='叶流程';
  leaf.nodes.at(-1).config.template='{{input}}';child.nodes[1].config.workflowId=leaf.id;
  child.nodes[1].config.inputTemplate='{{start.input#/item}}';child.nodes[1].config.resultType='json';
  child.nodes.at(-1).config.template='{{input}}';batch.config.resultType='json';options.workflows.push(leaf);
  const events=[];
  const asyncResult=await E.runFlow(root,'[[1,2],[3]]',{...options,onIteration:e=>events.push(e)});
  assert.deepEqual(asyncResult,E.executionPlan(root,'[[1,2],[3]]',options));
  assert.deepEqual(JSON.parse(asyncResult.output),[[{item:1,index:0,total:2},{item:2,index:1,total:2}],[{item:3,index:0,total:1}]]);
  assert.ok(events.every(e=>e.batchNodeId===batch.id));
  assert.deepEqual(events.filter(e=>e.kind==='iteration-start').map(e=>e.path),[[0],[0,0],[0,1],[1],[1,0]]);
});

test('缺失引用、直接或间接自调用和超过5层在运行前拒绝',()=>{
  const {root,child,batch,options}=fixture('batch');
  batch.config.workflowId='missing';assert.throws(()=>E.checkExecution(root,false,options),/找不到/);
  batch.config.workflowId=root.id;assert.throws(()=>E.checkExecution(root,false,options),/自调用/);
  batch.config.workflowId=child.id;child.nodes[1].config.workflowId=root.id;
  assert.throws(()=>E.checkExecution(root,false,options),/自调用/);
  let parent=root;options.workflows=[];
  for(let i=0;i<5;i++){const next=chain('batch');options.workflows.push(next);parent.nodes[1].config.workflowId=next.id;parent=next;}
  const leaf=chain();options.workflows.push(leaf);parent.nodes[1].config.workflowId=leaf.id;
  assert.throws(()=>E.checkExecution(root,false,options),/最多 5 层/);
  parent.nodes[1].type='knowledge';parent.nodes[1].config={content:'x'};
  assert.doesNotThrow(()=>E.checkExecution(root,false,options));
});

test('全部可达分支及子流程变量、HTTP配置和模型凭据在任何请求前预检',async()=>{
  for(const problem of ['variable','http','model','branch']) {
    const {root,child,batch,options}=fixture('llm','http');
    const preceding=E.makeNode('llm',0,0);root.nodes.push(preceding);root.edges=[link(root.nodes[0],preceding),link(preceding,batch),link(batch,root.nodes[2])];
    child.nodes[2].config.url='https://example.com';let calls=0,starts=0;
    if(problem==='variable')child.nodes[1].config.prompt='{{missing}}';
    if(problem==='http')child.nodes[2].config.url='invalid';
    if(problem==='branch') {const condition=E.makeNode('condition',0,0);child.nodes.push(condition);child.edges=[link(child.nodes[0],condition),link(condition,child.nodes[1]),link(child.nodes[1],child.nodes[2]),link(child.nodes[2],child.nodes[3])];}
    await assert.rejects(E.runFlow(root,'[]',{...options,invokeModel:async()=>{calls++;return '[]';},invokeHttp:async()=>{calls++;return {output:'x'};},validateModel:n=>{if(problem==='model'&&n.id===child.nodes[1].id)throw Error('缺少凭据');},onNodeStart:()=>starts++}),error=>{assert.equal(error.nodeId,batch.id);return true;});
    assert.equal(calls,0);assert.equal(starts,0);
  }
});

test('错误归因batch并保留已完成进度、明细节点和错误路径，阻止后继',async()=>{
  const {root,child,batch,options}=fixture('llm');batch.config.resultType='json';child.nodes.at(-1).config.template='{{input}}';
  const done=[],events=[];let calls=0;
  await assert.rejects(E.runFlow(root,'[1,2,3]',{...options,invokeModel:async()=>++calls===1?'1':'invalid',onNode:l=>done.push(l),onIteration:e=>events.push(e)}),error=>{
    assert.equal(error.nodeId,batch.id);assert.equal(error.detailNodeId,batch.id);assert.equal(error.iterationIndex,1);assert.deepEqual(error.completedResults,[1]);assert.match(error.message,/子流程 第 2 项/);return true;
  });
  assert.equal(calls,2);assert.equal(done.length,1);assert.equal(events.filter(e=>e.kind==='iteration-complete').length,1);assert.equal(events.at(-1).kind,'iteration-error');
  calls=0;
  await assert.rejects(E.runFlow(root,'[1,2]',{...options,invokeModel:async()=>{calls++;throw Error('失败');}}),error=>{assert.equal(error.detailNodeId,child.nodes[1].id);assert.equal(error.nodeId,batch.id);return true;});assert.equal(calls,1);
});

test('取消共享signal，停止后续项与根后继，并发出迭代错误事件',async()=>{
  const {root,child,batch,options}=fixture('llm');const controller=new AbortController(),events=[],rootDone=[];let calls=0;
  await assert.rejects(E.runFlow(root,'[1,2]',{...options,signal:controller.signal,invokeModel:async(n,input,signal)=>{assert.equal(signal,controller.signal);calls++;controller.abort();return 'x';},onNode:l=>rootDone.push(l),onIteration:e=>events.push(e)}),error=>{assert.equal(error.name,'AbortError');assert.equal(error.nodeId,batch.id);assert.equal(error.detailNodeId,child.nodes[1].id);return true;});
  assert.equal(calls,1);assert.equal(rootDone.length,1);assert.equal(events.at(-1).kind,'iteration-error');
});

test('全次执行共享2000节点上限，嵌套批处理不可放大绕过',()=>{
  const {root,child,options}=fixture('batch');const leaf=chain(...Array(20).fill('llm'));
  child.nodes[1].config.workflowId=leaf.id;child.nodes[1].config.inputTemplate='{{start.input#/item}}';child.nodes.at(-1).config.template='{{input}}';options.workflows.push(leaf);
  const data=JSON.stringify([Array(100).fill('x')]);let completes=0;
  assert.throws(()=>E.executionPlan(root,data,{...options,onIteration:e=>{if(e.kind==='node-complete')completes++;}}),/2000/);
  assert.ok(completes<=2000);
});

test('嵌套失败保留明细节点和迭代路径，节点开始上下文同步异步一致',async()=>{
  const {root,child,batch,options}=fixture('batch');const leaf=chain('llm');leaf.name='叶流程';
  child.nodes[1].config.workflowId=leaf.id;child.nodes[1].config.inputTemplate='{{start.input#/item}}';child.nodes.at(-1).config.template='{{input}}';options.workflows.push(leaf);
  const asyncEvents=[],syncEvents=[];
  await E.runFlow(root,'[[1]]',{...options,onIteration:e=>asyncEvents.push(e)});
  E.executionPlan(root,'[[1]]',{...options,onIteration:e=>syncEvents.push(e)});
  assert.deepEqual(asyncEvents,syncEvents);
  assert.equal(asyncEvents.find(e=>e.kind==='node-start'&&e.node.id===leaf.nodes[1].id).context.input,'{"item":1,"index":0,"total":1}');
  await assert.rejects(E.runFlow(root,'[[1,2]]',{...options,invokeModel:async()=>{throw Error('服务失败');}}),error=>{
    assert.equal(error.nodeId,batch.id);assert.equal(error.detailNodeId,leaf.nodes[1].id);assert.deepEqual(error.iterationPath,[0,0]);assert.match(error.message,/子流程 第 1 项.*叶流程 第 1 项.*服务失败/);return true;
  });
});

test('共享子流程预检按工作流和剩余深度缓存，避免重复展开且不绕过深度限制',()=>{
  const root=chain(...Array(30).fill('batch')),shared=chain('llm'),options={workflows:[shared]};let checks=0;
  root.nodes.filter(n=>n.type==='batch').forEach(n=>n.config.workflowId=shared.id);
  E.checkExecution(root,true,{...options,validateModel:()=>checks++});
  assert.equal(checks,1);
  // First visit the shared subtree at a shallow depth, then reach it at depth 5.
  const head=chain('batch','batch'),subtree=chain('batch'),leaf=chain();
  subtree.nodes[1].config.workflowId=leaf.id;head.nodes[1].config.workflowId=subtree.id;
  const workflows=[subtree,leaf];let parent=head.nodes[2];
  for(let i=0;i<4;i++){const wrapper=chain('batch');workflows.push(wrapper);parent.config.workflowId=wrapper.id;parent=wrapper.nodes[1];}
  parent.config.workflowId=subtree.id;
  assert.throws(()=>E.checkExecution(head,false,{workflows}),/最多 5 层/);
});

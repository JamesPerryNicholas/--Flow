const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('../public/engine.js');
const B=require('../public/workflow-bundle.js');
const link=(a,b,branch='yes')=>({id:E.uid(),from:a.id,to:b.id,branch});
function fixture(){
  const start=E.makeNode('start',0,0),knowledge=E.makeNode('knowledge',1,0),end=E.makeNode('end',2,0);
  knowledge.config.knowledgeId='kb-test';
  return {start,knowledge,end,flow:{id:'f',name:'资料检索',nodes:[start,knowledge,end],edges:[link(start,knowledge),link(knowledge,end)]}};
}
const hit={documentId:'doc1',documentName:'售后 <script>',chunkId:'chunk1',chunkIndex:2,text:'七天内可申请退款。',score:1.25};
const result={knowledgeName:'售后资料',hits:[hit]};
test('文档检索文本输出保留来源，JSON输出可供下游读取字段且无模型调用',async()=>{
  const {flow,knowledge,end}=fixture(),logs=[],calls=[];
  const options={invokeKnowledge:async(n,input,signal)=>{calls.push({id:n.config.knowledgeId,input,signal});return result;},onNode:log=>logs.push(log)};
  const text=await E.runFlow(flow,'退款期限',options);
  assert.match(text.output,/\[1\] 售后 <script> · 片段 3/);assert.match(text.output,/七天/);
  assert.deepEqual(logs[1].sources,[hit]);assert.equal(logs[1].knowledgeId,'kb-test');assert.equal(calls[0].input,'退款期限');
  knowledge.config.outputType='json';end.config.template='{{input#/hits/0/text}}';
  assert.equal((await E.runFlow(flow,'退款',options)).output,hit.text);
});
test('无命中显式返回空结果，导出仅携带知识库引用与检索配置',async()=>{
  const {flow,knowledge}=fixture();
  assert.match((await E.runFlow(flow,'无匹配',{invokeKnowledge:async()=>({knowledgeName:'库',hits:[]})})).output,/未找到/);
  knowledge.config.outputType='json';
  const output=JSON.parse((await E.runFlow(flow,'无匹配',{invokeKnowledge:async()=>({knowledgeName:'库',hits:[]})})).output);
  assert.deepEqual(output.hits,[]);assert.equal(output.query,'无匹配');
  knowledge.config.documents=[{content:'私密正文'}];knowledge.config.apiKey='secret';
  const bundle=B.exportBundle(flow,[flow]);assert.equal(bundle.workflow.nodes[1].config.knowledgeId,'kb-test');
  assert.ok(!JSON.stringify(bundle).includes('私密正文'));assert.ok(!JSON.stringify(bundle).includes('secret'));
});
test('所有可达知识库在首个外部调用前预检，空引用与无调用器明确拒绝',async()=>{
  const {flow,start,knowledge}=fixture(),model=E.makeNode('llm',0,0);model.config.modelId='m';flow.nodes.push(model);flow.edges=[link(start,model),link(model,knowledge),...flow.edges.slice(1)];
  let calls=0;
  await assert.rejects(E.runFlow(flow,'x',{invokeModel:async()=>{calls++;return 'x';},invokeKnowledge:async()=>result,validateKnowledge(){throw Error('文档库不存在');}}),/文档库不存在/);assert.equal(calls,0);
  knowledge.config.knowledgeId='';await assert.rejects(E.runFlow(flow,'x',{invokeModel:async()=>{calls++;return 'x';},invokeKnowledge:async()=>result}),/选择文档库/);assert.equal(calls,0);
  knowledge.config.knowledgeId='kb';assert.throws(()=>E.executionPlan(flow,'x'),/异步运行/);
  for(const config of [{topK:'0'},{topK:'11'},{topK:'x'},{sourceMode:'unknown'}]){Object.assign(knowledge.config,{sourceMode:'library',topK:'3'},config);assert.throws(()=>E.validateFlow(flow));}
});
test('检索失败或取消阻止下游，保留出错节点并传递AbortSignal',async()=>{
  const {flow,knowledge}=fixture(),controller=new AbortController(),logs=[];
  await assert.rejects(E.runFlow(flow,'退款',{signal:controller.signal,invokeKnowledge:async(n,q,signal)=>{assert.equal(signal,controller.signal);controller.abort();return result;},onNode:l=>logs.push(l)}),e=>e.name==='AbortError'&&e.nodeId===knowledge.id);
  assert.deepEqual(logs.map(l=>l.type),['start']);
  await assert.rejects(E.runFlow(flow,'退款',{invokeKnowledge:async()=>{throw Error('存储读取失败');}}),e=>e.nodeId===knowledge.id&&/读取失败/.test(e.message));
  await assert.rejects(E.runFlow(flow,'退款',{invokeKnowledge:async()=>({knowledgeName:'库',hits:[{...hit,score:NaN}]})}),/有效的检索结果/);
});
test('批处理子流程复用知识库，逐项日志包含来源且保持数组顺序',async()=>{
  const child=fixture();child.flow.id='child';child.knowledge.config.inputTemplate='{{start.input#/item}}';
  const root=fixture();root.knowledge.type='batch';root.knowledge.config={workflowId:'child',maxItems:'3',resultType:'text',outputType:'json'};
  const events=[],queries=[];
  const output=await E.runFlow(root.flow,'["退款","配送"]',{workflows:[child.flow],invokeKnowledge:async(n,q)=>{queries.push(q);return {...result,hits:[{...hit,text:q+'资料'}]};},onIteration:e=>events.push(e)});
  assert.deepEqual(queries,['退款','配送']);assert.equal(JSON.parse(output.output).length,2);
  const logs=events.filter(e=>e.kind==='node-complete'&&e.node.type==='knowledge');assert.deepEqual(logs.map(e=>e.index),[0,1]);assert.equal(logs[0].log.sources[0].text,'退款资料');
});

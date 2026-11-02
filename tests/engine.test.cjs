const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/engine.js');
const link = (a,b,branch='yes') => ({id:E.uid(),from:a.id,to:b.id,branch});

test('真实执行按节点传递模型返回值，不使用模拟模板', async () => {
  const f=E.sample(),a=f.nodes[1],b=E.makeNode('llm',0,0),end=f.nodes[2];
  a.config.modelId='writer';b.config.modelId='editor';f.nodes.push(b);f.edges=[link(f.nodes[0],a),link(a,b),link(b,end)];
  end.config.template='最终：{{input}}';const calls=[],events=[];
  const result=await E.runFlow(f,'起始',{validateModel:n=>assert.ok(n.config.modelId),invokeModel:async(n,input)=>{calls.push([n.config.modelId,input]);return input+'→'+n.config.modelId;},onNodeStart:n=>events.push('start:'+n.id),onNode:log=>events.push('end:'+log.id)});
  assert.deepEqual(calls,[['writer','起始'],['editor','起始→writer']]);
  assert.equal(result.output,'最终：起始→writer→editor');assert.equal(events.length,8);
});

test('所有可达分支先检查模型和路径，失败时不发送模型请求', async () => {
  const f=E.sample();let calls=0;
  await assert.rejects(E.runFlow(f,'输入',{validateModel(){throw Error('未选模型');},invokeModel:async()=>{calls++;return '输出';}}),/未选模型/);
  f.edges.pop();
  await assert.rejects(E.runFlow(f,'输入',{invokeModel:async()=>{calls++;return '输出';}}),/尚未连接/);
  assert.equal(calls,0);
});

test('模型失败立即中断，保留已完成节点事件', async () => {
  const f=E.sample(),done=[];
  await assert.rejects(E.runFlow(f,'输入',{invokeModel:async()=>{throw Error('认证失败');},onNode:log=>done.push(log.id)}),/认证失败/);
  assert.deepEqual(done,[f.nodes[0].id]);
});

test('运行取消会传给模型，且不会继续执行后续节点', async () => {
  const f=E.sample(),controller=new AbortController(),done=[];
  await assert.rejects(E.runFlow(f,'输入',{signal:controller.signal,invokeModel:async(n,input,signal)=>{assert.equal(signal,controller.signal);controller.abort();return '延迟结果';},onNode:log=>done.push(log.id)}),{name:'AbortError'});
  assert.deepEqual(done,[f.nodes[0].id]);
});

test('真实模型返回的文本驱动条件分支', async () => {
  const start=E.makeNode('start',0,0),agent=E.makeNode('agent',0,0),condition=E.makeNode('condition',0,0),yes=E.makeNode('end',0,0),no=E.makeNode('end',0,0);
  condition.config.keyword='通过';yes.config.template='已通过';no.config.template='未通过';
  const f={nodes:[start,agent,condition,yes,no],edges:[link(start,agent),link(agent,condition),link(condition,yes),link(condition,no,'no')]};
  assert.equal((await E.runFlow(f,'无关输入',{invokeModel:async()=> '通过'})).output,'已通过');
  assert.equal((await E.runFlow(f,'通过',{invokeModel:async()=> '拒绝'})).output,'未通过');
});

test('异步模拟与同步模拟一致，导入保留模型引用且剔除密钥', async () => {
  const f=E.sample();f.nodes[1].config.modelId='local-model';f.nodes[1].config.apiKey='should-not-import';
  const imported=E.validateFlow(JSON.parse(JSON.stringify(f)));
  assert.equal(imported.nodes[1].config.modelId,'local-model');assert.equal(imported.nodes[1].config.apiKey,undefined);
  assert.deepEqual(await E.runFlow(imported,'输入'),E.executionPlan(imported,'输入'));
});
test('示例从输入执行至结束并正确替换模板', () => {
  const f=E.sample(), result=E.executionPlan(f,'春日创作');
  assert.equal(result.logs.length,3);assert.match(result.output,/春日创作/);assert.equal(result.skipped,0);
});
test('所有节点类型都能创建且默认配置独立', () => {
  for(const type of Object.keys(E.types)){ const a=E.makeNode(type,0,0),b=E.makeNode(type,0,0);assert.notEqual(a.id,b.id);assert.notEqual(a.config,b.config); }
});
test('拒绝自身、反向起点、多输入和重复出口', () => {
  const f=E.sample(),[a,b,c]=f.nodes;
  assert.match(E.connectionError(f,b.id,b.id),/自身/);
  assert.match(E.connectionError(f,b.id,a.id),/开始/);
  assert.match(E.connectionError(f,a.id,c.id),/出口/);
  const d=E.makeNode('llm',0,0);f.nodes.push(d);assert.match(E.connectionError(f,d.id,c.id),/一条输入/);
});
test('禁止创建循环', () => {
  const a=E.makeNode('agent',0,0),b=E.makeNode('llm',0,0),c=E.makeNode('knowledge',0,0);
  const f={nodes:[a,b,c],edges:[link(a,b),link(b,c)]};assert.match(E.connectionError(f,c.id,a.id),/循环/);
});
test('非条件节点不能使用否分支', () => {
  const a=E.makeNode('start',0,0),b=E.makeNode('end',0,0);
  assert.match(E.connectionError({nodes:[a,b],edges:[]},a.id,b.id,'no'),/条件/);
});
test('缺少起点、终点和断开路径会报告错误', () => {
  assert.throws(()=>E.executionPlan({nodes:[],edges:[]},''),/开始/);
  const a=E.makeNode('start',0,0),b=E.makeNode('end',0,0);
  assert.throws(()=>E.executionPlan({nodes:[a],edges:[]},''),/结束/);
  assert.throws(()=>E.executionPlan({nodes:[a,b],edges:[]},''),/尚未连接/);
});
test('条件节点根据关键词执行不同分支，并保留输入', () => {
  const a=E.makeNode('start',0,0),b=E.makeNode('condition',0,0),yes=E.makeNode('end',0,0),no=E.makeNode('end',0,0);
  yes.config.template='是：{{input}}';no.config.template='否：{{input}}';
  const f={nodes:[a,b,yes,no],edges:[link(a,b),link(b,yes),link(b,no,'no')]};
  assert.equal(E.executionPlan(f,'创作').output,'是：创作');assert.equal(E.executionPlan(f,'你好').output,'否：你好');assert.equal(E.executionPlan(f,'你好').skipped,1);
  b.config.keyword='';assert.throws(()=>E.executionPlan(f,'创作'),/关键词/);
});
test('导入验证拒绝错误结构、重复节点和悬空连线', () => {
  assert.throws(()=>E.validateFlow({}));
  let f=E.sample();f.nodes.push(f.nodes[0]);assert.throws(()=>E.validateFlow(f),/重复/);
  f=E.sample();f.edges[0].to='missing';assert.throws(()=>E.validateFlow(f),/连线/);
  f=E.sample();f.nodes[0].x=Infinity;assert.throws(()=>E.validateFlow(f),/节点/);
});
test('JSON 往返后流程执行结果一致', () => {
  const f=E.sample(), restored=E.validateFlow(JSON.parse(JSON.stringify(f)));
  assert.equal(E.executionPlan(restored,'测试输入').output,E.executionPlan(f,'测试输入').output);
});
test('导入的循环图在试运行时被拒绝', () => {
  const f=E.sample(),d=E.makeNode('llm',0,0);f.nodes.push(d);f.edges=[link(f.nodes[0],f.nodes[2]),link(f.nodes[1],d),link(d,f.nodes[1])];
  assert.throws(()=>E.executionPlan(f,'输入'),/循环/);
});
test('知识检索匹配文本并处理无结果', () => {
  const a=E.makeNode('start',0,0),b=E.makeNode('knowledge',0,0),c=E.makeNode('end',0,0);
  b.config={content:'品牌定位：有温度的内容。'}; // 旧版内联知识仍可执行。
  const f={nodes:[a,b,c],edges:[link(a,b),link(b,c)]};
  assert.match(E.executionPlan(f,'品牌').output,/品牌定位/);assert.match(E.executionPlan(f,'完全不匹配').output,/未找到/);
});
test('模板替换不会把输入中的 $ 字符当作替换符', () => {
  const f=E.sample();assert.ok(E.executionPlan(f,'$& $\' $` <script>').output.includes('$& $\' $` <script>'));
});

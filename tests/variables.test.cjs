const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('../public/engine.js');
const link=(a,b,branch='yes')=>({id:E.uid(),from:a.id,to:b.id,branch});
function chain(){const f=E.sample(),second=E.makeNode('llm',0,0);f.nodes.push(second);f.edges=[link(f.nodes[0],f.nodes[1]),link(f.nodes[1],second),link(second,f.nodes[2])];return {f,start:f.nodes[0],a:f.nodes[1],b:second,end:f.nodes[2]};}
const ref=n=>'{{nodes.'+encodeURIComponent(n.id)+'.output}}';

test('组合原始输入与跨节点输出，真实模型收到解析后的输入和提示词',async()=>{
  const {f,a,b,end}=chain();const calls=[];
  b.config.inputTemplate='最初={{start.input}};稿件='+ref(a);b.config.prompt='编辑 {{input}}，主题 {{start.input}}';
  end.config.template='第一稿='+ref(a)+';最终={{input}};原始={{start.input}}';
  const result=await E.runFlow(f,'主题',{invokeModel:async(n,input,signal,context)=>{calls.push({id:n.id,input,prompt:context.prompt});return n.id===a.id?'初稿':'定稿';}});
  assert.equal(calls[1].input,'最初=主题;稿件=初稿');assert.equal(calls[1].prompt,'编辑 最初=主题;稿件=初稿，主题 主题');
  assert.equal(result.output,'第一稿=初稿;最终=定稿;原始=主题');assert.equal(result.logs[2].input,calls[1].input);
});
test('变量选择器只提供祖先，节点改名后引用仍有效，特殊ID不作为属性访问',()=>{
  const {f,a,b}=chain();a.id='__proto__.a {{x}}';f.edges=[link(f.nodes[0],a),link(a,b),link(b,f.nodes[2])];
  a.config.template='初稿';b.config.template=ref(a);a.name='重命名';
  assert.ok(E.getVariables(f,b.id).some(v=>v.nodeId===a.id&&v.label.includes('重命名')));
  assert.ok(!E.getVariables(f,a.id).some(v=>v.nodeId===b.id));assert.equal(E.executionPlan(f,'主题').output,'初稿');
});
test('不存在、自身、未来和未连接的节点引用均在模型调用前失败',async()=>{
  for(const kind of ['missing','self','future','disconnected','unknown']){
    const {f,a,b}=chain(),stray=E.makeNode('llm',0,0);f.nodes.push(stray);
    a.config.prompt=kind==='unknown'?'{{secrets.apiKey}}':kind==='missing'?'{{nodes.deleted.output}}':ref(kind==='self'?a:kind==='future'?b:stray);
    let calls=0;await assert.rejects(E.runFlow(f,'主题',{invokeModel:async()=>{calls++;return '输出';}}),/引用的变量不可用/);assert.equal(calls,0,kind);
  }
});
test('分支不能引用兄弟路径结果，条件输出变量保留实际文本',()=>{
  const start=E.makeNode('start',0,0),condition=E.makeNode('condition',0,0),a=E.makeNode('llm',0,0),b=E.makeNode('end',0,0),end=E.makeNode('end',0,0);
  const f={nodes:[start,condition,a,b,end],edges:[link(start,condition),link(condition,a),link(a,end),link(condition,b,'no')]};
  b.config.template=ref(a);assert.throws(()=>E.executionPlan(f,'你好'),/不可用/);
  b.config.template=ref(condition);const plan=E.executionPlan(f,'你好');assert.equal(plan.output,'你好');assert.match(plan.logs[1].decision,/否/);
});
test('变量替换单次完成，不把上游返回的模板文字再次展开',()=>{
  const {f,a,b}=chain();a.config.template='{{input}}';b.config.inputTemplate='原始={{start.input}};上游='+ref(a);
  b.config.template='{{input}}';assert.equal(E.executionPlan(f,'{{nodes.missing.output}} $&').output,'原始={{nodes.missing.output}} $&;上游={{nodes.missing.output}} $&');
});
test('仅检查当前运行模式使用的模板，旧配置导入兼容并保留输入模板',async()=>{
  const f=E.sample();delete f.nodes[1].config.inputTemplate;f.nodes[1].config.template='{{missing}}';
  assert.equal((await E.runFlow(f,'输入',{invokeModel:async()=> '真实返回'})).output,'真实返回');
  assert.throws(()=>E.executionPlan(f,'输入'),/不可用/);
  f.nodes[1].config.inputTemplate='前缀{{start.input}}';assert.equal(E.validateFlow(f).nodes[1].config.inputTemplate,'前缀{{start.input}}');
});
test('展开后的提示词和输入长度有上限，避免向模型发送膨胀内容',async()=>{
  const f=E.sample();f.nodes[1].config.prompt='{{input}}'.repeat(12);let calls=0;
  await assert.rejects(E.runFlow(f,'长'.repeat(10000),{invokeModel:async()=>{calls++;return '';}}),/内容过长/);assert.equal(calls,0);
});

const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('../public/engine.js');
const link=(a,b,branch='yes')=>({id:E.uid(),from:a.id,to:b.id,branch});
function chain(type='llm') {
  const start=E.makeNode('start',0,0),a=E.makeNode(type,0,0),b=E.makeNode('llm',0,0),end=E.makeNode('end',0,0);
  b.config.template='{{input}}';
  const nodes=[start,a,b,end];
  return {f:{id:E.uid(),name:'结构化变量',nodes,edges:nodes.slice(1).map((n,i)=>link(nodes[i],n))},start,a,b,end};
}
const ref=(n,path='')=>'{{nodes.'+encodeURIComponent(n.id)+'.output#'+path+'}}';
const failureAt=(node,pattern)=>error=>error.nodeId===node.id&&pattern.test(error.message);

test('outputType导入白名单、缺省兼容及变量类型提示',()=>{
  const {f,start,a,b}=chain();start.config.outputType='json';a.config.outputType='json';a.config.secret='移除';
  const imported=E.validateFlow(f);assert.equal(imported.nodes[0].config.outputType,'json');assert.equal(imported.nodes[1].config.secret,undefined);
  assert.equal(imported.nodes[2].config.outputType,undefined);
  const vars=E.getVariables(f,b.id);assert.deepEqual(vars.map(v=>v.type),['json','json','json']);
  assert.ok(vars.every(v=>!v.token.includes('#')));
  assert.equal(E.getVariables(f,a.id)[0].type,'json');assert.deepEqual(E.getVariables(f,start.id),[]);
  for(const value of ['object','',null,0]) {a.config.outputType=value;assert.throws(()=>E.validateFlow(f),/输出类型/);assert.throws(()=>E.checkExecution(f),failureAt(a,/输出类型/));}
});

test('嵌套对象数组路径、整JSON引用、特殊节点ID与RFC6901特殊键',()=>{
  const {f,a,b,end}=chain();a.id='node#part.%';f.edges=[link(f.nodes[0],a),link(a,b),link(b,end)];a.config.outputType='json';
  const data={data:{items:[{title:'标题'}]},'a/b':{'~key':false},'':0,'01':'对象数字键'};a.config.template=JSON.stringify(data);
  b.config.template=[ref(a,'/data/items/0/title'),ref(a,'/a~1b/~0key'),ref(a,'/'),ref(a,'/01'),ref(a)].join('|');
  assert.equal(E.executionPlan(f,'输入').output,'标题|false|0|对象数字键|'+JSON.stringify(data));
  const result=E.executionPlan(f,'输入');assert.equal(result.logs[1].outputType,'json');assert.equal(typeof result.logs[1].output,'string');
});

test('0、false、null、空字符串与缺失字段明确区分，错误归因到引用节点',()=>{
  const {f,a,b}=chain();a.config.template='{"zero":0,"bool":false,"nil":null,"empty":"","items":[1]}';
  b.config.template=['/zero','/bool','/nil','/empty'].map(p=>ref(a,p)).join('|');
  assert.equal(E.executionPlan(f,'输入').output,'0|false|null|');
  for(const path of ['/missing','/nil/x','/items/01','/items/-','/items/length','/items/1']) {
    b.config.template=ref(a,path);assert.throws(()=>E.executionPlan(f,'输入'),failureAt(b,/找不到字段/));
  }
  for(const raw of ['null','false','0','""','[]']) {a.config.template=raw;b.config.template=ref(a);assert.equal(E.executionPlan(f,'输入').output,raw==='""'?'':raw);}
});

test('start与input路径按实际输入解析，输入模板改变后不使用上游缓存',()=>{
  const {f,start,a,b}=chain();start.config.outputType='json';a.config.inputTemplate='{"data":{"answer":false}}';
  a.config.template='{{input#/data/answer}}|{{start.input#/data/answer}}';b.config.template='{{input}}';
  assert.equal(E.executionPlan(f,'{"data":{"answer":0}}').output,'false|0');
  a.config.inputTemplate='普通文本';a.config.template='{{input#}}';assert.throws(()=>E.executionPlan(f,'{}'),failureAt(a,/有效 JSON/));
  a.config.template='{{input}}';assert.throws(()=>E.executionPlan(f,'无效'),failureAt(start,/JSON 输出/));
});

test('所有类型均强制JSON输出合同，失败后不记录成功、不执行后继',async()=>{
  for(const kind of ['start','llm','http','end','knowledge','condition']) {
    const {f,start,a,b,end}=chain(kind==='start'||kind==='end'?'llm':kind);
    const node=kind==='start'?start:kind==='end'?end:a;
    if(kind==='condition') {const noEnd=E.makeNode('end',0,0);f.nodes.push(noEnd);f.edges.push(link(a,noEnd,'no'));}
    node.config.outputType='json';a.config.template='不是JSON';
    if(kind==='http')a.config.url='https://example.com';
    if(kind==='knowledge')a.config.sourceMode='inline';
    const logs=[],starts=[],calls=[];
    await assert.rejects(E.runFlow(f,'不是JSON',{invokeModel:async n=>{calls.push(n.id);return '不是JSON';},invokeHttp:async()=>({output:'不是JSON'}),onNode:log=>logs.push(log),onNodeStart:n=>starts.push(n.id)}),failureAt(node,/JSON 输出/));
    assert.ok(starts.includes(node.id),kind);assert.ok(!logs.some(log=>log.id===node.id),kind);
    if(!['end'].includes(kind))assert.ok(!calls.includes(b.id),kind);
  }
});

test('有效JSON模型输出原样保留在结果与日志，提取后的HTTP输出服从声明',async()=>{
  const {f,a,b,end}=chain('http');a.config.url='https://example.com';a.config.outputType='json';a.config.responsePath='/data';
  b.config.outputType='json';end.config.outputType='json';b.config.inputTemplate=ref(a,'/items');
  let models=0;
  const result=await E.runFlow(f,'输入',{invokeHttp:async()=>({output:'{"data":{"items":[0,false,null]}}'}),invokeModel:async(n,input)=>{models++;assert.equal(input,'[0,false,null]');return ' [0, false, null] ';}});
  assert.equal(result.output,' [0, false, null] ');assert.equal(result.logs[2].output,result.output);assert.equal(models,1);
  await assert.rejects(E.runFlow(f,'输入',{invokeHttp:async()=>({output:'{"data":"不是JSON"}'}),invokeModel:async()=>{throw Error('不应调用');}}),failureAt(a,/JSON 输出/));
});

test('非法路径与原型路径在执行前拒绝，不触发节点或外部调用',async()=>{
  for(const path of ['data.x','/bad~2','/bad~','/__proto__','/constructor/x','/prototype','/nested{{input','/x'.repeat(501)]) {
    const {f,a,b}=chain();b.config.prompt=ref(a,path);let calls=0,starts=0;
    await assert.rejects(E.runFlow(f,'{}',{invokeModel:async()=>{calls++;return '{}';},onNodeStart:()=>starts++}),error=>error.nodeId===b.id);
    assert.equal(calls,0,path);assert.equal(starts,0,path);
  }
  assert.throws(()=>E.parseReference('input#/key}}suffix'),/路径/);
});

test('结构化引用禁止跨分支、未来、自身、缺失来源，均在任何调用前拒绝',async()=>{
  const {f,start,a,b,end}=chain(),condition=E.makeNode('condition',0,0),other=E.makeNode('end',0,0);
  f.nodes.push(condition,other);f.edges=[link(start,condition),link(condition,a),link(a,b),link(b,end),link(condition,other,'no')];
  for(const source of [a,b,other,{id:'missing'}]) {
    other.config.template=ref(source,'/data');let calls=0;
    await assert.rejects(E.runFlow(f,'输入',{invokeModel:async()=>{calls++;return '{}';}}),failureAt(other,/不可用/));assert.equal(calls,0);
  }
});

test('HTTP整字符串结构化引用保留JSON类型，混合插值与旧引用保留文本且安全转义',async()=>{
  const {f,start,a,b}=chain('http');start.config.outputType='json';a.config.method='POST';a.config.url='https://example.com/search?q={{input#/text}}&v={{start.input#/zero}}';
  const data={object:{text:'{{missing}}',nested:[false,null]},array:[0,false,null],zero:0,bool:false,nil:null,empty:'',text:'"},"admin":true\n& /#?'};
  a.config.bodyTemplate=JSON.stringify({object:'{{input#/object}}',array:'{{input#/array}}',zero:'{{input#/zero}}',bool:'{{input#/bool}}',nil:'{{input#/nil}}',empty:'{{input#/empty}}',whole:'{{start.input#}}',mix:'prefix {{input#/object}} {{input#/text}}',legacy:'{{input}}',adjacent:'{{input#/zero}}{{input#/bool}}','__proto__':'safe'});
  await E.runFlow(f,JSON.stringify(data),{invokeHttp:async(n,r)=>{
    const body=JSON.parse(r.body);for(const key of ['object','array','zero','bool','nil','empty'])assert.deepEqual(body[key],data[key]);
    assert.deepEqual(body.whole,data);assert.equal(body.object.text,'{{missing}}');assert.equal(body.legacy,JSON.stringify(data));
    assert.equal(body.mix,'prefix '+JSON.stringify(data.object)+' '+data.text);assert.equal(body.admin,undefined);assert.equal(body.adjacent,'0false');
    assert.equal(r.url,'https://example.com/search?q='+encodeURIComponent(data.text)+'&v=0');return {output:'完成'};
  },invokeModel:async()=> '完成'});
});

test('非JSON或缺失路径与取消均阻止后续模型，保留已完成日志',async()=>{
  for(const mode of ['nonjson','missing','abort']) {
    const {f,a,b}=chain();b.config.prompt=ref(a,'/data');const controller=new AbortController(),logs=[];let calls=0;
    await assert.rejects(E.runFlow(f,'输入',{signal:controller.signal,onNode:log=>logs.push(log),invokeModel:async n=>{
      calls++;if(n.id!==a.id)throw Error('后继不应执行');if(mode==='abort')controller.abort();return mode==='nonjson'?'文本':'{}';
    }}),mode==='abort'?{name:'AbortError'}:failureAt(b,mode==='nonjson'?/有效 JSON/:/找不到字段/));
    assert.equal(calls,1);assert.equal(logs.length,mode==='abort'?1:2);
  }
});

test('interpolate旧Map继续可用，结构化插值仍只执行一遍',()=>{
  assert.equal(E.interpolate('输入={{input}}',new Map([['input','$& {{missing}}']])), '输入=$& {{missing}}');
  assert.equal(E.interpolate('{{input#/x}}',new Map([['input','{"x":"{{missing}}"}']])), '{{missing}}');
});


test('HTTP预检使用解码后的JSON字符串，转义模板不可绕过祖先检查',async()=>{
  const {f,a,b}=chain('http');a.config.url='https://example.com';a.config.method='POST';
  a.config.bodyTemplate='{"value":"'+String.raw`\u007b\u007bnodes.missing.output#/data}}`+'"}';
  let calls=0,starts=0;
  await assert.rejects(E.runFlow(f,'{}',{invokeHttp:async()=>{calls++;return {output:'{}'};},invokeModel:async()=>{calls++;return '{}';},onNodeStart:()=>starts++}),failureAt(a,/不可用/));
  assert.equal(calls,0);assert.equal(starts,0);
});

test('HTTP整值引用允许单个花括号等合法RFC6901键',async()=>{
  const {f,a}=chain('http');a.config.url='https://example.com';a.config.method='POST';
  a.config.bodyTemplate=JSON.stringify({value:'{{input#/a{b}c}}'});
  await E.runFlow(f,'{"a{b}c":{"n":0}}',{invokeHttp:async(n,r)=>{assert.deepEqual(JSON.parse(r.body),{value:{n:0}});return {output:'完成'};},invokeModel:async()=> '完成'});
});

const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('../public/engine.js');
const link=(a,b,branch='yes')=>({id:E.uid(),from:a.id,to:b.id,branch});
function chain(withModel=false){
  const start=E.makeNode('start',0,0),http=E.makeNode('http',300,0),end=E.makeNode('end',900,0);
  http.config.url='https://api.example.com/search?q={{input}}';
  const nodes=[start,http,...(withModel?[E.makeNode('llm',600,0)]:[]),end];
  return {f:{id:E.uid(),name:'HTTP 工具',nodes,edges:nodes.slice(1).map((n,i)=>link(nodes[i],n))},http,start,end,model:nodes[2]};
}

test('HTTP 响应字段传给模型，日志记录实际请求与响应状态',async()=>{
  const {f,http,model}=chain(true),calls=[],started=[];
  http.config.responsePath='/data/items/0/title';model.config.prompt='请总结 {{input}}，用户提问 {{start.input}}';
  const result=await E.runFlow(f,'春季露营&城市',{invokeHttp:async(n,request)=>{calls.push(request);return {output:'{"data":{"items":[{"title":"露营清单"}]}}',status:200,contentType:'application/json'};},invokeModel:async(n,input,signal,context)=>{assert.equal(input,'露营清单');assert.equal(context.prompt,'请总结 露营清单，用户提问 春季露营&城市');return '总结完成';},onNodeStart:(n,c)=>started.push(c)});
  assert.equal(calls[0].url,'https://api.example.com/search?q='+encodeURIComponent('春季露营&城市'));
  assert.equal(calls[0].method,'GET');assert.equal(result.output,'总结完成');
  assert.match(started[1].request,/GET https:/);assert.equal(result.logs[1].httpStatus,200);assert.equal(result.logs[1].contentType,'application/json');
});

test('JSON正文先解析后替换，变量中的引号、换行、模板与对象不会改写请求结构',async()=>{
  const {f,http}=chain(),input='"},"admin":true,"x":"\n{{not-expanded}}';
  http.config.method='POST';http.config.bodyTemplate='{"query":"{{input}}","nested":["{{start.input}}",1,true,null],"__proto__":{"x":"safe"}}';
  let body;
  await E.runFlow(f,input,{invokeHttp:async(n,request)=>{body=JSON.parse(request.body);return {output:'OK',status:201};}});
  assert.equal(body.query,input);assert.deepEqual(body.nested,[input,1,true,null]);assert.equal(body.admin,undefined);assert.equal(Object.hasOwn(body,'__proto__'),true);
});

test('模拟HTTP不依赖URL、凭据或调用器，响应提取同样有效',()=>{
  const {f,http}=chain();http.config.url='';http.config.credentialId='not-configured';http.config.template='{"data":{"answer":"模拟完成"}}';http.config.responsePath='/data/answer';
  assert.equal(E.executionPlan(f,'输入').output,'模拟完成');
});

test('无效方法、正文、变量、动态来源、超时和响应路径均在任何请求前失败',async()=>{
  for (const patch of [{method:'TRACE'},{method:'POST',bodyTemplate:'{broken}'},{method:'POST',bodyTemplate:'{"{{input}}":"value"}'},{url:'https://{{input}}/api'},{url:'http://example.com/api'},{url:'https://user:pass@example.com/'},{url:'https://example.com/#fragment'},{timeoutMs:'999'},{responsePath:'data.x'},{responsePath:'/bad~2'},{url:'https://example.com?q={{missing}}'}]) {
    const {f,http}=chain();Object.assign(http.config,patch);let calls=0;
    await assert.rejects(E.runFlow(f,'输入',{invokeHttp:async()=>{calls++;return {output:'OK'};}}));assert.equal(calls,0,JSON.stringify(patch));
  }
});

test('JSON Pointer按实际字段与数组索引读取，不访问原型，区分空值与缺失',()=>{
  const json=JSON.stringify({items:[{title:'标题'}],'a/b':{'~value':false},nil:null,empty:'',obj:{a:1},'':0,'01':'对象键'});
  assert.equal(E.extractResponse(json,'/items/0/title'),'标题');assert.equal(E.extractResponse(json,'/a~1b/~0value'),'false');assert.equal(E.extractResponse(json,'/nil'),'null');assert.equal(E.extractResponse(json,'/obj'),'{"a":1}');
  assert.equal(E.extractResponse(json,'/empty'),'');assert.equal(E.extractResponse(json,'/'),'0');assert.equal(E.extractResponse(json,'/01'),'对象键');
  for(const path of ['/items/01','/items/-','/items/length','/toString','/obj/__proto__','/missing','/nil/x'])assert.throws(()=>E.extractResponse(json,path),/找不到字段/);
  assert.throws(()=>E.extractResponse('plain text','/data'),/有效 JSON/);
});

test('HTTP错误、字段缺失或取消阻止后续模型调用，保留已完成节点',async()=>{
  for(const mode of ['error','missing','abort']) {
    const {f,http}=chain(true),controller=new AbortController(),logs=[];let models=0;http.config.responsePath='/answer';
    await assert.rejects(E.runFlow(f,'输入',{signal:controller.signal,invokeHttp:async()=>{if(mode==='error')throw Error('HTTP 500');if(mode==='abort')controller.abort();return {output:'{}'};},invokeModel:async()=>{models++;return '不能执行';},onNode:log=>logs.push(log)}), mode==='error'?/HTTP 500/:mode==='abort'?{name:'AbortError'}:/找不到字段/);
    assert.equal(models,0);assert.equal(logs.length,1);assert.equal(logs[0].type,'start');
  }
});

test('GET和DELETE忽略未启用正文，导入保留配置但剔除认证值',async()=>{
  const {f,http}=chain();http.config.method='DELETE';http.config.bodyTemplate='{{missing}}';http.config.secret='不能导出';http.config.headers={Authorization:'不能导出'};
  const imported=E.validateFlow(f);assert.equal(imported.nodes[1].config.secret,undefined);assert.equal(imported.nodes[1].config.headers,undefined);assert.equal(imported.nodes[1].config.url,http.config.url);
  await E.runFlow(imported,'输入',{invokeHttp:async(n,r)=>{assert.equal(r.body,'');return {output:'已删除',status:200};}});
});

test('多分支HTTP配置预检和凭据校验在开始执行前完成',async()=>{
  const {f,http,start,end}=chain(),condition=E.makeNode('condition',0,0),other=E.makeNode('end',0,0);f.nodes.push(condition,other);f.edges=[link(start,condition),link(condition,http),link(http,end),link(condition,other,'no')];http.config.url='';let starts=0;
  await assert.rejects(E.runFlow(f,'走否分支',{invokeHttp:async()=>({output:'OK'}),onNodeStart:()=>starts++}),/请求地址/);assert.equal(starts,0);
  http.config.url='https://example.com';await assert.rejects(E.runFlow(f,'输入',{invokeHttp:async()=>({output:'OK'}),validateHttp:()=>{throw Error('凭据不可用');},onNodeStart:()=>starts++}),/凭据不可用/);assert.equal(starts,0);
});

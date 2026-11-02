const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createApp}=require('../server.cjs');
const {createKnowledgeStore}=require('../lib/knowledge-store.cjs');
const E=require('../public/engine.js');
async function fixture(t,extra={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'flow-knowledge-api-')),filePath=path.join(dir,'knowledge.json');
  const store=createKnowledgeStore({filePath}),server=http.createServer(createApp({knowledgeStore:store,...extra}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(()=>{fs.rmSync(dir,{recursive:true,force:true});resolve();}));});
  return {store,filePath,base:`http://127.0.0.1:${server.address().port}`};
}
async function api(base,route,method='GET',body,headers={}){
  const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,data:await response.json()};
}
test('知识库与文档API完成创建、分片检索、编辑重索引、删除与磁盘重载',async t=>{
  const {base,filePath}=await fixture(t);
  assert.deepEqual((await api(base,'/api/knowledge')).data,{libraries:[]});
  const created=await api(base,'/api/knowledge','POST',{name:'产品资料'});assert.equal(created.status,201);
  const id=created.data.library.id,route='/api/knowledge/'+id;
  const document=await api(base,route+'/documents','POST',{name:'退款说明.md',content:'收到商品后七天内可申请退款。\nRefund requests accepted within seven days.'});assert.equal(document.status,201);
  const docRoute=route+'/documents/'+document.data.document.id;
  const match=await api(base,route+'/search','POST',{query:'退款期限',topK:3});assert.equal(match.status,200);assert.match(match.data.hits[0].text,/七天/);assert.equal(match.data.hits[0].documentName,'退款说明.md');
  assert.ok(!(await api(base,route)).data.library.documents[0].content);
  assert.equal((await api(base,docRoute)).data.document.content,match.data.hits[0].text);
  await api(base,route,'PUT',{name:'售后资料'});await api(base,docRoute,'PUT',{name:'配送说明',content:'国际快递预计五天送达。'});
  assert.equal((await api(base,route+'/search','POST',{query:'refund'})).data.hits.length,0);
  assert.equal(createKnowledgeStore({filePath}).get(id).name,'售后资料');
  assert.equal((await api(base,docRoute,'DELETE')).status,200);assert.equal((await api(base,docRoute)).status,404);
  assert.equal((await api(base,route,'DELETE')).status,200);assert.equal((await api(base,route)).status,404);
});
test('知识API沿用来源/主机校验并拒绝空正文、非法检索、过大请求与未知路径',async t=>{
  const {base}=await fixture(t),id=(await api(base,'/api/knowledge','POST',{name:'库'})).data.library.id,route='/api/knowledge/'+id;
  assert.equal((await api(base,route+'/documents','POST',{name:'doc',content:''})).status,400);
  for(const body of [{query:''},{query:'x',topK:'3'},{query:'x',topK:11}])assert.equal((await api(base,route+'/search','POST',body)).status,400);
  assert.equal((await api(base,'/api/knowledge', 'POST',{name:'x'},{Origin:'https://evil.example'})).status,403);
  assert.equal((await api(base,'/api/knowledge','GET',undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await api(base,'/api/knowledge/does-not-exist')).status,404);
  assert.equal((await api(base,route+'/search/not-a-document','POST',{query:'x'})).status,404);
  assert.equal((await api(base,route+'/documents','POST',{name:'doc',content:'x'.repeat(600000)})).status,413);
  assert.equal((await fetch(base+route+'/search',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})).status,415);
});
test('真实知识检索结果连到统一模型接口，模型收到引用和资料，无需外部网络',async t=>{
  const seen=[],model={id:'m',model:'fake',enabled:true,baseUrl:'https://model.example/v1',apiKey:''};
  const {base,store}=await fixture(t,{store:{get:id=>{assert.equal(id,'m');return model;},list:()=>[model]},fetchImpl:async(url,options)=>{seen.push(JSON.parse(options.body));return new Response(JSON.stringify({choices:[{message:{content:'依据 [1]：退款期限为七天。'}}]}),{status:200,headers:{'Content-Type':'application/json'}});}});
  const kb=store.save({name:'售后资料'});store.saveDocument(kb.id,{name:'退款手册',content:'收到商品后七天内可申请退款。'});
  const nodes=['start','knowledge','llm','end'].map(type=>E.makeNode(type,0,0));nodes[1].config.knowledgeId=kb.id;nodes[2].config.modelId='m';nodes[2].config.prompt='仅根据资料回答并保留编号。';
  const flow={nodes,edges:nodes.slice(1).map((n,i)=>({id:E.uid(),from:nodes[i].id,to:n.id,branch:'yes'}))};
  const plan=await E.runFlow(flow,'退款期限',{invokeKnowledge:async(n,query,signal)=>(await api(base,'/api/knowledge/'+n.config.knowledgeId+'/search','POST',{query,topK:3})).data,invokeModel:async(n,input,signal,context)=>(await api(base,'/api/chat','POST',{modelId:n.config.modelId,input,prompt:context.prompt})).data.output});
  assert.match(plan.output,/七天/);assert.equal(seen.length,1);assert.match(seen[0].messages[1].content,/\[1\] 退款手册/);assert.match(seen[0].messages[1].content,/收到商品/);assert.equal(plan.logs[1].sources[0].documentId,store.get(kb.id).documents[0].id);
});

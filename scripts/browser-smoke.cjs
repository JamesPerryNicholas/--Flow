const http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
fs.mkdirSync(path.join(root,'.local','validation'),{recursive:true,mode:0o700});
const {createApp}=require(root+'/server.cjs');
const E=require(root+'/public/engine.js');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'lingjing-browser-'));
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
let calls=0;
const upstream=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:body.tools&&!body.messages.some(m=>m.role==='tool')?{content:null,tool_calls:[{id:'browsercall',type:'function',function:{name:'tool_0',arguments:'{"query":"退款"}'}}]}:{content:'购买后七天内可申请退款 [1]。'}}]}));});
const app=http.createServer(createApp({storeOptions:{filePath:path.join(temp,'models.enc')},toolCredentialStoreOptions:{filePath:path.join(temp,'tool-credentials.enc')},knowledgeStoreOptions:{filePath:path.join(temp,'knowledge.json')},publishedStoreOptions:{filePath:path.join(temp,'published.json')},conversationStoreOptions:{filePath:path.join(temp,'conversations.json')}}));
(async()=>{
let browser;
try{
const upstreamBase=await listen(upstream),base=await listen(app);
browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform==='linux' && fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1500,height:980}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
await page.goto(base);await page.locator('#models-open').click();
await page.locator('#model-name').fill('浏览器测试模型');await page.locator('#model-code').fill('fake-local-model');await page.locator('#model-url').fill(upstreamBase+'/v1');await page.locator('#model-save').click();
await page.locator('#model-feedback').filter({hasText:'模型已保存'}).waitFor();await page.locator('#model-test').click();await page.locator('#model-feedback').filter({hasText:'连接成功'}).waitFor();await page.locator('#models-close').click();
const prepared=await page.evaluate(async()=>{
 const api=async(p,body)=>{const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error);return data;};
 const models=await fetch('/api/models').then(r=>r.json());const {library}=await api('/api/knowledge',{name:'售后服务手册'});await api('/api/knowledge/'+library.id+'/documents',{name:'退款规则',content:'退款规则：购买后七天内可申请退款。'});
 const flow=FlowEngine.sample(),tool=FlowEngine.makeNode('knowledge',760,500);flow.name='售后智能体 · 自主工具验证';flow.nodes[1].name='售后服务助手';flow.nodes[1].config.modelId=models.models[0].id;tool.name='查询退款政策';tool.config.knowledgeId=library.id;flow.nodes.push(tool);return {flow,agentId:flow.nodes[1].id,toolId:tool.id};
});
await page.locator('#import-file').setInputFiles({name:'agent-smoke.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(prepared.flow))});
await page.locator('#workflow-name').waitFor();await page.waitForFunction(()=>document.getElementById('workflow-name').value.includes('自主工具验证'));
await page.reload();await page.locator(`.node[data-id="${prepared.agentId}"]`).click();
const checkbox=page.locator(`[data-agent-tool="${prepared.toolId}"]`);await checkbox.check();await page.locator('[data-config="maxToolRounds"]').fill('2');await page.locator('#save').click();
await page.screenshot({path:root+'/.local/validation/agent-config.png',fullPage:true});
await page.reload();await page.locator(`.node[data-id="${prepared.agentId}"]`).click();assert.equal(await checkbox.isChecked(),true);
await page.locator('#run').click();await page.locator('#run-input').fill('买了三天，能退款吗？');await page.locator('#execute').click();await page.locator('#final-result').filter({hasText:'七天内'}).waitFor();
await page.locator('.run-node-detail').filter({hasText:'售后服务助手'}).locator('summary').click();await page.screenshot({path:root+'/.local/validation/agent-run.png',fullPage:true});
assert.ok((await page.locator('#run-results').innerText()).includes('自主工具调用'));
assert.ok((await page.locator('#run-results').innerText()).includes('查询退款政策'));
const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('lingjing-runs-v1')));assert.equal(stored.records[0].logs.find(l=>l.type==='agent').agentSteps[0].status,'success');
assert.equal(calls,3);
await page.locator('#publish-open').click();await page.locator('#pub-submit').click();await page.locator('#pub-open').waitFor();
const appPage=await browser.newPage({viewport:{width:1440,height:1000}});appPage.on('pageerror',error=>errors.push(error.message));
await appPage.goto(await page.locator('#pub-open').getAttribute('href'));await appPage.locator('#app-input').fill('三天前购买，可以退款吗？');await appPage.locator('#app-execute').click();
await appPage.locator('#app-output').filter({hasText:'七天内'}).waitFor();
await appPage.locator('#app-logs details').filter({hasText:'售后服务助手'}).locator('summary').click();
assert.ok((await appPage.locator('#app-logs').innerText()).includes('自主工具调用'));
await appPage.screenshot({path:root+'/.local/validation/agent-published.png',fullPage:true});
assert.equal(calls,5);assert.deepEqual(errors,[]);
console.log(JSON.stringify({browser:'Chromium',modelSave:true,connectionTest:true,toolSelectionPersisted:true,liveAgentKnowledgeCall:true,historyTrace:true,publishedApplication:true,upstreamRequests:calls,pageErrors:errors,screenshots:['.local/validation/agent-config.png','.local/validation/agent-run.png','.local/validation/agent-published.png']}));
}catch(e){console.error(e.stack);process.exitCode=1;}finally{await browser?.close();app.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>app.close(r)),new Promise(r=>upstream.close(r))]);fs.rmSync(temp,{recursive:true,force:true});}
})();

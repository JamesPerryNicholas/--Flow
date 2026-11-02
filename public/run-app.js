(() => {
  'use strict';
  const $=id=>document.getElementById(id),params=new URLSearchParams(location.search),appId=params.get('app');
  let app=null,busy=false,controller=null,recordId=null;
  const storage={getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)};
  const history=FlowHistory.createStore(storage,message=>{$('app-notice').textContent=message;});
  const historyUI=FlowHistory.mount({store:history,getFlowId:()=>`published:${appId}`,onReplay:record=>{if(!busy){$('app-input').value=record.input;$('app-input').focus();}},onOpen:()=>{}});
  $('app-history').onclick=()=>historyUI.open();
  const version=()=>app?.versions.find(v=>v.version===Number($('app-version').value));
  const conversations=FlowConversations.mount({appId,getVersion:()=>version()?.version,getMode:()=>$('app-mode').value,notice:message=>notice(message),onChange:()=>controls(),onSelect:()=>resetResult()});
  function controls(){const ready=!!app?.enabled&&!!version();$('app-execute').disabled=busy||!ready||!conversations.ready();$('app-input').disabled=busy||!ready;$('app-version').disabled=busy||!app;$('app-mode').disabled=busy;$('app-stop').hidden=!busy;$('app-execute').textContent=busy?'正在运行…':'运行应用 ↗';}
  function notice(message=''){$('app-notice').textContent=message;}
  function resetResult(){$('app-input').value='';$('app-result').hidden=true;$('app-placeholder').hidden=false;$('app-result-state').textContent='READY';notice();}
  function modeNote(){$('app-mode-note').textContent=$('app-mode').value==='live'?'真实执行会请求配置的模型和工具，可能产生费用或写入数据。':'模型与 HTTP 使用模板；文档库仍检索本机资料，不发送模型或工具请求。';}
  function selectVersion(){
    const v=version();if(!v)return;
    $('app-version-description').textContent=v.description||'此版本没有填写说明';
    $('app-version-meta').textContent=`发布于 ${new Date(v.createdAt).toLocaleString('zh-CN')} · ${v.nodeCount} 个节点 · ${v.workflowCount} 个流程`;
    $('app-input-type').textContent=v.inputType==='json'?'JSON':'TEXT';$('app-input').placeholder=v.inputType==='json'?'输入有效 JSON，例如 {"topic":"创作主题"}':'在这里输入你的问题或内容…';
    document.title=v.name+' · 灵境 Flow';$('app-name').textContent=v.name;
    const url=new URL(location.href);url.searchParams.set('version',v.version);globalThis.history.replaceState(null,'',url);
    $('app-result').hidden=true;$('app-placeholder').hidden=false;$('app-result-state').textContent='READY';notice(app.enabled?'':'应用已下架，暂时无法运行。可回到工作台启用。');controls();conversations.load();
  }
  function block(parent,label,text){if(text===undefined||text==='')return;const title=document.createElement('h4');title.textContent=label;const content=document.createElement('pre');content.textContent=String(text);parent.append(title,content);}
  function showResult(result){
    $('app-result').hidden=false;$('app-placeholder').hidden=true;$('app-logs').replaceChildren();
    $('app-result').classList.toggle('runner-error',result.status!=='success');
    const label=result.status==='success'?'执行成功':result.status==='cancelled'?'已取消':'运行失败';
    $('app-result-state').textContent=result.status==='success'?'DONE':result.status==='cancelled'?'STOPPED':'ERROR';
    $('app-result-meta').textContent=`${label} · v${result.version||version()?.version} · ${$('app-mode').value==='live'?'真实执行':'本地模拟'}${Number.isFinite(result.elapsedMs)?' · '+(result.elapsedMs/1000).toFixed(2)+' 秒':''}${result.conversationId?' · 上下文 '+result.contextTurns+' 轮'+(result.conversationSaved?' · 已保存对话':' · 未保存对话'):''}`;
    $('app-output').textContent=result.status==='success'?result.output:result.error||'运行失败，请检查工作流和本机配置。';$('app-copy').hidden=result.status!=='success';
    for(const log of result.logs||[]){
      const details=document.createElement('details');details.className='runner-log';details.open=log.status==='error';
      const summary=document.createElement('summary');summary.textContent=(log.name||log.id||'节点')+' · '+(log.status==='error'?'失败':log.status==='cancelled'?'已取消':'完成')+(Number.isFinite(log.elapsedMs)?' · '+(log.elapsedMs/1000).toFixed(2)+' 秒':'');details.append(summary);
      if(log.batchNodeId){const info=document.createElement('p');info.textContent=(log.workflowName||'子流程')+' · 第 '+(log.iterationPath?.length?log.iterationPath.map(i=>i+1).join(' / '):Number(log.iterationIndex||0)+1)+' 项';details.append(info);}
      if(log.sources?.length)block(details,'检索来源',log.sources.map((s,i)=>`[${i+1}] ${s.documentName} · 片段 ${s.chunkIndex+1}\n${s.text}`).join('\n\n'));
      if(log.agentSteps?.length)block(details,'自主工具调用',FlowHistory.formatAgentSteps(log.agentSteps));
      block(details,'输入',log.input);block(details,'提示词',log.prompt);block(details,'请求',log.request);block(details,'输出',log.output);block(details,'错误',log.error);$('app-logs').append(details);
    }
    if(result.omittedLogs){const note=document.createElement('p');note.className='runner-note';note.textContent=`有 ${result.omittedLogs} 条日志因容量限制省略。`;$('app-logs').append(note);}
  }
  $('app-mode').onchange=()=>{modeNote();resetResult();conversations.load();};$('app-version').onchange=selectVersion;
  $('app-stop').onclick=()=>controller?.abort();
  $('app-copy').onclick=async()=>{try{await navigator.clipboard.writeText($('app-output').textContent);notice('结果已复制。');}catch{notice('无法自动复制，请手动选择结果。');}};
  $('app-run-form').onsubmit=async event=>{
    event.preventDefault();if(busy||!app?.enabled||!version())return;
    const input=$('app-input').value,v=version(),mode=$('app-mode').value;
    if(v.inputType==='json'){try{JSON.parse(input);}catch{notice('此版本需要有效 JSON 输入。');return;}}
    if(!conversations.ready())return;
    busy=true;controller=new AbortController();notice();conversations.setBusy(true);controls();$('app-result-state').textContent='RUNNING';
    recordId=history.start({flowId:`published:${appId}`,flowName:v.name+' · v'+v.version,mode,input});
    try{
      const conversationId=await conversations.begin();
      if(controller.signal.aborted)throw new DOMException('运行已停止','AbortError');
      const response=await fetch('/api/published/'+encodeURIComponent(appId)+'/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input,version:v.version,mode,...(conversationId?{conversationId}:{})}),signal:controller.signal});
      let result;try{result=await response.json();}catch{throw Error('本机服务未返回有效响应，请重启服务后重试。');}
      if(!response.ok)throw Error(result.error||`请求失败（${response.status}）`);
      if(!['success','error','cancelled'].includes(result.status)||!Array.isArray(result.logs))throw Error('运行结果格式无效。');
      for(const log of result.logs)history.append(recordId,log);
      history.finish(recordId,{status:result.status,output:result.output,error:result.error,failedNodeId:result.nodeId});showResult(result);
      if(result.warning)notice(result.warning);
    }catch(error){
      const result={status:error.name==='AbortError'?'cancelled':'error',error:error.name==='AbortError'?'运行已停止。已发送的请求可能产生费用或写入数据。':error.message,version:v.version,logs:[]};
      history.finish(recordId,{status:result.status,error:result.error});showResult(result);
    }finally{recordId=null;controller=null;await conversations.refresh();busy=false;conversations.setBusy(false);controls();}
  };
  window.addEventListener('pagehide',()=>{controller?.abort();if(recordId)history.finish(recordId,{status:'cancelled',error:'离开应用页面，运行已取消。'});});
  async function load(){
    try{
      if(!appId||!/^[a-zA-Z0-9-]+$/.test(appId))throw Error('缺少有效的应用标识，请从发布管理打开应用。');
      const response=await fetch('/api/published/'+encodeURIComponent(appId));const data=await response.json();if(!response.ok)throw Error(data.error||'应用加载失败。');app=data.app;
      $('app-version').replaceChildren(...app.versions.map(v=>{const option=document.createElement('option');option.value=v.version;option.textContent=`v${v.version} · ${v.name}${v.version===app.latestVersion?' · 最新':''}`;return option;}));
      const requested=params.get('version');if(requested!==null&&(!/^[1-9]\d*$/.test(requested)||!app.versions.some(v=>v.version===Number(requested))))throw Error('指定的发布版本不存在。');
      $('app-version').value=requested||String(app.latestVersion);selectVersion();
    }catch(error){app=null;$('app-name').textContent='应用暂不可用';notice(error.message);controls();}
  }
  load();
})();

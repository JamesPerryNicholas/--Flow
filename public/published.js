(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date=value=>new Date(value).toLocaleString('zh-CN');
  function init({getDraft,getBundle,onOpen}) {
    const dialog=document.createElement('dialog');dialog.id='published-dialog';dialog.setAttribute('aria-labelledby','pub-title');
    dialog.innerHTML=`<header class="pub-header"><div><div class="eyebrow">WORKSPACE / PUBLISH</div><h2 id="pub-title">让工作流，开始工作 <span>✦</span></h2><p>固定流程版本，通过独立入口或 API 在本机运行。</p></div><button class="icon-button" id="pub-close" aria-label="关闭发布管理">×</button></header><div class="pub-body"><aside class="pub-sidebar"><div class="pub-list-heading">已发布应用</div><button class="button full" id="pub-current">查看当前工作流</button><nav id="pub-apps" aria-label="已发布应用"></nav><p class="pub-note">入口仅当前电脑可访问。<br>版本保留流程与子流程；<br>统一配置仍使用当前内容。</p></aside><section class="pub-main"><div id="pub-feedback" role="status" aria-live="polite"></div><form id="pub-form"><div class="pub-draft-label">当前草稿</div><h3 id="pub-draft-name"></h3><p id="pub-draft-meta"></p><label class="field"><span>版本说明 <small>可选</small></span><textarea id="pub-description" maxlength="500" rows="2" placeholder="例如：优化提示词，加入售后知识检索"></textarea></label><div class="pub-draft-actions"><span>发布前校验所有可达节点配置</span><button class="button primary" id="pub-submit" type="submit">发布当前草稿</button></div></form><div id="pub-empty" class="pub-empty">当前工作流尚未发布。<br>发布后即可获得独立入口和调用地址。</div><section id="pub-detail" hidden><div class="pub-app-heading"><div><h3 id="pub-app-name"></h3><p id="pub-app-state"></p></div><button class="button" id="pub-toggle" type="button"></button></div><label class="field"><span>运行版本 <small>历史版本可以独立调用</small></span><select id="pub-version" aria-label="运行版本"></select></label><p id="pub-version-meta" class="pub-note"></p><p id="pub-version-description"></p><div class="pub-entry"><div><span>独立运行入口</span><a id="pub-open" target="_blank" rel="noopener">打开应用 ↗</a></div><input id="pub-url" aria-label="独立运行地址" readonly><button class="button" id="pub-copy-url" type="button">复制地址</button></div><details class="pub-api"><summary>通过 API 调用</summary><p>JavaScript 示例 · Node.js 18+ · 每次请求都会重新运行</p><pre id="pub-code"></pre><button class="button" id="pub-copy-code" type="button">复制示例</button></details><p class="pub-note">草稿修改不会改变这些版本。模型、凭据和知识文档按运行时的本机配置读取。下架阻止新的运行，已发送的请求不会回滚。发布新版本会重新启用入口。</p></section></section></div>`;
    document.body.append(dialog);
    let apps=[],current=null,sourceId='',busy=false;
    function feedback(text='',error=false){$('pub-feedback').textContent=text;$('pub-feedback').className=error?'pub-error':'pub-success';}
    function controls(){dialog.querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=busy);}
    function list(){
      $('pub-apps').innerHTML=apps.length?apps.map(a=>`<button class="pub-app ${a.id===current?.id?'selected':''}" data-published="${esc(a.id)}"><b>${esc(a.name)}</b><small>v${a.latestVersion} · ${a.enabled?'已启用':'已下架'}${a.sourceWorkflowId===sourceId?' · 当前草稿':''}</small></button>`).join(''):'<p class="pub-note">还没有发布的应用</p>';
    }
    function versionView(){
      const version=current?.versions.find(v=>v.version===Number($('pub-version').value));if(!version)return;
      $('pub-version-meta').textContent=`${date(version.createdAt)} · ${version.nodeCount} 个节点 · ${version.workflowCount} 个流程 · ${version.inputType==='json'?'JSON':'文本'}输入`;
      $('pub-version-description').textContent=version.description||'此版本没有填写说明';
      const entry=new URL('/run.html',location.origin);entry.searchParams.set('app',current.id);entry.searchParams.set('version',version.version);
      $('pub-url').value=entry.href;$('pub-open').href=entry.href;
      const endpoint=location.origin+'/api/published/'+encodeURIComponent(current.id)+'/run';
      $('pub-code').textContent=`const response = await fetch(${JSON.stringify(endpoint)}, {\n  method: 'POST',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify({\n    input: ${JSON.stringify(version.inputType==='json'?'{}':'你的输入')},\n    version: ${version.version},\n    mode: 'live'\n  })\n});\nconst result = await response.json();\nconsole.log(result);`;
    }
    function detail(){
      $('pub-detail').hidden=!current;$('pub-empty').hidden=!!current;list();if(!current)return;
      $('pub-app-name').textContent=current.name;$('pub-app-state').textContent=(current.enabled?'入口已启用':'入口已下架')+' · 最新版本 v'+current.latestVersion;
      $('pub-toggle').textContent=current.enabled?'下架应用':'启用应用';
      $('pub-version').innerHTML=current.versions.map(v=>`<option value="${v.version}">v${v.version} · ${esc(v.name)}${v.version===current.latestVersion?' · 最新':''}</option>`).join('');versionView();
    }
    async function refresh(){apps=(await ModelManager.request('/api/published')).apps;}
    async function load(id){current=id?(await ModelManager.request('/api/published/'+encodeURIComponent(id))).app:null;detail();}
    async function task(action){if(busy)return;busy=true;controls();try{await action();}catch(error){feedback(error.message,true);}finally{busy=false;controls();}}
    function close(){if(busy)return;dialog.close();}
    $('pub-close').onclick=close;dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    $('pub-apps').onclick=event=>{const button=event.target.closest('[data-published]');if(button)task(()=>load(button.dataset.published));};
    $('pub-current').onclick=()=>task(()=>load(apps.find(a=>a.sourceWorkflowId===sourceId)?.id));
    $('pub-version').onchange=versionView;
    $('pub-toggle').onclick=()=>task(async()=>{const version=$('pub-version').value;current=(await ModelManager.request('/api/published/'+encodeURIComponent(current.id),{method:'PUT',body:{enabled:!current.enabled}})).app;await refresh();detail();$('pub-version').value=version;versionView();feedback(current.enabled?'应用已启用。':'应用已下架，新的运行请求将被拒绝。');});
    $('pub-form').onsubmit=event=>{event.preventDefault();task(async()=>{
      const bundle=getBundle();feedback('正在校验并保存固定版本…');
      const result=await ModelManager.request('/api/published',{method:'POST',body:{bundle,description:$('pub-description').value}});
      current=result.app;await refresh();detail();$('pub-description').value='';feedback(`v${result.version.version} 已发布，草稿仍可继续编辑。`);
    });};
    async function copy(text){try{await navigator.clipboard.writeText(text);feedback('已复制。');}catch{feedback('无法自动复制，请手动选择内容复制。',true);}}
    $('pub-copy-url').onclick=()=>copy($('pub-url').value);$('pub-copy-code').onclick=()=>copy($('pub-code').textContent);
    async function open(){
      if(busy)return;onOpen?.();feedback();if(!dialog.open)dialog.showModal();
      await task(async()=>{const draft=getDraft();sourceId=draft.id;$('pub-draft-name').textContent=draft.name;$('pub-draft-meta').textContent=`${draft.nodeCount} 个主流程节点，发布时包含全部依赖流程。每次发布新增一个版本。`;await refresh();await load(apps.find(a=>a.sourceWorkflowId===sourceId)?.id);});
    }
    $('publish-open').onclick=open;
    return {open};
  }
  window.PublishedManager={init};
})();

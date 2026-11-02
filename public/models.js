(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function request(path, options={}) {
    const {body,...rest}=options;
    const response=await fetch(path,{...rest,headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    let data;
    try { data=await response.json(); } catch { throw Error('本地服务未返回有效响应，请重启服务后重试'); }
    if(!response.ok){const error=Error(data.error || `请求失败（${response.status}）`);if(Array.isArray(data.agentSteps))error.agentSteps=data.agentSteps;throw error;}
    return data;
  }
  function init({onChange,onOpen}) {
    let models=[],editingId=null,busy=false,dirty=false,controller=null,loadSequence=0;
    function feedback(text='',state='') { $('model-feedback').textContent=text; $('model-feedback').dataset.state=state; }
    function controls() {
      $('model-form').querySelectorAll('input,button').forEach(el=>el.disabled=busy);
      $('model-test').disabled=busy||dirty||!editingId;
      $('model-new').disabled=busy;$('models-close').disabled=busy&&!controller;
      $('models-list').querySelectorAll('button').forEach(el=>el.disabled=busy);
    }
    function list() {
      $('models-count').textContent=models.length;
      $('models-list').innerHTML=models.length?models.map(m=>`<button type="button" class="model-card ${editingId===m.id?'selected':''}" data-model="${esc(m.id)}"><span class="type-icon" style="--type-bg:#efeafa;--type-color:#967dcc">✦</span><span class="model-card-text"><b>${esc(m.name)}</b><small>${esc(m.model)}</small></span><span class="model-health ${m.enabled?'':'off'}" title="${m.enabled?'已启用':'已停用'}"></span></button>`).join(''):'<div class="models-empty">还没有接入模型<br>填写右侧信息，开始连接</div>';
    }
    function edit(id=null) {
      const m=models.find(m=>m.id===id);editingId=m?.id||null;dirty=false;
      $('models-loading').hidden=true;$('model-form').hidden=false;
      $('model-form-title').textContent=m?'编辑模型配置':'接入一个新模型';
      $('model-name').value=m?.name||'';$('model-code').value=m?.model||'';$('model-url').value=m?.baseUrl||'';
      $('model-key').value='';$('model-enabled').checked=m?.enabled??true;
      $('model-key-state').textContent=m?.hasKey?'已保存 · 留空保留原密钥':'本机服务可不填';
      $('model-key').placeholder=m?.hasKey?'留空保留，输入新密钥可替换':'输入服务商提供的 API Key';
      $('model-key-help').textContent=m?.hasKey?'原密钥不会回显。更换接口域名时，需重新填写密钥。':'仅用于请求你配置的模型服务，不会放入工作流或浏览器本地存储。';
      $('model-delete').hidden=!m;feedback();list();controls();
    }
    async function refresh() {
      const sequence=++loadSequence;
      try { const data=await request('/api/models');if(sequence!==loadSequence)return;models=data.models;onChange(models,'');return true; }
      catch(error){if(sequence!==loadSequence)return;onChange(models,error.message);throw error;}
    }
    async function open() {
      onOpen();if(!$('models-dialog').open)$('models-dialog').showModal();
      $('model-form').hidden=true;$('models-loading').hidden=false;$('models-loading').className='';$('models-loading').textContent='正在加载模型配置…';
      $('model-key').value='';
      try { await refresh();if($('models-dialog').open)edit(models.some(m=>m.id===editingId)?editingId:models[0]?.id); }
      catch(error) { $('models-loading').className='models-loading-error';$('models-loading').textContent=error.message+'。关闭后重新打开可重试。'; }
    }
    $('models-open').onclick=open;$('models-nav').onclick=open;
    $('models-close').onclick=()=>$('models-dialog').close();
    $('models-dialog').addEventListener('cancel',e=>{if(busy&&!controller)e.preventDefault();});
    $('models-dialog').addEventListener('close',()=>{$('model-key').value='';controller?.abort();});
    $('model-new').onclick=()=>{if(!busy){edit();$('model-name').focus();}};
    $('models-list').onclick=e=>{const el=e.target.closest('[data-model]');if(el&&!busy)edit(el.dataset.model);};
    $('model-form').addEventListener('input',()=>{dirty=true;feedback('有未保存的更改，请先保存后测试。');controls();});
    $('model-form').onsubmit=async e=>{
      e.preventDefault();if(busy)return;busy=true;controls();feedback('正在保存…');
      const body={name:$('model-name').value.trim(),model:$('model-code').value.trim(),baseUrl:$('model-url').value.trim(),apiKey:$('model-key').value,enabled:$('model-enabled').checked};
      try {
        const data=await request(editingId?'/api/models/'+encodeURIComponent(editingId):'/api/models',{method:editingId?'PUT':'POST',body});
        const index=models.findIndex(m=>m.id===data.model.id);if(index<0)models.push(data.model);else models[index]=data.model;
        edit(data.model.id);onChange(models,'');feedback(data.model.enabled?'模型已保存，可在任意工作流节点中选择。':'模型已停用，引用它的节点需选择其他模型。','success');
      } catch(error){feedback(error.message,'error');}
      finally{busy=false;controls();}
    };
    $('model-test').onclick=async()=>{
      if(busy||dirty||!editingId)return;busy=true;controller=new AbortController();controls();feedback('正在发送测试请求…');
      try {const data=await request('/api/models/'+encodeURIComponent(editingId)+'/test',{method:'POST',body:{},signal:controller.signal});feedback(`连接成功 · ${data.elapsedMs} ms\n${data.message}`,'success');}
      catch(error){feedback(error.name==='AbortError'?'测试已取消':error.message,'error');}
      finally{controller=null;busy=false;controls();}
    };
    $('model-delete').onclick=async()=>{
      if(busy||!editingId)return;
      if(!confirm('删除此模型及其密钥？引用它的节点将不可用，需手动选择其他模型。'))return;
      busy=true;controls();
      try {await request('/api/models/'+encodeURIComponent(editingId),{method:'DELETE'});models=models.filter(m=>m.id!==editingId);edit(models[0]?.id);onChange(models,'');feedback('模型已删除。');}
      catch(error){feedback(error.message,'error');}
      finally{busy=false;controls();}
    };
    refresh().catch(()=>{});
    return {open};
  }
  window.ModelManager={init,request};
})();

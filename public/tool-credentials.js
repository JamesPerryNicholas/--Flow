(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function init({onChange,onOpen}) {
    const dialog = document.createElement('dialog');
    dialog.id = 'tool-credentials-dialog';
    dialog.setAttribute('aria-labelledby','tool-credentials-title');
    dialog.innerHTML = `<div class="models-header"><div><div class="eyebrow">WORKSPACE / TOOL CREDENTIALS</div><h2 id="tool-credentials-title">工具凭据</h2><p>集中管理接口认证，所有工作流共享使用。</p></div><button class="icon-button" id="credentials-close" aria-label="关闭工具凭据">×</button></div><div class="models-body"><section class="models-sidebar"><div class="models-list-title">我的凭据 <span id="credentials-count">0</span><button class="icon-button" id="credential-new" aria-label="新增工具凭据">＋</button></div><div id="credentials-list"></div><div class="models-local-note"><p>认证值在本机加密保存。<br>凭据仅发送至绑定的目标来源。</p></div></section><section class="models-editor"><div id="credentials-loading">正在加载…</div><form id="credential-form" autocomplete="off" hidden><h3 class="credential-form-title" id="credential-form-title">新增工具凭据</h3><label class="field"><span>显示名称</span><input id="credential-name" required maxlength="80" placeholder="例如：内容管理服务"></label><label class="field"><span>目标来源 <small>协议、域名和端口</small></span><input id="credential-origin" type="url" required maxlength="2000" placeholder="https://api.example.com"><div class="field-description">仅匹配这个来源的请求可使用此凭据。更换来源需重新填写认证值。</div></label><label class="field"><span>认证请求头</span><input id="credential-header" required maxlength="100" value="Authorization" placeholder="Authorization 或 X-API-Key"></label><label class="field"><span>认证值 <small id="credential-secret-state"></small></span><input id="credential-secret" type="password" maxlength="4096" autocomplete="new-password" placeholder="例如：Bearer 服务商令牌"><div class="field-description">填写完整请求头值；Bearer 认证需包含 Bearer 前缀。原值不会回显，不放入工作流。</div></label><div id="credential-feedback" role="status" aria-live="polite"></div><div class="model-form-actions"><button type="button" class="button danger" id="credential-delete" hidden>删除</button><span></span><button class="button primary" type="submit" id="credential-save">保存凭据</button></div></form></section></div>`;
    document.body.append(dialog);
    const $ = id => dialog.querySelector('#'+id);
    let credentials = [], editingId = null, busy = false, sequence = 0;
    const request = ModelManager.request;
    function feedback(message='',error=false) { $('credential-feedback').textContent=message; $('credential-feedback').classList.toggle('error',error); }
    function controls() { dialog.querySelectorAll('input,button').forEach(el=>el.disabled=busy); }
    function list() {
      $('credentials-count').textContent=credentials.length;
      $('credentials-list').innerHTML=credentials.length ? credentials.map(c=>`<button class="model-card ${editingId===c.id?'selected':''}" data-credential="${esc(c.id)}"><span class="model-card-text"><b>${esc(c.name)}</b><small>${esc(c.origin)}</small></span></button>`).join('') : '<div class="models-empty">还没有工具凭据<br>公开接口可直接调用，无需添加</div>';
    }
    function edit(id=null) {
      const c=credentials.find(c=>c.id===id); editingId=c?.id||null;
      $('credentials-loading').hidden=true; $('credential-form').hidden=false;
      $('credential-form-title').textContent=c?'编辑工具凭据':'新增工具凭据';
      $('credential-name').value=c?.name||''; $('credential-origin').value=c?.origin||''; $('credential-header').value=c?.headerName||'Authorization';
      $('credential-secret').value=''; $('credential-secret').required=!c;
      $('credential-secret-state').textContent=c?'已保存 · 留空保留':'';
      $('credential-delete').hidden=!c; feedback(); list(); controls();
    }
    async function refresh() {
      const token=++sequence;
      try { const data=await request('/api/tool-credentials'); if(token!==sequence)return; credentials=data.credentials;onChange(credentials,''); }
      catch(error) { if(token!==sequence)return;onChange(credentials,error.message);throw error; }
    }
    async function open() {
      onOpen(); if(!dialog.open)dialog.showModal();
      $('credential-secret').value='';$('credential-form').hidden=true;$('credentials-loading').hidden=false;$('credentials-loading').textContent='正在加载凭据…';
      try { await refresh();if(dialog.open)edit(credentials.some(c=>c.id===editingId)?editingId:credentials[0]?.id); }
      catch(error){$('credentials-loading').textContent=error.message+'。关闭后重新打开可重试。';}
    }
    $('credentials-close').onclick=()=>dialog.close();
    dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
    dialog.addEventListener('close',()=>{$('credential-secret').value='';});
    $('credential-new').onclick=()=>{if(!busy){edit();$('credential-name').focus();}};
    $('credentials-list').onclick=e=>{const button=e.target.closest('[data-credential]');if(button&&!busy)edit(button.dataset.credential);};
    $('credential-form').onsubmit=async e=>{
      e.preventDefault(); if(busy)return; busy=true;controls();feedback('正在加密保存…');
      try {
        const data=await request('/api/tool-credentials'+(editingId?'/'+encodeURIComponent(editingId):''),{method:editingId?'PUT':'POST',body:{name:$('credential-name').value.trim(),origin:$('credential-origin').value.trim(),headerName:$('credential-header').value.trim(),secret:$('credential-secret').value}});
        ++sequence;
        const at=credentials.findIndex(c=>c.id===data.credential.id);if(at<0)credentials.push(data.credential);else credentials[at]=data.credential;
        edit(data.credential.id);onChange(credentials,'');feedback('凭据已保存，可在 HTTP 节点中选择。');
      } catch(error){feedback(error.message,true);} finally{busy=false;controls();}
    };
    $('credential-delete').onclick=async()=>{
      if(busy||!editingId)return;
      if(!confirm('删除此工具凭据及认证值？引用它的节点需要重新选择凭据。'))return;
      busy=true;controls();
      try { await request('/api/tool-credentials/'+encodeURIComponent(editingId),{method:'DELETE'});++sequence;credentials=credentials.filter(c=>c.id!==editingId);edit(credentials[0]?.id);onChange(credentials,'');feedback('凭据已删除。'); }
      catch(error){feedback(error.message,true);}finally{busy=false;controls();}
    };
    refresh().catch(()=>{});
    return {open};
  }
  window.ToolCredentials={init};
})();

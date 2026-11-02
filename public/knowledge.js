(() => {
  'use strict';
  const $=id=>document.getElementById(id), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function init({onOpen,onChange}) {
    document.body.insertAdjacentHTML('beforeend',`<dialog id="knowledge-dialog" aria-labelledby="knowledge-title"><header class="kb-header"><div><div class="eyebrow">WORKSPACE / KNOWLEDGE</div><h2 id="knowledge-title">把资料，变成可用的知识 <span>✦</span></h2><p>导入文档、自动切片，在任意工作流中检索并追溯来源。</p></div><button class="icon-button" id="kb-close" aria-label="关闭知识库">×</button></header><div class="kb-body"><aside class="kb-sidebar"><div class="kb-list-heading"><b>我的文档库</b><button class="icon-button" id="kb-new" aria-label="新建文档库">＋</button></div><div id="kb-libraries"></div><p class="kb-note">资料保存在本机服务端。<br>全文检索不调用模型。<br>目前支持 UTF-8 文本文件。</p></aside><section class="kb-main"><div id="kb-feedback" role="status" aria-live="polite"></div><form id="kb-library-form"><div class="kb-title-row"><label class="field"><span>文档库名称</span><input id="kb-name" required maxlength="80" placeholder="例如：产品使用手册"></label><button class="button primary" type="submit" id="kb-save">保存文档库</button><button class="button danger" type="button" id="kb-delete">删除库</button></div></form><div id="kb-workspace" hidden><div class="kb-document-heading"><h3>文档 <small id="kb-stats"></small></h3><button type="button" class="button" id="kb-doc-new">＋ 新建文本</button><button type="button" class="button" id="kb-import">导入文件</button><input type="file" id="kb-file" accept=".txt,.md,.markdown,.csv,.json,text/plain,text/markdown,text/csv,application/json" hidden></div><div class="kb-documents" id="kb-documents"></div><form id="kb-document-form"><label class="field"><span>文档名称</span><input id="kb-doc-name" required maxlength="160" placeholder="文件名或便于识别的标题"></label><label class="field"><span>文档正文 <small>最多 100000 字符，保存后自动切片</small></span><textarea id="kb-doc-content" required maxlength="100000" placeholder="粘贴资料，或导入 TXT / Markdown / CSV / JSON 文件。内容按纯文本检索。"></textarea></label><div class="kb-document-actions"><button type="button" class="button danger" id="kb-doc-delete" hidden>删除文档</button><span id="kb-doc-info"></span><button class="button primary" type="submit">保存文档</button></div></form><section class="kb-search"><h3>检索测试 <small>本地全文排序 · BM25</small></h3><form id="kb-search-form"><input id="kb-query" aria-label="检索问题" required maxlength="10000" placeholder="输入问题，查看命中的片段和来源"><select id="kb-top-k" aria-label="检索测试片段数"><option value="3">3 条片段</option><option value="5">5 条片段</option><option value="10">10 条片段</option></select><button class="button" type="submit">测试检索</button></form><div id="kb-search-results" aria-live="polite"></div></section></div></section></div></dialog>`);
    let libraries=[], library=null, docId=null, busy=false, dirtyLibrary=false, dirtyDoc=false, loadSequence=0;
    const dialog=$('knowledge-dialog'), request=ModelManager.request;
    function feedback(message='',error=false){$('kb-feedback').textContent=message;$('kb-feedback').className=error?'kb-error':'kb-success';}
    function controls(){dialog.querySelectorAll('button,input,select,textarea').forEach(el=>el.disabled=busy);$('kb-delete').hidden=!library;$('kb-doc-delete').hidden=!docId;}
    function list(){
      $('kb-libraries').innerHTML=libraries.length?libraries.map(k=>`<button type="button" class="kb-library ${library?.id===k.id?'selected':''}" data-library="${esc(k.id)}"><b>${esc(k.name)}</b><small>${k.documentCount} 篇文档 · ${k.chunkCount} 个片段</small></button>`).join(''):'<p class="kb-empty">还没有文档库<br>点击 ＋ 创建第一个</p>';
    }
    function documents(){
      $('kb-workspace').hidden=!library;
      if(!library)return;
      $('kb-stats').textContent=`${library.documentCount} 篇 · ${library.chunkCount} 个片段`;
      $('kb-documents').innerHTML=library.documents.length?library.documents.map(d=>`<button class="kb-document ${docId===d.id?'selected':''}" type="button" data-document="${esc(d.id)}"><b>${esc(d.name)}</b><small>${d.charCount} 字符 · ${d.chunkCount} 个片段</small></button>`).join(''):'<p class="kb-empty">添加一篇资料，工作流就能从这里检索。</p>';
    }
    function newDocument(){docId=null;dirtyDoc=false;$('kb-doc-name').value='';$('kb-doc-content').value='';$('kb-doc-info').textContent='新文档';documents();controls();}
    function discard(){return !(dirtyLibrary||dirtyDoc)||confirm('有尚未保存的修改，确定放弃？');}
    function base(){return '/api/knowledge/'+encodeURIComponent(library.id);}
    function publish(){onChange(libraries,'');}
    async function refresh(){const sequence=++loadSequence;try{const data=await request('/api/knowledge');if(sequence!==loadSequence)return;libraries=data.libraries;publish();list();}catch(error){if(sequence===loadSequence)onChange(libraries,error.message);throw error;}}
    async function loadLibrary(id){
      library=id?(await request('/api/knowledge/'+encodeURIComponent(id))).library:null;
      dirtyLibrary=false;dirtyDoc=false;$('kb-name').value=library?.name||'';$('kb-search-results').replaceChildren();$('kb-query').value='';newDocument();list();controls();
    }
    async function task(action){if(busy)return;busy=true;feedback();controls();try{await action();}catch(error){feedback(error.message,true);}finally{busy=false;controls();}}
    async function open(id){
      onOpen();if(dialog.open)return;
      dialog.showModal();
      await task(async()=>{await refresh();await loadLibrary(libraries.some(k=>k.id===(id||library?.id))?(id||library.id):libraries[0]?.id);});
    }
    $('knowledge-open').onclick=()=>open();
    $('kb-close').onclick=()=>{if(!busy&&discard())dialog.close();};
    dialog.addEventListener('cancel',e=>{if(busy||!discard())e.preventDefault();});
    $('kb-name').oninput=()=>{dirtyLibrary=true;};
    for(const id of ['kb-doc-name','kb-doc-content'])$(id).oninput=()=>{dirtyDoc=true;};
    $('kb-new').onclick=()=>{if(discard())task(()=>loadLibrary(null));};
    $('kb-libraries').onclick=e=>{const button=e.target.closest('[data-library]');if(button&&!busy&&discard())task(()=>loadLibrary(button.dataset.library));};
    $('kb-library-form').onsubmit=e=>{e.preventDefault();task(async()=>{
      const data=await request(library?base():'/api/knowledge',{method:library?'PUT':'POST',body:{name:$('kb-name').value}});
      library=data.library;dirtyLibrary=false;await refresh();documents();list();feedback('文档库已保存，所有工作流共享使用。');
    });};
    $('kb-delete').onclick=()=>{if(!library||!confirm(`删除文档库「${library.name}」及其全部文档？无法撤销，引用它的节点将不可用。`))return;task(async()=>{await request(base(),{method:'DELETE'});library=null;dirtyLibrary=dirtyDoc=false;await refresh();await loadLibrary(libraries[0]?.id);feedback('文档库已删除，请更新引用它的工作流节点。');});};
    $('kb-doc-new').onclick=()=>{if(!dirtyDoc||confirm('放弃当前文档的未保存修改？'))newDocument();};
    $('kb-documents').onclick=e=>{const button=e.target.closest('[data-document]');if(!button||busy||(dirtyDoc&&!confirm('放弃当前文档的未保存修改？')))return;task(async()=>{
      const data=await request(base()+'/documents/'+encodeURIComponent(button.dataset.document));docId=data.document.id;dirtyDoc=false;$('kb-doc-name').value=data.document.name;$('kb-doc-content').value=data.document.content;$('kb-doc-info').textContent=`${data.document.charCount} 字符 · ${data.document.chunkCount} 个片段`;documents();
    });};
    $('kb-document-form').onsubmit=e=>{e.preventDefault();task(async()=>{
      const data=await request(base()+'/documents'+(docId?'/'+encodeURIComponent(docId):''),{method:docId?'PUT':'POST',body:{name:$('kb-doc-name').value,content:$('kb-doc-content').value}});
      docId=data.document.id;dirtyDoc=false;$('kb-doc-info').textContent=`${data.document.charCount} 字符 · ${data.document.chunkCount} 个片段`;
      library=(await request(base())).library;await refresh();documents();$('kb-search-results').replaceChildren();feedback('文档已保存并建立索引，可立即检索。');
    });};
    $('kb-doc-delete').onclick=()=>{if(!docId||!confirm('删除当前文档？无法撤销。'))return;task(async()=>{await request(base()+'/documents/'+encodeURIComponent(docId),{method:'DELETE'});library=(await request(base())).library;await refresh();newDocument();$('kb-search-results').replaceChildren();feedback('文档已删除，索引已更新。');});};
    $('kb-import').onclick=()=>{if(!dirtyDoc||confirm('放弃当前文档的未保存修改？'))$('kb-file').click();};
    $('kb-file').onchange=()=>{const file=$('kb-file').files[0];$('kb-file').value='';if(!file)return;task(async()=>{
      if(!/\.(txt|md|markdown|csv|json)$/i.test(file.name))throw Error('请选择 TXT、Markdown、CSV 或 JSON 文本文件；PDF、Word 暂不支持。');
      if(file.size>400000)throw Error('文件过大，请拆分为每篇最多 100000 字符的文档。');
      let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());}catch{throw Error('文件不是有效的 UTF-8 文本，请转换编码后重试。');}
      if(!content.trim()||content.length>100000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content))throw Error('正文为空、超过 100000 字符或含二进制控制字符。');
      newDocument();$('kb-doc-name').value=file.name.slice(0,160);$('kb-doc-content').value=content;dirtyDoc=true;feedback('文件已读取，请检查正文后点击“保存文档”。');
    });};
    $('kb-search-form').onsubmit=e=>{e.preventDefault();task(async()=>{
      const data=await request(base()+'/search',{method:'POST',body:{query:$('kb-query').value,topK:Number($('kb-top-k').value)}});
      $('kb-search-results').innerHTML=data.hits.length?data.hits.map((h,i)=>`<article class="kb-hit"><div><b>[${i+1}] ${esc(h.documentName)}</b><small>片段 ${h.chunkIndex+1} · 相关分 ${Number(h.score).toFixed(3)}</small></div><pre>${esc(h.text)}</pre></article>`).join(''):'<p class="kb-empty">未找到匹配片段。可调整关键词或补充资料；全文检索不会推断同义词。</p>';
      feedback('检索完成，仅查询已保存的文档。');
    });};
    refresh().catch(()=>{});
    return {open,refresh};
  }
  window.KnowledgeManager={init};
})();

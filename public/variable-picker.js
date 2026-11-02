(() => {
  'use strict';
  function init({ getVariables, getSample, onInsert }) {
    const dialog = document.createElement('dialog');
    dialog.id = 'variable-dialog';
    dialog.setAttribute('aria-labelledby', 'variable-title');
    dialog.innerHTML = `<form id="structured-variable-form"><div class="dialog-header"><h2 id="variable-title">选择 JSON 字段</h2><button type="button" class="icon-button" id="variable-close" aria-label="关闭字段选择">×</button></div><p class="field-description">引用对象字段或数组元素。字段来自历史示例，仅供参考；执行时以实际返回为准。</p><label class="field"><span>变量来源</span><select id="variable-source" aria-label="变量来源"></select></label><label class="field"><span>字段路径 <small>JSON Pointer</small></span><input id="variable-path" maxlength="1000" placeholder="/data/items/0/title" autocomplete="off"><div class="field-description">留空引用整个 JSON；数组下标从 0 开始。字段名中的 / 写成 ~1，~ 写成 ~0。</div></label><div id="variable-sample-note" class="field-description"></div><div id="variable-tree" aria-label="示例字段"></div><details class="variable-sample"><summary>粘贴 JSON 示例以选择字段</summary><textarea id="variable-sample" maxlength="100000" aria-label="JSON 示例" placeholder='{"data":{"items":[{"title":"示例标题"}]}}'></textarea><button class="button" type="button" id="variable-parse">解析示例</button></details><div class="variable-token"><span>将插入</span><code id="variable-token"></code></div><p id="variable-error" role="status" aria-live="polite"></p><div class="variable-actions"><button type="button" class="button" id="variable-cancel">取消</button><button type="submit" class="button primary">插入字段引用</button></div></form>`;
    document.body.append(dialog);
    const $ = id => dialog.querySelector('#' + id);
    let variables = [], destination = null, sample;
    const escPart = text => text.replace(/~/g, '~0').replace(/\//g, '~1');
    const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    function token() {
      const variable = variables[Number($('variable-source').value)];
      return variable ? variable.token.slice(0, -2) + '#' + $('variable-path').value + '}}' : '';
    }
    function preview() { $('variable-token').textContent = token(); $('variable-error').textContent = ''; }
    function tree() {
      const parent = $('variable-tree'); parent.replaceChildren();
      if (sample === undefined) return;
      let count = 0, limited = false;
      function visit(value, path, depth) {
        if (count >= 100 || depth > 8) { limited = true; return; }
        count++;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'variable-tree-row'; button.dataset.path = path;
        const name = document.createElement('code'); name.textContent = path || '（整个 JSON）';
        const type = document.createElement('span'); type.className = 'variable-value-type'; type.textContent = kind(value);
        const hint = document.createElement('small'); hint.textContent = typeof value === 'object' && value !== null ? (Array.isArray(value) ? value.length + ' 项' : Object.keys(value).length + ' 个字段') : String(value).slice(0, 70);
        button.append(name, type, hint); button.style.paddingLeft = 10 + depth * 10 + 'px';
        button.onclick = () => { $('variable-path').value = path; preview(); };
        parent.append(button);
        if (value !== null && typeof value === 'object') for (const key of Object.keys(value)) {
          if (count >= 100) { limited = true; break; }
          visit(value[key], path + '/' + escPart(key), depth + 1);
        }
      }
      visit(sample, '', 0);
      if (limited) { const note = document.createElement('p'); note.className = 'field-description'; note.textContent = '最多展示 100 项、8 层；其余字段可手动输入路径。'; parent.append(note); }
    }
    function sourceChanged() {
      sample = undefined; $('variable-path').value = ''; $('variable-sample').value = '';
      const variable = variables[Number($('variable-source').value)], saved = variable && getSample(variable);
      try {
        if (!saved || typeof saved.text !== 'string') throw Error();
        sample = JSON.parse(saved.text);
        $('variable-sample-note').textContent = saved.note || '字段来自最近一次运行的输出。';
      } catch { $('variable-sample-note').textContent = '暂无有效 JSON 示例。可直接填写路径，或粘贴示例查看字段。'; }
      tree(); preview();
    }
    $('variable-source').onchange = sourceChanged;
    $('variable-path').oninput = preview;
    $('variable-close').onclick = $('variable-cancel').onclick = () => dialog.close();
    $('variable-parse').onclick = () => {
      try { sample = JSON.parse($('variable-sample').value); tree(); $('variable-sample-note').textContent = '字段来自手动粘贴的示例，不会加入工作流或执行请求。'; preview(); }
      catch { $('variable-error').textContent = '示例不是有效 JSON，请检查后重试。'; }
    };
    $('structured-variable-form').onsubmit = e => {
      e.preventDefault();
      if (!token()) return;
      try { FlowEngine.parseReference(token().slice(2, -2)); }
      catch (error) { $('variable-error').textContent = error.message; return; }
      onInsert(destination, token()); dialog.close();
    };
    dialog.addEventListener('close', () => { sample = undefined; $('variable-sample').value = ''; $('variable-tree').replaceChildren(); });
    return { open(target) {
      variables = getVariables(); destination = target;
      $('variable-source').replaceChildren(...variables.map((v, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = v.label + (v.type === 'json' ? ' · JSON' : ' · 文本 / JSON 内容'); return option; }));
      if (!variables.length) return;
      sourceChanged(); dialog.showModal(); $('variable-source').focus();
    } };
  }
  window.StructuredVariables = { init };
})();

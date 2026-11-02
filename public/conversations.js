(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  function mount({ appId, getVersion, getMode, notice, onChange, onSelect }) {
    let selected = '', busy = false, loading = false, available = false, epoch = 0;
    const url = '/api/published/' + encodeURIComponent(appId) + '/conversations';
    const key = () => `lingjing-conversation:${appId}:${getVersion()}:${getMode()}`;
    const enabled = () => $('app-memory').checked;
    const remember = () => { try { selected ? sessionStorage.setItem(key(), selected) : sessionStorage.removeItem(key()); } catch { notice('浏览器无法保存当前会话选择；刷新后可从列表重新选择。'); } };
    async function request(path, options) {
      const response = await fetch(url + path, options);
      const body = await response.json();
      if (!response.ok) throw Error(body.error || '会话操作失败。');
      return body;
    }
    function controls() {
      $('app-memory').disabled = busy || loading;
      $('app-conversation').disabled = busy || loading || !enabled() || !available;
      $('app-conversation-new').disabled = busy || loading || !enabled();
      $('app-conversation-delete').disabled = busy || loading || !enabled() || !selected || !available;
      $('app-dialogue').hidden = !enabled();
      $('app-conversation-note').textContent = !enabled() ? '本次独立运行，不读取或写入会话。' : loading ? '正在读取会话…' : !available ? '会话暂不可用，可关闭对话记忆后独立运行。' : !selected ? '发送后创建新会话。失败和取消不会加入对话。' : '上下文最多保留最近 10 轮完整对话，共 60000 字符；仅主流程模型使用，循环子流程按项独立。';
      onChange();
    }
    function render(conversation) {
      const parent = $('app-dialogue'); parent.replaceChildren();
      if (!conversation?.turns?.length) {
        const empty = document.createElement('p'); empty.className = 'runner-note'; empty.textContent = '尚无对话，发送第一条内容开始。'; parent.append(empty); return;
      }
      if (conversation.omittedTurns) {
        const note = document.createElement('p'); note.className = 'runner-note'; note.textContent = `已省略 ${conversation.omittedTurns} 轮较早对话。`; parent.append(note);
      }
      for (const turn of conversation.turns) {
        for (const [label, text, role] of [['你', turn.input, 'user'], ['助手', turn.output, 'assistant']]) {
          const row = document.createElement('article'); row.className = `conversation-message conversation-${role}`;
          const title = document.createElement('b'); title.textContent = label;
          const content = document.createElement('pre'); content.textContent = text;
          row.append(title, content); parent.append(row);
        }
        if (turn.outputTruncated) {
          const note = document.createElement('p'); note.className = 'runner-note'; note.textContent = '此条结果在会话中截断，不会加入模型上下文；完整结果请查看本次运行。'; parent.append(note);
        }
      }
      parent.scrollTop = parent.scrollHeight;
    }
    async function load(preferred) {
      const token = ++epoch; loading = true; available = false; selected = ''; render(null); controls();
      try {
        if (!getVersion()) return;
        const result = await request(`?version=${getVersion()}&mode=${encodeURIComponent(getMode())}`);
        if (token !== epoch) return;
        const select = $('app-conversation'), blank = document.createElement('option'); blank.value = ''; blank.textContent = '新会话';
        select.replaceChildren(blank);
        for (const item of result.conversations) {
          const option = document.createElement('option'); option.value = item.id;
          option.textContent = `${new Date(item.updatedAt).toLocaleString('zh-CN')} · ${item.turnCount} 轮`; select.append(option);
        }
        let target = preferred;
        if (target === undefined) { try { target = sessionStorage.getItem(key()); } catch { target = ''; } }
        if (result.conversations.some(c => c.id === target)) {
          const detail = await request('/' + encodeURIComponent(target));
          if (token !== epoch) return;
          selected = target; render(detail.conversation);
        }
        select.value = selected; available = true; remember();
      } catch (error) { if (token === epoch) notice(error.message); }
      finally { if (token === epoch) { loading = false; controls(); } }
    }
    $('app-memory').onchange = controls;
    $('app-conversation').onchange = () => { onSelect?.(); load($('app-conversation').value); };
    $('app-conversation-new').onclick = () => { selected = ''; $('app-conversation').value = ''; remember(); render(null); onSelect?.(); controls(); $('app-input').focus(); };
    $('app-conversation-delete').onclick = async () => {
      if (!selected || busy || loading || !confirm('删除此会话及对话内容？运行历史会保留。')) return;
      loading = true; controls();
      try { await request('/' + encodeURIComponent(selected), { method: 'DELETE' }); selected = ''; remember(); onSelect?.(); await load(''); }
      catch (error) { notice(error.message); }
      finally { loading = false; controls(); }
    };
    return {
      load,
      ready: () => !enabled() || (available && !loading),
      setBusy(value) { busy = value; controls(); },
      async begin() {
        if (!enabled()) return undefined;
        if (!available || loading) throw Error('请等待会话加载完成，或关闭对话记忆后独立运行。');
        if (!selected) {
          const result = await request('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: getVersion(), mode: getMode() }) });
          selected = result.conversation.id; remember();
        }
        return selected;
      },
      async refresh() { if (selected) await load(selected); },
    };
  }
  globalThis.FlowConversations = { mount };
})();

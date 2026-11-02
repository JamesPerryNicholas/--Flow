const { AppError } = require('./model-store.cjs');

function validateInput(model, { prompt, input, history = [] }) {
  if (!model.enabled) throw new AppError(400, '该模型已停用。');
  if (typeof prompt !== 'string' || typeof input !== 'string' || prompt.length + input.length > 200000) throw new AppError(400, '提示词和输入必须为文本，且总长度不超过 200000。');
  if (!Array.isArray(history) || history.length > 20 || history.length % 2 || history.some((m, i) => !m || m.role !== (i % 2 ? 'assistant' : 'user') || typeof m.content !== 'string')) throw new AppError(400, '对话上下文必须是完整的用户与助手消息对，最多 10 轮。');
  if (history.reduce((size, m) => size + m.content.length, prompt.length + input.length) > 200000) throw new AppError(400, '提示词、输入和对话上下文总长度不超过 200000。');
}

async function completion(model, { messages, tools, toolChoice = 'auto', signal, timeoutMs = 60000, fetchImpl = fetch }) {
  if (!model.enabled) throw new AppError(400, '该模型已停用。');
  if (Buffer.byteLength(JSON.stringify({ messages, tools })) > 800000) throw new AppError(400, '模型上下文过长，请减少输入或工具结果。');
  const url = model.baseUrl.endsWith('/chat/completions') ? model.baseUrl : `${model.baseUrl}/chat/completions`;
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  try {
    if (controller.signal.aborted) throw new AppError(499, '请求已取消。');
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}) },
      body: JSON.stringify({ model: model.model, messages, stream: false, ...(tools?.length ? { tools, tool_choice: toolChoice, parallel_tool_calls: false } : {}) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const message = response.status === 401 || response.status === 403 ? '模型认证失败，请检查 API Key 和权限。' : response.status === 429 ? '模型请求过于频繁或额度不足，请稍后重试。' : `模型服务返回错误（HTTP ${response.status}）。`;
      throw new AppError(502, message);
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) { controller.abort(); throw new AppError(502, '模型响应过大。'); }
      chunks.push(chunk);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError(502, '模型服务返回了无效的 JSON。'); }
    const message = data.choices?.[0]?.message;
    if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) throw new AppError(502, '模型服务未返回有效文本或工具调用。');
    // Redact echoes in text AND tool arguments before passing anything downstream.
    if (controller.signal.aborted) throw new AppError(timedOut ? 504 : 499, timedOut ? '模型请求超时，请稍后重试。' : '请求已取消。');
    return JSON.parse(JSON.stringify(message), (_key, value) => typeof value === 'string' && model.apiKey ? value.replaceAll(model.apiKey, '[已隐藏 API Key]') : value);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (timedOut) throw new AppError(504, '模型请求超时，请稍后重试。');
    if (signal?.aborted) throw new AppError(499, '请求已取消。');
    throw new AppError(502, '无法连接模型服务，请检查 API 地址和网络。');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

async function chat(model, options) {
  validateInput(model, options);
  const { prompt, input, history = [] } = options;
  const message = await completion(model, { ...options, messages: [{ role: 'system', content: prompt }, ...history.map(m => ({ role: m.role, content: m.content })), { role: 'user', content: input }] });
  if (typeof message.content !== 'string' || message.tool_calls?.length) throw new AppError(502, '模型服务未返回有效文本。');
  return message.content;
}

module.exports = { chat, completion, validateInput };

const { AppError } = require('./model-store.cjs');

async function chat(model, { prompt, input, signal, timeoutMs = 60000, fetchImpl = fetch }) {
  if (!model.enabled) throw new AppError(400, '该模型已停用。');
  if (typeof prompt !== 'string' || typeof input !== 'string' || prompt.length + input.length > 200000) throw new AppError(400, '提示词和输入必须为文本，且总长度不超过 200000。');
  const url = model.baseUrl.endsWith('/chat/completions') ? model.baseUrl : `${model.baseUrl}/chat/completions`;
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}) },
      body: JSON.stringify({ model: model.model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: input }], stream: false }),
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
    const output = data.choices?.[0]?.message?.content;
    if (typeof output !== 'string') throw new AppError(502, '模型服务未返回有效文本。');
    // Some compatibility servers echo request headers in their response text.
    return model.apiKey ? output.replaceAll(model.apiKey, '[已隐藏 API Key]') : output;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (timedOut) throw new AppError(504, '模型请求超时，请稍后重试。');
    if (signal?.aborted) throw new AppError(499, '请求已取消。');
    throw new AppError(502, '无法连接模型服务，请检查 API 地址和网络。');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

module.exports = { chat };

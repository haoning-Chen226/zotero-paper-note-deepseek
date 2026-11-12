var PaperNoteDeepSeek = (() => {
  const DEFAULT_BASE_URL = 'https://api.deepseek.com';
  const DEFAULT_MODEL = 'deepseek-flash';
  const DEFAULT_TIMEOUT_MS = 150_000;
  const MAX_RESPONSE_CHARS = 1_000_000;
  const HTTP_ERRORS = {
    400: '请检查 API 地址和模型配置。',
    401: '请检查 API 密钥。',
    402: '请检查 API 账号余额。',
    403: '请检查 API 密钥与账号的访问权限。',
    404: '请检查 API 地址与模型名称。',
    408: '服务器等待请求超时，请稍后重试。',
    422: '服务端拒绝了请求参数，请检查模型是否支持 JSON 输出。',
    429: '已达到请求速率或并发上限，请稍后重试。',
    503: '服务器繁忙，请稍后重试。',
  };

  function apiError(code, message, status) {
    const error = new Error(message);
    error.code = code;
    if (status !== undefined) error.status = status;
    return error;
  }

  function endpointFor(baseURL = DEFAULT_BASE_URL) {
    const input = baseURL.trim() || DEFAULT_BASE_URL;
    let url;
    try {
      url = new URL(input);
    } catch {
      throw apiError('invalid-url', '请输入有效的 API 地址。');
    }
    // 远程接口用 HTTPS，回环地址可供本机代理使用。
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw apiError('invalid-url', 'API 地址必须使用 HTTPS。本机代理也可以使用 HTTP。');
    }
    if (url.username || url.password || /[?#\s]/u.test(input)) {
      throw apiError('invalid-url', 'API 地址中不能包含凭据、查询参数、片段或空白字符。');
    }
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
    return url.href;
  }

  function parseCompletion(responseText) {
    if (responseText.length > MAX_RESPONSE_CHARS) {
      throw apiError('invalid-response', 'API 响应过大。');
    }

    let response;
    try {
      response = JSON.parse(responseText);
    } catch {
      throw apiError('invalid-response', 'API 返回了无法读取的响应，请检查 API 地址。');
    }

    const choice = response?.choices?.[0];
    if (choice?.finish_reason === 'length') {
      throw apiError('incomplete', '模型输出达到长度限制，未能生成完整笔记。');
    }
    if (choice?.finish_reason === 'content_filter') {
      throw apiError('incomplete', '服务端内容过滤中断了生成。');
    }
    if (choice?.finish_reason && choice.finish_reason !== 'stop') {
      throw apiError('incomplete', '服务端中断了生成，请稍后重试。');
    }
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw apiError('empty-output', '模型未返回笔记内容，请重试。');
    }

    let note;
    try {
      note = JSON.parse(content);
    } catch {
      throw apiError('invalid-output', '模型返回的笔记格式无法读取，请重试。');
    }
    if (!note || typeof note !== 'object' || Array.isArray(note)) {
      throw apiError('invalid-output', '模型返回的笔记格式无法读取，请重试。');
    }
    return note;
  }

  async function complete({
    baseURL = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    apiKey,
    messages,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
  }) {
    if (signal?.aborted) throw apiError('cancelled', '请求已取消。');
    const key = apiKey?.trim();
    if (!key || /[^\x21-\x7e]/u.test(key)) {
      throw apiError('invalid-key', '请填写有效的 API 密钥。');
    }
    const modelName = model.trim() || DEFAULT_MODEL;
    const endpoint = endpointFor(baseURL);
    const body = {
      model: modelName,
      messages,
      response_format: { type: 'json_object' },
      max_tokens: 4096,
      stream: false,
    };
    // DeepSeek 官方接口接受 thinking 参数，兼容代理只收到通用字段。
    if (new URL(endpoint).origin === DEFAULT_BASE_URL) {
      body.thinking = { type: 'disabled' };
    }

    const controller = typeof newPaperNoteAbortController === 'function'
      ? newPaperNoteAbortController()
      : new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, timeoutMs);
    try {
      let response;
      let responseText;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          // 不附带隐式登录凭据，重定向也须由用户修改地址后重试。
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal,
        });
        if (response.ok) responseText = await response.text();
      } catch {
        if (signal?.aborted) throw apiError('cancelled', '请求已取消。');
        if (controller.signal.aborted) throw apiError('timeout', 'API 请求超时，请稍后重试。');
        throw apiError('network', '无法连接 API，请检查网络及 API 地址。');
      }
      if (!response.ok) {
        const status = response.status;
        const advice = HTTP_ERRORS[status] || '请检查配置或稍后重试。';
        throw apiError('http', `API 请求失败（HTTP ${status}）。${advice}`, status);
      }
      return parseCompletion(responseText);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  return { DEFAULT_BASE_URL, DEFAULT_MODEL, endpointFor, complete };
})();

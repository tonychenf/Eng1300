const TOKEN_KEY = 'eng1300_token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* 隐私模式下 localStorage 不可用，退化为仅本次会话有效 */ }
}

// 401 时广播，让 AuthProvider 统一清理登录态
function broadcastUnauthorized() {
  window.dispatchEvent(new CustomEvent('eng1300:unauthorized'));
}

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.message || payload?.error || `请求失败（${status}）`);
    this.status = status;
    this.code = payload?.error;
    this.payload = payload;
  }
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  // raw=true 的请求直接发二进制 body（上传原始资料）。不加这个判断的话，
  // 下面会把一个 File 对象 JSON.stringify 成 "{}" 发出去——服务端收到空 body，
  // 报的是"没有收到文件内容"，而浏览器这边看起来文件明明选上了。
  if (!options.raw && options.body !== undefined && typeof options.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    options = { ...options, body: JSON.stringify(options.body) };
  }

  const res = await fetch(`/api${path}`, { ...options, headers });
  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { message: text.slice(0, 200) }; }
  }

  if (!res.ok) {
    if (res.status === 401 && token) broadcastUnauthorized();
    throw new ApiError(res.status, payload);
  }
  return payload;
}

export const get = (path) => api(path);
export const post = (path, body) => api(path, { method: 'POST', body: body ?? {} });
export const put = (path, body) => api(path, { method: 'PUT', body: body ?? {} });
export const patch = (path, body) => api(path, { method: 'PATCH', body: body ?? {} });
/** 发二进制 body，不做 JSON 序列化。上传 docx 等原始资料用。 */
export const postRaw = (path, body) =>
  api(path, { method: 'POST', body, raw: true, headers: { 'Content-Type': 'application/octet-stream' } });

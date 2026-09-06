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
  if (options.body !== undefined && typeof options.body !== 'string') {
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

// AI API Key 的对称加密存储。密钥来自 Worker secret ENCRYPTION_KEY，
// 明文 Key 只在服务端内存中短暂存在，绝不下发到前端（PRD §5.4 安全要求）。

async function deriveKey(secret) {
  const material = new TextEncoder().encode(secret);
  const hash = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plaintext, secret) {
  if (!plaintext) return null;
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const out = new Uint8Array(iv.length + cipher.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(cipher), iv.length);
  return btoa(String.fromCharCode(...out));
}

export async function decryptSecret(stored, secret) {
  if (!stored) return null;
  try {
    const raw = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    const iv = raw.slice(0, 12);
    const cipher = raw.slice(12);
    const key = await deriveKey(secret);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

// 展示用脱敏：sk-abcdef...1234 -> sk-****1234
export function maskSecret(plaintext) {
  if (!plaintext) return null;
  if (plaintext.length <= 8) return '****';
  return `${plaintext.slice(0, 3)}****${plaintext.slice(-4)}`;
}

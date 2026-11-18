// One axios instance for the whole app: base URL, auth header, and readable errors.
import axios from 'axios';

const BASE = (import.meta.env.VITE_API_URL || '') + '/api';
export const api = axios.create({ baseURL: BASE });

const TOKEN_KEY = 'samay.token';
export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY)),
};

api.interceptors.request.use((config) => {
  const t = tokenStore.get();
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401 && !err.config.url.startsWith('/auth/')) onUnauthorized();
    return Promise.reject(err);
  },
);

/** The message to show a person for any failed request. */
export function errorMessage(err) {
  if (!err.response) return 'Cannot reach the server. Check that the API is running.';
  return err.response.data?.error || `Request failed (${err.response.status})`;
}

/**
 * Read a Server-Sent Events stream with fetch (EventSource can't send the auth header).
 * Calls onEvent(name, data) for each event; resolves when the server closes the stream.
 */
export async function readEventStream(path, onEvent, signal) {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${tokenStore.get()}` }, signal });
  if (!res.ok || !res.body) throw new Error(`Progress stream failed (${res.status})`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const name = chunk.match(/^event: (.*)$/m)?.[1] || 'message';
      const data = chunk.match(/^data: (.*)$/m)?.[1];
      if (data) onEvent(name, JSON.parse(data));
    }
  }
}

/** Download a file from an authenticated endpoint. */
export async function download(path, fallbackName) {
  const res = await api.get(path, { responseType: 'blob' });
  const name = res.headers['content-disposition']?.match(/filename="?([^"]+)"?/)?.[1] || fallbackName;
  const url = URL.createObjectURL(res.data);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

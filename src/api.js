// When the frontend and backend are deployed to different domains (e.g. Vercel + Railway),
// set VITE_API_BASE at build time to the backend's full origin. Empty = same-origin (local dev).
const BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');

// Prefixes a backend-relative path (e.g. "/media/...") with BASE; leaves absolute URLs (YouTube thumbnails) untouched.
const url = (path) => (!path || /^https?:\/\//i.test(path) ? path : `${BASE}${path}`);

async function request(path, options = {}) {
  const response = await fetch(url(path), {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.status === 204 ? null : response.json();
}

async function errorMessage(response) {
  try {
    const body = await response.json();
    const text = detailText(body.detail);
    if (text) return text;
  } catch {
    // Non-JSON error bodies fall through to the generic message.
  }
  return response.status >= 500 ? 'The ClipLabs server is not responding' : `Request failed (${response.status})`;
}

function uploadVideo(file, mode, options, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    form.append('mode', mode);
    form.append('options', JSON.stringify(options));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url('/api/projects/upload'));
    xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(event.loaded / event.total);
    xhr.onerror = () => reject(new Error('Upload failed. Is the backend running?'));
    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Handled below via status code.
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(detailText(body?.detail) || `Upload failed (${xhr.status})`));
    };
    xhr.send(form);
  });
}

function detailText(detail) {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail[0]?.msg) return detail[0].msg.replace(/^Value error,\s*/i, '');
  return '';
}

const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const api = {
  health: () => request('/api/health'),
  youtubeInfo: (url) => request(`/api/youtube/info?url=${encodeURIComponent(url)}`),
  listProjects: () => request('/api/projects'),
  getProject: (id) => request(`/api/projects/${id}`),
  getAnalysis: (id) => request(`/api/projects/${id}/analysis`),
  createProject: (url, mode, options) => post('/api/projects', { url, mode, options }),
  uploadVideo,
  cancelProject: (id) => post(`/api/projects/${id}/cancel`),
  retryProject: (id) => post(`/api/projects/${id}/retry`),
  deleteProject: (id) => request(`/api/projects/${id}`, { method: 'DELETE' }),
  updateClip: (id, patch) => request(`/api/clips/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteClip: (id) => request(`/api/clips/${id}`, { method: 'DELETE' }),
  duplicateClip: (id) => post(`/api/clips/${id}/duplicate`),
  downloadUrl: (id) => url(`/api/clips/${id}/download`),
  fileUrl: (id) => url(`/api/projects/${id}/file`),
  zipUrl: (id, clipIds) => url(`/api/projects/${id}/zip${clipIds?.length ? `?clips=${clipIds.join(',')}` : ''}`),
  url,
};

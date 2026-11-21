export const TERMINAL = new Set(['done', 'failed', 'cancelled']);

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

export function isYouTubeUrl(value) {
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
    return ['http:', 'https:'].includes(url.protocol) && YOUTUBE_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Parses "83", "1:23", "1:23.5" or "1:02:03" into seconds; returns NaN when invalid. */
export function parseTime(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(text)) return NaN;
  return text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

export function clock(seconds = 0) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

export function elapsedSeconds(startIso, endIso) {
  if (!startIso) return 0;
  return Math.max(0, ((endIso ? new Date(endIso) : new Date()) - new Date(startIso)) / 1000);
}

export function estimateRemaining(progress, elapsed) {
  if (progress < 8 || elapsed < 5) return null;
  return (elapsed * (100 - progress)) / progress;
}

export function navigate(path) {
  window.location.hash = path;
}

export function formatTime(seconds = 0) {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = (total % 60).toFixed(1).padStart(4, '0');
  return `${minutes}:${rest}`;
}

export function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function timeAgo(iso) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function isProcessing(project) {
  return !TERMINAL.has(project.status) || (project.clips || []).some((clip) => clip.status === 'queued' || clip.status === 'rendering');
}

import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { formatTime } from '../utils';
import { aspectRatio, Breakdown } from './ClipCard';

export default function PlayerModal({ clips, index, project, onClose, onNavigate, onEdit, notify }) {
  const clip = clips[index];
  const video = useRef(null);
  const [silent, setSilent] = useState(false);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight' && index < clips.length - 1) onNavigate(1);
      if (event.key === 'ArrowLeft' && index > 0) onNavigate(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clips.length, index, onClose, onNavigate]);

  useEffect(() => {
    setSilent(false);
    const el = video.current;
    if (!el) return undefined;

    el.muted = false;
    el.volume = 1;
    const startAudio = () => {
      el.muted = false;
      el.volume = 1;
      el.play().catch(() => {});
    };

    el.addEventListener('loadedmetadata', startAudio, { once: true });
    el.addEventListener('canplay', startAudio, { once: true });

    // Some embedded Chromium builds (e.g. VS Code's browser) can't decode AAC; detect it instead of looking broken.
    const timer = window.setTimeout(() => {
      if (el && !el.paused && !el.muted && el.currentTime > 1 && el.webkitAudioDecodedByteCount === 0) setSilent(true);
    }, 2500);

    return () => {
      window.clearTimeout(timer);
      el.removeEventListener('loadedmetadata', startAudio);
      el.removeEventListener('canplay', startAudio);
    };
  }, [clip?.id]);

  if (!clip) return null;

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`${label} copied`);
    } catch {
      notify('Clipboard access was blocked', 'error');
    }
  };
  const hashtags = (clip.hashtags || []).join(' ');
  const everything = [clip.title, clip.description, hashtags].filter(Boolean).join('\n\n');

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal player-modal" role="dialog" aria-modal="true" aria-label={clip.title}>
        <div className="player-stage">
          <button className="nav-arrow left" onClick={() => onNavigate(-1)} disabled={index === 0} aria-label="Previous clip">‹</button>
          <video key={clip.id} ref={video} src={api.url(clip.video_url)} poster={api.url(clip.thumb_url) || undefined} controls autoPlay playsInline style={{ aspectRatio: aspectRatio(clip, project) }} />
          <button className="nav-arrow right" onClick={() => onNavigate(1)} disabled={index === clips.length - 1} aria-label="Next clip">›</button>
          {silent && <p className="audio-hint">No sound? This browser can’t play AAC audio. Open ClipLabs in Chrome or Safari, or just download the clip.</p>}
        </div>
        <aside className="player-info">
          <div className="modal-head plain">
            <p className="kicker">CLIP {index + 1} OF {clips.length}</p>
            <button className="icon-button" onClick={onClose} aria-label="Close player">×</button>
          </div>
          <h2>{clip.title}</h2>
          <p className="clip-time">{formatTime(clip.start)} – {formatTime(clip.end)} · {Math.round(clip.duration)}s</p>
          {project.mode === 'clips' && (
            <div className="score-row">
              <div className="score-big"><b>{Math.round(clip.score)}</b><small>virality</small></div>
              {clip.score_breakdown && <Breakdown breakdown={clip.score_breakdown} />}
            </div>
          )}
          {clip.reason && <p className="clip-reason">{clip.reason}</p>}
          <div className="copy-block">
            <CopyRow label="Title" value={clip.title} onCopy={copy} />
            {clip.description && <CopyRow label="Description" value={clip.description} onCopy={copy} />}
            {hashtags && <CopyRow label="Hashtags" value={hashtags} onCopy={copy} />}
          </div>
          <div className="player-actions">
            <button className="btn" onClick={() => copy(everything, 'Post text')}>Copy all</button>
            <button className="btn" onClick={onEdit}>Edit clip</button>
            <a className="btn primary" href={api.downloadUrl(clip.id)} download>Download ↓</a>
          </div>
        </aside>
      </div>
    </div>
  );
}

function CopyRow({ label, value, onCopy }) {
  return (
    <div className="copy-row">
      <span>{label}</span>
      <p>{value}</p>
      <button className="btn icon" onClick={() => onCopy(value, label)} aria-label={`Copy ${label}`} title={`Copy ${label}`}>⧉</button>
    </div>
  );
}

import React, { useRef } from 'react';
import { api } from '../api';
import { formatTime } from '../utils';

export function aspectRatio(clip, project) {
  if (clip.aspect === 'original') return project.width && project.height ? `${project.width} / ${project.height}` : '16 / 9';
  return clip.aspect.replace(':', ' / ');
}

export default function ClipCard({ clip, project, rank, onOpen, onEdit, onDuplicate, onDelete, canEdit }) {
  const video = useRef(null);
  const busy = clip.status === 'queued' || clip.status === 'rendering';
  const ready = clip.status === 'ready' && clip.video_url;

  const startPreview = () => {
    if (!video.current) return;
    video.current.muted = true;
    video.current.play().catch(() => {});
  };
  const stopPreview = () => {
    if (!video.current) return;
    video.current.pause();
    video.current.currentTime = 0;
  };

  return (
    <article className="clip-card">
      <div
        className="clip-video"
        style={{ aspectRatio: aspectRatio(clip, project) }}
        onMouseEnter={ready ? startPreview : undefined}
        onMouseLeave={ready ? stopPreview : undefined}
        onClick={ready ? onOpen : undefined}
        role={ready ? 'button' : undefined}
        tabIndex={ready ? 0 : undefined}
        onKeyDown={(e) => ready && e.key === 'Enter' && onOpen()}
        aria-label={ready ? `Play ${clip.title}` : undefined}
      >
        {ready ? (
          <>
            <video ref={video} src={api.url(clip.video_url)} poster={api.url(clip.thumb_url) || undefined} muted loop playsInline preload="none" />
            <span className="play-badge" aria-hidden="true">▶</span>
          </>
        ) : (
          <div className="clip-placeholder" style={clip.thumb_url ? { backgroundImage: `url(${api.url(clip.thumb_url)})` } : undefined}>
            {busy && <div className="spinner-wrap"><span className="spinner" />{clip.status === 'queued' ? 'Waiting to render' : 'Rendering…'}</div>}
            {clip.status === 'failed' && <div className="spinner-wrap error">{clip.error === 'Cancelled' ? 'Cancelled' : 'Render failed'}</div>}
          </div>
        )}
        {project.mode === 'clips' && <span className="rank">#{rank}</span>}
        {project.mode === 'clips' && <span className="score" title="Virality score">{Math.round(clip.score)}</span>}
      </div>
      <div className="clip-body">
        <p className="clip-time">{formatTime(clip.start)} – {formatTime(clip.end)} · {Math.round(clip.duration)}s · {clip.aspect === 'original' ? 'Original' : clip.aspect}</p>
        {clip.status === 'failed' && clip.error && clip.error !== 'Cancelled' && <p className="clip-error">{clip.error}</p>}
        <div className="clip-actions">
          {ready ? <a className="btn primary clip-download-icon" href={api.downloadUrl(clip.id)} download aria-label="Download clip" title="Download clip">↓</a> : <span className="btn disabled clip-download-icon" aria-label="Download unavailable">↓</span>}
          <button className="btn" onClick={onEdit} disabled={!canEdit || busy}>Edit</button>
          <button className="btn icon" onClick={onDuplicate} disabled={!ready} title="Duplicate clip" aria-label="Duplicate clip">⧉</button>
          <button className="btn icon" onClick={onDelete} disabled={busy} title="Delete clip" aria-label="Delete clip">🗑</button>
        </div>
      </div>
    </article>
  );
}

const LABELS = { hook: 'Hook', energy: 'Energy', pacing: 'Pacing', visuals: 'Visuals' };

export function MiniBreakdown({ breakdown }) {
  return (
    <div className="mini-breakdown" aria-label="Score breakdown">
      {Object.entries(LABELS).map(([key, label]) => (
        <span key={key} title={`${label}: ${breakdown[key] ?? 0}/100`}>
          <i style={{ width: `${breakdown[key] ?? 0}%` }} />
          {label}
        </span>
      ))}
    </div>
  );
}

export function Breakdown({ breakdown }) {
  return (
    <div className="breakdown">
      {Object.entries(LABELS).map(([key, label]) => (
        <div key={key}>
          <span>{label}</span>
          <div className="bar"><i style={{ width: `${breakdown[key] ?? 0}%` }} /></div>
          <b>{breakdown[key] ?? 0}</b>
        </div>
      ))}
    </div>
  );
}

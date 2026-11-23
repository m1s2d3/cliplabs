import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { clock, elapsedSeconds, estimateRemaining } from '../utils';

function stagesFor(project) {
  const youtube = project.source_type === 'youtube';
  if (project.mode === 'download') return [['downloading', 'Download']];
  if (project.mode === 'cut') {
    return [
      ...(youtube ? [['downloading', 'Download']] : []),
      ...(project.options.captions ? [['transcribing', 'Transcribe']] : []),
      ['rendering', 'Render cut'],
    ];
  }
  return [...(youtube ? [['downloading', 'Download']] : []), ['transcribing', 'Transcribe'], ['analyzing', 'Find moments'], ['rendering', 'Render clips']];
}

export default function ProgressCard({ project, onCancel }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const stages = stagesFor(project);
  const stageIndex = stages.findIndex(([key]) => key === project.status);
  const current = Math.max(0, stageIndex);
  const activeStage = stages[current]?.[1] || 'Preparing';
  const elapsed = elapsedSeconds(project.started_at);
  const remaining = estimateRemaining(project.progress, elapsed);
  const queued = project.status === 'queued';

  return (
    <section className="progress-card">
      <div className="progress-content">
        <div className="progress-details">
          <div className="progress-kicker"><span className="progress-live-dot" />{queued ? 'Queued' : 'In progress'}<span>Step {current + 1} of {stages.length}</span></div>
          <div className="progress-top">
            <strong>{project.message || 'Working…'}</strong>
            <span>{Math.round(project.progress)}%</span>
          </div>
          <div className="progress-bar"><span style={{ width: `${Math.max(3, project.progress)}%` }} /></div>
          <div className="progress-meta">
            <span>{queued ? 'Waiting for the previous job to finish' : `Elapsed ${clock(elapsed)}`}{remaining ? ` · about ${clock(remaining)} left` : ''}</span>
            <button className="btn danger" onClick={onCancel} disabled={project.cancel_requested}>{project.cancel_requested ? 'Cancelling…' : 'Cancel'}</button>
          </div>
          <ol className="stage-steps">
            {stages.map(([key, label], index) => (
              <li key={key} className={index < current ? 'done' : index === current ? (queued ? 'queued' : 'current') : ''}><i>{index < current ? '✓' : index + 1}</i>{label}</li>
            ))}
          </ol>
          <p className="hint">You can leave this page. Processing continues in the background.</p>
        </div>
        <div className="progress-visual" style={project.thumbnail ? { '--progress-image': `url("${api.url(project.thumbnail)}")` } : undefined}>
          <div className="progress-visual-overlay" />
          <span className="progress-visual-label">{activeStage}</span>
          <div className="progress-activity-bars" aria-label={`${activeStage} in progress`}>
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((bar) => <i key={bar} style={{ '--bar-index': bar }} />)}
          </div>
          <span className="progress-visual-caption">{queued ? 'Starting soon' : 'Working on your video'}</span>
        </div>
      </div>
    </section>
  );
}

import { useEffect, useState } from 'react';
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
  const current = stages.findIndex(([key]) => key === project.status);
  const elapsed = elapsedSeconds(project.started_at);
  const remaining = estimateRemaining(project.progress, elapsed);
  const queued = project.status === 'queued';

  return (
    <section className="progress-card">
      <div className="progress-top">
        <strong>{project.message || 'Working…'}</strong>
        <span>{Math.round(project.progress)}%</span>
      </div>
      <div className="progress-bar"><span style={{ width: `${Math.max(3, project.progress)}%` }} /></div>
      <div className="progress-meta">
        <span>{queued ? 'Waiting for the previous job to finish' : `Elapsed ${clock(elapsed)}`}{remaining ? ` · about ${clock(remaining)} left` : ''}</span>
        <button className="btn danger" onClick={onCancel} disabled={project.cancel_requested}>{project.cancel_requested ? 'Cancelling…' : 'Cancel'}</button>
      </div>
      {stages.length > 1 && (
        <ol className="stage-steps">
          {stages.map(([key, label], index) => (
            <li key={key} className={index < current ? 'done' : index === current ? 'current' : ''}><i>{index < current ? '✓' : index + 1}</i>{label}</li>
          ))}
        </ol>
      )}
      <p className="hint">You can leave this page. Processing continues in the background, and the tab title shows ✓ when it’s done.</p>
    </section>
  );
}

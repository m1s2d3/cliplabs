import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import ClipCard from '../components/ClipCard';
import ClipEditor from '../components/ClipEditor';
import DownloadResult from '../components/DownloadResult';
import PlayerModal from '../components/PlayerModal';
import ProgressCard from '../components/ProgressCard';
import SourceTimeline from '../components/SourceTimeline';
import { LANGUAGES, MODE_LABELS, STATUS_LABELS } from '../constants';
import { clock, elapsedSeconds, formatDuration, isProcessing, TERMINAL } from '../utils';

const SORTS = {
  score: { label: 'Best score', fn: (a, b) => b.score - a.score },
  time: { label: 'Timeline order', fn: (a, b) => a.start - b.start },
  length: { label: 'Shortest first', fn: (a, b) => a.duration - b.duration },
};

export default function ProjectDetail({ id, notify }) {
  const [project, setProject] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [playing, setPlaying] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [sort, setSort] = useState('score');
  const [analysis, setAnalysis] = useState(null);

  const load = useCallback(async () => {
    try {
      setProject(await api.getProject(id));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const active = project ? isProcessing(project) : false;
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => { if (!document.hidden) load(); }, 2000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const status = project?.status;
  useEffect(() => {
    if (project && project.mode !== 'download' && ['analyzing', 'rendering', 'done'].includes(status)) {
      api.getAnalysis(id).then(setAnalysis).catch(() => setAnalysis(null));
    }
  }, [id, status, project?.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!project) return undefined;
    const base = project.title.length > 40 ? `${project.title.slice(0, 40)}…` : project.title;
    const prefix = project.status === 'done' ? '✓ ' : project.status === 'failed' ? '⚠ ' : TERMINAL.has(project.status) ? '' : `${Math.round(project.progress)}% · `;
    document.title = `${prefix}${base} · ClipLabs`;
    return () => {
      document.title = 'ClipLabs | AI Short-form Studio';
    };
  }, [project]);

  const clips = useMemo(() => (project ? [...project.clips].sort(SORTS[sort].fn) : []), [project, sort]);
  const readyClips = clips.filter((clip) => clip.status === 'ready');
  const rankById = useMemo(() => new Map((project?.clips || []).map((clip, index) => [clip.id, index + 1])), [project]);

  if (!project) {
    return (
      <main className="page">
        {error ? <div className="empty"><h2>Project unavailable</h2><p>{error}</p><a className="get-clips" href="#/projects">Back to projects</a></div> : <div className="empty">Loading project…</div>}
      </main>
    );
  }

  const finished = TERMINAL.has(project.status);
  const updateClip = (clip) => setProject((p) => ({ ...p, clips: p.clips.map((c) => (c.id === clip.id ? clip : c)) }));

  const onSaved = (clip) => {
    setEditing(null);
    updateClip(clip);
    notify(clip.status === 'queued' ? 'Re-rendering your clip…' : 'Clip updated');
  };

  const run = async (action, message) => {
    try {
      const result = await action();
      if (message) notify(message);
      return result;
    } catch (err) {
      notify(err.message, 'error');
      return null;
    }
  };

  const cancel = async () => {
    const result = await run(() => api.cancelProject(project.id), 'Cancelling…');
    if (result) setProject(result);
  };
  const retry = async () => {
    const result = await run(() => api.retryProject(project.id), 'Trying again');
    if (result) {
      setSelected(new Set());
      setProject(result);
    }
  };
  const duplicate = async (clip) => {
    const copy = await run(() => api.duplicateClip(clip.id), 'Clip duplicated');
    if (copy) setProject((p) => ({ ...p, clips: [...p.clips, copy] }));
  };
  const remove = async (clip) => {
    if (!window.confirm(`Delete "${clip.title}"?`)) return;
    const ok = await run(() => api.deleteClip(clip.id).then(() => true), 'Clip deleted');
    if (ok) {
      setProject((p) => ({ ...p, clips: p.clips.filter((c) => c.id !== clip.id) }));
      setSelected((s) => new Set([...s].filter((x) => x !== clip.id)));
    }
  };
  const toggle = (clipId) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(clipId)) next.delete(clipId);
    else next.add(clipId);
    return next;
  });
  const allSelected = readyClips.length > 0 && readyClips.every((clip) => selected.has(clip.id));
  const playIndex = playing ? readyClips.findIndex((clip) => clip.id === playing) : -1;
  const language = LANGUAGES.find(([key]) => key === project.language)?.[1] || project.language;
  const took = project.finished_at && project.started_at ? clock(elapsedSeconds(project.started_at, project.finished_at)) : null;
  const options = project.options;
  const range = options.range_start != null || options.range_end != null ? [options.range_start || 0, options.range_end || project.duration] : null;

  return (
    <main className="page">
      <div className="page-head">
        <div className="head-with-thumb">
          {project.thumbnail && <img className="head-thumb" src={api.url(project.thumbnail)} alt="" referrerPolicy="no-referrer" />}
          <div>
            <a className="back-link" href="#/projects">← All projects</a>
            <h1 className="project-title">{project.title}</h1>
            <p className="project-meta">
              <span className="mode-badge">{MODE_LABELS[project.mode]}</span>
              {project.source_type === 'youtube' ? <a href={project.source_url} target="_blank" rel="noreferrer">{project.channel || 'YouTube'} ↗</a> : 'Uploaded video'}
              {project.duration ? ` · ${formatDuration(project.duration)}` : ''}
              {project.mode === 'clips' && ` · ${options.clip_count} clips, ${options.min_length}–${options.max_length}s`}
              {project.mode === 'cut' && ` · ${clock(options.start)}–${clock(options.end)}`}
              {language && ` · ${language}`}
              {took && ` · took ${took}`}
            </p>
          </div>
        </div>
        <span className={`status-pill large ${project.status}`}>{STATUS_LABELS[project.status]}</span>
      </div>

      {!finished && <ProgressCard project={project} onCancel={cancel} />}

      {(project.status === 'failed' || project.status === 'cancelled') && (
        <div className={`notice ${project.status === 'failed' ? 'error' : ''}`}>
          <strong>{project.status === 'failed' ? 'Processing failed.' : 'You cancelled this project.'}</strong> {project.error}
          <div className="notice-actions"><button className="btn primary" onClick={retry}>↻ Try again</button><a className="btn" href="#/">New project</a></div>
        </div>
      )}

      {project.mode === 'download' && project.status === 'done' && <DownloadResult project={project} />}

      {project.mode !== 'download' && project.clips.length > 0 && (
        <section>
          {project.mode === 'clips' && <SourceTimeline duration={project.duration} clips={project.clips} waveform={analysis?.waveform} range={range} onOpen={setPlaying} />}
          {analysis && analysis.reliable === false && project.mode === 'clips' && (
            <p className="notice subtle">The speech in this video was hard to transcribe (music or an unexpected language), so titles use the video name. For songs, try the <b>Music</b> content type; for speech, pick the language under Advanced options.</p>
          )}
          <div className="clips-toolbar">
            <h2>{project.status === 'done' ? `${readyClips.length} ${project.mode === 'cut' ? 'cut' : 'clips'} ready` : 'Your clips'}</h2>
            <div className="toolbar-actions">
              {project.clips.length > 1 && (
                <label className="sort">Sort<select value={sort} onChange={(e) => setSort(e.target.value)}>{Object.entries(SORTS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
              )}
              {readyClips.length > 1 && (
                <button className="btn" onClick={() => setSelected(allSelected ? new Set() : new Set(readyClips.map((c) => c.id)))}>{allSelected ? 'Clear selection' : 'Select all'}</button>
              )}
              {readyClips.length > 0 && (
                <a className="btn primary" href={api.zipUrl(project.id, [...selected])} download>
                  {selected.size ? `Download ${selected.size} as ZIP` : 'Download all (ZIP)'}
                </a>
              )}
            </div>
          </div>
          <div className={`clip-grid ${project.mode === 'cut' ? 'single' : ''}`}>
            {clips.map((clip) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                project={project}
                rank={rankById.get(clip.id)}
                selected={selected.has(clip.id)}
                onSelect={() => toggle(clip.id)}
                onOpen={() => setPlaying(clip.id)}
                onEdit={() => setEditing(clip)}
                onDuplicate={() => duplicate(clip)}
                onDelete={() => remove(clip)}
                canEdit={finished}
              />
            ))}
          </div>
        </section>
      )}

      {playIndex >= 0 && (
        <PlayerModal
          clips={readyClips}
          index={playIndex}
          project={project}
          notify={notify}
          onClose={() => setPlaying(null)}
          onNavigate={(step) => setPlaying(readyClips[Math.min(readyClips.length - 1, Math.max(0, playIndex + step))].id)}
          onEdit={() => { setEditing(readyClips[playIndex]); setPlaying(null); }}
        />
      )}
      {editing && <ClipEditor clip={editing} project={project} analysis={analysis} onClose={() => setEditing(null)} onSaved={onSaved} notify={notify} />}
    </main>
  );
}

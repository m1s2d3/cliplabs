import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { MODE_LABELS, STATUS_LABELS } from '../constants';
import { formatDuration, navigate, timeAgo, TERMINAL } from '../utils';

const FILTERS = [
  ['all', 'All'],
  ['active', 'In progress'],
  ['done', 'Ready'],
  ['problem', 'Failed / cancelled'],
];

function matchesFilter(project, filter) {
  if (filter === 'active') return !TERMINAL.has(project.status);
  if (filter === 'done') return project.status === 'done';
  if (filter === 'problem') return project.status === 'failed' || project.status === 'cancelled';
  return true;
}

function summary(project) {
  if (project.mode === 'download') return `${project.options.kind === 'audio' ? 'Audio' : 'Video'} download`;
  if (project.mode === 'cut') return 'Manual cut';
  return `${project.clip_count} clips`;
}

export default function Projects({ notify }) {
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [mode, setMode] = useState('all');

  const load = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const anyActive = projects?.some((p) => !TERMINAL.has(p.status));
  useEffect(() => {
    if (!anyActive) return undefined;
    const timer = window.setInterval(() => { if (!document.hidden) load(); }, 3000);
    return () => window.clearInterval(timer);
  }, [anyActive, load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (projects || []).filter((p) => matchesFilter(p, filter) && (mode === 'all' || p.mode === mode) && (!needle || `${p.title} ${p.channel || ''}`.toLowerCase().includes(needle)));
  }, [projects, query, filter, mode]);

  const remove = async (event, project) => {
    event.stopPropagation();
    if (!window.confirm(`Delete "${project.title}" and all of its clips?`)) return;
    try {
      await api.deleteProject(project.id);
      setProjects((list) => list.filter((p) => p.id !== project.id));
      notify('Project deleted');
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <div><p className="kicker">YOUR WORKSPACE</p><h1>Projects</h1></div>
        <button className="get-clips" onClick={() => navigate('/')}>New project <b>↗</b></button>
      </div>
      {error && <div className="notice error">{error}. Make sure the backend is running (<code>npm run backend</code>).</div>}
      {projects === null && !error && <div className="empty">Loading projects…</div>}
      {projects?.length === 0 && (
        <div className="empty">
          <h2>No projects yet</h2>
          <p>Paste a YouTube link or upload a video to generate your first clips.</p>
          <button className="get-clips" onClick={() => navigate('/')}>Create clips <b>↗</b></button>
        </div>
      )}
      {projects?.length > 0 && (
        <div className="library-toolbar">
          <input type="search" placeholder="Search projects…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search projects" />
          <div className="segmented" role="radiogroup" aria-label="Filter by status">
            {FILTERS.map(([key, label]) => <button key={key} type="button" role="radio" aria-checked={filter === key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>)}
          </div>
          <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Filter by type">
            <option value="all">All types</option>
            {Object.entries(MODE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </div>
      )}
      {projects?.length > 0 && visible.length === 0 && <div className="empty">No projects match your filters.</div>}
      {visible.length > 0 && (
        <div className="projects-grid">
          {visible.map((project) => (
            <article key={project.id} className="project-card" onClick={() => navigate(`/projects/${project.id}`)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(`/projects/${project.id}`)}>
              <div className="project-thumb">
                {project.thumb_url || project.thumbnail ? <img src={api.url(project.thumb_url || project.thumbnail)} alt="" referrerPolicy="no-referrer" /> : <div className="thumb-placeholder">{project.source_type === 'youtube' ? '▶' : '⬆'}</div>}
                <span className={`status-pill ${project.status}`}>{STATUS_LABELS[project.status]}{!TERMINAL.has(project.status) && ` · ${Math.round(project.progress)}%`}</span>
                <span className="mode-badge floating">{MODE_LABELS[project.mode]}</span>
              </div>
              <div className="project-body">
                <h3 title={project.title}>{project.title}</h3>
                <p>{summary(project)} · {formatDuration(project.duration)} · {timeAgo(project.created_at)}</p>
              </div>
              {TERMINAL.has(project.status) && <button className="icon-button" aria-label="Delete project" title="Delete project" onClick={(e) => remove(e, project)}>🗑</button>}
            </article>
          ))}
        </div>
      )}
    </main>
  );
}

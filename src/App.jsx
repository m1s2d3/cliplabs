import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import Landing from './pages/Landing';
import ProjectDetail from './pages/ProjectDetail';
import Projects from './pages/Projects';
import { registerServiceWorker, useOnlineStatus } from './pwa';
import { STATUS_LABELS } from './constants';
import { navigate, TERMINAL } from './utils';

function parseRoute() {
  const path = window.location.hash.replace(/^#/, '') || '/';
  const match = path.match(/^\/projects\/([a-f0-9]{32})$/);
  if (match) return { name: 'project', id: match[1] };
  if (path === '/projects') return { name: 'projects' };
  if (path === '/download') return { name: 'download' };
  return { name: 'home' };
}

export default function App() {
  const [route, setRoute] = useState(parseRoute);
  const [toast, setToast] = useState(null);
  const [health, setHealth] = useState(undefined);
  const [updateReady, setUpdateReady] = useState(false);
  const [queue, setQueue] = useState([]);
  const online = useOnlineStatus();

  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const checkHealth = useCallback(() => api.health().then(setHealth).catch(() => setHealth(null)), []);

  useEffect(() => {
    if (online) checkHealth();
  }, [online, checkHealth]);

  // An installed app is often opened before the local server is started, so keep retrying while it is down.
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && checkHealth();
    document.addEventListener('visibilitychange', onVisible);
    const timer = health === null ? window.setInterval(checkHealth, 8000) : null;
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (timer) window.clearInterval(timer);
    };
  }, [health, checkHealth]);

  useEffect(() => registerServiceWorker(() => setUpdateReady(true)), []);

  // Shows every in-progress download/render in one place (sidebar), no matter which page is open.
  const loadQueue = useCallback(() => {
    api.listProjects().then((list) => setQueue(list.filter((p) => !TERMINAL.has(p.status)))).catch(() => {});
  }, []);
  useEffect(() => {
    if (health === null || !online) return undefined;
    loadQueue();
    const timer = window.setInterval(() => { if (!document.hidden) loadQueue(); }, 3000);
    return () => window.clearInterval(timer);
  }, [health, online, loadQueue]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const notify = useCallback((message, tone = 'info') => setToast({ message, tone, id: Date.now() }), []);
  const onHome = route.name === 'home' || route.name === 'download';

  return (
    <div className="app-shell">
      {!online && <div className="pwa-banner offline" role="status">You’re offline. Projects and downloads need a connection to the ClipLabs server.</div>}
      {updateReady && (
        <div className="pwa-banner update" role="status">
          A new version of ClipLabs is ready.
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}
      <div className="shell-grid">
        <aside className="sidebar">
          <a className="logo" href="#/"><span className="logo-icon">✦</span>Clip<span>Labs</span></a>
          <p className="side-section">Workflows</p>
          <a className={`side-link ${route.name === 'home' ? 'current' : ''}`} href="#/"><span aria-hidden="true">✦</span>Create</a>
          <a className={`side-link ${route.name === 'download' ? 'current' : ''}`} href="#/download"><span aria-hidden="true">↓</span>Downloader</a>
          <a className={`side-link ${!onHome ? 'current' : ''}`} href="#/projects"><span aria-hidden="true">▤</span>Projects</a>
          <QueuePanel queue={queue} />
        </aside>
        <div className="main-col">
          <div className="topbar-mobile">
            <a className="logo" href="#/"><span className="logo-icon">✦</span>clip<span>labs</span></a>
          </div>
          <QueuePanel queue={queue} mobile />
          {onHome && <Landing key={route.name} notify={notify} health={health} initialMode={route.name === 'download' ? 'download' : 'clips'} />}
          {route.name === 'projects' && <Projects notify={notify} />}
          {route.name === 'project' && <ProjectDetail key={route.id} id={route.id} notify={notify} />}
        </div>
      </div>
      <nav className="tabbar" aria-label="Main">
        <a className={onHome ? 'current' : ''} href="#/"><span aria-hidden="true">✦</span>Create</a>
        <a className={route.name === 'download' ? 'current' : ''} href="#/download"><span aria-hidden="true">↓</span>Downloader</a>
        <a className={!onHome ? 'current' : ''} href="#/projects"><span aria-hidden="true">▤</span>Projects</a>
      </nav>
      <div className={`toast ${toast ? 'show' : ''} ${toast?.tone === 'error' ? 'error' : ''}`} role="status">{toast?.message}</div>
    </div>
  );
}

function QueuePanel({ queue, mobile }) {
  if (!queue.length) return null;
  return (
    <div className={`queue-panel ${mobile ? 'queue-panel-mobile' : ''}`}>
      <p className="queue-head">In progress <span>{queue.length}</span></p>
      <div className="queue-list">
        {queue.map((project) => (
          <a key={project.id} className="queue-item" href={`#/projects/${project.id}`}>
            <span className="queue-item-top">
              <strong title={project.title}>{project.title}</strong>
              <em>{STATUS_LABELS[project.status]}</em>
            </span>
            <span className="queue-progress"><span style={{ width: `${Math.round(project.progress)}%` }} /></span>
          </a>
        ))}
      </div>
    </div>
  );
}

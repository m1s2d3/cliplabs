import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import Landing from './pages/Landing';
import ProjectDetail from './pages/ProjectDetail';
import Projects from './pages/Projects';
import { registerServiceWorker, useInstall, useOnlineStatus } from './pwa';
import { STATUS_LABELS } from './constants';
import { navigate, TERMINAL } from './utils';

function parseRoute() {
  const path = window.location.hash.replace(/^#/, '') || '/';
  const match = path.match(/^\/projects\/([a-f0-9]{32})$/);
  if (match) return { name: 'project', id: match[1] };
  if (path === '/projects') return { name: 'projects' };
  return { name: 'home' };
}

export default function App() {
  const [route, setRoute] = useState(parseRoute);
  const [toast, setToast] = useState(null);
  const [health, setHealth] = useState(undefined);
  const [updateReady, setUpdateReady] = useState(false);
  const [iosSteps, setIosSteps] = useState(false);
  const [queue, setQueue] = useState([]);
  const online = useOnlineStatus();
  const { canInstall, needsIosSteps, install } = useInstall();

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
  const showInstall = canInstall || needsIosSteps;
  const onHome = route.name === 'home';
  const installButton = showInstall && <button className="install-btn" onClick={canInstall ? install : () => setIosSteps(true)}>Install app</button>;

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
          <a className="logo" href="#/"><span className="logo-icon">✦</span>clip<span>labs</span></a>
          <p className="side-section">Workflows</p>
          <a className={`side-link ${onHome ? 'current' : ''}`} href="#/"><span aria-hidden="true">✦</span>Create</a>
          <a className={`side-link ${!onHome ? 'current' : ''}`} href="#/projects"><span aria-hidden="true">▤</span>Projects</a>
          <QueuePanel queue={queue} />
          <div className="side-foot">
            {installButton}
          </div>
        </aside>
        <div className="main-col">
          <div className="topbar-mobile">
            <a className="logo" href="#/"><span className="logo-icon">✦</span>clip<span>labs</span></a>
            <div className="nav-actions">
              {installButton}
            </div>
          </div>
          <QueuePanel queue={queue} mobile />
          {onHome && <Landing notify={notify} health={health} />}
          {route.name === 'projects' && <Projects notify={notify} />}
          {route.name === 'project' && <ProjectDetail key={route.id} id={route.id} notify={notify} />}
          <footer>
            <a className="logo" href="#/"><span className="logo-icon">✦</span>clip<span>labs</span></a>
            <span>Made for people with something to say.</span>
            <span>© 2026 ClipLabs</span>
          </footer>
        </div>
      </div>
      <nav className="tabbar" aria-label="Main">
        <a className={onHome ? 'current' : ''} href="#/"><span aria-hidden="true">✦</span>Create</a>
        <a className={!onHome ? 'current' : ''} href="#/projects"><span aria-hidden="true">▤</span>Projects</a>
      </nav>
      <div className={`toast ${toast ? 'show' : ''} ${toast?.tone === 'error' ? 'error' : ''}`} role="status">{toast?.message}</div>
      {iosSteps && <IosInstallSheet onClose={() => setIosSteps(false)} />}
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

function IosInstallSheet({ onClose }) {
  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop sheet" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal install-sheet" role="dialog" aria-modal="true" aria-label="Install ClipLabs">
        <div className="modal-head"><div><p className="kicker">INSTALL</p><h2>Add ClipLabs to your Home Screen</h2></div><button className="icon-button" onClick={onClose} aria-label="Close">×</button></div>
        <ol className="install-steps">
          <li>Tap the <b>Share</b> button <span aria-hidden="true">⎋</span> in Safari’s toolbar.</li>
          <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
          <li>Tap <b>Add</b>. ClipLabs now opens full-screen like an app.</li>
        </ol>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';

export function registerServiceWorker(onUpdate) {
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) {
    // A worker left over from a production preview on this port would intercept dev requests.
    navigator.serviceWorker.getRegistrations().then((list) => list.forEach((r) => r.unregister()));
    if (typeof caches !== 'undefined') caches.keys().then((names) => names.filter((n) => n.startsWith('cliplabs-')).forEach((n) => caches.delete(n)));
    return;
  }
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) onUpdate();
  });
  const start = () => navigator.serviceWorker.register('/sw.js').then((registration) => {
    // Installed apps stay open for days, so look for a new version whenever the user comes back.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {});
    });
  }).catch(() => {});
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

export function useOnlineStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function useInstall() {
  const [deferred, setDeferred] = useState(null);
  const [installed, setInstalled] = useState(isStandalone);

  useEffect(() => {
    const onPrompt = (event) => {
      event.preventDefault();
      setDeferred(event);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  }, [deferred]);

  // iOS has no install event; Safari only offers Share > Add to Home Screen.
  return { canInstall: Boolean(deferred) && !installed, needsIosSteps: isIos() && !installed && !deferred, install };
}

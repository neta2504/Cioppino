import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

// Self-heal from stale-cache chunk failures. The app code-splits each route
// into a content-hashed chunk. After a rebuild the old hashes are deleted, so
// a browser still holding a stale index.html will request a now-missing chunk
// and the dynamic import 404s — leaving the lazy <Suspense> content blank while
// the shell (sidebar + fixed decorations) keeps rendering, which looks like the
// UI "floating" with half-loaded controls (e.g. an empty dropdown). Vite emits
// `vite:preloadError` in that case; force a single hard reload to pull a fresh
// index.html (served no-cache) and the current chunks. Guarded so we never loop.
const CHUNK_RELOAD_KEY = 'cioppino:chunk-reload-at';
window.addEventListener('vite:preloadError', (e: Event) => {
  e.preventDefault();
  const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || '0');
  if (Date.now() - last > 10_000) {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    window.location.reload();
  }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

// Hold the splash until the backend reports `ready: true` — that means the
// initial discover/access/cost/activity scans have finished, so the first
// data fetch will return real numbers instead of an empty state. Polls
// every 250ms with a 15s hard cap (fail-open: show the app anyway).
// Also enforces a minimum visible window so on warm starts (when /api/ready
// returns true on the first poll) the user actually sees the splash —
// otherwise the icon never finishes decoding and the animations never run
// a frame before the fade-out begins.
const MIN_SPLASH_MS = 1200;
const splashStart =
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

function hideSplash() {
  const splash = document.getElementById('cioppino-splash');
  if (!splash) return;
  splash.classList.add('fade-out');
  setTimeout(() => splash.remove(), 350);
}

(async function waitForReady() {
  const headers: Record<string, string> = {};
  const t = new URLSearchParams(window.location.search).get('t');
  if (t) headers['x-cioppino-token'] = t;
  const apiPromise = import('./lib/api').catch(() => null);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('/api/ready', { headers });
      if (res.ok) {
        const j = await res.json();
        if (j?.ready) break;
      }
    } catch {
      /* backend not up yet — keep polling */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    const mod = await apiPromise;
    mod?.api.bust();
  } catch {}
  const now =
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  const remaining = MIN_SPLASH_MS - (now - splashStart);
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  hideSplash();
})();

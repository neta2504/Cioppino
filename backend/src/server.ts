import express, { Request, Response, NextFunction } from 'express';
import compression from 'compression';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PORT, TOKEN } from './config.js';
import { db, getSetting, pruneOldData, wipeAllData } from './db/index.js';
import { discoverAll, listAgents, getProcListerHealth, verifyIntegrationPid } from './discovery/index.js';
import { scanAccess, listAccess, getRevokeGuide, getUninstallGuide } from './access/index.js';
import { scanTokens, getTokenSummary } from './tokens/index.js';
import { settingsRouter } from './settings.js';
import { startSampler, subscribe, getRecentSamples, getRecentGpuSamples } from './performance/index.js';
import { getErrorSummary } from './errors/index.js';
import { getLatencySummary } from './latency/index.js';
import { getProjectsSummary } from './projects/index.js';
import { scanActivity, listActivity, listActivitySessions, getActivitySession, getActivityContent, deleteActivity, getActivityStats } from './activity/index.js';
import { scanDownloads, listDownloads, deleteDownloads } from './downloads/index.js';
import { REGISTRY } from './discovery/registry.js';
import { applySecurityHeaders, disableApiCaching } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const frontendDist = path.join(root, 'frontend', 'dist');

console.log('[cioppino] booting backend…');

if (!TOKEN) {
  console.error('[cioppino] FATAL: CIOPPINO_TOKEN is not set. Launch via `node scripts/start.mjs` so a per-session token is generated. Refusing to start.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
// Gzip/brotli all responses. Cuts JS/CSS transfer ~70% — the single biggest
// win for cold-load on the local loopback (still useful: parsing/transfer wins).
app.use(compression());
app.use(applySecurityHeaders);
app.use(express.json({ limit: '1mb' }));

// --- Security middlewares ---

// H1: Host-header allow-list. Defeats DNS-rebinding attacks: only requests
// whose Host header is 127.0.0.1 / localhost / ::1 are accepted.
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
app.use((req: Request, res: Response, next: NextFunction) => {
  const host = (req.headers.host || '').toLowerCase();
  const hostname = host.split(':')[0];
  if (!ALLOWED_HOSTS.has(hostname) && !ALLOWED_HOSTS.has(host)) {
    return res.status(403).type('text/plain').send('forbidden: invalid host');
  }
  next();
});

function readToken(req: Request): string {
  const header = req.headers['x-cioppino-token'];
  if (typeof header === 'string' && header) return header;
  const cookieHeader = req.headers.cookie || '';
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === 'cioppino_token') return decodeURIComponent(rest.join('='));
  }
  const q = req.query.t;
  return typeof q === 'string' ? q : '';
}

// H1+H2: require the per-session token on every API request (not only writes).
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (readToken(req) !== TOKEN) return res.status(403).json({ error: 'forbidden' });
  next();
}

// Kept for clarity at call sites; identical to requireAuth.
const authWrite = requireAuth;

// Render the splash-bearing index.html. Hoisted to module scope so /auth
// can serve it directly (no redirect) — splash paints on the very first
// response. Returns null if the frontend hasn't been built yet.
const indexHtmlPath = path.join(frontendDist, 'index.html');
const renderIndex = (extraHeadScript?: string): string | null => {
  if (!fs.existsSync(indexHtmlPath)) return null;
  let html = fs.readFileSync(indexHtmlPath, 'utf8');
  // Make the app's CSS link non-render-blocking so the splash paints
  // immediately. The CSS still applies as soon as it finishes downloading.
  html = html.replace(
    /<link\s+rel="stylesheet"([^>]*?)href="(\/assets\/[^"]+\.css)"([^>]*)>/gi,
    (_m, pre, href, post) =>
      `<link rel="preload" as="style"${pre}href="${href}"${post} onload="this.onload=null;this.rel='stylesheet'">` +
      `<noscript><link rel="stylesheet"${pre}href="${href}"${post}></noscript>`,
  );
  if (extraHeadScript) {
    html = html.replace(/<\/head>/i, `${extraHeadScript}\n</head>`);
  }
  return html;
};

// Bootstrap: start.mjs opens /auth?t=<token>. We validate the token, set
// an HttpOnly cookie scoped to this origin, then serve the splash HTML
// directly (no 302 → / round-trip — the splash paints on the first
// response). A tiny inline script strips the token from the URL bar with
// history.replaceState so it never lands in browser history or bookmarks.
app.get('/auth', (req, res) => {
  const t = typeof req.query.t === 'string' ? req.query.t : '';
  if (t !== TOKEN) return res.status(403).type('text/plain').send('forbidden');
  res.setHeader(
    'Set-Cookie',
    `cioppino_token=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
  );
  res.set('Cache-Control', 'no-store');
  const html = renderIndex(
    `<script>try{history.replaceState({},'','/');}catch(e){}</script>`,
  );
  if (html) return res.type('html').send(html);
  // Frontend not built yet — fall back to the original redirect so the
  // dev flow (vite dev server on a different port) still works.
  res.redirect(302, '/');
});

// --- API routes ---
app.use('/api', disableApiCaching);
app.get('/api/health', (_req, res) => res.json({ ok: true, version: '0.1.0' }));

// All other /api/* endpoints require the session token.
app.use('/api', requireAuth);

// Readiness flag + per-step state: every entry transitions
// pending → running → done|error. The frontend splash polls /api/ready
// and renders this as a live checklist so the user sees what's happening
// instead of a generic "loading…".
type StepStatus = 'pending' | 'running' | 'done' | 'error';
type StepState = { id: string; label: string; status: StepStatus; ms?: number; summary?: string };
const stepState: Record<string, StepState> = {
  discover:  { id: 'discover',  label: 'Discovering agents', status: 'pending' },
  access:    { id: 'access',    label: 'Scanning access',    status: 'pending' },
  tokens:    { id: 'tokens',    label: 'Scanning tokens',    status: 'pending' },
  activity:  { id: 'activity',  label: 'Scanning activity',  status: 'pending' },
  downloads: { id: 'downloads', label: 'Scanning downloads', status: 'pending' },
};
const STEP_ORDER = ['discover', 'access', 'tokens', 'activity', 'downloads'] as const;

// Warm start: if a previous run already populated the DB, the splash doesn't
// need to wait for any scan at all — pages render the persisted rows instantly
// and the SWR layer silently revalidates as the background rescans land. Set
// once at boot (see warm-start check below).
let warmReady = false;

// Ready as soon as the cheap, essential step (agent discovery) finishes — NOT
// all five scans. The agents list is what the dashboard needs to paint; access/
// tokens/activity/downloads stream in afterwards via background revalidation.
// On a warm start we don't even wait for discover. The 15s splash cap in
// main.tsx remains as a fail-open safety net.
const isReady = () => {
  if (warmReady) return true;
  const s = stepState.discover.status;
  return s === 'done' || s === 'error';
};

app.get('/api/ready', (_req, res) => {
  res.json({ ready: isReady(), steps: STEP_ORDER.map((k) => stepState[k]) });
});

app.get('/api/agents', (_req, res) => {
  res.json({ agents: listAgents(), registry: REGISTRY, procLister: getProcListerHealth() });
});

app.post('/api/agents/scan', authWrite, async (_req, res) => {
  try {
    const agents = await logScan('discover', 'api', () => discoverAll(), (a) => `${a.length} agents`);
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message || String(err) });
  }
});

app.get('/api/access', (req, res) => {
  res.json({ items: listAccess(req.query.agentId as string | undefined) });
});

app.post('/api/access/scan', authWrite, async (_req, res) => {
  try {
    const items = await logScan('access', 'api', () => scanAccess(), (a) => `${a.length} items`);
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message || String(err) });
  }
});

app.get('/api/access/revoke-guide', (req, res) => {
  const { agentId, category, sourcePath, providerId } = req.query as Record<string, string>;
  if (!agentId || !category) return res.status(400).json({ error: 'agentId and category required' });
  res.json(getRevokeGuide(agentId, category, sourcePath, providerId));
});

app.get('/api/access/uninstall-guide', (req, res) => {
  const { agentId } = req.query as Record<string, string>;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  res.json(getUninstallGuide(agentId));
});

app.get('/api/tokens', (req, res) => {
  const days = parseInt((req.query.days as string) || '30', 10);
  const model = (req.query.model as string) || undefined;
  res.json(getTokenSummary(days, model));
});

app.post('/api/tokens/scan', authWrite, async (_req, res) => {
  try {
    const r = await logScan('tokens', 'api', () => scanTokens(), (x) => `${x.inserted} entries`);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message || String(err) });
  }
});

app.get('/api/perf', (req, res) => {
  const minutes = parseInt((req.query.minutes as string) || '5', 10);
  res.json({
    samples: getRecentSamples(req.query.agentId as string | undefined, minutes * 60_000),
    gpu: getRecentGpuSamples(minutes * 60_000),
  });
});

app.get('/api/errors', async (req, res) => {
  const hours = parseInt((req.query.hours as string) || '24', 10);
  const data = await getErrorSummary(hours);
  res.json(data);
});

app.get('/api/latency', async (req, res) => {
  const hours = parseInt((req.query.hours as string) || '24', 10);
  const data = await getLatencySummary(hours);
  res.json(data);
});

app.get('/api/projects', async (_req, res) => {
  const data = await getProjectsSummary();
  res.json(data);
});

// ─── Activity (prompts/responses audit) ───────────────────────────────────
app.get('/api/activity', (req, res) => {
  const agentId = (req.query.agentId as string) || undefined;
  const q = (req.query.q as string) || undefined;
  const role = (req.query.role as string) || undefined;
  const modality = (req.query.modality as string) || undefined;
  const sinceMs = req.query.sinceMs ? parseInt(req.query.sinceMs as string, 10) : undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
  res.json(listActivity({ agentId, q, role, modality, sinceMs, limit, offset }));
});

app.get('/api/activity/stats', (req, res) => {
  const agentId = (req.query.agentId as string) || undefined;
  const q = (req.query.q as string) || undefined;
  const role = (req.query.role as string) || undefined;
  const modality = (req.query.modality as string) || undefined;
  const sinceMs = req.query.sinceMs ? parseInt(req.query.sinceMs as string, 10) : undefined;
  res.json(getActivityStats({ agentId, q, role, modality, sinceMs }));
});

app.get('/api/activity/sessions', (req, res) => {
  const agentId = (req.query.agentId as string) || undefined;
  const modality = (req.query.modality as string) || undefined;
  const sinceMs = req.query.sinceMs ? parseInt(req.query.sinceMs as string, 10) : undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  res.json(listActivitySessions({ agentId, modality, sinceMs, limit }));
});

app.get('/api/activity/sessions/:agentId/:sessionId', (req, res) => {
  const agentId = String(req.params.agentId);
  const sessionId = String(req.params.sessionId);
  res.json(getActivitySession(agentId, sessionId));
});

app.get('/api/activity/:id', (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  const row = getActivityContent(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

app.post('/api/activity/scan', authWrite, async (_req, res) => {
  try {
    const r = await logScan('activity', 'api', () => scanActivity(), (x) => `${x.inserted} new / ${x.scanned} scanned`);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message || String(err) });
  }
});

app.delete('/api/activity', authWrite, (req, res) => {
  const all = req.query.all === '1' || req.query.all === 'true';
  const agentId = (req.query.agentId as string) || undefined;
  if (!all && !agentId) return res.status(400).json({ error: 'all=1 or agentId required' });
  const removed = deleteActivity({ all, agentId });
  res.json({ removed });
});

app.delete('/api/activity/:id', authWrite, (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  const removed = deleteActivity({ id });
  res.json({ removed });
});

// ── Downloads — external items agents pulled onto the device ──
app.get('/api/downloads', (req, res) => {
  const agentId = (req.query.agentId as string) || undefined;
  const kind = (req.query.kind as string) || undefined;
  const manager = (req.query.manager as string) || undefined;
  const q = (req.query.q as string) || undefined;
  const sinceMs = req.query.sinceMs ? parseInt(req.query.sinceMs as string, 10) : undefined;
  const riskOnly = req.query.riskOnly === '1' || req.query.riskOnly === 'true';
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
  res.json(listDownloads({ agentId, kind, manager, q, sinceMs, riskOnly, limit, offset }));
});

app.post('/api/downloads/scan', authWrite, async (_req, res) => {
  try {
    const r = await logScan('downloads', 'api', () => scanDownloads(), (x) => `${x.inserted} new / ${x.scanned} scanned`);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message || String(err) });
  }
});

app.delete('/api/downloads', authWrite, (req, res) => {
  const all = req.query.all === '1' || req.query.all === 'true';
  const agentId = (req.query.agentId as string) || undefined;
  if (!all && !agentId) return res.status(400).json({ error: 'all=1 or agentId required' });
  const removed = deleteDownloads({ all, agentId });
  res.json({ removed });
});

app.get('/api/perf/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (samples: any, gpu: any) => {
    res.write(`data: ${JSON.stringify({ ts: Date.now(), samples, gpu })}\n\n`);
  };
  const recentGpu = getRecentGpuSamples(60_000);
  send(getRecentSamples(undefined, 60_000), recentGpu[recentGpu.length - 1] || null);
  const unsub = subscribe((tick) => send(tick.samples, tick.gpu));
  req.on('close', () => unsub());
});

app.use('/api/settings', settingsRouter);

app.post('/api/data/wipe', authWrite, (_req, res) => {
  wipeAllData();
  res.json({ ok: true });
});

// Kill a process owned by an agent
app.post('/api/agents/:id/kill', authWrite, async (req, res) => {
  const agentId = req.params.id;
  const pid = parseInt(req.body?.pid, 10);
  if (!pid || isNaN(pid)) return res.status(400).json({ error: 'pid required' });
  const agent = listAgents().find((a) => a.id === agentId);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  if (!agent.pids.includes(pid)) return res.status(403).json({ error: 'pid does not belong to this agent' });
  try {
    if (REGISTRY.find((def) => def.id === agentId)?.integration) {
      if (!await verifyIntegrationPid(agent, pid)) {
        return res.status(409).json({ error: 'Process identity could not be reverified. Rescan before retrying.' });
      }
      process.kill(pid, 'SIGTERM');
      setTimeout(async () => {
        try {
          if (await verifyIntegrationPid(agent, pid)) process.kill(pid, 'SIGKILL');
        } catch {
          console.warn('[cioppino] Could not complete verified integration process termination.');
        }
      }, 1500);
      return res.json({ ok: true, pid });
    }
    process.kill(pid, 'SIGTERM');
    setTimeout(() => {
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
    }, 1500);
    res.json({ ok: true, pid });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'kill failed' });
  }
});

// Open a path in OS file manager (revoke helper).
// M1: only paths that the access scanner has registered (or their parent dirs)
// are permitted, so a stolen token can't be used to browse arbitrary disk.
app.post('/api/open-path', authWrite, async (req, res) => {
  const raw = (req.body?.path as string) || '';
  if (!raw) return res.status(400).json({ error: 'path required' });
  let p: string;
  try {
    p = path.resolve(raw);
  } catch {
    return res.status(400).json({ error: 'invalid path' });
  }
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  const row = db
    .prepare('SELECT 1 FROM access_items WHERE source_path = ? LIMIT 1')
    .get(p) as { 1: number } | undefined;
  if (!row) return res.status(403).json({ error: 'path is not a registered access item' });
  const { spawn } = await import('node:child_process');
  const cmd =
    process.platform === 'win32'
      ? ['explorer', ['/select,', p]]
      : process.platform === 'darwin'
        ? ['open', ['-R', p]]
        : ['xdg-open', [path.dirname(p)]];
  spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: 'ignore' }).unref();
  res.json({ ok: true });
});

// Serve frontend (production).
if (fs.existsSync(frontendDist)) {
  app.get(['/', '/index.html'], (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    const html = renderIndex();
    if (html) return res.type('html').send(html);
    res.status(503).type('text/plain').send('frontend not built');
  });
  // Aggressively cache the hashed asset bundles so reloads don't re-fetch them.
  app.use(
    '/assets',
    express.static(path.join(frontendDist, 'assets'), {
      maxAge: '30d',
      immutable: true,
      index: false,
    }),
  );
  app.use(express.static(frontendDist, { index: false, maxAge: '1h' }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    // index.html references content-hashed asset chunks that are served
    // `immutable`. It MUST always revalidate, otherwise a browser that cached
    // this HTML (e.g. from a reload on /downloads or /activity) keeps loading
    // stale chunk references after a rebuild — making newer UI (like the
    // timeframe filter) silently disappear. Mirror the `/` route's no-cache.
    res.set('Cache-Control', 'no-cache');
    const html = renderIndex();
    if (html) return res.type('html').send(html);
    next();
  });
}

const runTask = async <T>(
  key: keyof typeof stepState,
  label: string,
  fn: () => Promise<T>,
  summarise: (r: T) => string,
) => {
  const start = Date.now();
  stepState[key].status = 'running';
  console.log(`[cioppino] ${label}…`);
  try {
    const r = await fn();
    const summary = summarise(r);
    stepState[key].status = 'done';
    stepState[key].ms = Date.now() - start;
    stepState[key].summary = summary;
    console.log(`[cioppino] ${label} → ${summary} (${stepState[key].ms}ms)`);
    return r;
  } catch (err) {
    stepState[key].status = 'error';
    stepState[key].ms = Date.now() - start;
    stepState[key].summary = (err as Error)?.message || String(err);
    console.error(`[cioppino] ${label} ✗ ${stepState[key].summary} (${stepState[key].ms}ms)`);
    throw err;
  }
};

// Lighter-weight logger for rescans that happen after boot (manual via the
// UI or periodic timers). Doesn't touch stepState — that's reserved for the
// splash bootstrap. Returns whatever the underlying scan returns.
async function logScan<T>(
  name: string,
  trigger: 'api' | 'periodic',
  fn: () => Promise<T>,
  summarise: (r: T) => string,
): Promise<T> {
  const start = Date.now();
  try {
    const r = await fn();
    console.log(`[cioppino] ${name} rescan (${trigger}) → ${summarise(r)} (${Date.now() - start}ms)`);
    return r;
  } catch (err) {
    const msg = (err as Error)?.message || String(err);
    console.error(`[cioppino] ${name} rescan (${trigger}) ✗ ${msg} (${Date.now() - start}ms)`);
    throw err;
  }
}

// Log that we're about to start discover (so the CLI shows the order the
// user expects: booting → discover agents… → http listening) but defer
// the actual scan work until AFTER app.listen runs. Scans do heavy
// synchronous filesystem work in their prologue and would otherwise
// delay app.listen by tens of seconds.
stepState.discover.status = 'running';
console.log('[cioppino] discover agents…');
const discoverStart = Date.now();

// Warm start: if the DB already holds agents from a previous run, mark the app
// ready immediately. Pages paint the persisted rows and the background scans
// (kicked off below) silently refresh them. Cold first runs leave this false
// and the splash waits only for the `discover` step.
try {
  const prior = db.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number };
  if (prior && prior.c > 0) {
    warmReady = true;
    console.log(`[cioppino] warm start — ${prior.c} cached agents, splash will not block on scans`);
  }
} catch {}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`cioppino:listening port=${PORT}`);
  console.log(`[cioppino] http listening on :${PORT}`);

  // Heavy scans still pin the event loop briefly. Give the browser a short
  // window to fetch the splash HTML/JS/CSS/icon over loopback before scans
  // start — but only ~600ms now: readiness gates on `discover` alone (or is
  // instant on a warm start), so we no longer need a long stall here.
  console.log('[cioppino] starting scans shortly — splash bootstrapping…');
  setTimeout(async () => {
    const scansT0 = Date.now();

    // Discovery is mostly *asynchronous* (process snapshot + child-process
    // version probes). The other scans do heavy *synchronous* fs/JSON work that
    // monopolises the event loop and starves discovery's async callbacks — which
    // is exactly what gates the splash on a cold start. So finish discover first,
    // then launch the heavy scans. On a warm start the splash is already cleared
    // from cached rows, so we just fire everything together as a refresh.
    const runDiscover = () =>
      discoverAll()
        .then((a) => {
          const summary = `${a.length} agents`;
          stepState.discover.status = 'done';
          stepState.discover.ms = Date.now() - discoverStart;
          stepState.discover.summary = summary;
          console.log(`[cioppino] discover agents → ${summary} (${stepState.discover.ms}ms)`);
        })
        .catch((err: unknown) => {
          stepState.discover.status = 'error';
          stepState.discover.ms = Date.now() - discoverStart;
          stepState.discover.summary = (err as Error)?.message || String(err);
          console.error(`[cioppino] discover agents ✗ ${stepState.discover.summary} (${stepState.discover.ms}ms)`);
        });

    const startHeavyScans = () => [
      runTask('access',    'scan access',    scanAccess,    (a) => `${a.length} items`),
      runTask('tokens',    'scan tokens',    scanTokens,    (r) => `${r.inserted} entries`),
      runTask('activity',  'scan activity',  scanActivity,  (r) => `${r.inserted} new / ${r.scanned} scanned`),
      runTask('downloads', 'scan downloads', scanDownloads, (r) => `${r.inserted} new / ${r.scanned} scanned`),
    ];

    const discoverPromise = runDiscover();
    if (!warmReady) {
      // Cold start: don't let the synchronous scans starve discovery — readiness
      // depends on it.
      await discoverPromise;
    }
    const all = [discoverPromise, ...startHeavyScans()];
    Promise.allSettled(all).then(() => {
      console.log(`[cioppino] ready — initial scans complete in ${Date.now() - scansT0}ms`);
    });
  }, 600);

  const perfInterval = parseInt(getSetting('perfIntervalMs') || '3000', 10);
  startSampler(perfInterval);
  console.log(`[cioppino] perf sampler started (every ${perfInterval}ms)`);
  const scanInterval = parseInt(getSetting('scanIntervalSec') || '60', 10) * 1000;
  setInterval(() => {
    logScan('discover', 'periodic', () => discoverAll(), (a) => `${a.length} agents`).catch(() => {});
    pruneOldData();
  }, scanInterval);
  setTimeout(
    () => setInterval(() => {
      logScan('tokens', 'periodic', () => scanTokens(), (x) => `${x.inserted} entries`).catch(() => {});
    }, scanInterval),
    Math.floor(scanInterval / 3),
  );
  setTimeout(
    () => setInterval(() => {
      logScan('activity', 'periodic', () => scanActivity(), (x) => `${x.inserted} new / ${x.scanned} scanned`).catch(() => {});
    }, scanInterval),
    Math.floor((scanInterval * 2) / 3),
  );
  setTimeout(
    () => setInterval(() => {
      logScan('downloads', 'periodic', () => scanDownloads(), (x) => `${x.inserted} new / ${x.scanned} scanned`).catch(() => {});
    }, scanInterval),
    Math.floor((scanInterval * 5) / 6),
  );
  console.log(`[cioppino] periodic rescans scheduled (every ${scanInterval / 1000}s)`);
});

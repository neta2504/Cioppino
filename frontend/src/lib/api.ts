const tokenFromUrl = new URLSearchParams(window.location.search).get('t') || '';

// Two-tier SWR cache.
//   fresh  (<= freshTtlMs)  — return cached value, skip refetch entirely.
//   stale  (<= staleTtlMs)  — return cached value AND kick off a background
//                              refetch; subscribers receive the new value.
//   expired                  — treat as cache miss.
//
// Tab-switching back to a page you visited in the last few minutes is
// instant — the snapshot renders synchronously and a silent refresh keeps
// it current. Refresh / Scan buttons still call `api.bust(...)` to force a
// hard reload.
const freshTtlMs = 3_000;
const staleTtlMs = 5 * 60_000;
type CacheEntry = { ts: number; value: unknown };
type Listener = (value: unknown) => void;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Map<string, Set<Listener>>();

function cacheKey(url: string) { return url; }

// Synchronously read whatever snapshot we have for `key`, regardless of
// freshness. Used by useCachedQuery to seed component state on mount so
// the UI never flashes blank between navigations.
export function getSnapshot<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.ts > staleTtlMs) return undefined;
  return hit.value as T;
}

// Subscribe to value changes for `key`. Called by useCachedQuery so a
// background refetch triggered by one mounted component updates every
// other component reading the same key.
export function subscribeSnapshot(key: string, fn: Listener): () => void {
  let set = listeners.get(key);
  if (!set) { set = new Set(); listeners.set(key, set); }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(key);
  };
}

function notify(key: string, value: unknown) {
  const set = listeners.get(key);
  if (!set) return;
  for (const fn of set) {
    try { fn(value); } catch {}
  }
}

// A response counts as "empty" if every list-shaped field on it is length 0.
// We refuse to cache those: an unlucky read landing while the backend is
// mid-rebuild used to poison every subsequent navigation for the full TTL.
function isEmptyList(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const listFields = ['agents', 'items', 'rows', 'byAgent', 'byModel', 'byProject', 'series', 'projects', 'points', 'recent', 'samples', 'gpu'];
  let sawAny = false;
  for (const k of listFields) {
    const arr = (v as Record<string, unknown>)[k];
    if (Array.isArray(arr)) {
      sawAny = true;
      if (arr.length > 0) return false;
    }
  }
  return sawAny; // only declare "empty" if at least one list field existed
}

async function req<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (tokenFromUrl) headers.set('x-cioppino-token', tokenFromUrl);
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

// Cached GET. Only used for read-only endpoints; writes always go via req().
//   - Within freshTtlMs: returns the cached value, no network call.
//   - Within staleTtlMs: returns cached value immediately AND fires a
//     background refetch (callers awaiting this promise get the fresh value;
//     subscribers to the snapshot get notified of the new value).
//   - Past staleTtlMs: behaves like a true miss.
async function getCached<T>(url: string): Promise<T> {
  const key = cacheKey(url);
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.ts : Infinity;
  if (hit && age < freshTtlMs) return hit.value as T;

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) {
    // If we have a stale snapshot, resolve immediately with it and let the
    // already-inflight request notify subscribers when it lands.
    if (hit && age < staleTtlMs) return hit.value as T;
    return existing;
  }
  const p = req<T>(url).then((value) => {
    if (!isEmptyList(value)) {
      cache.set(key, { ts: Date.now(), value });
      notify(key, value);
    }
    inflight.delete(key);
    return value;
  }).catch((err) => {
    inflight.delete(key);
    throw err;
  });
  inflight.set(key, p);
  // Stale-while-revalidate: hand back the snapshot synchronously, let the
  // background fetch update subscribers when it resolves.
  if (hit && age < staleTtlMs) return hit.value as T;
  return p;
}

function bust(prefix?: string) {
  if (!prefix) { cache.clear(); return; }
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

// Soft invalidation: don't drop snapshots (so UI stays painted), just
// expire their freshness so the next read triggers a background refetch.
function markStale(prefix?: string) {
  const past = Date.now() - freshTtlMs - 1;
  for (const [key, entry] of cache) {
    if (prefix && !key.startsWith(prefix)) continue;
    entry.ts = past;
  }
}

// Returning to the Cioppino tab (after working in another app/tab) should
// surface fresh data, but we don't want to nuke the snapshot — that would
// re-introduce the blank-flash on the next nav. Mark everything stale
// instead: the snapshot keeps rendering, and the very next read kicks off
// a background refresh.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') markStale();
  });
  window.addEventListener('focus', () => markStale());
}

function activityUrl(params: {
  agentId?: string;
  q?: string;
  role?: string;
  modality?: 'text' | 'audio' | 'all';
  sinceMs?: number;
  limit?: number;
  offset?: number;
} = {}) {
  const q = new URLSearchParams();
  if (params.agentId) q.set('agentId', params.agentId);
  if (params.q) q.set('q', params.q);
  if (params.role) q.set('role', params.role);
  if (params.modality && params.modality !== 'all') q.set('modality', params.modality);
  if (params.sinceMs) q.set('sinceMs', String(params.sinceMs));
  if (params.limit) q.set('limit', String(params.limit));
  if (params.offset) q.set('offset', String(params.offset));
  const qs = q.toString();
  return `/api/activity${qs ? `?${qs}` : ''}`;
}
function activityStatsUrl(params: {
  agentId?: string;
  q?: string;
  role?: string;
  modality?: 'text' | 'audio' | 'all';
  sinceMs?: number;
} = {}) {
  const q = new URLSearchParams();
  if (params.agentId) q.set('agentId', params.agentId);
  if (params.q) q.set('q', params.q);
  if (params.role) q.set('role', params.role);
  if (params.modality && params.modality !== 'all') q.set('modality', params.modality);
  if (params.sinceMs) q.set('sinceMs', String(params.sinceMs));
  const qs = q.toString();
  return `/api/activity/stats${qs ? `?${qs}` : ''}`;
}
function activitySessionsUrl(params: { agentId?: string; modality?: 'text' | 'audio' | 'all'; sinceMs?: number; limit?: number } = {}) {
  const q = new URLSearchParams();
  if (params.agentId) q.set('agentId', params.agentId);
  if (params.modality && params.modality !== 'all') q.set('modality', params.modality);
  if (params.sinceMs) q.set('sinceMs', String(params.sinceMs));
  if (params.limit) q.set('limit', String(params.limit));
  const qs = q.toString();
  return `/api/activity/sessions${qs ? `?${qs}` : ''}`;
}
function perfUrl(agentId?: string, minutes = 5) {
  return `/api/perf?minutes=${minutes}${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ''}`;
}
function accessUrl(agentId?: string) {
  return `/api/access${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`;
}

function downloadsUrl(params: {
  agentId?: string;
  kind?: string;
  manager?: string;
  q?: string;
  sinceMs?: number;
  riskOnly?: boolean;
  limit?: number;
  offset?: number;
} = {}) {
  const q = new URLSearchParams();
  if (params.agentId) q.set('agentId', params.agentId);
  if (params.kind) q.set('kind', params.kind);
  if (params.manager) q.set('manager', params.manager);
  if (params.q) q.set('q', params.q);
  if (params.sinceMs) q.set('sinceMs', String(params.sinceMs));
  if (params.riskOnly) q.set('riskOnly', '1');
  if (params.limit) q.set('limit', String(params.limit));
  if (params.offset) q.set('offset', String(params.offset));
  const qs = q.toString();
  return `/api/downloads${qs ? `?${qs}` : ''}`;
}

// Canonical cache-key URLs for the endpoints the UI subscribes to via
// useCachedQuery. These MUST match what getCached() stores under.
export const apiKeys = {
  agents: () => '/api/agents',
  access: accessUrl,
  tokens: (days = 30, model?: string) =>
    `/api/tokens?days=${days}${model && model !== 'all' ? `&model=${encodeURIComponent(model)}` : ''}`,
  errors: (hours = 24) => `/api/errors?hours=${hours}`,
  latency: (hours = 24) => `/api/latency?hours=${hours}`,
  projects: () => '/api/projects',
  settings: () => '/api/settings',
  perf: perfUrl,
  activity: activityUrl,
  activityStats: activityStatsUrl,
  activitySessions: activitySessionsUrl,
  downloads: downloadsUrl,
};

export const api = {
  bust,
  markStale,
  health: () => req<{ ok: boolean; version: string }>('/api/health'),
  agents: () => getCached<{ agents: Agent[]; registry: any[]; procLister?: { ok: boolean; error?: string } }>(apiKeys.agents()),
  scanAgents: () => req<{ agents: Agent[] }>('/api/agents/scan', { method: 'POST' }).then((r) => { bust('/api/agents'); return r; }),
  access: (agentId?: string) => getCached<{ items: AccessItem[] }>(apiKeys.access(agentId)),
  scanAccess: () => req<{ items: AccessItem[] }>('/api/access/scan', { method: 'POST' }).then((r) => { bust('/api/access'); return r; }),
  revokeGuide: (agentId: string, category: string, sourcePath?: string, providerId?: string) =>
    req<RevokeGuide>(
      `/api/access/revoke-guide?agentId=${encodeURIComponent(agentId)}&category=${encodeURIComponent(category)}${
        sourcePath ? `&sourcePath=${encodeURIComponent(sourcePath)}` : ''
      }${providerId ? `&providerId=${encodeURIComponent(providerId)}` : ''}`,
    ),
  uninstallGuide: (agentId: string) =>
    req<UninstallGuide>(`/api/access/uninstall-guide?agentId=${encodeURIComponent(agentId)}`),
  tokens: (days = 30, model?: string) => getCached<TokenSummary>(apiKeys.tokens(days, model)),
  scanTokens: () => req<{ inserted: number }>('/api/tokens/scan', { method: 'POST' }).then((r) => { bust('/api/tokens'); return r; }),
  perf: (agentId?: string, minutes = 5) =>
    getCached<{ samples: Sample[]; gpu: GpuSample[] }>(apiKeys.perf(agentId, minutes)),
  errors: (hours = 24) => getCached<ErrorSummary>(apiKeys.errors(hours)),
  latency: (hours = 24) => getCached<LatencySummary>(apiKeys.latency(hours)),
  projects: () => getCached<ProjectsSummary>(apiKeys.projects()),
  settings: () => getCached<Settings>(apiKeys.settings()),
  saveSettings: (s: Partial<Settings>) =>
    req<{ ok: boolean }>('/api/settings', { method: 'POST', body: JSON.stringify(s) })
      .then((r) => { bust('/api/settings'); bust('/api/tokens'); bust('/api/activity'); return r; }),
  wipe: () => req<{ ok: boolean }>('/api/data/wipe', { method: 'POST' }).then((r) => { bust(); return r; }),
  openPath: (p: string) =>
    req<{ ok: boolean }>('/api/open-path', { method: 'POST', body: JSON.stringify({ path: p }) }),
  killPid: (agentId: string, pid: number) =>
    req<{ ok: boolean; pid: number }>(`/api/agents/${encodeURIComponent(agentId)}/kill`, {
      method: 'POST',
      body: JSON.stringify({ pid }),
    }),
  activity: (params: {
    agentId?: string;
    q?: string;
    role?: string;
    modality?: 'text' | 'audio' | 'all';
    sinceMs?: number;
    limit?: number;
    offset?: number;
  } = {}) => getCached<ActivityListResponse>(apiKeys.activity(params)),
  activityStats: (params: {
    agentId?: string;
    q?: string;
    role?: string;
    modality?: 'text' | 'audio' | 'all';
    sinceMs?: number;
  } = {}) => getCached<ActivityStats>(apiKeys.activityStats(params)),
  activitySessions: (params: { agentId?: string; modality?: 'text' | 'audio' | 'all'; sinceMs?: number; limit?: number } = {}) =>
    getCached<{ sessions: ActivitySessionSummary[]; total: number; costEnabled: boolean }>(apiKeys.activitySessions(params)),
  activitySession: (agentId: string, sessionId: string) =>
    req<{ events: ActivityRow[]; summary: ActivitySessionSummary | null; costEnabled: boolean }>(
      `/api/activity/sessions/${encodeURIComponent(agentId)}/${encodeURIComponent(sessionId)}`,
    ),
  activityContent: (id: number) =>
    req<{ content: string; row: ActivityRow }>(`/api/activity/${id}`),
  scanActivity: () =>
    req<{ inserted: number; scanned: number }>('/api/activity/scan', { method: 'POST' })
      .then((r) => { bust('/api/activity'); return r; }),
  deleteActivity: (id: number) =>
    req<{ removed: number }>(`/api/activity/${id}`, { method: 'DELETE' })
      .then((r) => { bust('/api/activity'); return r; }),
  purgeActivity: (agentId?: string) =>
    req<{ removed: number }>(
      `/api/activity?${agentId ? `agentId=${encodeURIComponent(agentId)}` : 'all=1'}`,
      { method: 'DELETE' },
    ).then((r) => { bust('/api/activity'); return r; }),
  downloads: (params: {
    agentId?: string;
    kind?: string;
    manager?: string;
    q?: string;
    sinceMs?: number;
    riskOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {}) => getCached<DownloadListResponse>(apiKeys.downloads(params)),
  scanDownloads: () =>
    req<{ inserted: number; scanned: number }>('/api/downloads/scan', { method: 'POST' })
      .then((r) => { bust('/api/downloads'); return r; }),
  purgeDownloads: (agentId?: string) =>
    req<{ removed: number }>(
      `/api/downloads?${agentId ? `agentId=${encodeURIComponent(agentId)}` : 'all=1'}`,
      { method: 'DELETE' },
    ).then((r) => { bust('/api/downloads'); return r; }),
};

// Singleton EventSource so navigating between pages that subscribe to
// perfStream (Dashboard, Performance) doesn't churn SSE connections.
// Subscribers share one network stream; it closes when the last unsubscribes.
let perfEv: EventSource | null = null;
let lastPerf: { ts: number; samples: Sample[]; gpu: GpuSample | null } | null = null;
const perfSubs = new Set<(msg: { ts: number; samples: Sample[]; gpu: GpuSample | null }) => void>();
function ensurePerfStream() {
  if (perfEv) return;
  perfEv = new EventSource('/api/perf/stream');
  perfEv.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      lastPerf = msg;
      for (const fn of perfSubs) fn(msg);
    } catch {}
  };
}
export function perfStream(
  onMessage: (msg: { ts: number; samples: Sample[]; gpu: GpuSample | null }) => void,
) {
  perfSubs.add(onMessage);
  ensurePerfStream();
  if (lastPerf) onMessage(lastPerf);
  return () => {
    perfSubs.delete(onMessage);
    if (perfSubs.size === 0 && perfEv) {
      perfEv.close();
      perfEv = null;
    }
  };
}

// Synchronously read the last perf tick received on the singleton SSE stream.
// Used by pages (Dashboard, Performance) to seed their local samples state on
// mount so live cards never flash 0 between navigations.
export function getLastPerfTick(): { ts: number; samples: Sample[]; gpu: GpuSample | null } | null {
  return lastPerf;
}

export interface Agent {
  id: string;
  name: string;
  vendor: string;
  kind: string;
  installed: boolean;
  running: boolean;
  version?: string;
  binPath?: string;
  configPath?: string;
  pids: number[];
  lastSeen: number;
  metadata?: {
    description?: string;
    processState?: 'available' | 'unavailable';
    monitoring?: {
      platformAvailable: boolean;
      resources: string;
      access: string;
      activity: string;
      tokens: string;
      notes: string;
    };
    issues?: { feature: string; message: string }[];
    [key: string]: unknown;
  };
}
export interface AccessItem {
  id: number;
  agentId: string;
  category: 'folder' | 'api-key' | 'mcp' | 'extension' | 'integration' | 'other';
  label: string;
  detail?: string;
  sourcePath?: string;
  sensitive?: boolean;
  access?: 'granted' | 'potential';
  providerId?: string;
  lastSeen: number;
}
export interface RevokeGuide {
  agentId: string;
  category: string;
  steps: string[];
  openPath?: string;
}
export interface UninstallGuide {
  agentId: string;
  agentName: string;
  steps: string[];
  openPath?: string;
}
export interface TokenTip {
  category: 'cache' | 'right-size' | 'concentration';
  title: string;
  body: string;
}
export interface PriceEntry {
  pattern: string;
  match?: 'model' | 'substring';
  label: string;
  input: number;
  output: number;
  cacheWrite: number | null;
  cacheRead: number | null;
}
export interface CostBreakdown {
  total: number;
  pricedTokens: number;
  unpricedTokens: number;
  byAgent: { agentId: string; cost: number }[];
  byModel: { model: string; cost: number }[];
  byProject: { project: string; cost: number }[];
  series: { date: string; cost: number }[];
}
export interface TokenSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreateTokens: number;
  totalTokens: number;
  cacheHitRate: number;
  byAgent: { agentId: string; tokens: number }[];
  byModel: { model: string; tokens: number }[];
  byProject: { project: string; tokens: number }[];
  series: { date: string; input: number; output: number; cacheRead: number; cacheCreate: number; total: number }[];
  hourly: { hour: number; total: number }[];
  models: string[];
  tips: TokenTip[];
  costEnabled: boolean;
  cost?: CostBreakdown;
}
export interface Sample {
  agentId: string;
  pid: number;
  ts: number;
  cpu: number;
  gpu: number;
  rssMb: number;
  threads: number;
}
export interface GpuSample {
  ts: number;
  util: number;
  memUsedMb: number;
  name: string;
}
export interface Settings {
  codexInputRatio: number;
  scanIntervalSec: number;
  perfIntervalMs: number;
  retentionDays: number;
  costEnabled?: boolean;
  priceTable?: PriceEntry[];
  defaultPriceTable?: PriceEntry[];
  customPriceTable?: boolean;
  priceTableError?: string;
  pricingInfo?: {
    verifiedAt: string;
    sources: { name: string; url: string }[];
    reviews: { reviewOn: string; message: string; due: boolean }[];
  };
}
export interface ErrorRecord {
  agentId: string;
  ts: number;
  source: string;
  message: string;
  kind: string;
}
export interface ErrorSummary {
  byAgent: { agentId: string; count24h: number; count1h: number; total: number }[];
  recent: ErrorRecord[];
  total24h: number;
}
export interface LatencyPoint {
  agentId: string;
  ts: number;
  latencyMs: number;
}
export interface LatencySummary {
  points: LatencyPoint[];
  byAgent: { agentId: string; count: number; avgMs: number; p50Ms: number; p95Ms: number; maxMs: number }[];
}
export interface ProjectAgentUsage {
  agentId: string;
  sessions: number;
  lastSeen: number;
}
export interface Project {
  id: string;
  path: string;
  name: string;
  sessions: number;
  lastSeen: number;
  agents: ProjectAgentUsage[];
  gitBranch?: string;
  gitOrigin?: string;
}
export interface ProjectsSummary {
  projects: Project[];
  totalProjects: number;
  totalSessions: number;
}
export type ActivityRole = 'user' | 'assistant' | 'system' | 'tool';
export interface ActivityRow {
  id: number;
  agentId: string;
  sessionId: string | null;
  ts: number;
  role: ActivityRole;
  contentPreview: string;
  model: string | null;
  source: string;
  tokens: number;
  audio: boolean;
  cost?: number | null;
}
export interface ActivityListResponse {
  total: number;
  rows: ActivityRow[];
  agents: { agentId: string; count: number }[];
  costEnabled: boolean;
}
export interface ActivityStats {
  total: number;
  byRole: { user: number; assistant: number; system: number; tool: number };
  audio: { user: number; assistant: number; total: number };
  sessions: number;
  totalTokens: number;
  avgTokensPerMsg: number;
  topModel: { name: string; count: number; share: number } | null;
}
export interface ActivitySessionSummary {
  sessionId: string;
  displaySessionId: string;
  agentId: string;
  model: string | null;
  firstTs: number;
  lastTs: number;
  eventCount: number;
  userCount: number;
  assistantCount: number;
  toolCount: number;
  totalTokens: number;
  durationMs: number;
  lastRole: ActivityRole;
  status: 'active' | 'waiting' | 'idle' | 'stale';
  needsAttention: boolean;
  cost?: number | null;
  unpricedTokens?: number;
}

export type DownloadKind = 'install' | 'extension' | 'download' | 'document' | 'model' | 'dataset';
export interface DownloadRow {
  id: number;
  agentId: string;
  sessionId: string | null;
  ts: number;
  kind: DownloadKind;
  manager: string;
  name: string;
  version: string | null;
  target: string | null;
  command: string | null;
  source: string | null;
  status: string;
  riskFlags: string[];
  notes: string | null;
}
export interface DownloadListResponse {
  total: number;
  rows: DownloadRow[];
  agents: { agentId: string; count: number }[];
  byManager: { manager: string; count: number }[];
  byKind: { kind: DownloadKind; count: number }[];
  flagged: number;
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ActivityRow, ActivitySessionSummary, ActivityStats, Agent, ActivityListResponse, apiKeys, getSnapshot } from '../lib/api';
import { useCachedQuery } from '../lib/useCachedQuery';
import { PageHeader, Pill, EmptyState } from '../components/Bits';
import { fmtRel } from '../lib/format';
import { fmtUsd } from '../lib/format';
import { IntegrationNotice } from '../components/IntegrationNotice';
import {
  RefreshCw,
  Search,
  Trash2,
  Download,
  User,
  Bot,
  Settings as SettingsIcon,
  Wrench,
  Copy,
  X,
  ChevronRight,
  ChevronDown,
  MessageSquare,
  Coins,
  ListTree,
  Check,
  Mic,
  Sparkles,
  Hash,
  Cpu,
  DollarSign,
  Zap,
  Bell,
} from 'lucide-react';

const ROLE_META: Record<string, { Icon: any; label: string; tone: 'default' | 'amber' | 'red' | 'green' }> = {
  user: { Icon: User, label: 'User', tone: 'default' },
  assistant: { Icon: Bot, label: 'Assistant', tone: 'green' },
  system: { Icon: SettingsIcon, label: 'System', tone: 'amber' },
  tool: { Icon: Wrench, label: 'Tool', tone: 'default' },
};

// Read-only session status → dot color + label. `waiting` is the "needs-you"
// signal derived from the transcript on the backend.
const STATUS_META: Record<string, { dot: string; label: string }> = {
  active:  { dot: 'bg-emerald-500', label: 'Active' },
  waiting: { dot: 'bg-amber-500',   label: 'Needs you' },
  idle:    { dot: 'bg-slate-400',   label: 'Idle' },
  stale:   { dot: 'bg-slate-300',   label: 'Stale' },
};

const RANGES = [
  { label: 'Last hour', ms: 60 * 60 * 1000 },
  { label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  { label: 'All time', ms: 0 },
];

function fmtAbs(ts: number) {
  return new Date(ts).toLocaleString();
}
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}m`;
}

type Turn = {
  request?: ActivityRow;
  responses: ActivityRow[]; // assistant + tool + system after the user message
};

// Walk events in timestamp order and split into request → response turns.
// A new turn starts on each `user` event; everything after (until the next
// `user`) belongs to its response side.
function buildTurns(events: ActivityRow[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const e of events) {
    if (e.role === 'user') {
      if (cur) turns.push(cur);
      cur = { request: e, responses: [] };
    } else {
      if (!cur) cur = { responses: [] };
      cur.responses.push(e);
    }
  }
  if (cur) turns.push(cur);
  return turns;
}

export default function Activity() {
  const [view, setView] = useState<'sessions' | 'events'>('events');
  // agents is read on nearly every page — share the cached snapshot so
  // navigating into Activity never starts with an empty filter dropdown.
  const agentsQ = useCachedQuery(apiKeys.agents(), () => api.agents());
  const agents: Agent[] = agentsQ.data?.agents ?? [];
  const [agentFilter, setAgentFilter] = useState<string>('all');
  // Multi-select role filter. Empty Set = all roles allowed.
  const ALL_ROLES = ['user', 'assistant', 'system', 'tool'] as const;
  const [roleFilter, setRoleFilter] = useState<Set<string>>(new Set(ALL_ROLES));

  // Serialize the role multi-select for the API. Return undefined when no
  // narrowing is needed — i.e. all roles selected (the default) or none.
  function roleParam(): string | undefined {
    if (roleFilter.size === 0 || roleFilter.size === ALL_ROLES.length) return undefined;
    return [...roleFilter].join(',');
  }
  function toggleRole(role: string) {
    setRoleFilter((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }
  // Multi-select role dropdown: open/close + click-outside dismissal.
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const roleMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!roleMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!roleMenuRef.current) return;
      if (!roleMenuRef.current.contains(e.target as Node)) setRoleMenuOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [roleMenuOpen]);
  const allRolesSelected = roleFilter.size === ALL_ROLES.length;
  const roleButtonLabel = allRolesSelected || roleFilter.size === 0
    ? 'All roles'
    : roleFilter.size === 1
      ? `${ROLE_META[[...roleFilter][0]].label} only`
      : `${roleFilter.size} roles`;
  const [rangeMs, setRangeMs] = useState<number>(60 * 60 * 1000);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [modality, setModality] = useState<'all' | 'text' | 'audio'>('all');

  // Defaults match the useState initializers above. We use them ONLY to
  // synchronously look up any snapshot left in the cache from a previous
  // mount, so the page paints with real data instead of empties on return.
  const initialFilters = useMemo(
    () => ({ agentId: undefined as string | undefined, role: undefined as string | undefined, modality: 'all' as const, sinceMs: 60 * 60 * 1000, q: undefined as string | undefined }),
    [],
  );
  const initialEventsSnap = getSnapshot<ActivityListResponse>(apiKeys.activity({ ...initialFilters, limit: 100 }));
  const initialStatsSnap = getSnapshot<ActivityStats>(apiKeys.activityStats(initialFilters));
  const initialSessionsSnap = getSnapshot<{ sessions: ActivitySessionSummary[]; total: number }>(
    apiKeys.activitySessions({ agentId: undefined, modality: 'all', sinceMs: 60 * 60 * 1000, limit: 200 }),
  );

  const [stats, setStats] = useState<ActivityStats | null>(initialStatsSnap ?? null);

  // Events view state
  const [rows, setRows] = useState<ActivityRow[]>(initialEventsSnap?.rows ?? []);
  const [total, setTotal] = useState(initialEventsSnap?.total ?? 0);
  const [counts, setCounts] = useState<{ agentId: string; count: number }[]>(initialEventsSnap?.agents ?? []);
  const PAGE_SIZE = 100;
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);

  // Sessions view state
  const [sessions, setSessions] = useState<ActivitySessionSummary[]>(initialSessionsSnap?.sessions ?? []);
  const [sessionsTotal, setSessionsTotal] = useState(initialSessionsSnap?.total ?? 0);
  const [openSessionKey, setOpenSessionKey] = useState<string | null>(null);
  const [openSessionEvents, setOpenSessionEvents] = useState<ActivityRow[] | null>(null);
  const [openSessionLoading, setOpenSessionLoading] = useState(false);
  // Whether cost estimation is enabled (from the sessions/detail responses).
  const [costEnabled, setCostEnabled] = useState(false);
  // "Needs you" filter for the sessions view.
  const [needsOnly, setNeedsOnly] = useState(false);
  // Live auto-refresh (polling) toggle.
  const [live, setLive] = useState(false);

  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [purging, setPurging] = useState(false);

  // Detail drawer
  const [openId, setOpenId] = useState<number | null>(null);
  const [openContent, setOpenContent] = useState<{ content: string; row: ActivityRow } | null>(null);
  const [openLoading, setOpenLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  async function loadEvents() {
    setLoading(true);
    try {
      const r = await api.activity({
        agentId: agentFilter === 'all' ? undefined : agentFilter,
        role: roleParam(),
        modality,
        sinceMs: rangeMs || undefined,
        q: debouncedQ || undefined,
        limit,
      });
      setRows(r.rows);
      setTotal(r.total);
      setCounts(r.agents);
      setCostEnabled(r.costEnabled);
    } finally {
      setLoading(false);
    }
  }

  async function loadSessions() {
    setLoading(true);
    try {
      const r = await api.activitySessions({
        agentId: agentFilter === 'all' ? undefined : agentFilter,
        modality,
        sinceMs: rangeMs || undefined,
        limit: 200,
      });
      setSessions(r.sessions);
      setSessionsTotal(r.total);
      setCostEnabled(r.costEnabled);
      if (counts.length === 0) {
        api
          .activity({
            agentId: agentFilter === 'all' ? undefined : agentFilter,
            sinceMs: rangeMs || undefined,
            limit: 1,
          })
          .then((res) => {
            setCounts(res.agents);
            setTotal(res.total);
          })
          .catch(() => {});
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    setLoadingMore(true);
    try {
      const r = await api.activity({
        agentId: agentFilter === 'all' ? undefined : agentFilter,
        role: roleParam(),
        modality,
        sinceMs: rangeMs || undefined,
        q: debouncedQ || undefined,
        limit: PAGE_SIZE,
        offset: rows.length,
      });
      setRows((prev) => [...prev, ...r.rows]);
      setTotal(r.total);
      setCounts(r.agents);
      setCostEnabled(r.costEnabled);
      setLimit(rows.length + r.rows.length);
    } finally {
      setLoadingMore(false);
    }
  }

  // Fetch the aggregated stats whenever any filter changes. Cheap COUNT/SUM
  // queries — runs alongside the rows fetch.
  async function loadStats() {
    try {
      const s = await api.activityStats({
        agentId: agentFilter === 'all' ? undefined : agentFilter,
        role: roleParam(),
        modality,
        sinceMs: rangeMs || undefined,
        q: debouncedQ || undefined,
      });
      setStats(s);
    } catch {
      /* ignore — stats are best-effort */
    }
  }

  useEffect(() => {
    setLimit(PAGE_SIZE);
    loadStats();
    if (view === 'events') loadEvents();
    else {
      setOpenSessionKey(null);
      setOpenSessionEvents(null);
      loadSessions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, agentFilter, roleFilter, rangeMs, debouncedQ, modality]);

  // Live auto-refresh: poll stats + the active view on an interval while the
  // tab is visible. Non-disruptive — it refreshes the list/stats only and never
  // collapses an expanded session or closes the detail drawer.
  useEffect(() => {
    if (!live) return;
    const INTERVAL_MS = 10_000;
    const tick = () => {
      if (document.hidden) return;
      loadStats();
      if (view === 'events') loadEvents();
      else loadSessions();
    };
    const id = setInterval(tick, INTERVAL_MS);
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, view, agentFilter, roleFilter, rangeMs, debouncedQ, modality]);

  async function rescan() {
    setScanning(true);
    try {
      await api.scanActivity();
      if (view === 'events') await loadEvents();
      else await loadSessions();
    } finally {
      setScanning(false);
    }
  }

  async function purge() {
    const scope = agentFilter === 'all' ? 'ALL activity history' : `activity for ${agentName(agentFilter)}`;
    if (!confirm(`Delete ${scope}? This cannot be undone.`)) return;
    setPurging(true);
    try {
      await api.purgeActivity(agentFilter === 'all' ? undefined : agentFilter);
      if (view === 'events') await loadEvents();
      else await loadSessions();
    } finally {
      setPurging(false);
    }
  }

  async function deleteOne(id: number) {
    if (!confirm('Delete this activity event?')) return;
    await api.deleteActivity(id);
    setOpenId(null);
    setOpenContent(null);
    if (view === 'events') await loadEvents();
    else await loadSessions();
  }

  async function openRow(row: ActivityRow) {
    setOpenId(row.id);
    setOpenLoading(true);
    setOpenContent(null);
    try {
      const r = await api.activityContent(row.id);
      setOpenContent(r);
    } finally {
      setOpenLoading(false);
    }
  }

  async function toggleSession(s: ActivitySessionSummary) {
    const key = `${s.agentId}::${s.sessionId}`;
    if (openSessionKey === key) {
      setOpenSessionKey(null);
      setOpenSessionEvents(null);
      return;
    }
    setOpenSessionKey(key);
    setOpenSessionEvents(null);
    setOpenSessionLoading(true);
    try {
      const r = await api.activitySession(s.agentId, s.sessionId);
      setOpenSessionEvents(r.events);
      setCostEnabled(r.costEnabled);
    } finally {
      setOpenSessionLoading(false);
    }
  }

  function exportCsv() {
    const header = ['timestamp_iso', 'agent', 'role', 'session', 'model', 'tokens', 'preview'];
    if (costEnabled) header.splice(6, 0, 'cost_usd');
    const out = [
      header,
      ...rows.map((r) => {
        const base = [
          new Date(r.ts).toISOString(),
          r.agentId,
          r.role,
          r.sessionId || '',
          r.model || '',
          String(r.tokens || 0),
          r.contentPreview.replace(/"/g, '""'),
        ];
        if (costEnabled) base.splice(6, 0, r.cost != null ? r.cost.toFixed(6) : '');
        return base;
      }),
    ];
    const csv = out.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cioppino-activity-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function agentName(id: string): string {
    return agents.find((a) => a.id === id)?.name || id;
  }

  const installedAgentOptions = useMemo(() => {
    const haveAny = new Set([...counts.map((c) => c.agentId), ...agents.filter((a) => a.installed).map((a) => a.id)]);
    return agents.filter((a) => haveAny.has(a.id));
  }, [agents, counts]);

  // Count of sessions currently awaiting the user (the "needs-you" signal).
  const needsCount = useMemo(() => sessions.filter((s) => s.needsAttention).length, [sessions]);
  // Apply the "Needs you" filter; waiting sessions always sort to the top.
  const displaySessions = useMemo(() => {
    const list = needsOnly ? sessions.filter((s) => s.needsAttention) : sessions;
    return [...list].sort((a, b) => {
      if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
      return b.lastTs - a.lastTs;
    });
  }, [sessions, needsOnly]);

  return (
    <div>
      <PageHeader
        title="Activity"
        subtitle="Every prompt, response, and tool call from your AI agents — searchable and auditable."
        actions={
          <>
            <button
              type="button"
              onClick={() => setLive((v) => !v)}
              title={live ? 'Live auto-refresh on — click to pause' : 'Auto-refresh every 10s'}
              className={`px-3 py-1.5 rounded-lg border text-sm font-medium inline-flex items-center gap-1.5 ${
                live
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  : 'bg-cream border-ciop-200 text-espresso hover:bg-cream/70'
              }`}
            >
              <Zap size={14} className={live ? 'text-emerald-600' : ''} />
              {live ? 'Live' : 'Live off'}
            </button>
            {view === 'events' && (
              <button
                type="button"
                onClick={exportCsv}
                disabled={rows.length === 0}
                className="px-3 py-1.5 rounded-lg bg-cream border border-ciop-200 text-espresso text-sm font-medium hover:bg-cream/70 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Download size={14} /> Export CSV
              </button>
            )}
            <button
              type="button"
              onClick={purge}
              disabled={purging}
              className="px-3 py-1.5 rounded-lg bg-cream border border-red-200 text-red-700 text-sm font-medium hover:bg-red-50 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <Trash2 size={14} /> {purging ? 'Purging…' : 'Purge'}
            </button>
            <button
              type="button"
              onClick={rescan}
              disabled={scanning}
              className="px-3 py-1.5 rounded-lg bg-ciop-600 text-white text-sm font-medium hover:bg-ciop-700 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
              {scanning ? 'Scanning…' : 'Rescan'}
            </button>
          </>
        }
      />

      <IntegrationNotice agents={agents} feature="activity" agentId={agentFilter} />
      <div className="px-8 pb-8 space-y-4">
        {costEnabled && <p className="text-sm text-espresso/60">
          Costs use the current standard text rates in Settings, not historical invoices.
          Unmatched models are unpriced (n/a) and excluded from totals; session costs may be partial.
          Token counts and input/output splits are estimates.
        </p>}
        {/* Aggregated stats — reflects current filter selection. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
          <StatTile label="User msgs"    value={stats?.byRole.user ?? 0}      tone="ciop"    Icon={MessageSquare} />
          <StatTile label="Assistant"    value={stats?.byRole.assistant ?? 0} tone="emerald" Icon={Sparkles} />
          <StatTile
            label="Voice"
            value={stats?.audio.total ?? 0}
            tone="rose"
            Icon={Mic}
            sub={stats ? `${stats.audio.user} user · ${stats.audio.assistant} asst` : undefined}
          />
          <StatTile label="Tool calls"   value={stats?.byRole.tool ?? 0}      tone="amber"   Icon={Wrench} />
          <StatTile label="Sessions"     value={stats?.sessions ?? 0}         tone="sky"     Icon={ListTree} />
          <StatTile label="Tokens"       value={stats?.totalTokens ?? 0}      tone="ciop"    Icon={Coins}    formatBig />
          <StatTile label="Avg / msg"    value={stats?.avgTokensPerMsg ?? 0}  tone="slate"   Icon={Hash} />
          <StatTile
            label="Top model"
            value={stats?.topModel?.name ?? '—'}
            tone="purple"
            Icon={Cpu}
            sub={stats?.topModel ? `${Math.round(stats.topModel.share * 100)}% of msgs` : undefined}
            isText
          />
        </div>

        {/* View toggle + filter bar */}
        <div className="bg-white border border-ciop-100 rounded-2xl p-4 flex flex-wrap items-center gap-3 shadow-soft">
          <div className="inline-flex rounded-lg border border-ciop-200 bg-cream overflow-hidden">
            <button
              type="button"
              onClick={() => setView('sessions')}
              className={`px-3 py-2 text-sm font-medium inline-flex items-center gap-1.5 ${
                view === 'sessions' ? 'bg-ciop-600 text-white' : 'text-espresso hover:bg-white'
              }`}
            >
              <ListTree size={14} /> Sessions
            </button>
            <button
              type="button"
              onClick={() => setView('events')}
              className={`px-3 py-2 text-sm font-medium inline-flex items-center gap-1.5 ${
                view === 'events' ? 'bg-ciop-600 text-white' : 'text-espresso hover:bg-white'
              }`}
            >
              <MessageSquare size={14} /> Events
            </button>
          </div>

          {view === 'sessions' && (
            <button
              type="button"
              onClick={() => setNeedsOnly((v) => !v)}
              title="Show only sessions that appear to be waiting on you"
              className={`px-3 py-2 rounded-lg border text-sm font-medium inline-flex items-center gap-1.5 ${
                needsOnly
                  ? 'bg-amber-100 border-amber-300 text-amber-800'
                  : 'bg-cream border-ciop-200 text-espresso hover:bg-white'
              }`}
            >
              <Bell size={14} /> Needs you
              {needsCount > 0 && (
                <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-amber-500 text-white text-[10px] font-semibold leading-none">
                  {needsCount}
                </span>
              )}
            </button>
          )}

          {view === 'events' && (
            <div className="relative flex-1 min-w-[220px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-espresso/40" />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search prompts and responses…"
                className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-ciop-200 bg-cream focus:outline-none focus:ring-2 focus:ring-ciop-400"
              />
            </div>
          )}

          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="px-3 py-2 text-sm rounded-lg border border-ciop-200 bg-cream"
          >
            <option value="all">All agents{view === 'events' ? ` (${total})` : ''}</option>
            {installedAgentOptions.map((a) => {
              const c = counts.find((x) => x.agentId === a.id)?.count ?? 0;
              return (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {view === 'events' ? ` (${c})` : ''}
                </option>
              );
            })}
          </select>

          {view === 'events' && (
            <div ref={roleMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setRoleMenuOpen((o) => !o)}
                className="px-3 py-2 text-sm rounded-lg border border-ciop-200 bg-cream inline-flex items-center gap-2 hover:bg-white transition-colors"
                aria-haspopup="listbox"
                aria-expanded={roleMenuOpen}
              >
                <span>{roleButtonLabel}</span>
                <ChevronDown size={14} className={`transition-transform ${roleMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {roleMenuOpen && (
                <div
                  role="listbox"
                  aria-multiselectable="true"
                  className="absolute z-20 mt-1 left-0 min-w-[180px] rounded-lg border border-ciop-200 bg-cream shadow-lg overflow-hidden"
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={allRolesSelected}
                    onClick={() =>
                      setRoleFilter(allRolesSelected ? new Set() : new Set(ALL_ROLES))
                    }
                    className="w-full text-left px-3 py-2 text-sm inline-flex items-center gap-2 hover:bg-white border-b border-ciop-100"
                  >
                    <span className={`inline-flex h-4 w-4 items-center justify-center rounded border ${
                      allRolesSelected ? 'bg-ciop-600 border-ciop-600 text-white' : 'border-ciop-300 bg-white'
                    }`}>
                      {allRolesSelected && <Check size={12} />}
                    </span>
                    <span className="font-medium">All roles</span>
                  </button>
                  {ALL_ROLES.map((r) => {
                    const meta = ROLE_META[r];
                    const Icon = meta.Icon;
                    const active = roleFilter.has(r);
                    return (
                      <button
                        key={r}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => toggleRole(r)}
                        className="w-full text-left px-3 py-2 text-sm inline-flex items-center gap-2 hover:bg-white"
                      >
                        <span className={`inline-flex h-4 w-4 items-center justify-center rounded border ${
                          active ? 'bg-ciop-600 border-ciop-600 text-white' : 'border-ciop-300 bg-white'
                        }`}>
                          {active && <Check size={12} />}
                        </span>
                        <Icon size={13} className="text-espresso/70" />
                        <span>{meta.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <select
            value={rangeMs}
            onChange={(e) => setRangeMs(parseInt(e.target.value, 10))}
            className="px-3 py-2 text-sm rounded-lg border border-ciop-200 bg-cream"
          >
            {RANGES.map((r) => (
              <option key={r.label} value={r.ms}>
                {r.label}
              </option>
            ))}
          </select>

          <select
            value={modality}
            onChange={(e) => setModality(e.target.value as 'all' | 'text' | 'audio')}
            className="px-3 py-2 text-sm rounded-lg border border-ciop-200 bg-cream"
            title="Filter by message modality"
          >
            <option value="all">All modalities</option>
            <option value="text">Text only</option>
            <option value="audio">Audio only</option>
          </select>
        </div>

        {/* Sessions view */}
        {view === 'sessions' && (
          <div className="space-y-3">
            {loading && sessions.length === 0 ? (
              <div className="bg-white border border-ciop-100 rounded-2xl p-10 text-center text-espresso/60 text-sm shadow-soft">
                Loading…
              </div>
            ) : sessions.length === 0 ? (
              <EmptyState
                title="No sessions found"
                hint="Click Rescan to import transcripts, or widen the time range."
              />
            ) : (
              <>
                <div className="text-xs text-espresso/55 px-1">
                  Showing {displaySessions.length}{needsOnly ? '' : ` of ${sessionsTotal}`} session{displaySessions.length === 1 ? '' : 's'}
                  {needsOnly && ' that need you'}
                </div>
                {displaySessions.map((s) => {
                  const key = `${s.agentId}::${s.sessionId}`;
                  const isOpen = openSessionKey === key;
                  const st = STATUS_META[s.status] ?? STATUS_META.idle;
                  return (
                    <div key={key} className="bg-white border border-ciop-100 rounded-2xl shadow-soft overflow-hidden">
                      <button
                        type="button"
                        onClick={() => toggleSession(s)}
                        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-cream/40"
                      >
                        {isOpen ? (
                          <ChevronDown size={16} className="text-espresso/60 flex-none" />
                        ) : (
                          <ChevronRight size={16} className="text-espresso/60 flex-none" />
                        )}
                        <span
                          className={`flex-none w-2 h-2 rounded-full ${st.dot} ${s.status === 'active' ? 'animate-pulse' : ''}`}
                          title={st.label}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-espresso">{agentName(s.agentId)}</span>
                            {s.needsAttention && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-semibold">
                                <Bell size={10} /> Needs you
                              </span>
                            )}
                            <span className="text-xs text-espresso/55 font-mono truncate" title={s.sessionId}>
                              {s.displaySessionId}
                            </span>
                            {s.model && (
                              <Pill tone="default">
                                <span className="text-[11px]">{s.model}</span>
                              </Pill>
                            )}
                          </div>
                          <div className="text-xs text-espresso/55 mt-0.5 flex items-center gap-3 flex-wrap">
                            <span title={fmtAbs(s.lastTs)}>{fmtRel(s.lastTs)}</span>
                            <span>·</span>
                            <span>
                              {s.userCount} ask{s.userCount === 1 ? '' : 's'} · {s.assistantCount} repl
                              {s.assistantCount === 1 ? 'y' : 'ies'}
                              {s.toolCount > 0 ? ` · ${s.toolCount} tool` : ''}
                              {s.toolCount > 1 ? 's' : ''}
                            </span>
                            <span>·</span>
                            <span className="inline-flex items-center gap-1">
                              <Coins size={11} /> {fmtTokens(s.totalTokens)} tokens (≈)
                            </span>
                            {costEnabled && (
                              <>
                                <span>·</span>
                                <span className="inline-flex items-center gap-0.5 text-emerald-700 font-medium" title="Estimated cost">
                                  <DollarSign size={11} /> {s.cost == null ? 'n/a' : fmtUsd(s.cost)}
                                  {!!s.unpricedTokens && s.cost != null && ' (partial)'}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </button>

                      {isOpen && (
                        <div className="border-t border-ciop-100 bg-cream/30 px-4 py-4">
                          {openSessionLoading ? (
                            <div className="text-sm text-espresso/55 py-6 text-center">Loading turns…</div>
                          ) : openSessionEvents && openSessionEvents.length > 0 ? (
                            <div className="space-y-3">
                              {buildTurns(openSessionEvents).map((t, i) => {
                                const turnCost = costEnabled
                                  ? ((t.request?.cost ?? 0) + t.responses.reduce((sum, r) => sum + (r.cost ?? 0), 0))
                                  : 0;
                                return (
                                <div key={i} className="space-y-2">
                                  {costEnabled && turnCost > 0 && (
                                    <div className="flex justify-end">
                                      <span className="inline-flex items-center gap-0.5 text-[11px] text-emerald-700 font-medium" title="Estimated cost for this turn">
                                        <DollarSign size={10} /> {fmtUsd(turnCost)}
                                      </span>
                                    </div>
                                  )}
                                  {t.request && <TurnSide row={t.request} side="request" onOpen={openRow} />}
                                  {t.responses.length > 0 && (
                                    <div className="space-y-2 pl-4 border-l-2 border-ciop-200">
                                      {t.responses.map((r) => (
                                        <TurnSide key={r.id} row={r} side="response" onOpen={openRow} />
                                      ))}
                                    </div>
                                  )}
                                </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="text-sm text-espresso/55 py-6 text-center">No events in this session.</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {/* Events view */}
        {view === 'events' && (
          <div className="bg-white border border-ciop-100 rounded-2xl shadow-soft overflow-hidden">
            {loading && rows.length === 0 ? (
              <div className="p-10 text-center text-espresso/60 text-sm">Loading…</div>
            ) : rows.length === 0 ? (
              <EmptyState
                title="No activity found"
                hint={
                  total === 0
                    ? 'Click Rescan to import transcripts from your agents’ log directories.'
                    : 'Try clearing filters or broadening the time range.'
                }
              />
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wider text-espresso/50 border-b border-ciop-100">
                  <tr>
                    <th className="py-3 px-4">When</th>
                    <th className="py-3 px-4">Agent</th>
                    <th className="py-3 px-4">Role</th>
                    <th className="py-3 px-4">Preview</th>
                    <th className="py-3 px-4 text-right">Tokens</th>
                    {costEnabled && <th className="py-3 px-4 text-right">Cost</th>}
                    <th className="py-3 px-4">Model</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const meta = ROLE_META[r.role] || ROLE_META.user;
                    const Icon = meta.Icon;
                    return (
                      <tr
                        key={r.id}
                        className="border-b border-ciop-50 hover:bg-cream/40 cursor-pointer"
                        onClick={() => openRow(r)}
                      >
                        <td className="py-2.5 px-4 whitespace-nowrap text-espresso/70" title={fmtAbs(r.ts)}>
                          {fmtRel(r.ts)}
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap font-medium">{agentName(r.agentId)}</td>
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <Pill tone={meta.tone as any}>
                            <span className="inline-flex items-center gap-1">
                              <Icon size={11} /> {meta.label}
                            </span>
                          </Pill>
                        </td>
                        <td className="py-2.5 px-4 text-espresso/85 max-w-[520px] truncate">{r.contentPreview}</td>
                        <td className="py-2.5 px-4 whitespace-nowrap text-right text-espresso/70 font-mono text-xs">
                          {fmtTokens(r.tokens || 0)}
                        </td>
                        {costEnabled && (
                          <td className="py-2.5 px-4 whitespace-nowrap text-right text-espresso/70 font-mono text-xs">
                            {r.cost != null ? fmtUsd(r.cost) : 'n/a'}
                          </td>
                        )}
                        <td className="py-2.5 px-4 whitespace-nowrap text-espresso/55 text-xs">{r.model || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {rows.length > 0 && (
              <div className="px-4 py-3 border-t border-ciop-100 text-xs text-espresso/55 flex items-center justify-between gap-3 flex-wrap">
                <span>
                  Showing {rows.length} of {total} matching events
                </span>
                {rows.length < total && (
                  <button
                    type="button"
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="px-3 py-1.5 rounded-lg bg-ciop-600 text-white text-xs font-medium hover:bg-ciop-700 disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    <RefreshCw size={12} className={loadingMore ? 'animate-spin' : ''} />
                    {loadingMore ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, total - rows.length)} more`}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Detail drawer */}
      {openId !== null && (
        <div
          className="fixed inset-0 z-40 bg-black/30 flex justify-end"
          onClick={() => {
            setOpenId(null);
            setOpenContent(null);
          }}
        >
          <div
            className="w-full max-w-3xl h-full bg-cream shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-ciop-200 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-xs text-espresso/55 mb-1">
                  {openContent ? fmtAbs(openContent.row.ts) : ''} ·{' '}
                  {openContent ? agentName(openContent.row.agentId) : ''}
                  {openContent?.row.model ? ` · ${openContent.row.model}` : ''}
                  {openContent ? ` · ≈${fmtTokens(openContent.row.tokens || 0)} tokens` : ''}
                  {openContent && costEnabled && openContent.row.cost != null && openContent.row.cost > 0
                    ? ` · ≈${fmtUsd(openContent.row.cost)}`
                    : ''}
                </div>
                <div className="font-display text-lg font-semibold text-ciop-700 capitalize">
                  {openContent?.row.role || 'Loading…'}
                </div>
                {openContent?.row.sessionId && (
                  <div className="text-xs text-espresso/50 mt-1 truncate">session: {openContent.row.sessionId}</div>
                )}
              </div>
              <div className="flex items-center gap-2">
                {openContent && (
                  <>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard.writeText(openContent.content)}
                      className="px-2.5 py-1.5 rounded-lg bg-white border border-ciop-200 text-espresso text-xs font-medium hover:bg-white/70 inline-flex items-center gap-1.5"
                    >
                      <Copy size={12} /> Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteOne(openContent.row.id)}
                      className="px-2.5 py-1.5 rounded-lg bg-white border border-red-200 text-red-700 text-xs font-medium hover:bg-red-50 inline-flex items-center gap-1.5"
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  </>
                )}
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => {
                    setOpenId(null);
                    setOpenContent(null);
                  }}
                  className="p-1.5 rounded-lg hover:bg-white"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-6">
              {openLoading ? (
                <div className="text-center text-espresso/55 text-sm py-10">Loading…</div>
              ) : openContent ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-espresso">
                  {openContent.content}
                </pre>
              ) : null}
            </div>
            {openContent && (
              <div className="px-6 py-2 border-t border-ciop-200 text-[11px] text-espresso/45 truncate">
                {openContent.row.source}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TurnSide({
  row,
  side,
  onOpen,
}: {
  row: ActivityRow;
  side: 'request' | 'response';
  onOpen: (r: ActivityRow) => void;
}) {
  const meta = ROLE_META[row.role] || ROLE_META.user;
  const Icon = meta.Icon;
  const bg =
    side === 'request'
      ? 'bg-ciop-50 border-ciop-200'
      : row.role === 'tool'
        ? 'bg-amber-50 border-amber-200'
        : 'bg-emerald-50 border-emerald-200';
  return (
    <button
      type="button"
      onClick={() => onOpen(row)}
      className={`w-full text-left rounded-xl border ${bg} p-3 hover:shadow-soft transition-shadow`}
    >
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-espresso/60 font-semibold">
          <Icon size={12} />
          {side === 'request' ? 'Request' : meta.label}
        </div>
        <div className="text-[11px] text-espresso/55 inline-flex items-center gap-2 flex-none">
          <span className="font-mono inline-flex items-center gap-1">
            <Coins size={10} /> {fmtTokens(row.tokens || 0)}
          </span>
          <span>{fmtRel(row.ts)}</span>
        </div>
      </div>
      <div className="text-sm text-espresso/85 line-clamp-3 whitespace-pre-wrap break-words">
        {row.contentPreview}
      </div>
    </button>
  );
}

const TONE_ACCENT: Record<string, { chip: string; label: string }> = {
  ciop:    { chip: 'bg-ciop-50 text-ciop-700',       label: 'text-ciop-700' },
  emerald: { chip: 'bg-emerald-50 text-emerald-700', label: 'text-emerald-700' },
  rose:    { chip: 'bg-rose-50 text-rose-700',       label: 'text-rose-700' },
  amber:   { chip: 'bg-amber-50 text-amber-700',     label: 'text-amber-700' },
  sky:     { chip: 'bg-sky-50 text-sky-700',         label: 'text-sky-700' },
  slate:   { chip: 'bg-slate-100 text-slate-700',    label: 'text-slate-700' },
  purple:  { chip: 'bg-purple-50 text-purple-700',   label: 'text-purple-700' },
};

function fmtBig(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function StatTile({
  label,
  value,
  sub,
  Icon,
  tone,
  formatBig,
  isText,
}: {
  label: string;
  value: number | string;
  sub?: string;
  Icon: any;
  tone: 'ciop' | 'emerald' | 'rose' | 'amber' | 'sky' | 'slate' | 'purple';
  formatBig?: boolean;
  isText?: boolean;
}) {
  const display = isText
    ? String(value)
    : formatBig && typeof value === 'number'
      ? fmtBig(value)
      : typeof value === 'number'
        ? value.toLocaleString()
        : value;
  const accent = TONE_ACCENT[tone];
  return (
    <div className="card p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-espresso/60 mt-1">
        <span className={`w-5 h-5 rounded-md inline-flex items-center justify-center shrink-0 ${accent.chip}`}>
          <Icon size={12} />
        </span>
        <span className="truncate">{label}</span>
      </div>
      <div
        className={`mt-1 font-semibold ${isText ? `text-base truncate ${accent.label}` : 'text-2xl text-espresso'}`}
        title={isText ? String(value) : undefined}
      >
        {display}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-espresso/55 truncate">{sub}</div>}
    </div>
  );
}

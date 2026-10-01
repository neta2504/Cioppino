import { useEffect, useMemo, useState } from 'react';
import { api, Agent, AccessItem, TokenSummary, Sample, ActivityRow, perfStream, apiKeys, getLastPerfTick } from '../lib/api';
import { useCachedQuery } from '../lib/useCachedQuery';
import { fmtNum, fmtMb, fmtUsd } from '../lib/format';
import { fmtRel } from '../lib/format';
import { PageHeader, MetricCard, StatusDot, EmptyState } from '../components/Bits';
import { Bot, Coins, Cpu, MemoryStick, RefreshCw, Sparkles, ShieldCheck, CalendarRange, Folder, KeyRound, Plug, Puzzle, Globe, DollarSign, User, Wrench, Settings as SettingsIcon, ListChecks } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, Legend } from 'recharts';

const COLORS = ['#1E7898', '#F2A65A', '#2FA388', '#F47B5C', '#7DC9B7', '#C8A45C', '#9B5DE5', '#74B5C9'];

const ROLE_META: Record<string, { Icon: any; badge: string }> = {
  user: { Icon: User, badge: 'bg-ciop-50 text-espresso border-ciop-100' },
  assistant: { Icon: Bot, badge: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  system: { Icon: SettingsIcon, badge: 'bg-amber-50 text-amber-800 border-amber-200' },
  tool: { Icon: Wrench, badge: 'bg-violet-50 text-violet-800 border-violet-200' },
};

type RangeKey = 'today' | '7d' | '30d' | '90d' | 'lifetime';
const RANGES: { key: RangeKey; label: string; days: number }[] = [
  { key: 'today', label: 'Today', days: 1 },
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 },
  { key: 'lifetime', label: 'Lifetime', days: 36500 },
];

export default function Dashboard() {
  // Seed from the last SSE tick the shared perfStream singleton received so
  // live cards don't flash 0% every time we navigate back to this tab.
  const seedTick = getLastPerfTick();
  const [samples, setSamples] = useState<Sample[]>(seedTick?.samples ?? []);
  // Rolling ~5-minute window of samples used to draw the live CPU/GPU graph.
  const [history, setHistory] = useState<Sample[]>(seedTick?.samples ?? []);
  const [range, setRange] = useState<RangeKey>('7d');
  const rangeDef = useMemo(() => RANGES.find((r) => r.key === range)!, [range]);

  // Cached + SWR queries: returns last-known data synchronously, refetches
  // silently in the background, so navigating back to this page never shows
  // a blank flash once it has been visited at least once.
  const agentsQ = useCachedQuery(apiKeys.agents(), () => api.agents());
  const tokensQ = useCachedQuery(apiKeys.tokens(rangeDef.days), () => api.tokens(rangeDef.days));
  const accessQ = useCachedQuery(apiKeys.access(), () => api.access());

  const agents: Agent[] = agentsQ.data?.agents ?? [];
  const tokens: TokenSummary | null = tokensQ.data ?? null;
  const access: AccessItem[] = accessQ.data?.items ?? [];
  const activityQ = useCachedQuery(apiKeys.activity({ limit: 5 }), () => api.activity({ limit: 5 }));
  const activityRows: ActivityRow[] = [...(activityQ.data?.rows ?? [])]
    .sort((a, b) => b.ts - a.ts || b.id - a.id)
    .slice(0, 5);

  const [refreshing, setRefreshing] = useState(false);
  const loading =
    refreshing ||
    agentsQ.isRefreshing ||
    tokensQ.isRefreshing ||
    accessQ.isRefreshing ||
    activityQ.isRefreshing;

  useEffect(() => {
    // On cold load (no prior SSE tick buffered), pull the last minute of
    // samples from REST so the live cards have data before the first stream
    // tick lands (one perfIntervalMs, default 3s).
    api.perf(undefined, 1).then((r) => {
      if (r?.samples?.length) {
        // Keep only the most recent sample per process so the live cards show a
        // point-in-time snapshot, not a sum across the whole 1-minute window.
        const latest = new Map<string, Sample>();
        for (const s of r.samples) {
          const key = `${s.agentId}:${s.pid}`;
          const prev = latest.get(key);
          if (!prev || s.ts > prev.ts) latest.set(key, s);
        }
        const snapshot = [...latest.values()];
        setSamples((prev) => (prev.length === 0 ? snapshot : prev));
      }
    }).catch(() => {});
    // Seed the rolling window for the live CPU/GPU graph with the last 5 minutes.
    api.perf(undefined, 5).then((r) => {
      if (r?.samples?.length) {
        setHistory((prev) => (prev.length === 0 ? r.samples : prev));
      }
    }).catch(() => {});
    const off = perfStream((msg) => {
      setSamples(msg.samples);
      setHistory((prev) => {
        const cutoff = Date.now() - 5 * 60_000;
        const next = [...prev.filter((s) => s.ts >= cutoff), ...msg.samples];
        return next.slice(-2000);
      });
    });
    return off;
  }, []);

  useEffect(() => {
    const refreshActivity = () => {
      if (!document.hidden) activityQ.refresh().catch(() => {});
    };
    const timer = setInterval(refreshActivity, 10_000);
    document.addEventListener('visibilitychange', refreshActivity);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshActivity);
    };
  }, [activityQ.refresh]);

  function refresh() {
    setRefreshing(true);
    Promise.allSettled([api.scanAgents(), api.scanTokens(), api.scanAccess(), api.scanActivity()])
      .then(() => Promise.all([agentsQ.refresh(), tokensQ.refresh(), accessQ.refresh(), activityQ.refresh()]))
      .finally(() => setRefreshing(false));
  }

  const running = agents.filter((a) => a.running);
  const installed = agents.filter((a) => a.installed);
  const costEnabled = !!tokens?.costEnabled;
  const cost = tokens?.cost;
  const totalCpu = samples.reduce((s, x) => s + x.cpu, 0);
  const totalMem = samples.reduce((s, x) => s + x.rssMb, 0);
  const agentGpu = samples.reduce((s, x) => s + (x.gpu || 0), 0);
  const gpuPct = Math.min(100, agentGpu);

  const today = (tokens?.series || []).slice(-1)[0];
  const yesterday = (tokens?.series || []).slice(-2, -1)[0];
  const todayTokens = today?.total || 0;
  const trend =
    yesterday && yesterday.total > 0 ? ((todayTokens - yesterday.total) / yesterday.total) * 100 : 0;

  const accessByAgent = useMemo(() => {
    const map = new Map<
      string,
      { agentId: string; name: string; total: number; folders: number; keys: number; mcps: number; integrations: number; exts: number; sensitive: number }
    >();
    for (const it of access) {
      const name = agents.find((a) => a.id === it.agentId)?.name || it.agentId;
      let row = map.get(it.agentId);
      if (!row) {
        row = { agentId: it.agentId, name, total: 0, folders: 0, keys: 0, mcps: 0, integrations: 0, exts: 0, sensitive: 0 };
        map.set(it.agentId, row);
      }
      row.total++;
      if (it.category === 'folder') row.folders++;
      else if (it.category === 'api-key') row.keys++;
      else if (it.category === 'mcp') row.mcps++;
      else if (it.category === 'integration') row.integrations++;
      else if (it.category === 'extension') row.exts++;
      if (it.sensitive) row.sensitive++;
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [access, agents]);

  // Bucket the rolling window by 3s and pivot CPU per agent + sum agent GPU%,
  // matching the Performance page's live CPU/GPU chart.
  const perfChart = useMemo(() => {
    const bucket = new Map<number, Record<string, number>>();
    for (const s of history) {
      const t = Math.floor(s.ts / 3000) * 3000;
      if (!bucket.has(t)) bucket.set(t, { ts: t });
      const row = bucket.get(t)!;
      row[s.agentId] = (row[s.agentId] || 0) + s.cpu;
      row.__gpu = Math.min(100, (row.__gpu || 0) + (s.gpu || 0));
    }
    return [...bucket.values()]
      .sort((a, b) => (a.ts as number) - (b.ts as number))
      .map((r) => ({ ...r, time: new Date(r.ts as number).toLocaleTimeString().slice(0, 8) }));
  }, [history]);

  const perfAgentIds = useMemo(() => [...new Set(history.map((s) => s.agentId))], [history]);

  return (
    <div>
      <PageHeader
        title="The Cioppino Agents Stew"
        subtitle="Your AI agents are simmering, monitored, and ready to serve."
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <CalendarRange
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-espresso/50 pointer-events-none"
              />
              <select
                className="pl-7 pr-3 py-1.5 rounded-xl border border-ciop-100 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-ciop-300"
                value={range}
                onChange={(e) => setRange(e.target.value as RangeKey)}
              >
                {RANGES.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn-primary" onClick={refresh} disabled={loading}>
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        }
      />

      <div className={`px-8 grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6 ${costEnabled ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
        <MetricCard
          label="Active agents"
          value={<span>{running.length}<span className="text-espresso/60 font-display text-base font-medium ml-2">{running.length === 1 ? 'agent on the burner' : 'agents on the burner'}</span></span>}
          sub={`${installed.length} installed · ${agents.length} known`}
          Icon={Bot}
          tone="tomato"
        />
        <MetricCard
          label={`Tokens · ${rangeDef.label.toLowerCase()}`}
          value={fmtNum(tokens?.totalTokens || 0)}
          sub={
            <span>
              Today {fmtNum(todayTokens)}
              {trend !== 0 && (
                <span className={trend > 0 ? 'text-red-600 ml-1' : 'text-emerald-600 ml-1'}>
                  {trend > 0 ? '▲' : '▼'} {Math.abs(trend).toFixed(0)}%
                </span>
              )}
              <span className="block text-espresso/55">tokens served</span>
            </span>
          }
          Icon={Coins}
          tone="saffron"
        />
        <MetricCard
          label="Live CPU / GPU"
          value={
            <span>
              {totalCpu.toFixed(0)}%
              <span className="text-espresso/50 font-display font-medium mx-2">/</span>
              <span className="text-ciop-700">{gpuPct.toFixed(0)}%</span>
            </span>
          }
          sub={`CPU · GPU across ${samples.length} agent processes`}
          Icon={Cpu}
          tone="basil"
        />
        <MetricCard
          label="Live memory"
          value={fmtMb(totalMem)}
          sub={`across all agents · plenty of room in the pot`}
          Icon={MemoryStick}
        />
        {costEnabled && (
          <MetricCard
            label={`Est. cost · ${rangeDef.label.toLowerCase()}`}
            value={cost && cost.pricedTokens > 0 ? fmtUsd(cost.total) : 'n/a'}
            sub={cost && cost.unpricedTokens > 0 ? 'partial · unmatched models excluded' : 'estimate · standard text rates'}
            Icon={DollarSign}
            tone="tomato"
          />
        )}
      </div>

      <div className="px-8 grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="card p-5 lg:order-3">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-semibold">
              Top tokens · {rangeDef.label.toLowerCase()}
            </h2>
            <Link to="/tokens" className="text-xs text-ciop-700 hover:underline">
              View tokens →
            </Link>
          </div>
          {tokens && tokens.byAgent.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="text-left text-espresso/60 text-xs uppercase">
                <tr>
                  <th className="pb-2">Agent</th>
                  <th className="pb-2">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {tokens.byAgent.map((r) => (
                  <tr key={r.agentId} className="border-t border-ciop-50">
                    <td className="py-2 truncate">{agents.find((a) => a.id === r.agentId)?.name || r.agentId}</td>
                    <td className="py-2">{fmtNum(r.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-sm text-espresso/50">No usage parsed yet.</div>
          )}
        </div>

        <div className="card p-5 lg:order-1">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-semibold flex items-center gap-2">
              <Sparkles size={18} className="text-ciop-500" /> Simmering Now
            </h2>
            <Link to="/agents" className="text-xs text-ciop-700 hover:underline">
              View all agents →
            </Link>
          </div>
          {running.length === 0 ? (
            <div className="text-sm text-espresso/50">The pot is empty — fire up an agent.</div>
          ) : (
            <ul className="space-y-3">
              {running.map((a) => {
                const samp = samples.filter((s) => s.agentId === a.id);
                const cpu = samp.reduce((s, x) => s + x.cpu, 0);
                const mem = samp.reduce((s, x) => s + x.rssMb, 0);
                const hot = cpu > 5;
                return (
                  <li key={a.id} className="flex items-center gap-3 p-2 rounded-xl hover:bg-ciop-50">
                    <StatusDot running />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{a.name}</div>
                      <div className="text-xs text-espresso/50">
                        {a.pids.length} proc · {cpu.toFixed(0)}% CPU · {fmtMb(mem)}
                      </div>
                    </div>
                    <span className={`pill ${hot ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                      {hot ? 'on the burner' : 'waiting...'}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="card p-5 lg:order-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-semibold flex items-center gap-2">
              <ShieldCheck size={18} className="text-emerald-600" /> Access
            </h2>
            <Link to="/access" className="text-xs text-ciop-700 hover:underline">
              Manage →
            </Link>
          </div>
          {accessByAgent.length === 0 ? (
            <div className="text-sm text-espresso/50">No access mapped yet.</div>
          ) : (
            <ul className="space-y-2.5">
              {accessByAgent.slice(0, 5).map((row) => (
                <li key={row.agentId} className="p-2 rounded-xl hover:bg-ciop-50">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-medium truncate text-sm">{row.name}</span>
                    <span className="text-[11px] text-espresso/50 shrink-0">{row.total} items</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
                    {row.folders > 0 && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-ciop-50 text-espresso border border-ciop-100">
                        <Folder size={10} /> {row.folders}
                      </span>
                    )}
                    {row.keys > 0 && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
                        <KeyRound size={10} /> {row.keys}
                      </span>
                    )}
                    {row.mcps > 0 && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200">
                        <Plug size={10} /> {row.mcps}
                      </span>
                    )}
                    {row.integrations > 0 && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-800 border border-rose-200">
                        <Globe size={10} /> {row.integrations}
                      </span>
                    )}
                    {row.exts > 0 && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-800 border border-violet-200">
                        <Puzzle size={10} /> {row.exts}
                      </span>
                    )}
                    {row.sensitive > 0 && (
                      <span className="px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
                        {row.sensitive} sensitive
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="px-8 pb-8 space-y-4">
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-semibold flex items-center gap-2">
              <Cpu size={18} className="text-basil" /> CPU % &amp; GPU % — live
            </h2>
            <Link to="/performance" className="text-xs text-ciop-700 hover:underline">
              View performance →
            </Link>
          </div>
          {perfChart.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={perfChart}>
                <XAxis dataKey="time" stroke="#0F2A3A" fontSize={11} />
                <YAxis stroke="#0F2A3A" fontSize={11} unit="%" domain={[0, 'auto']} />
                <Tooltip
                  contentStyle={{ background: '#F5ECDA', border: '1px solid #A8D2DF', borderRadius: 12 }}
                  formatter={(v: any) => `${Number(v).toFixed(1)}%`}
                />
                <Legend />
                {perfAgentIds.map((id, i) => (
                  <Line
                    key={id}
                    type="monotone"
                    dataKey={id}
                    stroke={COLORS[i % COLORS.length]}
                    strokeWidth={2}
                    dot={false}
                    name={(agents.find((a) => a.id === id)?.name || id) + ' · CPU'}
                  />
                ))}
                <Line
                  type="monotone"
                  dataKey="__gpu"
                  stroke="#9B5DE5"
                  strokeWidth={2.5}
                  strokeDasharray="5 3"
                  dot={false}
                  name="GPU · agents (sum)"
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState title="No live samples yet" hint="Start an AI agent and metrics will stream in." />
          )}
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-semibold flex items-center gap-2">
              <ListChecks size={18} className="text-ciop-700" /> Recent Activity
            </h2>
            <Link to="/activity" className="text-xs text-ciop-700 hover:underline">
              See more →
            </Link>
          </div>
          {activityRows.length === 0 ? (
            <EmptyState title="No activity yet" hint="Prompts and responses from your AI agents will show up here." />
          ) : (
            <ul className="divide-y divide-ciop-50">
              {activityRows.slice(0, 5).map((r) => {
                const meta = ROLE_META[r.role] || ROLE_META.user;
                const name = agents.find((a) => a.id === r.agentId)?.name || r.agentId;
                return (
                  <li key={r.id} className="py-2.5 flex items-start gap-3">
                    <div className="w-7 h-7 rounded-lg bg-ciop-50 text-ciop-700 flex items-center justify-center shrink-0">
                      <meta.Icon size={14} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-medium">{name}</span>
                        <span className="text-espresso/40">·</span>
                        <span className={`px-1.5 py-0.5 rounded-full border text-[11px] ${meta.badge}`}>{r.role}</span>
                        {r.model && (
                          <>
                            <span className="text-espresso/40">·</span>
                            <span className="font-mono text-espresso/50 truncate">{r.model}</span>
                          </>
                        )}
                        <span className="text-espresso/40">·</span>
                        <span className="text-espresso/50">{fmtRel(r.ts)}</span>
                      </div>
                      <div className="text-sm mt-0.5 text-espresso/85 truncate">{r.contentPreview || '(no content)'}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-semibold">Pot Activity</h2>
            <span className="text-xs text-espresso/50">Tokens over time · {rangeDef.label.toLowerCase()}</span>
          </div>
          {tokens && tokens.series.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={tokens.series}>
                <defs>
                  <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#1E7898" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#1E7898" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" stroke="#0F2A3A" fontSize={11} />
                <YAxis stroke="#0F2A3A" fontSize={11} tickFormatter={(v) => fmtNum(Number(v))} />
                <Tooltip
                  contentStyle={{ background: '#F5ECDA', border: '1px solid #A8D2DF', borderRadius: 12 }}
                  formatter={(v: any) => fmtNum(Number(v))}
                />
                <Area type="monotone" dataKey="total" stroke="#1E7898" strokeWidth={2} fill="url(#g)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState title="No usage yet" hint="Run an AI agent and it'll show up here." />
          )}
        </div>
      </div>
    </div>
  );
}

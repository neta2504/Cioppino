import { useEffect, useMemo, useState } from 'react';
import { api, Agent, Sample, GpuSample, ErrorSummary, LatencySummary, perfStream, apiKeys, getSnapshot } from '../lib/api';
import { useCachedQuery } from '../lib/useCachedQuery';
import { IntegrationNotice } from '../components/IntegrationNotice';
import { PageHeader, MetricCard, EmptyState, ProcListerBanner } from '../components/Bits';
import { fmtMb, fmtRel } from '../lib/format';
import { Cpu, MemoryStick, Activity, AlertTriangle, Gauge, MonitorSmartphone } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend, PieChart, Pie, Cell } from 'recharts';

const COLORS = ['#1E7898', '#F2A65A', '#2FA388', '#F47B5C', '#7DC9B7', '#C8A45C', '#9B5DE5', '#74B5C9'];

function fmtMs(ms: number): string {
  if (!ms || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s ? ` ${s}s` : ''}`;
}

export default function Performance() {
  const agentsQ = useCachedQuery(apiKeys.agents(), () => api.agents());
  const errorsQ = useCachedQuery(apiKeys.errors(24), () => api.errors(24));
  const latencyQ = useCachedQuery(apiKeys.latency(24), () => api.latency(24));
  const agents: Agent[] = agentsQ.data?.agents ?? [];
  const errors: ErrorSummary | null = errorsQ.data ?? null;
  const latency: LatencySummary | null = latencyQ.data ?? null;

  // Seed the perf samples from any snapshot left by a previous visit so the
  // CPU/MEM charts don't redraw from empty while the next stream tick lands.
  const perfSnap = getSnapshot<{ samples: Sample[]; gpu: GpuSample[] }>(apiKeys.perf(undefined, 5));
  const [samples, setSamples] = useState<Sample[]>(perfSnap?.samples ?? []);
  const [gpuSamples, setGpuSamples] = useState<GpuSample[]>(perfSnap?.gpu ?? []);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    api.perf(undefined, 5).then((r) => {
      setSamples(r.samples);
      setGpuSamples(r.gpu || []);
    });
    // Errors and latency are also kept fresh on a 30s timer; useCachedQuery
    // handles the snapshot/seed, this just keeps the rolling window current.
    const errTimer = setInterval(() => errorsQ.refresh().catch(() => {}), 30_000);
    const latTimer = setInterval(() => latencyQ.refresh().catch(() => {}), 30_000);
    const off = perfStream((msg) => {
      setSamples((prev) => {
        const cutoff = Date.now() - 5 * 60_000;
        const next = [...prev.filter((s) => s.ts >= cutoff), ...msg.samples];
        return next.slice(-2000);
      });
      if (msg.gpu) {
        setGpuSamples((prev) => {
          const cutoff = Date.now() - 5 * 60_000;
          const next = [...prev.filter((g) => g.ts >= cutoff), msg.gpu as GpuSample];
          return next.slice(-2000);
        });
      }
    });
    return () => {
      clearInterval(errTimer);
      clearInterval(latTimer);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(
    () => (filter === 'all' ? samples : samples.filter((s) => s.agentId === filter)),
    [samples, filter],
  );

  // bucket by ts (round to 3s) and pivot CPU per agent + sum agent GPU%
  const chartData = useMemo(() => {
    const bucket = new Map<number, Record<string, number>>();
    for (const s of filtered) {
      const t = Math.floor(s.ts / 3000) * 3000;
      if (!bucket.has(t)) bucket.set(t, { ts: t });
      const row = bucket.get(t)!;
      row[s.agentId] = (row[s.agentId] || 0) + s.cpu;
      row.__gpu = Math.min(100, (row.__gpu || 0) + (s.gpu || 0));
    }
    return [...bucket.values()].sort((a, b) => (a.ts as number) - (b.ts as number)).map((r) => ({
      ...r,
      time: new Date(r.ts as number).toLocaleTimeString().slice(0, 8),
    }));
  }, [filtered]);

  const memData = useMemo(() => {
    const bucket = new Map<number, Record<string, number>>();
    for (const s of filtered) {
      const t = Math.floor(s.ts / 3000) * 3000;
      if (!bucket.has(t)) bucket.set(t, { ts: t });
      const row = bucket.get(t)!;
      row[s.agentId] = (row[s.agentId] || 0) + s.rssMb;
    }
    return [...bucket.values()].sort((a, b) => (a.ts as number) - (b.ts as number)).map((r) => ({
      ...r,
      time: new Date(r.ts as number).toLocaleTimeString().slice(0, 8),
    }));
  }, [filtered]);

  const runningAgents = agents.filter((a) => a.running);
  const usedAgentIds = [...new Set(filtered.map((s) => s.agentId))];

  const latencyAgentIds = useMemo(
    () => (latency ? [...new Set(latency.points.map((p) => p.agentId))] : []),
    [latency],
  );
  const latencyChart = useMemo(() => {
    if (!latency || latency.points.length === 0) return [] as any[];
    const bucketMs = 30 * 60_000; // 30-minute buckets
    const buckets = new Map<number, Record<string, number[]>>();
    for (const p of latency.points) {
      const t = Math.floor(p.ts / bucketMs) * bucketMs;
      if (!buckets.has(t)) buckets.set(t, {});
      const row = buckets.get(t)!;
      (row[p.agentId] ||= []).push(p.latencyMs);
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, agentVals]) => {
        const row: Record<string, any> = {
          ts: t,
          time: new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };
        for (const [aid, arr] of Object.entries(agentVals)) {
          row[aid] = Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
        }
        return row;
      });
  }, [latency]);

  // Live cards: prefer samples within the last ~15s (5× default tick), but
  // if the stream stalls briefly fall back to the most recent sample we have
  // per agent so the cards don't zero out on a single missed tick.
  const latestByAgent = new Map<string, Sample[]>();
  const cutoff = Date.now() - 15_000;
  for (const s of samples) {
    if (s.ts < cutoff) continue;
    if (!latestByAgent.has(s.agentId)) latestByAgent.set(s.agentId, []);
    latestByAgent.get(s.agentId)!.push(s);
  }
  if (latestByAgent.size === 0 && samples.length > 0) {
    const lastByAgent = new Map<string, Sample>();
    for (const s of samples) {
      const prev = lastByAgent.get(s.agentId);
      if (!prev || s.ts > prev.ts) lastByAgent.set(s.agentId, s);
    }
    for (const [aid, s] of lastByAgent) latestByAgent.set(aid, [s]);
  }
  const totalCpu = [...latestByAgent.values()].flat().reduce((a, b) => a + b.cpu, 0);
  const totalMem = [...latestByAgent.values()].flat().reduce((a, b) => a + b.rssMb, 0);
  const totalAgentGpu = Math.min(
    100,
    [...latestByAgent.values()].flat().reduce((a, b) => a + (b.gpu || 0), 0),
  );
  const latestGpu = gpuSamples[gpuSamples.length - 1];
  const systemGpuPct = latestGpu?.util ?? 0;
  const gpuName = latestGpu?.name || 'GPU';

  return (
    <div>
      <PageHeader
        title="Performance"
        subtitle="Live CPU, memory, and process metrics for every running agent."
        actions={
          <select
            className="px-3 py-2 rounded-xl border border-ciop-200 bg-white/80"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All agents</option>
            {runningAgents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        }
      />

      <ProcListerBanner procLister={agentsQ.data?.procLister} />
      <IntegrationNotice agents={agents} feature="resources" />

      <div className="px-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <MetricCard label="Live CPU" value={`${totalCpu.toFixed(0)}%`} Icon={Cpu} tone="tomato" />
        <MetricCard
          label="Live GPU (agents)"
          value={`${totalAgentGpu.toFixed(0)}%`}
          sub={
            latestGpu
              ? `Agent processes · system ${systemGpuPct.toFixed(0)}% on ${gpuName}`
              : 'Agent processes · per-PID GPU (Windows)'
          }
          Icon={MonitorSmartphone}
          tone="basil"
        />
        <MetricCard label="Live memory" value={fmtMb(totalMem)} Icon={MemoryStick} tone="saffron" />
        <MetricCard label="Active processes" value={[...latestByAgent.values()].flat().length} Icon={Activity} />
        <MetricCard
          label="Errors · last 24h"
          value={errors?.total24h ?? 0}
          sub={
            errors && errors.byAgent.length > 0
              ? `${errors.byAgent[0].count24h} from ${agents.find((a) => a.id === errors.byAgent[0].agentId)?.name || errors.byAgent[0].agentId}`
              : 'no errors detected'
          }
          Icon={AlertTriangle}
        />
      </div>

      <div className="px-8 pb-8 space-y-4">
        <div className="card p-5">
          <h2 className="font-display text-lg font-semibold mb-3">CPU % &amp; GPU % — live</h2>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData}>
                <XAxis dataKey="time" stroke="#0F2A3A" fontSize={11} />
                <YAxis stroke="#0F2A3A" fontSize={11} unit="%" domain={[0, 'auto']} />
                <Tooltip
                  contentStyle={{ background: '#F5ECDA', border: '1px solid #A8D2DF', borderRadius: 12 }}
                  formatter={(v: any) => `${Number(v).toFixed(1)}%`}
                />
                <Legend />
                {usedAgentIds.map((id, i) => (
                  <Line key={id} type="monotone" dataKey={id} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} name={(agents.find((a) => a.id === id)?.name || id) + ' · CPU'} />
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
          <h2 className="font-display text-lg font-semibold mb-3">Memory (MB)</h2>
          {memData.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={memData}>
                <XAxis dataKey="time" stroke="#0F2A3A" fontSize={11} />
                <YAxis stroke="#0F2A3A" fontSize={11} unit="MB" />
                <Tooltip
                  contentStyle={{ background: '#F5ECDA', border: '1px solid #A8D2DF', borderRadius: 12 }}
                  formatter={(v: any) => `${Number(v).toFixed(3)} MB`}
                />
                <Legend />
                {usedAgentIds.map((id, i) => (
                  <Line key={id} type="monotone" dataKey={id} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} name={agents.find((a) => a.id === id)?.name || id} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : null}
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="font-display text-lg font-semibold flex items-center gap-2">
              <Gauge size={18} className="text-ciop-700" /> Response latency · last 24h
            </h2>
            {latency && latency.byAgent.length > 0 && (
              <div className="flex gap-2 text-xs flex-wrap">
                {latency.byAgent.map((b) => {
                  const name = agents.find((a) => a.id === b.agentId)?.name || b.agentId;
                  return (
                    <span
                      key={b.agentId}
                      className="px-2 py-1 rounded-full bg-ciop-50 text-espresso border border-ciop-100"
                    >
                      {name}: avg <b>{fmtMs(b.avgMs)}</b> · p95 <b>{fmtMs(b.p95Ms)}</b> · {b.count} turns
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          {latencyChart.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={latencyChart}>
                <XAxis dataKey="time" stroke="#0F2A3A" fontSize={11} />
                <YAxis stroke="#0F2A3A" fontSize={11} tickFormatter={(v) => fmtMs(v)} />
                <Tooltip
                  contentStyle={{ background: '#F5ECDA', border: '1px solid #A8D2DF', borderRadius: 12 }}
                  formatter={(v: any) => fmtMs(Number(v))}
                />
                <Legend />
                {latencyAgentIds.map((id, i) => (
                  <Line
                    key={id}
                    type="monotone"
                    dataKey={id}
                    stroke={COLORS[i % COLORS.length]}
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    connectNulls
                    name={agents.find((a) => a.id === id)?.name || id}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState
              title="No latency data yet"
              hint="Send a few messages to your AI agents and turn-by-turn latency will show up here."
            />
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card p-5 lg:col-span-2 lg:order-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-semibold flex items-center gap-2">
              <AlertTriangle size={18} className="text-amber-600" /> Recent errors
            </h2>
            {errors && errors.byAgent.length > 0 && (
              <div className="flex gap-2 text-xs">
                {errors.byAgent.map((b) => {
                  const name = agents.find((a) => a.id === b.agentId)?.name || b.agentId;
                  return (
                    <span
                      key={b.agentId}
                      className="px-2 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200"
                    >
                      {name}: <b>{b.count24h}</b>
                      {b.count1h > 0 && <span className="text-red-700"> · {b.count1h} in last hour</span>}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          {!errors || errors.recent.length === 0 ? (
            <div className="text-sm text-espresso/50">No errors detected in the last 24h. ✨</div>
          ) : (
            <ul className="divide-y divide-ciop-50 max-h-80 overflow-auto">
              {errors.recent.map((e, idx) => {
                const name = agents.find((a) => a.id === e.agentId)?.name || e.agentId;
                return (
                  <li key={idx} className="py-2.5 flex items-start gap-3">
                    <div className="w-7 h-7 rounded-lg bg-red-100 text-red-700 flex items-center justify-center shrink-0">
                      <AlertTriangle size={14} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-medium">{name}</span>
                        <span className="text-espresso/40">·</span>
                        <span className="font-mono text-espresso/50">{e.kind}</span>
                        <span className="text-espresso/40">·</span>
                        <span className="text-espresso/50">{fmtRel(e.ts)}</span>
                      </div>
                      <div className="text-sm mt-0.5 break-words">{e.message || '(no message)'}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="card p-5 lg:order-1">
          <h2 className="font-display text-lg font-semibold flex items-center gap-2 mb-3">
            <AlertTriangle size={18} className="text-amber-600" /> Errors by agent
          </h2>
          {!errors || errors.byAgent.length === 0 ? (
            <div className="text-sm text-espresso/50 h-64 flex items-center justify-center">
              No errors to chart.
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={errors.byAgent.map((b) => ({
                      name: agents.find((a) => a.id === b.agentId)?.name || b.agentId,
                      value: b.count24h,
                    }))}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={80}
                    paddingAngle={2}
                  >
                    {errors.byAgent.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-3 space-y-1.5">
                {errors.byAgent.map((b, i) => {
                  const name = agents.find((a) => a.id === b.agentId)?.name || b.agentId;
                  const pct = errors.total24h ? Math.round((b.count24h / errors.total24h) * 100) : 0;
                  return (
                    <div key={b.agentId} className="flex items-center gap-2 text-xs">
                      <span
                        className="w-2.5 h-2.5 rounded-sm shrink-0"
                        style={{ background: COLORS[i % COLORS.length] }}
                      />
                      <span className="flex-1 truncate">{name}</span>
                      <span className="text-espresso/50">{b.count24h} · {pct}%</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, Agent, TokenSummary, apiKeys } from '../lib/api';
import { useCachedQuery } from '../lib/useCachedQuery';
import { PageHeader, MetricCard, EmptyState } from '../components/Bits';
import { fmtNum, fmtUsd } from '../lib/format';
import { IntegrationNotice } from '../components/IntegrationNotice';
import { RefreshCw, Coins, Layers, Bot, FolderKanban, Sparkles, DollarSign, Clock, ChevronDown } from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  BarChart,
  Bar,
  Cell,
  RadialBarChart,
  RadialBar,
  PolarAngleAxis,
} from 'recharts';

const COLORS = ['#1E7898', '#F2A65A', '#2FA388', '#F47B5C', '#7DC9B7', '#C8A45C', '#A26ED4', '#E36BAE'];

const AGENT_EMOJI: Record<string, string> = {
  claude: '🦞',
  'claude-code': '🦞',
  copilot: '🐙',
  'copilot-cli': '🐙',
  codex: '🐟',
  'codex-cli': '🐟',
  aider: '🐚',
  cursor: '🦑',
  cline: '🦐',
  gemini: '🦀',
  windsurf: '🍤',
};
function emojiFor(agentId: string): string {
  const key = agentId.toLowerCase();
  for (const k of Object.keys(AGENT_EMOJI)) if (key.includes(k)) return AGENT_EMOJI[k];
  return '🫧';
}

function agentName(id: string, agents: Agent[]): string {
  return agents.find((a) => a.id === id)?.name || id;
}

// Collapsible section state persisted to localStorage so the layout the user
// chooses survives reloads.
function useCollapsed(id: string): [boolean, () => void] {
  const key = `ciop.collapse.tokens.${id}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
  });
  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(key, next ? '1' : '0'); } catch {}
      return next;
    });
  return [collapsed, toggle];
}

function Section({
  id,
  title,
  icon,
  children,
}: {
  id: string;
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [collapsed, toggle] = useCollapsed(id);
  return (
    <div>
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between px-1 py-1.5 mb-2 text-left"
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-espresso">
          {icon}
          <span>{title}</span>
        </div>
        <ChevronDown size={16} className={`text-espresso/50 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
      </button>
      {!collapsed && children}
    </div>
  );
}

export default function Tokens() {
  const [searchParams, setSearchParams] = useSearchParams();
  const ALLOWED_DAYS = [1, 7, 30, 90, 365];
  const rawDays = Number(searchParams.get('days'));
  const days = ALLOWED_DAYS.includes(rawDays) ? rawDays : 30;
  const model = searchParams.get('model') || 'all';

  const setParam = (key: string, value: string | number, clearWhen: string | number) => {
    const next = new URLSearchParams(searchParams);
    if (value === clearWhen) next.delete(key);
    else next.set(key, String(value));
    setSearchParams(next, { replace: true });
  };

  const tokensQ = useCachedQuery(apiKeys.tokens(days, model), () => api.tokens(days, model));
  const agentsQ = useCachedQuery(apiKeys.agents(), () => api.agents());
  const data: TokenSummary | null = tokensQ.data ?? null;
  const agents: Agent[] = agentsQ.data?.agents ?? [];
  const [scanning, setScanning] = useState(false);

  const costEnabled = !!data?.costEnabled;
  const cost = data?.cost;
  const modelCost = new Map<string, number>((cost?.byModel ?? []).map((m) => [m.model, m.cost]));

  async function rescan() {
    setScanning(true);
    try {
      await api.scanTokens();
      await Promise.all([tokensQ.refresh(), agentsQ.refresh()]);
    } finally {
      setScanning(false);
    }
  }

  function exportCsv() {
    if (!data) return;
    const costByDate = new Map((cost?.series ?? []).map((s) => [s.date, s.cost]));
    const header = ['date', 'input', 'output', 'cacheRead', 'cacheCreate', 'total'];
    if (costEnabled) header.push('costUsd');
    const rows: (string | number)[][] = [
      header,
      ...data.series.map((s) => {
        const row: (string | number)[] = [s.date, s.input, s.output, s.cacheRead, s.cacheCreate, s.total];
        if (costEnabled) row.push(costByDate.has(s.date) ? costByDate.get(s.date)!.toFixed(4) : '');
        return row;
      }),
    ];
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cioppino-tokens-${days}d.csv`;
    a.click();
  }

  const heaviestModel = data?.byModel?.[0]?.model;
  const cachePct = data ? Math.round((data.cacheHitRate || 0) * 100) : 0;
  const cacheData = [{ name: 'cache', value: cachePct, fill: '#2FA388' }];

  return (
    <div>
      <PageHeader
        title="Tokens & Usage"
        subtitle="What's stewing in the pot — token volume across every agent, project, and model."
        actions={
          <div className="flex items-center gap-2">
            <select
              value={model}
              onChange={(e) => setParam('model', e.target.value, 'all')}
              className="px-3 py-1.5 rounded-lg border border-ciop-200 bg-white text-sm max-w-[200px]"
              title="Filter by model"
            >
              <option value="all">all models</option>
              {(data?.models ?? []).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <select
              value={days}
              onChange={(e) => setParam('days', Number(e.target.value), 30)}
              className="px-3 py-1.5 rounded-lg border border-ciop-200 bg-white text-sm"
            >
              <option value={1}>last 24h</option>
              <option value={7}>last 7 days</option>
              <option value={30}>last 30 days</option>
              <option value={90}>last 90 days</option>
              <option value={365}>last 365 days</option>
            </select>
            <button
              onClick={rescan}
              disabled={scanning}
              className="px-3 py-1.5 rounded-lg bg-ciop-600 text-white text-sm hover:bg-ciop-700 disabled:opacity-50 flex items-center gap-1.5"
            >
              <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
              {scanning ? 'Simmering…' : 'Rescan'}
            </button>
            <button
              onClick={exportCsv}
              className="px-3 py-1.5 rounded-lg border border-ciop-200 bg-white text-sm hover:bg-ciop-50"
            >
              Export today's recipe (CSV)
            </button>
          </div>
        }
      />

      <IntegrationNotice agents={agents} feature="tokens" />
      <div className="px-8 space-y-6 pb-10">
        {/* Hero metrics */}
        <div className={`grid grid-cols-1 md:grid-cols-2 gap-4 ${costEnabled ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
          <MetricCard
            label="Total tokens"
            value={fmtNum(data?.totalTokens || 0)}
            sub={heaviestModel ? `Today's special: ${heaviestModel}` : 'served from the broth'}
            Icon={Coins}
            tone="tomato"
          />
          <MetricCard
            label="Input tokens"
            value={fmtNum(data?.totalInputTokens || 0)}
            sub="prompts & context"
            Icon={Layers}
            tone="saffron"
          />
          <MetricCard
            label="Output tokens"
            value={fmtNum(data?.totalOutputTokens || 0)}
            sub="generated responses"
            Icon={Sparkles}
            tone="basil"
          />
          <MetricCard
            label="Cached tokens"
            value={fmtNum((data?.totalCacheReadTokens || 0) + (data?.totalCacheCreateTokens || 0))}
            sub={`${fmtNum(data?.totalCacheReadTokens || 0)} read · ${fmtNum(data?.totalCacheCreateTokens || 0)} created`}
            Icon={Bot}
          />
          {costEnabled && (
            <MetricCard
              label="Est. cost"
              value={cost && cost.pricedTokens > 0 ? fmtUsd(cost.total) : 'n/a'}
              sub={cost && cost.unpricedTokens > 0 ? 'partial · unmatched models excluded' : 'estimate · standard text rates'}
              Icon={DollarSign}
              tone="tomato"
            />
          )}
        </div>
        {costEnabled && !!cost?.unpricedTokens && <p className="text-sm text-amber-800" role="status">
          {fmtNum(cost.unpricedTokens)} tokens have no matching price and are excluded.
          This is a partial estimate, not a complete bill. Add a verified model rate in Settings if needed.
        </p>}

        {/* Cache dial + series */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="card p-5">
            <div className="text-sm font-semibold text-espresso mb-2">🫧 Cache hit rate</div>
            <div className="text-xs text-espresso/60 mb-3">cached vs fresh broth</div>
            <div style={{ width: '100%', height: 220 }}>
              <ResponsiveContainer>
                <RadialBarChart
                  cx="50%"
                  cy="50%"
                  innerRadius="70%"
                  outerRadius="100%"
                  barSize={18}
                  data={cacheData}
                  startAngle={90}
                  endAngle={-270}
                >
                  <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                  <RadialBar background dataKey="value" cornerRadius={10} />
                  <text
                    x="50%"
                    y="50%"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="fill-espresso"
                    style={{ fontSize: 36, fontWeight: 700 }}
                  >
                    {cachePct}%
                  </text>
                </RadialBarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="card p-5 lg:col-span-2">
            <div className="text-sm font-semibold text-espresso mb-3">📈 Tokens over time</div>
            {data && data.series.length > 0 ? (
              <div style={{ width: '100%', height: 240 }}>
                <ResponsiveContainer>
                  <AreaChart data={data.series}>
                    <defs>
                      <linearGradient id="gInput" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#F2A65A" stopOpacity={0.85} />
                        <stop offset="100%" stopColor="#F2A65A" stopOpacity={0.1} />
                      </linearGradient>
                      <linearGradient id="gOutput" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2FA388" stopOpacity={0.85} />
                        <stop offset="100%" stopColor="#2FA388" stopOpacity={0.1} />
                      </linearGradient>
                      <linearGradient id="gCacheRead" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#1E7898" stopOpacity={0.85} />
                        <stop offset="100%" stopColor="#1E7898" stopOpacity={0.1} />
                      </linearGradient>
                      <linearGradient id="gCacheCreate" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#A26ED4" stopOpacity={0.85} />
                        <stop offset="100%" stopColor="#A26ED4" stopOpacity={0.1} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmtNum(v)} />
                    <Tooltip formatter={(v: any) => fmtNum(Number(v))} />
                    <Area type="monotone" dataKey="input" stackId="1" stroke="#F2A65A" fill="url(#gInput)" />
                    <Area type="monotone" dataKey="output" stackId="1" stroke="#2FA388" fill="url(#gOutput)" />
                    <Area type="monotone" dataKey="cacheRead" stackId="1" stroke="#1E7898" fill="url(#gCacheRead)" />
                    <Area type="monotone" dataKey="cacheCreate" stackId="1" stroke="#A26ED4" fill="url(#gCacheCreate)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyState title="The pot is empty" hint="Boot an agent and let it simmer — tokens will show up here." />
            )}
          </div>
        </div>

        {/* By agent + by model */}
        <Section id="breakdown" title="By agent & model" icon={<Bot size={16} className="text-ciop-600" />}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-3">
              <Bot size={16} className="text-ciop-600" />
              <div className="text-sm font-semibold text-espresso">Tokens by agent</div>
            </div>
            {data && data.byAgent.length > 0 ? (
              <div style={{ width: '100%', height: Math.max(200, data.byAgent.length * 36) }}>
                <ResponsiveContainer>
                  <BarChart data={data.byAgent.slice(0, 12)} layout="vertical" margin={{ left: 20 }}>
                    <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => fmtNum(v)} />
                    <YAxis
                      type="category"
                      dataKey="agentId"
                      tick={{ fontSize: 12 }}
                      width={140}
                      tickFormatter={(id: string) => `${emojiFor(id)} ${agentName(id, agents)}`}
                    />
                    <Tooltip formatter={(v: any) => fmtNum(Number(v))} />
                    <Bar dataKey="tokens" radius={[0, 6, 6, 0]}>
                      {data.byAgent.slice(0, 12).map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyState title="No agent activity yet" />
            )}
          </div>

          <div className="card p-5">
            <div className="text-sm font-semibold text-espresso mb-3">Tokens by model</div>
            {data && data.byModel.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-espresso/60 border-b border-ciop-100">
                      <th className="py-2">Model</th>
                      <th className="py-2 text-right">Tokens</th>
                      <th className="py-2 text-right">Share</th>
                      {costEnabled && <th className="py-2 text-right">Est. cost</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.byModel.map((m) => {
                      const share = data.totalTokens > 0 ? (m.tokens / data.totalTokens) * 100 : 0;
                      const c = modelCost.get(m.model);
                      return (
                        <tr key={m.model} className="border-b border-ciop-50">
                          <td className="py-2 font-mono text-xs">{m.model}</td>
                          <td className="py-2 text-right">{fmtNum(m.tokens)}</td>
                          <td className="py-2 text-right text-espresso/70">{share.toFixed(1)}%</td>
                          {costEnabled && (
                            <td className="py-2 text-right text-espresso/70">
                              {c !== undefined ? fmtUsd(c) : <span className="text-espresso/40">n/a</span>}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="No model breakdown yet" />
            )}
          </div>
          </div>
        </Section>

        {/* Hourly usage — tokens by hour-of-day across the range */}
        <Section id="hourly" title="Tokens by hour of day" icon={<Clock size={16} className="text-ciop-600" />}>
          <div className="card p-5">
            {data && data.hourly.some((h) => h.total > 0) ? (
              <div style={{ width: '100%', height: 220 }}>
                <ResponsiveContainer>
                  <BarChart data={data.hourly}>
                    <XAxis
                      dataKey="hour"
                      tick={{ fontSize: 11 }}
                      tickFormatter={(h: number) => `${String(h).padStart(2, '0')}h`}
                    />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmtNum(v)} />
                    <Tooltip
                      formatter={(v: any) => fmtNum(Number(v))}
                      labelFormatter={(h: any) => `${String(h).padStart(2, '0')}:00`}
                    />
                    <Bar dataKey="total" radius={[6, 6, 0, 0]} fill="#1E7898" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyState title="No hourly data yet" />
            )}
          </div>
        </Section>

        {/* By project — only render when we have at least one real project */}
        {data && data.byProject.some((p) => p.project !== 'Unknown') && (
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-3">
              <FolderKanban size={16} className="text-ciop-600" />
              <div className="text-sm font-semibold text-espresso">Tokens by project</div>
            </div>
            <div style={{ width: '100%', height: Math.max(200, data.byProject.length * 36) }}>
              <ResponsiveContainer>
                <BarChart data={data.byProject.slice(0, 12)} layout="vertical" margin={{ left: 20 }}>
                  <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => fmtNum(v)} />
                  <YAxis type="category" dataKey="project" tick={{ fontSize: 12 }} width={180} />
                  <Tooltip formatter={(v: any) => fmtNum(Number(v))} />
                  <Bar dataKey="tokens" radius={[0, 6, 6, 0]}>
                    {data.byProject.slice(0, 12).map((_, i) => (
                      <Cell key={i} fill={COLORS[(i + 2) % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Estimated cost breakdown — only when cost estimation is enabled */}
        {costEnabled && cost && (
          <Section id="cost" title="Estimated cost" icon={<DollarSign size={16} className="text-ciop-600" />}>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="card p-5">
                <div className="text-sm font-semibold text-espresso mb-3">Cost over time</div>
                {cost.series.length > 0 ? (
                  <div style={{ width: '100%', height: 220 }}>
                    <ResponsiveContainer>
                      <AreaChart data={cost.series}>
                        <defs>
                          <linearGradient id="gCost" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#F47B5C" stopOpacity={0.85} />
                            <stop offset="100%" stopColor="#F47B5C" stopOpacity={0.1} />
                          </linearGradient>
                        </defs>
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmtUsd(Number(v))} width={70} />
                        <Tooltip formatter={(v: any) => fmtUsd(Number(v))} />
                        <Area type="monotone" dataKey="cost" stroke="#F47B5C" fill="url(#gCost)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <EmptyState title="No priced usage yet" hint="Costs appear once a known model is used." />
                )}
              </div>

              <div className="card p-5">
                <div className="text-sm font-semibold text-espresso mb-3">Cost by agent</div>
                {cost.byAgent.length > 0 ? (
                  <div style={{ width: '100%', height: Math.max(200, cost.byAgent.length * 36) }}>
                    <ResponsiveContainer>
                      <BarChart data={cost.byAgent.slice(0, 12)} layout="vertical" margin={{ left: 20 }}>
                        <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => fmtUsd(v)} />
                        <YAxis
                          type="category"
                          dataKey="agentId"
                          tick={{ fontSize: 12 }}
                          width={140}
                          tickFormatter={(id: string) => `${emojiFor(id)} ${agentName(id, agents)}`}
                        />
                        <Tooltip formatter={(v: any) => fmtUsd(Number(v))} />
                        <Bar dataKey="cost" radius={[0, 6, 6, 0]}>
                          {cost.byAgent.slice(0, 12).map((_, i) => (
                            <Cell key={i} fill={COLORS[i % COLORS.length]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <EmptyState title="No priced usage yet" />
                )}
              </div>
            </div>
            <div className="text-xs text-espresso/50 mt-2 px-1">
              Estimates use API list prices and may not reflect Pro/Max subscription billing. Edit rates in Settings.
            </div>
          </Section>
        )}

        {/* Tips */}
        {data && data.tips && data.tips.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {data.tips.map((t, i) => (
              <div key={i} className="card p-5 bg-gradient-to-br from-amber-50 to-white">
                <div className="text-xs uppercase tracking-wider text-amber-700 font-semibold mb-1">
                  🍅 {t.category}
                </div>
                <div className="font-semibold text-espresso mb-1">{t.title}</div>
                <div className="text-sm text-espresso/70">{t.body}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

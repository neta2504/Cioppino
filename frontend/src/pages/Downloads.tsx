import { useEffect, useMemo, useState } from 'react';
import { api, apiKeys, Agent, DownloadRow, DownloadKind, DownloadListResponse } from '../lib/api';
import { useCachedQuery } from '../lib/useCachedQuery';
import { IntegrationNotice } from '../components/IntegrationNotice';
import { PageHeader, Pill, EmptyState, MetricCard } from '../components/Bits';
import { fmtRel } from '../lib/format';
import {
  RefreshCw,
  Search,
  Trash2,
  Download,
  Package,
  Puzzle,
  FileText,
  Brain,
  Database,
  Globe,
  ShieldAlert,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  AlertTriangle,
} from 'lucide-react';

const RANGES = [
  { label: 'Last hour', ms: 60 * 60 * 1000 },
  { label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  { label: 'All time', ms: 0 },
];

const KIND_META: Record<DownloadKind, { Icon: any; label: string; tone: 'default' | 'green' | 'amber' | 'red' }> = {
  install: { Icon: Package, label: 'Package', tone: 'green' },
  extension: { Icon: Puzzle, label: 'Extension', tone: 'default' },
  download: { Icon: Globe, label: 'Web file', tone: 'default' },
  document: { Icon: FileText, label: 'Document', tone: 'amber' },
  model: { Icon: Brain, label: 'Model', tone: 'amber' },
  dataset: { Icon: Database, label: 'Dataset', tone: 'amber' },
};

const RISK_LABELS: Record<string, string> = {
  'insecure-http': 'Insecure HTTP',
  'piped-install': 'Piped to shell',
  'executable-payload': 'Executable',
  'untrusted-host': 'Untrusted host',
  'global-install': 'Global install',
};

const ALL_KINDS = Object.keys(KIND_META) as DownloadKind[];

function fmtAbs(ts: number) {
  return new Date(ts).toLocaleString();
}

export default function Downloads() {
  const agentsQ = useCachedQuery(apiKeys.agents(), () => api.agents());
  const agents: Agent[] = agentsQ.data?.agents ?? [];
  const agentName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.id, a.name);
    return m;
  }, [agents]);

  const [agentFilter, setAgentFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState<DownloadKind | 'all'>('all');
  const [managerFilter, setManagerFilter] = useState('all');
  const [rangeMs, setRangeMs] = useState<number>(7 * 24 * 60 * 60 * 1000);
  const [riskOnly, setRiskOnly] = useState(false);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);

  const [scanning, setScanning] = useState(false);
  const [purging, setPurging] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const params = {
    agentId: agentFilter === 'all' ? undefined : agentFilter,
    kind: kindFilter === 'all' ? undefined : kindFilter,
    manager: managerFilter === 'all' ? undefined : managerFilter,
    sinceMs: rangeMs || undefined,
    riskOnly: riskOnly || undefined,
    q: debouncedQ || undefined,
    limit: 500,
  };
  const key = apiKeys.downloads(params);
  const dl = useCachedQuery<DownloadListResponse>(key, () => api.downloads(params));
  const data = dl.data;
  const rows: DownloadRow[] = data?.rows ?? [];

  // Manager facet options come from the unfiltered-by-manager response, but to
  // keep it simple we surface whatever the current response reports.
  const managerOptions = data?.byManager ?? [];

  async function rescan() {
    setScanning(true);
    try {
      await api.scanDownloads();
      await dl.refresh();
    } finally {
      setScanning(false);
    }
  }

  async function clearAll() {
    if (!window.confirm('Delete all recorded downloads? This cannot be undone.')) return;
    setPurging(true);
    try {
      await api.purgeDownloads();
      await dl.refresh();
    } finally {
      setPurging(false);
    }
  }

  function exportCsv() {
    const head = ['ts', 'agent', 'kind', 'manager', 'name', 'version', 'target', 'risk', 'status', 'source', 'command'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [head.join(',')];
    for (const r of rows) {
      lines.push([
        new Date(r.ts).toISOString(),
        agentName.get(r.agentId) || r.agentId,
        r.kind,
        r.manager,
        r.name,
        r.version ?? '',
        r.target ?? '',
        r.riskFlags.join('|'),
        r.status,
        r.source ?? '',
        r.command ?? '',
      ].map(esc).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cioppino-downloads-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const total = data?.total ?? 0;
  const flagged = data?.flagged ?? 0;
  const agentCount = data?.agents.length ?? 0;

  return (
    <div className="pb-10">
      <PageHeader
        title="Downloads"
        subtitle="Every external item your agents pulled onto this device"
        actions={
          <>
            <button onClick={exportCsv} className="btn btn-ghost" disabled={rows.length === 0}>
              <Download size={14} /> Export CSV
            </button>
            <button onClick={clearAll} className="btn btn-ghost" disabled={purging || total === 0}>
              <Trash2 size={14} /> {purging ? 'Clearing…' : 'Clear'}
            </button>
            <button onClick={rescan} className="btn btn-primary" disabled={scanning}>
              <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} /> {scanning ? 'Scanning…' : 'Rescan'}
            </button>
          </>
        }
      />

      <IntegrationNotice agents={agents} feature="downloads" agentId={agentFilter} />
      <div className="px-8">
        {/* Summary metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
          <MetricCard label="Items" value={total} Icon={Download} tone="default" />
          <MetricCard label="Agents" value={agentCount} Icon={Package} tone="basil" />
          <MetricCard label="Risk-flagged" value={flagged} Icon={ShieldAlert} tone={flagged > 0 ? 'tomato' : 'default'} />
          <MetricCard
            label="Kinds"
            value={(data?.byKind.length ?? 0)}
            Icon={Database}
            tone="saffron"
          />
        </div>

        {/* Filters */}
        <div className="card p-4 mb-5 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-espresso/40" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, URL or command…"
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-ciop-200 bg-cream focus:outline-none focus:ring-2 focus:ring-ciop-400"
            />
          </div>

          <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} className="px-3 py-2 text-sm rounded-lg border border-ciop-200 bg-cream">
            <option value="all">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>

          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as DownloadKind | 'all')} className="px-3 py-2 text-sm rounded-lg border border-ciop-200 bg-cream">
            <option value="all">All kinds</option>
            {ALL_KINDS.map((k) => (
              <option key={k} value={k}>{KIND_META[k].label}</option>
            ))}
          </select>

          <select value={managerFilter} onChange={(e) => setManagerFilter(e.target.value)} className="px-3 py-2 text-sm rounded-lg border border-ciop-200 bg-cream">
            <option value="all">All sources</option>
            {managerOptions.map((m) => (
              <option key={m.manager} value={m.manager}>{m.manager} ({m.count})</option>
            ))}
          </select>

          <select value={rangeMs} onChange={(e) => setRangeMs(Number(e.target.value))} className="px-3 py-2 text-sm rounded-lg border border-ciop-200 bg-cream">
            {RANGES.map((r) => (
              <option key={r.label} value={r.ms}>{r.label}</option>
            ))}
          </select>

          <label className={`pill cursor-pointer select-none ${riskOnly ? 'bg-red-100 text-red-800' : 'bg-ciop-50 text-ciop-700'}`}>
            <input type="checkbox" checked={riskOnly} onChange={(e) => setRiskOnly(e.target.checked)} className="hidden" />
            <ShieldAlert size={13} className="inline mr-1 -mt-0.5" /> Risky only
          </label>
        </div>

        {/* Results */}
        {rows.length === 0 ? (
          dl.isLoading ? (
            <div className="card p-12 text-center text-espresso/50">Loading…</div>
          ) : (
            <EmptyState
              title="No downloads recorded yet"
              hint="Click Rescan to parse agent transcripts for installs, models and web downloads."
            />
          )
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-espresso/55 text-xs uppercase tracking-wider border-b border-ciop-100/70">
                  <th className="px-4 py-3 font-semibold">Item</th>
                  <th className="px-4 py-3 font-semibold">Kind</th>
                  <th className="px-4 py-3 font-semibold">Source</th>
                  <th className="px-4 py-3 font-semibold">Agent</th>
                  <th className="px-4 py-3 font-semibold">Risk</th>
                  <th className="px-4 py-3 font-semibold">When</th>
                  <th className="px-4 py-3 font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const meta = KIND_META[r.kind];
                  const Icon = meta.Icon;
                  const isOpen = expanded === r.id;
                  return (
                    <RowGroup
                      key={r.id}
                      row={r}
                      meta={meta}
                      Icon={Icon}
                      isOpen={isOpen}
                      onToggle={() => setExpanded(isOpen ? null : r.id)}
                      agentLabel={agentName.get(r.agentId) || r.agentId}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function RowGroup({
  row,
  meta,
  Icon,
  isOpen,
  onToggle,
  agentLabel,
}: {
  row: DownloadRow;
  meta: { label: string; tone: 'default' | 'green' | 'amber' | 'red' };
  Icon: any;
  isOpen: boolean;
  onToggle: () => void;
  agentLabel: string;
}) {
  return (
    <>
      <tr className="border-b border-ciop-50 hover:bg-ciop-50/40">
        <td className="px-4 py-3 align-top">
          <div className="flex items-start gap-2">
            <Icon size={16} className="text-ciop-600 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="font-medium text-espresso break-all">
                {row.name}
                {row.version && <span className="text-espresso/50 font-normal"> @{row.version}</span>}
              </div>
              {row.target && <div className="text-xs text-espresso/50 break-all">{row.target}</div>}
            </div>
          </div>
        </td>
        <td className="px-4 py-3 align-top">
          <Pill tone={meta.tone}>{meta.label}</Pill>
        </td>
        <td className="px-4 py-3 align-top text-espresso/80">{row.manager}</td>
        <td className="px-4 py-3 align-top text-espresso/80">{agentLabel}</td>
        <td className="px-4 py-3 align-top">
          {row.riskFlags.length === 0 ? (
            <span className="text-espresso/30">—</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {row.riskFlags.map((f) => (
                <span key={f} className="pill bg-red-100 text-red-800 text-[11px]">
                  <AlertTriangle size={11} className="inline mr-0.5 -mt-0.5" />
                  {RISK_LABELS[f] || f}
                </span>
              ))}
            </div>
          )}
        </td>
        <td className="px-4 py-3 align-top text-espresso/60 whitespace-nowrap" title={fmtAbs(row.ts)}>
          {fmtRel(row.ts)}
        </td>
        <td className="px-4 py-3 align-top">
          <div className="flex items-center gap-1">
            <button onClick={onToggle} className="p-1 rounded hover:bg-ciop-100 text-espresso/60" title="Details">
              {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </button>
          </div>
        </td>
      </tr>
      {isOpen && (
        <tr className="border-b border-ciop-50 bg-ciop-50/30">
          <td colSpan={7} className="px-6 py-4">
            <div className="grid gap-3 text-sm">
              {row.command && (
                <div>
                  <div className="text-xs uppercase tracking-wider text-espresso/50 mb-1">Command</div>
                  <pre className="bg-espresso/5 rounded-lg p-3 overflow-x-auto text-xs text-espresso/80 whitespace-pre-wrap break-all">{row.command}</pre>
                </div>
              )}
              <div className="flex flex-wrap gap-6 text-xs text-espresso/70">
                <div>
                  <span className="text-espresso/45">Status: </span>{row.status}
                </div>
                {row.sessionId && (
                  <div>
                    <span className="text-espresso/45">Session: </span>{row.sessionId}
                  </div>
                )}
                {row.source && (
                  <button
                    onClick={() => row.source && api.openPath(row.source.split('#')[0])}
                    className="inline-flex items-center gap-1 text-ciop-700 hover:underline break-all"
                    title="Open source file"
                  >
                    <ExternalLink size={12} /> {row.source}
                  </button>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

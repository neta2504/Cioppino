import { useEffect, useRef, useState } from 'react';
import { api, Agent, apiKeys } from '../lib/api';
import { useCachedQuery } from '../lib/useCachedQuery';
import { PageHeader, StatusDot, Pill, EmptyState, ProcListerBanner } from '../components/Bits';
import { fmtRel } from '../lib/format';
import { RefreshCw, Bot, X, Square, ChevronDown } from 'lucide-react';

export default function Agents() {
  const agentsQ = useCachedQuery(apiKeys.agents(), () => api.agents());
  const agents: Agent[] = agentsQ.data?.agents ?? [];
  const [selected, setSelected] = useState<Agent | null>(null);
  const [scanning, setScanning] = useState(false);
  const [killing, setKilling] = useState<number | null>(null);
  const [killMsg, setKillMsg] = useState<string | null>(null);

  // Keep the open detail card in sync with the freshly fetched list.
  useEffect(() => {
    if (!selected) return;
    const fresh = agents.find((a) => a.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  async function scan() {
    setScanning(true);
    try {
      await api.scanAgents();
      await agentsQ.refresh();
    } finally {
      setScanning(false);
    }
  }

  async function endTask(agent: Agent, pid: number) {
    if (!confirm(`End process ${pid} (${agent.name})?\n\nThis sends SIGTERM, then SIGKILL after 1.5s.`)) return;
    setKilling(pid);
    setKillMsg(null);
    try {
      await api.killPid(agent.id, pid);
      setKillMsg(`Process ${pid} terminated.`);
      setTimeout(() => {
        scan();
        setKillMsg(null);
      }, 1500);
    } catch (e: any) {
      setKillMsg(`Failed to kill ${pid}: ${e.message || e}`);
    } finally {
      setKilling(null);
    }
  }

  async function endAll(agent: Agent) {
    if (agent.pids.length === 0) return;
    if (!confirm(`End ALL ${agent.pids.length} processes for ${agent.name}?\n\nPIDs: ${agent.pids.join(', ')}`)) return;
    setKilling(-1);
    setKillMsg(null);
    let ok = 0;
    let fail = 0;
    for (const pid of agent.pids) {
      try {
        await api.killPid(agent.id, pid);
        ok++;
      } catch {
        fail++;
      }
    }
    setKillMsg(`Killed ${ok} process${ok === 1 ? '' : 'es'}${fail ? `, ${fail} failed` : ''}.`);
    setTimeout(() => {
      scan();
      setKillMsg(null);
    }, 1500);
    setKilling(null);
  }

  return (
    <div>
      <PageHeader
        title="Agents"
        subtitle="Every AI agent we've discovered on your machine."
        actions={
          <button className="btn-primary" onClick={scan} disabled={scanning}>
            <RefreshCw size={16} className={scanning ? 'animate-spin' : ''} /> Rescan
          </button>
        }
      />

      <ProcListerBanner procLister={agentsQ.data?.procLister} />

      <div className="px-8 pb-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.filter((a) => a.installed).length === 0 && (
          <EmptyState title="No agents detected yet" hint="Click Rescan to look again." />
        )}
        {agents
          .filter((a) => a.installed)
          .map((a) => (
          <button
            key={a.id}
            onClick={() => setSelected(a)}
            className="card card-hover p-5 text-left"
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-ciop-100 text-ciop-600 flex items-center justify-center">
                  <Bot size={20} />
                </div>
                <div>
                  <div className="font-semibold">{a.name}</div>
                  <div className="text-xs text-espresso/50">{a.vendor} · {a.kind}</div>
                </div>
              </div>
              <StatusDot running={a.running} />
            </div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {a.metadata?.processState === 'unavailable'
                ? <Pill tone="amber">Running state unavailable</Pill>
                : a.running ? <Pill tone="green">Running</Pill> : <Pill>Installed</Pill>}
              {a.version && <Pill>v{a.version.replace(/^v/i, '').slice(0, 12)}</Pill>}
            </div>
            <div className="text-xs text-espresso/50 truncate">
              {a.binPath || a.configPath || '—'}
            </div>
            {a.metadata?.monitoring && (
              <div className="text-xs text-espresso/60 mt-2">
                Activity: {a.metadata.monitoring.activity}
              </div>
            )}
            {a.running && (
              <div className="text-xs text-espresso/60 mt-2">{a.pids.length} process{a.pids.length === 1 ? '' : 'es'} · {fmtRel(a.lastSeen)}</div>
            )}
          </button>
        ))}
      </div>

      {selected && (
        <div className="fixed inset-0 bg-black/30 flex justify-end z-50" onClick={() => setSelected(null)}>
          <div
            className="w-full max-w-md bg-cream h-full p-6 shadow-2xl overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="font-display text-2xl font-bold">{selected.name}</h2>
                <p className="text-espresso/60 text-sm">{selected.vendor}</p>
              </div>
              <button className="btn-ghost p-2" onClick={() => setSelected(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="space-y-3 text-sm">
              <Row label="Status" value={selected.metadata?.processState === 'unavailable' ? <Pill tone="amber">Running state unavailable</Pill> : selected.running ? <Pill tone="green">Running</Pill> : selected.installed ? <Pill>Installed</Pill> : <Pill tone="amber">Not installed</Pill>} />
              <Row label="Kind" value={selected.kind} />
              <Row label="Version" value={selected.version || '—'} />
              <Row label="Binary" value={<code className="text-xs break-all">{selected.binPath || '—'}</code>} />
              <Row label="Config path" value={<code className="text-xs break-all">{selected.configPath || '—'}</code>} />
              <ProcessesRow
                agent={selected}
                onEnd={(pid) => endTask(selected, pid)}
                onEndAll={() => endAll(selected)}
                busy={killing !== null}
                killMsg={killMsg}
              />
              <Row label="Last seen" value={fmtRel(selected.lastSeen)} />
              {selected.metadata?.description && <Row label="About" value={String(selected.metadata.description)} />}
              {selected.metadata?.monitoring && <>
                <Row label="CPU / memory scope" value={selected.metadata.monitoring.resources} />
                <Row label="Access inspection" value={selected.metadata.monitoring.access} />
                <Row label="Activity support" value={selected.metadata.monitoring.activity} />
                <Row label="Token support" value={selected.metadata.monitoring.tokens} />
                <Row label="Limitations" value={selected.metadata.monitoring.notes} />
                <p className="text-xs text-espresso/60">Running means the application is running, not that its agent is working. Platform support requires local verification.</p>
              </>}
              {!!selected.metadata?.issues?.length && (
                <div role="alert" className="text-amber-800">
                  {selected.metadata.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-espresso/50 font-semibold">{label}</div>
      <div className="mt-1">{value}</div>
    </div>
  );
}

function ProcessesRow({
  agent,
  onEnd,
  onEndAll,
  busy,
  killMsg,
}: {
  agent: Agent;
  onEnd: (pid: number) => void;
  onEndAll: () => void;
  busy: boolean;
  killMsg: string | null;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs uppercase tracking-wider text-espresso/50 font-semibold">PIDs</div>
        {agent.pids.length > 0 && (
          <EndTaskMenu agent={agent} onEnd={onEnd} onEndAll={onEndAll} busy={busy} />
        )}
      </div>
      <div className="mt-1">
        {agent.pids.length === 0 ? (
          <span className="text-espresso/50">—</span>
        ) : (
          <div className="font-mono text-sm flex flex-wrap gap-1.5">
            {agent.pids.map((pid) => (
              <span key={pid} className="px-2 py-0.5 rounded bg-ciop-50 text-ciop-700">
                {pid}
              </span>
            ))}
          </div>
        )}
        {killMsg && <div className="text-xs text-espresso/70 mt-2">{killMsg}</div>}
      </div>
    </div>
  );
}

function EndTaskMenu({
  agent,
  onEnd,
  onEndAll,
  busy,
}: {
  agent: Agent;
  onEnd: (pid: number) => void;
  onEndAll: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        className="btn text-xs bg-red-50 text-red-700 border border-red-200 hover:bg-red-600 hover:text-white hover:border-red-600 px-3 py-1.5 disabled:opacity-50"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
      >
        <Square size={12} fill="currentColor" />
        End task
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-56 card p-1 z-10 bg-white shadow-glow">
          <div className="px-2 pt-1.5 pb-1 text-[11px] uppercase tracking-wider text-espresso/50 font-semibold">
            End specific PID
          </div>
          {agent.pids.map((pid) => (
            <button
              key={pid}
              onClick={() => {
                setOpen(false);
                onEnd(pid);
              }}
              className="w-full text-left px-3 py-1.5 rounded-lg hover:bg-red-50 hover:text-red-700 font-mono text-sm flex items-center gap-2"
            >
              <Square size={11} />
              PID {pid}
            </button>
          ))}
          <div className="border-t border-ciop-100 my-1" />
          <button
            onClick={() => {
              setOpen(false);
              onEndAll();
            }}
            className="w-full text-left px-3 py-1.5 rounded-lg hover:bg-red-600 hover:text-white text-red-700 font-medium text-sm flex items-center gap-2"
          >
            <Square size={11} fill="currentColor" />
            End all {agent.pids.length} task{agent.pids.length === 1 ? '' : 's'}
          </button>
        </div>
      )}
    </div>
  );
}

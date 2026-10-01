import { useMemo, useState } from 'react';
import { api, AccessItem, Agent, RevokeGuide, apiKeys } from '../lib/api';
import { useCachedQuery } from '../lib/useCachedQuery';
import { PageHeader, Pill, EmptyState } from '../components/Bits';
import { RefreshCw, Folder, Key, Server, Puzzle, AlertTriangle, X, ExternalLink, ChevronRight, FileText, Plug } from 'lucide-react';
import { fmtRel } from '../lib/format';
import { IntegrationNotice } from '../components/IntegrationNotice';

const CAT_META: Record<string, { Icon: any; label: string; tone: 'default' | 'amber' | 'red' | 'green' }> = {
  folder: { Icon: Folder, label: 'Folder / Project', tone: 'default' },
  'api-key': { Icon: Key, label: 'API Key', tone: 'red' },
  mcp: { Icon: Server, label: 'MCP Server', tone: 'amber' },
  integration: { Icon: Plug, label: 'Integration', tone: 'red' },
  extension: { Icon: Puzzle, label: 'Extension', tone: 'default' },
  other: { Icon: AlertTriangle, label: 'Other', tone: 'default' },
};

export default function Access() {
  const agentsQ = useCachedQuery(apiKeys.agents(), () => api.agents());
  const accessQ = useCachedQuery(apiKeys.access(), () => api.access());
  const agents: Agent[] = agentsQ.data?.agents ?? [];
  const items: AccessItem[] = accessQ.data?.items ?? [];

  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [catFilter, setCatFilter] = useState<string>('all');
  const [scanning, setScanning] = useState(false);
  const [revoke, setRevoke] = useState<{ item: AccessItem; guide: RevokeGuide } | null>(null);

  async function scan() {
    setScanning(true);
    try {
      await api.scanAccess();
      await accessQ.refresh();
    } finally {
      setScanning(false);
    }
  }

  const installedIds = useMemo(() => new Set(agents.filter((a) => a.installed).map((a) => a.id)), [agents]);

  const filtered = useMemo(
    () =>
      items.filter(
        (i) =>
          installedIds.has(i.agentId) &&
          !(i.category === 'integration' && i.access === 'potential') &&
          (agentFilter === 'all' || i.agentId === agentFilter) &&
          (catFilter === 'all' || i.category === catFilter),
      ),
    [items, agentFilter, catFilter, installedIds],
  );

  const byAgent = useMemo(() => {
    const m = new Map<string, AccessItem[]>();
    for (const i of filtered) {
      if (!m.has(i.agentId)) m.set(i.agentId, []);
      m.get(i.agentId)!.push(i);
    }
    // Sort: running agents first, then by name.
    const entries = [...m.entries()];
    entries.sort((a, b) => {
      const ag = agents.find((x) => x.id === a[0]);
      const bg = agents.find((x) => x.id === b[0]);
      const ar = ag?.running ? 1 : 0;
      const br = bg?.running ? 1 : 0;
      if (ar !== br) return br - ar;
      return (ag?.name || a[0]).localeCompare(bg?.name || b[0]);
    });
    return entries;
  }, [filtered, agents]);

  async function openRevoke(item: AccessItem) {
    const guide = await api.revokeGuide(item.agentId, item.category, item.sourcePath, item.providerId);
    setRevoke({ item, guide });
  }

  return (
    <div>
      <PageHeader
        title="Access"
        subtitle="What your AI agents can see and touch — and how to take it back."
        actions={
          <button className="btn-primary" onClick={scan} disabled={scanning}>
            <RefreshCw size={16} className={scanning ? 'animate-spin' : ''} /> Rescan
          </button>
        }
      />

      <IntegrationNotice agents={agents} feature="access" agentId={agentFilter} />
      <div className="px-8 pb-8 space-y-4">
        <div className="card p-4 flex flex-wrap items-center gap-3">
          <span className="text-sm text-espresso/60">Filter:</span>
          <select
            className="px-3 py-1.5 rounded-xl border border-ciop-100 bg-white"
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
          >
            <option value="all">All agents</option>
            {agents
              .filter((a) => a.installed && items.some((i) => i.agentId === a.id))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
          <select
            className="px-3 py-1.5 rounded-xl border border-ciop-100 bg-white"
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
          >
            <option value="all">All categories</option>
            <option value="folder">Folders</option>
            <option value="api-key">API keys</option>
            <option value="mcp">MCP servers</option>
            <option value="integration">Integrations</option>
            <option value="extension">Extensions</option>
          </select>
          <span className="ml-auto text-sm text-espresso/60">{filtered.length} items</span>
        </div>

        {filtered.length === 0 && <EmptyState title="Nothing to show" hint="Run a scan to discover access items." />}

        {byAgent.map(([agentId, list]) => {
          const agent = agents.find((a) => a.id === agentId);
          return (
            <div key={agentId} className="card p-5">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <h3 className="font-display text-lg font-semibold">{agent?.name || agentId}</h3>
                <Pill>{list.length}</Pill>
                {agent?.running ? (
                  <Pill tone="green">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 mr-1 align-middle" />
                    Running
                  </Pill>
                ) : agent?.installed ? (
                  <Pill tone="default">Installed</Pill>
                ) : (
                  <Pill tone="default">Not installed</Pill>
                )}
                {agent?.lastSeen ? (
                  <span className="text-[11px] text-espresso/50">Last seen {fmtRel(agent.lastSeen)}</span>
                ) : null}
              </div>
              {(agent?.binPath || agent?.configPath) && (
                <div className="mb-3 text-[11px] text-espresso/60 space-y-0.5">
                  {agent?.binPath && (
                    <div className="flex items-center gap-2">
                      <span className="uppercase tracking-wider text-espresso/40 font-semibold">App</span>
                      <span className="font-mono break-all">{agent.binPath}</span>
                      <button
                        className="text-ciop-600 hover:underline shrink-0"
                        onClick={() => api.openPath(agent.binPath!).catch(() => {})}
                      >
                        Open
                      </button>
                    </div>
                  )}
                  {agent?.configPath && (
                    <div className="flex items-center gap-2">
                      <span className="uppercase tracking-wider text-espresso/40 font-semibold">Config</span>
                      <span className="font-mono break-all">{agent.configPath}</span>
                      <button
                        className="text-ciop-600 hover:underline shrink-0"
                        onClick={() => api.openPath(agent.configPath!).catch(() => {})}
                      >
                        Open
                      </button>
                    </div>
                  )}
                </div>
              )}
              <CategoryGroups
                items={list.filter((i) => i.category !== 'folder')}
                onRevoke={openRevoke}
              />
              <FolderGroups
                items={list.filter((i) => i.category === 'folder')}
                onRevoke={openRevoke}
              />
            </div>
          );
        })}
      </div>

      {revoke && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-6 z-50" onClick={() => setRevoke(null)}>
          <div className="card max-w-lg w-full p-6 bg-cream" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="font-display text-xl font-bold">Revoke access</h2>
                <p className="text-sm text-espresso/60 mt-1">
                  {revoke.item.label} · {CAT_META[revoke.item.category]?.label}
                </p>
              </div>
              <button className="btn-ghost p-2" onClick={() => setRevoke(null)}>
                <X size={18} />
              </button>
            </div>
            <ol className="space-y-2 text-sm">
              {revoke.guide.steps.map((s, i) => (
                <li key={i} className="flex gap-3">
                  <span className="w-6 h-6 rounded-full bg-ciop-500 text-white text-xs flex items-center justify-center shrink-0">
                    {i + 1}
                  </span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
            {revoke.guide.openPath && (
              <div className="mt-4 p-3 rounded-xl bg-ciop-50 border border-ciop-100">
                <div className="text-xs text-espresso/60 mb-1">Source</div>
                <div className="font-mono text-xs break-all mb-2">{revoke.guide.openPath}</div>
                <button
                  className="btn-primary text-sm"
                  onClick={() => api.openPath(revoke.guide.openPath!).catch(() => {})}
                >
                  <ExternalLink size={14} /> Open in file manager
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function parentDir(p: string): string {
  if (!p) return '';
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('\\'), cleaned.lastIndexOf('/'));
  return idx > 0 ? cleaned.slice(0, idx) : cleaned;
}

function baseName(p: string): string {
  if (!p) return '';
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('\\'), cleaned.lastIndexOf('/'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function AccessItemCard({ item, onRevoke }: { item: AccessItem; onRevoke: (i: AccessItem) => void }) {
  const meta = CAT_META[item.category] || CAT_META.other;
  const Icon = meta.Icon;
  return (
    <div className="border border-ciop-50 rounded-xl p-3 flex items-start gap-3">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${item.sensitive ? 'bg-red-100 text-red-700' : 'bg-ciop-50 text-ciop-700'}`}>
        <Icon size={16} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Pill tone={meta.tone}>{meta.label}</Pill>
          {item.access === 'granted' && <Pill tone="green">granted</Pill>}
          {item.access === 'potential' && <Pill tone="amber">potential</Pill>}
          {item.sensitive && <Pill tone="red">sensitive</Pill>}
        </div>
        <div className="font-medium mt-1 truncate">{item.label}</div>
        {item.detail && <div className="text-xs text-espresso/60 truncate">{item.detail}</div>}
        {item.sourcePath && (
          <div className="text-[11px] text-espresso/40 truncate mt-0.5">{item.sourcePath}</div>
        )}
      </div>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-red-200 text-red-600 bg-white hover:bg-red-50 hover:border-red-300 active:bg-red-100 transition-colors shrink-0"
        onClick={() => onRevoke(item)}
      >
        Revoke
      </button>
    </div>
  );
}

// Preferred display order for the collapsible category groups.
const CATEGORY_ORDER = ['api-key', 'mcp', 'integration', 'extension', 'other'];

function CategoryGroups({ items, onRevoke }: { items: AccessItem[]; onRevoke: (i: AccessItem) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const m = new Map<string, AccessItem[]>();
    for (const it of items) {
      if (!m.has(it.category)) m.set(it.category, []);
      m.get(it.category)!.push(it);
    }
    return [...m.entries()].sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a[0]);
      const bi = CATEGORY_ORDER.indexOf(b[0]);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  }, [items]);

  if (groups.length === 0) return null;

  return (
    <div className="space-y-2 mt-3">
      {groups.map(([cat, list]) => {
        const meta = CAT_META[cat] || CAT_META.other;
        const Icon = meta.Icon;
        const isOpen = !!open[cat];
        const sensitiveCount = list.filter((i) => i.sensitive).length;
        return (
          <div key={cat} className="border border-ciop-50 rounded-xl overflow-hidden">
            <button
              className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-ciop-50 text-left"
              onClick={() => setOpen((p) => ({ ...p, [cat]: !p[cat] }))}
            >
              <ChevronRight
                size={16}
                className={`text-espresso/50 transition-transform ${isOpen ? 'rotate-90' : ''}`}
              />
              <div className="w-9 h-9 rounded-lg bg-ciop-50 text-ciop-700 flex items-center justify-center shrink-0">
                <Icon size={16} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{meta.label}s</div>
              </div>
              {sensitiveCount > 0 && <Pill tone="red">{sensitiveCount} sensitive</Pill>}
              <Pill>{list.length}</Pill>
            </button>
            {isOpen && (
              <div className="border-t border-ciop-50 bg-cream/40 p-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {list.map((i) => (
                    <AccessItemCard key={i.id} item={i} onRevoke={onRevoke} />
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FolderGroups({ items, onRevoke }: { items: AccessItem[]; onRevoke: (i: AccessItem) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const m = new Map<string, AccessItem[]>();
    for (const it of items) {
      const key = parentDir(it.sourcePath || it.label) || '(unknown)';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(it);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [items]);

  if (groups.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      <div className="text-xs uppercase tracking-wider text-espresso/50 font-semibold">
        Folders ({groups.length})
      </div>
      {groups.map(([dir, files]) => {
        const isOpen = !!open[dir];
        return (
          <div key={dir} className="border border-ciop-50 rounded-xl overflow-hidden">
            <button
              className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-ciop-50 text-left"
              onClick={() => setOpen((p) => ({ ...p, [dir]: !p[dir] }))}
            >
              <ChevronRight
                size={16}
                className={`text-espresso/50 transition-transform ${isOpen ? 'rotate-90' : ''}`}
              />
              <div className="w-9 h-9 rounded-lg bg-ciop-50 text-ciop-700 flex items-center justify-center shrink-0">
                <Folder size={16} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{baseName(dir) || dir}</div>
                <div className="text-[11px] text-espresso/40 truncate">{dir}</div>
              </div>
              <Pill>{files.length} {files.length === 1 ? 'file' : 'files'}</Pill>
            </button>
            {isOpen && (
              <div className="border-t border-ciop-50 bg-cream/40">
                <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-espresso/50 font-semibold flex items-center justify-between">
                  <span>Files in this folder</span>
                  <span>{files.length}</span>
                </div>
                <ul className="divide-y divide-ciop-50">
                  {files.map((f) => (
                    <li key={f.id} className="flex items-center gap-3 px-3 py-2 hover:bg-white">
                      <FileText size={14} className="text-espresso/40 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">{f.label}</div>
                        {f.detail && <div className="text-[11px] text-espresso/50 truncate">{f.detail}</div>}
                      </div>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-red-200 text-red-600 bg-white hover:bg-red-50 hover:border-red-300 active:bg-red-100 transition-colors shrink-0"
                        onClick={() => onRevoke(f)}
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

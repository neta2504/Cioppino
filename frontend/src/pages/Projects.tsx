import { useMemo, useState } from 'react';
import { api, Agent, ProjectsSummary, Project, apiKeys } from '../lib/api';
import { useCachedQuery } from '../lib/useCachedQuery';
import { IntegrationNotice } from '../components/IntegrationNotice';
import { PageHeader, MetricCard, EmptyState } from '../components/Bits';
import { fmtRel } from '../lib/format';
import { FolderGit2, Folder, RefreshCw, Bot, Activity, GitBranch, ChevronRight, ExternalLink } from 'lucide-react';

export default function Projects() {
  const agentsQ = useCachedQuery(apiKeys.agents(), () => api.agents());
  const projectsQ = useCachedQuery(apiKeys.projects(), () => api.projects());
  const agents: Agent[] = agentsQ.data?.agents ?? [];
  const data: ProjectsSummary | null = projectsQ.data ?? null;
  const loading = agentsQ.isLoading || projectsQ.isLoading || agentsQ.isRefreshing || projectsQ.isRefreshing;
  const [filterAgent, setFilterAgent] = useState<string>('all');
  const [query, setQuery] = useState<string>('');
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load() {
    await Promise.all([agentsQ.refresh(), projectsQ.refresh()]);
  }

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name || id;

  const filtered: Project[] = useMemo(() => {
    if (!data) return [];
    return data.projects.filter((p) => {
      if (filterAgent !== 'all' && !p.agents.some((u) => u.agentId === filterAgent)) return false;
      if (query) {
        const q = query.toLowerCase();
        if (!p.name.toLowerCase().includes(q) && !p.path.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [data, filterAgent, query]);

  const agentsWithProjects = useMemo(() => {
    if (!data) return [] as { id: string; count: number }[];
    const m = new Map<string, number>();
    for (const p of data.projects) {
      for (const u of p.agents) {
        if (filterAgent !== 'all' && u.agentId !== filterAgent) continue;
        m.set(u.agentId, (m.get(u.agentId) || 0) + 1);
      }
    }
    return [...m.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count);
  }, [data, filterAgent]);

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle="The folders and repos your AI agents have worked in."
        actions={
          <button className="btn-primary" onClick={load} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        }
      />

      <IntegrationNotice agents={agents} feature="projects" agentId={filterAgent} />
      <div className="px-8 grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <MetricCard
          label="Projects discovered"
          value={data?.totalProjects ?? 0}
          sub={data ? `${data.totalSessions} sessions tracked` : undefined}
          Icon={FolderGit2}
          tone="tomato"
        />
        <MetricCard
          label="Agents involved"
          value={agentsWithProjects.length}
          sub={agentsWithProjects.slice(0, 3).map((a) => agentName(a.id)).join(' · ') || '—'}
          Icon={Bot}
          tone="saffron"
        />
        <MetricCard
          label="Most active project"
          value={data && data.projects[0] ? data.projects[0].name : '—'}
          sub={data && data.projects[0] ? `${data.projects[0].sessions} sessions · ${fmtRel(data.projects[0].lastSeen)}` : undefined}
          Icon={Activity}
          tone="basil"
        />
      </div>

      <div className="px-8 pb-8">
        <div className="card p-5">
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <h2 className="font-display text-lg font-semibold">All projects</h2>
            <div className="flex items-center gap-2">
              <input
                placeholder="Search by name or path…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="px-3 py-1.5 rounded-xl border border-ciop-100 bg-white text-sm w-64 focus:outline-none focus:ring-2 focus:ring-ciop-300"
              />
              <select
                className="px-3 py-1.5 rounded-xl border border-ciop-100 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-ciop-300"
                value={filterAgent}
                onChange={(e) => setFilterAgent(e.target.value)}
              >
                <option value="all">All agents</option>
                {agents
                  .filter((a) => data?.projects.some((p) => p.agents.some((u) => u.agentId === a.id)))
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              title="No projects yet"
              hint="Run an AI agent inside a folder and it'll show up here."
            />
          ) : (
            <ul className="divide-y divide-ciop-50">
              {filtered.map((p) => {
                const open = expanded === p.id;
                return (
                  <li key={p.id} className="py-2">
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : p.id)}
                      className="w-full flex items-center gap-3 text-left rounded-xl px-2 py-2 hover:bg-ciop-50"
                    >
                      <ChevronRight
                        size={16}
                        className={`text-espresso/40 transition-transform ${open ? 'rotate-90' : ''}`}
                      />
                      <div className="w-9 h-9 rounded-xl bg-ciop-100 text-ciop-700 flex items-center justify-center shrink-0">
                        <Folder size={18} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium truncate">{p.name}</span>
                          {p.gitBranch && (
                            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200">
                              <GitBranch size={11} /> {p.gitBranch}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-espresso/50 truncate font-mono">{p.path}</div>
                      </div>
                      <div className="hidden sm:flex items-center gap-2 shrink-0">
                        {p.agents.slice(0, 4).map((u) => (
                          <span
                            key={u.agentId}
                            title={`${agentName(u.agentId)} · ${u.sessions} session${u.sessions === 1 ? '' : 's'}`}
                            className="text-[11px] px-2 py-0.5 rounded-full bg-ciop-50 text-espresso border border-ciop-100"
                          >
                            {agentName(u.agentId)}
                          </span>
                        ))}
                      </div>
                      <div className="text-right shrink-0 ml-2">
                        <div className="text-sm font-semibold">{p.sessions}</div>
                        <div className="text-[11px] text-espresso/50">{fmtRel(p.lastSeen)}</div>
                      </div>
                    </button>

                    {open && (
                      <div className="ml-12 mt-2 mb-3 rounded-xl border border-ciop-100 bg-ciop-50/40 p-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <div className="text-xs font-semibold uppercase text-espresso/60 mb-2">
                              Agents in this project
                            </div>
                            <ul className="space-y-1.5">
                              {p.agents.map((u) => (
                                <li key={u.agentId} className="flex items-center gap-2 text-sm">
                                  <span className="w-1.5 h-1.5 rounded-full bg-ciop-500" />
                                  <span className="flex-1">{agentName(u.agentId)}</span>
                                  <span className="text-espresso/60">
                                    {u.sessions} session{u.sessions === 1 ? '' : 's'}
                                  </span>
                                  <span className="text-[11px] text-espresso/40 w-20 text-right">
                                    {fmtRel(u.lastSeen)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                          <div>
                            <div className="text-xs font-semibold uppercase text-espresso/60 mb-2">
                              Details
                            </div>
                            <dl className="text-sm space-y-1.5">
                              <div className="flex gap-2">
                                <dt className="text-espresso/60 w-20">Path</dt>
                                <dd className="font-mono text-xs break-all flex-1">{p.path}</dd>
                              </div>
                              {p.gitBranch && (
                                <div className="flex gap-2">
                                  <dt className="text-espresso/60 w-20">Branch</dt>
                                  <dd className="flex-1">{p.gitBranch}</dd>
                                </div>
                              )}
                              {p.gitOrigin && (
                                <div className="flex gap-2">
                                  <dt className="text-espresso/60 w-20">Origin</dt>
                                  <dd className="flex-1 break-all">
                                    <a
                                      href={p.gitOrigin}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex items-center gap-1 text-ciop-700 hover:underline"
                                    >
                                      {p.gitOrigin} <ExternalLink size={12} />
                                    </a>
                                  </dd>
                                </div>
                              )}
                              <div className="flex gap-2">
                                <dt className="text-espresso/60 w-20">Sessions</dt>
                                <dd className="flex-1">{p.sessions}</dd>
                              </div>
                              <div className="flex gap-2">
                                <dt className="text-espresso/60 w-20">Last seen</dt>
                                <dd className="flex-1">{fmtRel(p.lastSeen)}</dd>
                              </div>
                            </dl>
                            <button
                              className="mt-3 text-xs px-3 py-1.5 rounded-xl border border-ciop-200 hover:bg-ciop-50"
                              onClick={(e) => {
                                e.stopPropagation();
                                api.openPath(p.path).catch(() => {});
                              }}
                            >
                              Open folder
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

import type { Agent } from '../lib/api';

export function IntegrationNotice({ agents, feature, agentId = 'all' }: {
  agents: Agent[];
  feature: 'access' | 'activity' | 'tokens' | 'resources' | 'projects' | 'downloads';
  agentId?: string;
}) {
  const selected = agents.filter((agent) => agent.metadata?.monitoring &&
    (agent.installed || agent.running) && (agentId === 'all' || agent.id === agentId));
  if (!selected.length) return null;
  const unsupported = selected.filter((agent) => feature === 'downloads' ||
    (feature === 'projects' ? agent.metadata?.monitoring?.activity : agent.metadata?.monitoring?.[feature]) === 'Not yet supported');
  const issues = selected.flatMap((agent) => (agent.metadata?.issues ?? []).map((issue) => `${agent.name}: ${issue.message}`));
  return (
    <div className="mx-8 mb-4 rounded-xl border border-ciop-200 bg-ciop-50 p-3 text-sm text-espresso/80">
      <strong>Monitoring coverage</strong>
      {feature === 'resources'
        ? <p>Editor and terminal metrics measure the application, not AI-only work. Error and latency parsing is not yet available for these new integrations.</p>
        : feature === 'access'
          ? <p>New integrations inspect limited user configuration. Configured, disabled, and potential access do not prove effective permissions or active use. See Agents for per-product scope.</p>
          : <p>Discovery does not imply {feature} support. Missing records are not evidence of zero usage.</p>}
      {unsupported.length > 0 && <p>Not yet supported: {unsupported.map((agent) => agent.name).join(', ')}.</p>}
      {selected.some((agent) => agent.id === 'pi-coding-agent') && ['tokens', 'activity'].includes(feature) &&
        <p>Pi: Tokens uses reported usage; Activity uses text-length estimates. Unlisted models remain unpriced.</p>}
      {issues.length > 0 && <div role="alert" className="mt-2 text-amber-800">{[...new Set(issues)].join(' ')}</div>}
    </div>
  );
}

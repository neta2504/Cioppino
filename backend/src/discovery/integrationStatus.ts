export type IntegrationFeature = 'discovery' | 'resources' | 'access' | 'activity';
export interface IntegrationIssue {
  feature: IntegrationFeature;
  message: string;
}

const issues = new Map<string, IntegrationIssue[]>();

export function setIntegrationIssues(agentId: string, feature: IntegrationFeature, messages: string[]) {
  const current = (issues.get(agentId) ?? []).filter((item) => item.feature !== feature);
  const next = [...new Set(messages)].slice(0, 5).map((message) => ({ feature, message }));
  issues.set(agentId, [...current, ...next]);
}

export function getIntegrationIssues(agentId: string): IntegrationIssue[] {
  return issues.get(agentId) ?? [];
}

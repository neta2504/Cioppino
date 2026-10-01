import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parseDocument } from 'yaml';
import type { AgentDef } from '../discovery/registry.js';
import { object, readIntegrationFile } from '../discovery/integrationFiles.js';
import { setIntegrationIssues } from '../discovery/integrationStatus.js';
import type { AccessItem } from './index.js';

export function scanIntegrationAccess(def: AgentDef): AccessItem[] {
  const items: AccessItem[] = [];
  const issues: string[] = [];
  for (const config of def.integration?.configs ?? []) {
    try {
      const text = readIntegrationFile(config.file);
      if (text === undefined) continue;
      let parsed: unknown;
      if (config.format === 'yaml') {
        const document = parseDocument(text, { uniqueKeys: true });
        if (document.errors.length) throw new Error('Invalid YAML');
        parsed = document.toJS({ maxAliasCount: 20 });
      } else if (config.format === 'jsonc') {
        const errors: ParseError[] = [];
        parsed = parseJsonc(text, errors, { allowTrailingComma: true });
        if (errors.length) throw new Error('Invalid JSONC');
      } else {
        parsed = JSON.parse(text);
      }
      const root = object(parsed);
      if (!root) throw new Error('Expected a configuration object');
      const shared = config.shared ? ' Shared CLI/IDE or CLI/Desktop configuration.' : '';
      const add = (category: AccessItem['category'], label: string, detail: string, enabled = false) => {
        items.push({
          agentId: def.id, category, label: label.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120),
          detail: detail + shared, sourcePath: config.file,
          access: enabled ? 'granted' : 'potential', lastSeen: Date.now(),
        });
      };
      add('other', 'User configuration', 'Configuration found; this does not prove active use or effective permissions.');
      if (config.kind === 'pi') {
        if (typeof root.defaultProvider === 'string') add('other', 'Default provider', 'A provider preference is configured; credentials are not inspected.');
        if (Array.isArray(root.extensions)) add('extension', 'Pi extensions', `${root.extensions.length} extension declarations; extension code is not executed.`);
        continue;
      }
      if (config.kind === 'junie') {
        add('other', 'Junie sandbox policy', 'A user sandbox policy exists. It may not be active; this is not an effective permission audit.');
        continue;
      }
      if (config.kind === 'goose' && (object(root.providers) || typeof root.GOOSE_PROVIDER === 'string')) {
        add('other', 'Provider configuration', 'Provider settings are present; credential values and runtime environment overrides are not inspected.');
      }
      const key = config.kind === 'goose' ? 'extensions' : config.kind === 'zed' ? 'context_servers' : 'mcpServers';
      if (root[key] !== undefined && !object(root[key])) throw new Error('Invalid server map');
      const servers = Object.entries(object(root[key]) ?? {});
      if (servers.length > 100) throw new Error('Server count exceeds limit');
      for (const [name, value] of servers) {
        const server = object(value);
        if (!server) throw new Error('Invalid server');
        const enabled = config.kind === 'goose' ? server.enabled === true : server.disabled !== true && server.enabled !== false;
        const category = config.kind === 'goose' && ['builtin', 'platform'].includes(String(server.type)) ? 'extension' : 'mcp';
        add(category, name, `${enabled ? 'Configured' : 'Disabled'} in user ${key}; not proof of a running server. Environment values, arguments, headers, and URLs are not collected.`, enabled);
      }
    } catch {
      issues.push('A user configuration could not be inspected (invalid format, read limit, or permissions). No credentials were collected.');
    }
  }
  setIntegrationIssues(def.id, 'access', issues);
  return items;
}

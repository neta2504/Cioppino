import fs from 'node:fs';
import path from 'node:path';
import { REGISTRY, AgentDef } from '../discovery/registry.js';
import { db } from '../db/index.js';
import { HOME } from '../config.js';
import { scanIntegrationAccess } from './integrations.js';

export interface AccessItem {
  id?: number;
  agentId: string;
  category: 'folder' | 'api-key' | 'mcp' | 'extension' | 'integration' | 'other';
  label: string;
  detail?: string;
  sourcePath?: string;
  sensitive?: boolean;
  access?: 'granted' | 'potential';   // granted = wired into agent config; potential = on-disk creds the agent could read
  providerId?: string;                  // for integrations: which provider (gmail, slack, …)
  lastSeen: number;
}

const KEY_HINTS = ['api_key', 'apikey', 'token', 'secret', 'auth', 'bearer'];

// Known third-party services + keyword fragments that identify them in MCP
// server names, env keys, or credential file paths.
interface IntegrationDef {
  id: string;
  label: string;
  kind: 'email' | 'chat' | 'social' | 'productivity' | 'storage' | 'dev' | 'calendar' | 'media' | 'other';
  keywords: string[];        // lowercase fragments to look for
  sensitive?: boolean;       // treat as sensitive (PII / communications)
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: 'gmail',     label: 'Gmail',           kind: 'email',        sensitive: true,  keywords: ['gmail', 'googlemail'] },
  { id: 'google',    label: 'Google Account',  kind: 'productivity', sensitive: true,  keywords: ['google-oauth', 'google_oauth', 'goog_oauth', 'googleapis'] },
  { id: 'outlook',   label: 'Outlook / O365',  kind: 'email',        sensitive: true,  keywords: ['outlook', 'office365', 'o365', 'microsoft-graph', 'msgraph'] },
  { id: 'slack',     label: 'Slack',           kind: 'chat',         sensitive: true,  keywords: ['slack'] },
  { id: 'discord',   label: 'Discord',         kind: 'chat',         sensitive: true,  keywords: ['discord'] },
  { id: 'telegram',  label: 'Telegram',        kind: 'chat',         sensitive: true,  keywords: ['telegram'] },
  { id: 'whatsapp',  label: 'WhatsApp',        kind: 'chat',         sensitive: true,  keywords: ['whatsapp', 'wa-business'] },
  { id: 'signal',    label: 'Signal',          kind: 'chat',         sensitive: true,  keywords: ['signal-cli', 'signal-mcp'] },
  { id: 'teams',     label: 'Microsoft Teams', kind: 'chat',         sensitive: true,  keywords: ['msteams', 'ms-teams', 'microsoft-teams'] },
  { id: 'zoom',      label: 'Zoom',            kind: 'chat',         sensitive: true,  keywords: ['zoom'] },
  { id: 'gcal',      label: 'Google Calendar', kind: 'calendar',     sensitive: true,  keywords: ['gcal', 'google-calendar', 'googlecalendar'] },
  { id: 'calendar',  label: 'Calendar',        kind: 'calendar',     sensitive: true,  keywords: ['calendar-mcp', 'caldav'] },
  { id: 'notion',    label: 'Notion',          kind: 'productivity', sensitive: true,  keywords: ['notion'] },
  { id: 'github',    label: 'GitHub',          kind: 'dev',          sensitive: true,  keywords: ['github', 'gh-token', 'gh_oauth'] },
  { id: 'gitlab',    label: 'GitLab',          kind: 'dev',          sensitive: true,  keywords: ['gitlab'] },
  { id: 'bitbucket', label: 'Bitbucket',       kind: 'dev',          sensitive: true,  keywords: ['bitbucket'] },
  { id: 'jira',      label: 'Jira',            kind: 'productivity', sensitive: true,  keywords: ['jira', 'atlassian'] },
  { id: 'linear',    label: 'Linear',          kind: 'productivity', sensitive: true,  keywords: ['linear-mcp', '/linear/', '"linear"'] },
  { id: 'asana',     label: 'Asana',           kind: 'productivity', sensitive: true,  keywords: ['asana'] },
  { id: 'trello',    label: 'Trello',          kind: 'productivity', sensitive: true,  keywords: ['trello'] },
  { id: 'confluence',label: 'Confluence',      kind: 'productivity', sensitive: true,  keywords: ['confluence'] },
  { id: 'drive',     label: 'Google Drive',    kind: 'storage',      sensitive: true,  keywords: ['gdrive', 'google-drive', 'googledrive'] },
  { id: 'dropbox',   label: 'Dropbox',         kind: 'storage',      sensitive: true,  keywords: ['dropbox'] },
  { id: 'onedrive',  label: 'OneDrive',        kind: 'storage',      sensitive: true,  keywords: ['onedrive'] },
  { id: 'box',       label: 'Box',             kind: 'storage',      sensitive: true,  keywords: ['box-mcp', '"box"'] },
  { id: 'twitter',   label: 'X / Twitter',     kind: 'social',       sensitive: true,  keywords: ['twitter', 'x-api', 'x_api'] },
  { id: 'reddit',    label: 'Reddit',          kind: 'social',       sensitive: true,  keywords: ['reddit'] },
  { id: 'spotify',   label: 'Spotify',         kind: 'media',        sensitive: true,  keywords: ['spotify'] },
  { id: 'youtube',   label: 'YouTube',         kind: 'media',        sensitive: true,  keywords: ['youtube'] },
  { id: 'figma',     label: 'Figma',           kind: 'productivity', sensitive: true,  keywords: ['figma'] },
  { id: 'sentry',    label: 'Sentry',          kind: 'dev',          sensitive: true,  keywords: ['sentry'] },
  { id: 'stripe',    label: 'Stripe',          kind: 'dev',          sensitive: true,  keywords: ['stripe'] },
  { id: 'hubspot',   label: 'HubSpot',         kind: 'productivity', sensitive: true,  keywords: ['hubspot'] },
];

function detectIntegration(text: string): IntegrationDef | undefined {
  const t = text.toLowerCase();
  for (const i of INTEGRATIONS) {
    for (const kw of i.keywords) {
      if (t.includes(kw)) return i;
    }
  }
  return undefined;
}

// Well-known OAuth / credential files on disk. Each entry maps a file (or
// directory) to the integration it grants access to. We attribute these to
// the most likely owning agent based on path overlap; if none match, we skip
// (we don't fabricate a `host-os` agent).
interface CredentialSite {
  path: string;
  integrationId: string;
  detail: string;
  isDir?: boolean;
}

function credentialSites(): CredentialSite[] {
  const appdata = process.env.APPDATA || '';
  const localappdata = process.env.LOCALAPPDATA || '';
  const sites: CredentialSite[] = [
    // GitHub CLI
    { path: path.join(HOME, '.config', 'gh', 'hosts.yml'),     integrationId: 'github',  detail: 'gh CLI OAuth token' },
    { path: path.join(appdata, 'GitHub CLI', 'hosts.yml'),     integrationId: 'github',  detail: 'gh CLI OAuth token (Windows)' },
    // Google / gcloud
    { path: path.join(HOME, '.config', 'gcloud', 'credentials.db'),       integrationId: 'google',  detail: 'gcloud user credentials' },
    { path: path.join(HOME, 'AppData', 'Roaming', 'gcloud', 'credentials.db'), integrationId: 'google', detail: 'gcloud user credentials' },
    // Generic Google OAuth caches used by many MCP servers
    { path: path.join(HOME, '.gmail-mcp'),     integrationId: 'gmail',   detail: 'gmail-mcp OAuth tokens', isDir: true },
    { path: path.join(HOME, '.gcal-mcp'),      integrationId: 'gcal',    detail: 'gcal-mcp OAuth tokens',  isDir: true },
    { path: path.join(HOME, '.gdrive-mcp'),    integrationId: 'drive',   detail: 'gdrive-mcp OAuth tokens', isDir: true },
    // Slack
    { path: path.join(HOME, '.slack', 'credentials.json'),     integrationId: 'slack',   detail: 'Slack CLI credentials' },
    { path: path.join(appdata, 'Slack'),                       integrationId: 'slack',   detail: 'Slack desktop app data', isDir: true },
    // Discord
    { path: path.join(appdata, 'discord'),                     integrationId: 'discord', detail: 'Discord desktop app data', isDir: true },
    // Telegram
    { path: path.join(appdata, 'Telegram Desktop', 'tdata'),   integrationId: 'telegram',detail: 'Telegram session', isDir: true },
    // WhatsApp
    { path: path.join(localappdata, 'WhatsApp'),               integrationId: 'whatsapp',detail: 'WhatsApp Desktop data', isDir: true },
    // Microsoft Teams
    { path: path.join(appdata, 'Microsoft', 'Teams'),          integrationId: 'teams',   detail: 'MS Teams data', isDir: true },
    // Zoom
    { path: path.join(appdata, 'Zoom'),                        integrationId: 'zoom',    detail: 'Zoom data', isDir: true },
    // Notion
    { path: path.join(appdata, 'Notion'),                      integrationId: 'notion',  detail: 'Notion desktop data', isDir: true },
    // Dropbox / OneDrive
    { path: path.join(appdata, 'Dropbox'),                     integrationId: 'dropbox', detail: 'Dropbox client data', isDir: true },
    { path: path.join(localappdata, 'Microsoft', 'OneDrive'),  integrationId: 'onedrive',detail: 'OneDrive client data', isDir: true },
    // Spotify
    { path: path.join(appdata, 'Spotify'),                     integrationId: 'spotify', detail: 'Spotify data', isDir: true },
  ].filter((s) => s.path && !s.path.endsWith(path.sep));
  return sites;
}

export async function scanAccess(): Promise<AccessItem[]> {
  const out: AccessItem[] = [];
  for (const def of REGISTRY) {
    if (def.integration) {
      out.push(...scanIntegrationAccess(def));
      await yieldToLoop();
      continue;
    }
    out.push(...scanFolders(def));
    out.push(...await scanApiKeys(def));
    out.push(...scanMcp(def));
    out.push(...await scanIntegrationsFromConfigs(def));
    if (def.id.startsWith('codex')) out.push(...await scanCodexSessions(def));
    await yieldToLoop();
  }
  out.push(...scanCredentialSites());
  persist(dedupeItems(out));
  return out;
}

// Read the leading chunk of a (possibly huge) file without loading it all.
function readHead(file: string, maxBytes = 8 * 1024): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, bytes);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// Codex stores sessions date-nested as
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, with the real working
// directory recorded inside each file's first `session_meta` record
// (payload.cwd). The generic scanFolders only sees the year folder, so it
// never surfaces the real project directories Codex accessed. The session_meta
// line can be tens of KB (long base instructions), so we read just the head
// and regex the cwd rather than JSON-parsing the whole line.
async function scanCodexSessions(def: AgentDef): Promise<AccessItem[]> {
  const roots = [
    ...(def.logPaths || []).filter((p) => /sessions$/i.test(p)),
    ...(def.configPaths || []).map((c) => path.join(c, 'sessions')),
  ];
  const seen = new Set<string>();
  const items: AccessItem[] = [];
  const MAX_FILES = 300;
  const MAX_FOLDERS = 50;
  let filesRead = 0;
  for (const root of roots) {
    if (items.length >= MAX_FOLDERS) break;
    try {
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
      await walkFiles(root, 6, (f) => {
        if (filesRead >= MAX_FILES || items.length >= MAX_FOLDERS) return;
        if (!/rollout-.*\.jsonl$/i.test(f)) return;
        filesRead++;
        const head = readHead(f);
        if (!head.includes('"session_meta"')) return;
        const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (!m) return;
        // Unescape the JSON string value (e.g. C:\\Users -> C:\Users).
        let cwd: string;
        try { cwd = JSON.parse(`"${m[1]}"`); } catch { cwd = m[1].replace(/\\\\/g, '\\'); }
        if (!cwd) return;
        const key = cwd.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        items.push({
          agentId: def.id,
          category: 'folder',
          label: path.basename(cwd) || cwd,
          detail: 'Project workspace (Codex session)',
          sourcePath: cwd,
          access: 'granted',
          lastSeen: Date.now(),
        });
      });
    } catch {}
  }
  return items;
}

// Collapse identical access rows (same agent/category/label/source) that
// different scanners can produce (e.g. duplicate MCP server entries).
function dedupeItems(items: AccessItem[]): AccessItem[] {
  const seen = new Set<string>();
  const out: AccessItem[] = [];
  for (const i of items) {
    const key = `${i.agentId}|${i.category}|${i.label}|${i.sourcePath ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

function scanFolders(def: AgentDef): AccessItem[] {
  const items: AccessItem[] = [];
  const candidates = [
    def.configPaths,
    [def.configPaths?.[0] ? path.join(def.configPaths[0], 'projects') : ''],
    [def.configPaths?.[0] ? path.join(def.configPaths[0], 'history.json') : ''],
    [def.configPaths?.[0] ? path.join(def.configPaths[0], 'recent.json') : ''],
  ]
    .flat()
    .filter(Boolean) as string[];

  // For Cursor / VS Code-like, look at storage.json
  const projectsDirs = (def.configPaths || [])
    .map((c) => [path.join(c, 'projects'), path.join(c, 'session-state'), path.join(c, 'sessions'), path.join(c, 'workspaceStorage')])
    .flat();

  for (const dir of projectsDirs) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        const entries = fs.readdirSync(dir).slice(0, 50);
        for (const e of entries) {
          // Skip meaningless bucket folders (e.g. Codex's YYYY / YYYY-MM date
          // dirs under sessions) — the real project path lives inside the
          // rollout files and is surfaced by scanCodexSessions instead.
          if (/^\d{4}([-_]\d{2}){0,2}$/.test(e)) continue;
          items.push({
            agentId: def.id,
            category: 'folder',
            label: e,
            detail: `Recent project / session record`,
            sourcePath: path.join(dir, e),
            lastSeen: Date.now(),
          });
        }
      }
    } catch {}
  }

  // Look for recent file references in JSON configs
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c) || !fs.statSync(c).isFile()) continue;
      const content = fs.readFileSync(c, 'utf8');
      const matches = content.match(/[A-Za-z]:\\[^"\n\r<>|*?]{3,200}/g) || [];
      for (const m of matches.slice(0, 30)) {
        items.push({
          agentId: def.id,
          category: 'folder',
          label: m,
          detail: 'Path referenced in agent config',
          sourcePath: c,
          lastSeen: Date.now(),
        });
      }
    } catch {}
  }

  return items;
}

async function scanApiKeys(def: AgentDef): Promise<AccessItem[]> {
  const items: AccessItem[] = [];
  if (!def.configPaths) return items;
  for (const root of def.configPaths) {
    try {
      if (!fs.existsSync(root)) continue;
      await walkFiles(root, 3, (f) => {
        if (!/\.(json|toml|yaml|yml|env|ini|cfg)$/i.test(f)) return;
        try {
          const content = fs.readFileSync(f, 'utf8');
          for (const hint of KEY_HINTS) {
            const re = new RegExp(`["']?(${hint}[\\w-]*)["']?\\s*[:=]\\s*["']?([A-Za-z0-9_\\-]{12,})`, 'gi');
            let m: RegExpExecArray | null;
            const seen = new Set<string>();
            while ((m = re.exec(content))) {
              const keyName = m[1];
              if (seen.has(keyName)) continue;
              seen.add(keyName);
              items.push({
                agentId: def.id,
                category: 'api-key',
                label: keyName,
                detail: `${m[2].slice(0, 4)}…${m[2].slice(-4)} (${m[2].length} chars)`,
                sourcePath: f,
                sensitive: true,
                lastSeen: Date.now(),
              });
              if (items.length > 200) return;
            }
          }
        } catch {}
      });
    } catch {}
  }
  return items;
}

function scanMcp(def: AgentDef): AccessItem[] {
  const items: AccessItem[] = [];
  if (!def.configPaths) return items;
  const candidates = def.configPaths
    .map((c) => [
      path.join(c, 'mcp.json'),
      path.join(c, 'config.json'),
      path.join(c, 'config.toml'),
      path.join(c, 'claude_desktop_config.json'),
      path.join(c, 'settings.json'),
    ])
    .flat();

  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue;
      const content = fs.readFileSync(c, 'utf8');
      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch {
        // toml or other, do a regex pass
        const re = /\[?mcp[._-]servers?\.["']?([\w-]+)/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content))) {
          items.push({
            agentId: def.id,
            category: 'mcp',
            label: m[1],
            detail: 'MCP server entry',
            sourcePath: c,
            lastSeen: Date.now(),
          });
          const integ = detectIntegration(m[1]);
          if (integ) {
            items.push({
              agentId: def.id,
              category: 'integration',
              label: integ.label,
              detail: `Wired through MCP server "${m[1]}"`,
              sourcePath: c,
              sensitive: !!integ.sensitive,
              access: 'granted',
              providerId: integ.id,
              lastSeen: Date.now(),
            });
          }
        }
        continue;
      }
      const servers = parsed?.mcpServers || parsed?.mcp_servers || parsed?.mcp || {};
      if (servers && typeof servers === 'object') {
        for (const [name, val] of Object.entries(servers)) {
          const v = val as any;
          const summary = typeof v === 'object' ? (v.command || v.url || JSON.stringify(v).slice(0, 200)) : String(v).slice(0, 200);
          items.push({
            agentId: def.id,
            category: 'mcp',
            label: name,
            detail: summary?.toString().slice(0, 200),
            sourcePath: c,
            lastSeen: Date.now(),
          });
          const integ = detectIntegration(`${name} ${summary}`);
          if (integ) {
            items.push({
              agentId: def.id,
              category: 'integration',
              label: integ.label,
              detail: `Wired through MCP server "${name}"`,
              sourcePath: c,
              sensitive: !!integ.sensitive,
              access: 'granted',
              providerId: integ.id,
              lastSeen: Date.now(),
            });
          }
        }
      }
    } catch {}
  }
  return items;
}

// Scan agent config files for environment variables / tokens whose names
// reference a known integration (e.g. SLACK_BOT_TOKEN, GMAIL_REFRESH_TOKEN).
async function scanIntegrationsFromConfigs(def: AgentDef): Promise<AccessItem[]> {
  const items: AccessItem[] = [];
  if (!def.configPaths) return items;
  const seen = new Set<string>();
  for (const root of def.configPaths) {
    try {
      if (!fs.existsSync(root)) continue;
      await walkFiles(root, 3, (f) => {
        if (!/\.(json|toml|yaml|yml|env|ini|cfg)$/i.test(f)) return;
        let content = '';
        try { content = fs.readFileSync(f, 'utf8'); } catch { return; }
        for (const integ of INTEGRATIONS) {
          for (const kw of integ.keywords) {
            // Only treat as an integration grant if the keyword appears
            // adjacent to a credential-shaped token/secret/url assignment.
            const re = new RegExp(
              `([\\w.-]*${kw}[\\w.-]*)\\s*[:=]\\s*["']?[A-Za-z0-9_\\-./:]{12,}`,
              'gi',
            );
            let m: RegExpExecArray | null;
            while ((m = re.exec(content))) {
              const key = `${def.id}:${integ.id}:${f}:${m[1]}`;
              if (seen.has(key)) continue;
              seen.add(key);
              items.push({
                agentId: def.id,
                category: 'integration',
                label: integ.label,
                detail: `Credential "${m[1]}" embedded in agent config`,
                sourcePath: f,
                sensitive: !!integ.sensitive,
                access: 'granted',
                providerId: integ.id,
                lastSeen: Date.now(),
              });
              if (items.length > 200) return;
            }
          }
        }
      });
    } catch {}
  }
  return items;
}

// Walk well-known credential locations on disk and attribute them to any
// agent whose config path overlaps with the credential file. If no agent
// overlaps, we still surface the integration under each agent that *could*
// potentially use it (we attach to all CLI agents) so the user can see what
// providers their local AI agents could touch.
function scanCredentialSites(): AccessItem[] {
  const out: AccessItem[] = [];
  const sites = credentialSites();
  for (const site of sites) {
    let exists = false;
    try {
      exists = fs.existsSync(site.path);
    } catch {}
    if (!exists) continue;
    const integ = INTEGRATIONS.find((i) => i.id === site.integrationId);
    if (!integ) continue;
    // Attribute to all CLI agents — they are the ones that can shell out and
    // read these credentials. Avoid duplicating per IDE extension.
    const owners = REGISTRY.filter((d) => d.kind === 'cli');
    for (const owner of owners) {
      out.push({
        agentId: owner.id,
        category: 'integration',
        label: integ.label,
        detail: `${site.detail} — ${owner.name} could read these locally`,
        sourcePath: site.path,
        sensitive: !!integ.sensitive,
        access: 'potential',
        providerId: integ.id,
        lastSeen: Date.now(),
      });
    }
  }
  return out;
}

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

async function walkFiles(
  root: string,
  maxDepth: number,
  fn: (file: string) => void,
  depth = 0,
  counter: { n: number } = { n: 0 },
) {
  if (depth > maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
      await walkFiles(full, maxDepth, fn, depth + 1, counter);
    } else if (e.isFile()) {
      try {
        const stat = fs.statSync(full);
        if (stat.size > 2 * 1024 * 1024) continue;
        fn(full);
        if (++counter.n % 15 === 0) await yieldToLoop();
      } catch {}
    }
  }
}

function persist(items: AccessItem[]) {
  // Wrap the wipe-and-rebuild in a transaction so a concurrent /api/access
  // read can never observe the temporarily-empty table between DELETE
  // and the INSERTs. node:sqlite is synchronous within one call, but
  // belt-and-braces — if the loop ever grows an await, this stays safe.
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM access_items');
    const stmt = db.prepare(
      'INSERT INTO access_items (agent_id,category,label,detail,source_path,sensitive,access_kind,provider_id,last_seen) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    for (const i of items) {
      stmt.run(
        i.agentId,
        i.category,
        i.label,
        i.detail ?? null,
        i.sourcePath ?? null,
        i.sensitive ? 1 : 0,
        i.access ?? null,
        i.providerId ?? null,
        i.lastSeen,
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function listAccess(agentId?: string): AccessItem[] {
  const rows = agentId
    ? (db.prepare('SELECT * FROM access_items WHERE agent_id=? ORDER BY category,label').all(agentId) as any[])
    : (db.prepare('SELECT * FROM access_items ORDER BY agent_id,category,label').all() as any[]);
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    category: r.category,
    label: r.label,
    detail: r.detail ?? undefined,
    sourcePath: r.source_path ?? undefined,
    sensitive: !!r.sensitive,
    access: r.access_kind ?? undefined,
    providerId: r.provider_id ?? undefined,
    lastSeen: r.last_seen,
  }));
}

export interface RevokeRecipe {
  agentId: string;
  category: string;
  steps: string[];
  openPath?: string;
}

export interface UninstallRecipe {
  agentId: string;
  agentName: string;
  steps: string[];
  openPath?: string;
}

// Build a tailored uninstall guide based on agent kind + platform.
export function getUninstallGuide(agentId: string): UninstallRecipe {
  const def = REGISTRY.find((d) => d.id === agentId);
  if (!def) return { agentId, agentName: agentId, steps: ['Agent not found in registry.'] };
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const steps: string[] = [];
  let openPath: string | undefined;
  if (def.integration) {
    return {
      agentId, agentName: def.name,
      steps: [
        `Quit ${def.name} using its own interface.`,
        'Use the original package manager or operating-system app uninstaller. Portable applications may not have an uninstaller.',
        'Do not delete shared configuration or sessions: Kiro and goose may share them between CLI and desktop products.',
        'Removing the application does not remove the history already imported into Cioppino.',
      ],
    };
  }

  // Pull a likely install/config location for the user to inspect.
  const row = db.prepare('SELECT bin_path, config_path FROM agents WHERE id=?').get(agentId) as
    | { bin_path?: string; config_path?: string }
    | undefined;
  const binPath = row?.bin_path;
  const configPath = row?.config_path;
  openPath = binPath || configPath;

  steps.push(`Quit ${def.name} if it is currently running (close all windows; check the system tray / menu bar).`);

  switch (def.kind) {
    case 'desktop':
      if (isWin) {
        steps.push(
          `Open Settings → Apps → Installed apps and search for "${def.name}".`,
          `Click the entry and choose Uninstall, then follow the prompts.`,
          `If the app shipped a standalone uninstaller, look in its install folder (${binPath || 'see source path below'}) for an "unins*.exe" or "Uninstall.exe" and run it.`,
        );
      } else if (isMac) {
        steps.push(
          `Open /Applications in Finder, find ${def.name}.app, and drag it to the Trash.`,
          `Empty the Trash to complete removal.`,
        );
      } else {
        steps.push(
          `Use your distro's package manager to remove the package (e.g. \`apt remove\`, \`dnf remove\`, \`snap remove\`, or \`flatpak uninstall\`).`,
          `If installed via AppImage, simply delete the AppImage file.`,
        );
      }
      steps.push(
        `Delete leftover user data and config: ${configPath || `look under ${isWin ? '%APPDATA% / %LOCALAPPDATA%' : '~/Library/Application Support or ~/.config'} for a "${def.name}" folder`}.`,
      );
      break;

    case 'cli':
      steps.push(
        binPath
          ? `Locate the CLI binary at: ${binPath}`
          : `Find the CLI binary on PATH (run \`${isWin ? 'where' : 'which'} ${def.id}\` in a terminal).`,
      );
      steps.push(
        `If it was installed via npm: \`npm uninstall -g <package>\`.`,
        `If it was installed via Homebrew: \`brew uninstall <formula>\`.`,
        `If it was installed via pipx/pip: \`pipx uninstall <package>\` or \`pip uninstall <package>\`.`,
        `If the binary was downloaded manually, just delete it from the path above.`,
        `Remove the agent's config/cache: ${configPath || `look under ${isWin ? '%USERPROFILE%' : '~'} for a folder beginning with ".${def.id}" or "${def.id}"`}.`,
      );
      break;

    case 'extension':
      steps.push(
        `Open the host IDE (likely VS Code, Cursor, or a JetBrains IDE).`,
        `Go to the Extensions / Plugins panel.`,
        `Search for "${def.name}".`,
        `Click Uninstall (or Disable to keep it installed but inactive).`,
        `Restart the IDE to fully remove background processes.`,
        configPath
          ? `Optionally delete cached data at: ${configPath}`
          : `Optionally delete the extension's cache folder (e.g. \`~/.vscode/extensions/<publisher>.<name>-*\`).`,
      );
      break;

    default:
      steps.push(`Locate the install path below and remove it manually.`);
  }

  steps.push(
    `After uninstalling, run a Rescan in Cioppino → Access to confirm the agent's entries disappear.`,
  );

  return { agentId, agentName: def.name, steps, openPath };
}

// Provider-specific revoke instructions: where to go to actually invalidate
// access for each known integration.
interface ProviderRevoke {
  url: string;
  hint: string;
}
const PROVIDER_REVOKE: Record<string, ProviderRevoke> = {
  gmail:     { url: 'https://myaccount.google.com/permissions',                hint: 'Google Account → Security → Third-party access' },
  google:    { url: 'https://myaccount.google.com/permissions',                hint: 'Google Account → Security → Third-party access' },
  gcal:      { url: 'https://myaccount.google.com/permissions',                hint: 'Google Account → Security → Third-party access' },
  drive:     { url: 'https://myaccount.google.com/permissions',                hint: 'Google Account → Security → Third-party access' },
  outlook:   { url: 'https://account.live.com/consent/Manage',                 hint: 'Microsoft Account → Privacy → Apps and services that can access your data' },
  teams:     { url: 'https://myaccount.microsoft.com/',                        hint: 'Microsoft 365 admin / personal account → Apps' },
  onedrive:  { url: 'https://account.live.com/consent/Manage',                 hint: 'Microsoft Account → Privacy → Apps' },
  slack:     { url: 'https://api.slack.com/apps',                              hint: 'Slack → Apps & Integrations → manage tokens' },
  discord:   { url: 'https://discord.com/developers/applications',             hint: 'Discord Developer Portal → Applications' },
  telegram:  { url: 'https://my.telegram.org/auth',                            hint: 'Telegram → API development tools → terminate sessions' },
  whatsapp:  { url: 'https://faq.whatsapp.com/',                               hint: 'WhatsApp → Settings → Linked devices → log out' },
  signal:    { url: 'https://support.signal.org/',                             hint: 'Signal → Settings → Linked devices' },
  zoom:      { url: 'https://marketplace.zoom.us/user/installed',              hint: 'Zoom Marketplace → Manage → Installed Apps' },
  notion:    { url: 'https://www.notion.so/my-integrations',                   hint: 'Notion → Settings → My connections / integrations' },
  github:    { url: 'https://github.com/settings/applications',                hint: 'GitHub → Settings → Applications → Authorized OAuth Apps' },
  gitlab:    { url: 'https://gitlab.com/-/profile/applications',               hint: 'GitLab → Preferences → Applications' },
  bitbucket: { url: 'https://bitbucket.org/account/settings/app-authorizations/', hint: 'Bitbucket → Personal settings → App authorizations' },
  jira:      { url: 'https://id.atlassian.com/manage-profile/apps',            hint: 'Atlassian → Connected apps' },
  linear:    { url: 'https://linear.app/settings/api',                         hint: 'Linear → Settings → API' },
  asana:     { url: 'https://app.asana.com/0/my-apps',                         hint: 'Asana → My Apps → Authorized apps' },
  trello:    { url: 'https://trello.com/your/account',                         hint: 'Trello → Account → Applications' },
  confluence:{ url: 'https://id.atlassian.com/manage-profile/apps',            hint: 'Atlassian → Connected apps' },
  dropbox:   { url: 'https://www.dropbox.com/account/connected_apps',          hint: 'Dropbox → Settings → Connected apps' },
  box:       { url: 'https://app.box.com/account#access',                      hint: 'Box → Account Settings → Authentication' },
  twitter:   { url: 'https://x.com/settings/connected_apps',                   hint: 'X / Twitter → Settings → Connected apps' },
  reddit:    { url: 'https://www.reddit.com/prefs/apps',                       hint: 'Reddit → Preferences → Apps' },
  spotify:   { url: 'https://www.spotify.com/account/apps/',                   hint: 'Spotify → Account → Apps' },
  youtube:   { url: 'https://myaccount.google.com/permissions',                hint: 'Google Account → Security → Third-party access' },
  figma:     { url: 'https://www.figma.com/settings',                          hint: 'Figma → Settings → Account → Apps' },
  sentry:    { url: 'https://sentry.io/settings/account/api/',                 hint: 'Sentry → User settings → Auth tokens' },
  stripe:    { url: 'https://dashboard.stripe.com/account/applications',       hint: 'Stripe Dashboard → Settings → Connected apps' },
  hubspot:   { url: 'https://app.hubspot.com/api-key/',                        hint: 'HubSpot → Settings → API key / Connected apps' },
  calendar:  { url: '',                                                        hint: 'Open the calendar provider and revoke the integration there.' },
};

export function getRevokeGuide(agentId: string, category: string, sourcePath?: string, providerId?: string): RevokeRecipe {
  const def = REGISTRY.find((d) => d.id === agentId);
  if (def?.integration) {
    const key = agentId === 'zed' ? 'context_servers' : agentId.startsWith('goose-') ? 'extensions' : 'mcpServers';
    return {
      agentId, category,
      steps: [
        `Review this entry in ${def.name}'s own settings; configured or potential access is not proof of active use.`,
        ...(category === 'mcp' || category === 'extension'
          ? [`For file-based configuration, review the "${key}" entry in the registered source file. Disable it in the application before editing.`]
          : ['Use the application or provider controls to change permissions. Do not delete a credential file based only on a potential-access entry.']),
        'Shared configuration changes can affect both CLI and desktop products. Workspace or custom-agent overrides may also apply.',
        'Cioppino does not change these files or revoke permissions automatically.',
      ],
      openPath: sourcePath,
    };
  }
  const steps: string[] = [];
  switch (category) {
    case 'api-key':
      steps.push(
        `Open the config file shown below.`,
        `Locate the key entry and remove it (or replace its value with an empty string).`,
        `Save the file.`,
        `Rotate the key on the provider's website if it may have leaked.`,
        `Restart ${def?.name || 'the agent'} to apply changes.`,
      );
      break;
    case 'mcp':
      steps.push(
        `Open the config file shown below.`,
        `Find the MCP server entry under the "mcpServers" object.`,
        `Delete that entry to revoke the agent's access to this MCP server.`,
        `Save and restart ${def?.name || 'the agent'}.`,
      );
      break;
    case 'folder':
      steps.push(
        `Open the file/folder reference shown below.`,
        `Move or remove the project from the recents list, or delete the session file.`,
        `For OS-level access control, remove permissions from the folder's properties.`,
      );
      break;
    case 'extension':
      steps.push(
        `Open your IDE's Extensions panel.`,
        `Find the extension matching this entry.`,
        `Click "Disable" or "Uninstall".`,
      );
      break;
    case 'integration': {
      const pid = providerId || guessProviderFromPath(sourcePath || '');
      const provider = pid ? PROVIDER_REVOKE[pid] : undefined;
      const providerName = pid
        ? (INTEGRATIONS.find((i) => i.id === pid)?.label || pid)
        : 'this provider';
      steps.push(
        `Revoke the agent's grant on ${providerName} directly: ${provider?.hint || 'visit the provider\'s account/security page and remove the connected app or integration'}.`,
      );
      if (provider?.url) {
        steps.push(`Open ${provider.url} and remove any entry referring to ${def?.name || 'this agent'} or the related MCP server.`);
      }
      steps.push(
        `Delete the local credential file/folder shown below — it caches the OAuth token or session that ${def?.name || 'the agent'} reads.`,
        `If the integration was wired through an MCP server, also remove its entry from the agent's "mcpServers" config so it can't reconnect.`,
        `Restart ${def?.name || 'the agent'} so it drops any cached connection.`,
      );
      break;
    }
    default:
      steps.push(`Open the source path below and remove the relevant entry manually.`);
  }
  return { agentId, category, steps, openPath: sourcePath };
}

// Cheap heuristic so the existing get-revoke-guide endpoint can pick the
// right provider without changing its signature.
function guessProviderFromPath(p: string): string | undefined {
  const t = p.toLowerCase();
  for (const integ of INTEGRATIONS) {
    for (const kw of integ.keywords) if (t.includes(kw)) return integ.id;
  }
  return undefined;
}

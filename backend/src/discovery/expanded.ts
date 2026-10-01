import path from 'node:path';
import type { AgentDef, ConfigSource, IntegrationDef } from './registry.js';

export function integrationMonitoring(def: AgentDef) {
  if (!def.integration) return undefined;
  return {
    platformAvailable: def.integration.platforms.includes(process.platform),
    resources: def.kind === 'cli' ? 'Attributed processes' : 'Whole application, not AI-only',
    access: 'Limited to verified user configuration',
    activity: def.integration.activity === 'pi' ? 'Pi v2/v3 JSONL' : 'Not yet supported',
    tokens: def.integration.activity === 'pi' ? 'Reported Pi usage; missing models remain unpriced' : 'Not yet supported',
    notes: def.integration.notes,
  };
}

export function expandedAgents(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
): AgentDef[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const join = (...parts: string[]) => p.join(home, ...parts);
  const absolute = (value: string | undefined, fallback: string) =>
    value && p.isAbsolute(value) ? value : fallback;
  const roaming = absolute(env.APPDATA, join('AppData', 'Roaming'));
  const local = absolute(env.LOCALAPPDATA, join('AppData', 'Local'));
  const xdg = absolute(env.XDG_CONFIG_HOME, join('.config'));
  const pi = absolute(env.PI_CODING_AGENT_DIR, join('.pi', 'agent'));
  const goose = env.GOOSE_PATH_ROOT && p.isAbsolute(env.GOOSE_PATH_ROOT)
    ? p.join(env.GOOSE_PATH_ROOT, 'config')
    : platform === 'win32' ? p.join(roaming, 'Block', 'goose', 'config') : p.join(xdg, 'goose');
  const binDirs = platform === 'win32'
    ? [join('.local', 'bin'), p.join(roaming, 'npm')]
    : [join('.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const appPaths = (name: string) => platform === 'darwin'
    ? [`/Applications/${name}.app`, join('Applications', `${name}.app`)]
    : [];
  const config = (file: string, kind: ConfigSource['kind'], format: ConfigSource['format'] = 'json', shared = false): ConfigSource =>
    ({ file, kind, format, shared });
  const integration = (configs: ConfigSource[], installPaths: string[] = [], notes = ''): IntegrationDef => ({
    platforms: ['win32', 'darwin', 'linux'],
    installPaths,
    binDirs,
    configs,
    activity: 'unverified',
    notes: `${notes} Session and usage formats are not yet verified; activity, tokens, downloads, and latency are unavailable.`.trim(),
  });
  const kiroConfig = config(join('.kiro', 'settings', 'mcp.json'), 'mcp', 'json', true);
  const gooseConfig = config(p.join(goose, 'config.yaml'), 'goose', 'yaml', true);
  return [
    {
      id: 'kiro-cli', name: 'Kiro CLI', vendor: 'AWS', kind: 'cli',
      binNames: ['kiro-cli'], processNames: ['kiro-cli', 'kiro-cli.exe'],
      configPaths: [join('.kiro')],
      integration: integration([kiroConfig], [], 'User MCP configuration only; workspace and custom-agent overrides are not inspected. Native Windows requires Windows 11.'),
      description: 'Kiro terminal agent; separate from Kiro IDE.',
    },
    {
      id: 'junie-cli', name: 'Junie CLI', vendor: 'JetBrains', kind: 'cli',
      binNames: ['junie'], processNames: ['junie', 'junie.exe'],
      configPaths: [join('.junie')],
      integration: integration([config(join('.junie', 'sandbox.json'), 'junie')], [],
        'Sandbox policy presence only, not active permissions or MCP access. Version probes are disabled because the launcher can auto-update.'),
      description: 'JetBrains terminal coding agent.',
    },
    {
      id: 'goose-cli', name: 'goose CLI', vendor: 'AAIF / Block', kind: 'cli',
      binNames: ['goose'], processNames: ['goose', 'goose.exe'],
      configPaths: [goose],
      integration: integration([gooseConfig], [],
        'Configuration is shared with goose Desktop. Only positively identified CLI processes are attributed.'),
      description: 'Open-source goose terminal agent.',
    },
    {
      id: 'pi-coding-agent', name: 'Pi Coding Agent', vendor: 'Pi', kind: 'cli',
      binNames: ['pi'], processNames: ['node', 'node.exe'],
      configPaths: [pi],
      integration: {
        ...integration([config(p.join(pi, 'settings.json'), 'pi')]),
        activity: 'pi', sessionPaths: [p.join(pi, 'sessions')],
        notes: 'Detects npm packages @mariozechner/pi-coding-agent and its upstream successor @earendil-works/pi-coding-agent. Standalone binaries and custom session directories are not detected. Pi v2/v3 JSONL messages and reported usage are supported; summary/tool usage without a model stays unpriced. Activity text-token estimates are separate from reported Tokens usage. Settings inspection does not imply MCP support.',
      },
      description: 'Pi terminal coding agent from the badlogic/pi-mono project.',
    },
    {
      id: 'kiro-ide', name: 'Kiro IDE', vendor: 'AWS', kind: 'ide',
      binNames: ['kiro'], processNames: ['Kiro', 'Kiro.exe', 'kiro'],
      configPaths: [join('.kiro')],
      integration: integration([kiroConfig], appPaths('Kiro'),
        'Whole-application CPU/memory, not AI-only activity. User MCP configuration only; workspace/custom-agent overrides are not inspected.'),
      description: 'Kiro editor; separate from Kiro CLI.',
    },
    {
      id: 'zed', name: 'Zed', vendor: 'Zed Industries', kind: 'ide',
      binNames: ['zed'], processNames: ['zed', 'zed.exe', 'Zed'],
      configPaths: [platform === 'win32' ? p.join(roaming, 'Zed') : join('.config', 'zed')],
      integration: integration([config(platform === 'win32'
        ? p.join(roaming, 'Zed', 'settings.json') : join('.config', 'zed', 'settings.json'), 'zed', 'jsonc')], appPaths('Zed'),
        'Whole-editor CPU/memory, excluding separately attributed external agents. User context_servers only; project and ACP-agent configuration are not inspected.'),
      description: 'Zed editor and its agent panel.',
    },
    {
      id: 'goose-desktop', name: 'goose Desktop', vendor: 'AAIF / Block', kind: 'desktop',
      processNames: ['Goose', 'Goose.exe', 'goosed', 'goosed.exe'],
      configPaths: [goose],
      integration: integration([gooseConfig], appPaths('Goose'),
        'Whole-application CPU/memory. Shared config is not proof Desktop is installed; CLI/Desktop history is not imported or counted twice.'),
      description: 'goose Desktop, distinct from the goose CLI.',
    },
    {
      id: 'warp', name: 'Warp', vendor: 'Warp', kind: 'desktop',
      processNames: ['Warp', 'warp.exe', 'warp-terminal'],
      configPaths: [join('.warp')],
      integration: integration([config(join('.warp', '.mcp.json'), 'mcp')], platform === 'win32'
        ? [p.join(local, 'programs', 'Warp', 'warp.exe'),
          p.join(absolute(env.ProgramFiles, 'C:\\Program Files'), 'Warp', 'warp.exe')]
        : appPaths('Warp'),
      'Includes Warp Agent. CPU/memory measure the terminal app, not AI-only work. Only Warp user file-based MCP definitions are inspected; UI-managed, third-party, and project approvals are not inferred.'),
      description: 'Warp terminal and Warp Agent in one integration.',
    },
  ];
}

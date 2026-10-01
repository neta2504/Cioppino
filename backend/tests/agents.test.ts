import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expandedAgents, integrationMonitoring } from '../src/discovery/expanded.js';
import { desktopGoose, isPiBinary, matchesIntegrationProcess, piScript, resolveIntegration } from '../src/discovery/integrationDiscovery.js';
import { readIntegrationFile } from '../src/discovery/integrationFiles.js';
import { getIntegrationIssues } from '../src/discovery/integrationStatus.js';
import { scanIntegrationAccess } from '../src/access/integrations.js';
import { parsePiSession, readPiSessions } from '../src/activity/pi.js';
import type { ProcInfo, ProcSnapshot } from '../src/discovery/procSnapshot.js';
import type { AgentDef } from '../src/discovery/registry.js';
import type { DiscoveredAgent } from '../src/discovery/index.js';
import { createPricingFixture } from './pricing-fixture.js';

const fixture = await createPricingFixture();
const { REGISTRY } = await import('../src/discovery/registry.js');
const { samplesForAgents } = await import('../src/performance/index.js');
const { verifyIntegrationPid, listAgents } = await import('../src/discovery/index.js');
after(() => fixture.close());
const definitions = expandedAgents(process.platform, fixture.directory, {});
const get = (id: string) => {
  const def = definitions.find((item) => item.id === id);
  assert.ok(def, id);
  return def;
};
const write = (relative: string, content: string) => {
  const file = path.join(fixture.directory, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};
const proc = (name: string, executable = name, cmdline = executable, pid = 42): ProcInfo => ({
  name, executable, cmdline, pid, started: 'synthetic-start', cpu: 12, rssMb: 34, threads: 2,
});
function withConfig(id: string, file: string): AgentDef {
  const def = get(id);
  assert.ok(def.integration);
  return { ...def, integration: { ...def.integration, configs: [{ ...def.integration.configs[0], file }] } };
}

const now = Date.now();
const session = (id = 'session-one') => [
  { type: 'session', version: 3, id, timestamp: new Date(now).toISOString(), cwd: 'C:\\Synthetic Project' },
  { type: 'message', id: 'user-1', timestamp: new Date(now + 1).toISOString(), message: { role: 'user', content: 'Synthetic question' } },
  { type: 'message', id: 'assistant-1', timestamp: new Date(now + 2).toISOString(), message: {
    role: 'assistant', content: [{ type: 'text', text: 'Synthetic answer' }, { type: 'thinking', thinking: 'Do not import this block' }],
    model: 'gpt-6-astra', usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 5, cacheWrite1h: 10 },
  } },
  { type: 'message', id: 'assistant-2', timestamp: new Date(now + 3).toISOString(), message: {
    role: 'assistant', content: 'Another answer', model: 'gpt-6-astra',
    usage: { input: 200, output: 10, cacheRead: 0, cacheWrite: 0 },
  } },
  { type: 'usage', id: 'usage-3', timestamp: new Date(now + 4).toISOString(), kind: 'cache_warm',
    model: 'future-unknown-model', usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 } },
  { type: 'compaction', id: 'summary-4', timestamp: new Date(now + 5).toISOString(), tokensBefore: 999999, summary: 'Compacted',
    usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 } },
].map((entry) => JSON.stringify(entry)).join('\n') + '\n';

test('registry adds exactly eight stable identities and one Warp entry', () => {
  assert.equal(REGISTRY.length, 33);
  assert.equal(new Set(REGISTRY.map((item) => item.id)).size, 33);
  assert.equal(REGISTRY.filter((item) => item.integration).length, 8);
  assert.equal(REGISTRY.filter((item) => /warp/i.test(item.id)).length, 1);
  assert.equal(definitions.filter((item) => item.integration?.activity === 'pi').length, 1);
  for (const def of definitions) assert.equal(def.logPaths, undefined, 'Do not feed new formats to legacy regex readers');
});

test('Windows and macOS roots are explicit, including supported absolute overrides', () => {
  const windows = expandedAgents('win32', 'C:\\Synthetic User', { APPDATA: 'D:\\Roaming', LOCALAPPDATA: 'D:\\Local' });
  assert.equal(windows.find((def) => def.id === 'goose-cli')?.integration?.configs[0].file, 'D:\\Roaming\\Block\\goose\\config\\config.yaml');
  assert.equal(windows.find((def) => def.id === 'zed')?.integration?.configs[0].file, 'D:\\Roaming\\Zed\\settings.json');
  const mac = expandedAgents('darwin', '/Users/synthetic', {});
  assert.ok(mac.find((def) => def.id === 'goose-desktop')?.integration?.installPaths.includes('/Applications/Goose.app'));
  assert.equal(mac.find((def) => def.id === 'zed')?.integration?.configs[0].file, '/Users/synthetic/.config/zed/settings.json');
  const custom = expandedAgents('win32', 'C:\\Home', { PI_CODING_AGENT_DIR: 'D:\\Pi', GOOSE_PATH_ROOT: 'D:\\Goose' });
  assert.deepEqual(custom.find((def) => def.id === 'pi-coding-agent')?.integration?.sessionPaths, ['D:\\Pi\\sessions']);
  assert.equal(custom.find((def) => def.id === 'goose-cli')?.integration?.configs[0].file, 'D:\\Goose\\config\\config.yaml');
  assert.equal(expandedAgents('win32', 'C:\\Home', { PI_CODING_AGENT_DIR: 'relative' })
    .find((def) => def.id === 'pi-coding-agent')?.configPaths?.[0], 'C:\\Home\\.pi\\agent');
});

test('Pi process detection uses the actual script argument, never prompt substrings', () => {
  const script = 'C:\\Synthetic User\\node_modules\\@mariozechner\\pi-coding-agent\\dist\\cli.js';
  assert.equal(piScript(`"C:\\Program Files\\nodejs\\node.exe" "${script}"`), script);
  assert.equal(matchesIntegrationProcess(get('pi-coding-agent'), proc('node.exe', 'node.exe', `node.exe "${script}"`)), true);
  assert.equal(piScript(`node other.js "${script}"`), undefined);
  assert.equal(piScript(`node -e "${script}"`), undefined);
  assert.equal(matchesIntegrationProcess(get('pi-coding-agent'), proc('python.exe', 'python.exe', `node "${script}"`)), false);
  assert.equal(matchesIntegrationProcess(get('kiro-cli'), proc('kiro-cli-helper')), false);
  assert.equal(matchesIntegrationProcess(get('kiro-ide'), proc('Electron', '/Applications/Kiro.app/Contents/MacOS/Electron')), true);
  assert.equal(matchesIntegrationProcess(get('kiro-cli'), proc('Kiro')), false);
});

test('goose CLI and Electron Desktop never own the same process', () => {
  const desktop = 'C:\\Portable Goose\\Goose.exe';
  const markers = (file: string) => file === 'C:\\Portable Goose\\resources\\app.asar';
  assert.equal(desktopGoose(desktop, markers), true);
  const process = proc('Goose.exe', desktop);
  assert.equal(matchesIntegrationProcess(get('goose-desktop'), process, new Set(), markers), true);
  assert.equal(matchesIntegrationProcess(get('goose-cli'), process, new Set(['c:/portable goose/goose.exe']), markers), false);
  assert.equal(matchesIntegrationProcess(get('goose-cli'), proc('goose.exe', 'C:\\migration\\goose.exe')), false);
  assert.equal(matchesIntegrationProcess(get('goose-cli'), proc('goose.exe', 'C:\\cli\\goose.exe'), new Set(['c:/cli/goose.exe']), () => false), true);
});

test('native identities remain distinct and running processes are visible without PATH', async () => {
  for (const [id, name] of [['kiro-cli', 'kiro-cli.exe'], ['junie-cli', 'junie.exe'],
    ['kiro-ide', 'Kiro.exe'], ['zed', 'zed.exe'], ['warp', 'warp.exe']]) {
    const original = get(id);
    const def = { ...original, binNames: [], integration: { ...original.integration!, binDirs: [], installPaths: [] } };
    const result = await resolveIntegration(def, [proc(name)], { PATH: '' });
    assert.equal(result.installed, true, id);
    assert.deepEqual(result.pids, [42], id);
    assert.equal(matchesIntegrationProcess(def, proc('unrelated-' + name)), false);
  }
});

test('shared residual config is not proof either goose application is installed', async () => {
  const config = write('shared-goose/config.yaml', 'extensions: {}');
  for (const id of ['goose-cli', 'goose-desktop']) {
    const original = get(id);
    const def = { ...original, configPaths: [path.dirname(config)], binNames: [], integration: {
      ...original.integration!, binDirs: [], installPaths: [],
    } };
    const result = await resolveIntegration(def, [], { PATH: '' });
    assert.equal(result.installed, false);
    assert.equal(result.configPath, path.dirname(config));
  }
});

test('npm shim discovery verifies Pi package identity without executing it', async () => {
  const shim = write('npm-bin/pi.cmd', '@echo off\r\nnode "%dp0%/node_modules/@mariozechner/pi-coding-agent/dist/cli.js" %*\r\n');
  write('npm-bin/node_modules/@mariozechner/pi-coding-agent/package.json', JSON.stringify({ name: '@mariozechner/pi-coding-agent' }));
  assert.equal(isPiBinary(shim), true);
  assert.equal(isPiBinary(write('unrelated-pi.cmd', '@echo unrelated')), false);
  const def = get('pi-coding-agent');
  const result = await resolveIntegration({ ...def, binNames: process.platform === 'win32' ? ['pi'] : ['pi.cmd'],
    integration: { ...def.integration!, binDirs: [path.dirname(shim)] } }, [], { PATH: '' });
  assert.equal(result.installed, true);
  assert.equal(result.binPath, shim);
});

test('bounded file reading rejects oversized and non-file sources', () => {
  assert.throws(() => readIntegrationFile(write('too-large.txt', '0123456789'), 4));
  assert.throws(() => readIntegrationFile(fixture.directory));
  assert.equal(readIntegrationFile(path.join(fixture.directory, 'absent.json')), undefined);
});

test('Zed JSONC inspection preserves disabled state and never copies secrets', () => {
  const file = write('zed/settings.json', `{
    // supported JSONC
    "context_servers": {
      "enabled-server": {"command":"tool", "env":{"TOKEN":"synthetic-secret-value"}, "args":["synthetic-secret-value"]},
      "disabled-server": {"enabled":false, "url":"https://user:synthetic-secret-value@example.test",},
    }
  }`);
  const items = scanIntegrationAccess(withConfig('zed', file));
  assert.equal(items.find((item) => item.label === 'enabled-server')?.access, 'granted');
  assert.equal(items.find((item) => item.label === 'disabled-server')?.access, 'potential');
  assert.equal(JSON.stringify(items).includes('synthetic-secret-value'), false);
  assert.equal(JSON.stringify(items).includes('example.test'), false);
});

test('goose YAML handles builtin and MCP entries and shared config without secrets', () => {
  const file = write('goose/config.yaml', `providers:\n  anthropic:\n    enabled: true\nextensions:\n  dev:\n    type: builtin\n    enabled: true\n  local:\n    type: stdio\n    enabled: false\n    envs:\n      TOKEN: synthetic-yaml-secret\n`);
  const cli = scanIntegrationAccess(withConfig('goose-cli', file));
  const desktop = scanIntegrationAccess(withConfig('goose-desktop', file));
  assert.equal(cli.find((item) => item.label === 'dev')?.category, 'extension');
  assert.equal(cli.find((item) => item.label === 'local')?.access, 'potential');
  assert.equal(cli.length, desktop.length);
  assert.ok(cli.every((item) => item.detail?.includes('Shared')));
  assert.equal(JSON.stringify(cli).includes('synthetic-yaml-secret'), false);
});

test('malformed or oversized config is surfaced with sanitized errors', () => {
  const file = write('invalid/config.json', '{"context_servers": "synthetic-sensitive-garbage"');
  assert.deepEqual(scanIntegrationAccess(withConfig('zed', file)), []);
  const issues = getIntegrationIssues('zed');
  assert.ok(issues.length);
  assert.equal(JSON.stringify(issues).includes('synthetic-sensitive-garbage'), false);
  assert.deepEqual(scanIntegrationAccess(withConfig('zed', fixture.directory)), []);
});

test('Pi usage uses exact counters and excludes reasoning/cache subset double counting', () => {
  const data = parsePiSession(session());
  assert.equal(data.activity.length, 3);
  assert.equal(data.activity[1].content, 'Synthetic answer');
  assert.equal(data.usage.length, 4);
  assert.deepEqual(data.usage.map((event) => [event.inputTokens, event.outputTokens, event.cacheReadTokens, event.cacheCreateTokens]),
    [[100, 20, 30, 40], [200, 10, 0, 0], [5, 3, 0, 0], [2, 3, 0, 0]]);
  assert.equal(fixture.pricing.costForUsage(data.usage[0], fixture.pricing.DEFAULT_PRICE_TABLE), 0.00253);
  assert.equal(fixture.pricing.costForUsage(data.usage[3], fixture.pricing.DEFAULT_PRICE_TABLE), null);
  assert.equal(data.projects[0].cwd, 'C:\\Synthetic Project');
});

test('unsupported headers and incomplete records do not become successful zero usage', () => {
  assert.throws(() => parsePiSession(session().replace('"version":3', '"version":99')));
  const data = parsePiSession(session() + '{"type":"message"');
  assert.equal(data.usage.length, 4);
  assert.equal(data.issues.length, 1);
  const invalid = parsePiSession(session().replace('"input":100', '"input":-1'));
  assert.equal(invalid.usage.length, 3);
  assert.ok(invalid.issues.length);
});

test('forks and alternate roots deduplicate usage without changing original source files', () => {
  const first = write('pi-fixtures/project/01.jsonl', session());
  const second = write('pi-fixtures/project/02.jsonl', session('session-fork'));
  const root = path.dirname(path.dirname(first));
  const data = readPiSessions([root, root]);
  assert.equal(data.usage.length, 4);
  assert.equal(data.activity.length, 3);
  assert.equal(data.activity[0].sessionId, 'session-one');
  assert.equal(data.projects.length, 2);
  assert.equal(fs.readFileSync(first, 'utf8'), session());
  assert.equal(fs.readFileSync(second, 'utf8'), session('session-fork'));
});

test('resource samples count each PID once and reject reused or stale identities', () => {
  const process = proc('Warp', '/Applications/Warp.app/Contents/MacOS/warp');
  const snap: ProcSnapshot = { ok: true, ts: now, procs: [process], byPid: new Map([[42, process]]), byName: new Map() };
  const agent: DiscoveredAgent = {
    id: 'warp', name: 'Warp', vendor: 'Warp', kind: 'desktop', installed: true, running: true, pids: [42, 42], lastSeen: now,
    metadata: { monitoring: integrationMonitoring(get('warp')), processIdentities: { 42: process.started } },
  };
  const samples = samplesForAgents([agent, { ...agent, id: 'other' }], snap, new Map(), now);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].cpu, 12);
  assert.equal(samples[0].rssMb, 34);
  assert.deepEqual(samplesForAgents([{ ...agent, metadata: { ...agent.metadata, processIdentities: { 42: 'reused' } } }], snap, new Map(), now), []);
  assert.deepEqual(samplesForAgents([agent], snap, new Map(), now + 6000), []);
});

test('process controls fail closed when discovery did not capture creation identity', async () => {
  assert.equal(await verifyIntegrationPid({
    id: 'warp', name: 'Warp', vendor: 'Warp', kind: 'desktop',
    installed: true, running: true, pids: [42], lastSeen: now,
  }, 42), false);
});

test('real OS snapshot identifies only the test-owned Pi-shaped Node process', { timeout: 35000 }, async () => {
  const script = write('owned-process/node_modules/@mariozechner/pi-coding-agent/dist/cli.js',
    "process.send('ready'); setInterval(() => {}, 1000);");
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await once(child, 'message');
    const { getProcessSnapshot } = await import('../src/discovery/procSnapshot.js');
    const snap = await getProcessSnapshot(true, 25000);
    const owned = snap.byPid.get(child.pid!);
    assert.ok(snap.ok, 'OS process snapshot must be available');
    assert.ok(owned, 'Test-owned child must be visible');
    assert.equal(matchesIntegrationProcess(get('pi-coding-agent'), owned), true);
    assert.ok(typeof owned.started === 'string' && owned.started);
    const samples = samplesForAgents([{
      id: 'pi-coding-agent', name: 'Pi', vendor: 'Pi', kind: 'cli',
      installed: true, running: true, pids: [owned.pid], lastSeen: snap.ts,
      metadata: { monitoring: integrationMonitoring(get('pi-coding-agent')), processIdentities: { [owned.pid]: owned.started } },
    }], snap);
    assert.equal(samples.length, 1);
    assert.ok(samples[0].rssMb > 0);
    assert.ok(Number.isFinite(samples[0].cpu) && samples[0].cpu >= 0);
  } finally {
    const closed = once(child, 'exit');
    child.kill();
    await closed;
  }
});

test('Pi ingestion survives rescans, prices reported tokens, and preserves saved settings', async () => {
  fixture.reset();
  const pi = REGISTRY.find((item) => item.id === 'pi-coding-agent')!;
  const root = pi.integration!.sessionPaths![0];
  assert.ok(root.startsWith(fixture.directory + path.sep), 'No real sessions may be scanned');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'test.jsonl');
  fs.writeFileSync(file, session());
  const table = [fixture.pricing.DEFAULT_PRICE_TABLE.find((row) => row.pattern === 'gpt-6-astra')!];
  const saved = JSON.stringify(table);
  fixture.setSetting('priceTable', saved);
  fixture.setSetting('costEnabled', 'true');
  for (let i = 0; i < 2; i++) {
    await fixture.tokens.scanTokens();
    await fixture.activity.scanActivity();
  }
  const usage = fixture.db.prepare("SELECT * FROM usage_events WHERE agent_id='pi-coding-agent'").all();
  assert.equal(usage.length, 4);
  const summary = fixture.tokens.getTokenSummary();
  assert.equal(summary.byAgent.find((agent) => agent.agentId === pi.id)?.tokens, 413);
  const cost = summary.cost?.byAgent.find((agent) => agent.agentId === pi.id)?.cost;
  assert.equal(typeof cost, 'number');
  assert.ok(Math.abs(cost! - 0.00503) < Number.EPSILON, 'Reported usage must cost $0.00503 within floating-point precision');
  const activity = fixture.db.prepare("SELECT * FROM activity_events WHERE agent_id='pi-coding-agent'").all();
  assert.equal(activity.length, 3);
  assert.equal(fixture.getSetting('priceTable'), saved);
  assert.equal(fs.readFileSync(file, 'utf8'), session());
  const { getProjectsSummary, invalidateProjectsCache } = await import('../src/projects/index.js');
  invalidateProjectsCache();
  assert.equal((await getProjectsSummary()).projects.filter((project) => project.agents.some((a) => a.agentId === pi.id)).length, 1);
  fs.writeFileSync(path.join(root, 'mac.jsonl'), session('mac-project').replace('C:\\\\Synthetic Project', '/Users/synthetic/Project'));
  invalidateProjectsCache();
  const mac = (await getProjectsSummary()).projects.find((project) => project.path === '/Users/synthetic/Project');
  assert.equal(mac?.name, 'Project');
  await fetch(fixture.url + '/__test/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const agents = listAgents();
  assert.equal(agents.length, 8);
  assert.equal(agents.find((agent) => agent.id === 'pi-coding-agent')?.metadata?.monitoring !== undefined, true);
});

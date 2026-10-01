import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

export async function createPricingFixture(port = 0) {
  const directory = mkdtempSync(path.join(tmpdir(), 'cioppino-pricing-'));
  const keys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
    'PI_CODING_AGENT_DIR', 'GOOSE_PATH_ROOT'] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) process.env[key] = directory;

  // Set the synthetic home before importing any module that opens SQLite.
  const config = await import('../src/config.js');
  assert.ok(config.DB_PATH.startsWith(directory + path.sep), 'Tests must not open the real database');
  const storage = await import('../src/db/index.js');
  const pricing = await import('../src/tokens/pricing.js');
  const tokens = await import('../src/tokens/index.js');
  const activity = await import('../src/activity/index.js');
  const { applySecurityHeaders, disableApiCaching } = await import('../src/security.js');
  const { settingsRouter } = await import('../src/settings.js');
  const { REGISTRY } = await import('../src/discovery/registry.js');
  const { listAgents } = await import('../src/discovery/index.js');
  const { integrationMonitoring } = await import('../src/discovery/expanded.js');
  const { setIntegrationIssues } = await import('../src/discovery/integrationStatus.js');
  const { db, setSetting } = storage;

  function reset() {
    db.exec('DELETE FROM settings; DELETE FROM usage_events; DELETE FROM activity_events; DELETE FROM agents;');
    for (const def of REGISTRY) for (const feature of ['discovery', 'resources', 'access', 'activity'] as const) setIntegrationIssues(def.id, feature, []);
    const now = Date.now();
    const usage = db.prepare(`INSERT INTO usage_events
      (agent_id, ts, model, input_tokens, output_tokens, source)
      VALUES ('synthetic-agent', ?, ?, ?, ?, 'synthetic-fixture')`);
    usage.run(now, 'gpt-4.1', 1_000_000, 1_000_000);
    usage.run(now, 'unknown-future-model', 1_000_000, 0);
    const event = db.prepare(`INSERT INTO activity_events
      (agent_id, session_id, ts, role, model, content, content_preview, source, dedup_key, tokens)
      VALUES ('synthetic-agent', 'pricing-session', ?, ?, ?, 'Synthetic test content',
        'Synthetic test content', 'synthetic-fixture', ?, 1000000)`);
    event.run(now - 1000, 'assistant', 'gpt-4.1', 'known');
    event.run(now, 'user', 'unknown-future-model', 'unknown');
  }
  reset();

  const app = express();
  app.use(applySecurityHeaders);
  app.use('/api', disableApiCaching);
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  app.get('/api/ready', (_req, res) => res.json({ ready: true, steps: [] }));
  app.get('/api/agents', (_req, res) => res.json({ agents: listAgents(), registry: [] }));
  app.post('/__test/agents', (req, res) => {
    const insert = db.prepare(`INSERT OR REPLACE INTO agents
      (id,name,vendor,kind,installed,running,pids,last_seen,metadata) VALUES (?,?,?,?,1,0,'[]',?,?)`);
    for (const def of REGISTRY.filter((item) => item.integration)) {
      insert.run(def.id, def.name, def.vendor, def.kind, Date.now(), JSON.stringify({
        description: def.description, monitoring: integrationMonitoring(def),
      }));
    }
    if (req.body.issue) setIntegrationIssues('zed', 'access', ['A user configuration could not be inspected.']);
    res.json({ ok: true });
  });
  app.get('/api/tokens', (_req, res) => res.json(tokens.getTokenSummary()));
  app.get('/api/activity/stats', (_req, res) => res.json(activity.getActivityStats({})));
  app.get('/api/activity/sessions', (_req, res) => res.json(activity.listActivitySessions({})));
  app.get('/api/activity/sessions/:agent/:session', (req, res) =>
    res.json(activity.getActivitySession(String(req.params.agent), String(req.params.session))));
  app.get('/api/activity', (_req, res) => res.json(activity.listActivity({})));
  app.post('/__test/reset', (req, res) => {
    reset();
    setSetting('costEnabled', 'true');
    if (req.body.custom) setSetting('priceTable', JSON.stringify([{
      pattern: 'gpt-4', label: 'Legacy custom', input: 42, output: 84, cacheWrite: 0, cacheRead: 0,
    }]));
    res.json({ ok: true });
  });
  const dist = fileURLToPath(new URL('../../frontend/dist/', import.meta.url));
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  const server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  let disposed = false;
  function disposeData() {
    if (disposed) return;
    disposed = true;
    db.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }

  return {
    ...storage, pricing, tokens, activity, reset, directory, app, disposeData,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      disposeData();
    },
  };
}

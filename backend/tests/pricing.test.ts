import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createPricingFixture } from './pricing-fixture.js';

const fixture = await createPricingFixture();
const { pricing, db, getSetting, setSetting, tokens, activity, wipeAllData } = fixture;
const { DEFAULT_PRICE_TABLE: defaults, priceFor, costForUsage, parsePriceTable, getPriceSettings, getPricingInfo } = pricing;
after(() => fixture.close());
beforeEach(() => fixture.reset());

test('defaults have unique exact identities and finite nonnegative rates', () => {
  assert.ok(defaults.length >= 60);
  assert.equal(new Set(defaults.map((row) => row.pattern)).size, defaults.length);
  for (const row of defaults) {
    assert.equal(row.match, 'model');
    for (const rate of [row.input, row.output, row.cacheWrite, row.cacheRead]) {
      assert.ok(rate === null || (Number.isFinite(rate) && rate >= 0));
    }
  }
  assert.deepEqual(parsePriceTable(defaults), defaults);
});

test('verified rates and cache columns cover all providers', () => {
  const cases: [string, number, number, number | null, number | null][] = [
    ['claude-opus-5.5', 4, 20, 5, 0.2],
    ['claude-opus-5', 5, 25, 6.25, 0.5],
    ['claude-sonnet-5', 2, 10, 2.5, 0.2],
    ['claude-sonnet-4.6', 3, 15, 3.75, 0.3],
    ['claude-fable-5.1', 10, 50, 12.5, 0.25],
    ['claude-mythos-5.1', 10, 50, 12.5, 0.25],
    ['claude-haiku-4.5', 1, 5, 1.25, 0.1],
    ['gpt-6-astra', 10, 50, 12.5, 1],
    ['gpt-5.6-sol', 4, 20, 5, 0.4],
    ['gpt-5.6-terra', 2, 12, 2.5, 0.2],
    ['gpt-5.6-luna', 0.2, 1.2, 0.25, 0.02],
    ['gpt-5.3-codex', 1.75, 14, null, 0.175],
    ['gpt-5-mini', 0.25, 2, null, 0.025],
    ['gpt-4.1', 2, 8, null, 0.5],
    ['gpt-4o', 2.5, 10, null, 1.25],
    ['gpt-4o-2024-05-13', 5, 15, null, null],
    ['o3', 2, 8, null, 0.5],
    ['o3-mini', 1.1, 4.4, null, 0.55],
    ['o3-pro', 20, 80, null, null],
    ['gemini-3.8-flash', 0.75, 3.75, null, 0.075],
    ['gemini-3.6-flash', 0.75, 3.75, null, 0.075],
    ['gemini-3.5-flash', 1.5, 9, null, 0.15],
    ['gemini-3.5-flash-lite', 0.3, 2.5, null, 0.03],
    ['gemini-3.1-pro-preview', 2, 12, null, 0.2],
    ['gemini-2.5-pro', 1.25, 10, null, 0.125],
    ['gemini-2.5-flash', 0.3, 2.5, null, 0.03],
    ['gemini-2.5-flash-lite', 0.1, 0.4, null, 0.01],
  ];
  for (const [name, ...rates] of cases) {
    const row = priceFor(name, defaults);
    assert.ok(row, name);
    assert.deepEqual([row.input, row.output, row.cacheWrite, row.cacheRead], rates, name);
  }
});

test('known prefixes and version punctuation normalize without broad suffix stripping', () => {
  assert.equal(priceFor('ANTHROPIC/CLAUDE-OPUS-5-5', defaults)?.input, 4);
  assert.equal(priceFor('openai/gpt-4.1', defaults)?.input, 2);
  assert.equal(priceFor('models/gemini-2.5-flash-lite', defaults)?.input, 0.1);
  assert.equal(priceFor('google/gemini-3.1-pro-preview-customtools', defaults)?.input, 2);
  assert.equal(priceFor('claude-haiku-4-5-20251001', defaults)?.input, 1);
  assert.equal(priceFor('claude-opus-4-5-20251101', defaults)?.input, 5);
  assert.equal(priceFor('claude-sonnet-4-5-20250929', defaults)?.input, 3);
  for (const name of [
    'opus', 'sonnet', 'gpt-4', 'codex', 'gemini', 'gpt-5.99', 'gpt-5.6-sol-fast',
    'gpt-4.1-2099-01-01', 'o3-mini-new', 'claude-opus-5.5-preview',
    'gemini-2.5-flash-image', 'gemini-2.5-flash-native-audio', 'unknown/gpt-4.1',
  ]) assert.equal(priceFor(name, defaults), undefined, name);
});

test('cost arithmetic distinguishes unavailable from deliberately free rates', () => {
  assert.equal(costForUsage({
    model: 'claude-opus-5.5', inputTokens: 1e6, outputTokens: 1e6,
    cacheReadTokens: 1e6, cacheCreateTokens: 1e6,
  }, defaults), 29.2);
  assert.equal(costForUsage({ model: 'gpt-4.1', inputTokens: 1e6, outputTokens: 1e6 }, defaults), 10);
  assert.equal(costForUsage({ model: 'unknown', inputTokens: 1e6, outputTokens: 0 }, defaults), null);
  assert.equal(costForUsage({ model: 'free', inputTokens: 1e6, outputTokens: 0 }, [{
    pattern: 'free', label: 'Free', input: 0, output: 0, cacheWrite: null, cacheRead: null,
  }]), 0);
});

test('saved custom rules preserve ordering and an empty table stays empty', () => {
  const table = [
    { pattern: 'GPT-4', label: 'Custom', input: 42, output: 84, cacheWrite: 0, cacheRead: 0 },
    defaults.find((row) => row.pattern === 'gpt-4.1')!,
  ];
  setSetting('priceTable', JSON.stringify(table));
  assert.deepEqual(getPriceSettings().priceTable, table);
  assert.equal(priceFor('gpt-4.1', pricing.getPriceTable())?.input, 42);
  setSetting('priceTable', '[]');
  assert.deepEqual(pricing.getPriceTable(), []);
  assert.equal(getPriceSettings().customPriceTable, true);
});

test('invalid tables produce explicit errors rather than silent defaults', () => {
  for (const value of [
    null, {}, [{ ...defaults[0], input: -1 }], [{ ...defaults[0], output: NaN }],
    [{ ...defaults[0], cacheRead: Infinity }], [{ ...defaults[0], pattern: '' }],
    [{ ...defaults[0], match: 'regex' }],
  ]) assert.throws(() => parsePriceTable(value), TypeError);
  setSetting('priceTable', '{broken-json');
  const original = console.error;
  const errors: string[] = [];
  console.error = (message: string) => errors.push(message);
  try {
    const result = getPriceSettings();
    assert.deepEqual(result.priceTable, []);
    assert.ok('priceTableError' in result && result.priceTableError);
    assert.equal(errors.length, 1);
    assert.ok(!errors[0].includes('broken-json'));
    assert.equal(getSetting('priceTable'), '{broken-json');
  } finally {
    console.error = original;
  }
});

test('security headers protect local API responses', async () => {
  const response = await fetch(`${fixture.url}/api/ready`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy') || '', /connect-src 'self'/);
});

test('wipe removes every persisted application data category', () => {
  db.prepare("INSERT INTO agents (id,name,installed,running) VALUES ('wipe-agent','Wipe',1,0)").run();
  db.prepare("INSERT INTO access_items (agent_id,category,label) VALUES ('wipe-agent','folder','Synthetic')").run();
  db.prepare("INSERT INTO perf_samples (agent_id,ts) VALUES ('wipe-agent',?)").run(Date.now());
  db.prepare('INSERT INTO gpu_samples (ts) VALUES (?)').run(Date.now());
  db.prepare(`INSERT INTO downloads
    (dedup_key,agent_id,ts,kind,manager,name,status)
    VALUES ('wipe-download','wipe-agent',?,'package','npm','synthetic','observed')`).run(Date.now());
  db.prepare("INSERT INTO scan_state (scanner,path,mtime_ms,size) VALUES ('wipe','synthetic',1,1)").run();
  setSetting('wipe-test', 'sensitive');

  wipeAllData();

  for (const table of [
    'agents', 'access_items', 'usage_events', 'perf_samples', 'gpu_samples',
    'settings', 'activity_events', 'downloads', 'scan_state',
  ]) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    assert.equal(row.count, 0, table);
  }
});

test('review warnings use UTC date boundaries without changing rates', () => {
  const before = getPricingInfo(Date.parse('2026-11-21T23:59:59Z'));
  const first = getPricingInfo(Date.parse('2026-11-22T00:00:00Z'));
  const second = getPricingInfo(Date.parse('2027-01-01T00:00:00Z'));
  assert.deepEqual(before.reviews.map((r) => r.due), [false, false]);
  assert.deepEqual(first.reviews.map((r) => r.due), [true, false]);
  assert.deepEqual(second.reviews.map((r) => r.due), [true, true]);
  assert.equal(priceFor('gemini-3.8-flash', defaults)?.input, 0.75);
});

test('Settings API round-trips modes, null cache rates, overrides and empty tables', async () => {
  const save = (body: unknown) => fetch(`${fixture.url}/api/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const read = async () => (await fetch(`${fixture.url}/api/settings`)).json();
  assert.equal((await read()).costEnabled, false);
  assert.equal((await save({ priceTable: defaults, costEnabled: true })).status, 200);
  assert.deepEqual((await read()).priceTable, defaults);
  const raw = getSetting('priceTable');
  await save({ scanIntervalSec: 90 });
  assert.equal(getSetting('priceTable'), raw);
  const invalid = await save({ priceTable: [{ ...defaults[0], input: -1 }], costEnabled: false });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /nonnegative/);
  assert.equal(getSetting('costEnabled'), 'true', 'Reject before any settings writes');
  await save({ priceTable: [] });
  assert.deepEqual((await read()).priceTable, []);
});

test('Tokens and Activity consistently exclude unpriced usage and use current rates', () => {
  assert.equal(tokens.getTokenSummary().costEnabled, false);
  assert.equal(activity.listActivitySessions({}).costEnabled, false);
  setSetting('costEnabled', 'true');
  const cost = tokens.getTokenSummary().cost!;
  assert.equal(cost.total, 10);
  assert.equal(cost.pricedTokens, 2e6);
  assert.equal(cost.unpricedTokens, 1e6);
  const session = activity.listActivitySessions({}).sessions[0];
  const detail = activity.getActivitySession('synthetic-agent', 'pricing-session');
  assert.equal(session.cost, 8);
  assert.equal(session.unpricedTokens, 1e6);
  assert.equal(detail.summary?.cost, session.cost);
  assert.equal(detail.summary?.unpricedTokens, session.unpricedTokens);
  assert.equal(detail.events.find((e) => e.model === 'unknown-future-model')?.cost, null);
  setSetting('priceTable', '[]');
  assert.equal(activity.listActivitySessions({}).sessions[0].cost, null);
  assert.equal(tokens.getTokenSummary().cost?.unpricedTokens, 3e6);
});

test('pricing reads never write a table or enable cost estimation automatically', () => {
  for (let i = 0; i < 3; i++) {
    pricing.getPriceTable();
    getPriceSettings();
  }
  assert.equal(getSetting('priceTable'), undefined);
  assert.equal(getSetting('costEnabled'), undefined);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM settings').get());
});

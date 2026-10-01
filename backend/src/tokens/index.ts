// Token usage scanner + summary. Pure volume tracking; no pricing.
//
// Walks every agent's log paths (and Codex's state SQLite), parses
// usage events out of JSONL / regex / markdown / SQLite, dedupes
// streaming snapshots, and persists to `usage_events`.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { REGISTRY } from '../discovery/registry.js';
import { db, getSetting, isFileUnchanged, recordFileScanned } from '../db/index.js';
import { costForUsage, getPriceTable, isCostEnabled, PriceEntry } from './pricing.js';
import { readPiSessions } from '../activity/pi.js';
import { setIntegrationIssues } from '../discovery/integrationStatus.js';

export interface UsageEvent {
  agentId: string;
  ts: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  source: string;
  /** Project derived from source path (best-effort). */
  project?: string;
  /** Anthropic message.id when present — enables exact dedupe of streaming snapshots. */
  messageId?: string;
}

// Rough char→token estimator (~4 chars per token for English text).
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Derive a friendly project name from a source path. Examples:
 *   ~/.claude/projects/<slug>/session.jsonl → "<slug>" (with slashes → dashes)
 *   any path under .../projects/<slug>/...   → "<slug>"
 *   anything else → undefined (caller buckets as "Unknown")
 */
function projectFromSource(source: string): string | undefined {
  // Strip `#N` line suffix or `msg:` / `codex-thread:` synthetic prefixes
  if (!source) return undefined;
  if (source.startsWith('msg:') || source.startsWith('codex-thread:') || source.startsWith('copilot-session:')) {
    return undefined;
  }
  const norm = source.replace(/\\/g, '/').replace(/#\d+$/, '');
  const m = norm.match(/\/(?:projects|workspaces|workspace)\/([^/]+)/i);
  if (m && m[1]) return m[1].replace(/-/g, ' ').trim() || undefined;
  return undefined;
}

export async function scanTokens(): Promise<{ inserted: number }> {
  const events: UsageEvent[] = [];

  // Incremental guard: parse a file only if it's new or changed since the last
  // scan. Skipped files keep their existing rows because the persist step below
  // only deletes-and-reinserts sources we actually re-collected this run.
  const parseIfChanged = (file: string, parse: () => UsageEvent[]) => {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { return; }
    if (isFileUnchanged('tokens', file, st.mtimeMs, st.size)) return;
    try {
      events.push(...parse());
      recordFileScanned('tokens', file, st.mtimeMs, st.size);
    } catch {}
  };

  for (const def of REGISTRY) {
    if (def.integration) {
      if (def.integration.activity === 'pi') {
        const data = readPiSessions(def.integration.sessionPaths ?? []);
        events.push(...data.usage);
        setIntegrationIssues(def.id, 'activity', data.issues);
      }
      continue;
    }
    if (def.logPaths) {
      for (const lp of def.logPaths) {
        if (!fs.existsSync(lp)) continue;
        try {
          if (fs.statSync(lp).isFile()) {
            parseIfChanged(lp, () => parseFile(def.id, lp));
          } else {
            await walkFiles(lp, 4, (f) => { parseIfChanged(f, () => parseFile(def.id, f)); });
          }
        } catch {}
      }
    }
    // Codex CLI: thread totals live in state SQLite.
    if (def.id === 'codex-cli') {
      const root = def.configPaths?.[0];
      if (root && fs.existsSync(root)) {
        for (const f of fs.readdirSync(root)) {
          if (/^state.*\.sqlite$/.test(f)) {
            const full = path.join(root, f);
            parseIfChanged(full, () => parseCodexSqlite(def.id, full));
          }
        }
      }
    }
    await yieldToLoop();
  }

  // Stage 1: exact dedupe by Anthropic `message.id` — streaming snapshots
  // of the same message share that id. Keep the highest-token snapshot.
  const byMsgId = new Map<string, UsageEvent>();
  const noMsgId: UsageEvent[] = [];
  for (const e of events) {
    if (!e.messageId) { noMsgId.push(e); continue; }
    const key = `${e.agentId}::${e.messageId}`;
    const prev = byMsgId.get(key);
    const total = (e.inputTokens || 0) + (e.outputTokens || 0) + (e.cacheReadTokens || 0) + (e.cacheCreateTokens || 0);
    const prevTotal = prev
      ? (prev.inputTokens || 0) + (prev.outputTokens || 0) + (prev.cacheReadTokens || 0) + (prev.cacheCreateTokens || 0)
      : -1;
    if (!prev || total > prevTotal) byMsgId.set(key, e);
  }
  const msgDeduped: UsageEvent[] = Array.from(byMsgId.values()).map((e) => ({
    ...e,
    source: `msg:${e.messageId}`,
  }));

  // Stage 2: heuristic per-file dedupe for events without a message id.
  // Many provider logs emit cumulative usage blocks per streaming chunk;
  // summing them inflates totals 10–100×.
  const collapsed: UsageEvent[] = [...msgDeduped];
  const byFile = new Map<string, UsageEvent[]>();
  for (const e of noMsgId) {
    const file = e.source.includes('#') ? e.source.slice(0, e.source.lastIndexOf('#')) : e.source;
    const key = `${e.agentId}::${file}`;
    const list = byFile.get(key) ?? [];
    list.push(e);
    byFile.set(key, list);
  }
  for (const [, list] of byFile) {
    if (list.length <= 1) { collapsed.push(...list); continue; }
    const totals = list.map((e) => e.inputTokens + e.outputTokens);
    let monotonic = true;
    for (let i = 1; i < totals.length; i++) {
      if (totals[i] < totals[i - 1]) { monotonic = false; break; }
    }
    const sorted = [...totals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1;
    const max = sorted[sorted.length - 1];
    const cumulative = monotonic || max > median * 10;
    if (!cumulative) { collapsed.push(...list); continue; }
    const winner = list.reduce((a, b) =>
      a.inputTokens + a.outputTokens >= b.inputTokens + b.outputTokens ? a : b,
    );
    collapsed.push({
      ...winner,
      source: winner.source.includes('#')
        ? winner.source.slice(0, winner.source.lastIndexOf('#'))
        : winner.source,
    });
  }

  // Persist: delete prior rows for each source, then insert. Wrap in a
  // transaction so `/api/tokens` reads never see the empty mid-state.
  const sources = new Set(collapsed.map((e) => `${e.agentId}::${e.source}`));
  const delPrefixStmt = db.prepare(
    "DELETE FROM usage_events WHERE agent_id=? AND (source=? OR source LIKE ?)",
  );
  const ins = db.prepare(
    'INSERT INTO usage_events (agent_id,ts,model,input_tokens,output_tokens,cache_read_tokens,cache_create_tokens,cost_usd,estimated,message_id,source,project) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const s of sources) {
      const [agentId, source] = s.split('::');
      delPrefixStmt.run(agentId, source, `${source}#%`);
    }
    for (const e of collapsed) {
      ins.run(
        e.agentId,
        e.ts,
        e.model ?? null,
        e.inputTokens,
        e.outputTokens,
        e.cacheReadTokens ?? 0,
        e.cacheCreateTokens ?? 0,
        0, // cost_usd: column kept for schema compat, no longer used
        1, // estimated flag legacy
        e.messageId ?? null,
        e.source,
        e.project ?? null,
      );
      inserted++;
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
  return { inserted };
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
  } catch { return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      await walkFiles(full, maxDepth, fn, depth + 1, counter);
    } else if (e.isFile()) {
      try {
        const stat = fs.statSync(full);
        if (stat.size > 200 * 1024 * 1024) continue;
        if (!/\.(jsonl?|md|log|txt)$/i.test(e.name)) continue;
        fn(full);
        if (++counter.n % 15 === 0) await yieldToLoop();
      } catch {}
    }
  }
}

function parseFile(agentId: string, file: string): UsageEvent[] {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1024);
    fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    head = buf.toString('utf8');
  } catch { return []; }
  if (/\.jsonl$/i.test(file) && /"type"\s*:\s*"session\.start"/.test(head)) {
    return parseCopilotEvents(agentId, file);
  }
  if (/\.jsonl$/i.test(file)) {
    return parseUsageJsonl(agentId, file);
  }
  if (/\.md$/i.test(file) && /aider|chat|history/i.test(file)) {
    return parseAiderMarkdown(agentId, file);
  }
  return parseUsageRegex(agentId, file);
}

// Copilot CLI events.jsonl: char-based estimate from message content.
function parseCopilotEvents(agentId: string, file: string): UsageEvent[] {
  let content: string;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const lines = content.split(/\r?\n/);
  let sessionId: string | undefined;
  let model: string | undefined;
  let startTs = fs.statSync(file).mtimeMs;
  let lastTs = startTs;
  let inputChars = 0;
  let outputChars = 0;

  for (const line of lines) {
    if (!line) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const t = obj.type;
    const data = obj.data || {};
    if (obj.timestamp) {
      const ms = new Date(obj.timestamp).getTime();
      if (!isNaN(ms)) lastTs = ms;
    }
    if (t === 'session.start') {
      sessionId = data.sessionId || sessionId;
      if (obj.timestamp) {
        const m = new Date(obj.timestamp).getTime();
        if (!isNaN(m)) startTs = m;
      }
    } else if (t === 'session.model_change') {
      model = data.newModel || data.model || model;
    } else if (t === 'user.message' || t === 'system.message') {
      const c = typeof data.content === 'string' ? data.content : JSON.stringify(data.content || '');
      inputChars += c.length;
    } else if (t === 'tool.execution_complete') {
      // Cap tool results to 4 KB so a single huge dump doesn't dominate.
      const c = JSON.stringify(data.result || '');
      inputChars += Math.min(c.length, 4_000);
    } else if (t === 'assistant.message') {
      const c = typeof data.content === 'string' ? data.content : '';
      outputChars += c.length;
      if (Array.isArray(data.toolRequests)) {
        for (const tr of data.toolRequests) outputChars += JSON.stringify(tr.arguments || {}).length;
      }
    }
  }

  if (inputChars === 0 && outputChars === 0) return [];
  const inputTokens = Math.ceil(inputChars / 4);
  const outputTokens = Math.ceil(outputChars / 4);
  const source = sessionId ? `copilot-session:${sessionId}` : file;
  return [{
    agentId,
    ts: lastTs || startTs,
    model,
    inputTokens,
    outputTokens,
    source,
    project: projectFromSource(file), // use the on-disk file path for project hint
  }];
}

function parseUsageJsonl(agentId: string, file: string): UsageEvent[] {
  const events: UsageEvent[] = [];
  let content: string;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return events; }
  const baseTs = fs.statSync(file).mtimeMs;
  const project = projectFromSource(file);
  const lines = content.split(/\r?\n/);
  let i = 0;
  for (const line of lines) {
    if (!line.trim()) { i++; continue; }
    try {
      const obj = JSON.parse(line);
      const usage = obj.usage || obj.message?.usage || obj.response?.usage;
      if (usage) {
        const inT = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? 0;
        const outT = usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? 0;
        const cacheRead =
          usage.cache_read_input_tokens ??
          usage.cacheReadInputTokens ??
          usage.cache_read_tokens ??
          0;
        const cc = usage.cache_creation || usage.cacheCreation || {};
        const cacheCreate =
          (cc.ephemeral_5m_input_tokens ?? cc.ephemeral5mInputTokens ?? 0) +
          (cc.ephemeral_1h_input_tokens ?? cc.ephemeral1hInputTokens ?? 0) +
          (usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0);
        const model = obj.model || obj.message?.model || obj.response?.model;
        const messageId = obj.message?.id || obj.id || undefined;
        const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : baseTs;
        events.push({
          agentId,
          ts: isNaN(ts) ? baseTs : ts,
          model,
          inputTokens: inT,
          outputTokens: outT,
          cacheReadTokens: cacheRead,
          cacheCreateTokens: cacheCreate,
          messageId,
          source: `${file}#${i}`,
          project,
        });
      }
    } catch {}
    i++;
  }
  return events;
}

function parseAiderMarkdown(agentId: string, file: string): UsageEvent[] {
  let content: string;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const baseTs = fs.statSync(file).mtimeMs;
  const userParts = content.match(/^####\s+.+$([\s\S]*?)(?=^####|\Z)/gm) || [];
  const totalIn = userParts.reduce((s, p) => s + estimateTokens(p), 0);
  const totalOut = Math.round(totalIn * 0.6);
  if (totalIn === 0) return [];
  return [{
    agentId,
    ts: baseTs,
    inputTokens: totalIn,
    outputTokens: totalOut,
    source: file,
    project: projectFromSource(file),
  }];
}

function parseUsageRegex(agentId: string, file: string): UsageEvent[] {
  let content: string;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const baseTs = fs.statSync(file).mtimeMs;
  const project = projectFromSource(file);
  const events: UsageEvent[] = [];
  const usageRe = /"usage"\s*:\s*\{([^}]+)\}/g;
  const modelRe = /"model"\s*:\s*"([^"]+)"/;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = usageRe.exec(content))) {
    const block = m[1];
    const inMatch = /"(?:input|prompt)_tokens"\s*:\s*(\d+)/.exec(block);
    const outMatch = /"(?:output|completion)_tokens"\s*:\s*(\d+)/.exec(block);
    if (!inMatch && !outMatch) continue;
    const modelMatch = modelRe.exec(content.slice(Math.max(0, m.index - 400), m.index + 200));
    const model = modelMatch?.[1];
    const inT = inMatch ? parseInt(inMatch[1], 10) : 0;
    const outT = outMatch ? parseInt(outMatch[1], 10) : 0;
    events.push({
      agentId,
      ts: baseTs,
      model,
      inputTokens: inT,
      outputTokens: outT,
      source: `${file}#${idx++}`,
      project,
    });
  }
  return events;
}

function parseCodexSqlite(agentId: string, dbPath: string): UsageEvent[] {
  const events: UsageEvent[] = [];
  const ratioRaw = parseFloat(getSetting('codexInputRatio') || '0.7');
  const inputRatio = Number.isFinite(ratioRaw) && ratioRaw >= 0 && ratioRaw <= 1 ? ratioRaw : 0.7;
  try {
    const sdb = new DatabaseSync(dbPath, { readOnly: true });
    let rows: any[] = [];
    try {
      rows = sdb
        .prepare('SELECT id, model, tokens_used, created_at_ms, updated_at_ms FROM threads WHERE tokens_used > 0')
        .all() as any[];
    } catch {}
    for (const r of rows) {
      const total = Number(r.tokens_used) || 0;
      if (total <= 0) continue;
      const inputTokens = Math.round(total * inputRatio);
      const outputTokens = total - inputTokens;
      const ts = Number(r.updated_at_ms || r.created_at_ms) || fs.statSync(dbPath).mtimeMs;
      events.push({
        agentId,
        ts,
        model: r.model || undefined,
        inputTokens,
        outputTokens,
        source: `codex-thread:${r.id}`,
      });
    }
    sdb.close();
  } catch {}
  return events;
}

// ===== Summary API ==========================================================

export interface TokenTip {
  category: 'cache' | 'concentration' | 'right-size';
  title: string;
  body: string;
}

export interface CostBreakdown {
  total: number;
  pricedTokens: number;
  unpricedTokens: number;
  byAgent: { agentId: string; cost: number }[];
  byModel: { model: string; cost: number }[];
  byProject: { project: string; cost: number }[];
  series: { date: string; cost: number }[];
}

export interface TokenSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreateTokens: number;
  totalTokens: number;
  cacheHitRate: number;
  byAgent: { agentId: string; tokens: number }[];
  byModel: { model: string; tokens: number }[];
  byProject: { project: string; tokens: number }[];
  series: { date: string; input: number; output: number; cacheRead: number; cacheCreate: number; total: number }[];
  /** Tokens by hour-of-day (0–23), summed over the range. */
  hourly: { hour: number; total: number }[];
  /** Distinct model names present in range, for the filter dropdown. */
  models: string[];
  tips: TokenTip[];
  /** True when cost estimation is enabled in Settings. */
  costEnabled: boolean;
  /** Cost aggregates — only present when costEnabled. */
  cost?: CostBreakdown;
}

export function getTokenSummary(rangeDays = 30, modelFilter?: string): TokenSummary {
  const since = Date.now() - rangeDays * 86400_000;

  // Build an optional model filter applied uniformly to every query.
  const hasFilter = !!modelFilter && modelFilter !== 'all';
  const modelClause = hasFilter
    ? modelFilter === 'unknown'
      ? ' AND model IS NULL'
      : ' AND model = ?'
    : '';
  const baseParams: any[] = hasFilter && modelFilter !== 'unknown' ? [since, modelFilter] : [since];

  const total = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens),0) as i, COALESCE(SUM(output_tokens),0) as o, COALESCE(SUM(cache_read_tokens),0) as cr, COALESCE(SUM(cache_create_tokens),0) as cc FROM usage_events WHERE ts >= ?${modelClause}`,
    )
    .get(...baseParams) as any;
  const byAgent = db
    .prepare(
      `SELECT agent_id as agentId, COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_create_tokens),0) as tokens FROM usage_events WHERE ts >= ?${modelClause} GROUP BY agent_id ORDER BY tokens DESC`,
    )
    .all(...baseParams) as { agentId: string; tokens: number }[];
  const byModel = db
    .prepare(
      `SELECT COALESCE(model,'unknown') as model, COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_create_tokens),0) as tokens FROM usage_events WHERE ts >= ?${modelClause} GROUP BY model ORDER BY tokens DESC`,
    )
    .all(...baseParams) as { model: string; tokens: number }[];

  const series = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') as date,
              COALESCE(SUM(input_tokens),0)        as input,
              COALESCE(SUM(output_tokens),0)       as output,
              COALESCE(SUM(cache_read_tokens),0)   as cacheRead,
              COALESCE(SUM(cache_create_tokens),0) as cacheCreate
       FROM usage_events WHERE ts >= ?${modelClause} GROUP BY date ORDER BY date`,
    )
    .all(...baseParams) as any[];
  for (const r of series) r.total = r.input + r.output + r.cacheRead + r.cacheCreate;

  // Tokens by hour-of-day (0–23), summed across the whole range.
  const hourRows = db
    .prepare(
      `SELECT CAST(strftime('%H', ts/1000, 'unixepoch') AS INTEGER) as hour,
              COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_create_tokens),0) as total
       FROM usage_events WHERE ts >= ?${modelClause} GROUP BY hour`,
    )
    .all(...baseParams) as { hour: number; total: number }[];
  const hourMap = new Map<number, number>(hourRows.map((r) => [r.hour, r.total]));
  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, total: hourMap.get(h) || 0 }));

  // Distinct models present in the (unfiltered) range, for the filter dropdown.
  const models = (
    db
      .prepare(
        "SELECT DISTINCT COALESCE(model,'unknown') as model FROM usage_events WHERE ts >= ? ORDER BY model",
      )
      .all(since) as { model: string }[]
  ).map((r) => r.model);

  // Per-project: stored as a real column; NULL/empty bucket as "Unknown".
  const projectRows = db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(project),''),'Unknown') as project,
              COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_create_tokens),0) as tokens
       FROM usage_events WHERE ts >= ?${modelClause} GROUP BY project ORDER BY tokens DESC`,
    )
    .all(...baseParams) as { project: string; tokens: number }[];
  const byProject = projectRows.filter((r) => r.tokens > 0);

  // Optional cost estimation (off by default). Cost depends on the model, so we
  // group every dimension by model, price each group, then aggregate.
  const costEnabled = isCostEnabled();
  let cost: CostBreakdown | undefined;
  if (costEnabled) {
    cost = computeCost(since, modelClause, baseParams, getPriceTable());
  }

  const totalCacheRead = total.cr || 0;
  const totalCacheCreate = total.cc || 0;
  const cacheDenominator = totalCacheRead + totalCacheCreate + (total.i || 0);
  const cacheHitRate = cacheDenominator > 0 ? totalCacheRead / cacheDenominator : 0;
  const totalTokens = (total.i || 0) + (total.o || 0) + totalCacheRead + totalCacheCreate;

  // Tips
  const tips: TokenTip[] = [];
  if (cacheDenominator > 100_000 && cacheHitRate > 0 && cacheHitRate < 0.4) {
    tips.push({
      category: 'cache',
      title: `Low cache hit rate: ${(cacheHitRate * 100).toFixed(0)}%`,
      body:
        'Most input is being re-sent fresh instead of cached. Longer-lived sessions or fewer context resets would let the prompt cache pay off.',
    });
  }
  if (byAgent.length > 0 && totalTokens > 0) {
    const top = byAgent[0];
    if (top.tokens > totalTokens * 0.7) {
      tips.push({
        category: 'concentration',
        title: `${top.agentId} is ${((top.tokens / totalTokens) * 100).toFixed(0)}% of all tokens`,
        body: 'A single agent dominates usage. Worth checking whether tasks are routed to the right tool.',
      });
    }
  }
  const opusUsage = byModel.find((m) => /opus/i.test(m.model));
  if (opusUsage && opusUsage.tokens > 200_000) {
    const opusSplit = db
      .prepare("SELECT COALESCE(SUM(output_tokens),0) as o, COALESCE(SUM(input_tokens),0) as i FROM usage_events WHERE ts >= ? AND model LIKE '%opus%'")
      .get(since) as any;
    if (opusSplit.i > 0 && opusSplit.o > 0 && opusSplit.o < opusSplit.i * 0.05) {
      tips.push({
        category: 'right-size',
        title: 'Opus turns are mostly short — Sonnet might do',
        body: 'Output averages under 5% of input on Opus. For routine work, Sonnet is nearly as capable on coding tasks.',
      });
    }
  }

  return {
    totalInputTokens: total.i || 0,
    totalOutputTokens: total.o || 0,
    totalCacheReadTokens: totalCacheRead,
    totalCacheCreateTokens: totalCacheCreate,
    totalTokens,
    cacheHitRate,
    byAgent,
    byModel,
    byProject,
    series,
    hourly,
    models,
    tips,
    costEnabled,
    cost,
  };
}

/**
 * Compute cost aggregates by grouping each dimension on model, pricing every
 * group, then summing. Honors the same time range + model filter as the summary.
 */
function computeCost(
  since: number,
  modelClause: string,
  baseParams: any[],
  table: PriceEntry[],
): CostBreakdown {
  const rows = db
    .prepare(
      `SELECT agent_id as agentId,
              COALESCE(NULLIF(TRIM(project),''),'Unknown') as project,
              strftime('%Y-%m-%d', ts/1000, 'unixepoch') as date,
              model,
              COALESCE(SUM(input_tokens),0)        as input,
              COALESCE(SUM(output_tokens),0)       as output,
              COALESCE(SUM(cache_read_tokens),0)   as cacheRead,
              COALESCE(SUM(cache_create_tokens),0) as cacheCreate
       FROM usage_events WHERE ts >= ?${modelClause}
       GROUP BY agent_id, project, date, model`,
    )
    .all(...baseParams) as any[];

  let total = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  const agentMap = new Map<string, number>();
  const modelMap = new Map<string, number>();
  const projectMap = new Map<string, number>();
  const dateMap = new Map<string, number>();

  for (const r of rows) {
    const c = costForUsage(
      {
        model: r.model,
        inputTokens: r.input,
        outputTokens: r.output,
        cacheReadTokens: r.cacheRead,
        cacheCreateTokens: r.cacheCreate,
      },
      table,
    );
    const tokens = r.input + r.output + r.cacheRead + r.cacheCreate;
    if (c === null) {
      unpricedTokens += tokens;
      continue;
    }
    pricedTokens += tokens;
    total += c;
    agentMap.set(r.agentId, (agentMap.get(r.agentId) || 0) + c);
    const mKey = r.model || 'unknown';
    modelMap.set(mKey, (modelMap.get(mKey) || 0) + c);
    projectMap.set(r.project, (projectMap.get(r.project) || 0) + c);
    dateMap.set(r.date, (dateMap.get(r.date) || 0) + c);
  }

  const sortDesc = (m: Map<string, number>) =>
    Array.from(m.entries()).sort((a, b) => b[1] - a[1]);

  return {
    total,
    pricedTokens,
    unpricedTokens,
    byAgent: sortDesc(agentMap).map(([agentId, cost]) => ({ agentId, cost })),
    byModel: sortDesc(modelMap).map(([model, cost]) => ({ model, cost })),
    byProject: sortDesc(projectMap).map(([project, cost]) => ({ project, cost })),
    series: Array.from(dateMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, cost]) => ({ date, cost })),
  };
}

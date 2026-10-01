import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { db, isFileUnchanged, recordFileScanned } from '../db/index.js';
import { REGISTRY } from '../discovery/registry.js';
import { isCostEnabled, getPriceTable, costForUsage, PriceEntry } from '../tokens/pricing.js';
import { readPiSessions } from './pi.js';
import { setIntegrationIssues } from '../discovery/integrationStatus.js';

export type ActivityRole = 'user' | 'assistant' | 'system' | 'tool';

// Read-only session-status inference thresholds (tunable).
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;        // last event newer than this => active
const STALE_WINDOW_MS = 24 * 60 * 60 * 1000;   // older than this => stale

export type SessionStatus = 'active' | 'waiting' | 'idle' | 'stale';

// Matches assistant messages that appear to be awaiting a human decision.
const WAITING_PROMPT_RE =
  /\b(y\/n|yes\/no|proceed\?|continue\?|confirm|which option|would you like|shall i|do you want|should i|may i|let me know)\b/i;

/**
 * Infer a read-only session status from the last event. `waiting` (the
 * "needs-you" signal) only fires for a recent assistant message that looks like
 * it is asking the user something — never for stale sessions.
 */
export function deriveStatus(
  lastTs: number,
  lastRole: ActivityRole,
  lastPreview: string,
  now: number = Date.now(),
): { status: SessionStatus; needsAttention: boolean } {
  const age = now - lastTs;
  if (age > STALE_WINDOW_MS) return { status: 'stale', needsAttention: false };
  const p = (lastPreview || '').trim();
  const looksLikeQuestion =
    lastRole === 'assistant' && (/[?？]\s*$/.test(p) || WAITING_PROMPT_RE.test(p));
  if (looksLikeQuestion) return { status: 'waiting', needsAttention: true };
  if (age <= ACTIVE_WINDOW_MS) return { status: 'active', needsAttention: false };
  return { status: 'idle', needsAttention: false };
}

export interface ActivityEvent {
  agentId: string;
  sessionId?: string;
  ts: number;
  role: ActivityRole;
  content: string;
  model?: string;
  source: string;
  audio?: boolean;
}

const MAX_CONTENT_CHARS = 100_000;
const PREVIEW_CHARS = 240;
const MAX_FILE_BYTES = 80 * 1024 * 1024;

// Heuristic: returns true only when the payload contains an unambiguous
// audio blob (base64-encoded `data:audio/...` URI). Earlier versions matched
// loose strings like `"type":"audio"` or `audio_url`, but those are also
// present in source code, API docs, and assistant responses about audio APIs
// — so plain text messages were being mis-flagged. Real voice integrations
// (OpenAI Realtime, Whisper transcripts, Gemini audio) embed the binary blob,
// which is the only signal we can rely on without false positives.
function detectAudio(body: string): boolean {
  if (!body) return false;
  if (body.length > 2_000_000) body = body.slice(0, 2_000_000);
  return /data:audio\/(?:mp3|wav|ogg|webm|m4a|opus|mpeg|aac|flac)[^"'\s]*;base64,/i.test(body);
}

function clampContent(s: string): string {
  if (s.length <= MAX_CONTENT_CHARS) return s;
  return s.slice(0, MAX_CONTENT_CHARS) + `\n…[truncated ${s.length - MAX_CONTENT_CHARS} chars]`;
}

function preview(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= PREVIEW_CHARS ? oneLine : oneLine.slice(0, PREVIEW_CHARS) + '…';
}

function dedupKey(e: ActivityEvent): string {
  const h = crypto.createHash('sha1');
  h.update(e.agentId);
  h.update('|');
  h.update(e.source);
  h.update('|');
  h.update(String(e.ts));
  h.update('|');
  h.update(e.role);
  h.update('|');
  h.update(e.content.slice(0, 4096));
  return h.digest('hex');
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
      await walkFiles(full, maxDepth, fn, depth + 1, counter);
    } else if (e.isFile()) {
      try {
        const stat = fs.statSync(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        fn(full);
        // Yield every so often so heavy read+parse work doesn't pin the event
        // loop and stall /api/ready and the app's own API calls during a scan.
        if (++counter.n % 15 === 0) await yieldToLoop();
      } catch {}
    }
  }
}

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parseCopilotEvents(agentId: string, file: string): ActivityEvent[] {
  const content = safeRead(file);
  if (!content) return [];
  const events: ActivityEvent[] = [];
  let sessionId: string | undefined;
  let model: string | undefined;
  const baseTs = fs.statSync(file).mtimeMs;
  let i = 0;
  for (const line of content.split(/\r?\n/)) {
    i++;
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() || baseTs : baseTs;
    const t = obj.type;
    const data = obj.data || {};
    if (t === 'session.start') {
      sessionId = data.sessionId || sessionId;
      model = data.model || model;
      continue;
    }
    if (t === 'session.model_change') {
      model = data.newModel || data.model || model;
      continue;
    }
    let role: ActivityRole | null = null;
    let body = '';
    if (t === 'user.message') {
      role = 'user';
      body = typeof data.content === 'string' ? data.content : JSON.stringify(data.content || '');
    } else if (t === 'system.message') {
      role = 'system';
      body = typeof data.content === 'string' ? data.content : JSON.stringify(data.content || '');
    } else if (t === 'assistant.message') {
      role = 'assistant';
      body = typeof data.content === 'string' ? data.content : JSON.stringify(data.content || '');
      if (Array.isArray(data.toolRequests) && data.toolRequests.length) {
        body +=
          '\n\n[tool calls]\n' +
          data.toolRequests
            .map((tr: any) => `• ${tr.name || 'tool'} ${JSON.stringify(tr.arguments || {})}`)
            .join('\n');
      }
    } else if (t === 'tool.execution_complete') {
      role = 'tool';
      const name = data.toolName || data.name || 'tool';
      const result = typeof data.result === 'string' ? data.result : JSON.stringify(data.result || '');
      body = `${name}\n${result}`;
    }
    if (!role || !body.trim()) continue;
    // Detect audio against the original raw payload too — covers cases where
    // toolRequests appended `[tool calls]` text and made the body look textual.
    const audio = detectAudio(body) || detectAudio(JSON.stringify(data || ''));
    events.push({
      agentId,
      sessionId,
      ts,
      role,
      content: clampContent(body),
      model,
      source: `${file}#${i}`,
      audio,
    });
  }
  return events;
}

function parseClaudeJsonl(agentId: string, file: string): ActivityEvent[] {
  const content = safeRead(file);
  if (!content) return [];
  const events: ActivityEvent[] = [];
  const baseTs = fs.statSync(file).mtimeMs;
  const sessionId = path.basename(file).replace(/\.jsonl?$/i, '');
  let i = 0;
  for (const line of content.split(/\r?\n/)) {
    i++;
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() || baseTs : baseTs;
    const msg = obj.message || obj;
    const role = (msg.role || obj.type || '').toLowerCase();
    let mappedRole: ActivityRole | null = null;
    if (role === 'user' || role === 'human') mappedRole = 'user';
    else if (role === 'assistant') mappedRole = 'assistant';
    else if (role === 'system') mappedRole = 'system';
    else if (role === 'tool' || role === 'tool_result') mappedRole = 'tool';
    if (!mappedRole) continue;
    let body = '';
    if (typeof msg.content === 'string') body = msg.content;
    else if (Array.isArray(msg.content)) {
      body = msg.content
        .map((c: any) => (typeof c === 'string' ? c : c.text || c.input || JSON.stringify(c)))
        .join('\n');
    } else if (msg.content) body = JSON.stringify(msg.content);
    if (!body.trim()) continue;
    // Look at the full raw msg blob for audio markers — the body may be a
    // text transcript while the original payload still flagged the modality.
    const audio = detectAudio(body) || detectAudio(JSON.stringify(msg || ''));
    events.push({
      agentId,
      sessionId,
      ts,
      role: mappedRole,
      content: clampContent(body),
      model: msg.model || obj.model,
      source: `${file}#${i}`,
      audio,
    });
  }
  return events;
}

function parseAiderMarkdown(agentId: string, file: string): ActivityEvent[] {
  const content = safeRead(file);
  if (!content) return [];
  const events: ActivityEvent[] = [];
  const baseTs = fs.statSync(file).mtimeMs;
  const sessionId = path.basename(file);
  const blocks = content.split(/^####\s+/m);
  let idx = 0;
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi].trim();
    if (!block) continue;
    if (bi === 0) {
      events.push({
        agentId,
        sessionId,
        ts: baseTs,
        role: 'assistant',
        content: clampContent(block),
        source: `${file}#${idx++}`,
      });
      continue;
    }
    const m = block.match(/^([^\n]+)\n?([\s\S]*)$/);
    if (!m) continue;
    const userLine = m[1].trim();
    const rest = m[2].trim();
    events.push({
      agentId,
      sessionId,
      ts: baseTs,
      role: 'user',
      content: clampContent(userLine),
      source: `${file}#${idx++}`,
    });
    if (rest) {
      events.push({
        agentId,
        sessionId,
        ts: baseTs,
        role: 'assistant',
        content: clampContent(rest),
        source: `${file}#${idx++}`,
      });
    }
  }
  return events;
}

function parseCodexSqlite(agentId: string, dbPath: string): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  let sdb: DatabaseSync | null = null;
  try {
    sdb = new DatabaseSync(dbPath, { readOnly: true });
    const tables = (sdb
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>).map((r) => r.name);

    const msgTable = tables.find((n) => /^(messages|thread_messages|events)$/i.test(n));
    if (msgTable) {
      try {
        const rows = sdb
          .prepare(
            `SELECT * FROM ${msgTable} ORDER BY COALESCE(created_at_ms, created_at, ts, id) ASC LIMIT 5000`,
          )
          .all() as any[];
        for (const r of rows) {
          const role = String(r.role || r.type || '').toLowerCase();
          let mapped: ActivityRole | null = null;
          if (role === 'user') mapped = 'user';
          else if (role === 'assistant') mapped = 'assistant';
          else if (role === 'system') mapped = 'system';
          else if (role.startsWith('tool')) mapped = 'tool';
          if (!mapped) continue;
          const body =
            typeof r.content === 'string' ? r.content : JSON.stringify(r.content || r.text || r.body || '');
          if (!body || body === '""') continue;
          const ts =
            Number(r.created_at_ms) ||
            Number(r.updated_at_ms) ||
            Number(r.ts) ||
            (r.created_at ? new Date(r.created_at).getTime() : 0) ||
            fs.statSync(dbPath).mtimeMs;
          events.push({
            agentId,
            sessionId: String(r.thread_id || r.session_id || ''),
            ts,
            role: mapped,
            content: clampContent(body),
            model: r.model || undefined,
            source: `${dbPath}#${msgTable}:${r.id ?? events.length}`,
          });
        }
      } catch {}
    }

    if (events.length === 0 && tables.includes('threads')) {
      try {
        const rows = sdb
          .prepare('SELECT id, model, responses, updated_at_ms, created_at_ms FROM threads')
          .all() as any[];
        for (const r of rows) {
          if (!r.responses) continue;
          let arr: any[] = [];
          try {
            const parsed = typeof r.responses === 'string' ? JSON.parse(r.responses) : r.responses;
            arr = Array.isArray(parsed) ? parsed : [];
          } catch {
            continue;
          }
          for (let i = 0; i < arr.length; i++) {
            const m = arr[i];
            const role = String(m.role || '').toLowerCase();
            const mapped: ActivityRole | null =
              role === 'user' || role === 'assistant' || role === 'system' || role === 'tool'
                ? (role as ActivityRole)
                : null;
            if (!mapped) continue;
            const body =
              typeof m.content === 'string'
                ? m.content
                : Array.isArray(m.content)
                  ? m.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
                  : JSON.stringify(m.content || '');
            if (!body.trim()) continue;
            events.push({
              agentId,
              sessionId: String(r.id),
              ts: Number(r.updated_at_ms) || Number(r.created_at_ms) || fs.statSync(dbPath).mtimeMs,
              role: mapped,
              content: clampContent(body),
              model: r.model || undefined,
              source: `${dbPath}#thread:${r.id}:${i}`,
            });
          }
        }
      } catch {}
    }
  } catch {
    // unreadable / locked
  } finally {
    try { sdb?.close(); } catch {}
  }
  return events;
}

function parseFile(agentId: string, file: string): ActivityEvent[] {
  if (/\.sqlite\d*$/i.test(file) && agentId === 'codex-cli') {
    return parseCodexSqlite(agentId, file);
  }
  if (!/\.(jsonl?|md)$/i.test(file)) return [];
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1024);
    fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    head = buf.toString('utf8');
  } catch {
    return [];
  }
  if (/\.md$/i.test(file)) {
    if (agentId === 'aider' || /aider|chat|history/i.test(file)) {
      return parseAiderMarkdown(agentId, file);
    }
    return [];
  }
  if (/"type"\s*:\s*"session\.start"/.test(head) || agentId === 'copilot-cli') {
    return parseCopilotEvents(agentId, file);
  }
  if (agentId === 'claude-cli' || /"role"\s*:\s*"(user|assistant|human)"/.test(head)) {
    return parseClaudeJsonl(agentId, file);
  }
  return [];
}

export async function scanActivity(): Promise<{ inserted: number; scanned: number }> {
  const collected: ActivityEvent[] = [];
  let scanned = 0;
  // Incremental guard: parse a file only if it's new or changed since the last
  // scan. Unchanged transcripts (the overwhelming majority on every rescan) are
  // skipped without being read or JSON-parsed.
  const guard = (file: string, parse: () => ActivityEvent[]) => {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { return; }
    if (st.size > MAX_FILE_BYTES) return;
    if (isFileUnchanged('activity', file, st.mtimeMs, st.size)) return;
    try {
      const events = parse();
      collected.push(...events);
      scanned++;
      recordFileScanned('activity', file, st.mtimeMs, st.size);
    } catch {}
  };
  for (const def of REGISTRY) {
    if (def.integration) {
      if (def.integration.activity === 'pi') {
        const data = readPiSessions(def.integration.sessionPaths ?? []);
        collected.push(...data.activity);
        scanned += data.projects.length;
        setIntegrationIssues(def.id, 'activity', data.issues);
      }
      continue;
    }
    for (const lp of def.logPaths || []) {
      if (!fs.existsSync(lp)) continue;
      try {
        if (fs.statSync(lp).isFile()) {
          guard(lp, () => parseFile(def.id, lp));
        } else {
          await walkFiles(lp, 5, (f) => guard(f, () => parseFile(def.id, f)));
        }
      } catch {}
    }
    if (def.id === 'codex-cli') {
      const root = def.configPaths?.[0];
      if (root && fs.existsSync(root)) {
        try {
          for (const f of fs.readdirSync(root)) {
            if (/^state.*\.sqlite\d*$/i.test(f)) {
              const full = path.join(root, f);
              guard(full, () => parseCodexSqlite(def.id, full));
            }
          }
        } catch {}
      }
    }
    await yieldToLoop();
  }

  let inserted = 0;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO activity_events
       (agent_id, session_id, ts, role, content, content_preview, model, source, dedup_key, tokens, audio)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let written = 0;
  for (const e of collected) {
    const key = dedupKey(e);
    const tokens = Math.ceil(e.content.length / 4);
    const r = ins.run(
      e.agentId,
      e.sessionId || null,
      e.ts,
      e.role,
      e.content,
      preview(e.content),
      e.model || null,
      e.source,
      key,
      tokens,
      e.audio ? 1 : 0,
    );
    if ((r.changes as number) > 0) inserted++;
    if (++written % 1000 === 0) await yieldToLoop();
  }
  return { inserted, scanned };
}

export interface ActivityRow {
  id: number;
  agentId: string;
  sessionId: string | null;
  ts: number;
  role: ActivityRole;
  contentPreview: string;
  model: string | null;
  source: string;
  tokens: number;
  audio: boolean;
  cost?: number | null; // null means the model has no matching price
}

export interface ActivityListResponse {
  total: number;
  rows: ActivityRow[];
  agents: { agentId: string; count: number }[];
  costEnabled: boolean;
}

export function listActivity(opts: {
  agentId?: string;
  q?: string;
  role?: string;
  modality?: 'text' | 'audio' | 'all' | string;
  sinceMs?: number;
  limit?: number;
  offset?: number;
}): ActivityListResponse {
  const where: string[] = [];
  const args: any[] = [];
  if (opts.agentId) {
    where.push('agent_id = ?');
    args.push(opts.agentId);
  }
  if (opts.role) {
    const roles = String(opts.role)
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    if (roles.length === 1) {
      where.push('role = ?');
      args.push(roles[0]);
    } else if (roles.length > 1) {
      where.push(`role IN (${roles.map(() => '?').join(',')})`);
      args.push(...roles);
    }
  }
  if (opts.modality === 'text')  where.push('audio = 0');
  if (opts.modality === 'audio') where.push('audio = 1');
  if (opts.sinceMs && opts.sinceMs > 0) {
    where.push('ts >= ?');
    args.push(Date.now() - opts.sinceMs);
  }
  if (opts.q && opts.q.trim()) {
    where.push('content LIKE ?');
    args.push(`%${opts.q.trim()}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const total = (db
    .prepare(`SELECT COUNT(*) as c FROM activity_events ${whereSql}`)
    .get(...args) as { c: number }).c;

  const rawRows = db
    .prepare(
      `SELECT id, agent_id as agentId, session_id as sessionId, ts, role,
              content_preview as contentPreview, model, source,
              COALESCE(tokens, 0) as tokens,
              COALESCE(audio, 0) as audio
       FROM activity_events ${whereSql}
       ORDER BY ts DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as any[];
  const rows = rawRows.map((r) => ({ ...r, audio: !!r.audio })) as ActivityRow[];

  const costEnabled = isCostEnabled();
  if (costEnabled) {
    const table = getPriceTable();
    for (const r of rows) r.cost = estimateEventCost(r.role, r.model, r.tokens, table);
  }

  const agents = db
    .prepare(
      `SELECT agent_id as agentId, COUNT(*) as count
       FROM activity_events GROUP BY agent_id ORDER BY count DESC`,
    )
    .all() as { agentId: string; count: number }[];

  return { total, rows, agents, costEnabled };
}

// Shared WHERE builder used by listActivity, getActivityStats, and (subset of)
// listActivitySessions filters. Returns the where clause and bind args.
function buildActivityWhere(opts: {
  agentId?: string;
  q?: string;
  role?: string;
  modality?: 'text' | 'audio' | 'all' | string;
  sinceMs?: number;
}): { whereSql: string; args: any[] } {
  const where: string[] = [];
  const args: any[] = [];
  if (opts.agentId) { where.push('agent_id = ?'); args.push(opts.agentId); }
  if (opts.role) {
    const roles = String(opts.role).split(',').map((r) => r.trim()).filter(Boolean);
    if (roles.length === 1) { where.push('role = ?'); args.push(roles[0]); }
    else if (roles.length > 1) { where.push(`role IN (${roles.map(() => '?').join(',')})`); args.push(...roles); }
  }
  if (opts.modality === 'text')  where.push('audio = 0');
  if (opts.modality === 'audio') where.push('audio = 1');
  if (opts.sinceMs && opts.sinceMs > 0) {
    where.push('ts >= ?');
    args.push(Date.now() - opts.sinceMs);
  }
  if (opts.q && opts.q.trim()) {
    where.push('content LIKE ?');
    args.push(`%${opts.q.trim()}%`);
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

export interface ActivityStats {
  total: number;
  byRole: { user: number; assistant: number; system: number; tool: number };
  audio: { user: number; assistant: number; total: number };
  sessions: number;
  totalTokens: number;
  avgTokensPerMsg: number;
  topModel: { name: string; count: number; share: number } | null;
}

export function getActivityStats(opts: {
  agentId?: string;
  q?: string;
  role?: string;
  modality?: 'text' | 'audio' | 'all' | string;
  sinceMs?: number;
}): ActivityStats {
  const { whereSql, args } = buildActivityWhere(opts);
  const total = (db
    .prepare(`SELECT COUNT(*) as c FROM activity_events ${whereSql}`)
    .get(...args) as { c: number }).c;

  const roleRows = db
    .prepare(`SELECT role, COUNT(*) as c FROM activity_events ${whereSql} GROUP BY role`)
    .all(...args) as { role: string; c: number }[];
  const byRole = { user: 0, assistant: 0, system: 0, tool: 0 } as ActivityStats['byRole'];
  for (const r of roleRows) {
    if (r.role === 'user' || r.role === 'assistant' || r.role === 'system' || r.role === 'tool') {
      (byRole as any)[r.role] = r.c;
    }
  }

  const audioRows = db
    .prepare(
      `SELECT role, COUNT(*) as c FROM activity_events
       ${whereSql ? whereSql + ' AND audio = 1' : 'WHERE audio = 1'}
       GROUP BY role`,
    )
    .all(...args) as { role: string; c: number }[];
  const audio = { user: 0, assistant: 0, total: 0 };
  for (const r of audioRows) {
    if (r.role === 'user') audio.user = r.c;
    else if (r.role === 'assistant') audio.assistant = r.c;
    audio.total += r.c;
  }

  const sessions = (db
    .prepare(`SELECT COUNT(DISTINCT COALESCE(session_id, source)) as c FROM activity_events ${whereSql}`)
    .get(...args) as { c: number }).c;

  const totalTokens = (db
    .prepare(`SELECT COALESCE(SUM(tokens), 0) as s FROM activity_events ${whereSql}`)
    .get(...args) as { s: number }).s;

  const avgTokensPerMsg = total > 0 ? Math.round(totalTokens / total) : 0;

  const topModelRow = db
    .prepare(
      `SELECT model, COUNT(*) as c FROM activity_events
       ${whereSql ? whereSql + ' AND model IS NOT NULL AND model <> \'\'' : 'WHERE model IS NOT NULL AND model <> \'\''}
       GROUP BY model ORDER BY c DESC LIMIT 1`,
    )
    .get(...args) as { model: string; c: number } | undefined;
  const topModel = topModelRow
    ? { name: topModelRow.model, count: topModelRow.c, share: total > 0 ? topModelRow.c / total : 0 }
    : null;

  return { total, byRole, audio, sessions, totalTokens, avgTokensPerMsg, topModel };
}

// Pseudo-session-id used when session_id IS NULL. Encodes the source-file
// basename so transcripts from the same file stay grouped.
function fileBasenameKey(source: string): string {
  const norm = (source || '').replace(/\\/g, '/');
  const noFrag = norm.split('#')[0];
  const base = noFrag.split('/').pop() || noFrag || 'unknown';
  return `_file:${base}`;
}

export interface ActivitySessionSummary {
  sessionId: string;
  displaySessionId: string;
  agentId: string;
  model: string | null;
  firstTs: number;
  lastTs: number;
  eventCount: number;
  userCount: number;
  assistantCount: number;
  toolCount: number;
  totalTokens: number;
  durationMs: number;
  lastRole: ActivityRole;
  status: SessionStatus;
  needsAttention: boolean;
  cost?: number | null;
  unpricedTokens?: number;
}

// Per-event cost: assistant tokens priced as output, everything else as input.
function estimateEventCost(role: ActivityRole, model: string | null, tokens: number, table: PriceEntry[]): number | null {
  return role === 'assistant'
    ? costForUsage({ model, inputTokens: 0, outputTokens: tokens || 0 }, table)
    : costForUsage({ model, inputTokens: tokens || 0, outputTokens: 0 }, table);
}

export function listActivitySessions(opts: {
  agentId?: string;
  modality?: 'text' | 'audio' | 'all' | string;
  sinceMs?: number;
  limit?: number;
}): { sessions: ActivitySessionSummary[]; total: number; costEnabled: boolean } {
  const where: string[] = [];
  const args: any[] = [];
  if (opts.agentId) {
    where.push('agent_id = ?');
    args.push(opts.agentId);
  }
  if (opts.modality === 'text')  where.push('audio = 0');
  if (opts.modality === 'audio') where.push('audio = 1');
  if (opts.sinceMs && opts.sinceMs > 0) {
    where.push('ts >= ?');
    args.push(Date.now() - opts.sinceMs);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Pull the rows we need with one query and group in JS so we can apply
  // the file-basename fallback for NULL session_ids consistently.
  const rows = db
    .prepare(
      `SELECT agent_id as agentId, session_id as sessionId, ts, role, model, source,
              content_preview as contentPreview, COALESCE(tokens, 0) as tokens
       FROM activity_events ${whereSql}`,
    )
    .all(...args) as Array<{
      agentId: string;
      sessionId: string | null;
      ts: number;
      role: ActivityRole;
      model: string | null;
      source: string;
      contentPreview: string;
      tokens: number;
    }>;

  const costEnabled = isCostEnabled();
  const priceTable = costEnabled ? getPriceTable() : [];
  const now = Date.now();

  // Accumulator carries the extra fields we need to derive status/cost before
  // shaping the public summary.
  interface Acc extends ActivitySessionSummary {
    _lastPreview: string;
  }
  const map = new Map<string, Acc>();
  for (const r of rows) {
    const sid = r.sessionId && r.sessionId.trim() ? r.sessionId : fileBasenameKey(r.source);
    const key = `${r.agentId}::${sid}`;
    let s = map.get(key);
    if (!s) {
      s = {
        sessionId: sid,
        displaySessionId: sid.startsWith('_file:') ? sid.slice('_file:'.length) : sid,
        agentId: r.agentId,
        model: r.model,
        firstTs: r.ts,
        lastTs: r.ts,
        eventCount: 0,
        userCount: 0,
        assistantCount: 0,
        toolCount: 0,
        totalTokens: 0,
        durationMs: 0,
        lastRole: r.role,
        status: 'idle',
        needsAttention: false,
        ...(costEnabled ? { cost: null, unpricedTokens: 0 } : {}),
        _lastPreview: r.contentPreview || '',
      };
      map.set(key, s);
    }
    s.eventCount++;
    s.totalTokens += r.tokens || 0;
    if (r.role === 'user') s.userCount++;
    else if (r.role === 'assistant') s.assistantCount++;
    else if (r.role === 'tool') s.toolCount++;
    if (costEnabled) {
      const cost = estimateEventCost(r.role, r.model, r.tokens, priceTable);
      if (cost === null) s.unpricedTokens = (s.unpricedTokens ?? 0) + (r.tokens || 0);
      else s.cost = (s.cost ?? 0) + cost;
    }
    if (r.ts < s.firstTs) s.firstTs = r.ts;
    if (r.ts >= s.lastTs) {
      s.lastTs = r.ts;
      s.lastRole = r.role;
      s._lastPreview = r.contentPreview || '';
    }
    if (r.model && (!s.model || r.ts >= s.lastTs)) s.model = r.model;
  }

  const sessions: ActivitySessionSummary[] = [...map.values()]
    .sort((a, b) => b.lastTs - a.lastTs)
    .map((s) => {
      const { status, needsAttention } = deriveStatus(s.lastTs, s.lastRole, s._lastPreview || '', now);
      s.status = status;
      s.needsAttention = needsAttention;
      s.durationMs = Math.max(0, s.lastTs - s.firstTs);
      const { _lastPreview, ...pub } = s;
      return pub;
    });

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  return { sessions: sessions.slice(0, limit), total: sessions.length, costEnabled };
}

export function getActivitySession(
  agentId: string,
  sessionId: string,
): { events: ActivityRow[]; summary: ActivitySessionSummary | null; costEnabled: boolean } {
  const costEnabled = isCostEnabled();
  const priceTable = costEnabled ? getPriceTable() : [];
  let where: string;
  let args: any[];
  if (sessionId.startsWith('_file:')) {
    const base = sessionId.slice('_file:'.length);
    where = "agent_id = ? AND session_id IS NULL AND (source LIKE ? OR source LIKE ?)";
    args = [agentId, `%/${base}%`, `%\\${base}%`];
  } else {
    where = 'agent_id = ? AND session_id = ?';
    args = [agentId, sessionId];
  }
  const events = db
    .prepare(
      `SELECT id, agent_id as agentId, session_id as sessionId, ts, role,
              content_preview as contentPreview, model, source,
              COALESCE(tokens, 0) as tokens
       FROM activity_events WHERE ${where}
       ORDER BY ts ASC, id ASC`,
    )
    .all(...args) as unknown as ActivityRow[];

  if (events.length === 0) return { events: [], summary: null, costEnabled };

  // Per-event cost: assistant tokens priced as output, everything else as input.
  if (costEnabled) {
    for (const e of events) {
      e.cost = estimateEventCost(e.role, e.model, e.tokens, priceTable);
    }
  }

  const lastRole = events[events.length - 1].role;
  const lastPreview = events[events.length - 1].contentPreview || '';
  const { status, needsAttention } = deriveStatus(events[events.length - 1].ts, lastRole, lastPreview);
  const summary: ActivitySessionSummary = {
    sessionId,
    displaySessionId: sessionId.startsWith('_file:') ? sessionId.slice('_file:'.length) : sessionId,
    agentId,
    model: null,
    firstTs: events[0].ts,
    lastTs: events[events.length - 1].ts,
    eventCount: events.length,
    userCount: events.filter((e) => e.role === 'user').length,
    assistantCount: events.filter((e) => e.role === 'assistant').length,
    toolCount: events.filter((e) => e.role === 'tool').length,
    totalTokens: events.reduce((s, e) => s + (e.tokens || 0), 0),
    durationMs: Math.max(0, events[events.length - 1].ts - events[0].ts),
    lastRole,
    status,
    needsAttention,
  };
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].model) { summary.model = events[i].model; break; }
  }
  if (costEnabled) {
    const priced = events.filter((e) => e.cost != null);
    summary.cost = priced.length ? priced.reduce((sum, e) => sum + (e.cost ?? 0), 0) : null;
    summary.unpricedTokens = events.reduce((sum, e) => sum + (e.cost == null ? e.tokens || 0 : 0), 0);
  }
  return { events, summary, costEnabled };
}

export function getActivityContent(id: number): { content: string; row: ActivityRow } | null {
  const row = db
    .prepare(
      `SELECT id, agent_id as agentId, session_id as sessionId, ts, role,
              content, content_preview as contentPreview, model, source,
              COALESCE(tokens, 0) as tokens
       FROM activity_events WHERE id = ?`,
    )
    .get(id) as (ActivityRow & { content: string }) | undefined;
  if (!row) return null;
  const { content, ...rest } = row;
  if (isCostEnabled()) {
    rest.cost = estimateEventCost(rest.role, rest.model, rest.tokens, getPriceTable());
  }
  return { content, row: rest };
}

export function deleteActivity(opts: { id?: number; agentId?: string; all?: boolean }): number {
  if (opts.all) {
    const r = db.prepare('DELETE FROM activity_events').run();
    return r.changes as number;
  }
  if (typeof opts.id === 'number') {
    const r = db.prepare('DELETE FROM activity_events WHERE id = ?').run(opts.id);
    return r.changes as number;
  }
  if (opts.agentId) {
    const r = db.prepare('DELETE FROM activity_events WHERE agent_id = ?').run(opts.agentId);
    return r.changes as number;
  }
  return 0;
}

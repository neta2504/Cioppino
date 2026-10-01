import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { REGISTRY } from '../discovery/registry.js';

export interface ErrorRecord {
  agentId: string;
  ts: number;
  source: string;
  message: string;
  kind: string;
}

export interface ErrorSummary {
  byAgent: { agentId: string; count24h: number; count1h: number; total: number }[];
  recent: ErrorRecord[];
  total24h: number;
}

const CACHE: { at: number; data: ErrorSummary | null } = { at: 0, data: null };
const TTL_MS = 30_000;

export async function getErrorSummary(rangeHours = 24): Promise<ErrorSummary> {
  if (CACHE.data && Date.now() - CACHE.at < TTL_MS) return CACHE.data;
  const now = Date.now();
  const cutoff24 = now - 24 * 3600_000;
  const cutoff1 = now - 3600_000;
  const cutoffRange = now - rangeHours * 3600_000;
  const all: ErrorRecord[] = [];

  for (const def of REGISTRY) {
    if (def.logPaths) {
      for (const lp of def.logPaths) {
        if (!fs.existsSync(lp)) continue;
        try {
          if (fs.statSync(lp).isFile()) {
            all.push(...scanFile(def.id, lp, cutoffRange));
          } else {
            walk(lp, 4, (f) => all.push(...scanFile(def.id, f, cutoffRange)));
          }
        } catch {}
      }
    }
    if (def.id === 'codex-cli') {
      const root = def.configPaths?.[0];
      if (root && fs.existsSync(root)) {
        for (const f of fs.readdirSync(root)) {
          if (/^logs.*\.sqlite$/.test(f)) {
            all.push(...scanCodexLogsDb(def.id, path.join(root, f), cutoffRange));
          }
        }
      }
    }
  }

  const byAgentMap = new Map<string, { count24h: number; count1h: number; total: number }>();
  for (const e of all) {
    const cur = byAgentMap.get(e.agentId) || { count24h: 0, count1h: 0, total: 0 };
    cur.total++;
    if (e.ts >= cutoff24) cur.count24h++;
    if (e.ts >= cutoff1) cur.count1h++;
    byAgentMap.set(e.agentId, cur);
  }
  const byAgent = [...byAgentMap.entries()]
    .map(([agentId, v]) => ({ agentId, ...v }))
    .sort((a, b) => b.count24h - a.count24h);

  const recent = all.sort((a, b) => b.ts - a.ts).slice(0, 30);
  const total24h = byAgent.reduce((s, x) => s + x.count24h, 0);

  const data = { byAgent, recent, total24h };
  CACHE.at = Date.now();
  CACHE.data = data;
  return data;
}

function walk(root: string, maxDepth: number, fn: (file: string) => void, depth = 0) {
  if (depth > maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) walk(full, maxDepth, fn, depth + 1);
    else if (e.isFile()) {
      try {
        const st = fs.statSync(full);
        if (st.size > 200 * 1024 * 1024) continue;
        if (!/\.(jsonl?|md|log|txt)$/i.test(e.name)) continue;
        fn(full);
      } catch {}
    }
  }
}

function scanFile(agentId: string, file: string, cutoff: number): ErrorRecord[] {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(512);
    fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    head = buf.toString('utf8');
  } catch {
    return [];
  }
  if (/\.jsonl$/i.test(file) && /"type"\s*:\s*"session\.start"/.test(head)) {
    return scanCopilotEvents(agentId, file, cutoff);
  }
  return [];
}

function scanCopilotEvents(agentId: string, file: string, cutoff: number): ErrorRecord[] {
  const out: ErrorRecord[] = [];
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  const base = fs.statSync(file).mtimeMs;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : base;
    if (isNaN(ts) || ts < cutoff) continue;
    const t = obj.type;
    const data = obj.data || {};
    let msg = '';
    let kind = '';
    if (t === 'tool.execution_complete' && data.success === false) {
      kind = 'tool_error';
      msg = data.error?.message || data.error?.code || data.toolName || 'tool failed';
    } else if (typeof t === 'string' && /error|fail|crash/i.test(t)) {
      kind = t;
      msg = JSON.stringify(data).slice(0, 200);
    } else if (data.error && (data.error.message || data.error.code)) {
      kind = t || 'error';
      msg = data.error.message || data.error.code;
    } else {
      continue;
    }
    out.push({ agentId, ts, source: file, message: String(msg).slice(0, 300), kind });
  }
  return out;
}

function scanCodexLogsDb(agentId: string, dbPath: string, cutoff: number): ErrorRecord[] {
  const out: ErrorRecord[] = [];
  try {
    const sdb = new DatabaseSync(dbPath, { readOnly: true });
    let rows: any[] = [];
    try {
      rows = sdb
        .prepare(
          "SELECT ts, level, target, feedback_log_body FROM logs WHERE level='ERROR' AND ts*1000 >= ? ORDER BY ts DESC LIMIT 200",
        )
        .all(cutoff) as any[];
    } catch {}
    for (const r of rows) {
      out.push({
        agentId,
        ts: Number(r.ts) * 1000,
        source: dbPath,
        message: `${r.target || ''} ${String(r.feedback_log_body || '').trim()}`.slice(0, 300),
        kind: 'codex_error',
      });
    }
    sdb.close();
  } catch {}
  return out;
}

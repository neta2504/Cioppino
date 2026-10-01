import fs from 'node:fs';
import path from 'node:path';
import { REGISTRY } from '../discovery/registry.js';

export interface LatencyPoint {
  agentId: string;
  ts: number;
  latencyMs: number;
}

export interface LatencySummary {
  points: LatencyPoint[];
  byAgent: { agentId: string; count: number; avgMs: number; p50Ms: number; p95Ms: number; maxMs: number }[];
}

const CACHE = new Map<number, { at: number; data: LatencySummary }>();
const TTL_MS = 30_000;

export async function getLatencySummary(rangeHours = 24): Promise<LatencySummary> {
  const cached = CACHE.get(rangeHours);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;
  const cutoff = Date.now() - rangeHours * 3600_000;
  const points: LatencyPoint[] = [];

  for (const def of REGISTRY) {
    if (!def.logPaths) continue;
    for (const lp of def.logPaths) {
      if (!fs.existsSync(lp)) continue;
      try {
        if (fs.statSync(lp).isFile()) {
          points.push(...scanFile(def.id, lp, cutoff));
        } else {
          walk(lp, 4, (f) => points.push(...scanFile(def.id, f, cutoff)));
        }
      } catch {}
    }
  }

  const groups = new Map<string, number[]>();
  for (const p of points) {
    const arr = groups.get(p.agentId) || [];
    arr.push(p.latencyMs);
    groups.set(p.agentId, arr);
  }
  const byAgent = [...groups.entries()]
    .map(([agentId, arr]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const sum = sorted.reduce((s, v) => s + v, 0);
      return {
        agentId,
        count: sorted.length,
        avgMs: Math.round(sum / sorted.length),
        p50Ms: sorted[Math.floor(sorted.length * 0.5)] || 0,
        p95Ms: sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1] || 0,
        maxMs: sorted[sorted.length - 1] || 0,
      };
    })
    .sort((a, b) => b.count - a.count);

  points.sort((a, b) => a.ts - b.ts);
  const data: LatencySummary = { points, byAgent };
  CACHE.set(rangeHours, { at: Date.now(), data });
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
        if (!/\.jsonl?$/i.test(e.name)) continue;
        fn(full);
      } catch {}
    }
  }
}

function scanFile(agentId: string, file: string, cutoff: number): LatencyPoint[] {
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
  if (/"type"\s*:\s*"session\.start"/.test(head)) {
    return scanCopilotEvents(agentId, file, cutoff);
  }
  return [];
}

function scanCopilotEvents(agentId: string, file: string, cutoff: number): LatencyPoint[] {
  const out: LatencyPoint[] = [];
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  const lines = content.split(/\r?\n/);
  let pendingUserTs: number | null = null;
  for (const line of lines) {
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : NaN;
    if (isNaN(ts)) continue;
    if (obj.type === 'user.message') {
      pendingUserTs = ts;
    } else if (obj.type === 'assistant.message' && pendingUserTs != null) {
      const dt = ts - pendingUserTs;
      if (dt > 0 && dt < 10 * 60_000 && ts >= cutoff) {
        out.push({ agentId, ts, latencyMs: dt });
      }
      pendingUserTs = null;
    }
  }
  return out;
}

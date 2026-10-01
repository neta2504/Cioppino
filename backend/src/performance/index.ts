import si from 'systeminformation';
import { spawn } from 'node:child_process';
import { db } from '../db/index.js';
import { listAgents, type DiscoveredAgent } from '../discovery/index.js';
import { getProcessSnapshot, type ProcSnapshot } from '../discovery/procSnapshot.js';
import { object } from '../discovery/integrationFiles.js';
import { setIntegrationIssues } from '../discovery/integrationStatus.js';

export interface Sample {
  agentId: string;
  pid: number;
  ts: number;
  cpu: number;
  gpu: number;        // 0-100, per-process (Windows only; 0 elsewhere)
  rssMb: number;
  threads: number;
}

export interface GpuSample {
  ts: number;
  util: number;       // 0-100 (max across controllers)
  memUsedMb: number;  // sum across controllers
  name: string;       // primary controller model
}

export interface PerfTick {
  samples: Sample[];
  gpu: GpuSample | null;
}

let timer: NodeJS.Timeout | null = null;
const subscribers = new Set<(t: PerfTick) => void>();

export function startSampler(intervalMs = 3000) {
  if (timer) return;
  const tick = async () => {
    try {
      const [samples, gpu] = await Promise.all([sampleOnce(), sampleGpuOnce()]);
      if (samples.length > 0) {
        const ins = db.prepare('INSERT INTO perf_samples (agent_id,pid,ts,cpu,rss_mb,threads,gpu) VALUES (?,?,?,?,?,?,?)');
        for (const s of samples) ins.run(s.agentId, s.pid, s.ts, s.cpu, s.rssMb, s.threads, s.gpu);
      }
      if (gpu) {
        db.prepare('INSERT INTO gpu_samples (ts,util,mem_used_mb,name) VALUES (?,?,?,?)').run(
          gpu.ts,
          gpu.util,
          gpu.memUsedMb,
          gpu.name,
        );
      }
      const payload: PerfTick = { samples, gpu };
      for (const fn of subscribers) {
        try {
          fn(payload);
        } catch {}
      }
    } catch (e) {
      // swallow
    }
  };
  timer = setInterval(tick, intervalMs);
  tick();
}

export function stopSampler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function subscribe(fn: (t: PerfTick) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

async function sampleOnce(): Promise<Sample[]> {
  const agents = listAgents().filter((a) => a.running && a.pids.length > 0);
  if (agents.length === 0) return [];
  const allPids = new Set<number>();
  for (const a of agents) for (const p of a.pids) allPids.add(p);
  const [snap, pidGpu] = await Promise.all([
    getProcessSnapshot(),
    samplePerPidGpuWindows(allPids),
  ]);
  return samplesForAgents(agents, snap, pidGpu);
}

export function samplesForAgents(agents: DiscoveredAgent[], snap: ProcSnapshot, pidGpu = new Map<number, number>(), ts = Date.now()): Sample[] {
  const byPid = snap.byPid;
  const samples: Sample[] = [];
  const seen = new Set<number>();
  for (const a of agents) {
    let unavailable = false;
    for (const pid of a.pids) {
      if (seen.has(pid)) continue;
      const proc = byPid.get(pid);
      if (!proc) continue;
      if (a.metadata?.monitoring) {
        const identities = object(a.metadata.processIdentities);
        if (!snap.ok || ts - snap.ts > 5000 || !proc.started || identities?.[pid] !== proc.started) {
          unavailable = true;
          continue;
        }
      }
      seen.add(pid);
      samples.push({
        agentId: a.id,
        pid,
        ts,
        cpu: proc.cpu ?? 0,
        gpu: pidGpu.get(pid) ?? 0,
        rssMb: proc.rssMb,
        threads: proc.threads ?? 0,
      });
    }
    if (a.metadata?.monitoring) setIntegrationIssues(a.id, 'resources',
      unavailable ? ['Resource sampling is unavailable until process identity can be refreshed.'] : []);
  }
  return samples;
}

// Per-process GPU utilization on Windows. Uses Get-Counter against the
// "GPU Engine" counter; instance names look like "pid_1234_luid_..._engtype_3D"
// and CookedValue is utilization % per engine. We sum engines per PID and
// clamp to 100. Returns an empty map on non-Windows or on any failure.
function samplePerPidGpuWindows(pids: Set<number>): Promise<Map<number, number>> {
  if (process.platform !== 'win32' || pids.size === 0) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    const cmd =
      "$ErrorActionPreference='SilentlyContinue';" +
      "$s=(Get-Counter '\\GPU Engine(*)\\Utilization Percentage').CounterSamples;" +
      "$s | Where-Object {$_.CookedValue -gt 0} | Select-Object InstanceName,CookedValue | ConvertTo-Json -Compress";
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      windowsHide: true,
    });
    let out = '';
    const timeout = setTimeout(() => {
      try { ps.kill(); } catch {}
      resolve(new Map());
    }, 4000);
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.on('close', () => {
      clearTimeout(timeout);
      const map = new Map<number, number>();
      try {
        const text = out.trim();
        if (!text) return resolve(map);
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const row of arr) {
          const inst: string = row?.InstanceName || '';
          const m = /pid_(\d+)/i.exec(inst);
          if (!m) continue;
          const pid = parseInt(m[1], 10);
          if (!pids.has(pid)) continue;
          const v = Number(row?.CookedValue) || 0;
          map.set(pid, (map.get(pid) || 0) + v);
        }
        for (const [k, v] of map) map.set(k, Math.min(100, v));
      } catch {}
      resolve(map);
    });
    ps.on('error', () => { clearTimeout(timeout); resolve(new Map()); });
  });
}

async function sampleGpuOnce(): Promise<GpuSample | null> {
  try {
    const g = await si.graphics();
    const controllers = (g?.controllers || []).filter((c: any) => c && typeof c === 'object');
    if (controllers.length === 0) return null;
    // Pick the controller most likely to be discrete/active (highest util, then highest mem).
    let util = 0;
    let memUsedMb = 0;
    let name = '';
    for (const c of controllers) {
      const u = typeof c.utilizationGpu === 'number' ? c.utilizationGpu : 0;
      if (u > util) util = u;
      const memU = typeof c.memoryUsed === 'number' ? c.memoryUsed : 0; // already MB
      memUsedMb += memU;
      if (!name && c.model) name = c.model;
    }
    return { ts: Date.now(), util, memUsedMb, name: name || 'GPU' };
  } catch {
    return null;
  }
}

export function getRecentSamples(agentId?: string, sinceMs = 5 * 60_000) {
  const since = Date.now() - sinceMs;
  const rows = agentId
    ? db.prepare('SELECT * FROM perf_samples WHERE agent_id=? AND ts >= ? ORDER BY ts').all(agentId, since)
    : db.prepare('SELECT * FROM perf_samples WHERE ts >= ? ORDER BY ts').all(since);
  return (rows as any[]).map((r) => ({
    agentId: r.agent_id,
    pid: r.pid,
    ts: r.ts,
    cpu: r.cpu,
    gpu: r.gpu ?? 0,
    rssMb: r.rss_mb,
    threads: r.threads,
  }));
}

export function getRecentGpuSamples(sinceMs = 5 * 60_000): GpuSample[] {
  const since = Date.now() - sinceMs;
  const rows = db.prepare('SELECT * FROM gpu_samples WHERE ts >= ? ORDER BY ts').all(since);
  return (rows as any[]).map((r) => ({
    ts: r.ts,
    util: r.util ?? 0,
    memUsedMb: r.mem_used_mb ?? 0,
    name: r.name ?? 'GPU',
  }));
}

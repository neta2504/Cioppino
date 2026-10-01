import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { REGISTRY, AgentDef } from './registry.js';
import { db } from '../db/index.js';
import { getProcessSnapshot, ProcInfo } from './procSnapshot.js';
import { resolveIntegration } from './integrationDiscovery.js';
import { getIntegrationIssues } from './integrationStatus.js';
import { integrationMonitoring } from './expanded.js';

const execFileP = promisify(execFile);

// Last known health of the process lister. Surfaced via /api/agents so the UI
// can warn the user when "running" state and perf charts can't be measured.
let lastProcListerOk = true;
let lastProcListerError: string | undefined;

export function getProcListerHealth() {
  return { ok: lastProcListerOk, error: lastProcListerError };
}

export interface DiscoveredAgent {
  id: string;
  name: string;
  vendor: string;
  kind: string;
  installed: boolean;
  running: boolean;
  version?: string;
  binPath?: string;
  configPath?: string;
  pids: number[];
  lastSeen: number;
  metadata?: Record<string, unknown>;
}

// Resolve a binary against PATH entirely in-process (no `where`/`command -v`
// child-process spawn — those cost 30–200ms each on Windows and there are
// dozens of binNames across the registry). Mirrors shell PATH/PATHEXT lookup.
const PATH_DIRS = (process.env.PATH || process.env.Path || '')
  .split(path.delimiter)
  .filter(Boolean);
const PATH_EXTS = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

function existsSafe(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function whichBin(name: string): string | undefined {
  const hasExt = path.extname(name) !== '';
  for (const dir of PATH_DIRS) {
    const base = path.join(dir, name);
    if (existsSafe(base)) return base;
    if (!hasExt && process.platform === 'win32') {
      for (const ext of PATH_EXTS) {
        if (existsSafe(base + ext)) return base + ext;
      }
    }
  }
  return undefined;
}

// Async, time-boxed `--version`. Batch/shell shims are deliberately skipped:
// discovery does not need version output badly enough to execute a shell.
async function tryVersion(bin: string): Promise<string | undefined> {
  if (process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(bin)) return undefined;
  try {
    const { stdout } = await execFileP(bin, ['--version'], {
      timeout: 1200,
      maxBuffer: 4096,
      windowsHide: true,
    });
    return stdout.toString().trim().split(/\r?\n/)[0].slice(0, 80) || undefined;
  } catch {
    return undefined;
  }
}

function findFirstExisting(paths: string[] = []): string | undefined {
  for (const p of paths) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return undefined;
}

export async function discoverAll(): Promise<DiscoveredAgent[]> {
  // Kick off the (slow on Windows) process snapshot and resolve bin/config
  // paths in-process at the same time, then await the snapshot — overlapping
  // the two instead of doing them strictly back-to-back.
  const snapPromise = getProcessSnapshot(true);

  // Synchronous, spawn-free detection of where each agent lives.
  const resolved = REGISTRY.map((def) => ({ def, ...(def.integration ? {} : isInstalled(def)) }));

  // Versions need a (shelled) child process; run them all concurrently and
  // time-boxed rather than serially blocking discovery.
  const versions = await Promise.all(
    resolved.map((r) => (r.binPath ? tryVersion(r.binPath) : Promise.resolve(undefined))),
  );

  const snap = await snapPromise;
  const integrations = new Map(await Promise.all(REGISTRY.filter((def) => def.integration)
    .map(async (def) => [def.id, await resolveIntegration(def, snap.ok ? snap.procs : [])] as const)));
  lastProcListerOk = snap.ok;
  lastProcListerError = snap.error;
  if (!snap.ok && snap.error) {
    // One-time-ish warning so the operator sees it in the log.
    console.warn('[cioppino] process lister failed:', snap.error);
  }

  const out: DiscoveredAgent[] = [];

  resolved.forEach(({ def, binPath, configPath }, i) => {
    const integration = integrations.get(def.id);
    const version = integration?.version ?? versions[i];

    const pids: number[] = [...(integration?.pids ?? [])];
    if (!def.integration && def.processNames) {
      for (const pn of def.processNames) {
        const matches: ProcInfo[] = snap.byName.get(pn.toLowerCase()) || [];
        for (const m of matches) {
          // Generic hosts (node, python) match many unrelated processes; for
          // those we require the cmdline to mention the agent id or name so
          // we don't mark every node process as the Copilot CLI.
          const isGeneric = ['node', 'node.exe', 'python.exe', 'python'].includes(pn.toLowerCase());
          if (isGeneric) {
            const cmd = m.cmdline;
            if (!cmd.includes(def.id) && !cmd.includes(def.name.toLowerCase())) continue;
          }
          pids.push(m.pid);
        }
      }
    }

    out.push({
      id: def.id,
      name: def.name,
      vendor: def.vendor,
      kind: def.kind,
      installed: integration?.installed ?? !!(binPath || configPath),
      running: pids.length > 0,
      version,
      binPath: integration?.binPath ?? binPath,
      configPath: integration?.configPath ?? configPath,
      pids: [...new Set(pids)],
      lastSeen: Date.now(),
      metadata: {
        description: def.description,
        ...(def.integration ? {
          monitoring: integrationMonitoring(def),
          processIdentities: Object.fromEntries(pids.map((pid) => [pid, snap.byPid.get(pid)?.started ?? ''])),
        } : {}),
      },
    });
  });

  // Shared hosts cannot contribute the same PID to two agent totals.
  const owned = new Set<number>();
  for (const agent of [...out.filter((a) => integrations.has(a.id)), ...out.filter((a) => !integrations.has(a.id))]) {
    agent.pids = agent.pids.filter((pid) => {
      if (owned.has(pid)) return false;
      owned.add(pid);
      return true;
    });
    agent.running = agent.pids.length > 0;
  }
  persist(out);
  return out;
}

export async function verifyIntegrationPid(agent: DiscoveredAgent, pid: number): Promise<boolean> {
  const def = REGISTRY.find((item) => item.id === agent.id);
  if (!def?.integration || !agent.pids.includes(pid)) return false;
  const identities = agent.metadata?.processIdentities;
  if (!identities || typeof identities !== 'object') return false;
  const started = (identities as Record<string, unknown>)[pid];
  if (typeof started !== 'string' || !started) return false;
  const requestedAt = Date.now();
  const snapshot = await getProcessSnapshot(true);
  if (!snapshot.ok || snapshot.ts < requestedAt) return false;
  const proc = snapshot.byPid.get(pid);
  if (!proc || proc.started !== started) return false;
  return (await resolveIntegration(def, [proc])).pids.includes(pid);
}

function isInstalled(def: AgentDef): { binPath?: string; configPath?: string } {
  let binPath: string | undefined;
  if (def.binNames) {
    for (const b of def.binNames) {
      const found = whichBin(b);
      if (found) {
        binPath = found;
        break;
      }
    }
  }
  const configPath = findFirstExisting(def.configPaths);
  return { binPath, configPath };
}

function persist(items: DiscoveredAgent[]) {
  const stmt = db.prepare(`
    INSERT INTO agents (id,name,vendor,kind,installed,running,version,bin_path,config_path,pids,last_seen,metadata)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, vendor=excluded.vendor, kind=excluded.kind,
      installed=excluded.installed, running=excluded.running, version=excluded.version,
      bin_path=excluded.bin_path, config_path=excluded.config_path,
      pids=excluded.pids, last_seen=excluded.last_seen, metadata=excluded.metadata
  `);
  // Single transaction so /api/agents reads either the full old set or
  // the full new set — never a partial overlay.
  db.exec('BEGIN');
  try {
    for (const a of items) {
      stmt.run(
        a.id,
        a.name,
        a.vendor,
        a.kind,
        a.installed ? 1 : 0,
        a.running ? 1 : 0,
        a.version ?? null,
        a.binPath ?? null,
        a.configPath ?? null,
        JSON.stringify(a.pids),
        a.lastSeen,
        JSON.stringify(a.metadata ?? {}),
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function listAgents(): DiscoveredAgent[] {
  const rows = db.prepare('SELECT * FROM agents ORDER BY running DESC, installed DESC, name ASC').all() as any[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    vendor: r.vendor,
    kind: r.kind,
    installed: !!r.installed,
    running: !!r.running,
    version: r.version ?? undefined,
    binPath: r.bin_path ?? undefined,
    configPath: r.config_path ?? undefined,
    pids: JSON.parse(r.pids || '[]'),
    lastSeen: r.last_seen,
    metadata: {
      ...(r.metadata ? JSON.parse(r.metadata) : {}),
      issues: getIntegrationIssues(r.id),
      ...(REGISTRY.find((def) => def.id === r.id)?.integration
        ? { processState: lastProcListerOk ? 'available' : 'unavailable' } : {}),
    },
  }));
}

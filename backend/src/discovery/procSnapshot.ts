import si from 'systeminformation';
import path from 'node:path';

export interface ProcInfo {
  pid: number;
  name: string;
  // Lowercased "command + ' ' + params". On Windows si fills both fields
  // (params holds the full cmdline for node.exe / python.exe hosts), so this
  // is what we match generic process names against.
  cmdline: string;
  executable?: string;
  started?: string;
  cpu: number;
  rssMb: number;
  threads: number;
}

export interface ProcSnapshot {
  ts: number;
  procs: ProcInfo[];
  byPid: Map<number, ProcInfo>;
  byName: Map<string, ProcInfo[]>; // lowercased name -> procs
  ok: boolean;
  error?: string;
}

const EMPTY: ProcSnapshot = {
  ts: 0,
  procs: [],
  byPid: new Map(),
  byName: new Map(),
  ok: false,
};

let last: ProcSnapshot = EMPTY;
let inflight: Promise<ProcSnapshot> | null = null;

const CACHE_MS = 1500;
// `si.processes()` shells out to wmic/PowerShell on Windows and can take many
// seconds (occasionally tens) — and worse, its result event can be starved when
// the event loop is busy with the synchronous scans. Bound how long any caller
// (notably agent discovery, which gates the splash) waits on it. The real probe
// keeps running in the background and refreshes `last` for the next caller.
const SI_TIMEOUT_MS = 4000;

export async function getProcessSnapshot(force = false, timeoutMs = SI_TIMEOUT_MS): Promise<ProcSnapshot> {
  if (!force && last.ts && Date.now() - last.ts < CACHE_MS) return last;
  if (!inflight) inflight = buildSnapshot();
  if (timeoutMs <= 0) return inflight;
  let timer: NodeJS.Timeout;
  const timeout = new Promise<ProcSnapshot>((resolve) => {
    timer = setTimeout(
      () => resolve({ ...(last.ts ? last : EMPTY), ok: false, error: 'process snapshot timed out' }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([inflight, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function buildSnapshot(): Promise<ProcSnapshot> {
  return (async () => {
    try {
      const r = await si.processes();
      const procs: ProcInfo[] = [];
      const byPid = new Map<number, ProcInfo>();
      const byName = new Map<string, ProcInfo[]>();
      for (const p of r.list || []) {
        const name = (p.name || '').toString();
        const command = (p as any).command ? String((p as any).command) : '';
        const params = (p as any).params ? String((p as any).params) : '';
        const info: ProcInfo = {
          pid: p.pid,
          name,
          cmdline: (`${command} ${params}`).trim().toLowerCase(),
          executable: process.platform === 'win32'
            ? p.path || undefined
            : p.path ? path.join(p.path, command) : command,
          started: p.started,
          cpu: (p as any).cpu ?? 0,
          // si returns memRss in KB on most platforms — performance sampler
          // already treats it that way (divides by 1024 for MB).
          rssMb: ((p as any).memRss ?? (p as any).mem_rss ?? (p as any).mem ?? 0) / 1024,
          threads: (p as any).threads ?? 0,
        };
        procs.push(info);
        byPid.set(info.pid, info);
        const key = name.toLowerCase();
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key)!.push(info);
      }
      const snap: ProcSnapshot = {
        ts: Date.now(),
        procs,
        byPid,
        byName,
        ok: procs.length > 0,
      };
      last = snap;
      return snap;
    } catch (err) {
      const snap: ProcSnapshot = {
        ts: Date.now(),
        procs: [],
        byPid: new Map(),
        byName: new Map(),
        ok: false,
        error: (err as Error)?.message || String(err),
      };
      last = snap;
      return snap;
    } finally {
      inflight = null;
    }
  })();
}

export function getLastSnapshot(): ProcSnapshot {
  return last;
}

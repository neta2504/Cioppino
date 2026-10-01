import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HOME } from '../config.js';
import { REGISTRY } from '../discovery/registry.js';
import { readPiSessions } from '../activity/pi.js';
import { setIntegrationIssues } from '../discovery/integrationStatus.js';

export interface ProjectAgentUsage {
  agentId: string;
  sessions: number;
  lastSeen: number;
}

export interface Project {
  /** stable id derived from normalized path */
  id: string;
  /** normalized absolute path */
  path: string;
  /** basename of path */
  name: string;
  /** total sessions across all agents */
  sessions: number;
  /** ms timestamp of most recent session */
  lastSeen: number;
  /** breakdown per agent */
  agents: ProjectAgentUsage[];
  /** optional git info if known */
  gitBranch?: string;
  gitOrigin?: string;
}

export interface ProjectsSummary {
  projects: Project[];
  totalProjects: number;
  totalSessions: number;
}

const CACHE: { at: number; data: ProjectsSummary | null } = { at: 0, data: null };
const TTL_MS = 30_000;

interface SessionRecord {
  agentId: string;
  cwd: string;
  ts: number;
  gitBranch?: string;
  gitOrigin?: string;
}

export async function getProjectsSummary(): Promise<ProjectsSummary> {
  if (CACHE.data && Date.now() - CACHE.at < TTL_MS) return CACHE.data;

  const records: SessionRecord[] = [];
  records.push(...scanCopilot());
  records.push(...scanCodex());
  for (const def of REGISTRY) {
    if (def.integration?.activity !== 'pi') continue;
    const data = readPiSessions(def.integration.sessionPaths ?? []);
    records.push(...data.projects);
    setIntegrationIssues(def.id, 'activity', data.issues);
  }

  const map = new Map<string, Project>();
  for (const r of records) {
    const norm = normalizePath(r.cwd);
    if (!norm) continue;
    const windows = isWindowsPath(norm);
    const id = windows ? norm.toLowerCase() : norm;
    let p = map.get(id);
    if (!p) {
      p = {
        id,
        path: norm,
        name: (windows ? path.win32 : path.posix).basename(norm) || norm,
        sessions: 0,
        lastSeen: 0,
        agents: [],
        gitBranch: r.gitBranch,
        gitOrigin: r.gitOrigin,
      };
      map.set(id, p);
    }
    p.sessions++;
    if (r.ts > p.lastSeen) p.lastSeen = r.ts;
    if (r.gitBranch && !p.gitBranch) p.gitBranch = r.gitBranch;
    if (r.gitOrigin && !p.gitOrigin) p.gitOrigin = r.gitOrigin;
    let usage = p.agents.find((a) => a.agentId === r.agentId);
    if (!usage) {
      usage = { agentId: r.agentId, sessions: 0, lastSeen: 0 };
      p.agents.push(usage);
    }
    usage.sessions++;
    if (r.ts > usage.lastSeen) usage.lastSeen = r.ts;
  }

  const projects = [...map.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  for (const p of projects) p.agents.sort((a, b) => b.sessions - a.sessions);

  const data: ProjectsSummary = {
    projects,
    totalProjects: projects.length,
    totalSessions: records.length,
  };
  CACHE.at = Date.now();
  CACHE.data = data;
  return data;
}

export function invalidateProjectsCache() {
  CACHE.at = 0;
  CACHE.data = null;
}

function isWindowsPath(p: string): boolean {
  return /^[a-z]:[\\/]/i.test(p) || /^\\\\/.test(p);
}

function normalizePath(p: string): string {
  if (!p || typeof p !== 'string') return '';
  let n = p.trim();
  if (!n) return '';
  if (!isWindowsPath(n)) return path.posix.normalize(n).replace(/\/+$/, '') || '/';
  n = path.win32.normalize(n);
  // capitalize drive letter
  if (/^[a-z]:\\/.test(n)) n = n[0].toUpperCase() + n.slice(1);
  // strip trailing separator
  if (n.length > 3 && (n.endsWith('\\') || n.endsWith('/'))) n = n.slice(0, -1);
  return n;
}

function scanCopilot(): SessionRecord[] {
  const out: SessionRecord[] = [];
  const root = path.join(HOME, '.copilot', 'session-state');
  if (!fs.existsSync(root)) return out;
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = path.join(root, d.name, 'events.jsonl');
    if (!fs.existsSync(file)) continue;
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(2048);
      const n = fs.readSync(fd, buf, 0, 2048, 0);
      fs.closeSync(fd);
      const head = buf.slice(0, n).toString('utf8');
      const firstLine = head.split(/\r?\n/, 1)[0];
      if (!firstLine) continue;
      let obj: any;
      try {
        obj = JSON.parse(firstLine);
      } catch {
        continue;
      }
      if (obj?.type !== 'session.start') continue;
      const cwd = obj?.data?.context?.cwd || obj?.data?.cwd;
      if (!cwd) continue;
      const tsRaw = obj?.timestamp || obj?.data?.startTime;
      const ts = tsRaw ? new Date(tsRaw).getTime() : fs.statSync(file).mtimeMs;
      out.push({ agentId: 'copilot-cli', cwd, ts: isNaN(ts) ? Date.now() : ts });
    } catch {}
  }
  return out;
}

function scanCodex(): SessionRecord[] {
  const out: SessionRecord[] = [];
  const dir = path.join(HOME, '.codex');
  if (!fs.existsSync(dir)) return out;
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^state_.*\.sqlite$/.test(f));
  } catch {
    return out;
  }
  for (const f of files) {
    const dbPath = path.join(dir, f);
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db
          .prepare(
            'SELECT cwd, updated_at_ms, git_branch, git_origin_url FROM threads WHERE cwd IS NOT NULL AND cwd != ""',
          )
          .all() as any[];
        for (const r of rows) {
          out.push({
            agentId: 'codex-cli',
            cwd: String(r.cwd),
            ts: Number(r.updated_at_ms) || Date.now(),
            gitBranch: r.git_branch ? String(r.git_branch) : undefined,
            gitOrigin: r.git_origin_url ? String(r.git_origin_url) : undefined,
          });
        }
      } catch {}
      db.close();
    } catch {}
  }
  return out;
}

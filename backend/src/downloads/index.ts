import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { REGISTRY } from '../discovery/registry.js';

// ─── Types ───────────────────────────────────────────────────────────────────

// What an external item is. Drives the badge + filtering in the UI.
//   install   — a package added via a package manager (npm/pip/brew/…)
//   extension — a VS Code / Cursor extension installed via CLI
//   download  — a generic file fetched over the network (curl/wget/iwr)
//   document  — a downloaded document/data file (.pdf/.csv/.docx/…)
//   model     — a model weights file or model pull (ollama/huggingface/.gguf/…)
//   dataset   — a downloaded dataset (huggingface datasets, .parquet, …)
export type DownloadKind =
  | 'install'
  | 'extension'
  | 'download'
  | 'document'
  | 'model'
  | 'dataset';

// A parsed item before it is persisted. Agent attribution is required.
export interface DownloadEvent {
  kind: DownloadKind;
  manager: string;
  name: string;
  version?: string;
  target?: string;
  status: string;
  agentId?: string;
  sessionId?: string;
  ts?: number;
  command?: string;
  source?: string;
  notes?: string;
  riskFlags?: string[];
}

export interface DownloadRow {
  id: number;
  agentId: string;
  sessionId: string | null;
  ts: number;
  kind: DownloadKind;
  manager: string;
  name: string;
  version: string | null;
  target: string | null;
  command: string | null;
  source: string | null;
  status: string;
  riskFlags: string[];
  notes: string | null;
}

export interface ListDownloadsOpts {
  agentId?: string;
  manager?: string;
  kind?: string;
  q?: string;
  sinceMs?: number;
  riskOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface DeleteDownloadsOpts {
  id?: number;
  agentId?: string;
  all?: boolean;
}

// One-time cleanup: prior versions of the scanner inserted "system" rows with a
// NULL agent_id. The tab is strictly agent-attributed, so evict any leftover
// rows on module load. Idempotent — no-op once the table is clean.
try {
  db.prepare('DELETE FROM downloads WHERE agent_id IS NULL').run();
} catch {}

const MAX_CMD_CHARS = 4000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function clamp(s: string, max = MAX_CMD_CHARS): string {
  return s.length <= max ? s : s.slice(0, max) + `…[${s.length - max} more]`;
}

function dedupKey(e: DownloadEvent): string {
  // Identity of an item is the (manager, name, version, target, kind) tuple.
  // Agent and timestamp are deliberately excluded so the same package installed
  // multiple times (or re-detected next scan) doesn't duplicate.
  const h = crypto.createHash('sha1');
  h.update(e.manager);
  h.update('|');
  h.update(e.name.toLowerCase());
  h.update('|');
  h.update(e.version || '');
  h.update('|');
  h.update(e.target || '');
  h.update('|');
  h.update(e.kind);
  return h.digest('hex');
}

// ─── Target classification ───────────────────────────────────────────────────

const MODEL_EXTS = /\.(gguf|safetensors|onnx|pt|pth|ckpt|bin|h5|tflite|mlmodel)$/i;
const DATASET_EXTS = /\.(parquet|arrow|tfrecord|jsonl)$/i;
const DOC_EXTS =
  /\.(pdf|docx?|pptx?|xlsx?|csv|tsv|txt|md|rtf|odt|epub|zip|tar|gz|tgz|7z|rar)$/i;

// Decide the kind for a generic URL download by inspecting its file extension
// and host. Falls back to 'download' when nothing matches.
function classifyDownload(url: string): DownloadKind {
  const clean = url.split(/[?#]/)[0];
  if (MODEL_EXTS.test(clean) || /huggingface\.co|ollama\.com/i.test(url)) return 'model';
  if (DATASET_EXTS.test(clean)) return 'dataset';
  if (DOC_EXTS.test(clean)) return 'document';
  return 'download';
}

// ─── Risk heuristics ─────────────────────────────────────────────────────────

const EXECUTABLE_EXTS = /\.(exe|sh|ps1|msi|bat|cmd|scr|run|bash|app|dmg|pkg)$/i;
const UNTRUSTED_HOST =
  /(?:raw\.githubusercontent\.com|raw\.github\.com|gist\.github(?:usercontent)?\.com|pastebin\.com|paste\.ee|transfer\.sh|0x0\.st|anonfiles|bit\.ly|tinyurl\.com|t\.co)/i;
const IP_LITERAL_HOST = /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\//i;

// Returns an array of risk-flag codes for an event. Empty array = no flags.
function computeRisk(e: DownloadEvent): string[] {
  const flags = new Set<string>();
  const cmd = e.command || '';
  const target = e.target || '';
  const haystack = `${target} ${cmd}`;

  // Loopback/localhost targets are local API calls, not risky external pulls.
  const isLoopback = /https?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)(?::\d+)?\b/i.test(target);

  // Insecure transport (ignoring loopback).
  if (!isLoopback && /\bhttp:\/\//i.test(haystack) && !/\bhttp:\/\/(?:localhost|127\.0\.0\.1)/i.test(haystack)) {
    flags.add('insecure-http');
  }

  // Piped installer: curl/wget … | sh|bash|pwsh|powershell.
  if (/\b(?:curl|wget|iwr|invoke-webrequest)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|pwsh|powershell)\b/i.test(cmd)) {
    flags.add('piped-install');
  }

  // Executable / script payload by extension.
  const targetClean = target.split(/[?#]/)[0];
  if (EXECUTABLE_EXTS.test(targetClean) || EXECUTABLE_EXTS.test(e.name)) {
    flags.add('executable-payload');
  }

  // Untrusted / raw host, or a bare (non-loopback) IP literal.
  if (!isLoopback && (UNTRUSTED_HOST.test(haystack) || IP_LITERAL_HOST.test(target))) {
    flags.add('untrusted-host');
  }

  // Global package install.
  if (/(?:^|\s)(?:-g|--global)(?:\s|$)/.test(cmd) || /\(global\)/.test(target)) {
    flags.add('global-install');
  }

  return [...flags];
}

// ─── Command matching ────────────────────────────────────────────────────────

function matchInstallCommand(rawCmd: string): DownloadEvent[] {
  const cmd = rawCmd.trim();
  if (!cmd) return [];
  const out: DownloadEvent[] = [];

  // npm install / npm i / npm add  (also yarn add, pnpm add, bun add)
  const npmRe = /\b(npm|pnpm|yarn|bun)\s+(install|i|add)\s+([^\n&;|]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = npmRe.exec(cmd))) {
    const tool = m[1].toLowerCase();
    const rest = m[3].trim();
    const args = rest.split(/\s+/).filter(Boolean);
    const isGlobal = args.includes('-g') || args.includes('--global');
    const pkgs = args.filter((a) => !a.startsWith('-'));
    for (const pkg of pkgs) {
      let name = pkg;
      let version: string | undefined;
      if (pkg.startsWith('@')) {
        // scoped package: @scope/name[@version]
        const at = pkg.indexOf('@', 1);
        if (at !== -1) {
          name = pkg.slice(0, at);
          version = pkg.slice(at + 1);
        }
      } else if (pkg.includes('@')) {
        const [n, v] = pkg.split('@');
        name = n;
        version = v;
      }
      out.push({
        kind: 'install',
        manager: tool,
        name,
        version: version || undefined,
        target: isGlobal ? `${tool} (global)` : `${tool} (project)`,
        status: 'installed',
      });
    }
  }

  // pip / pip3 / pipx / uv install
  const pipRe = /\b(pip3?|pipx|uv)\s+(install|add)\s+([^\n&;|]+)/gi;
  while ((m = pipRe.exec(cmd))) {
    const tool = m[1].toLowerCase();
    const rest = m[3].trim();
    const args = rest.split(/\s+/).filter((a) => a && !a.startsWith('-') && !a.includes('://'));
    for (const pkg of args) {
      const eqMatch = pkg.match(/^([^=<>]+)(?:(==|>=|<=|~=|>|<)([^\s]+))?$/);
      const name = (eqMatch?.[1] || pkg).trim();
      const version = eqMatch?.[3];
      if (!name) continue;
      out.push({ kind: 'install', manager: 'pip', name, version, status: 'installed', target: tool });
    }
  }

  // Homebrew
  const brewRe = /\bbrew\s+install\s+([^\n&;|]+)/gi;
  while ((m = brewRe.exec(cmd))) {
    for (const pkg of m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'))) {
      out.push({ kind: 'install', manager: 'brew', name: pkg, status: 'installed' });
    }
  }

  // winget
  const wingetRe = /\bwinget\s+install\s+([^\n&;|]+)/gi;
  while ((m = wingetRe.exec(cmd))) {
    const args = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
    for (const id of args) {
      out.push({ kind: 'install', manager: 'winget', name: id, status: 'installed' });
    }
  }

  // chocolatey
  const chocoRe = /\bchoco\s+install\s+([^\n&;|]+)/gi;
  while ((m = chocoRe.exec(cmd))) {
    for (const pkg of m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'))) {
      out.push({ kind: 'install', manager: 'choco', name: pkg, status: 'installed' });
    }
  }

  // scoop
  const scoopRe = /\bscoop\s+install\s+([^\n&;|]+)/gi;
  while ((m = scoopRe.exec(cmd))) {
    for (const pkg of m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'))) {
      out.push({ kind: 'install', manager: 'scoop', name: pkg, status: 'installed' });
    }
  }

  // cargo
  const cargoRe = /\bcargo\s+install\s+([^\n&;|]+)/gi;
  while ((m = cargoRe.exec(cmd))) {
    for (const pkg of m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'))) {
      out.push({ kind: 'install', manager: 'cargo', name: pkg, status: 'installed' });
    }
  }

  // gem
  const gemRe = /\bgem\s+install\s+([^\n&;|]+)/gi;
  while ((m = gemRe.exec(cmd))) {
    for (const pkg of m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'))) {
      out.push({ kind: 'install', manager: 'gem', name: pkg, status: 'installed' });
    }
  }

  // Linux package managers — kept for cross-platform agents that may shell out.
  const linuxRe = /\b(apt|apt-get|dnf|yum|pacman)\s+(?:-[A-Za-z]+\s+)*(install|-S)\s+([^\n&;|]+)/gi;
  while ((m = linuxRe.exec(cmd))) {
    const mgr = m[1].toLowerCase();
    for (const pkg of m[3].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'))) {
      out.push({
        kind: 'install',
        manager: mgr.startsWith('apt') ? 'apt' : mgr,
        name: pkg,
        status: 'installed',
      });
    }
  }

  // VS Code / Cursor extensions installed via CLI.
  const extRe = /\b(code|cursor|code-insiders)\s+--install-extension\s+([^\s&;|]+)/gi;
  while ((m = extRe.exec(cmd))) {
    const tool = m[1].toLowerCase();
    const ext = m[2];
    const manager = tool === 'cursor' ? 'cursor' : 'vscode';
    out.push({ kind: 'extension', manager, name: ext, status: 'installed' });
  }

  // ── Models & datasets ──
  // ollama pull / ollama run <model>
  const ollamaRe = /\bollama\s+(?:pull|run)\s+([^\s&;|]+)/gi;
  while ((m = ollamaRe.exec(cmd))) {
    out.push({ kind: 'model', manager: 'ollama', name: m[1], status: 'pulled' });
  }
  // huggingface-cli download / hf download  →  <repo_id> [<file>]
  const hfRe = /\b(?:huggingface-cli|hf)\s+download\s+(?:--repo-type[= ](\w+)\s+)?([^\s&;|]+)/gi;
  while ((m = hfRe.exec(cmd))) {
    const repoType = (m[1] || '').toLowerCase();
    const kind: DownloadKind = repoType === 'dataset' ? 'dataset' : 'model';
    out.push({ kind, manager: 'huggingface', name: m[2], target: 'huggingface.co', status: 'downloaded' });
  }
  // git clone of a huggingface.co repo → model/dataset
  const hfCloneRe = /\bgit\s+clone\s+(https?:\/\/huggingface\.co\/([^\s&;|]+))/gi;
  while ((m = hfCloneRe.exec(cmd))) {
    const repoPath = m[2];
    const kind: DownloadKind = /^datasets\//i.test(repoPath) ? 'dataset' : 'model';
    out.push({
      kind,
      manager: 'huggingface',
      name: repoPath.replace(/^datasets\//i, ''),
      target: m[1],
      status: 'cloned',
    });
  }

  // ── Raw network downloads ──
  // curl URL (any flags), wget, PowerShell Invoke-WebRequest / iwr / Start-BitsTransfer.
  // Loopback/localhost URLs are local API calls (not external pulls) and are skipped.
  const urlRe = /https?:\/\/[^\s"')]+/gi;
  const isLoopbackUrl = (url: string) => {
    const m = /^https?:\/\/([^/?#:;,\s]+)/i.exec(url);
    if (!m) return false;
    const host = m[1].toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  };
  const pushUrl = (url: string, manager: string) => {
    if (isLoopbackUrl(url)) return;
    const name = url.split('/').pop() || url;
    out.push({ kind: classifyDownload(url), manager, name, target: url, status: 'downloaded' });
  };
  if (/\bcurl\b/i.test(cmd)) {
    let u: RegExpExecArray | null;
    urlRe.lastIndex = 0;
    while ((u = urlRe.exec(cmd))) pushUrl(u[0], 'curl');
  }
  if (/\bwget\b/i.test(cmd)) {
    urlRe.lastIndex = 0;
    let u: RegExpExecArray | null;
    while ((u = urlRe.exec(cmd))) pushUrl(u[0], 'wget');
  }
  const iwrRe = /\b(Invoke-WebRequest|iwr|Start-BitsTransfer)\b[^\n;|&]*?(https?:\/\/[^\s"';)]+)/gi;
  while ((m = iwrRe.exec(cmd))) {
    pushUrl(m[2], 'powershell');
  }

  // De-dupe within the same command (e.g. `npm i a b a`).
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = `${p.manager}|${p.name}|${p.version || ''}|${p.kind}|${p.target || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ─── Transcript walking ──────────────────────────────────────────────────────

// Walk one agent's transcript file and yield install/download events. We extract
// shell-call evidence from the same JSON shapes the activity parser knows about,
// so attribution is naturally session-accurate.
function scanAgentTranscript(agentId: string, file: string): DownloadEvent[] {
  let raw: string;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) return [];
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const events: DownloadEvent[] = [];
  const baseTs = (() => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return Date.now();
    }
  })();
  const lines = raw.split(/\r?\n/);
  let sessionId: string | undefined;
  let lineIdx = 0;
  for (const line of lines) {
    lineIdx++;
    const t = line.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) continue;
    let obj: any;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const ts =
      Number(obj.ts) ||
      Number(obj.timestamp) ||
      (obj.created_at ? new Date(obj.created_at).getTime() : 0) ||
      baseTs;
    if (obj.type === 'session.start' && obj.sessionId) sessionId = String(obj.sessionId);
    const data = obj.data || obj;
    const candidates: string[] = [];
    if (typeof data.command === 'string') candidates.push(data.command);
    if (Array.isArray(data.command)) candidates.push(data.command.join(' '));
    if (data.arguments && typeof data.arguments.command === 'string') candidates.push(data.arguments.command);
    if (data.input && typeof data.input.command === 'string') candidates.push(data.input.command);
    if (Array.isArray(data.toolRequests)) {
      for (const tr of data.toolRequests) {
        const args = tr.arguments || tr.input || {};
        if (typeof args.command === 'string') candidates.push(args.command);
        if (Array.isArray(args.command)) candidates.push(args.command.join(' '));
      }
    }
    // Claude tool_use blocks
    if (Array.isArray(obj.message?.content)) {
      for (const c of obj.message.content) {
        if (c?.type === 'tool_use' && c.input?.command) {
          const v = c.input.command;
          candidates.push(typeof v === 'string' ? v : Array.isArray(v) ? v.join(' ') : '');
        }
      }
    }
    for (const cmd of candidates) {
      if (!cmd) continue;
      for (const p of matchInstallCommand(cmd)) {
        events.push({
          ...p,
          agentId,
          sessionId,
          ts,
          command: clamp(cmd),
          source: `${file}#${lineIdx}`,
        });
      }
    }
  }
  // Fallback: catch shell command lines that aren't embedded in JSON (e.g. aider
  // markdown transcripts), but only when the file isn't JSON-ish.
  if (events.length === 0) {
    const head = raw.slice(0, 256).trim();
    if (head[0] !== '{' && head[0] !== '[') {
      for (const line of raw.split(/\r?\n/)) {
        for (const p of matchInstallCommand(line)) {
          events.push({
            ...p,
            agentId,
            ts: baseTs,
            command: clamp(line.trim()),
            source: file,
          });
        }
      }
    }
  }
  return events;
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
    if (e.isDirectory()) await walkFiles(full, maxDepth, fn, depth + 1, counter);
    else if (e.isFile()) {
      try {
        const stat = fs.statSync(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        if (!/\.(jsonl?|md)$/i.test(full)) continue;
        fn(full);
        if (++counter.n % 15 === 0) await yieldToLoop();
      } catch {}
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function scanDownloads(): Promise<{ inserted: number; scanned: number }> {
  const collected: DownloadEvent[] = [];
  let scanned = 0;
  // Agent-attributed: re-walk transcripts (same roots Activity uses).
  for (const def of REGISTRY) {
    for (const lp of def.logPaths || []) {
      if (!lp || !fs.existsSync(lp)) continue;
      try {
        if (fs.statSync(lp).isFile()) {
          scanned++;
          collected.push(...scanAgentTranscript(def.id, lp));
        } else {
          await walkFiles(lp, 5, (f) => {
            scanned++;
            collected.push(...scanAgentTranscript(def.id, f));
          });
        }
      } catch {}
    }
  }

  let inserted = 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO downloads
     (dedup_key, agent_id, session_id, ts, kind, manager, name, version, target, command, source, status, risk_flags, notes)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const e of collected) {
    if (!e.name) continue;
    if (!/[a-zA-Z0-9]/.test(e.name)) continue; // drop punctuation-only matches parsed from prose
    if (!e.agentId) continue; // agent-only: defense in depth if a parser omits it
    const key = dedupKey(e);
    const riskFlags = e.riskFlags || computeRisk(e);
    const r = ins.run(
      key,
      e.agentId,
      e.sessionId || null,
      e.ts ?? Date.now(),
      e.kind,
      e.manager,
      e.name,
      e.version || null,
      e.target || null,
      e.command || null,
      e.source || null,
      e.status,
      riskFlags.length ? JSON.stringify(riskFlags) : null,
      e.notes || null,
    );
    if (r.changes > 0) inserted++;
  }
  return { inserted, scanned };
}

function parseFlags(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function listDownloads(opts: ListDownloadsOpts) {
  // Belt-and-suspenders: every row must be agent-attributed. Even if a future
  // parser ever inserts a NULL agent_id, the WHERE clause hides it.
  const where: string[] = ['agent_id IS NOT NULL'];
  const args: any[] = [];
  if (opts.agentId) {
    where.push('agent_id = ?');
    args.push(opts.agentId);
  }
  if (opts.manager) {
    const list = String(opts.manager).split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length === 1) {
      where.push('manager = ?');
      args.push(list[0]);
    } else if (list.length > 1) {
      where.push(`manager IN (${list.map(() => '?').join(',')})`);
      args.push(...list);
    }
  }
  if (opts.kind) {
    const list = String(opts.kind).split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length === 1) {
      where.push('kind = ?');
      args.push(list[0]);
    } else if (list.length > 1) {
      where.push(`kind IN (${list.map(() => '?').join(',')})`);
      args.push(...list);
    }
  }
  if (opts.riskOnly) {
    where.push("risk_flags IS NOT NULL AND risk_flags != '' AND risk_flags != '[]'");
  }
  if (opts.sinceMs && opts.sinceMs > 0) {
    where.push('ts >= ?');
    args.push(Date.now() - opts.sinceMs);
  }
  if (opts.q && opts.q.trim()) {
    where.push('(name LIKE ? OR target LIKE ? OR command LIKE ?)');
    const like = `%${opts.q.trim()}%`;
    args.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const offset = Math.max(opts.offset ?? 0, 0);

  const total = (db.prepare(`SELECT COUNT(*) as c FROM downloads ${whereSql}`).get(...args) as { c: number }).c;
  const rawRows = db
    .prepare(`SELECT id, agent_id as agentId, session_id as sessionId, ts, kind, manager, name,
              version, target, command, source, status, risk_flags as riskFlags, notes
       FROM downloads
       ${whereSql}
       ORDER BY ts DESC
       LIMIT ${limit} OFFSET ${offset}`)
    .all(...args) as any[];
  const rows: DownloadRow[] = rawRows.map((r) => ({ ...r, riskFlags: parseFlags(r.riskFlags) }));

  const agents = db
    .prepare(`SELECT agent_id as agentId, COUNT(*) as count
       FROM downloads ${whereSql}
       GROUP BY agent_id
       ORDER BY count DESC`)
    .all(...args);
  const byManager = db
    .prepare(`SELECT manager, COUNT(*) as count
       FROM downloads ${whereSql}
       GROUP BY manager
       ORDER BY count DESC`)
    .all(...args);
  const byKind = db
    .prepare(`SELECT kind, COUNT(*) as count
       FROM downloads ${whereSql}
       GROUP BY kind
       ORDER BY count DESC`)
    .all(...args);
  const flagged = (db
    .prepare(`SELECT COUNT(*) as c FROM downloads ${whereSql}${whereSql ? ' AND' : ' WHERE'} risk_flags IS NOT NULL AND risk_flags != '' AND risk_flags != '[]'`)
    .get(...args) as { c: number }).c;

  return { total, rows, agents, byManager, byKind, flagged };
}

export function deleteDownloads(opts: DeleteDownloadsOpts): number {
  if (opts.id) {
    return db.prepare('DELETE FROM downloads WHERE id = ?').run(opts.id).changes as number;
  }
  if (opts.agentId) {
    return db.prepare('DELETE FROM downloads WHERE agent_id = ?').run(opts.agentId).changes as number;
  }
  if (opts.all) {
    return db.prepare('DELETE FROM downloads').run().changes as number;
  }
  return 0;
}

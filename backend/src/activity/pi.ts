import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { UsageEvent } from '../tokens/index.js';
import type { ActivityEvent } from './index.js';
import { object, readIntegrationFile } from '../discovery/integrationFiles.js';

export interface PiSessionData {
  activity: ActivityEvent[];
  usage: UsageEvent[];
  projects: { agentId: string; sessionId: string; cwd: string; ts: number }[];
  issues: string[];
}

const agentId = 'pi-coding-agent';
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function content(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 100_000);
  if (!Array.isArray(value)) return '';
  return value.flatMap((part) => {
    const block = object(part);
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  }).join('\n').slice(0, 100_000);
}

export function parsePiSession(text: string): PiSessionData {
  const result: PiSessionData = { activity: [], usage: [], projects: [], issues: [] };
  const lines = text.split(/\r?\n/);
  const header = object(JSON.parse(lines[0]));
  if (!header || header.type !== 'session' || ![2, 3].includes(Number(header.version)) ||
      typeof header.id !== 'string' || !header.id) throw new Error('Unsupported Pi session header');
  let lastTs = Date.parse(String(header.timestamp));
  if (!Number.isFinite(lastTs)) throw new Error('Invalid Pi session timestamp');
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = object(JSON.parse(lines[i]));
      if (!entry || typeof entry.id !== 'string' || typeof entry.timestamp !== 'string') throw new Error('Invalid entry');
      const ts = Date.parse(entry.timestamp);
      if (!Number.isFinite(ts)) throw new Error('Invalid timestamp');
      lastTs = Math.max(lastTs, ts);
      const message = entry.type === 'message' ? object(entry.message) : undefined;
      // Copies/forks retain entry identity and timestamp. Context replay is not new usage.
      const identity = createHash('sha256').update(`${entry.id}\0${entry.timestamp}`).digest('hex');
      if (seen.has(identity)) continue;
      seen.add(identity);
      const model = typeof message?.model === 'string' ? message.model
        : typeof entry.model === 'string' ? entry.model : undefined;
      if (message) {
        const role = message.role === 'toolResult' ? 'tool' : message.role;
        const body = content(message.content);
        if (['user', 'assistant', 'system', 'tool'].includes(String(role)) && body) {
          result.activity.push({
            agentId, sessionId: header.id, ts, role: role as ActivityEvent['role'],
            content: body, model, source: `pi:${identity}`,
          });
        }
      }
      const usage = object(message?.usage ?? (['usage', 'compaction', 'branch_summary'].includes(String(entry.type)) ? entry.usage : undefined));
      if (!usage) continue;
      if (![usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(count)) throw new Error('Invalid usage');
      result.usage.push({
        agentId, ts, model, inputTokens: Number(usage.input), outputTokens: Number(usage.output),
        cacheReadTokens: Number(usage.cacheRead), cacheCreateTokens: Number(usage.cacheWrite),
        messageId: `pi-${identity}`, source: `pi:${identity}`,
        project: typeof header.cwd === 'string' ? header.cwd : undefined,
      });
    } catch {
      result.issues.push('A Pi session contains an invalid or incomplete record. Valid records were retained; the file will be retried.');
    }
  }
  if (typeof header.cwd === 'string' && (path.posix.isAbsolute(header.cwd) || path.win32.isAbsolute(header.cwd))) {
    result.projects.push({ agentId, sessionId: header.id, cwd: header.cwd, ts: lastTs });
  }
  result.issues = [...new Set(result.issues)];
  return result;
}

export function readPiSessions(roots: string[]): PiSessionData {
  const result: PiSessionData = { activity: [], usage: [], projects: [], issues: [] };
  let files = 0;
  let bytes = 0;
  let entriesVisited = 0;
  const visit = (root: string, depth: number) => {
    if (depth > 3) { result.issues.push('Pi session directory depth limit reached.'); return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      result.issues.push('A Pi session directory could not be read. Check local permissions.');
      return;
    }
    for (const entry of entries) {
      if (++entriesVisited > 2000 || files >= 500 || bytes >= 64 * 1024 * 1024) {
        result.issues.push('Pi scan limit reached (2000 entries, 500 files, or 64 MiB). Some history is unavailable.');
        return;
      }
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) { visit(file, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      files++;
      try {
        const text = readIntegrationFile(file, Math.min(16 * 1024 * 1024, 64 * 1024 * 1024 - bytes));
        if (text === undefined) continue;
        bytes += Buffer.byteLength(text);
        const data = parsePiSession(text);
        result.activity.push(...data.activity);
        result.usage.push(...data.usage);
        result.projects.push(...data.projects);
        result.issues.push(...data.issues);
      } catch {
        result.issues.push('A Pi session could not be imported (unsupported schema, read limit, or permissions).');
      }
    }
  };
  for (const root of [...new Set(roots)]) visit(root, 0);
  const activity = new Map<string, ActivityEvent>();
  for (const event of result.activity) if (!activity.has(event.source)) activity.set(event.source, event);
  result.activity = [...activity.values()];
  result.usage = [...new Map(result.usage.map((event) => [event.messageId, event])).values()];
  result.projects = [...new Map(result.projects.map((project) => [project.sessionId, project])).values()];
  result.issues = [...new Set(result.issues)];
  return result;
}

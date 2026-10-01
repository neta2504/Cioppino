import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../config.js';

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    vendor TEXT,
    kind TEXT,
    installed INTEGER NOT NULL DEFAULT 0,
    running INTEGER NOT NULL DEFAULT 0,
    version TEXT,
    bin_path TEXT,
    config_path TEXT,
    pids TEXT,
    last_seen INTEGER,
    metadata TEXT
  );
`);

// Migrate older access_items rows that may not have access_kind/provider_id columns.
try { db.exec('ALTER TABLE access_items ADD COLUMN access_kind TEXT'); } catch {}
try { db.exec('ALTER TABLE access_items ADD COLUMN provider_id TEXT'); } catch {}
// Migrate older usage_events rows for cache-token tracking + message-id dedupe.
try { db.exec('ALTER TABLE usage_events ADD COLUMN cache_read_tokens INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE usage_events ADD COLUMN cache_create_tokens INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE usage_events ADD COLUMN message_id TEXT'); } catch {}
try { db.exec('ALTER TABLE usage_events ADD COLUMN project TEXT'); } catch {}
// Activity-event token estimate column (added later in CREATE TABLE for fresh installs;
// ALTER here covers existing DBs). Backfill happens after CREATE TABLE below.
try { db.exec('ALTER TABLE activity_events ADD COLUMN tokens INTEGER DEFAULT 0'); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS access_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    category TEXT NOT NULL,
    label TEXT NOT NULL,
    detail TEXT,
    source_path TEXT,
    sensitive INTEGER DEFAULT 0,
    access_kind TEXT,
    provider_id TEXT,
    last_seen INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_access_agent ON access_items(agent_id);

  CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    model TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_create_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    estimated INTEGER DEFAULT 1,
    message_id TEXT,
    source TEXT,
    project TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
  CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage_events(agent_id);

  CREATE TABLE IF NOT EXISTS perf_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    pid INTEGER,
    ts INTEGER NOT NULL,
    cpu REAL,
    rss_mb REAL,
    threads INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_perf_ts ON perf_samples(ts);
  CREATE INDEX IF NOT EXISTS idx_perf_agent_ts ON perf_samples(agent_id, ts);

  CREATE TABLE IF NOT EXISTS gpu_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    util REAL,
    mem_used_mb REAL,
    name TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gpu_ts ON gpu_samples(ts);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Idempotent migrations for older DBs that may not have these columns.
try { db.exec('ALTER TABLE access_items ADD COLUMN access_kind TEXT'); } catch {}
try { db.exec('ALTER TABLE access_items ADD COLUMN provider_id TEXT'); } catch {}
try { db.exec('ALTER TABLE perf_samples ADD COLUMN gpu REAL DEFAULT 0'); } catch {}

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string) {
  db.prepare(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(key, value);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS activity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    session_id TEXT,
    ts INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    content_preview TEXT NOT NULL,
    model TEXT,
    source TEXT NOT NULL,
    dedup_key TEXT NOT NULL UNIQUE,
    tokens INTEGER DEFAULT 0,
    audio INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_activity_agent_ts ON activity_events(agent_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_events(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_activity_session ON activity_events(session_id);
`);

// Idempotent migration for older DBs that don't have the audio column.
// Must happen BEFORE creating the audio index, since the column may not exist
// yet on databases created before this column was added.
try { db.exec('ALTER TABLE activity_events ADD COLUMN audio INTEGER DEFAULT 0'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_activity_audio ON activity_events(audio)'); } catch {}

// Backfill token estimates for any pre-existing rows that don't have one yet.
try {
  db.exec(
    "UPDATE activity_events SET tokens = CAST((length(content) + 3) / 4 AS INTEGER) WHERE tokens IS NULL OR tokens = 0",
  );
} catch {}

// One-time reset + strict re-detection. Earlier versions of detectAudio were
// too loose (matched `"type":"audio"`, `audio_url`, etc. — which appear in
// code/docs as plain text). Bump this version when the detection rule
// changes; we wipe `audio` flags and re-flag only rows whose stored content
// has a real base64 audio blob. Gated by a setting so it runs once.
const AUDIO_DETECTION_VERSION = '2';
try {
  if (getSetting('audio_detection_v') !== AUDIO_DETECTION_VERSION) {
    db.exec('UPDATE activity_events SET audio = 0 WHERE audio = 1');
    db.exec(`UPDATE activity_events SET audio = 1
             WHERE content GLOB 'data:audio/*;base64,*'
                OR content LIKE '%data:audio/mp3%;base64,%'
                OR content LIKE '%data:audio/wav%;base64,%'
                OR content LIKE '%data:audio/ogg%;base64,%'
                OR content LIKE '%data:audio/webm%;base64,%'
                OR content LIKE '%data:audio/m4a%;base64,%'
                OR content LIKE '%data:audio/opus%;base64,%'
                OR content LIKE '%data:audio/mpeg%;base64,%'
                OR content LIKE '%data:audio/aac%;base64,%'
                OR content LIKE '%data:audio/flac%;base64,%'`);
    setSetting('audio_detection_v', AUDIO_DETECTION_VERSION);
  }
} catch {}

// Downloads — every external item an agent pulled onto the device
// (package installs, IDE extensions, web downloads, documents/files,
// models/datasets). Populated by parsing agent transcripts for shell commands;
// every row is agent-attributed. `risk_flags` is a JSON array of flag codes.
db.exec(`
  CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedup_key TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL,
    session_id TEXT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    manager TEXT NOT NULL,
    name TEXT NOT NULL,
    version TEXT,
    target TEXT,
    command TEXT,
    source TEXT,
    status TEXT NOT NULL,
    risk_flags TEXT,
    notes TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_downloads_agent_ts ON downloads(agent_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_downloads_ts ON downloads(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_downloads_kind ON downloads(kind);
`);

// Idempotent migrations for DBs created by an earlier version of this table.
try { db.exec('ALTER TABLE downloads ADD COLUMN risk_flags TEXT'); } catch {}
// Drop the deprecated size_bytes column (and its data) from existing DBs.
try { db.exec('ALTER TABLE downloads DROP COLUMN size_bytes'); } catch {}

export function pruneOldData() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  db.prepare('DELETE FROM perf_samples WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM gpu_samples WHERE ts < ?').run(cutoff);
}

export function wipeAllData() {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      DELETE FROM agents;
      DELETE FROM access_items;
      DELETE FROM usage_events;
      DELETE FROM perf_samples;
      DELETE FROM gpu_samples;
      DELETE FROM settings;
      DELETE FROM activity_events;
      DELETE FROM downloads;
      DELETE FROM scan_state;
    `);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

// Per-file scan cursor so scanners can skip files that haven't changed since
// the last run (keyed by scanner name + path, compared on mtime + size). This
// turns repeat scans — every boot and every periodic rescan — from "reparse
// every transcript" into "parse only new/changed files".
db.exec(`
  CREATE TABLE IF NOT EXISTS scan_state (
    scanner  TEXT NOT NULL,
    path     TEXT NOT NULL,
    mtime_ms REAL,
    size     INTEGER,
    PRIMARY KEY (scanner, path)
  );
`);

const scanStateGet = db.prepare('SELECT mtime_ms AS m, size AS s FROM scan_state WHERE scanner=? AND path=?');
const scanStatePut = db.prepare(
  'INSERT INTO scan_state(scanner,path,mtime_ms,size) VALUES(?,?,?,?) ' +
    'ON CONFLICT(scanner,path) DO UPDATE SET mtime_ms=excluded.mtime_ms, size=excluded.size',
);

/** True when `file` is unchanged since the scanner last recorded it. */
export function isFileUnchanged(scanner: string, file: string, mtimeMs: number, size: number): boolean {
  const row = scanStateGet.get(scanner, file) as { m: number; s: number } | undefined;
  return !!row && row.m === mtimeMs && row.s === size;
}

/** Record `file`'s current mtime/size so future scans can skip it if unchanged. */
export function recordFileScanned(scanner: string, file: string, mtimeMs: number, size: number) {
  scanStatePut.run(scanner, file, mtimeMs, size);
}

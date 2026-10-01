#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const token = randomBytes(16).toString('hex');
process.env.CIOPPINO_TOKEN = token;
process.env.CIOPPINO_PORT = process.env.CIOPPINO_PORT || '5174';

// Theme is no longer configurable — ocean is the only style.

const distExists = existsSync(join(root, 'frontend', 'dist', 'index.html'));
if (!distExists) {
  console.log('[cioppino] frontend not built yet — run: npm run build:frontend');
}

// Capture stdout so we can detect the "cioppino:listening" marker the
// backend prints from inside its app.listen callback. We still forward
// every line to our own stdout so the user sees backend logs as usual.
// stderr is inherited directly.
const backend = spawn('node', ['backend/dist/server.js'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
  env: process.env,
  shell: false,
});

let stopping = false;
function stopBackend(signal) {
  if (stopping) return;
  stopping = true;
  if (backend.exitCode === null) backend.kill(signal);
  setTimeout(() => {
    if (backend.exitCode === null) backend.kill('SIGKILL');
  }, 5000).unref();
}

process.once('SIGINT', () => stopBackend('SIGINT'));
process.once('SIGTERM', () => stopBackend('SIGTERM'));

backend.on('error', (error) => {
  console.error(`[cioppino] backend failed to start: ${error.message}`);
  process.exit(1);
});
backend.on('exit', (code) => process.exit(code ?? 0));

// Wait for the backend to print a single "cioppino:listening" line — that
// fires from inside the app.listen callback, so as soon as we see it we
// know the socket is accepting connections. Falls back to a 4 s timeout
// so a botched startup doesn't hang the launcher forever.
function waitForListening(timeoutMs = 90000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      backend.stdout.off('data', onData);
      clearTimeout(timer);
      resolve(ok);
    };
    const onData = (buf) => {
      const s = buf.toString();
      process.stdout.write(s);
      if (s.includes('cioppino:listening')) finish(true);
    };
    backend.stdout.on('data', onData);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

await waitForListening();
// After readiness, leave the backend's stdout connected to our own so the
// rest of its log output keeps streaming through.
backend.stdout.pipe(process.stdout);

const url = `http://127.0.0.1:${process.env.CIOPPINO_PORT}/auth?t=${token}`;
console.log(`[cioppino] opening http://127.0.0.1:${process.env.CIOPPINO_PORT}`);

if (process.env.CIOPPINO_NO_OPEN !== '1') {
  const opener =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();
}

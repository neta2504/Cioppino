#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const releaseDir = join(root, 'release');
const windowsArchive = join(releaseDir, `Cioppino-v${version}-windows.zip`);
const macArchive = join(releaseDir, `Cioppino-v${version}-macos.tar.gz`);
const checksumsFile = join(releaseDir, 'SHA256SUMS.txt');
const npmCli = process.env.npm_execpath;
const tempRoot = mkdtempSync(join(tmpdir(), 'cioppino-release-'));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${result.stdout || ''}\n${result.stderr || ''}`,
    );
  }
}

function runNpm(args, cwd) {
  if (!npmCli) throw new Error('Run package verification through npm so npm_execpath is available.');
  run(process.execPath, [npmCli, ...args], cwd);
}

function extractZip(file, destination) {
  mkdirSync(destination, { recursive: true });
  run('tar', ['-xf', file, '-C', destination], root);
}

function extractTar(file, destination) {
  mkdirSync(destination, { recursive: true });
  run('tar', ['-xzf', file, '-C', destination], root);
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function inspectPackage(directory, platform) {
  const expected = [
    'backend/dist/server.js',
    'frontend/dist/index.html',
    'scripts/start.mjs',
    'package.json',
    'package-lock.json',
    'README.md',
    'QUICKSTART.md',
    'Images/Cioppino Icon.png',
    'Images/CioppinoDashboard.png',
    'LICENSE',
    'PRIVACY.md',
    'SECURITY.md',
  ];
  for (const file of expected) {
    assert.ok(existsSync(join(directory, ...file.split('/'))), `${platform}: missing ${file}`);
  }
  const launcher = platform === 'windows' ? 'install-and-run.cmd' : 'install-and-run.command';
  assert.ok(existsSync(join(directory, launcher)), `${platform}: missing ${launcher}`);

  const forbidden = /(^|[\\/])(?:node_modules|auth\.html)(?:[\\/]|$)|\.(?:db|log|pem|p12|pfx)$/i;
  for (const file of walk(directory)) {
    const rel = relative(directory, file);
    assert.equal(forbidden.test(rel), false, `${platform}: forbidden file ${rel}`);
  }
  assert.equal(existsSync(join(directory, 'Images', 'Downloads')), false);
  assert.equal(existsSync(join(directory, 'Images', 'CioppinoDashboardOld.png')), false);

  const runtimePackage = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  assert.equal(runtimePackage.version, version);
  assert.equal(runtimePackage.engines.node, '>=24.0.0');
  assert.equal(runtimePackage.devDependencies, undefined);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForListening(child, output) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Startup timed out\n${output.text}`)), 90_000);
    const check = () => {
      if (!output.text.includes('cioppino:listening')) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Process exited before verification (${code})\n${output.text}`));
    });
  });
}

async function stopChild(child) {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 7_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function capture(child) {
  const output = { text: '' };
  child.stdout.on('data', (chunk) => { output.text += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output.text += chunk.toString(); });
  return output;
}

async function verifyLauncher(directory, dataRoot) {
  const port = await freePort();
  const child = spawn(process.execPath, ['scripts/start.mjs'], {
    cwd: directory,
    env: {
      ...process.env,
      APPDATA: dataRoot,
      HOME: dataRoot,
      USERPROFILE: dataRoot,
      XDG_CONFIG_HOME: dataRoot,
      CIOPPINO_NO_OPEN: '1',
      CIOPPINO_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = capture(child);
  try {
    await waitForListening(child, output);
    assert.equal(output.text.includes('/auth?t='), false, 'Launcher output exposed the authenticated URL');
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
  } finally {
    await stopChild(child);
  }
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
}

async function verifyRuntime(directory) {
  console.log(`[verify] installing production dependencies in ${relative(tempRoot, directory)}`);
  runNpm(['ci', '--omit=dev', '--no-audit', '--no-fund'], directory);

  const dataRoot = join(tempRoot, 'data');
  await verifyLauncher(directory, dataRoot);

  const port = await freePort();
  const token = 'cioppino-release-verification-token';
  const child = spawn(process.execPath, ['backend/dist/server.js'], {
    cwd: directory,
    env: {
      ...process.env,
      APPDATA: dataRoot,
      HOME: dataRoot,
      USERPROFILE: dataRoot,
      XDG_CONFIG_HOME: dataRoot,
      CIOPPINO_PORT: String(port),
      CIOPPINO_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const output = capture(child);
  try {
    await waitForListening(child, output);

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.equal(health.headers.get('referrer-policy'), 'no-referrer');

    const denied = await fetch(`http://127.0.0.1:${port}/api/ready`);
    assert.equal(denied.status, 403);
    const allowed = await fetch(`http://127.0.0.1:${port}/api/ready`, {
      headers: { 'x-cioppino-token': token },
    });
    assert.equal(allowed.status, 200);
  } finally {
    await stopChild(child);
  }
}

try {
  for (const file of [windowsArchive, macArchive, checksumsFile]) {
    assert.ok(existsSync(file), `Missing release artifact: ${basename(file)}`);
  }
  for (const file of [windowsArchive, macArchive]) {
    assert.ok(statSync(file).size < 100 * 1024 * 1024, `${basename(file)} exceeds 100 MiB`);
  }
  const expectedChecksums = new Map(
    readFileSync(checksumsFile, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/);
        assert.ok(match, `Invalid checksum line: ${line}`);
        return [match[2], match[1]];
      }),
  );
  for (const file of [windowsArchive, macArchive]) {
    assert.equal(sha256(file), expectedChecksums.get(basename(file)), basename(file));
  }

  const windowsExtract = join(tempRoot, 'windows');
  const macExtract = join(tempRoot, 'macos');
  extractZip(windowsArchive, windowsExtract);
  extractTar(macArchive, macExtract);
  const windowsPackage = join(windowsExtract, 'Cioppino');
  const macPackage = join(macExtract, 'Cioppino');
  inspectPackage(windowsPackage, 'windows');
  inspectPackage(macPackage, 'macos');
  if (process.platform === 'win32') {
    const listing = spawnSync('tar', ['-tvzf', macArchive], {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /^-rwxr-xr-x.*Cioppino\/install-and-run\.command$/m);
  } else {
    assert.ok((statSync(join(macPackage, 'install-and-run.command')).mode & 0o111) !== 0);
  }

  const runtimePackage = process.platform === 'darwin' ? macPackage : windowsPackage;
  await verifyRuntime(runtimePackage);
  console.log('[verify] release archives, checksums, contents, and runtime passed');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

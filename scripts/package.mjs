#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TarArchive, ZipArchive } from 'archiver';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const backendPackage = JSON.parse(readFileSync(join(root, 'backend', 'package.json'), 'utf8'));
const version = packageJson.version;
const npmCli = process.env.npm_execpath;
const stagingRoot = join(root, '_dist-package');
const baseStage = join(stagingRoot, 'base');
const windowsStage = join(stagingRoot, 'windows', 'Cioppino');
const macStage = join(stagingRoot, 'macos', 'Cioppino');
const releaseDir = join(root, 'release');
const windowsArchive = join(releaseDir, `Cioppino-v${version}-windows.zip`);
const macArchive = join(releaseDir, `Cioppino-v${version}-macos.tar.gz`);
const checksumsFile = join(releaseDir, 'SHA256SUMS.txt');

function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(' ')} (${relative(root, cwd) || '.'})`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status ?? 'unknown'}): ${command} ${args.join(' ')}`);
  }
}

function runNpm(args, cwd) {
  if (!npmCli) throw new Error('Run packaging through npm so npm_execpath is available.');
  run(process.execPath, [npmCli, ...args], cwd);
}

function copyRequired(relativePath, destinationRoot = baseStage) {
  const source = join(root, relativePath);
  if (!existsSync(source)) throw new Error(`Required release file is missing: ${relativePath}`);
  const destination = join(destinationRoot, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function writeExecutable(file, content) {
  writeFileSync(file, content, { mode: 0o755 });
}

function createArchive(format, source, destination) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(destination);
    const archive = format === 'zip'
      ? new ZipArchive({ zlib: { level: 9 } })
      : new TarArchive({ gzip: true, gzipOptions: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('warning', (error) => {
      if (error.code === 'ENOENT') console.warn(`[package] ${error.message}`);
      else reject(error);
    });
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(source, 'Cioppino', (entry) => {
      const name = entry.name.replaceAll('\\', '/');
      if (name === 'install-and-run.command' || name === 'install-and-run.sh') {
        entry.mode = 0o755;
      }
      return entry;
    });
    archive.finalize();
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

console.log('[package] building source workspaces');
runNpm(['run', 'build'], root);

console.log('[package] preparing deterministic staging directories');
rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(baseStage, { recursive: true });
mkdirSync(releaseDir, { recursive: true });
for (const file of [windowsArchive, macArchive, checksumsFile]) rmSync(file, { force: true });

for (const item of [
  'backend/dist',
  'frontend/dist',
  'scripts/start.mjs',
  'Images/Cioppino Icon.png',
  'Images/CioppinoDashboard.png',
  'README.md',
  'LICENSE',
  'PRIVACY.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'docs/ARCHITECTURE.md',
]) {
  copyRequired(item);
}

const runtimePackage = {
  name: 'cioppino',
  version,
  private: true,
  description: packageJson.description,
  license: packageJson.license,
  engines: { node: '>=24.0.0', npm: '>=11.0.0' },
  scripts: { start: 'node scripts/start.mjs' },
  dependencies: backendPackage.dependencies,
};
writeFileSync(join(baseStage, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);

const quickStart = `# Cioppino v${version} quick start

Cioppino is a local-first activity monitor for AI agents.

## Requirements

- Node.js 24 or newer: https://nodejs.org/
- npm 11 or newer

## Windows

Extract the ZIP, open the Cioppino folder, and double-click \`install-and-run.cmd\`.

## macOS

Extract the tarball, open the Cioppino folder, and double-click
\`install-and-run.command\`. If macOS blocks the unsigned script, review it first,
then allow it from System Settings > Privacy & Security.

The first launch installs the production dependencies from the included lockfile.
Cioppino then opens a browser on the local loopback interface. Release bundles are
not code-signed or notarized.

See README.md, PRIVACY.md, and SECURITY.md before use.
`;
writeFileSync(join(baseStage, 'QUICKSTART.md'), quickStart);

console.log('[package] generating production dependency lockfile');
runNpm(
  ['install', '--package-lock-only', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
  baseStage,
);

cpSync(baseStage, windowsStage, { recursive: true });
cpSync(baseStage, macStage, { recursive: true });

const windowsLauncher = `@echo off\r
setlocal\r
cd /d "%~dp0"\r
where node >nul 2>nul || (\r
  echo [Cioppino] Node.js 24 or newer is required: https://nodejs.org/\r
  pause\r
  exit /b 1\r
)\r
where npm >nul 2>nul || (\r
  echo [Cioppino] npm 11 or newer is required.\r
  pause\r
  exit /b 1\r
)\r
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" || (\r
  echo [Cioppino] Node.js 24 or newer is required.\r
  pause\r
  exit /b 1\r
)\r
if not exist "node_modules\\express\\package.json" (\r
  echo [Cioppino] Installing production dependencies from package-lock.json...\r
  call npm ci --omit=dev --no-audit --no-fund || goto :error\r
)\r
echo [Cioppino] Starting local monitor...\r
node scripts\\start.mjs\r
exit /b %errorlevel%\r
:error\r
echo [Cioppino] Installation failed. Review the messages above.\r
pause\r
exit /b 1\r
`;
writeFileSync(join(windowsStage, 'install-and-run.cmd'), windowsLauncher);

const macLauncher = `#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "[Cioppino] Node.js 24 or newer is required: https://nodejs.org/"
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "[Cioppino] npm 11 or newer is required."
  exit 1
fi
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" || {
  echo "[Cioppino] Node.js 24 or newer is required."
  exit 1
}
if [ ! -f "node_modules/express/package.json" ]; then
  echo "[Cioppino] Installing production dependencies from package-lock.json..."
  npm ci --omit=dev --no-audit --no-fund
fi
echo "[Cioppino] Starting local monitor..."
exec node scripts/start.mjs
`;
writeExecutable(join(macStage, 'install-and-run.command'), macLauncher);
writeExecutable(join(macStage, 'install-and-run.sh'), macLauncher);

console.log('[package] creating release archives');
await createArchive('zip', windowsStage, windowsArchive);
await createArchive('tar', macStage, macArchive);

const checksumLines = [];
for (const file of [windowsArchive, macArchive]) {
  checksumLines.push(`${await sha256(file)}  ${file.split(/[\\/]/).pop()}`);
}
writeFileSync(checksumsFile, `${checksumLines.join('\n')}\n`);

for (const file of [windowsArchive, macArchive, checksumsFile]) {
  const size = statSync(file).size;
  console.log(`[package] ${relative(root, file)} (${(size / 1024 / 1024).toFixed(2)} MiB)`);
}

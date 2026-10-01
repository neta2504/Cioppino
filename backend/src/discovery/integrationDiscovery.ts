import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentDef } from './registry.js';
import type { ProcInfo } from './procSnapshot.js';
import { object, readIntegrationFile } from './integrationFiles.js';
import { setIntegrationIssues } from './integrationStatus.js';

const execFileP = promisify(execFile);
const piPackages = ['@mariozechner/pi-coding-agent', '@earendil-works/pi-coding-agent'];
const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase();

export function piScript(command: string): string | undefined {
  const args = command.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((arg) => arg.replace(/^["']|["']$/g, '')) ?? [];
  if (!/^(?:.*[/\\])?node(?:\.exe)?$/i.test(args[0] ?? '')) return undefined;
  // Only the script argument is evidence; later prompt text must not match.
  const script = args[1];
  if (!script) return undefined;
  const normalized = normalize(script);
  return piPackages.some((name) => normalized.endsWith(`/node_modules/${name}/dist/cli.js`)) ? script : undefined;
}

export function isPiBinary(file: string): boolean {
  const real = fs.realpathSync(file);
  const normalized = normalize(real);
  if (piPackages.some((name) => normalized.endsWith(`/node_modules/${name}/dist/cli.js`))) return true;
  // npm's Windows shims refer to a package installed beside the shim.
  const shim = readIntegrationFile(real, 32 * 1024);
  if (!shim) return false;
  for (const name of piPackages) {
    const packageFile = path.join(path.dirname(real), 'node_modules', ...name.split('/'), 'package.json');
    const text = readIntegrationFile(packageFile, 64 * 1024);
    if (text && object(JSON.parse(text))?.name === name && normalize(shim).includes(`${name}/dist/cli.js`)) return true;
  }
  return false;
}

export function desktopGoose(executable: string, exists = fs.existsSync): boolean {
  const norm = normalize(executable);
  if (norm.includes('/goose.app/contents/')) return true;
  const p = /^[a-z]:[/\\]/i.test(executable) ? path.win32 : path;
  const directory = p.dirname(executable);
  return exists(p.join(directory, 'resources', 'app.asar')) ||
    (/[/\\]resources[/\\]bin[/\\]/i.test(executable) && exists(p.resolve(directory, '..', 'app.asar')));
}

export function matchesIntegrationProcess(
  def: AgentDef,
  proc: ProcInfo,
  gooseCliPaths: ReadonlySet<string> = new Set(),
  exists = fs.existsSync,
): boolean {
  const name = proc.name.toLowerCase();
  const executable = proc.executable ?? '';
  if (def.id === 'pi-coding-agent') return ['node', 'node.exe'].includes(name) && !!piScript(proc.cmdline);
  if (def.id === 'goose-desktop') {
    return /^(goose(?:\.exe)?|goosed(?:\.exe)?|goose helper(?: .*)?)$/i.test(name) && desktopGoose(executable, exists);
  }
  if (def.id === 'goose-cli') return gooseCliPaths.has(normalize(executable)) && !desktopGoose(executable, exists);
  if (def.id === 'kiro-ide' && normalize(executable).includes('/kiro.app/contents/')) {
    return /^(electron|kiro|kiro helper(?: .*)?)$/i.test(name);
  }
  return !!def.processNames?.some((candidate) => candidate.toLowerCase() === name);
}

function binaryCandidates(def: AgentDef, env: NodeJS.ProcessEnv): string[] {
  const directories = [...(env.PATH || env.Path || '').split(path.delimiter), ...def.integration!.binDirs].filter(Boolean);
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return [...new Set(directories.flatMap((directory) =>
    (def.binNames ?? []).flatMap((name) => extensions.map((ext) => path.join(directory, name + ext)))))];
}

function regularFile(file: string): boolean {
  try { return fs.statSync(file).isFile(); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function resolveIntegration(def: AgentDef, procs: ProcInfo[], env = process.env) {
  const integration = def.integration!;
  const issues: string[] = [];
  const result: { binPath?: string; configPath?: string; version?: string; pids: number[]; installed: boolean } =
    { pids: [], installed: false };
  if (!integration.platforms.includes(process.platform)) return result;
  const gooseCliPaths = new Set<string>();
  try {
    const candidates = binaryCandidates(def, env);
    if (def.id === 'goose-cli') {
      candidates.push(...procs.filter((proc) => /^(goose|goose.exe)$/i.test(proc.name))
        .map((proc) => proc.executable ?? '').filter((file) => path.isAbsolute(file)));
    }
    for (const file of [...new Set(candidates)]) {
      if (!regularFile(file)) continue;
      if (def.id === 'pi-coding-agent') {
        try { if (!isPiBinary(file)) continue; }
        catch {
          issues.push('A pi executable could not be identified as Pi Coding Agent; it was not attributed.');
          continue;
        }
      }
      if (def.id === 'goose-cli') {
        if (desktopGoose(file) || /\.(cmd|bat)$/i.test(file)) continue;
        // The unrelated SQL migration utility is also named goose.
        try {
          const { stdout } = await execFileP(file, ['--version'], { timeout: 1200, maxBuffer: 4096, windowsHide: true });
          if (!/^goose \d+\.\d+\.\d+(?:[-+.\w]*)\s*$/i.test(stdout.trim())) continue;
          gooseCliPaths.add(normalize(file));
          result.version = stdout.trim().replace(/^goose\s+/i, '');
        } catch {
          issues.push('Could not verify a goose CLI executable; it was not attributed.');
          continue;
        }
      }
      result.binPath ??= file;
      if (def.id !== 'goose-cli') break;
    }
    const app = integration.installPaths.find((file) => fs.existsSync(file));
    const config = def.configPaths?.find((file) => fs.existsSync(file));
    result.configPath = config;
    result.pids = procs.filter((proc) => matchesIntegrationProcess(def, proc, gooseCliPaths)).map((proc) => proc.pid);
    result.installed = !!(result.binPath || app || result.pids.length);
  } catch {
    issues.push('Discovery could not inspect an installation path. Check local permissions.');
  }
  setIntegrationIssues(def.id, 'discovery', issues);
  return result;
}

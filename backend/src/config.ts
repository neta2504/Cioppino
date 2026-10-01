import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export const APP_NAME = 'Cioppino';

export function appDataDir(): string {
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const dir = path.join(base, APP_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const DB_PATH = path.join(appDataDir(), 'cioppino.db');
export const PORT = parseInt(process.env.CIOPPINO_PORT || '5174', 10);
export const TOKEN = process.env.CIOPPINO_TOKEN || '';
export const HOME = os.homedir();

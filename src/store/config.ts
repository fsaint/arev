import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  port: number;
  notifications: boolean;
  open_browser: boolean;
}

export const DEFAULT_CONFIG: Config = {
  port: 7717,
  notifications: process.platform === 'darwin',
  open_browser: true,
};

export function loadConfig(root: string): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(root: string, config: Config): void {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArevError } from '../errors.js';
import { loadConfig, saveConfig } from '../store/config.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

async function health(port: number): Promise<{ root: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(600) });
    if (!res.ok) return null;
    const body = (await res.json()) as { app?: string; root?: string };
    return body.app === 'arev' && body.root ? { root: body.root } : { root: '' };
  } catch {
    return null;
  }
}

/** Port of an already-running review server for this store, or null. Never starts one. */
export async function findServer(root: string): Promise<number | null> {
  const config = loadConfig(root);
  for (let port = config.port; port < config.port + 20; port++) {
    const h = await health(port);
    if (h && h.root === root) return port;
    if (!h) return null; // servers take the first free port, so nothing for this store lies beyond
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Make sure a review server for this store is running; start one in the
 * background if needed. Returns the port. Each store gets its own port
 * (the first free one from config.port upward, saved back to config).
 */
export async function ensureServer(root: string): Promise<number> {
  const config = loadConfig(root);
  for (let port = config.port; port < config.port + 20; port++) {
    const h = await health(port);
    if (h && h.root === root) return port;
    if (h) continue; // another arev store (or something else) owns this port

    const log = fs.openSync(path.join(root, 'server.log'), 'a');
    const child = spawn(process.execPath, [CLI, 'serve', '--store', root, '--port', String(port)], {
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.unref();
    let exited = false;
    child.once('exit', () => (exited = true));
    for (let i = 0; i < 40 && !exited; i++) {
      await sleep(125);
      const h2 = await health(port);
      if (h2 && h2.root === root) {
        if (port !== config.port) saveConfig(root, { ...config, port });
        return port;
      }
    }
    // Port taken by something that isn't answering as arev — try the next one.
  }
  throw new ArevError('E_SERVER', `Could not start the review server (see ${path.join(root, 'server.log')})`);
}

export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  execFile(cmd, args as string[], () => {});
}

export function notify(title: string, message: string): void {
  if (process.platform !== 'darwin') return;
  execFile('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], () => {});
}

export function reviewUrl(port: number, asset: string, version?: number): string {
  return `http://localhost:${port}/a/${asset}${version ? `/v/${version}` : ''}`;
}

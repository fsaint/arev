import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArevError } from '../errors.js';

export const STORE_DIR = '.arev';

/** Walk up from `start` looking for a `.arev/` directory, like git does. */
export function findStore(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, STORE_DIR);
    if (fs.existsSync(path.join(candidate, 'arev.db'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function globalStorePath(): string {
  return path.join(os.homedir(), STORE_DIR);
}

export interface StoreOptions {
  store?: string;
  global?: boolean;
}

/** Returns the store directory to use, or throws if none can be found. */
export function resolveStorePath(opts: StoreOptions, cwd = process.cwd()): string {
  const explicit = opts.store ?? process.env.AREV_STORE;
  if (explicit) return path.resolve(explicit);
  if (opts.global) return globalStorePath();
  const found = findStore(cwd);
  if (!found) {
    throw new ArevError('E_NO_STORE', 'No .arev store found here or in any parent directory. Run `arev init` first (or pass --global).');
  }
  return found;
}

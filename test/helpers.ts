import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arev-test-'));
}

/** Writes a fake file with unique bytes; arev only cares about extension + hash. */
export function fakeFile(dir: string, name: string, content = name + Math.random()): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

export const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

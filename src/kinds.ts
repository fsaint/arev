import path from 'node:path';
import { ArevError } from './errors.js';

export type Kind = 'image' | 'video' | 'pdf';

const TYPES: Record<string, { kind: Kind; mime: string }> = {
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.avif': { kind: 'image', mime: 'image/avif' },
  '.svg': { kind: 'image', mime: 'image/svg+xml' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.m4v': { kind: 'video', mime: 'video/mp4' },
  '.mov': { kind: 'video', mime: 'video/quicktime' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.pdf': { kind: 'pdf', mime: 'application/pdf' },
};

export function detectKind(file: string): { kind: Kind; mime: string; ext: string } {
  const ext = path.extname(file).toLowerCase();
  const t = TYPES[ext];
  if (!t) {
    throw new ArevError(
      'E_UNSUPPORTED',
      `Unsupported file type "${ext || '(none)'}". Supported: ${Object.keys(TYPES).join(' ')}`,
    );
  }
  return { ...t, ext };
}

export function mimeForPath(file: string): string {
  return TYPES[path.extname(file).toLowerCase()]?.mime ?? 'application/octet-stream';
}

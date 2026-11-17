import { ArevError } from './errors.js';
import type { Kind } from './kinds.js';

export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }

export type Anchor =
  | { type: 'region'; x: number; y: number; w: number; h: number }
  | { type: 'point'; x: number; y: number }
  | { type: 'time'; t: number; region?: Rect; point?: Point }
  | { type: 'range'; start: number; end: number; region?: Rect; point?: Point }
  | { type: 'page'; page: number; region?: Rect; point?: Point };

const ALLOWED: Record<Kind, Anchor['type'][]> = {
  image: ['region', 'point'],
  video: ['time', 'range'],
  pdf: ['page'],
};

function bad(msg: string): never {
  throw new ArevError('E_BAD_ANCHOR', msg);
}

function unit(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) bad(`${name} must be a number between 0 and 1`);
  return Math.round(v * 10000) / 10000;
}

function seconds(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) bad(`${name} must be a non-negative number of seconds`);
  return Math.round(v * 1000) / 1000;
}

function rect(r: any, name = 'region'): Rect {
  if (!r || typeof r !== 'object') bad(`${name} must be an object {x,y,w,h}`);
  const out = { x: unit(r.x, `${name}.x`), y: unit(r.y, `${name}.y`), w: unit(r.w, `${name}.w`), h: unit(r.h, `${name}.h`) };
  if (out.x + out.w > 1.0001 || out.y + out.h > 1.0001) bad(`${name} extends past the edge of the asset`);
  return out;
}

function point(p: any, name = 'point'): Point {
  if (!p || typeof p !== 'object') bad(`${name} must be an object {x,y}`);
  return { x: unit(p.x, `${name}.x`), y: unit(p.y, `${name}.y`) };
}

function withSpot<T extends object>(base: T, a: any): T & { region?: Rect; point?: Point } {
  if (a.region && a.point) bad('anchor may have a region or a point, not both');
  if (a.region) return { ...base, region: rect(a.region) };
  if (a.point) return { ...base, point: point(a.point) };
  return base;
}

/** Validates and normalizes an anchor for an asset kind. Returns null for general comments. */
export function validateAnchor(kind: Kind, a: unknown): Anchor | null {
  if (a === null || a === undefined) return null;
  if (typeof a !== 'object') bad('anchor must be an object');
  const anchor = a as any;
  if (!ALLOWED[kind].includes(anchor.type)) {
    bad(`anchor type "${anchor.type}" is not valid for ${kind}; use one of: ${ALLOWED[kind].join(', ')}`);
  }
  switch (anchor.type as Anchor['type']) {
    case 'region':
      return { type: 'region', ...rect(anchor, 'region') };
    case 'point':
      return { type: 'point', ...point(anchor) };
    case 'time':
      return withSpot({ type: 'time' as const, t: seconds(anchor.t, 't') }, anchor);
    case 'range': {
      const start = seconds(anchor.start, 'start');
      const end = seconds(anchor.end, 'end');
      if (end < start) bad('range end must be after start');
      return withSpot({ type: 'range' as const, start, end }, anchor);
    }
    case 'page': {
      if (!Number.isInteger(anchor.page) || anchor.page < 1) bad('page must be a positive integer');
      return withSpot({ type: 'page' as const, page: anchor.page as number }, anchor);
    }
  }
}

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function spot(a: { region?: Rect; point?: Point }): string {
  if (a.region) return ` region x=${pct(a.region.x)} y=${pct(a.region.y)} w=${pct(a.region.w)} h=${pct(a.region.h)}`;
  if (a.point) return ` point x=${pct(a.point.x)} y=${pct(a.point.y)}`;
  return '';
}

/** Short human/LLM-readable description of an anchor. */
export function describeAnchor(a: Anchor | null): string {
  if (!a) return 'general';
  switch (a.type) {
    case 'region':
      return `region x=${pct(a.x)} y=${pct(a.y)} w=${pct(a.w)} h=${pct(a.h)}`;
    case 'point':
      return `point x=${pct(a.x)} y=${pct(a.y)}`;
    case 'time':
      return `at ${fmtTime(a.t)}${spot(a)}`;
    case 'range':
      return `${fmtTime(a.start)}–${fmtTime(a.end)}${spot(a)}`;
    case 'page':
      return `page ${a.page}${spot(a)}`;
  }
}

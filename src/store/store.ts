import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type Anchor, validateAnchor } from '../anchors.js';
import { ArevError, EXIT } from '../errors.js';
import { detectKind, type Kind } from '../kinds.js';
import { type Config, loadConfig, saveConfig, DEFAULT_CONFIG } from './config.js';
import { openDb } from './db.js';

export type ReviewStatus = 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'superseded';
export type Decision = 'approved' | 'changes_requested' | 'rejected';

interface AssetRow { id: number; name: string; kind: Kind; created_at: string; archived: number }
interface VersionRow {
  id: number; asset_id: number; n: number; sha256: string; path: string; original_name: string | null;
  mime: string; bytes: number; note: string | null; created_at: string;
}
interface ReviewRow { id: number; version_id: number; status: ReviewStatus; summary: string | null; decided_at: string | null; decided_by: string | null }
interface CommentRow {
  id: number; version_id: number; text: string; anchor_json: string | null; snapshot_path: string | null;
  author: string; resolved_in_version: number | null; created_at: string;
}

export interface CommentOut {
  id: string;
  version: number;
  text: string;
  anchor: Anchor | null;
  snapshot: string | null;
  author: string;
  created_at: string;
  resolved: boolean;
  resolved_in_version: number | null;
}

export interface Feedback {
  asset: string;
  kind: Kind;
  version: number;
  latest_version: number;
  status: ReviewStatus;
  decided_at: string | null;
  decided_by: string | null;
  summary: string | null;
  note: string | null;
  file: string;
  comments: CommentOut[];
  unresolved_from_previous: CommentOut[];
}

export interface AssetSummary {
  asset: string;
  kind: Kind;
  latest_version: number;
  status: ReviewStatus;
  open_comments: number;
  updated_at: string;
}

export interface VersionInfo {
  id: number;
  version: number;
  sha256: string;
  file: string;
  original_name: string | null;
  mime: string;
  bytes: number;
  note: string | null;
  created_at: string;
  status: ReviewStatus;
  summary: string | null;
  decided_at: string | null;
  decided_by: string | null;
  comments: CommentOut[];
  resolves: string[];
}

export interface SubmitResult {
  asset: string;
  kind: Kind;
  version: number;
  sha256: string;
  file: string;
  superseded: number | null;
  resolved: string[];
}

export interface EventRow { id: number; ts: string; type: string; asset: string | null; payload: unknown }

const NAME_RE = /^[a-z0-9](?:[a-z0-9_-]|\/(?=[a-z0-9]))*$/;

export function validateName(name: string): void {
  if (!name || name.length > 128 || !NAME_RE.test(name)) {
    throw new ArevError(
      'E_BAD_NAME',
      `Invalid asset name "${name}". Use lowercase letters, digits, "-", "_" and "/" for grouping (e.g. ep12/thumbnail).`,
    );
  }
}

export function parseCommentId(id: string): number {
  const m = /^c?(\d+)$/i.exec(id.trim());
  if (!m) throw new ArevError('E_BAD_COMMENT', `Invalid comment id "${id}" (expected e.g. c12)`);
  return Number(m[1]);
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function hashFile(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

let ffmpegAvailable: boolean | undefined;
function hasFfmpeg(): boolean {
  if (ffmpegAvailable === undefined) {
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      ffmpegAvailable = true;
    } catch {
      ffmpegAvailable = false;
    }
  }
  return ffmpegAvailable;
}

export class Store {
  readonly db: Database.Database;

  private constructor(readonly root: string) {
    this.db = openDb(root);
  }

  /** Create (or reuse) a store at `root` (the `.arev` directory itself). */
  static init(root: string): Store {
    fs.mkdirSync(path.join(root, 'objects'), { recursive: true });
    fs.mkdirSync(path.join(root, 'snapshots'), { recursive: true });
    if (!fs.existsSync(path.join(root, 'config.json'))) saveConfig(root, DEFAULT_CONFIG);
    return new Store(root);
  }

  static open(root: string): Store {
    if (!fs.existsSync(path.join(root, 'arev.db'))) {
      throw new ArevError('E_NO_STORE', `No arev store at ${root}. Run \`arev init\` first.`);
    }
    return new Store(root);
  }

  close(): void {
    this.db.close();
  }

  get config(): Config {
    return loadConfig(this.root);
  }

  abs(rel: string): string {
    return path.join(this.root, rel);
  }

  // ---------------------------------------------------------------- lookups

  private assetRow(name: string, includeArchived = false): AssetRow {
    const row = this.db.prepare('SELECT * FROM assets WHERE name = ?').get(name) as AssetRow | undefined;
    if (!row || (row.archived && !includeArchived)) {
      throw new ArevError('E_NOT_FOUND', `No asset named "${name}"`, EXIT.NOT_FOUND);
    }
    return row;
  }

  private versionRow(asset: AssetRow, n?: number): VersionRow {
    const row = (
      n === undefined
        ? this.db.prepare('SELECT * FROM versions WHERE asset_id = ? ORDER BY n DESC LIMIT 1').get(asset.id)
        : this.db.prepare('SELECT * FROM versions WHERE asset_id = ? AND n = ?').get(asset.id, n)
    ) as VersionRow | undefined;
    if (!row) {
      throw new ArevError('E_NOT_FOUND', `Asset "${asset.name}" has no version ${n ?? ''}`.trim(), EXIT.NOT_FOUND);
    }
    return row;
  }

  private latestN(asset: AssetRow): number {
    return (this.db.prepare('SELECT MAX(n) AS n FROM versions WHERE asset_id = ?').get(asset.id) as { n: number }).n;
  }

  private reviewRow(versionId: number): ReviewRow {
    return this.db.prepare('SELECT * FROM reviews WHERE version_id = ?').get(versionId) as ReviewRow;
  }

  private commentOut(c: CommentRow, versionN: number): CommentOut {
    return {
      id: `c${c.id}`,
      version: versionN,
      text: c.text,
      anchor: c.anchor_json ? (JSON.parse(c.anchor_json) as Anchor) : null,
      snapshot: c.snapshot_path ? this.abs(c.snapshot_path) : null,
      author: c.author,
      created_at: c.created_at,
      resolved: c.resolved_in_version !== null,
      resolved_in_version: c.resolved_in_version,
    };
  }

  private commentsFor(version: VersionRow): CommentOut[] {
    const rows = this.db.prepare('SELECT * FROM comments WHERE version_id = ? ORDER BY id').all(version.id) as CommentRow[];
    return rows.map((c) => this.commentOut(c, version.n));
  }

  private logEvent(type: string, asset: string | null, payload: unknown): void {
    this.db
      .prepare('INSERT INTO events (ts, type, asset, payload_json) VALUES (?, ?, ?, ?)')
      .run(now(), type, asset, JSON.stringify(payload ?? null));
  }

  // ---------------------------------------------------------------- submit

  submit(o: { file: string; name: string; note?: string; resolves?: string[]; force?: boolean }): SubmitResult {
    validateName(o.name);
    const src = path.resolve(o.file);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      throw new ArevError('E_FILE_NOT_FOUND', `File not found: ${o.file}`, EXIT.NOT_FOUND);
    }
    const { kind, mime, ext } = detectKind(src);
    const sha = hashFile(src);
    const rel = path.join('objects', sha.slice(0, 2), sha + ext);
    const dest = this.abs(rel);
    const bytes = fs.statSync(src).size;
    const resolveIds = (o.resolves ?? []).map(parseCommentId);

    const result = this.db.transaction((): SubmitResult => {
      let asset = this.db.prepare('SELECT * FROM assets WHERE name = ?').get(o.name) as AssetRow | undefined;
      if (!asset) {
        const info = this.db.prepare('INSERT INTO assets (name, kind, created_at) VALUES (?, ?, ?)').run(o.name, kind, now());
        asset = { id: Number(info.lastInsertRowid), name: o.name, kind, created_at: now(), archived: 0 };
      } else {
        if (asset.kind !== kind) {
          throw new ArevError('E_KIND_MISMATCH', `Asset "${o.name}" is a ${asset.kind}; cannot add a ${kind} version`);
        }
        if (asset.archived) this.db.prepare('UPDATE assets SET archived = 0 WHERE id = ?').run(asset.id);
      }

      if (!o.force) {
        const dup = this.db.prepare('SELECT n FROM versions WHERE asset_id = ? AND sha256 = ?').get(asset.id, sha) as { n: number } | undefined;
        if (dup) {
          throw new ArevError('E_DUPLICATE', `File is identical to ${o.name} v${dup.n}. Change it, or pass --force to submit anyway.`);
        }
      }

      const prev = this.db.prepare('SELECT * FROM versions WHERE asset_id = ? ORDER BY n DESC LIMIT 1').get(asset.id) as VersionRow | undefined;
      const n = (prev?.n ?? 0) + 1;

      const resolved: string[] = [];
      for (const cid of resolveIds) {
        const c = this.db
          .prepare('SELECT c.id FROM comments c JOIN versions v ON v.id = c.version_id WHERE c.id = ? AND v.asset_id = ?')
          .get(cid, asset.id);
        if (!c) throw new ArevError('E_BAD_COMMENT', `Comment c${cid} does not belong to asset "${o.name}"`);
        this.db.prepare('UPDATE comments SET resolved_in_version = ? WHERE id = ?').run(n, cid);
        resolved.push(`c${cid}`);
      }

      let superseded: number | null = null;
      if (prev) {
        const r = this.db.prepare("UPDATE reviews SET status = 'superseded' WHERE version_id = ? AND status = 'pending'").run(prev.id);
        if (r.changes) superseded = prev.n;
      }

      const v = this.db
        .prepare(
          `INSERT INTO versions (asset_id, n, sha256, path, original_name, mime, bytes, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(asset.id, n, sha, rel, path.basename(src), mime, bytes, o.note ?? null, now());
      this.db.prepare("INSERT INTO reviews (version_id, status) VALUES (?, 'pending')").run(v.lastInsertRowid);
      this.logEvent('version_submitted', o.name, { version: n, superseded, resolved });

      return { asset: o.name, kind, version: n, sha256: sha, file: dest, superseded, resolved };
    })();

    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    return result;
  }

  // ---------------------------------------------------------------- queries

  list(o: { status?: string; includeArchived?: boolean } = {}): AssetSummary[] {
    const rows = this.db
      .prepare(
        `SELECT a.name, a.kind, v.n, v.created_at AS updated_at, r.status,
           (SELECT COUNT(*) FROM comments c JOIN versions v2 ON v2.id = c.version_id
              WHERE v2.asset_id = a.id AND c.resolved_in_version IS NULL) AS open_comments
         FROM assets a
         JOIN versions v ON v.asset_id = a.id AND v.n = (SELECT MAX(n) FROM versions WHERE asset_id = a.id)
         JOIN reviews r ON r.version_id = v.id
         WHERE (? OR a.archived = 0)
         ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'changes_requested' THEN 1 ELSE 2 END, v.created_at DESC`,
      )
      .all(o.includeArchived ? 1 : 0) as Array<{ name: string; kind: Kind; n: number; updated_at: string; status: ReviewStatus; open_comments: number }>;
    return rows
      .filter((r) => !o.status || r.status === o.status)
      .map((r) => ({
        asset: r.name,
        kind: r.kind,
        latest_version: r.n,
        status: r.status,
        open_comments: r.open_comments,
        updated_at: r.updated_at,
      }));
  }

  status(name: string): AssetSummary {
    this.assetRow(name);
    const s = this.list({ includeArchived: true }).find((r) => r.asset === name);
    if (!s) throw new ArevError('E_NOT_FOUND', `No asset named "${name}"`, EXIT.NOT_FOUND);
    return s;
  }

  versions(name: string): { asset: string; kind: Kind; versions: VersionInfo[] } {
    const asset = this.assetRow(name);
    const rows = this.db.prepare('SELECT * FROM versions WHERE asset_id = ? ORDER BY n').all(asset.id) as VersionRow[];
    return {
      asset: asset.name,
      kind: asset.kind,
      versions: rows.map((v) => {
        const r = this.reviewRow(v.id);
        const resolves = (
          this.db
            .prepare('SELECT c.id FROM comments c JOIN versions v2 ON v2.id = c.version_id WHERE v2.asset_id = ? AND c.resolved_in_version = ? ORDER BY c.id')
            .all(asset.id, v.n) as Array<{ id: number }>
        ).map((c) => `c${c.id}`);
        return {
          id: v.id,
          version: v.n,
          sha256: v.sha256,
          file: this.abs(v.path),
          original_name: v.original_name,
          mime: v.mime,
          bytes: v.bytes,
          note: v.note,
          created_at: v.created_at,
          status: r.status,
          summary: r.summary,
          decided_at: r.decided_at,
          decided_by: r.decided_by,
          comments: this.commentsFor(v),
          resolves,
        };
      }),
    };
  }

  /** Absolute path of a version's file. `approved` picks the newest approved version. */
  file(name: string, o: { version?: number; approved?: boolean } = {}): { version: number; file: string; mime: string } {
    const asset = this.assetRow(name);
    let v: VersionRow | undefined;
    if (o.approved) {
      v = this.db
        .prepare(`SELECT v.* FROM versions v JOIN reviews r ON r.version_id = v.id WHERE v.asset_id = ? AND r.status = 'approved' ORDER BY v.n DESC LIMIT 1`)
        .get(asset.id) as VersionRow | undefined;
      if (!v) throw new ArevError('E_NOT_FOUND', `Asset "${name}" has no approved version`, EXIT.NOT_FOUND);
    } else {
      v = this.versionRow(asset, o.version);
    }
    return { version: v.n, file: this.abs(v.path), mime: v.mime };
  }

  versionById(id: number): { file: string; mime: string; sha256: string } | null {
    const v = this.db.prepare('SELECT * FROM versions WHERE id = ?').get(id) as VersionRow | undefined;
    return v ? { file: this.abs(v.path), mime: v.mime, sha256: v.sha256 } : null;
  }

  snapshotById(id: number): string | null {
    const c = this.db.prepare('SELECT snapshot_path FROM comments WHERE id = ?').get(id) as { snapshot_path: string | null } | undefined;
    return c?.snapshot_path ? this.abs(c.snapshot_path) : null;
  }

  reviewStatus(name: string, version?: number): { version: number; status: ReviewStatus } {
    const asset = this.assetRow(name, true);
    const v = this.versionRow(asset, version);
    return { version: v.n, status: this.reviewRow(v.id).status };
  }

  // ---------------------------------------------------------------- feedback

  private feedbackFor(asset: AssetRow, v: VersionRow): Feedback {
    const r = this.reviewRow(v.id);
    const prev = this.db
      .prepare(
        `SELECT c.*, v.n AS vn FROM comments c JOIN versions v ON v.id = c.version_id
         WHERE v.asset_id = ? AND v.n < ? AND (c.resolved_in_version IS NULL OR c.resolved_in_version > ?)
         ORDER BY c.id`,
      )
      .all(asset.id, v.n, v.n) as Array<CommentRow & { vn: number }>;
    return {
      asset: asset.name,
      kind: asset.kind,
      version: v.n,
      latest_version: this.latestN(asset),
      status: r.status,
      decided_at: r.decided_at,
      decided_by: r.decided_by,
      summary: r.summary,
      note: v.note,
      file: this.abs(v.path),
      comments: this.commentsFor(v),
      unresolved_from_previous: prev.map((c) => {
        const out = this.commentOut(c, c.vn);
        // Report resolution status as of this version.
        return { ...out, resolved: false, resolved_in_version: null };
      }),
    };
  }

  /**
   * Feedback for one version. Default: the latest version that has a decision,
   * falling back to the latest version if none has been decided yet.
   */
  feedback(name: string, o: { version?: number } = {}): Feedback {
    const asset = this.assetRow(name, true);
    let v: VersionRow;
    if (o.version !== undefined) {
      v = this.versionRow(asset, o.version);
    } else {
      v = (this.db
        .prepare(
          `SELECT v.* FROM versions v JOIN reviews r ON r.version_id = v.id
           WHERE v.asset_id = ? AND r.status IN ('approved','changes_requested','rejected') ORDER BY v.n DESC LIMIT 1`,
        )
        .get(asset.id) as VersionRow | undefined) ?? this.versionRow(asset);
    }
    return this.feedbackFor(asset, v);
  }

  feedbackAll(name: string): Feedback[] {
    const asset = this.assetRow(name, true);
    const rows = this.db.prepare('SELECT * FROM versions WHERE asset_id = ? ORDER BY n').all(asset.id) as VersionRow[];
    return rows.map((v) => this.feedbackFor(asset, v));
  }

  // ---------------------------------------------------------------- comments & decisions

  addComment(o: {
    name: string;
    version?: number;
    text: string;
    anchor?: unknown;
    author?: string;
    snapshotDataUrl?: string;
  }): CommentOut {
    const asset = this.assetRow(o.name);
    const v = this.versionRow(asset, o.version);
    const text = (o.text ?? '').trim();
    if (!text) throw new ArevError('E_EMPTY', 'Comment text is required');
    const anchor = validateAnchor(asset.kind, o.anchor);
    const author = o.author ?? 'human';

    const id = Number(
      this.db
        .prepare('INSERT INTO comments (version_id, text, anchor_json, author, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(v.id, text, anchor ? JSON.stringify(anchor) : null, author, now()).lastInsertRowid,
    );

    const snapRel = path.join('snapshots', `c${id}.png`);
    let wrote = false;
    if (o.snapshotDataUrl) {
      const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(o.snapshotDataUrl);
      if (!m) throw new ArevError('E_BAD_SNAPSHOT', 'snapshot must be a base64 PNG or JPEG data URL');
      fs.mkdirSync(this.abs('snapshots'), { recursive: true });
      fs.writeFileSync(this.abs(snapRel), Buffer.from(m[2], 'base64'));
      wrote = true;
    } else if (asset.kind === 'video' && anchor && (anchor.type === 'time' || anchor.type === 'range') && hasFfmpeg()) {
      const t = anchor.type === 'time' ? anchor.t : anchor.start;
      try {
        fs.mkdirSync(this.abs('snapshots'), { recursive: true });
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(t), '-i', this.abs(v.path), '-frames:v', '1', this.abs(snapRel)], {
          stdio: 'ignore',
          timeout: 20000,
        });
        wrote = fs.existsSync(this.abs(snapRel));
      } catch {
        wrote = false;
      }
    }
    if (wrote) this.db.prepare('UPDATE comments SET snapshot_path = ? WHERE id = ?').run(snapRel, id);

    this.logEvent('comment', asset.name, { version: v.n, comment: `c${id}`, author });
    const row = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as CommentRow;
    return this.commentOut(row, v.n);
  }

  deleteComment(id: number): void {
    const c = this.db
      .prepare('SELECT c.*, a.name AS asset, v.n AS vn FROM comments c JOIN versions v ON v.id = c.version_id JOIN assets a ON a.id = v.asset_id WHERE c.id = ?')
      .get(id) as (CommentRow & { asset: string; vn: number }) | undefined;
    if (!c) throw new ArevError('E_NOT_FOUND', `No comment c${id}`, EXIT.NOT_FOUND);
    this.db.prepare('DELETE FROM comments WHERE id = ?').run(id);
    if (c.snapshot_path) fs.rmSync(this.abs(c.snapshot_path), { force: true });
    this.logEvent('comment_deleted', c.asset, { version: c.vn, comment: `c${id}` });
  }

  decide(o: { name: string; version?: number; status: Decision; summary?: string; by?: string }): Feedback {
    if (!['approved', 'changes_requested', 'rejected'].includes(o.status)) {
      throw new ArevError('E_BAD_STATUS', `Invalid decision "${o.status}"`);
    }
    const asset = this.assetRow(o.name);
    const latest = this.versionRow(asset);
    const v = o.version === undefined ? latest : this.versionRow(asset, o.version);
    if (v.n !== latest.n) {
      throw new ArevError('E_NOT_LATEST', `Only the latest version (v${latest.n}) of "${o.name}" can be decided; v${v.n} is outdated.`);
    }
    const summary = o.summary?.trim() || null;
    if (o.status !== 'approved' && !summary) {
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE version_id = ?').get(v.id) as { n: number }).n;
      if (!count) {
        throw new ArevError('E_FEEDBACK_REQUIRED', `${o.status === 'rejected' ? 'Rejecting' : 'Requesting changes'} needs a summary or at least one comment.`);
      }
    }
    this.db
      .prepare('UPDATE reviews SET status = ?, summary = ?, decided_at = ?, decided_by = ? WHERE version_id = ?')
      .run(o.status, summary, now(), o.by ?? 'human', v.id);
    this.logEvent('decision', asset.name, { version: v.n, status: o.status });
    return this.feedbackFor(asset, v);
  }

  archive(name: string): void {
    const asset = this.assetRow(name);
    this.db.prepare('UPDATE assets SET archived = 1 WHERE id = ?').run(asset.id);
    this.logEvent('archived', name, null);
  }

  // ---------------------------------------------------------------- events

  maxEventId(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get() as { id: number }).id;
  }

  eventsSince(id: number): EventRow[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(id) as Array<{ id: number; ts: string; type: string; asset: string | null; payload_json: string | null }>;
    return rows.map((r) => ({ id: r.id, ts: r.ts, type: r.type, asset: r.asset, payload: r.payload_json ? JSON.parse(r.payload_json) : null }));
  }
}

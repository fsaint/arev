import Database from 'better-sqlite3';
import path from 'node:path';

type DB = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE assets (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE versions (
    id INTEGER PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    n INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    path TEXT NOT NULL,
    original_name TEXT,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (asset_id, n)
  );
  CREATE TABLE reviews (
    id INTEGER PRIMARY KEY,
    version_id INTEGER NOT NULL UNIQUE REFERENCES versions(id),
    status TEXT NOT NULL,
    summary TEXT,
    decided_at TEXT,
    decided_by TEXT
  );
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY,
    version_id INTEGER NOT NULL REFERENCES versions(id),
    text TEXT NOT NULL,
    anchor_json TEXT,
    snapshot_path TEXT,
    author TEXT NOT NULL,
    resolved_in_version INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    asset TEXT,
    payload_json TEXT
  );
  CREATE INDEX idx_versions_asset ON versions(asset_id);
  CREATE INDEX idx_comments_version ON comments(version_id);
  `,
];

export function openDb(root: string): DB {
  const db = new Database(path.join(root, 'arev.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  return db;
}

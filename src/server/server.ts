import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArevError } from '../errors.js';
import { mimeForPath } from '../kinds.js';
import { parseCommentId, type Store, type VersionInfo, type CommentOut } from '../store/store.js';

const WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url));
const PDFJS_DIR = path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'build');

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json',
};

const MAX_BODY = 25 * 1024 * 1024;

export interface RunningServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(json);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof ArevError) {
    send(res, err.exitCode === 2 ? 404 : 400, { error: { code: err.code, message: err.message } });
  } else {
    console.error(err);
    send(res, 500, { error: { code: 'E_INTERNAL', message: String((err as Error)?.message ?? err) } });
  }
}

/** Serve a file, honouring Range requests so videos can seek. */
function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, type: string, cache = 'no-cache'): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    send(res, 404, { error: { code: 'E_NOT_FOUND', message: 'file missing' } });
    return;
  }
  const headers: http.OutgoingHttpHeaders = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': cache };
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    let start = range[1] ? Number(range[1]) : NaN;
    let end = range[2] ? Number(range[2]) : NaN;
    if (Number.isNaN(start)) {
      start = stat.size - end;
      end = stat.size - 1;
    } else if (Number.isNaN(end) || end >= stat.size) {
      end = stat.size - 1;
    }
    if (start < 0 || start > end || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') return void res.end();
  fs.createReadStream(file).pipe(res);
}

function sendStatic(req: http.IncomingMessage, res: http.ServerResponse, baseDir: string, rel: string): void {
  const file = path.normalize(path.join(baseDir, rel));
  if (!file.startsWith(baseDir)) return void send(res, 403, { error: { code: 'E_FORBIDDEN', message: 'forbidden' } });
  sendFile(req, res, file, STATIC_TYPES[path.extname(file)] ?? 'application/octet-stream');
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ArevError('E_TOO_LARGE', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new ArevError('E_BAD_JSON', 'invalid JSON body');
  }
}

function withCommentUrls(c: CommentOut, store: Store): CommentOut & { snapshot_url: string | null } {
  const id = parseCommentId(c.id);
  return { ...c, snapshot: null, snapshot_url: store.snapshotById(id) ? `/api/snapshot?cid=${id}` : null };
}

function versionPayload(v: VersionInfo, store: Store) {
  return { ...v, file: undefined, file_url: `/api/file?vid=${v.id}&h=${v.sha256}`, comments: v.comments.map((c) => withCommentUrls(c, store)) };
}

export function startServer(store: Store, o: { port: number; host?: string }): Promise<RunningServer> {
  const host = o.host ?? '127.0.0.1';
  const clients = new Set<http.ServerResponse>();
  let lastEvent = store.maxEventId();

  const poll = setInterval(() => {
    let events;
    try {
      events = store.eventsSince(lastEvent);
    } catch {
      return;
    }
    for (const ev of events) {
      lastEvent = ev.id;
      const msg = `id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`;
      for (const c of clients) c.write(msg);
    }
  }, 500);
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 15000);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (p === '/' || p === '/index.html') return sendStatic(req, res, WEB_DIR, 'index.html');
        if (/^\/a\/.+/.test(p)) return sendStatic(req, res, WEB_DIR, 'review.html');
        if (p.startsWith('/static/')) return sendStatic(req, res, WEB_DIR, p.slice('/static/'.length));
        if (p.startsWith('/vendor/pdfjs/')) return sendStatic(req, res, PDFJS_DIR, p.slice('/vendor/pdfjs/'.length));

        if (p === '/api/health') return send(res, 200, { ok: true, app: 'arev', root: store.root, pid: process.pid });
        if (p === '/api/assets') return send(res, 200, { assets: store.list() });
        if (p === '/api/asset') {
          const name = url.searchParams.get('name') ?? '';
          const info = store.versions(name);
          const latest = info.versions[info.versions.length - 1];
          return send(res, 200, {
            asset: info.asset,
            kind: info.kind,
            latest_version: latest.version,
            versions: info.versions.map((v) => versionPayload(v, store)),
          });
        }
        if (p === '/api/file') {
          const v = store.versionById(Number(url.searchParams.get('vid')));
          if (!v) return send(res, 404, { error: { code: 'E_NOT_FOUND', message: 'no such version' } });
          // Version ids are only unique within one store, and ports get reused by other
          // stores, so only a URL that carries the content hash may be cached forever.
          const h = url.searchParams.get('h');
          if (h !== null && h !== v.sha256) return send(res, 404, { error: { code: 'E_NOT_FOUND', message: 'no such file' } });
          return sendFile(req, res, v.file, v.mime, h ? 'private, max-age=31536000, immutable' : 'no-cache');
        }
        if (p === '/api/snapshot') {
          const file = store.snapshotById(Number(url.searchParams.get('cid')));
          if (!file) return send(res, 404, { error: { code: 'E_NOT_FOUND', message: 'no snapshot' } });
          return sendFile(req, res, file, mimeForPath(file));
        }
        if (p === '/api/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write(': connected\n\n');
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (p === '/api/comments') {
          const c = store.addComment({
            name: body.asset,
            version: body.version,
            text: body.text,
            anchor: body.anchor ?? null,
            author: 'human',
            snapshotDataUrl: body.snapshot,
          });
          return send(res, 201, withCommentUrls(c, store));
        }
        if (p === '/api/comments/delete') {
          store.deleteComment(parseCommentId(String(body.id)));
          return send(res, 200, { ok: true });
        }
        if (p === '/api/decision') {
          const f = store.decide({ name: body.asset, version: body.version, status: body.status, summary: body.summary, by: 'human' });
          return send(res, 200, { ...f, file: undefined });
        }
      }
      send(res, 404, { error: { code: 'E_NOT_FOUND', message: `${req.method} ${p} not found` } });
    } catch (err) {
      sendError(res, err);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      clearInterval(poll);
      clearInterval(heartbeat);
      reject(err);
    });
    server.listen(o.port, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : o.port;
      resolve({
        port,
        url: `http://localhost:${port}`,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(poll);
            clearInterval(heartbeat);
            for (const c of clients) c.end();
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

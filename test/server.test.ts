import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServer, startServer } from '../src/server/server.js';
import { Store } from '../src/store/store.js';
import { fakeFile, PNG_1PX, tempDir } from './helpers.js';

let dir: string;
let store: Store;
let srv: RunningServer;

beforeEach(async () => {
  dir = tempDir();
  store = Store.init(path.join(dir, '.arev'));
  srv = await startServer(store, { port: 0 });
});
afterEach(async () => {
  await srv.close();
  store.close();
});

const url = (p: string) => `http://127.0.0.1:${srv.port}${p}`;
const post = (p: string, body: unknown) =>
  fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('review server', () => {
  it('serves health, pages and static assets', async () => {
    expect(await (await fetch(url('/api/health'))).json()).toMatchObject({ app: 'arev', root: store.root });
    expect((await fetch(url('/'))).headers.get('content-type')).toMatch(/html/);
    expect((await fetch(url('/a/ep1/thumb/v/2'))).status).toBe(200);
    expect((await fetch(url('/static/review.js'))).status).toBe(200);
    expect((await fetch(url('/vendor/pdfjs/pdf.mjs'))).status).toBe(200);
    expect((await fetch(url('/static/../../package.json'))).status).not.toBe(200);
  });

  it('gives files hash-bearing URLs so a reused port never serves another store\'s cached file', async () => {
    store.submit({ file: fakeFile(dir, 'a.png', 'first store'), name: 'hero' });
    const a = (await (await fetch(url('/api/asset?name=hero'))).json()).versions[0].file_url as string;

    // A second store on its own server: same version id (1), different bytes.
    const dir2 = tempDir();
    const store2 = Store.init(path.join(dir2, '.arev'));
    const srv2 = await startServer(store2, { port: 0 });
    try {
      store2.submit({ file: fakeFile(dir2, 'b.png', 'second store'), name: 'end-card' });
      const res = await fetch(`http://127.0.0.1:${srv2.port}/api/asset?name=end-card`);
      const b = (await res.json()).versions[0].file_url as string;
      expect(a).toMatch(/vid=1&h=[0-9a-f]{64}$/);
      expect(b).toMatch(/vid=1&h=[0-9a-f]{64}$/);
      expect(a).not.toBe(b); // same vid, different URL: a browser cache can't mix them up
    } finally {
      await srv2.close();
      store2.close();
    }

    const cached = await fetch(url(a));
    expect(cached.headers.get('cache-control')).toMatch(/immutable/);
    expect(await cached.text()).toBe('first store');
    const bare = await fetch(url('/api/file?vid=1'));
    expect(bare.headers.get('cache-control')).toBe('no-cache');
    await bare.arrayBuffer();
    expect((await fetch(url(`/api/file?vid=1&h=${'0'.repeat(64)}`))).status).toBe(404);
  });

  it('runs the review flow over the API', async () => {
    store.submit({ file: fakeFile(dir, 'a.png', '0123456789'), name: 'hero' });
    const asset = await (await fetch(url('/api/asset?name=hero'))).json();
    expect(asset).toMatchObject({ asset: 'hero', kind: 'image', latest_version: 1 });
    const fileUrl = asset.versions[0].file_url;

    const ranged = await fetch(url(fileUrl), { headers: { range: 'bytes=2-5' } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('2345');

    const blocked = await post('/api/decision', { asset: 'hero', status: 'changes_requested' });
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error.code).toBe('E_FEEDBACK_REQUIRED');

    const c = await (await post('/api/comments', { asset: 'hero', version: 1, text: 'move left', anchor: { type: 'point', x: 0.2, y: 0.3 }, snapshot: PNG_1PX })).json();
    expect(c).toMatchObject({ id: 'c1', snapshot_url: '/api/snapshot?cid=1' });
    expect((await fetch(url(c.snapshot_url))).headers.get('content-type')).toBe('image/png');

    const d = await post('/api/decision', { asset: 'hero', version: 1, status: 'changes_requested', summary: 'nearly' });
    expect(d.status).toBe(200);
    expect(store.feedback('hero')).toMatchObject({ status: 'changes_requested', summary: 'nearly', comments: [{ id: 'c1' }] });

    expect((await fetch(url('/api/asset?name=nope'))).status).toBe(404);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/store.js';
import { fakeFile, PNG_1PX, tempDir } from './helpers.js';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = tempDir();
  store = Store.init(path.join(dir, '.arev'));
});

describe('submit & versioning', () => {
  it('creates versions v1, v2 and copies files into the object store', () => {
    const a = store.submit({ file: fakeFile(dir, 'a.png'), name: 'hero', note: 'first' });
    const b = store.submit({ file: fakeFile(dir, 'b.png'), name: 'hero' });
    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
    expect(a.kind).toBe('image');
    expect(fs.existsSync(a.file)).toBe(true);
    expect(a.file.startsWith(path.join(dir, '.arev', 'objects'))).toBe(true);
    expect(store.status('hero')).toMatchObject({ latest_version: 2, status: 'pending' });
  });

  it('supersedes a pending review when a new version arrives', () => {
    store.submit({ file: fakeFile(dir, 'a.png'), name: 'hero' });
    const b = store.submit({ file: fakeFile(dir, 'b.png'), name: 'hero' });
    expect(b.superseded).toBe(1);
    expect(store.reviewStatus('hero', 1).status).toBe('superseded');
  });

  it('rejects identical bytes unless forced', () => {
    const f = fakeFile(dir, 'a.png', 'same');
    store.submit({ file: f, name: 'hero' });
    expect(() => store.submit({ file: f, name: 'hero' })).toThrow(/identical to hero v1/);
    expect(store.submit({ file: f, name: 'hero', force: true }).version).toBe(2);
  });

  it('rejects kind changes, bad names, and unsupported types', () => {
    store.submit({ file: fakeFile(dir, 'a.png'), name: 'hero' });
    expect(() => store.submit({ file: fakeFile(dir, 'a.pdf'), name: 'hero' })).toThrow(/is a image/);
    expect(() => store.submit({ file: fakeFile(dir, 'a.png'), name: 'Bad Name' })).toThrow(/Invalid asset name/);
    expect(() => store.submit({ file: fakeFile(dir, 'a.png'), name: 'a//b' })).toThrow(/Invalid asset name/);
    expect(() => store.submit({ file: fakeFile(dir, 'a.txt'), name: 'notes' })).toThrow(/Unsupported/);
    expect(store.submit({ file: fakeFile(dir, 'x.mp4'), name: 'ep12/intro' }).kind).toBe('video');
  });
});

describe('decisions', () => {
  it('requires feedback for changes_requested / rejected', () => {
    store.submit({ file: fakeFile(dir, 'a.png'), name: 'hero' });
    expect(() => store.decide({ name: 'hero', status: 'rejected' })).toThrow(/needs a summary/);
    store.addComment({ name: 'hero', text: 'too dark' });
    expect(store.decide({ name: 'hero', status: 'rejected' }).status).toBe('rejected');
  });

  it('only allows deciding the latest version', () => {
    store.submit({ file: fakeFile(dir, 'a.png'), name: 'hero' });
    store.submit({ file: fakeFile(dir, 'b.png'), name: 'hero' });
    expect(() => store.decide({ name: 'hero', version: 1, status: 'approved' })).toThrow(/Only the latest/);
    expect(store.decide({ name: 'hero', status: 'approved' }).version).toBe(2);
    expect(store.file('hero', { approved: true }).version).toBe(2);
  });
});

describe('comments & feedback contract', () => {
  it('validates anchors per kind', () => {
    store.submit({ file: fakeFile(dir, 'a.png'), name: 'img' });
    store.submit({ file: fakeFile(dir, 'a.mp4'), name: 'vid' });
    store.submit({ file: fakeFile(dir, 'a.pdf'), name: 'doc' });
    expect(() => store.addComment({ name: 'img', text: 'x', anchor: { type: 'time', t: 1 } })).toThrow(/not valid for image/);
    expect(() => store.addComment({ name: 'img', text: 'x', anchor: { type: 'region', x: 0.9, y: 0, w: 0.5, h: 0.1 } })).toThrow(/past the edge/);
    expect(store.addComment({ name: 'vid', text: 'x', anchor: { type: 'range', start: 1, end: 2, region: { x: 0, y: 0, w: 0.5, h: 0.5 } } }).anchor).toMatchObject({ type: 'range' });
    expect(() => store.addComment({ name: 'doc', text: 'x', anchor: { type: 'page', page: 0 } })).toThrow(/positive integer/);
  });

  it('stores snapshots from data URLs', () => {
    store.submit({ file: fakeFile(dir, 'a.png'), name: 'hero' });
    const c = store.addComment({ name: 'hero', text: 'here', anchor: { type: 'point', x: 0.5, y: 0.5 }, snapshotDataUrl: PNG_1PX });
    expect(c.snapshot).toMatch(/snapshots\/c\d+\.png$/);
    expect(fs.existsSync(c.snapshot!)).toBe(true);
  });

  it('produces the feedback JSON shape and tracks resolution across versions', () => {
    store.submit({ file: fakeFile(dir, 'a.png'), name: 'hero', note: 'first try' });
    const c1 = store.addComment({ name: 'hero', text: 'bigger logo', anchor: { type: 'region', x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });
    const c2 = store.addComment({ name: 'hero', text: 'warmer colors' });
    store.decide({ name: 'hero', status: 'changes_requested', summary: 'close' });

    const fb1 = store.feedback('hero');
    expect(fb1).toMatchObject({
      asset: 'hero',
      kind: 'image',
      version: 1,
      latest_version: 1,
      status: 'changes_requested',
      summary: 'close',
      note: 'first try',
      decided_by: 'human',
      unresolved_from_previous: [],
    });
    expect(fb1.comments).toHaveLength(2);
    expect(fb1.comments[0]).toMatchObject({ id: c1.id, version: 1, text: 'bigger logo', author: 'human', resolved: false, anchor: { type: 'region' } });
    expect(Object.keys(fb1).sort()).toEqual(
      ['asset', 'comments', 'decided_at', 'decided_by', 'file', 'kind', 'latest_version', 'note', 'status', 'summary', 'unresolved_from_previous', 'version'].sort(),
    );

    // v2 resolves c1 only; c2 stays open.
    const v2 = store.submit({ file: fakeFile(dir, 'b.png'), name: 'hero', resolves: [c1.id] });
    expect(v2.resolved).toEqual([c1.id]);
    store.decide({ name: 'hero', status: 'changes_requested', summary: 'still cold' });
    const fb2 = store.feedback('hero');
    expect(fb2.version).toBe(2);
    expect(fb2.unresolved_from_previous.map((c) => c.id)).toEqual([c2.id]);

    // From v1's point of view nothing was resolved yet.
    expect(store.feedback('hero', { version: 1 }).comments.map((c) => c.resolved)).toEqual([true, false]);
    expect(store.feedbackAll('hero')).toHaveLength(2);
  });

  it('rejects --resolves ids from other assets', () => {
    store.submit({ file: fakeFile(dir, 'a.png'), name: 'one' });
    store.submit({ file: fakeFile(dir, 'b.png'), name: 'two' });
    const c = store.addComment({ name: 'one', text: 'x' });
    expect(() => store.submit({ file: fakeFile(dir, 'c.png'), name: 'two', resolves: [c.id] })).toThrow(/does not belong/);
    expect(store.status('two').latest_version).toBe(1); // transaction rolled back
  });

  it('defaults feedback to the latest decided version while a newer one is pending', () => {
    store.submit({ file: fakeFile(dir, 'a.png'), name: 'hero' });
    store.decide({ name: 'hero', status: 'changes_requested', summary: 'redo' });
    store.submit({ file: fakeFile(dir, 'b.png'), name: 'hero' });
    expect(store.feedback('hero')).toMatchObject({ version: 1, latest_version: 2, status: 'changes_requested' });
  });
});

describe('list & archive', () => {
  it('lists pending first, filters by status, hides archived', () => {
    store.submit({ file: fakeFile(dir, 'a.png'), name: 'done' });
    store.decide({ name: 'done', status: 'approved' });
    store.submit({ file: fakeFile(dir, 'b.png'), name: 'todo' });
    expect(store.list().map((r) => r.asset)).toEqual(['todo', 'done']);
    expect(store.list({ status: 'approved' }).map((r) => r.asset)).toEqual(['done']);
    store.archive('done');
    expect(store.list().map((r) => r.asset)).toEqual(['todo']);
    expect(store.submit({ file: fakeFile(dir, 'c.png'), name: 'done' }).version).toBe(2);
    expect(store.list()).toHaveLength(2);
  });
});

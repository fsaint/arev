import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeFile, tempDir } from './helpers.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const env = { ...process.env, AREV_POLL_MS: '100', AREV_NO_OPEN: '1', AREV_STORE: '' };
let cwd: string;

function arev(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

function arevAsync(...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error('run `npm run build` first');
  cwd = tempDir();
});

describe('arev CLI end to end', () => {
  it('runs the full submit → feedback → resubmit → approve loop', async () => {
    expect(arev('init').code).toBe(0);
    const v1 = fakeFile(cwd, 'v1.png');
    const v2 = fakeFile(cwd, 'v2.png');

    const s1 = arev('--json', 'submit', v1, '--name', 't', '--note', 'first', '--no-open');
    expect(s1.code).toBe(0);
    expect(s1.json()).toMatchObject({ asset: 't', version: 1, review_url: expect.stringContaining('/a/t/v/1') });

    // Works from a subdirectory (store found by walking up).
    fs.mkdirSync(path.join(cwd, 'sub'));
    expect(spawnSync(process.execPath, [CLI, 'status', 't'], { cwd: path.join(cwd, 'sub'), env }).status).toBe(0);

    // A background waiter returns when the human requests changes.
    const waiter = arevAsync('--json', 'wait', 't', '--timeout', '20s');
    await new Promise((r) => setTimeout(r, 300));
    expect(arev('comment', 't', 'make it pop', '--author', 'human', '--anchor', '{"type":"region","x":0.1,"y":0.1,"w":0.3,"h":0.3}').code).toBe(0);
    expect(arev('request-changes', 't', '-m', 'x').code).toBe(0);
    const w1 = await waiter;
    expect(w1.code).toBe(11);
    const fb = JSON.parse(w1.out);
    expect(fb).toMatchObject({ asset: 't', version: 1, status: 'changes_requested', summary: 'x' });
    expect(fb.comments[0]).toMatchObject({ id: 'c1', anchor: { type: 'region' } });

    const s2 = arev('--json', 'submit', v2, '--name', 't', '--resolves', 'c1', '--no-open');
    expect(s2.json()).toMatchObject({ version: 2, resolved: ['c1'] });

    expect(arev('approve', 't').code).toBe(0);
    expect(arev('--json', 'wait', 't').code).toBe(10);

    const out = path.join(cwd, 'out') + '/';
    const got = arev('--json', 'get', 't', '--approved', '-o', out).json();
    expect(got.version).toBe(2);
    expect(fs.readFileSync(got.file)).toEqual(fs.readFileSync(v2));

    expect(arev('feedback', 't', '--version', '1', '--format', 'md').out).toContain('**c1**');
  });

  it('reports rejections, timeouts and errors with the right exit codes', () => {
    const f = fakeFile(cwd, 'r.pdf');
    arev('submit', f, '--name', 'doc', '--no-open');
    expect(arev('wait', 'doc', '--timeout', '200ms').code).toBe(3);
    expect(arev('reject', 'doc', '-m', 'wrong direction').code).toBe(0);
    expect(arev('wait', 'doc').code).toBe(12);
    expect(arev('status', 'missing').code).toBe(2);
    const err = arev('--json', 'submit', f, '--name', 'doc', '--no-open');
    expect(err.code).toBe(1);
    expect(err.json().error.code).toBe('E_DUPLICATE');
  });

  it('submit --wait blocks and returns the decision', async () => {
    const f = fakeFile(cwd, 'w.png');
    const p = arevAsync('--json', 'submit', f, '--name', 'waiting', '--wait', '--no-open', '--timeout', '20s');
    await new Promise((r) => setTimeout(r, 400));
    expect(arev('approve', 'waiting', '-m', 'ship it').code).toBe(0);
    const r = await p;
    expect(r.code).toBe(10);
    expect(JSON.parse(r.out)).toMatchObject({ asset: 'waiting', version: 1, feedback: { status: 'approved', summary: 'ship it' } });
  });
});

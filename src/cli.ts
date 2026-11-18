#!/usr/bin/env node
import { Command, Option } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { ArevError, EXIT } from './errors.js';
import { feedbackMarkdown, statusLabel, summaryTable, versionsTable } from './format.js';
import { ensureServer, findServer, notify, openBrowser, reviewUrl } from './server/ensure.js';
import { startServer } from './server/server.js';
import { STORE_DIR, resolveStorePath, globalStorePath } from './store/find-store.js';
import { type Decision, type Feedback, Store } from './store/store.js';

const VERSION: string = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

interface GlobalOpts {
  json?: boolean;
  store?: string;
  global?: boolean;
}

const program = new Command();
program
  .name('arev')
  .description('Asset review loop for AI agents: submit images, videos and PDFs, get structured human feedback back.')
  // -V only: `--version` is used by subcommands to pick an asset version.
  .version(VERSION, '-V')
  .option('--json', 'machine-readable JSON output on stdout')
  .option('--store <dir>', 'path to a .arev store directory (or set AREV_STORE)')
  .option('--global', 'use the global store in ~/.arev');

function globals(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals() as GlobalOpts;
}

function openStore(g: GlobalOpts): Store {
  const root = resolveStorePath(g);
  if (g.global && !g.store && !fs.existsSync(path.join(root, 'arev.db'))) return Store.init(root);
  return Store.open(root);
}

function print(g: GlobalOpts, data: unknown, human: () => string): void {
  if (g.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else {
    const text = human();
    if (text) console.log(text);
  }
}

/** Wrap a command action with uniform error handling and exit codes. */
function action<A extends unknown[]>(fn: (...args: A) => Promise<number | void> | number | void) {
  return async (...args: A) => {
    const cmd = args[args.length - 1] as Command;
    const g = globals(cmd);
    try {
      const code = await fn(...args);
      process.exitCode = code ?? EXIT.OK;
    } catch (err) {
      if (err instanceof ArevError) {
        if (g.json) process.stdout.write(JSON.stringify({ error: { code: err.code, message: err.message } }, null, 2) + '\n');
        else console.error(`arev: ${err.message}`);
        process.exitCode = err.exitCode;
      } else {
        console.error(err);
        process.exitCode = EXIT.ERROR;
      }
    }
  };
}

function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) throw new ArevError('E_BAD_DURATION', `Invalid duration "${s}" (use e.g. 90s, 30m, 2h)`);
  const n = Number(m[1]);
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h'];
  return n * mult;
}

function parseVersion(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(String(v).replace(/^v/i, ''));
  if (!Number.isInteger(n) || n < 1) throw new ArevError('E_BAD_VERSION', `Invalid version "${v}"`);
  return n;
}

function exitForStatus(status: string): number {
  return status === 'approved' ? EXIT.APPROVED : status === 'changes_requested' ? EXIT.CHANGES_REQUESTED : EXIT.REJECTED;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the DB until the version is decided. Returns the feedback. */
async function waitForDecision(store: Store, name: string, version: number | undefined, timeoutMs: number): Promise<Feedback> {
  const target = store.reviewStatus(name, version).version;
  const pollMs = Number(process.env.AREV_POLL_MS) || 1000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status } = store.reviewStatus(name, target);
    if (status === 'superseded') {
      throw new ArevError('E_SUPERSEDED', `${name} v${target} was superseded by a newer version before it was reviewed.`);
    }
    if (status !== 'pending') return store.feedback(name, { version: target });
    if (Date.now() >= deadline) {
      throw new ArevError('E_TIMEOUT', `Timed out waiting for a review of ${name} v${target}. Run \`arev wait ${name}\` again to keep waiting.`, EXIT.TIMEOUT);
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

// ------------------------------------------------------------------ init

program
  .command('init')
  .description(`create a ${STORE_DIR}/ store in the current directory`)
  .action(
    action((_opts: unknown, cmd: Command) => {
      const g = globals(cmd);
      const root = g.store ? path.resolve(g.store) : g.global ? globalStorePath() : path.resolve(STORE_DIR);
      const existed = fs.existsSync(path.join(root, 'arev.db'));
      Store.init(root).close();
      print(g, { store: root, created: !existed }, () => (existed ? `Store already exists at ${root}` : `Created store at ${root}`));
    }),
  );

// ------------------------------------------------------------------ submit

program
  .command('submit')
  .description('submit a file as a new version of a named asset and ask for review')
  .argument('<file>', 'image, video or PDF file')
  .requiredOption('-n, --name <asset>', 'asset name, e.g. homepage-hero or ep12/thumbnail')
  .option('--note <text>', 'what changed in this version (shown to the reviewer)')
  .option('--resolves <ids>', 'comma-separated comment ids this version addresses, e.g. c12,c15')
  .option('--force', 'submit even if the file is identical to an earlier version')
  .option('--wait', 'block until the reviewer decides (exit 10 approved, 11 changes requested, 12 rejected)')
  .option('--timeout <duration>', 'with --wait: give up after this long (exit 3)', '30m')
  .option('--no-open', 'do not start the review server or open the browser')
  .action(
    action(async (file: string, opts: { name: string; note?: string; resolves?: string; force?: boolean; wait?: boolean; timeout: string; open: boolean }, cmd: Command) => {
      const g = globals(cmd);
      const store = openStore(g);
      const timeoutMs = parseDuration(opts.timeout);
      const res = store.submit({
        file,
        name: opts.name,
        note: opts.note,
        resolves: opts.resolves ? opts.resolves.split(',').map((s) => s.trim()).filter(Boolean) : [],
        force: opts.force,
      });

      const config = store.config;
      const shouldOpen = opts.open && process.env.AREV_NO_OPEN !== '1';
      // Without --no-open we start the server. With it, only point at a server that is
      // already running for this store; config.port may belong to another store's server.
      let port = shouldOpen ? config.port : ((await findServer(store.root)) ?? config.port);
      if (shouldOpen) {
        port = await ensureServer(store.root);
        const url = reviewUrl(port, res.asset, res.version);
        if (config.open_browser) openBrowser(url);
        if (config.notifications) notify('arev: review requested', `${res.asset} v${res.version}${opts.note ? ` — ${opts.note}` : ''}`);
      }
      const submitted = { ...res, review_url: reviewUrl(port, res.asset, res.version) };

      if (!opts.wait) {
        print(g, submitted, () =>
          [
            `Submitted ${res.asset} v${res.version} (${res.kind})`,
            res.superseded ? `  superseded pending v${res.superseded}` : '',
            res.resolved.length ? `  marked fixed: ${res.resolved.join(', ')}` : '',
            `  review: ${submitted.review_url}`,
          ]
            .filter(Boolean)
            .join('\n'),
        );
        return;
      }

      if (!g.json) console.error(`Submitted ${res.asset} v${res.version}. Waiting for review at ${submitted.review_url} ...`);
      const fb = await waitForDecision(store, res.asset, res.version, timeoutMs);
      print(g, { ...submitted, feedback: fb }, () => feedbackMarkdown(fb));
      return exitForStatus(fb.status);
    }),
  );

// ------------------------------------------------------------------ wait

program
  .command('wait')
  .description('block until a version is reviewed; prints the feedback (exit 10 approved, 11 changes requested, 12 rejected, 3 timeout)')
  .argument('<asset>')
  .option('-v, --version <n>', 'version to wait for (default: latest)')
  .option('--timeout <duration>', 'give up after this long', '30m')
  .action(
    action(async (name: string, opts: { version?: string; timeout: string }, cmd: Command) => {
      const g = globals(cmd);
      const store = openStore(g);
      const fb = await waitForDecision(store, name, parseVersion(opts.version), parseDuration(opts.timeout));
      print(g, fb, () => feedbackMarkdown(fb));
      return exitForStatus(fb.status);
    }),
  );

// ------------------------------------------------------------------ status / list

program
  .command('status')
  .description('show the review status of one asset, or all assets')
  .argument('[asset]')
  .action(
    action((name: string | undefined, _opts: unknown, cmd: Command) => {
      const g = globals(cmd);
      const store = openStore(g);
      if (name) {
        const s = store.status(name);
        print(g, s, () => summaryTable([s]));
      } else {
        const rows = store.list();
        print(g, { assets: rows }, () => summaryTable(rows));
      }
    }),
  );

program
  .command('list')
  .alias('ls')
  .description('list assets')
  .addOption(new Option('--status <status>', 'filter by status').choices(['pending', 'approved', 'changes_requested', 'rejected']))
  .option('--archived', 'include archived assets')
  .action(
    action((opts: { status?: string; archived?: boolean }, cmd: Command) => {
      const g = globals(cmd);
      const rows = openStore(g).list({ status: opts.status, includeArchived: opts.archived });
      print(g, { assets: rows }, () => summaryTable(rows));
    }),
  );

// ------------------------------------------------------------------ feedback / versions / get

program
  .command('feedback')
  .description('show reviewer feedback (default: latest decided version)')
  .argument('<asset>')
  .option('-v, --version <n>', 'a specific version')
  .option('--all', 'feedback for every version')
  .addOption(new Option('--format <format>', 'output format (default: md, or json with --json)').choices(['json', 'md']))
  .action(
    action((name: string, opts: { version?: string; all?: boolean; format?: string }, cmd: Command) => {
      const g = globals(cmd);
      const store = openStore(g);
      const asJson = opts.format ? opts.format === 'json' : !!g.json;
      const data = opts.all ? store.feedbackAll(name) : store.feedback(name, { version: parseVersion(opts.version) });
      if (asJson) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      else console.log(Array.isArray(data) ? data.map(feedbackMarkdown).join('\n\n---\n\n') : feedbackMarkdown(data));
    }),
  );

program
  .command('versions')
  .description('version history of an asset')
  .argument('<asset>')
  .action(
    action((name: string, _opts: unknown, cmd: Command) => {
      const g = globals(cmd);
      const info = openStore(g).versions(name);
      print(g, info, () => `${info.asset} (${info.kind})\n\n${versionsTable(info.versions)}`);
    }),
  );

program
  .command('get')
  .description("copy a version's file out of the store (default: latest)")
  .argument('<asset>')
  .option('-v, --version <n>', 'a specific version')
  .option('--approved', 'the newest approved version')
  .option('-o, --output <path>', 'destination file or directory (default: print the stored path)')
  .action(
    action((name: string, opts: { version?: string; approved?: boolean; output?: string }, cmd: Command) => {
      const g = globals(cmd);
      const f = openStore(g).file(name, { version: parseVersion(opts.version), approved: opts.approved });
      let dest = f.file;
      if (opts.output) {
        dest = path.resolve(opts.output);
        const isDir = (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) || /[\\/]$/.test(opts.output);
        if (isDir) {
          fs.mkdirSync(dest, { recursive: true });
          dest = path.join(dest, `${name.replace(/\//g, '-')}-v${f.version}${path.extname(f.file)}`);
        } else {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
        }
        fs.copyFileSync(f.file, dest);
      }
      print(g, { asset: name, version: f.version, file: dest, mime: f.mime }, () => dest);
    }),
  );

// ------------------------------------------------------------------ comment / decisions

program
  .command('comment')
  .description('add a comment to a version (default: latest)')
  .argument('<asset>')
  .argument('<text>')
  .option('-v, --version <n>', 'a specific version')
  .option('--anchor <json>', 'anchor JSON, e.g. \'{"type":"time","t":12.5}\'')
  .option('--author <who>', 'comment author', 'agent')
  .action(
    action((name: string, text: string, opts: { version?: string; anchor?: string; author: string }, cmd: Command) => {
      const g = globals(cmd);
      let anchor: unknown = null;
      if (opts.anchor) {
        try {
          anchor = JSON.parse(opts.anchor);
        } catch {
          throw new ArevError('E_BAD_ANCHOR', '--anchor must be valid JSON');
        }
      }
      const c = openStore(g).addComment({ name, version: parseVersion(opts.version), text, anchor, author: opts.author });
      print(g, c, () => `Added ${c.id} to ${name} v${c.version}`);
    }),
  );

function decisionCommand(cmdName: string, status: Decision, description: string, messageRequired: boolean) {
  const c = program.command(cmdName).description(description).argument('<asset>').option('-v, --version <n>', 'version (must be the latest)');
  if (messageRequired) c.requiredOption('-m, --message <text>', 'feedback summary (required)');
  else c.option('-m, --message <text>', 'optional summary');
  c.action(
    action((name: string, opts: { version?: string; message?: string }, cmd: Command) => {
      const g = globals(cmd);
      const fb = openStore(g).decide({ name, version: parseVersion(opts.version), status, summary: opts.message, by: 'human' });
      print(g, fb, () => `${name} v${fb.version}: ${statusLabel(fb.status)}`);
    }),
  );
}

decisionCommand('approve', 'approved', 'approve the latest version', false);
decisionCommand('request-changes', 'changes_requested', 'request changes on the latest version', true);
decisionCommand('reject', 'rejected', 'reject the latest version (agent should stop this direction)', true);

// ------------------------------------------------------------------ server / open / rm

program
  .command('serve')
  .description('run the review UI server in the foreground')
  .option('-p, --port <port>', 'port (default: config.port, 7717)')
  .action(
    action(async (opts: { port?: string }, cmd: Command) => {
      const g = globals(cmd);
      const store = openStore(g);
      const port = opts.port ? Number(opts.port) : store.config.port;
      const srv = await startServer(store, { port });
      console.log(`arev review server for ${store.root}\n  ${srv.url}`);
      await new Promise<void>((resolve) => {
        const stop = () => srv.close().then(resolve);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    }),
  );

program
  .command('open')
  .description('open the review page in the browser (starts the server if needed)')
  .argument('[asset]')
  .option('-v, --version <n>', 'a specific version')
  .action(
    action(async (name: string | undefined, opts: { version?: string }, cmd: Command) => {
      const g = globals(cmd);
      const store = openStore(g);
      if (name) store.status(name);
      const port = await ensureServer(store.root);
      const url = name ? reviewUrl(port, name, parseVersion(opts.version)) : `http://localhost:${port}/`;
      openBrowser(url);
      print(g, { url }, () => url);
    }),
  );

program
  .command('rm')
  .description('archive an asset (history is kept; submitting again restores it)')
  .argument('<asset>')
  .action(
    action((name: string, _opts: unknown, cmd: Command) => {
      const g = globals(cmd);
      openStore(g).archive(name);
      print(g, { asset: name, archived: true }, () => `Archived ${name}`);
    }),
  );

if (process.argv.length === 3 && process.argv[2] === '--version') {
  console.log(VERSION);
} else {
  program.parseAsync(process.argv);
}

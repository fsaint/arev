import { describeAnchor } from './anchors.js';
import type { AssetSummary, CommentOut, Feedback, VersionInfo } from './store/store.js';

const LABEL: Record<string, string> = {
  pending: 'pending review',
  approved: 'APPROVED',
  changes_requested: 'CHANGES REQUESTED',
  rejected: 'REJECTED',
  superseded: 'superseded',
};

export function statusLabel(s: string): string {
  return LABEL[s] ?? s;
}

function commentLine(c: CommentOut, showVersion = false): string {
  const box = c.resolved ? '[x]' : '[ ]';
  const where = describeAnchor(c.anchor);
  const v = showVersion ? ` v${c.version}` : '';
  let line = `- ${box} **${c.id}**${v} (${where}, ${c.author}): ${c.text}`;
  if (c.resolved_in_version) line += ` _(agent marked fixed in v${c.resolved_in_version})_`;
  if (c.snapshot) line += `\n  - snapshot: ${c.snapshot}`;
  return line;
}

export function feedbackMarkdown(f: Feedback): string {
  const out: string[] = [];
  out.push(`# ${f.asset} v${f.version} — ${statusLabel(f.status)}`);
  if (f.version !== f.latest_version) out.push(`_Note: latest version is v${f.latest_version}._`);
  out.push('');
  out.push(`- kind: ${f.kind}`);
  out.push(`- file: ${f.file}`);
  if (f.decided_at) out.push(`- decided: ${f.decided_at} by ${f.decided_by}`);
  if (f.note) out.push(`- agent note: ${f.note}`);
  if (f.summary) {
    out.push('', '## Reviewer summary', '', ...f.summary.split('\n').map((l) => `> ${l}`));
  }
  out.push('', '## Comments', '');
  out.push(f.comments.length ? f.comments.map((c) => commentLine(c)).join('\n') : '_No comments on this version._');
  if (f.unresolved_from_previous.length) {
    out.push('', '## Still open from earlier versions', '');
    out.push(f.unresolved_from_previous.map((c) => commentLine(c, true)).join('\n'));
  }
  return out.join('\n');
}

export function table(rows: string[][]): string {
  if (!rows.length) return '';
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ')).join('\n');
}

export function summaryTable(rows: AssetSummary[]): string {
  if (!rows.length) return 'No assets.';
  return table([
    ['ASSET', 'KIND', 'VERSION', 'STATUS', 'OPEN', 'UPDATED'],
    ...rows.map((r) => [r.asset, r.kind, `v${r.latest_version}`, statusLabel(r.status), String(r.open_comments), r.updated_at]),
  ]);
}

export function versionsTable(versions: VersionInfo[]): string {
  return table([
    ['VERSION', 'STATUS', 'COMMENTS', 'CREATED', 'NOTE / SUMMARY'],
    ...versions.map((v) => [
      `v${v.version}`,
      statusLabel(v.status),
      String(v.comments.length),
      v.created_at,
      [v.note && `note: ${v.note}`, v.summary && `review: ${v.summary}`].filter(Boolean).join(' | '),
    ]),
  ]);
}

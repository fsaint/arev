const LABEL = {
  pending: 'Awaiting review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  rejected: 'Rejected',
};
const ORDER = ['pending', 'changes_requested', 'approved', 'rejected'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? res.statusText);
  return body;
}

async function thumb(a) {
  // Thumbnails need the file URL of the latest version.
  const d = await api(`/api/asset?name=${encodeURIComponent(a.asset)}`);
  const v = d.versions[d.versions.length - 1];
  if (a.kind === 'image') return `<img loading="lazy" src="${v.file_url}" alt="">`;
  if (a.kind === 'video') return `<video muted preload="metadata" src="${v.file_url}#t=0.5"></video>`;
  return `<span class="pdf">PDF</span>`;
}

async function render() {
  const [{ assets }, health] = await Promise.all([api('/api/assets'), api('/api/health')]);
  document.getElementById('root').textContent = health.root;
  const pending = assets.filter((a) => a.status === 'pending').length;
  document.getElementById('counts').textContent = `${pending} awaiting review · ${assets.length} assets`;
  document.title = pending ? `(${pending}) arev · Review inbox` : 'arev · Review inbox';

  const main = document.getElementById('inbox');
  if (!assets.length) {
    main.innerHTML = `<div class="empty">No assets yet. An agent can submit one with<br><code>arev submit file.png --name my-asset</code></div>`;
    return;
  }
  const thumbs = await Promise.all(assets.map(thumb));
  const byStatus = Object.groupBy ? Object.groupBy(assets.map((a, i) => ({ ...a, thumb: thumbs[i] })), (a) => a.status)
    : assets.reduce((m, a, i) => ((m[a.status] ??= []).push({ ...a, thumb: thumbs[i] }), m), {});
  main.innerHTML = ORDER.filter((s) => byStatus[s]?.length)
    .map(
      (s) => `<h2>${LABEL[s]} (${byStatus[s].length})</h2>
      <div class="grid">${byStatus[s]
        .map(
          (a) => `<a class="card" href="/a/${a.asset}/v/${a.latest_version}">
            <div class="thumb">${a.thumb}</div>
            <div class="meta">
              <div class="name">${esc(a.asset)}</div>
              <div><span class="chip ${a.status}">${LABEL[a.status]}</span> <span class="muted">v${a.latest_version} · ${a.kind}${a.open_comments ? ` · ${a.open_comments} open` : ''}</span></div>
              <div class="muted">${new Date(a.updated_at).toLocaleString()}</div>
            </div>
          </a>`,
        )
        .join('')}</div>`,
    )
    .join('');
}

render().catch((e) => (document.getElementById('inbox').innerHTML = `<div class="empty error">${esc(e.message)}</div>`));
const events = new EventSource('/api/events');
let connectedOnce = false;
events.onmessage = () => render().catch(() => {});
events.onopen = () => {
  if (connectedOnce) render().catch(() => {}); // catch up after a reconnect
  connectedOnce = true;
};

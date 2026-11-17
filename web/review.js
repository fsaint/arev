// arev review page: viewer + anchored comments + decision bar.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clamp = (n) => Math.min(1, Math.max(0, n));
const r4 = (n) => Math.round(n * 10000) / 10000;
const r3 = (n) => Math.round(n * 1000) / 1000;

const LABEL = {
  pending: 'Awaiting review',
  approved: 'Approved',
  changes_requested: 'Changes requested',
  rejected: 'Rejected',
  superseded: 'Superseded',
};

const match = location.pathname.match(/^\/a\/(.+?)(?:\/v\/(\d+))?\/?$/);
const ASSET = decodeURIComponent(match[1]);
let viewN = match[2] ? Number(match[2]) : null;

let data = null;
let compareN = null;
let compareMode = 'side';
let surfaces = [];
let draft = null; // { anchor, surface, snapshot }
let renderedKey = '';
let videoEl = null;
let videoSurface = null;
let drawMode = false;
let zoom = null; // null = fit
let pendingFocus = null;
const pdfCache = new Map();

// ------------------------------------------------------------------ api

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message ?? res.statusText);
  return json;
}

function version(n) {
  return data.versions.find((v) => v.version === n);
}

function fmtTime(t) {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
}
const pct = (n) => `${Math.round(n * 100)}%`;

function describe(a) {
  if (!a) return 'general';
  const spot = a.region ? ', region' : a.point ? ', point' : '';
  switch (a.type) {
    case 'region': return `region ${pct(a.x)},${pct(a.y)} ${pct(a.w)}×${pct(a.h)}`;
    case 'point': return `point ${pct(a.x)},${pct(a.y)}`;
    case 'time': return `at ${fmtTime(a.t)}${spot}`;
    case 'range': return `${fmtTime(a.start)}–${fmtTime(a.end)}${spot}`;
    case 'page': return `page ${a.page}${spot}`;
  }
  return a.type;
}

function flashError(msg) {
  const info = $('decision-info');
  info.innerHTML = `<span class="error">${esc(msg)}</span>`;
}

// ------------------------------------------------------------------ load & render

async function load() {
  data = await api(`/api/asset?name=${encodeURIComponent(ASSET)}`);
  if (!viewN || !version(viewN)) viewN = data.latest_version;
  if (compareN && !version(compareN)) compareN = null;
  await renderAll();
}

async function renderAll() {
  renderHeader();
  renderHistory();
  renderComments();
  renderDecision();
  await renderViewer();
  renderMarkers();
  if (pendingFocus) {
    const c = pendingFocus;
    pendingFocus = null;
    focusComment(c);
  }
}

function setVersion(n) {
  if (n === viewN) return;
  viewN = n;
  if (compareN === n) compareN = null;
  history.replaceState(null, '', `/a/${ASSET}/v/${n}`);
  cancelDraft();
  return renderAll();
}

function renderHeader() {
  const v = version(viewN);
  document.title = `${ASSET} v${viewN} · arev`;
  $('title').textContent = ASSET;

  $('version-select').innerHTML = data.versions
    .slice()
    .reverse()
    .map((x) => `<option value="${x.version}" ${x.version === viewN ? 'selected' : ''}>v${x.version} — ${LABEL[x.status]}</option>`)
    .join('');

  const chip = $('status-chip');
  chip.className = `chip ${v.status}`;
  chip.textContent = LABEL[v.status];

  const others = data.versions.filter((x) => x.version !== viewN);
  $('compare-select').innerHTML =
    `<option value="">off</option>` +
    others.map((x) => `<option value="${x.version}" ${x.version === compareN ? 'selected' : ''}>v${x.version}</option>`).join('');
  $('compare-select').disabled = !others.length;
  $('compare-mode').hidden = !compareN || data.kind !== 'image';
  $('compare-mode').value = compareMode;

  const bits = [];
  if (v.note) bits.push(`<strong>Agent note:</strong> ${esc(v.note)}`);
  if (v.resolves.length) bits.push(`<strong>Says it fixes:</strong> ${v.resolves.map(esc).join(', ')}`);
  bits.push(`<span class="muted">v${v.version} · ${esc(v.original_name ?? '')} · ${(v.bytes / 1024).toFixed(0)} KB · ${new Date(v.created_at).toLocaleString()}</span>`);
  $('note').innerHTML = bits.join(' &nbsp;·&nbsp; ');

  $('hint').textContent = {
    image: 'Drag on the image to comment on a region, or click to mark a point.',
    video: 'Press C to comment at the current time. Turn on “Draw region” to mark an area of the frame.',
    pdf: 'Drag on a page to comment on a region, or use “Comment on page”.',
  }[data.kind];
}

// ------------------------------------------------------------------ history

function renderHistory() {
  const ol = $('version-history');
  ol.innerHTML = '';
  for (const x of data.versions.slice().reverse()) {
    const li = document.createElement('li');
    li.className = `hist${x.version === viewN ? ' current' : ''}`;
    li.title = `Show v${x.version}`;
    const thumb =
      data.kind === 'image' ? `<img src="${x.file_url}" alt="" loading="lazy">`
      : data.kind === 'video' ? `<video muted preload="metadata" src="${x.file_url}#t=0.5"></video>`
      : '<span>PDF</span>';
    const n = x.comments.length;
    const meta = [new Date(x.created_at).toLocaleString(), `${n} comment${n === 1 ? '' : 's'}`];
    if (x.resolves.length) meta.push(`fixes ${x.resolves.join(', ')}`);
    li.innerHTML = `
      <div class="hist-thumb">${thumb}</div>
      <div class="hist-body">
        <div class="hist-head"><strong>v${x.version}</strong><span class="chip ${x.status}">${LABEL[x.status]}</span></div>
        ${x.note ? `<div class="hist-note"><span class="muted">Agent:</span> ${esc(x.note)}</div>` : ''}
        ${x.summary ? `<div class="hist-note"><span class="muted">You:</span> “${esc(x.summary)}”</div>` : ''}
        <div class="hist-meta muted">${esc(meta.join(' · '))}</div>
      </div>`;
    li.addEventListener('click', () => setVersion(x.version));
    ol.append(li);
  }
}

// ------------------------------------------------------------------ toast

let toastTimer = null;
function toast(html, kind = '') {
  const t = $('toast');
  t.className = `toast ${kind}`;
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}

// ------------------------------------------------------------------ viewer

async function renderViewer() {
  const key = `${viewN}|${compareN}|${compareMode}`;
  if (key === renderedKey) return;
  renderedKey = key;
  surfaces = [];
  videoEl = null;
  videoSurface = null;
  drawMode = false;
  const viewer = $('viewer');
  viewer.innerHTML = '';
  $('toolbar').innerHTML = '';

  const cur = version(viewN);
  const other = compareN ? version(compareN) : null;
  if (other && compareMode === 'slider' && data.kind === 'image') return renderSlider(viewer, other, cur);

  let target = viewer;
  if (other) {
    viewer.innerHTML = `<div class="columns">
      <div><div class="col-label">v${other.version} (comparing)</div><div id="col-a"></div></div>
      <div><div class="col-label">v${cur.version} (reviewing)</div><div id="col-b"></div></div>
    </div>`;
    target = $('col-b');
    renderKind($('col-a'), other, false, key);
  }
  await renderKind(target, cur, true, key);
}

function renderKind(el, v, interactive, key) {
  if (data.kind === 'image') return renderImage(el, v, interactive);
  if (data.kind === 'video') return renderVideo(el, v, interactive);
  return renderPdf(el, v, interactive, key);
}

function makeSurfaceEl(parent) {
  const s = document.createElement('div');
  s.className = 'surface';
  parent.append(s);
  return s;
}

function tool(html, onClick) {
  const b = document.createElement('button');
  b.innerHTML = html;
  b.addEventListener('click', onClick);
  $('toolbar').append(b);
  return b;
}

function renderImage(el, v, interactive, opts = {}) {
  const s = makeSurfaceEl(el);
  const img = new Image();
  img.src = v.file_url;
  img.alt = `v${v.version}`;
  s.append(img);
  if (!interactive) return;

  const surface = {
    el: s,
    matches: (a) => a && (a.type === 'region' || a.type === 'point'),
    spotOf: (a) => (a.type === 'region' ? { region: a } : { point: a }),
    makeAnchor: (spot) => (spot.region ? { type: 'region', ...spot.region } : { type: 'point', ...spot.point }),
    source: () => ({ el: img, w: img.naturalWidth, h: img.naturalHeight }),
  };
  attachOverlay(s, surface);
  surfaces.push(surface);

  if (opts.noZoom) return;
  const applyZoom = () => {
    if (zoom === null) {
      img.style.width = '';
      s.classList.remove('zoomed');
    } else {
      img.style.width = `${img.naturalWidth * zoom}px`;
      s.classList.add('zoomed');
    }
    label.textContent = zoom === null ? 'fit' : `${Math.round(zoom * 100)}%`;
  };
  const fitScale = () => img.getBoundingClientRect().width / img.naturalWidth || 1;
  tool('Fit', () => ((zoom = null), applyZoom()));
  tool('1:1', () => ((zoom = 1), applyZoom()));
  tool('−', () => ((zoom = Math.max(0.1, (zoom ?? fitScale()) / 1.25)), applyZoom()));
  tool('+', () => ((zoom = Math.min(8, (zoom ?? fitScale()) * 1.25)), applyZoom()));
  const label = document.createElement('span');
  label.className = 'muted';
  $('toolbar').append(label);
  img.addEventListener('load', applyZoom);
  applyZoom();
}

function renderSlider(viewer, other, cur) {
  const wrap = document.createElement('div');
  wrap.className = 'slider-wrap';
  const base = new Image();
  base.src = other.file_url;
  wrap.append(base);
  const top = document.createElement('div');
  top.className = 'slider-top';
  wrap.append(top);
  const line = document.createElement('div');
  line.className = 'slider-line';
  wrap.append(line);
  viewer.append(wrap);
  renderImage(top, cur, true, { noZoom: true });

  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0';
  range.max = '100';
  range.value = '50';
  const apply = () => {
    top.style.clipPath = `inset(0 0 0 ${range.value}%)`;
    line.style.left = `${range.value}%`;
  };
  range.addEventListener('input', apply);
  apply();
  const lbl = document.createElement('span');
  lbl.className = 'muted';
  lbl.textContent = `left: v${other.version} · right: v${cur.version} (reviewing)`;
  $('toolbar').append(range, lbl);
}

function renderVideo(el, v, interactive) {
  const s = makeSurfaceEl(el);
  const video = document.createElement('video');
  video.src = v.file_url;
  video.controls = true;
  video.preload = 'auto';
  video.playsInline = true;
  s.append(video);
  if (!interactive) return;

  videoEl = video;
  const surface = {
    el: s,
    matches: (a) => a && (a.type === 'time' || a.type === 'range'),
    spotOf: (a) => (a.region ? { region: a.region } : a.point ? { point: a.point } : null),
    visible: (a) => {
      const t = video.currentTime;
      return a.type === 'time' ? Math.abs(t - a.t) < 0.75 : t >= a.start - 0.3 && t <= a.end + 0.3;
    },
    onStart: () => video.pause(),
    makeAnchor: (spot) => ({ type: 'time', t: r3(video.currentTime), ...spot }),
    source: () => ({ el: video, w: video.videoWidth, h: video.videoHeight }),
  };
  const ov = attachOverlay(s, surface);
  ov.classList.add('passive');
  surfaces.push(surface);
  videoSurface = surface;
  video.addEventListener('timeupdate', renderMarkers);
  video.addEventListener('seeked', renderMarkers);

  const step = (d) => {
    video.pause();
    video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + d));
  };
  tool('◀ frame', () => step(-1 / 30));
  tool('frame ▶', () => step(1 / 30));
  tool('Comment at current time <kbd>C</kbd>', commentAtTime);
  const drawBtn = tool('Draw region', () => {
    drawMode = !drawMode;
    drawBtn.classList.toggle('on', drawMode);
    ov.classList.toggle('passive', !drawMode);
    if (drawMode) video.pause();
  });
  const time = document.createElement('span');
  time.className = 'mono muted';
  $('toolbar').append(time);
  const upd = () => (time.textContent = `${fmtTime(video.currentTime)} / ${video.duration ? fmtTime(video.duration) : '–'}`);
  video.addEventListener('timeupdate', upd);
  video.addEventListener('loadedmetadata', upd);
}

function commentAtTime() {
  if (!videoEl) return;
  videoEl.pause();
  openDraft({ type: 'time', t: r3(videoEl.currentTime) }, videoSurface);
}

function getPdf(v) {
  if (!pdfCache.has(v.id)) {
    pdfCache.set(
      v.id,
      (async () => {
        const pdfjs = await import('/vendor/pdfjs/pdf.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
        return pdfjs.getDocument(v.file_url).promise;
      })(),
    );
  }
  return pdfCache.get(v.id);
}

async function renderPdf(el, v, interactive, key) {
  const pages = document.createElement('div');
  pages.className = 'pdf-pages';
  pages.innerHTML = '<div class="muted">Loading PDF…</div>';
  el.append(pages);
  let doc;
  try {
    doc = await getPdf(v);
  } catch (e) {
    pages.innerHTML = `<div class="error">Could not load PDF: ${esc(e.message)}</div>`;
    return;
  }
  if (key !== renderedKey) return;
  pages.innerHTML = '';

  if (interactive) {
    const jump = document.createElement('input');
    jump.type = 'number';
    jump.min = '1';
    jump.max = String(doc.numPages);
    jump.value = '1';
    jump.style.width = '70px';
    jump.addEventListener('change', () => document.getElementById(`page-${jump.value}`)?.scrollIntoView({ behavior: 'smooth' }));
    const lbl = document.createElement('span');
    lbl.className = 'muted';
    lbl.textContent = `of ${doc.numPages} pages`;
    $('toolbar').append('Page ', jump, lbl);
  }

  const cssW = Math.min(1000, Math.max(300, (el.clientWidth || 800) - 4));
  const dpr = window.devicePixelRatio || 1;
  for (let p = 1; p <= doc.numPages; p++) {
    if (key !== renderedKey) return;
    const page = await doc.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (cssW / base.width) * dpr });

    const box = document.createElement('div');
    if (interactive) box.id = `page-${p}`;
    const head = document.createElement('div');
    head.className = 'page-head';
    head.innerHTML = `<span>Page ${p}</span>`;
    box.append(head);
    const s = makeSurfaceEl(box);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = `${cssW}px`;
    s.append(canvas);
    pages.append(box);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    if (interactive) {
      const surface = {
        el: s,
        page: p,
        matches: (a) => a && a.type === 'page' && a.page === p,
        spotOf: (a) => (a.region ? { region: a.region } : a.point ? { point: a.point } : null),
        makeAnchor: (spot) => ({ type: 'page', page: p, ...spot }),
        source: () => ({ el: canvas, w: canvas.width, h: canvas.height }),
      };
      attachOverlay(s, surface);
      surfaces.push(surface);
      const btn = document.createElement('button');
      btn.textContent = 'Comment on page';
      btn.addEventListener('click', () => openDraft({ type: 'page', page: p }, surface));
      head.append(btn);
      renderMarkers();
    }
  }
}

// ------------------------------------------------------------------ drawing

function attachOverlay(surfaceEl, surface) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  surfaceEl.append(ov);
  surface.overlay = ov;

  let start = null;
  let box = null;
  const norm = (e) => {
    const r = ov.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height), r };
  };
  const rectOf = (a, b) => ({
    x: r4(Math.min(a.x, b.x)),
    y: r4(Math.min(a.y, b.y)),
    w: r4(Math.abs(a.x - b.x)),
    h: r4(Math.abs(a.y - b.y)),
  });

  ov.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    ov.setPointerCapture(e.pointerId);
    surface.onStart?.();
    start = norm(e);
    box = document.createElement('div');
    box.className = 'marker draft';
    ov.append(box);
    placeMarker(box, { region: { x: start.x, y: start.y, w: 0, h: 0 } });
  });
  ov.addEventListener('pointermove', (e) => {
    if (!start) return;
    placeMarker(box, { region: rectOf(start, norm(e)) });
  });
  const finish = (e, cancelled) => {
    if (!start) return;
    const end = norm(e);
    const r = rectOf(start, end);
    box.remove();
    const tiny = r.w * end.r.width < 6 && r.h * end.r.height < 6;
    start = null;
    if (cancelled) return;
    const spot = tiny ? { point: { x: r4(end.x), y: r4(end.y) } } : { region: r };
    openDraft(surface.makeAnchor(spot), surface);
  };
  ov.addEventListener('pointerup', (e) => finish(e, false));
  ov.addEventListener('pointercancel', (e) => finish(e, true));
  return ov;
}

function placeMarker(el, spot) {
  if (spot.region) {
    el.classList.remove('point');
    Object.assign(el.style, {
      left: `${spot.region.x * 100}%`,
      top: `${spot.region.y * 100}%`,
      width: `${spot.region.w * 100}%`,
      height: `${spot.region.h * 100}%`,
    });
  } else {
    el.classList.add('point');
    Object.assign(el.style, { left: `${spot.point.x * 100}%`, top: `${spot.point.y * 100}%`, width: '', height: '' });
  }
}

function renderMarkers() {
  if (!data) return;
  const comments = version(viewN)?.comments ?? [];
  for (const s of surfaces) {
    if (!s.overlay) continue;
    s.overlay.querySelectorAll('.marker:not(.draft), .marker.pending-draft').forEach((m) => m.remove());
    const items = comments.filter((c) => s.matches(c.anchor) && (!s.visible || s.visible(c.anchor)));
    for (const c of items) {
      const spot = s.spotOf(c.anchor);
      if (!spot) continue;
      const m = document.createElement('div');
      m.className = 'marker';
      m.dataset.id = c.id;
      m.innerHTML = `<span class="tag">${esc(c.id)}</span>`;
      placeMarker(m, spot);
      s.overlay.append(m);
    }
    if (draft && draft.surface === s) {
      const spot = s.spotOf(draft.anchor);
      if (spot) {
        const m = document.createElement('div');
        m.className = 'marker draft pending-draft';
        m.innerHTML = '<span class="tag">new</span>';
        placeMarker(m, spot);
        s.overlay.append(m);
      }
    }
  }
}

// ------------------------------------------------------------------ snapshots

/** Render the full frame/page/image with the anchored spot outlined, as a PNG data URL. */
function snapshotFor(anchor, surface) {
  const src = surface.source();
  if (!src || !src.w || !src.h) return null;
  const scale = Math.min(1, 1600 / src.w);
  const cw = Math.round(src.w * scale);
  const ch = Math.round(src.h * scale);
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext('2d');
  try {
    ctx.drawImage(src.el, 0, 0, cw, ch);
  } catch {
    return null;
  }
  const spot = surface.spotOf(anchor);
  ctx.strokeStyle = '#ff2d55';
  ctx.lineWidth = Math.max(3, cw / 250);
  if (spot?.region) ctx.strokeRect(spot.region.x * cw, spot.region.y * ch, spot.region.w * cw, spot.region.h * ch);
  if (spot?.point) {
    ctx.beginPath();
    ctx.arc(spot.point.x * cw, spot.point.y * ch, Math.max(12, cw / 50), 0, Math.PI * 2);
    ctx.stroke();
  }
  try {
    return c.toDataURL('image/png');
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ composer

function openDraft(anchor, surface) {
  if (!surface) return;
  draft = { anchor, surface, snapshot: snapshotFor(anchor, surface) };
  $('composer').hidden = false;
  $('composer-anchor').textContent = describe(anchor);
  const extra = $('composer-extra');
  extra.innerHTML = '';
  if (anchor.type === 'time' || anchor.type === 'range') {
    const b = document.createElement('button');
    b.textContent = 'Set end = current time (range)';
    b.addEventListener('click', () => {
      const start = draft.anchor.type === 'time' ? draft.anchor.t : draft.anchor.start;
      const end = r3(videoEl.currentTime);
      if (end <= start) return flashError('Move the playhead past the start time first.');
      const { region, point } = draft.anchor;
      draft.anchor = { type: 'range', start, end, ...(region ? { region } : {}), ...(point ? { point } : {}) };
      $('composer-anchor').textContent = describe(draft.anchor);
    });
    extra.append(b);
  }
  $('composer-text').focus();
  renderMarkers();
}

function cancelDraft() {
  draft = null;
  $('composer').hidden = true;
  $('composer-text').value = '';
  renderMarkers();
}

async function saveDraft() {
  if (!draft) return;
  const text = $('composer-text').value.trim();
  if (!text) return $('composer-text').focus();
  try {
    await api('/api/comments', { asset: ASSET, version: viewN, text, anchor: draft.anchor, snapshot: draft.snapshot ?? undefined });
    cancelDraft();
    await load();
  } catch (e) {
    flashError(e.message);
  }
}

async function addGeneral() {
  const text = $('general-text').value.trim();
  if (!text) return $('general-text').focus();
  try {
    await api('/api/comments', { asset: ASSET, version: viewN, text, anchor: null });
    $('general-text').value = '';
    await load();
  } catch (e) {
    flashError(e.message);
  }
}

// ------------------------------------------------------------------ comment list

function commentItem(c, { showVersion = false, deletable = false } = {}) {
  const li = document.createElement('li');
  li.className = 'comment';
  li.innerHTML = `
    <div class="head">
      <span class="id">${esc(c.id)}</span>
      ${showVersion ? `<span>v${c.version}</span>` : ''}
      <span>${esc(describe(c.anchor))}</span>
      <span>· ${esc(c.author)}</span>
      ${deletable ? '<button class="del" title="Delete comment">✕</button>' : ''}
    </div>
    <div class="text">${esc(c.text)}</div>
    ${c.resolved_in_version ? `<div class="fixed">✓ agent marked fixed in v${c.resolved_in_version}</div>` : ''}
    ${c.snapshot_url ? `<img class="snap" loading="lazy" src="${c.snapshot_url}" alt="">` : ''}`;
  li.addEventListener('click', () => focusComment(c));
  li.querySelector('.del')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await api('/api/comments/delete', { id: c.id });
      await load();
    } catch (err) {
      flashError(err.message);
    }
  });
  return li;
}

function renderComments() {
  const v = version(viewN);
  const list = $('comments');
  list.innerHTML = '';
  if (!v.comments.length) list.innerHTML = '<li class="muted" style="list-style:none">No comments yet.</li>';
  for (const c of v.comments) list.append(commentItem(c, { deletable: c.author === 'human' }));

  const earlier = data.versions
    .filter((x) => x.version < viewN)
    .flatMap((x) => x.comments)
    .filter((c) => c.resolved_in_version === null || c.resolved_in_version >= viewN);
  const prev = $('prev-comments');
  prev.innerHTML = '';
  $('prev-wrap').hidden = !earlier.length;
  for (const c of earlier) {
    // Comments the agent says this version fixes are listed too, so the reviewer can verify them.
    const shown = c.resolved_in_version === viewN ? c : { ...c, resolved_in_version: null };
    prev.append(commentItem(shown, { showVersion: true }));
  }
}

function focusComment(c) {
  if (c.version !== viewN) {
    pendingFocus = c;
    setVersion(c.version);
    return;
  }
  const a = c.anchor;
  if (!a) return;
  if ((a.type === 'time' || a.type === 'range') && videoEl) {
    videoEl.pause();
    videoEl.currentTime = a.type === 'time' ? a.t : a.start;
  }
  if (a.type === 'page') document.getElementById(`page-${a.page}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => {
    renderMarkers();
    const m = document.querySelector(`.marker[data-id="${c.id}"]`);
    if (!m) return;
    if (a.type !== 'page') m.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    m.classList.remove('flash');
    void m.offsetWidth;
    m.classList.add('flash');
  }, 250);
}

// ------------------------------------------------------------------ decision

const BUTTONS = { approved: 'btn-approve', changes_requested: 'btn-changes', rejected: 'btn-reject' };
const ICON = { approved: '✓', changes_requested: '↺', rejected: '✕' };
let deciding = null; // status being sent

function renderDecision() {
  const v = version(viewN);
  const isLatest = viewN === data.latest_version;
  const hasFeedback = !!$('summary').value.trim() || v.comments.length > 0;
  $('btn-approve').disabled = !isLatest || !!deciding;
  $('btn-changes').disabled = !isLatest || !hasFeedback || !!deciding;
  $('btn-reject').disabled = !isLatest || !hasFeedback || !!deciding;
  for (const [status, id] of Object.entries(BUTTONS)) {
    $(id).classList.toggle('chosen', v.status === status);
    $(id).textContent = deciding === status ? 'Sending…' : { approved: 'Approve', changes_requested: 'Request changes', rejected: 'Reject' }[status];
  }
  document.querySelector('.decision-bar').dataset.state = isLatest ? v.status : '';
  const info = $('decision-info');
  if (!isLatest) {
    info.innerHTML = `Viewing an older version. Decisions apply to the latest — <a href="#" id="go-latest">go to v${data.latest_version}</a>.`;
    $('go-latest').addEventListener('click', (e) => (e.preventDefault(), setVersion(data.latest_version)));
  } else if (v.status === 'pending') {
    info.textContent = hasFeedback ? 'Awaiting your decision.' : 'Awaiting your decision. Add a comment or summary to request changes or reject.';
  } else {
    info.innerHTML = `<strong class="decided ${v.status}">${ICON[v.status] ?? ''} ${LABEL[v.status]}</strong> · sent ${esc(new Date(v.decided_at).toLocaleString())}${v.summary ? ` — “${esc(v.summary)}”` : ''}. The agent receives it when it next checks. You can still change it.`;
  }
}

async function decide(status) {
  if (deciding) return;
  deciding = status;
  renderDecision();
  const n = viewN;
  try {
    await api('/api/decision', { asset: ASSET, version: n, status, summary: $('summary').value });
    $('summary').value = '';
    deciding = null;
    await load();
    toast(`<strong>${ICON[status]} ${LABEL[status]}: v${n}</strong> Your decision was saved and sent to the agent.`, status);
  } catch (e) {
    deciding = null;
    renderDecision();
    flashError(e.message);
  }
}

// ------------------------------------------------------------------ wiring

$('version-select').addEventListener('change', (e) => setVersion(Number(e.target.value)));
$('compare-select').addEventListener('change', (e) => {
  compareN = e.target.value ? Number(e.target.value) : null;
  renderHeader();
  renderViewer().then(renderMarkers);
});
$('compare-mode').addEventListener('change', (e) => {
  compareMode = e.target.value;
  renderViewer().then(renderMarkers);
});
$('composer-save').addEventListener('click', saveDraft);
$('composer-cancel').addEventListener('click', cancelDraft);
$('general-add').addEventListener('click', addGeneral);
$('summary').addEventListener('input', renderDecision);
$('btn-approve').addEventListener('click', () => decide('approved'));
$('btn-changes').addEventListener('click', () => decide('changes_requested'));
$('btn-reject').addEventListener('click', () => decide('rejected'));

document.addEventListener('keydown', (e) => {
  const typing = /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement?.tagName ?? '');
  if (e.key === 'Escape' && draft) return cancelDraft();
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    if (document.activeElement === $('composer-text')) return saveDraft();
    if (document.activeElement === $('general-text')) return addGeneral();
  }
  if (typing) return;
  if ((e.key === 'c' || e.key === 'C') && videoEl && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    commentAtTime();
  }
});

// Live updates. A new version replaces the one on screen automatically, unless the
// reviewer is in the middle of writing something; then a banner offers the switch.
function busyWriting() {
  return !!draft || !!$('summary').value.trim() || !!$('general-text').value.trim() || !!$('composer-text').value.trim();
}

const events = new EventSource('/api/events');
let connectedOnce = false;
events.onopen = () => {
  // After a reconnect (e.g. the server restarted) events may have been missed.
  if (connectedOnce) load().catch(() => {});
  connectedOnce = true;
};
events.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.asset !== ASSET) return;
  const n = ev.payload?.version;
  if (ev.type === 'version_submitted' && n > viewN) {
    const banner = $('banner');
    if (busyWriting()) {
      banner.hidden = false;
      banner.innerHTML = `A new version (v${n}) was just submitted. <a href="#">Review it</a>`;
      banner.querySelector('a').addEventListener('click', (x) => {
        x.preventDefault();
        banner.hidden = true;
        setVersion(n);
      });
    } else {
      banner.hidden = true;
      viewN = n;
      if (compareN === n) compareN = null;
      history.replaceState(null, '', `/a/${ASSET}/v/${n}`);
      toast(`<strong>v${n} arrived</strong> Now showing the new version.`);
    }
  }
  load().catch(() => {});
};

load().catch((e) => ($('viewer').innerHTML = `<div class="empty error">${esc(e.message)}</div>`));

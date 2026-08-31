/**
 * Doctorna Intelligence — landing page.
 *
 * Reads the static JSON the pipeline publishes. It never loads the archive:
 * `index.json` is small (featured + counts), and the stream is fetched a page
 * at a time. Filtering happens over what has been loaded, and "Load more"
 * pulls the next page — so a browser holds a screenful, not a database.
 */
const $ = (s, r = document) => r.querySelector(s);
const DATA = '/intelligence/data';

const state = {
  index: null,
  pages: [],          // loaded page numbers
  items: [],          // everything loaded so far
  category: new URL(location.href).searchParams.get('category') ?? '',
  type: '',
  source: '',
  query: '',
};

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmt = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.valueOf()) ? ''
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
const fold = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/* ── cards ─────────────────────────────────────────────────── */

const meta = (a) => `
  <span class="intel-meta">
    <span class="intel-src">${esc(a.sourceName)}</span>
    ${a.originalPublishedAt ? `<span class="intel-dot" aria-hidden="true"></span>
      <time datetime="${esc(a.originalPublishedAt)}">${esc(fmt(a.originalPublishedAt))}</time>` : ''}
    ${a.related?.specialties?.length ? `<span class="intel-dot" aria-hidden="true"></span>
      <span>${esc(a.related.specialties[0].label)}</span>` : ''}
  </span>`;

const kicker = (a) => `
  <span class="intel-kicker">
    <span class="intel-cat">${esc(a.categoryLabel)}</span>
    <span class="intel-type intel-type-${esc(a.contentType)}">${esc(a.contentTypeLabel)}</span>
  </span>`;

function itemCard(a, { thumb = false } = {}) {
  return `<article class="intel-item">
    <a class="intel-link" href="/intelligence/a/${esc(a.slug)}/">
      ${thumb && a.image ? `<img class="intel-thumb" src="${esc(a.image)}" alt="" loading="lazy" decoding="async">` : ''}
      ${kicker(a)}
      <h3>${esc(a.title)}</h3>
      ${a.summary ? `<p>${esc(a.summary.slice(0, 180))}${a.summary.length > 180 ? '…' : ''}</p>` : ''}
      ${meta(a)}
    </a>
  </article>`;
}

function featured(items) {
  if (!items.length) return '';
  const [lead, ...rest] = items;
  return `<div class="intel-lead">
    <div class="intel-lead-main">
      <a class="intel-link" href="/intelligence/a/${esc(lead.slug)}/">
        ${lead.image ? `<img class="intel-thumb" src="${esc(lead.image)}" alt="" loading="lazy" decoding="async">` : ''}
        ${kicker(lead)}
        <h3>${esc(lead.title)}</h3>
        ${lead.summary ? `<p>${esc(lead.summary.slice(0, 260))}${lead.summary.length > 260 ? '…' : ''}</p>` : ''}
        ${meta(lead)}
      </a>
    </div>
    <div class="intel-lead-side">${rest.slice(0, 4).map((a) => itemCard(a)).join('')}</div>
  </div>`;
}

/* ── filtering ─────────────────────────────────────────────── */

function visible() {
  const q = fold(state.query);
  return state.items.filter((a) => {
    if (state.category && a.category !== state.category) return false;
    if (state.type && a.contentType !== state.type) return false;
    if (state.source && a.sourceName !== state.source) return false;
    if (q) {
      const hay = fold(`${a.title} ${a.summary ?? ''} ${a.sourceName} ${a.categoryLabel}`);
      if (!q.split(' ').every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

function paintStream() {
  const list = visible();
  $('#streamHost').innerHTML = list.map((a) => itemCard(a, { thumb: true })).join('');
  $('#streamEmpty').hidden = list.length > 0 || state.items.length === 0;
  $('#latestCount').textContent = state.index
    ? `${list.length} of ${state.index.total} published`
    : '';
  const more = $('#intelMore');
  more.hidden = !state.index || state.pages.length >= state.index.pages;
}

function paintCats() {
  const rail = $('#catRail');
  const counts = state.index?.categories ?? {};
  const labels = new Map(state.items.map((a) => [a.category, a.categoryLabel]));
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  rail.innerHTML = [
    `<button class="intel-cat-btn" type="button" data-cat="" aria-pressed="${state.category === ''}">All<span class="n">${state.index?.total ?? 0}</span></button>`,
    ...entries.map(([key, n]) => `<button class="intel-cat-btn" type="button" data-cat="${esc(key)}"
        aria-pressed="${state.category === key}">${esc(labels.get(key) ?? key)}<span class="n">${n}</span></button>`),
  ].join('');
}

/* ── loading ───────────────────────────────────────────────── */

async function loadPage(n) {
  if (state.pages.includes(n)) return;
  const page = await getJSON(`${DATA}/page-${n}.json`);
  state.pages.push(n);
  state.items.push(...page.items);
  // Source filter is built from what has actually been loaded.
  const sel = $('#intelSource');
  const seen = new Set([...sel.options].map((o) => o.value));
  for (const a of page.items) {
    if (!seen.has(a.sourceName)) {
      seen.add(a.sourceName);
      sel.insertAdjacentHTML('beforeend', `<option value="${esc(a.sourceName)}">${esc(a.sourceName)}</option>`);
    }
  }
}

async function boot() {
  let index;
  try {
    index = await getJSON(`${DATA}/index.json`);
  } catch {
    // No published dataset at all — say so plainly.
    $('#featured').hidden = true; $('#categories').hidden = true;
    $('#latest').hidden = true; $('#research').hidden = true;
    $('#bootEmpty').hidden = false;
    $('#bootEmptyNote').textContent =
      'No published dataset was found at /intelligence/data/index.json.';
    return;
  }
  state.index = index;

  if (index.total === 0) {
    $('#featured').hidden = true; $('#categories').hidden = true;
    $('#latest').hidden = true; $('#research').hidden = true;
    $('#bootEmpty').hidden = false;
    $('#bootEmptyNote').textContent =
      'The pipeline has run but nothing has reached PUBLISHED yet. Items awaiting medical or '
      + 'editorial review are held deliberately.';
    return;
  }

  // Signals — only what the data supports.
  if (index.signals?.length) {
    $('#signalGrid').innerHTML = index.signals.map((s) => `
      <div class="intel-signal"><b>${esc(String(s.value))}</b><span>${esc(s.label)}</span></div>`).join('');
    $('#signals').hidden = false;
  }

  $('#featuredHost').innerHTML = featured(index.featured ?? []);
  $('#featuredCount').textContent = `${index.total} item${index.total === 1 ? '' : 's'}`;

  // UAE first, then global. Both are rendered from published counts; neither is
  // hidden, and an empty section stays absent rather than showing a stub.
  if (index.uaeLatest?.length) {
    $('#uaeHost').innerHTML = index.uaeLatest.map((a) => itemCard(a, { thumb: true })).join('');
    $('#uaeCount').textContent = `${index.regions?.uae ?? index.uaeLatest.length} UAE item(s)`;
    $('#uae').hidden = false;
  }
  if (index.globalLatest?.length) {
    $('#globalHost').innerHTML = index.globalLatest.map((a) => itemCard(a)).join('');
    $('#globalCount').textContent = `${index.regions?.global ?? index.globalLatest.length} global item(s)`;
    $('#global').hidden = false;
  }

  // Content-type filter, from the published counts.
  const typeSel = $('#intelType');
  const seenTypes = new Map((index.featured ?? []).map((a) => [a.contentType, a.contentTypeLabel]));
  for (const [key] of Object.entries(index.contentTypes ?? {})) {
    if (!seenTypes.has(key)) seenTypes.set(key, key);
  }
  for (const [key, label] of seenTypes) {
    typeSel.insertAdjacentHTML('beforeend', `<option value="${esc(key)}">${esc(label)}</option>`);
  }

  await loadPage(1);
  paintCats();
  paintStream();

  if (index.research?.length) {
    $('#researchHost').innerHTML = index.research.map((a) => itemCard(a)).join('');
  } else {
    $('#researchEmpty').hidden = false;
  }
}

/* ── events ────────────────────────────────────────────────── */

$('#catRail').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  state.category = b.dataset.cat;
  const url = new URL(location.href);
  if (state.category) url.searchParams.set('category', state.category);
  else url.searchParams.delete('category');
  history.replaceState(null, '', url);
  paintCats();
  paintStream();
});

let debounce;
$('#intelSearch').addEventListener('input', (e) => {
  clearTimeout(debounce);
  const v = e.target.value;
  debounce = setTimeout(() => { state.query = v; paintStream(); }, 160);
});
$('#intelType').addEventListener('change', (e) => { state.type = e.target.value; paintStream(); });
$('#intelSource').addEventListener('change', (e) => { state.source = e.target.value; paintStream(); });

$('#intelMore').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await loadPage(state.pages.length + 1);
    paintStream();
  } finally { btn.disabled = false; }
});

boot().catch((err) => {
  $('#bootEmpty').hidden = false;
  $('#bootEmptyNote').textContent = `Could not load the intelligence dataset: ${err.message}`;
});

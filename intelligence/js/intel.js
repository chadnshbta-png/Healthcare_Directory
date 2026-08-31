/**
 * Doctorna Intelligence — landing page.
 *
 * DATA
 * ----
 * Everything here is read from the static JSON the pipeline publishes. Nothing
 * on this page is generated, estimated or padded: a card shows a figure only
 * when the published record actually carries one. Reading time comes from the
 * publisher's own text (tools/intel/publish-intel.mjs), view counts come from a
 * real counter (tools/intel/view-endpoint.mjs), images come from the publisher
 * — and when any of them is absent the card omits it rather than inventing one.
 *
 * COMPOSITION
 * -----------
 * The filter panel drives the WHOLE page below it. The featured block is the
 * top of the current result set (one lead + three behind it) and the stream is
 * the remainder, so filtering visibly moves everything rather than leaving a
 * stale "featured" block that contradicts the filters.
 *
 * PAGING
 * ------
 * The archive is published as page-N.json and that architecture is preserved.
 * Page 1 paints immediately, then the remaining pages are pulled in the
 * background so a filter, a sort or a count applies to the WHOLE archive
 * rather than to whatever happened to be on screen. The DOM still renders a
 * page at a time: `Load more` reveals the next slice. Above PREFETCH_PAGE_LIMIT
 * pages the background load is skipped and the UI says so, so this cannot
 * silently become "download the whole database".
 */
const $ = (s, r = document) => r.querySelector(s);
const DATA = '/intelligence/data';
const PREFETCH_PAGE_LIMIT = 40;
/** Cards the featured block consumes off the top of the result set. */
const FEATURE_TAKE = 4;

const state = {
  index: null,
  pageSize: 12,
  pages: [],          // page numbers already fetched
  items: [],          // every card fetched so far
  complete: false,    // the full archive is in memory
  prefetch: true,     // background loading is permitted for this archive size
  shown: 0,           // how many stream cards the DOM currently renders
  views: Object.create(null),
  viewsMode: 'none',  // 'live' | 'snapshot' | 'none'
  viewsAt: null,
  // Display labels, learned from every card we see. The index blocks carry
  // them before page 1 arrives, so a facet never has to print its raw key.
  catLabel: new Map(),
  typeLabel: new Map(),
  // filters
  category: '',
  type: '',
  source: '',
  date: '',
  query: '',
  sort: 'newest',
};

const DEFAULTS = { category: '', type: '', source: '', date: '', query: '', sort: 'newest' };
const DATE_LABEL = { today: 'today', week: 'this week', month: 'this month', year: 'this year' };

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
const num = (n) => Number(n).toLocaleString('en-GB');
/** Publication instant, or NaN when the source published none. */
const when = (a) => Date.parse(a.originalPublishedAt ?? '');

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/** Remember the human labels a batch of cards carries. */
function noteLabels(cards) {
  for (const a of cards ?? []) {
    if (a.category && a.categoryLabel) state.catLabel.set(a.category, a.categoryLabel);
    if (a.contentType && a.contentTypeLabel) state.typeLabel.set(a.contentType, a.contentTypeLabel);
  }
}

/* ── URL state ─────────────────────────────────────────────────
   `category` keeps the parameter name it has always had, so existing links
   still resolve. The rest are additive, and a default is never written. */

const PARAM = { category: 'category', type: 'type', source: 'source', date: 'date', query: 'q', sort: 'sort' };

function readUrl() {
  const p = new URL(location.href).searchParams;
  for (const [key, name] of Object.entries(PARAM)) {
    const v = p.get(name);
    if (v != null) state[key] = v;
  }
  if (!['newest', 'oldest'].includes(state.sort)) state.sort = 'newest';
  if (state.date && !DATE_LABEL[state.date]) state.date = '';
}

function writeUrl() {
  const url = new URL(location.href);
  for (const [key, name] of Object.entries(PARAM)) {
    if (state[key] && state[key] !== DEFAULTS[key]) url.searchParams.set(name, state[key]);
    else url.searchParams.delete(name);
  }
  history.replaceState(null, '', url);
}

/* ── view counts ───────────────────────────────────────────────
   A count is shown only where one was actually recorded. There is no
   client-side fallback: localStorage counts one browser, not the world, and
   printing it as a view count would be a fabricated statistic. */

function viewsOf(slug) {
  const n = state.views[slug];
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function loadViews() {
  let cfg = {};
  try { cfg = await getJSON(`${DATA}/config.json`); } catch { /* optional */ }
  const base = String(cfg.viewEndpoint ?? '').replace(/\/+$/, '');
  if (base) {
    try {
      state.views = await getJSON(`${base}/api/intel/views`);
      state.viewsMode = 'live';
      return;
    } catch { /* fall through to the published snapshot */ }
  }
  try {
    const snap = await getJSON(`${DATA}/views.json`);
    if (snap && snap.counted > 0) {
      state.views = snap.views ?? Object.create(null);
      state.viewsMode = 'snapshot';
      state.viewsAt = snap.generatedAt ?? null;
    }
  } catch { /* no counter has ever run */ }
}

function paintViewNote() {
  const el = $('#viewNote');
  if (!el) return;
  if (state.viewsMode === 'live') { el.hidden = true; return; }
  if (state.viewsMode === 'snapshot') {
    el.hidden = false;
    el.textContent = 'View counts are a snapshot of the article view counter, taken when the '
      + `archive was published${state.viewsAt ? ` on ${fmt(state.viewsAt)}` : ''}.`;
    return;
  }
  el.hidden = false;
  el.textContent = 'View counts require the article view counter (tools/intel/view-endpoint.mjs) '
    + 'to be running and its base URL set in DOCTORNA_VIEW_ENDPOINT. No counter is configured for '
    + 'this build, so no view figures are shown rather than invented ones.';
}

/* ── imagery ───────────────────────────────────────────────────
   Publishers supply a lead image for roughly half the archive. Where one
   exists it is shown; where one does not, a branded panel names the source
   instead. Stock photography is never substituted for a picture the
   publisher did not take. */

const DOCTORNA_MARK = `<svg viewBox="0 0 32 32" aria-hidden="true">
  <rect width="32" height="32" rx="9" fill="#2899E5"/>
  <path d="M12.5 8.5h5.2a7.5 7.5 0 010 15h-5.2z" fill="#fff"/>
  <circle cx="12.5" cy="16" r="2.1" fill="#2899E5"/></svg>`;

/**
 * The panel shown when a publisher supplied no picture. It carries the item's
 * own category and source, so a page of them reads as a set of deliberate
 * covers rather than one repeated broken image. Nothing here stands in for a
 * photograph that does not exist.
 */
const fallbackInner = (a) => `${DOCTORNA_MARK}<b>${esc(a.categoryLabel)}</b><span>${esc(a.sourceName)}</span>`;

function shot(a, { small = false } = {}) {
  const cls = `intel-shot${small ? ' intel-shot-sm' : ''}`;
  if (a.image) {
    // A publisher's image is fetched from their origin at read time. If it has
    // gone, the <img> swaps itself for the same branded panel rather than
    // leaving an empty grey rectangle where a photograph is implied.
    return `<div class="${cls}"><img src="${esc(a.image)}" alt="" loading="lazy" decoding="async"
      onerror="this.closest('.intel-shot').classList.add('intel-shot-none');
               this.closest('.intel-shot').innerHTML=this.dataset.fb;"
      data-fb="${esc(fallbackInner(a))}"></div>`;
  }
  return `<div class="${cls} intel-shot-none">${fallbackInner(a)}</div>`;
}

/* ── cards ─────────────────────────────────────────────────────
   Image · Category · Title · Excerpt · Date · Reading time · Views.
   Each part is rendered only when the record carries it. */

function metaBits(a) {
  const bits = [`<span class="intel-src">${esc(a.sourceName)}</span>`];
  if (a.originalPublishedAt) {
    bits.push(`<time datetime="${esc(a.originalPublishedAt)}">${esc(fmt(a.originalPublishedAt))}</time>`);
  }
  if (a.readingMinutes) bits.push(`<span>${a.readingMinutes} min read</span>`);
  const v = viewsOf(a.slug);
  if (v !== null) bits.push(`<span>${num(v)} view${v === 1 ? '' : 's'}</span>`);
  return `<span class="intel-meta">${bits.join('<span class="intel-dot" aria-hidden="true"></span>')}</span>`;
}

const kicker = (a) => `
  <span class="intel-kicker">
    <span class="intel-cat">${esc(a.categoryLabel)}</span>
    <span class="intel-type intel-type-${esc(a.contentType)}">${esc(a.contentTypeLabel)}</span>
  </span>`;

const excerpt = (a, max) => (a.summary
  ? `<p>${esc(a.summary.slice(0, max))}${a.summary.length > max ? '…' : ''}</p>`
  : '');

const href = (a) => `/intelligence/a/${esc(a.slug)}/`;

function itemCard(a, { thumb = true } = {}) {
  return `<article class="intel-item">
    <a class="intel-link" href="${href(a)}">
      ${thumb ? shot(a) : ''}
      ${kicker(a)}
      <h3>${esc(a.title)}</h3>
      ${excerpt(a, 150)}
      ${metaBits(a)}
    </a>
  </article>`;
}

/**
 * The lead story. With a picture it runs as image + text; without one it runs
 * as a text lead — a bigger headline and a longer extract across the full
 * column — rather than parking a half-width empty panel where a photograph
 * would be. Which variant appears is decided by the record, not by us.
 */
function leadCard(a) {
  const text = !a.image;
  return `<article class="intel-item">
    <a class="intel-link intel-lead-card${text ? ' intel-lead-text' : ''}" href="${href(a)}">
      ${text ? '' : shot(a)}
      <div class="intel-lead-body">
        ${kicker(a)}
        <h3>${esc(a.title)}</h3>
        ${excerpt(a, text ? 420 : 240)}
        ${metaBits(a)}
      </div>
    </a>
  </article>`;
}

function sideCard(a) {
  return `<article class="intel-item intel-side-row">
    <a class="intel-link intel-side-item" href="${href(a)}">
      ${shot(a, { small: true })}
      <div class="intel-side-text">
        <h3>${esc(a.title)}</h3>
        ${metaBits(a)}
      </div>
    </a>
  </article>`;
}

/* ── filtering ─────────────────────────────────────────────────
   Category, date, type, source and search all narrow the same set and
   combine with one another. Sorting is applied last. */

/**
 * Start of the requested calendar window, in local time. These are calendar
 * boundaries, not rolling windows: "this week" means the week we are in,
 * which is what the label says.
 */
function dateFloor(kind, at = Date.now()) {
  const d = new Date(at);
  const y = d.getFullYear();
  const m = d.getMonth();
  switch (kind) {
    case 'today': return new Date(y, m, d.getDate()).getTime();
    case 'week': return new Date(y, m, d.getDate() - ((d.getDay() + 6) % 7)).getTime();
    case 'month': return new Date(y, m, 1).getTime();
    case 'year': return new Date(y, 0, 1).getTime();
    default: return null;
  }
}

/**
 * @param {object} a card
 * @param {string} [skip] dimension to ignore, so a facet can count itself
 */
function matches(a, skip) {
  if (skip !== 'category' && state.category && a.category !== state.category) return false;
  if (skip !== 'type' && state.type && a.contentType !== state.type) return false;
  if (skip !== 'source' && state.source && a.sourceName !== state.source) return false;
  if (skip !== 'date' && state.date) {
    const floor = dateFloor(state.date);
    const t = when(a);
    // An item with no publication date is never claimed to fall in a window.
    if (!Number.isFinite(t) || t < floor) return false;
  }
  if (skip !== 'query' && state.query) {
    const hay = fold(`${a.title} ${a.summary ?? ''} ${a.sourceName} ${a.categoryLabel} ${a.contentTypeLabel}`);
    if (!fold(state.query).split(' ').every((w) => hay.includes(w))) return false;
  }
  return true;
}

function sorted(list) {
  const dir = state.sort === 'oldest' ? 1 : -1;
  return list.slice().sort((x, y) => {
    const a = when(x);
    const b = when(y);
    // Undated items sort last in both directions rather than pretending to a
    // position on the timeline.
    if (!Number.isFinite(a) && !Number.isFinite(b)) return 0;
    if (!Number.isFinite(a)) return 1;
    if (!Number.isFinite(b)) return -1;
    return (a - b) * dir;
  });
}

/** The current result set: every loaded card the filters admit, in order. */
const results = () => sorted(state.items.filter((a) => matches(a)));

const activeFilters = () => Object.keys(DEFAULTS)
  .filter((k) => k !== 'sort' && state[k] !== DEFAULTS[k]);

function describeFilters() {
  const label = (key) => {
    if (key === 'category') return `category “${state.catLabel.get(state.category) ?? state.category}”`;
    if (key === 'type') return `type “${state.typeLabel.get(state.type) ?? state.type}”`;
    if (key === 'source') return `source “${state.source}”`;
    if (key === 'date') return `published ${DATE_LABEL[state.date]}`;
    if (key === 'query') return `matching “${state.query}”`;
    return key;
  };
  return activeFilters().map(label);
}

/* ── painting ──────────────────────────────────────────────── */

function paintFeature(list) {
  const top = list.slice(0, FEATURE_TAKE);
  // The lead slot is the one place where a picture changes the composition, so
  // it goes to the first story IN THE TOP GROUP that has one. The group itself
  // is still strictly the top of the sorted result set — nothing jumps the
  // queue, only the order within these few is editorial.
  const leadIdx = Math.max(0, top.findIndex((a) => a.image));
  const lead = top[leadIdx];
  const side = top.filter((_, i) => i !== leadIdx);
  const host = $('#featured');
  if (!lead) { host.hidden = true; return; }
  host.hidden = false;
  $('#featuredHost').innerHTML = leadCard(lead);
  $('#featuredSide').innerHTML = side.map(sideCard).join('');
}

function paintStream(list) {
  const rest = list.slice(FEATURE_TAKE);
  const slice = rest.slice(0, Math.max(state.pageSize, state.shown));
  $('#streamHost').innerHTML = slice.map((a) => itemCard(a)).join('');
  $('#streamCount').textContent = rest.length
    ? `${num(slice.length)} of ${num(rest.length)} shown`
    : '';

  const more = $('#intelMore');
  const pagesLeft = state.index ? state.pages.length < state.index.pages : false;
  more.hidden = slice.length >= rest.length && !pagesLeft;
}

function paintCount(list) {
  const total = state.index?.total ?? state.items.length;
  const filtered = activeFilters().length > 0;
  const parts = filtered
    ? `<b>${num(list.length)} article${list.length === 1 ? '' : 's'}</b> found of ${num(total)} published`
    : `<b>${num(total)} article${total === 1 ? '' : 's'}</b> found`;
  const loading = !state.complete
    ? ` · <span style="color:var(--muted-2)">${state.prefetch ? 'indexing archive…' : `filtering ${num(state.items.length)} loaded`}</span>`
    : '';
  $('#latestCount').innerHTML = parts + loading;

  const desc = describeFilters();
  const clean = desc.length === 0 && state.sort === DEFAULTS.sort;
  const st = $('#filterState');
  st.hidden = clean;
  st.textContent = clean ? '' : `${[
    desc.length ? `Filtered by ${desc.join(' · ')}` : 'All articles',
    state.sort === 'oldest' ? 'oldest first' : null,
  ].filter(Boolean).join(' · ')}.`;
  $('#intelReset').hidden = clean;

  // Badge on the toggle, so a filter folded away is never invisible — and the
  // panel opens itself when a deep link arrives with one set.
  const hidden = ['type', 'source'].filter((k) => state[k] !== DEFAULTS[k]).length;
  const badge = $('#moreFiltersCount');
  badge.hidden = hidden === 0;
  badge.textContent = String(hidden);
  if (hidden > 0) setMoreFilters(true);
}

/** Show or hide the secondary filter row, keeping the toggle in sync. */
function setMoreFilters(open) {
  $('#moreFilters').hidden = !open;
  $('#moreToggle').setAttribute('aria-expanded', String(open));
}

function paintEmpty(list) {
  const empty = $('#streamEmpty');
  empty.hidden = list.length > 0 || state.items.length === 0;
  if (empty.hidden) return;
  const desc = describeFilters();
  const why = [`No published article matches ${desc.length ? desc.join(' and ') : 'these filters'}.`];
  if (state.date) {
    const newest = state.items.filter((a) => matches(a, 'date'))
      .map(when).filter(Number.isFinite).sort((x, y) => y - x)[0];
    why.push(newest
      ? `The most recent item that matches the other filters is dated ${fmt(new Date(newest).toISOString())}.`
      : 'Nothing matches the other filters either.');
  }
  $('#streamEmptyWhy').textContent = why.join(' ');
}

function paintAll() {
  const list = results();
  paintFeature(list);
  paintStream(list);
  paintCount(list);
  paintEmpty(list);
}

function paintCats() {
  const rail = $('#catRail');
  const published = state.index?.categories ?? {};
  // Facet counts: how many items each category would yield under the OTHER
  // filters. Until the whole archive is loaded the published totals are used,
  // because a count taken from one page would be wrong.
  const pool = state.complete ? state.items.filter((a) => matches(a, 'category')) : null;
  const countOf = (key) => (pool ? pool.filter((a) => a.category === key).length : published[key] ?? 0);
  const all = pool ? pool.length : (state.index?.total ?? 0);

  const entries = Object.entries(published).sort((a, b) => b[1] - a[1]);
  const btn = (key, label, n) => `<button class="intel-cat-btn${n === 0 ? ' is-zero' : ''}" type="button"
      data-cat="${esc(key)}" aria-pressed="${state.category === key}">${esc(label)}<span class="n">${num(n)}</span></button>`;
  rail.innerHTML = [
    btn('', 'All', all),
    ...entries.map(([key, n]) => btn(key, state.catLabel.get(key) ?? key, pool ? countOf(key) : n)),
  ].join('');
  syncRail();
}

const STAT_ICON = {
  analysed: '<path d="M6 3.5h8l4 4V20a1.5 1.5 0 01-1.5 1.5h-10A1.5 1.5 0 015 20V5A1.5 1.5 0 016.5 3.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 3.5V8h4M8.5 13h7M8.5 16.5h4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  articles: '<rect x="3.5" y="5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3.5 9.5h17M7.5 13h6M7.5 16.5h9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  uae: '<path d="M12 21s6.5-5.7 6.5-10.4A6.5 6.5 0 005.5 10.6C5.5 15.3 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="10.4" r="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  sources: '<path d="M5 19V8.5L12 4l7 4.5V19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M3.5 19.5h17M9.5 19v-4.5h5V19M9.5 10.5h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
};

function paintHero(index) {
  if (index.signals?.length) {
    // `intel-signal` is kept alongside `intel-stat` because it is the class the
    // published dataset's figures have always carried.
    $('#heroStats').innerHTML = index.signals.map((s) => `
      <div class="intel-stat intel-signal"${s.note ? ` title="${esc(s.note)}"` : ''}>
        <span class="intel-stat-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">${STAT_ICON[s.key] ?? STAT_ICON.articles}</svg></span>
        <div>
          <dt>${esc(num(s.value))}</dt>
          <dd>${esc(s.label)}</dd>
        </div>
      </div>`).join('');
    $('#heroStats').hidden = false;
  }
  const bits = [];
  if (index.cadence) bits.push(index.cadence);
  if (index.generatedAt) bits.push(`archive last published ${fmt(index.generatedAt)}`);
  if (bits.length) {
    $('#heroUpdated').textContent = `${bits.join(' · ')}.`;
    $('#heroUpdated').hidden = false;
  }
}

/* ── loading ───────────────────────────────────────────────── */

/**
 * The source list is built from the items actually loaded, so it never offers
 * a filter that cannot match anything. `state.source` stays authoritative: a
 * deep link to a source whose page has not arrived yet is re-selected as soon
 * as it does.
 */
function paintSources() {
  const sel = $('#intelSource');
  const names = [...new Set(state.items.map((a) => a.sourceName))].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = ['<option value="">Any source</option>',
    ...names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`)].join('');
  sel.value = names.includes(state.source) ? state.source : '';
}

async function loadPage(n) {
  if (state.pages.includes(n)) return;
  const page = await getJSON(`${DATA}/page-${n}.json`);
  state.pages.push(n);
  state.items.push(...page.items);
  noteLabels(page.items);
  state.complete = state.pages.length >= (state.index?.pages ?? 1);
  paintSources();
}

/** Pull the pages `count` cards need, in order. */
async function loadThrough(count) {
  while (state.items.length < count && state.index && state.pages.length < state.index.pages) {
    await loadPage(state.pages.length + 1);
  }
}

/**
 * Background hydration, after first paint. Filtering and counting need the
 * whole archive; rendering does not, so this changes what the numbers say,
 * not how much DOM exists.
 */
async function prefetchRest() {
  if (!state.prefetch) return;
  for (let p = 2; p <= state.index.pages; p++) {
    await loadPage(p);
    paintCats();
  }
  state.complete = true;
  paintCats();
  paintAll();
}

async function boot() {
  readUrl();
  let index;
  try {
    index = await getJSON(`${DATA}/index.json`);
  } catch {
    // No published dataset at all — say so plainly.
    $('#featured').hidden = true; $('#latest').hidden = true; $('#research').hidden = true;
    $('#categories').hidden = true;
    $('#bootEmpty').hidden = false;
    $('#bootEmptyNote').textContent =
      'No published dataset was found at /intelligence/data/index.json.';
    return;
  }
  state.index = index;
  state.pageSize = index.pageSize || 12;
  state.shown = state.pageSize;
  state.prefetch = index.pages <= PREFETCH_PAGE_LIMIT;

  if (index.total === 0) {
    $('#featured').hidden = true; $('#latest').hidden = true; $('#research').hidden = true;
    $('#categories').hidden = true;
    $('#bootEmpty').hidden = false;
    $('#bootEmptyNote').textContent =
      'The pipeline has run but nothing has reached PUBLISHED yet. Items awaiting medical or '
      + 'editorial review are held deliberately.';
    return;
  }

  paintHero(index);

  // The index blocks already carry every label the facets need.
  for (const block of ['featured', 'uaeLatest', 'globalLatest', 'research']) noteLabels(index[block]);

  // Content-type filter, from the published counts.
  const typeSel = $('#intelType');
  for (const key of Object.keys(index.contentTypes ?? {})) {
    typeSel.insertAdjacentHTML('beforeend',
      `<option value="${esc(key)}">${esc(state.typeLabel.get(key) ?? key)}</option>`);
  }

  // Reflect deep-linked state in the controls before the first paint.
  if (![...typeSel.options].some((o) => o.value === state.type)) state.type = '';
  $('#intelSearch').value = state.query;
  $('#intelDate').value = state.date;
  $('#intelSort').value = state.sort;
  typeSel.value = state.type;

  // View counts, before the first card is drawn, so a card is never rendered
  // once without its figure and again with it.
  await loadViews();
  paintViewNote();

  // UAE first, then global. Both are rendered from published counts; neither is
  // hidden, and an empty section stays absent rather than showing a stub.
  if (index.uaeLatest?.length) {
    $('#uaeHost').innerHTML = index.uaeLatest.slice(0, 6).map((a) => itemCard(a)).join('');
    $('#uaeCount').textContent = `${index.regions?.uae ?? index.uaeLatest.length} UAE item(s)`;
    $('#uae').hidden = false;
  }
  if (index.globalLatest?.length) {
    $('#globalHost').innerHTML = index.globalLatest.slice(0, 6).map((a) => itemCard(a)).join('');
    $('#globalCount').textContent = `${index.regions?.global ?? index.globalLatest.length} global item(s)`;
    $('#global').hidden = false;
  }

  await loadPage(1);
  paintCats();
  paintAll();

  if (index.research?.length) {
    $('#researchHost').innerHTML = index.research.slice(0, 3).map((a) => itemCard(a)).join('');
  } else {
    $('#researchEmpty').hidden = false;
  }

  prefetchRest();
}

/* ── events ────────────────────────────────────────────────── */

/** Any filter change restarts the visible page count — page 3 of the old
 *  result set means nothing in the new one. */
function refilter() {
  state.shown = state.pageSize;
  writeUrl();
  paintCats();
  paintAll();
}

$('#moreToggle').addEventListener('click', () => {
  setMoreFilters($('#moreFilters').hidden);
});

/* The category rail scrolls sideways; the arrows appear only while there is
   something left to reveal on that side. */
const railScroll = $('#catScroll');
const rail = railScroll.closest('.intel-cats-rail');
function syncRail() {
  const max = railScroll.scrollWidth - railScroll.clientWidth;
  const start = railScroll.scrollLeft > 4;
  const end = railScroll.scrollLeft < max - 4;
  rail.dataset.overflowStart = start ? '1' : '0';
  rail.dataset.overflowEnd = end ? '1' : '0';
  rail.querySelector('.intel-rail-prev').hidden = !start;
  rail.querySelector('.intel-rail-next').hidden = !end;
}
railScroll.addEventListener('scroll', syncRail, { passive: true });
// A ResizeObserver rather than a window resize listener: the rail's width
// changes when the panel reflows, not only when the window does — and it
// fires without depending on an animation frame.
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(syncRail).observe(railScroll);
} else {
  addEventListener('resize', syncRail, { passive: true });
}
for (const [sel, dir] of [['.intel-rail-prev', -1], ['.intel-rail-next', 1]]) {
  rail.querySelector(sel).addEventListener('click', () => {
    railScroll.scrollBy({ left: dir * Math.max(200, railScroll.clientWidth * 0.7), behavior: 'smooth' });
  });
}

$('#catRail').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  state.category = b.dataset.cat;
  refilter();
});

let debounce;
$('#intelSearch').addEventListener('input', (e) => {
  clearTimeout(debounce);
  const v = e.target.value;
  debounce = setTimeout(() => { state.query = v.trim(); refilter(); }, 160);
});
$('#intelType').addEventListener('change', (e) => { state.type = e.target.value; refilter(); });
$('#intelSource').addEventListener('change', (e) => { state.source = e.target.value; refilter(); });
$('#intelDate').addEventListener('change', (e) => { state.date = e.target.value; refilter(); });
$('#intelSort').addEventListener('change', (e) => { state.sort = e.target.value; refilter(); });

for (const btn of document.querySelectorAll('[data-reset]')) {
  btn.addEventListener('click', () => {
    Object.assign(state, DEFAULTS);
    $('#intelSearch').value = '';
    $('#intelType').value = '';
    $('#intelSource').value = '';
    $('#intelDate').value = '';
    $('#intelSort').value = 'newest';
    setMoreFilters(false);
    refilter();
    $('#categories').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

$('#intelMore').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    state.shown = Math.max(state.pageSize, state.shown) + state.pageSize;
    await loadThrough(state.shown + FEATURE_TAKE);
    paintAll();
  } finally { btn.disabled = false; }
});

boot().catch((err) => {
  $('#bootEmpty').hidden = false;
  $('#bootEmptyNote').textContent = `Could not load the intelligence dataset: ${err.message}`;
});

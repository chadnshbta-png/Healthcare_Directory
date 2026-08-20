/**
 * Entry point — wires data, state, filters, query and rendering together.
 *
 * This module owns the initialisation lifecycle and event wiring. It
 * deliberately does not know how data is fetched (data.js), how a query runs
 * (query.js), or what any markup looks like (render.js / filters.js / detail.js).
 *
 * Lifecycle, in one place and in this order:
 *
 *   init()
 *     → checkVersion()      HTML and JS must be from the same build
 *     → wireShell()         controls that must work even if data never arrives
 *     → loadData()          fetch + parse + derive, then assert it populated
 *     → initState()         restore the URL-derived state onto the controls
 *     → renderDirectory()   the product itself — critical, must succeed
 *     → renderSections()    discovery sections — each one optional, isolated
 *     → applyRoute()        detail overlay if the hash asks for one
 *
 * Two rules this file exists to enforce:
 *   1. The visitor is NEVER left looking at a skeleton. Any failure after the
 *      data loads surfaces the error state with real diagnostics.
 *   2. A broken decorative section can never take the directory down, and never
 *      leaves an empty headed section on the page.
 */
import { loadDirectory, db, DataLoadError } from './data.js';
import {
  state, MULTI, readUrl, writeUrl, clearAll, isFiltered,
  loadSaved, persistSaved,
} from './state.js';
import { primeSearchIndex, runQuery, sortMatches, facilityResults } from './query.js';
import { initFilters, refreshFilters, resetFilterUi, openGroup, GROUPS } from './filters.js';
import {
  renderCards, renderChips, renderCounts, showState, setProgress,
  renderHeroStats, renderHeroSelects, renderPopular, renderNetwork,
  renderFacilityFeature, renderSpecialtyExplorer, renderSeoColumns, renderFaq,
} from './render.js';
import { initDetail, renderRoute } from './detail.js';
import { $, $$, debounce, scrollToEl } from './utils.js';

/**
 * Build version — must match <meta name="app-version"> in index.html.
 *
 * Static hosts that send no cache headers (notably `python -m http.server`)
 * let a browser keep an old index.html while fetching fresh modules, or the
 * reverse. The two halves then disagree about which elements exist and the app
 * dies on a null reference, stranding the visitor on the loading skeleton.
 * This handshake detects that split and repairs it.
 */
const APP_VERSION = '3';

let matches = [];

/** Everything that failed during boot, so it can be reported honestly. */
const bootProblems = [];

/**
 * Run one boot step in isolation. Non-critical failures are recorded and the
 * owning section is hidden, so a half-rendered block never stays on screen.
 */
function step(label, fn, { section = null, critical = false } = {}) {
  try {
    fn();
    return true;
  } catch (err) {
    bootProblems.push(`${label}: ${err.name}: ${err.message}`);
    console.error(`[directory] ${label} failed`, err);
    if (critical) throw err;
    if (section) {
      const el = document.querySelector(section);
      if (el) el.hidden = true;
    }
    return false;
  }
}

/* ═══ the single render pass ════════════════════════════════ */
function update({ skipFilters = false } = {}) {
  // Nothing may render — least of all the "no results" state — until the
  // dataset is actually in memory. Every interactive handler is wired before
  // loading finishes, so this guard is what keeps an early click or keystroke
  // from painting an empty directory over the loading state.
  if (!db.ready || !db.rows.length) return;

  matches = runQuery();
  sortMatches(matches, state.sort);

  const view = state.view;
  const items = view === 'doctors' ? matches : facilityResults(matches);
  const total = items.length;
  const shown = Math.min(state.page * state.pageSize, total);

  if (total === 0) {
    showState('empty');
    $('#emptyTitle').textContent = 'No matches found';
    $('#emptyText').textContent = isFiltered()
      ? 'Try removing a filter or searching for a broader term.'
      : 'The directory returned no records.';
  } else {
    showState(null);
    renderCards(items.slice(0, shown), view);
    $('#loadMoreBtn').hidden = shown >= total;
  }

  renderCounts({ total, shown, view, filtered: isFiltered() });
  renderChips();
  if (!skipFilters) refreshFilters(matches);
  writeUrl();
}

/** Redraw the filter lists only — the panel's UI changed, the query did not. */
function refreshPanelOnly() {
  if (!db.ready || !db.rows.length) return;
  refreshFilters(matches);
}

const updateSoon = debounce(update, 130);

/* ═══ search ════════════════════════════════════════════════ */
function wireSearch() {
  const input = $('#heroSearch');
  const clear = $('#heroSearchClear');

  input.addEventListener('input', () => {
    state.q = input.value;
    state.page = 1;
    clear.hidden = !input.value;
    updateSoon();
  });
  clear.addEventListener('click', () => {
    input.value = '';
    state.q = '';
    state.page = 1;
    clear.hidden = true;
    input.focus();
    update();
  });

  // The selects are shortcuts into the same facets the rail drives.
  $('#heroCategory').addEventListener('change', (e) => {
    state.categories = e.target.value ? new Set([e.target.value]) : new Set();
    state.page = 1;
    update();
  });
  $('#heroSpecialty').addEventListener('change', (e) => {
    state.specialties = e.target.value ? new Set([e.target.value]) : new Set();
    state.page = 1;
    update();
  });
  $('#heroFacilityType').addEventListener('change', (e) => {
    state.facilityTypes = e.target.value ? new Set([e.target.value]) : new Set();
    state.page = 1;
    update();
  });

  $('#heroSearchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    update();
    scrollToEl($('#directory'));
  });

  $('#popularSearches').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-popular]');
    if (!btn) return;
    state.specialties = new Set([btn.dataset.popular]);
    state.view = 'doctors';
    state.page = 1;
    syncViewButtons();
    syncHeroSelects();
    update();
    scrollToEl($('#directory'));
  });
}

/** Keep the hero selects in step with state, wherever the change came from. */
function syncHeroSelects() {
  const pick = (sel, set) => {
    const el = $(sel);
    if (!el) return;
    const only = set.size === 1 ? [...set][0] : '';
    el.value = [...el.options].some((o) => o.value === only) ? only : '';
  };
  pick('#heroCategory', state.categories);
  pick('#heroSpecialty', state.specialties);
  pick('#heroFacilityType', state.facilityTypes);
}

/* ═══ view switch, sort, layout, pagination ═════════════════ */
function syncViewButtons() {
  $$('[data-view]').forEach((b) => {
    const on = b.dataset.view === state.view;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
    if (on) $('#results-region').setAttribute('aria-labelledby', b.id);
  });
  $$('.nav-link[data-nav-view]').forEach((a) => {
    a.classList.toggle('is-active', a.dataset.navView === state.view);
  });
}

function syncLayoutButtons() {
  $$('[data-layout]').forEach((b) => {
    const on = b.dataset.layout === state.layout;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function setView(view) {
  if (state.view === view) return;
  state.view = view;
  state.page = 1;
  syncViewButtons();
  update();
}

function wireControls() {
  $$('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  $$('[data-layout]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.layout = btn.dataset.layout;
      syncLayoutButtons();
      update({ skipFilters: true });
    });
  });

  $('#sortSelect').addEventListener('change', (e) => {
    state.sort = e.target.value;
    state.page = 1;
    update();
  });

  $('#loadMoreBtn').addEventListener('click', () => {
    state.page += 1;
    update({ skipFilters: true });
  });

  const doClear = () => {
    clearAll();
    resetFilterUi();
    $('#heroSearch').value = '';
    $('#heroSearchClear').hidden = true;
    syncHeroSelects();
    update();
  };
  $('#clearAllBtn').addEventListener('click', doClear);
  $('#drawerClear').addEventListener('click', doClear);
  $('#emptyClear').addEventListener('click', doClear);
  $('#emptyReset').addEventListener('click', () => {
    state.q = '';
    $('#heroSearch').value = '';
    $('#heroSearchClear').hidden = true;
    state.page = 1;
    update();
  });

  $('#retryBtn').addEventListener('click', () => location.reload());
  $('#diagToggle').addEventListener('click', (e) => {
    const panel = $('#diagPanel');
    const open = panel.hidden;
    panel.hidden = !open;
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });
}

/* ═══ chips ═════════════════════════════════════════════════ */
function wireChips() {
  $('#chipRow').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.hasAttribute('data-clear-q')) {
      state.q = '';
      $('#heroSearch').value = '';
      $('#heroSearchClear').hidden = true;
    } else if (btn.hasAttribute('data-clear-all')) {
      clearAll();
      resetFilterUi();
      $('#heroSearch').value = '';
      $('#heroSearchClear').hidden = true;
    } else if (btn.dataset.chipKey) {
      const g = GROUPS.find((x) => x.key === btn.dataset.chipKey);
      if (g) state[g.stateKey].delete(btn.dataset.chipValue);
    } else if (btn.dataset.chipToggle) {
      state.toggles.delete(btn.dataset.chipToggle);
    }
    state.page = 1;
    syncHeroSelects();
    update();
  });
}

/* ═══ hash routing: directory <-> detail views ══════════════ */
const PAGE_SECTIONS = [
  '.hero', '.searchbar-wrap', '.directory', '#network-region', '#trust-region',
  '#facilities-region', '#specialties-region', '#for-clinics', '#languages-region', '#faq-region',
];

function applyRoute() {
  const showingDetail = renderRoute(location.hash);
  for (const sel of PAGE_SECTIONS) {
    const el = document.querySelector(sel);
    // A section hidden because its own render failed must stay hidden.
    if (el && !el.dataset.permanentlyHidden) el.hidden = showingDetail;
  }
  document.title = showingDetail ? 'Profile — Doctorna Directory' : 'Healthcare Directory — Doctorna';
}

function wireRouting() {
  initDetail($('#detailHost'), (view) => {
    // Returning to the directory keeps every filter, because state lives in the
    // query string and the detail route only ever changed the hash.
    if (view && view !== state.view) {
      state.view = view;
      state.page = 1;
      syncViewButtons();
      update();
    }
    history.pushState(null, '', location.pathname + location.search);
    applyRoute();
  });
  window.addEventListener('hashchange', applyRoute);
  window.addEventListener('popstate', applyRoute);

  $('#detailHost').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-facility-filter]');
    if (!btn) return;
    e.preventDefault();
    filterByFacility(btn.dataset.facilityFilter);
    history.pushState(null, '', location.pathname + location.search);
    applyRoute();
    scrollToEl($('#directory'));
  });
}

function filterByFacility(name) {
  state.facilities = new Set([name]);
  state.view = 'doctors';
  state.page = 1;
  syncViewButtons();
  update();
}

/* ═══ result cards ══════════════════════════════════════════ */
function wireCards() {
  $('#cardGrid').addEventListener('click', (e) => {
    const save = e.target.closest('[data-save]');
    if (save) {
      e.preventDefault();
      const id = save.dataset.save;
      if (state.saved.has(id)) state.saved.delete(id); else state.saved.add(id);
      persistSaved();
      update({ skipFilters: true });
      return;
    }
    const facFilter = e.target.closest('[data-facility-filter]');
    if (facFilter) {
      e.preventDefault();
      filterByFacility(facFilter.dataset.facilityFilter);
      scrollToEl($('#directory'));
    }
    // Doctor / facility links are real routes; let the browser follow the href
    // so the hash changes and applyRoute() renders the detail view.
  });
}

/* ═══ discovery sections ════════════════════════════════════ */
function wireSections() {
  $('#networkGrid').addEventListener('click', (e) => {
    const tile = e.target.closest('[data-ftype]');
    if (!tile) return;
    state.facilityTypes = new Set([tile.dataset.ftype]);
    state.view = 'doctors';
    state.page = 1;
    syncViewButtons();
    syncHeroSelects();
    update();
    scrollToEl($('#directory'));
  });

  $('#facilityFeature').addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const card = e.target.closest('[data-facility-open]');
    if (card) card.querySelector('a')?.click();
  });

  $('#specialtyExplorer').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-spec]');
    if (!btn) return;
    state.specialties = new Set([btn.dataset.spec]);
    state.view = 'doctors';
    state.page = 1;
    syncViewButtons();
    syncHeroSelects();
    update();
    scrollToEl($('#directory'));
  });

  $('#seoColumns').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-facet-pick]');
    if (!btn) return;
    const g = GROUPS.find((x) => x.key === btn.dataset.facetPick);
    if (!g) return;
    state[g.stateKey] = new Set([btn.dataset.value]);
    state.view = 'doctors';
    state.page = 1;
    syncViewButtons();
    syncHeroSelects();
    update();
    scrollToEl($('#directory'));
  });

  document.addEventListener('click', (e) => {
    const jump = e.target.closest('[data-jump]');
    if (jump) {
      e.preventDefault();
      const key = jump.dataset.jump;
      if (window.matchMedia('(max-width:900px)').matches) setDrawer(true);
      if (key !== 'all') openGroup(key);
      scrollToEl($('#directory'));
      return;
    }
    const viewJump = e.target.closest('[data-view-jump]');
    if (viewJump) {
      e.preventDefault();
      setView(viewJump.dataset.viewJump);
      scrollToEl($('#directory'));
      return;
    }
    const navView = e.target.closest('.nav-link[data-nav-view]');
    if (navView) setView(navView.dataset.navView);
  });

  $('#faqList').addEventListener('click', (e) => {
    const q = e.target.closest('[data-faq]');
    if (!q) return;
    const item = q.closest('.faq-item');
    const open = item.dataset.open !== 'true';
    item.dataset.open = String(open);
    q.setAttribute('aria-expanded', String(open));
  });
}

/* ═══ chrome: drawer, nav, header, consent ══════════════════ */
let setDrawer = () => {};

function wireChrome() {
  const panel = $('#filterPanel');
  const scrim = $('#scrim');
  const openBtn = $('#openFilters');

  setDrawer = (open) => {
    panel.classList.toggle('is-open', open);
    scrim.hidden = !open;
    openBtn.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) panel.querySelector('.fgroup-head')?.focus();
  };
  openBtn.addEventListener('click', () => setDrawer(true));
  $('#drawerClose').addEventListener('click', () => setDrawer(false));
  $('#drawerApply').addEventListener('click', () => setDrawer(false));
  scrim.addEventListener('click', () => { setDrawer(false); closeNav(); });

  const nav = $('#siteNav');
  const menu = $('#menuToggle');
  const closeNav = () => { nav.classList.remove('is-open'); menu.setAttribute('aria-expanded', 'false'); };
  menu.addEventListener('click', () => {
    const open = !nav.classList.contains('is-open');
    nav.classList.toggle('is-open', open);
    menu.setAttribute('aria-expanded', String(open));
  });
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) closeNav(); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (panel.classList.contains('is-open')) setDrawer(false);
    if (nav.classList.contains('is-open')) closeNav();
  });

  const header = $('#siteHeader');
  const onScroll = () => header.classList.toggle('is-stuck', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  $('#savedBtn').addEventListener('click', () => {
    if (!state.saved.size) return;
    alert(`${state.saved.size} saved professional${state.saved.size === 1 ? '' : 's'}.\n\nA saved-list page is not part of this package — see README ▸ Limitations.`);
  });

  const railQuery = window.matchMedia('(max-width:900px)');
  const syncTrigger = () => { openBtn.hidden = !railQuery.matches; };
  railQuery.addEventListener('change', syncTrigger);
  syncTrigger();

  wireCookieNotice();
}

const COOKIE_KEY = 'doctorna.consent.v1';

function wireCookieNotice() {
  const bar = $('#cookieBar');
  let seen = null;
  try { seen = localStorage.getItem(COOKIE_KEY); } catch { /* storage blocked */ }
  if (seen) return;
  bar.hidden = false;
  const dismiss = (value) => {
    bar.hidden = true;
    try { localStorage.setItem(COOKIE_KEY, value); } catch { /* ignore */ }
  };
  $('#cookieAccept').addEventListener('click', () => dismiss('accepted'));
  $('#cookieDecline').addEventListener('click', () => {
    dismiss('declined');
    try { localStorage.removeItem('doctorna.saved.v1'); } catch { /* ignore */ }
    state.saved.clear();
    update({ skipFilters: true });
  });
}

/* ═══ reveal-on-scroll ══════════════════════════════════════
 * Content is NEVER hidden by default. Only sections that start below the fold
 * are dimmed, and a timer restores them regardless of the observer.
 */
function wireReveal() {
  const targets = $$('.section, .section-tight');
  if (!targets.length || !('IntersectionObserver' in window)) return;
  const reveal = (el) => { el.classList.remove('reveal'); el.classList.add('is-in'); };

  const below = targets.filter((el) => el.getBoundingClientRect().top > window.innerHeight * 0.9);
  if (!below.length) return;
  below.forEach((el) => el.classList.add('reveal'));

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      reveal(entry.target);
      io.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.02 });
  below.forEach((el) => io.observe(el));

  setTimeout(() => below.forEach(reveal), 2500);
}

/* ═══ lifecycle ═════════════════════════════════════════════ */

/** Detect an HTML/JS version split caused by a stale cache, and repair it. */
function checkVersion() {
  const declared = document.querySelector('meta[name="app-version"]')?.content;
  if (declared === APP_VERSION) return true;

  const KEY = 'doctorna.reloaded.v' + APP_VERSION;
  let alreadyTried = false;
  try { alreadyTried = sessionStorage.getItem(KEY) === '1'; } catch { /* ignore */ }

  if (!alreadyTried) {
    // One cache-busting reload, guarded so it can never loop.
    try { sessionStorage.setItem(KEY, '1'); } catch { /* ignore */ }
    const url = new URL(location.href);
    url.searchParams.set('_v', APP_VERSION);
    location.replace(url.toString());
    return false;
  }

  failBoot(
    'This page is out of date.',
    'Your browser is holding an old copy of this page. Reload once with Ctrl+Shift+R (Cmd+Shift+R on a Mac).',
    [
      `Page markup version : ${declared ?? '(none declared)'}`,
      `Application version : ${APP_VERSION}`,
      '',
      'A static server that sends no cache headers (for example',
      '"python -m http.server") lets the browser keep an old index.html while',
      'loading new JavaScript. Use "python serve.py" from this folder instead.',
    ].join('\n')
  );
  return false;
}

/** Put the app into its error state with real diagnostics. Never a blank wait. */
function failBoot(title, text, diagnostics) {
  showState('error');
  const rc = $('#resultCount');
  if (rc) rc.textContent = 'Directory unavailable';
  const ctx = $('#resultContext');
  if (ctx) ctx.textContent = '';
  const t = $('#errorTitle'); if (t) t.textContent = title;
  const x = $('#errorText'); if (x) x.textContent = text;
  const d = $('#diagPanel'); if (d) d.textContent = diagnostics;
}

async function loadData() {
  await loadDirectory((stage) => {
    if (stage === 'facets') setProgress(0.2, 'Preparing filters…');
    if (stage === 'doctors') setProgress(0.8, 'Loading professionals…');
    if (stage === 'done') setProgress(1, 'Directory loaded.');
  });

  // Assert the dataset actually populated before anything claims it is ready.
  if (!db.ready || !db.rows.length || !db.facilities.length) {
    throw new Error(`Dataset did not populate (rows=${db.rows.length}, facilities=${db.facilities.length})`);
  }
}

function initState() {
  primeSearchIndex();
  $('#heroSearch').value = state.q;
  $('#heroSearchClear').hidden = !state.q;
  $('#sortSelect').value = state.sort;
  syncViewButtons();
  syncLayoutButtons();
}

/** The directory itself. If this cannot render, the page has genuinely failed. */
function renderDirectory() {
  step('filter panel', () => initFilters((o = {}) => (o.refreshOnly ? refreshPanelOnly() : update())), { critical: true });
  step('results', () => update(), { critical: true });

  const painted = $('#cardGrid').children.length > 0 || !$('#stateEmpty').hidden;
  if (!painted) throw new Error('First paint produced neither cards nor an empty state');
}

/** Discovery sections. Each is independent, optional, and self-hiding on error. */
function renderSections() {
  step('hero figures', renderHeroStats);
  step('hero selects', () => { renderHeroSelects(); syncHeroSelects(); });
  step('popular searches', renderPopular);
  step('network grid', renderNetwork, { section: '#network-region' });
  step('featured facilities', renderFacilityFeature, { section: '#facilities-region' });
  step('specialty explorer', renderSpecialtyExplorer, { section: '#specialties-region' });
  step('browse columns', renderSeoColumns, { section: '#languages-region' });
  step('faq', renderFaq, { section: '#faq-region' });
  step('section wiring', wireSections);
  step('reveal', wireReveal);

  // Remember which sections were switched off so routing leaves them off.
  for (const sel of PAGE_SECTIONS) {
    const el = document.querySelector(sel);
    if (el && el.hidden) el.dataset.permanentlyHidden = '1';
  }
}

async function init() {
  window.__directoryBooting = true;

  if (!checkVersion()) return;

  // Shell wiring first: these must work even if the data never arrives.
  step('saved list', loadSaved);
  step('url state', readUrl);
  step('search wiring', wireSearch);
  step('control wiring', wireControls);
  step('chip wiring', wireChips);
  step('card wiring', wireCards);
  step('chrome wiring', wireChrome);
  step('routing wiring', wireRouting);

  showState('loading');
  setProgress(0.05, 'Loading the directory…');

  try {
    await loadData();
  } catch (err) {
    const isData = err instanceof DataLoadError;
    failBoot(
      err.isFileProtocol ? 'This page needs a local web server.' : 'Something went wrong while loading the directory.',
      err.isFileProtocol ? 'Open it over http instead of from the file system, then try again.' : 'Please try again.',
      [
        isData ? `File     : ${err.file}` : null,
        isData ? `Full URL : ${err.url}` : null,
        `Error    : ${err.name}: ${err.message}`,
        err.detail ? `Detail   : ${err.detail}` : null,
        err.stack ? `\nStack:\n${err.stack}` : null,
      ].filter(Boolean).join('\n')
    );
    return;
  }

  initState();

  try {
    renderDirectory();
  } catch (err) {
    // Data arrived but the directory could not be painted. Say so plainly —
    // never leave the visitor on a skeleton that will never resolve.
    failBoot(
      'The directory could not be displayed.',
      'The data loaded, but this page failed to render it. Please try again.',
      [
        `Error     : ${err.name}: ${err.message}`,
        `Rows      : ${db.rows.length}`,
        `Facilities: ${db.facilities.length}`,
        bootProblems.length ? `\nSteps that failed:\n  ${bootProblems.join('\n  ')}` : null,
        err.stack ? `\nStack:\n${err.stack}` : null,
      ].filter(Boolean).join('\n')
    );
    return;
  }

  renderSections();
  step('route', applyRoute);

  window.__directoryBooted = true;
  window.__directoryProblems = bootProblems;
  if (bootProblems.length) {
    console.warn(`[directory] booted with ${bootProblems.length} non-fatal problem(s):`, bootProblems);
  }
}

init();

/**
 * UI state + URL synchronisation.
 *
 * Every filter lives in the query string so a filtered view can be shared or
 * bookmarked, e.g.
 *   ?view=doctors&q=derma&cat=Physician&spec=Dermatology&lang=Arabic&sort=name-asc
 */

const PAGE_SIZE = 24;

/** Multi-select facets: url key ▸ state key. */
export const MULTI = {
  cat: 'categories',
  spec: 'specialties',
  fac: 'facilities',
  ftype: 'facilityTypes',
  lang: 'languages',
  nat: 'nationalities',
  lic: 'licences',
};

/**
 * Boolean "profile data" filters. Each one is answerable from the bundled row
 * data, so every count shown next to it is real.
 */
export const TOGGLES = {
  facility: 'Has facility',
  contact: 'Has contact details',
  languages: 'Has languages',
  education: 'Has education',
};

/**
  * How a selected FACILITY TYPE resolves to facility results.
  *
  *   'type'   the facility's own classified type must match the selection.
  *            Medical centre -> medical centres only. A professional who also
  *            works at a hospital does not pull that hospital into the result.
  *   'linked' every facility reachable through a matching professional, so a
  *            multi-facility professional surfaces all of their placements.
  *
  * Doctor results are identical under both modes — a professional licensed at a
  * medical centre matches "Medical centre" either way. The mode decides which
  * FACILITIES are listed, which is the thing that was ambiguous.
  */
export const FACILITY_MATCH = {
  type: 'Match selected facility type',
  linked: 'All linked facilities',
};

export const state = {
  view: 'doctors',
  q: '',
  facilityMatch: 'type',
  categories: new Set(),
  specialties: new Set(),
  facilities: new Set(),
  facilityTypes: new Set(),
  languages: new Set(),
  nationalities: new Set(),
  licences: new Set(),
  toggles: new Set(),
  sort: 'relevance',
  layout: 'grid',
  page: 1,
  pageSize: PAGE_SIZE,
  saved: new Set(),
};

export const isFiltered = () =>
  Boolean(state.q) ||
  state.toggles.size > 0 ||
  Object.values(MULTI).some((k) => state[k].size > 0);

export const activeFilterCount = () =>
  (state.q ? 1 : 0) +
  state.toggles.size +
  Object.values(MULTI).reduce((n, k) => n + state[k].size, 0);

export function clearAll() {
  state.q = '';
  for (const k of Object.values(MULTI)) state[k].clear();
  state.toggles.clear();
  state.page = 1;
}

export function toggleValue(stateKey, value) {
  const set = state[stateKey];
  if (set.has(value)) set.delete(value);
  else set.add(value);
  state.page = 1;
}

/* ── URL ─────────────────────────────────────────────────── */

export function readUrl() {
  const p = new URLSearchParams(location.search);
  const view = p.get('view');
  if (view === 'facilities' || view === 'doctors') state.view = view;
  state.q = p.get('q') ?? '';
  for (const [key, stateKey] of Object.entries(MULTI)) {
    const raw = p.get(key);
    state[stateKey] = new Set(raw ? raw.split('~').filter(Boolean) : []);
  }
  state.toggles = new Set((p.get('has') ?? '').split(',').filter((t) => t in TOGGLES));
  const sort = p.get('sort');
  if (sort) state.sort = sort;
  const layout = p.get('layout');
  if (layout === 'list' || layout === 'grid') state.layout = layout;
  const ftmode = p.get('ftmode');
  state.facilityMatch = ftmode in FACILITY_MATCH ? ftmode : 'type';
  const page = Number(p.get('page'));
  state.page = Number.isFinite(page) && page > 0 ? page : 1;
}

export function writeUrl() {
  const p = new URLSearchParams();
  if (state.view !== 'doctors') p.set('view', state.view);
  if (state.q) p.set('q', state.q);
  for (const [key, stateKey] of Object.entries(MULTI)) {
    if (state[stateKey].size) p.set(key, [...state[stateKey]].join('~'));
  }
  if (state.toggles.size) p.set('has', [...state.toggles].join(','));
  if (state.sort !== 'relevance') p.set('sort', state.sort);
  if (state.layout !== 'grid') p.set('layout', state.layout);
  // Only the non-default mode travels in the URL, so existing links keep working.
  if (state.facilityMatch !== 'type') p.set('ftmode', state.facilityMatch);
  if (state.page > 1) p.set('page', String(state.page));
  const qs = p.toString();
  // Keep the hash. It carries the detail route (#/doctor/<id>), and dropping it
  // here silently cancelled every deep link before applyRoute() could read it.
  const url = (qs ? `${location.pathname}?${qs}` : location.pathname) + location.hash;
  history.replaceState(null, '', url);
}

/* ── saved list (localStorage, best effort) ───────────────── */

const SAVED_KEY = 'doctorna.saved.v1';

export function loadSaved() {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (raw) state.saved = new Set(JSON.parse(raw));
  } catch {
    /* storage unavailable — saving simply won't persist */
  }
}

export function persistSaved() {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify([...state.saved]));
  } catch {
    /* ignore */
  }
}

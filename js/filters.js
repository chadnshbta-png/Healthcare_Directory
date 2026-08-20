/**
 * Filter panel — builds the groups, keeps counts live, handles option search,
 * pinning of selected values and "show all". Only facets the data actually
 * supports are rendered, and every count comes from a real query pass.
 */
import { db } from './data.js';
import { state, MULTI, TOGGLES } from './state.js';
import { $, esc, num, fold, LICENCE_LABEL, FACILITY_TYPE_LABEL } from './utils.js';
import { facetCounts, toggleCounts } from './query.js';

const CHECK = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2 6.2 2.6 2.6L10 3.4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CARET = '<svg class="fgroup-caret" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SEARCH_ICO = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m13 13 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

/**
 * Group definitions. `style: 'chips'` for short lists, `'list'` for long
 * searchable ones. `open` controls the initial disclosure state.
 */
const GROUPS = [
  { key: 'cat', stateKey: 'categories', title: 'Professional category', dict: 'category', style: 'chips', open: true },
  { key: 'spec', stateKey: 'specialties', title: 'Specialty', dict: 'specialty', style: 'list', open: true, searchable: true, initial: 8 },
  { key: 'ftype', stateKey: 'facilityTypes', title: 'Facility type', dict: 'facilityType', style: 'chips', open: true, labelMap: FACILITY_TYPE_LABEL },
  { key: 'fac', stateKey: 'facilities', title: 'Facility', dict: 'facility', style: 'list', open: true, searchable: true, initial: 6 },
  { key: 'lang', stateKey: 'languages', title: 'Language', dict: 'language', style: 'list', open: false, searchable: true, initial: 8 },
  { key: 'nat', stateKey: 'nationalities', title: 'Nationality', dict: 'nationality', style: 'list', open: false, searchable: true, initial: 8 },
  { key: 'lic', stateKey: 'licences', title: 'Licence type', dict: 'licenseType', style: 'chips', open: false, labelMap: LICENCE_LABEL },
];

/** Per-group UI memory (option search text + expanded state). */
const ui = new Map(GROUPS.map((g) => [g.key, { search: '', expanded: false }]));
let onChange = () => {};

export function initFilters(handler) {
  onChange = handler;
  $('#filterScroll').innerHTML = GROUPS.map(groupShell).join('') + flagsShell();

  const scroll = $('#filterScroll');
  scroll.addEventListener('click', handleClick);
  scroll.addEventListener('input', handleInput);
  scroll.addEventListener('change', handleChange);
}

function head(key, title, open) {
  return `<button class="fgroup-head" type="button" data-toggle-group="${key}"
                  aria-expanded="${open}" aria-controls="fgroup-${key}">
    <span class="fgroup-title">${esc(title)}</span>
    <span class="fgroup-badge" data-badge="${key}" hidden>0</span>${CARET}
  </button>`;
}

function groupShell(g) {
  return `<section class="fgroup" data-group="${g.key}" data-open="${g.open}">
    ${head(g.key, g.title, g.open)}
    <div class="fgroup-body" id="fgroup-${g.key}">
      ${g.searchable ? `<div class="fgroup-tools">
        <label class="opt-search">${SEARCH_ICO}
          <input type="search" data-optsearch="${g.key}" placeholder="Search ${esc(g.title.toLowerCase())}…" aria-label="Search ${esc(g.title)} options">
        </label>
        <button class="fgroup-clear" type="button" data-groupclear="${g.key}" hidden>Clear</button>
      </div>` : `<div class="fgroup-tools" data-plain>
        <button class="fgroup-clear" type="button" data-groupclear="${g.key}" hidden>Clear</button>
      </div>`}
      <div data-options="${g.key}"></div>
    </div>
  </section>`;
}

function flagsShell() {
  return `<section class="fgroup" data-group="flags" data-open="true">
    ${head('flags', 'Profile data', true)}
    <div class="fgroup-body" id="fgroup-flags">
      <div class="fgroup-tools" data-plain>
        <button class="fgroup-clear" type="button" data-groupclear="flags" hidden>Clear</button>
      </div>
      <div class="seg-row">
        ${Object.entries(TOGGLES).map(([k, label]) =>
          `<button class="seg-chip" type="button" role="switch" aria-pressed="false" data-toggle="${k}">
             ${esc(label)} <span class="opt-count" data-togglecount="${k}">—</span>
           </button>`).join('')}
      </div>
    </div>
  </section>`;
}

/** Some facets store a key ('hospital') but should read as a label. */
const display = (g, label) => (g.labelMap && g.labelMap[label]) || label;

/** One checkbox row. */
const optionRow = (g, o, selected) => `
  <label class="opt">
    <input type="checkbox" data-facet="${g.key}" value="${esc(o.label)}" ${selected ? 'checked' : ''}>
    <span class="opt-box" aria-hidden="true">${CHECK}</span>
    <span class="opt-label" title="${esc(display(g, o.label))}">${esc(display(g, o.label))}</span>
    <span class="opt-count">${num(o.count)}</span>
  </label>`;

/**
 * Redraw every group's options with counts reflecting the current query.
 * `matches` is the current result set, reused for the profile-data counts so
 * they cost one extra pass rather than four.
 */
export function refreshFilters(matches) {
  for (const g of GROUPS) {
    const counts = facetCounts(g.key, matches);
    const selected = state[g.stateKey];
    const memory = ui.get(g.key);

    let options = db.facets[g.dict]
      .map((o) => ({ label: o.label, count: counts.get(o.i) ?? 0 }))
      .filter((o) => o.count > 0 || selected.has(o.label));

    if (memory.search) {
      const q = fold(memory.search);
      options = options.filter((o) => fold(display(g, o.label)).includes(q));
    }

    // Selected values are pinned above the rest so a choice never scrolls away.
    const byCount = (a, b) => b.count - a.count || display(g, a.label).localeCompare(display(g, b.label));
    const picked = options.filter((o) => selected.has(o.label)).sort(byCount);
    const rest = options.filter((o) => !selected.has(o.label)).sort(byCount);

    const host = document.querySelector(`[data-options="${g.key}"]`);
    if (!host) continue;

    if (!options.length) {
      host.innerHTML = '<p class="opt-none">No matching options</p>';
    } else if (g.style === 'chips') {
      const chip = (o) => `
        <button class="seg-chip" type="button" role="switch" aria-pressed="${selected.has(o.label)}"
                data-facet="${g.key}" data-value="${esc(o.label)}"
                ${g.labelMap?.[o.label] ? `title="${esc(g.labelMap[o.label])}"` : ''}>
          ${esc(display(g, o.label))} <span class="opt-count">${num(o.count)}</span>
        </button>`;
      host.innerHTML = `<div class="seg-row">${[...picked, ...rest].map(chip).join('')}</div>`;
    } else {
      const limit = memory.expanded ? rest.length : (g.initial ?? 8);
      const visible = rest.slice(0, limit);
      host.innerHTML =
        (picked.length ? `<div class="opt-list opt-pinned">${picked.map((o) => optionRow(g, o, true)).join('')}</div>` : '') +
        (visible.length ? `<div class="opt-list">${visible.map((o) => optionRow(g, o, false)).join('')}</div>` : '') +
        (rest.length > limit || (memory.expanded && rest.length > (g.initial ?? 8))
          ? `<button class="opt-more" type="button" data-more="${g.key}">${memory.expanded ? 'Show less' : `Show all ${num(rest.length)}`}</button>`
          : '');
    }

    setBadge(g.key, selected.size);
  }

  // Profile-data switches, with live counts from the current result set.
  const tCounts = matches ? toggleCounts(matches) : null;
  for (const k of Object.keys(TOGGLES)) {
    const btn = document.querySelector(`[data-toggle="${k}"]`);
    if (btn) btn.setAttribute('aria-pressed', String(state.toggles.has(k)));
    const countEl = document.querySelector(`[data-togglecount="${k}"]`);
    if (countEl && tCounts) countEl.textContent = num(tCounts.get(k) ?? 0);
  }
  setBadge('flags', state.toggles.size);
}

function setBadge(key, n) {
  const badge = document.querySelector(`[data-badge="${key}"]`);
  if (badge) {
    badge.hidden = n === 0;
    badge.textContent = String(n);
  }
  const clear = document.querySelector(`[data-groupclear="${key}"]`);
  if (clear) clear.hidden = n === 0;
}

/* ── events ──────────────────────────────────────────────── */

function handleClick(e) {
  const head = e.target.closest('[data-toggle-group]');
  if (head) {
    const section = head.closest('.fgroup');
    const open = section.dataset.open !== 'true';
    section.dataset.open = String(open);
    head.setAttribute('aria-expanded', String(open));
    return;
  }

  const clear = e.target.closest('[data-groupclear]');
  if (clear) {
    const key = clear.dataset.groupclear;
    if (key === 'flags') state.toggles.clear();
    else {
      const g = GROUPS.find((x) => x.key === key);
      state[g.stateKey].clear();
      ui.get(key).expanded = false;
    }
    state.page = 1;
    onChange();
    return;
  }

  const more = e.target.closest('[data-more]');
  if (more) {
    const m = ui.get(more.dataset.more);
    m.expanded = !m.expanded;
    onChange({ refreshOnly: true });
    return;
  }

  const chip = e.target.closest('.seg-chip[data-facet]');
  if (chip) {
    const g = GROUPS.find((x) => x.key === chip.dataset.facet);
    const set = state[g.stateKey];
    const v = chip.dataset.value;
    if (set.has(v)) set.delete(v); else set.add(v);
    state.page = 1;
    onChange();
    return;
  }

  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    const k = toggle.dataset.toggle;
    if (state.toggles.has(k)) state.toggles.delete(k); else state.toggles.add(k);
    state.page = 1;
    onChange();
  }
}

function handleChange(e) {
  const box = e.target.closest('input[type="checkbox"][data-facet]');
  if (!box) return;
  const g = GROUPS.find((x) => x.key === box.dataset.facet);
  const set = state[g.stateKey];
  if (box.checked) set.add(box.value); else set.delete(box.value);
  state.page = 1;
  onChange();
}

let searchTimer;
function handleInput(e) {
  const input = e.target.closest('[data-optsearch]');
  if (!input) return;
  const key = input.dataset.optsearch;
  ui.get(key).search = input.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    onChange({ refreshOnly: true });
    // keep focus + caret after the re-render
    const again = document.querySelector(`[data-optsearch="${key}"]`);
    if (again) { again.focus(); again.value = input.value; again.setSelectionRange(again.value.length, again.value.length); }
  }, 140);
}

/** Reset per-group UI memory (used by "Clear all"). */
export function resetFilterUi() {
  for (const m of ui.values()) { m.search = ''; m.expanded = false; }
  for (const el of document.querySelectorAll('[data-optsearch]')) el.value = '';
}

/** Open a filter group and scroll it into view (used by the page shortcuts). */
export function openGroup(key) {
  const section = document.querySelector(`.fgroup[data-group="${key}"]`);
  if (!section) return;
  section.dataset.open = 'true';
  section.querySelector('.fgroup-head')?.setAttribute('aria-expanded', 'true');
  section.scrollIntoView({ block: 'nearest' });
}

export { GROUPS, display as facetLabel };

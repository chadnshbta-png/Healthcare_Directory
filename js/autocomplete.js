/**
 * Search autocomplete.
 *
 * Every suggestion is a REAL value already in the loaded dataset — a facility
 * name from the facility dictionary, or a professional name / specialty from
 * the row data. Nothing is generated, guessed or completed from a word list.
 *
 * Suggestions respect the active search mode, because a suggestion that cannot
 * produce a result is worse than no suggestion:
 *   facilities     facility names only
 *   professionals  professional names + specialties only
 *   all            both, facilities first
 *
 * Performance: the dataset holds 102k professional names, so the scan is a
 * single pass with an early exit once enough matches are found, run against the
 * pre-folded haystacks the query engine already builds (`db.foldedName`,
 * `db.foldedFacility`). No index is duplicated and no dependency is added.
 */
import { db } from './data.js';
import { fold } from './utils.js';

/** Below this a query matches too much to be worth suggesting. */
export const MIN_QUERY = 2;
/** Suggestions offered at once. Small enough to stay on screen on a phone. */
const LIMIT = 8;

/**
 * Build the suggestion list for a query in a mode.
 * @returns {Array<{kind:'facility'|'professional'|'specialty', value:string, meta:string}>}
 */
export function suggest(rawQuery, mode = 'all') {
  const q = fold(rawQuery);
  if (q.length < MIN_QUERY) return [];

  const wantFacilities = mode === 'all' || mode === 'facilities';
  const wantPeople = mode === 'all' || mode === 'professionals';
  const perKind = mode === 'all' ? Math.ceil(LIMIT / 2) : LIMIT;

  const out = [];

  if (wantFacilities) {
    const hay = db.foldedFacility ?? [];
    // Prefix hits first — they are what the typist most likely means.
    const starts = [];
    const contains = [];
    for (let i = 0; i < hay.length && starts.length < perKind; i++) {
      if (!hay[i].includes(q)) continue;
      const rec = db.facilities[i];
      if (!rec) continue;
      (hay[i].startsWith(q) ? starts : contains).push({
        kind: 'facility',
        value: rec.name,
        meta: `${rec.doctorCount.toLocaleString('en-US')} professionals`,
      });
      if (starts.length + contains.length >= perKind * 4) break;
    }
    out.push(...[...starts, ...contains].slice(0, perKind));
  }

  if (wantPeople) {
    const before = out.length;
    // Specialties are a short dictionary, so they are cheap and often the
    // most useful professional suggestion ("dermat…" -> the specialty).
    const specs = [];
    const fs = db.foldedSpecialty ?? [];
    for (let i = 0; i < fs.length && specs.length < 3; i++) {
      if (fs[i].includes(q)) specs.push({
        kind: 'specialty', value: db.dict.specialty[i], meta: 'Specialty',
      });
    }
    // Professional CATEGORY is a five-value dictionary and a legitimate
    // professional-side suggestion ("nurse" -> Nurse and Midwife).
    const fc = db.foldedCategory ?? [];
    for (let i = 0; i < fc.length && specs.length < 4; i++) {
      if (fc[i].includes(q)) specs.push({
        kind: 'category', value: db.dict.category[i], meta: 'Category',
      });
    }
    out.push(...specs);

    const names = db.foldedName ?? [];
    const starts = [];
    const contains = [];
    const seen = new Set();
    const room = perKind - specs.length;
    for (let i = 0; i < names.length; i++) {
      if (!names[i].includes(q)) continue;
      const row = db.rows[i];
      const name = row[1];
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const spec = row[3] >= 0 ? db.dict.specialty[row[3]] : '';
      const entry = { kind: 'professional', value: name, meta: spec || 'Professional' };
      (names[i].startsWith(q) ? starts : contains).push(entry);
      // Enough candidates to fill the slots with prefix hits preferred.
      if (starts.length >= room || starts.length + contains.length >= room * 6) break;
    }
    out.push(...[...starts, ...contains].slice(0, Math.max(0, room)));
    if (out.length === before) { /* nothing for this kind; fine */ }
  }

  return out.slice(0, LIMIT);
}

/**
 * Wire the combobox: rendering, keyboard and pointer selection.
 *
 * `onPick(suggestion)` is called with the chosen entry so the caller can set
 * the search state — this module never touches state or runs a query itself.
 */
export function initAutocomplete({ input, list, getMode, onPick }) {
  let items = [];
  let active = -1;
  let open = false;

  const close = () => {
    open = false;
    active = -1;
    list.hidden = true;
    list.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const paint = () => {
    list.innerHTML = items.map((s, i) => `
      <li class="ac-item${i === active ? ' is-active' : ''}" role="option"
          id="ac-opt-${i}" aria-selected="${i === active}" data-ac-index="${i}">
        <span class="ac-kind ac-kind-${s.kind}">${
          s.kind === 'facility' ? 'Facility'
          : s.kind === 'specialty' ? 'Specialty'
          : s.kind === 'category' ? 'Category' : 'Person'}</span>
        <span class="ac-value">${escapeHtml(s.value)}</span>
        <span class="ac-meta">${escapeHtml(s.meta)}</span>
      </li>`).join('');
    list.hidden = items.length === 0;
    open = items.length > 0;
    input.setAttribute('aria-expanded', String(open));
    if (active >= 0) input.setAttribute('aria-activedescendant', `ac-opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  const refresh = () => {
    if (!db.ready) return;
    items = suggest(input.value, getMode());
    active = -1;
    paint();
  };

  const move = (delta) => {
    if (!open || !items.length) return;
    active = (active + delta + items.length) % items.length;
    paint();
    list.querySelector('.ac-item.is-active')?.scrollIntoView({ block: 'nearest' });
  };

  const choose = (i) => {
    const s = items[i];
    if (!s) return;
    close();
    onPick(s);
  };

  input.addEventListener('input', refresh);
  input.addEventListener('focus', () => { if (input.value.trim().length >= MIN_QUERY) refresh(); });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) refresh(); else move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Escape') { if (open) { e.preventDefault(); close(); } return; }
    if (e.key === 'Enter') {
      // Enter on a highlighted suggestion picks it; otherwise the form's own
      // submit handler runs the typed query unchanged.
      if (open && active >= 0) { e.preventDefault(); choose(active); }
      else close();
    }
  });

  // Pointer + touch: mousedown, so the pick lands before the input blurs.
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('[data-ac-index]');
    if (!li) return;
    e.preventDefault();
    choose(Number(li.dataset.acIndex));
  });

  document.addEventListener('click', (e) => {
    if (!list.contains(e.target) && e.target !== input) close();
  });

  return { close, refresh };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

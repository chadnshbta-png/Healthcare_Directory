/**
 * All DOM output: result cards, chips, counts, states and the editorial
 * sections. Nothing here queries or filters — it is handed data and paints it.
 *
 * Every figure rendered by this module is read from the loaded dataset. There
 * are no hardcoded providers, facilities or counts anywhere in this file.
 */
import {
  db, R, FLAG, rowFacility, rowFacilityCount, rowLanguages, rowHas, facilityTopSpecialties,
  rowLicences,
  doctorHref, facilityHref,
} from './data.js';
import { state, MULTI, TOGGLES, activeFilterCount } from './state.js';
import { $, esc, num, initials, FACILITY_TYPE_LABEL, LICENCE_LABEL, licenceBadge, specialtyLabel } from './utils.js';

const ICON = {
  facility: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 17h14M5 17V7l5-3 5 3v10M8.5 10h3M10 8.5v3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  globe: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 10h14M10 3a11 11 0 010 14 11 11 0 010-14z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  chat: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12v8H8l-4 3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  people: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="7.5" cy="7" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 16c0-2.5 2-4.2 4.5-4.2S12 13.5 12 16M13.5 8.2a2.3 2.3 0 100-4.4M15 15.6c0-2 .9-3.2 2.5-3.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  steth: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3v4a3.2 3.2 0 0 0 6.4 0V3M8.2 10.1V12a4 4 0 0 0 8 0v-1.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="16.2" cy="9" r="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  arrow: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 6l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  shield: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.6 4.4 4.9v4.4c0 3.3 2.3 6.4 5.6 7.6 3.3-1.2 5.6-4.3 5.6-7.6V4.9z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="m7.5 9.9 1.8 1.8 3.3-3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  star: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 14.8 5.3 17.3l.9-5.2L2.4 8.4l5.3-.8L10 2.8l2.3 4.8 5.3.8-3.8 3.7.9 5.2z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  starOutline: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 14.8 5.3 17.3l.9-5.2L2.4 8.4l5.3-.8L10 2.8l2.3 4.8 5.3.8-3.8 3.7.9 5.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  close: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

/**
 * A record earns the verification mark when the register publishes a licence
 * type for it. That is a real field, not a rating.
 */
const VERIFIED = `<span class="verified">${ICON.shield}Verified</span>`;

/* ═══ doctor card ═══════════════════════════════════════════ */
function doctorCard(rowIdx) {
  const r = db.rows[rowIdx];
  const id = r[R.ID];
  const name = r[R.NAME];
  const category = r[R.CATEGORY] >= 0 ? db.dict.category[r[R.CATEGORY]] : '';
  const specialty = r[R.SPECIALTY] >= 0 ? db.dict.specialty[r[R.SPECIALTY]] : '';
  const licences = rowLicences(r);
  const licence = licences[0] ?? '';
  const nationality = r[R.NATIONALITY] >= 0 ? db.dict.nationality[r[R.NATIONALITY]] : '';
  const facility = rowFacility(r);
  const facilityName = facility ? facility.name : '';
  // Cards stay one line per field; extra facilities are counted, not listed.
  const extraFacilities = Math.max(0, rowFacilityCount(r) - 1);
  const langs = rowLanguages(r);
  const isSaved = state.saved.has(id);

  // Deliberately not every field — facility, origin, languages, in that order.
  const meta = [];
  if (facilityName) {
    const more = extraFacilities ? ` +${extraFacilities}` : '';
    const title = extraFacilities
      ? `${facilityName} and ${extraFacilities} other facility${extraFacilities === 1 ? '' : 'ies'}`
      : facilityName;
    meta.push(`<div class="meta-row">${ICON.facility}<span title="${esc(title)}">${esc(facilityName)}${esc(more)}</span></div>`);
  }
  if (nationality) meta.push(`<div class="meta-row">${ICON.globe}<span>${esc(nationality)}</span></div>`);
  if (langs.length) meta.push(`<div class="meta-row langs">${ICON.chat}<span>${esc(langs.slice(0, 3).join(' · '))}${langs.length > 3 ? ` +${langs.length - 3}` : ''}</span></div>`);

  const marks = [];
  if (licences.length) marks.push(VERIFIED);
  // EVERY licence type the professional holds gets a badge. A card must not
  // imply someone is only Full-time when they are also Part-time elsewhere.
  for (const l of licences) {
    marks.push(`<span class="tag" title="${esc(LICENCE_LABEL[l] ?? l)}">${esc(licenceBadge(l))}</span>`);
  }
  if (licences.length === 0 && (rowHas(r, FLAG.MOBILE) || rowHas(r, FLAG.EMAIL))) {
    marks.push('<span class="tag tag-brand">Contactable</span>');
  }

  return `<article class="card">
    <div class="card-mark">${marks.join('')}</div>
    <div class="card-body">
      <div class="avatar" aria-hidden="true">${esc(initials(name))}</div>
      <div class="card-head-text">
        <h3 class="card-name"><a href="${doctorHref(id)}" data-doctor="${esc(id)}">${esc(name)}</a></h3>
        <p class="card-role${specialty ? '' : ' plain'}" title="${esc(specialty ? specialtyLabel(specialty) : category)}">${esc(specialty ? specialtyLabel(specialty) : category)}</p>
      </div>
    </div>
    ${meta.length ? `<div class="card-meta">${meta.join('')}</div>` : ''}
    <div class="card-foot">
      <span class="card-cta">View profile ${ICON.arrow}</span>
      <button class="save-btn" type="button" data-save="${esc(id)}" aria-pressed="${isSaved}" aria-label="${isSaved ? 'Remove from saved' : 'Save'} ${esc(name)}">${isSaved ? ICON.star : ICON.starOutline}</button>
    </div>
  </article>`;
}

/* ═══ facility card (results view) ══════════════════════════ */
function facilityCard(f) {
  const type = f.type ? (FACILITY_TYPE_LABEL[f.type] ?? f.type) : '';
  const shown = f.matchingDoctors ?? f.doctorCount;
  const partial = f.matchingDoctors !== undefined && f.matchingDoctors !== f.doctorCount;
  const top = facilityTopSpecialties(f);

  const marks = [];
  if (f.inDhaMasterList) marks.push(`<span class="verified">${ICON.shield}Verified</span>`);
  if (type) marks.push(`<span class="tag tag-blue">${esc(type)}</span>`);

  return `<article class="card">
    <div class="card-mark">${marks.join('')}</div>
    <div class="card-body">
      <div class="avatar facility" aria-hidden="true">${ICON.facility}</div>
      <div class="card-head-text">
        <h3 class="card-name"><a href="${facilityHref(f)}" data-facility="${esc(f.id)}">${esc(f.name)}</a></h3>
        <p class="card-role">${num(shown)} ${shown === 1 ? 'professional' : 'professionals'}${partial ? ` of ${num(f.doctorCount)}` : ''}</p>
      </div>
    </div>
    ${top.length ? `<div class="card-meta">
      <div class="meta-row">${ICON.steth}<span title="${esc(top.map((s) => `${specialtyLabel(s.label)} (${num(s.count)})`).join(', '))}">${esc(top.map((s) => specialtyLabel(s.label)).join(' · '))}</span></div>
    </div>` : ''}
    <div class="card-foot">
      <span class="card-cta">View facility ${ICON.arrow}</span>
      <button class="save-btn" type="button" data-facility-filter="${esc(f.name)}" aria-label="Show only professionals at ${esc(f.name)}">${ICON.people}</button>
    </div>
  </article>`;
}

export function renderCards(items, view) {
  const grid = $('#cardGrid');
  grid.classList.toggle('is-list', state.layout === 'list');
  grid.innerHTML = view === 'doctors' ? items.map(doctorCard).join('') : items.map(facilityCard).join('');
}

/* ═══ active filter chips ═══════════════════════════════════ */
const CHIP_LABEL = {
  cat: 'Category', spec: 'Specialty', ftype: 'Facility type',
  fac: 'Facility', lang: 'Language', nat: 'Nationality', lic: 'Licence',
};
const CHIP_VALUE = { ftype: (v) => FACILITY_TYPE_LABEL[v] ?? v, lic: (v) => LICENCE_LABEL[v] ?? v, spec: specialtyLabel };

export function renderChips() {
  const row = $('#chipRow');
  const chips = [];
  if (state.q) {
    chips.push(`<span class="chip"><i>Search</i><span>${esc(state.q)}</span><button type="button" data-clear-q aria-label="Clear search">${ICON.close}</button></span>`);
  }
  for (const [key, stateKey] of Object.entries(MULTI)) {
    for (const value of state[stateKey]) {
      const shown = CHIP_VALUE[key] ? CHIP_VALUE[key](value) : value;
      chips.push(`<span class="chip"><i>${CHIP_LABEL[key]}</i><span>${esc(shown)}</span><button type="button" data-chip-key="${key}" data-chip-value="${esc(value)}" aria-label="Remove ${esc(shown)} filter">${ICON.close}</button></span>`);
    }
  }
  for (const t of state.toggles) {
    chips.push(`<span class="chip"><i>Profile</i><span>${esc(TOGGLES[t])}</span><button type="button" data-chip-toggle="${t}" aria-label="Remove ${esc(TOGGLES[t])} filter">${ICON.close}</button></span>`);
  }
  if (chips.length > 1) chips.push('<button class="chip chip-clear" type="button" data-clear-all>Clear all</button>');
  row.innerHTML = chips.join('');
}

/* ═══ counts + summary ══════════════════════════════════════ */
export function renderCounts({ total, shown, view, filtered }) {
  const noun = view === 'doctors' ? 'professional' : 'facility';
  const plural = view === 'doctors' ? 'professionals' : 'facilities';
  $('#directoryTitle').textContent = view === 'doctors' ? 'Healthcare professionals' : 'Healthcare facilities';
  $('#resultCount').textContent = `${num(total)} ${total === 1 ? noun : plural}`;
  $('#resultContext').textContent = filtered ? 'matching your filters' : 'on the register';
  $('#shownCount').textContent = num(shown);
  $('#totalCount').textContent = num(total);
  $('#loadMoreLabel').textContent = `Load more ${plural}`;

  const n = activeFilterCount();
  $('#filterSummary').textContent = n === 0 ? 'No filters applied' : `${n} filter${n === 1 ? '' : 's'} applied`;
  $('#clearAllBtn').disabled = n === 0;

  // Sidebar header badge + sticky footer count. Presentation only — both read
  // the same numbers the header already shows.
  const badge = $('#filterCountBadge');
  if (badge) { badge.hidden = n === 0; badge.textContent = String(n); }
  const railCount = $('#railCount');
  if (railCount) railCount.textContent = num(total);
  const railNoun = $('#railNoun');
  if (railNoun) railNoun.textContent = total === 1 ? noun : plural;
  const railReset = $('#railReset');
  if (railReset) railReset.disabled = n === 0;
  const mobileCount = $('#mobileFilterCount');
  mobileCount.hidden = n === 0;
  mobileCount.textContent = String(n);
  $('#drawerCount').textContent = `${num(total)} ${plural}`;
  $('#savedCount').textContent = String(state.saved.size);
}

/**
 * Exactly one of loading / error / empty is visible, or none of them (`null`)
 * when real results are on screen. The skeleton grid stands in for the results
 * while loading, so the layout never collapses and then jumps back.
 */
export function showState(which) {
  const map = { loading: '#stateLoading', error: '#stateError', empty: '#stateEmpty' };
  for (const [key, sel] of Object.entries(map)) $(sel).hidden = key !== which;
  $('#loadingText').hidden = which !== 'loading';
  $('#cardGrid').hidden = which !== null;
  $('#resultsFoot').hidden = which !== null;
}

/** Progress is announced to screen readers; the skeleton carries it visually. */
export function setProgress(_ratio, label) {
  if (label) $('#loadingText').textContent = label;
}

/* ═══ hero figures ══════════════════════════════════════════ */
export function renderHeroStats() {
  const t = db.meta.totals;
  const set = (k, v) => { for (const el of document.querySelectorAll(`[data-stat="${k}"]`)) el.textContent = num(v); };
  set('doctors', t.doctors);
  set('facilities', t.facilities);
  set('specialties', t.specialties);
  set('links', t.doctorFacilityLinks);
  set('facilitiesWithDoctors', t.facilitiesWithDoctors);
  document.querySelector('[data-viewcount="doctors"]').textContent = num(t.doctors);
  document.querySelector('[data-viewcount="facilities"]').textContent = num(t.facilitiesWithDoctors);

  const when = new Date(db.meta.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  $('#heroGenerated').textContent = when;
  $('#footerMeta').textContent = `Register snapshot generated ${when}`;
}

/**
 * Show when the directory was last synchronized, when the publisher recorded it.
 *
 * Kept separate from the snapshot date above: `generatedAt` is when the data was
 * exported, `lastSuccessfulSyncAt` is when a validated dataset actually went
 * live. They differ whenever a publish is refused.
 */
export function renderSyncStatus(status) {
  const el = $('#footerMeta');
  if (!el || !status?.lastSuccessfulSyncAt) return;
  const when = new Date(status.lastSuccessfulSyncAt).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  el.textContent = `${el.textContent} · last synchronized ${when}`;
}

/* ═══ hero search selects ═══════════════════════════════════ */
export function renderHeroSelects() {
  const fill = (sel, items, label = (x) => x.label) => {
    const el = $(sel);
    if (!el) return;
    el.insertAdjacentHTML('beforeend', items
      .map((x) => `<option value="${esc(x.label)}">${esc(label(x))} (${num(x.count)})</option>`).join(''));
  };
  fill('#heroCategory', db.facets.category);
  fill('#heroSpecialty', db.facets.specialty.slice(0, 60), (x) => specialtyLabel(x.label));
  fill('#heroFacilityType', db.facets.facilityType, (x) => FACILITY_TYPE_LABEL[x.label] ?? x.label);
}

/* ═══ popular searches — the real top specialties ═══════════ */
export function renderPopular() {
  const host = $('#popularSearches');
  const picks = db.facets.specialty.slice(0, 5);
  host.insertAdjacentHTML('beforeend', picks
    .map((s) => `<button class="popular-btn" type="button" data-popular="${esc(s.label)}">${esc(specialtyLabel(s.label))}</button>`).join(''));
}

/* ═══ network — real facility types, editorial grid ═════════ */
const PLANES = ['', 'p2', 'p3', 'p4'];

export function renderNetwork() {
  const host = $('#networkGrid');
  const types = db.facilityTypes.filter((t) => t.doctors > 0).slice(0, 7);
  // The lead tile occupies 2x2 of a 4-column grid; widening the first and last
  // of the remainder makes the composition close out flush instead of leaving
  // a hole in the final row.
  const last = types.length - 1;
  host.innerHTML = types.map((t, i) => {
    const label = FACILITY_TYPE_LABEL[t.type] ?? t.type;
    const size = i === 0 ? ' etile-lead' : (i === 1 || i === last ? ' etile-wide' : '');
    return `<button class="etile${size}" type="button" data-ftype="${esc(t.type)}" aria-label="Filter by ${esc(label)}">
      <span class="etile-plane ${PLANES[i % PLANES.length]}" aria-hidden="true"></span>
      <span class="etile-grid" aria-hidden="true"></span>
      <span class="etile-scrim" aria-hidden="true"></span>
      <span class="etile-content">
        <span class="etile-kicker">Facility type</span>
        <span class="etile-name">${esc(label)}</span>
        <span class="etile-figures"><b>${num(t.doctors)}</b> professionals <span aria-hidden="true">·</span> ${num(t.facilities)} venues</span>
      </span>
      <span class="etile-go" aria-hidden="true">${ICON.arrow}</span>
    </button>`;
  }).join('');
}

/* ═══ featured facilities — real records ════════════════════ */
export function renderFacilityFeature() {
  const host = $('#facilityFeature');
  const top = [...db.facilities].sort((a, b) => b.doctorCount - a.doctorCount).slice(0, 6);
  host.innerHTML = top.map((f, i) => {
    const type = f.type ? (FACILITY_TYPE_LABEL[f.type] ?? f.type) : '';
    const specs = facilityTopSpecialties(f);
    return `<article class="fac-card" data-facility-open="${esc(f.id)}">
      <div class="fac-visual" aria-hidden="true">
        <span class="fac-visual-grid"></span>
        <span class="fac-glyph">${ICON.facility}</span>
        ${f.inDhaMasterList ? `<span class="verified">${ICON.shield}Verified</span>` : ''}
      </div>
      <div class="fac-info">
        <h3 class="fac-name"><a href="${facilityHref(f)}">${esc(f.name)}</a></h3>
        <p class="fac-sub">${type ? `${esc(type)} <span aria-hidden="true">·</span> ` : ''}<b>${num(f.doctorCount)}</b> professionals</p>
        ${specs.length ? `<div class="fac-specs">${specs.map((s) => `<span class="tag">${esc(specialtyLabel(s.label))}</span>`).join('')}</div>` : ''}
      </div>
    </article>`;
  }).join('');
}

/* ═══ specialty explorer — three editorial columns ══════════ */
export function renderSpecialtyExplorer() {
  const host = $('#specialtyExplorer');
  const picks = db.facets.specialty.slice(0, 18);
  const perCol = Math.ceil(picks.length / 3);
  const cols = [0, 1, 2].map((c) => picks.slice(c * perCol, (c + 1) * perCol));
  host.innerHTML = cols.map((col, ci) => `<div class="spec-col">${col.map((s, ri) => {
    const rank = ci * perCol + ri + 1;
    return `<button class="spec-item" type="button" data-spec="${esc(s.label)}">
      <span class="spec-rank">${String(rank).padStart(2, '0')}</span>
      <span class="spec-name">${esc(specialtyLabel(s.label))}</span>
      <span class="spec-count">${num(s.count)}</span>
    </button>`;
  }).join('')}</div>`).join('');
}

/* ═══ SEO columns — four real indexes into the register ═════ */
export function renderSeoColumns() {
  const host = $('#seoColumns');
  const col = (title, key, items, valueOf, labelOf) => `<div class="seo-col">
    <h3>${esc(title)}</h3>
    <ul>${items.map((x) => `<li><button class="seo-link" type="button" data-facet-pick="${key}" data-value="${esc(valueOf(x))}">
      <span>${esc(labelOf(x))}</span><em>${num(x.count)}</em>
    </button></li>`).join('')}</ul>
  </div>`;

  host.innerHTML = [
    col('By category', 'cat', db.facets.category.slice(0, 8), (x) => x.label, (x) => x.label),
    col('By specialty', 'spec', db.facets.specialty.slice(0, 8), (x) => x.label, (x) => specialtyLabel(x.label)),
    col('By language', 'lang', db.facets.language.slice(0, 8), (x) => x.label, (x) => x.label),
    col('By nationality', 'nat', db.facets.nationality.slice(0, 8), (x) => x.label, (x) => x.label),
  ].join('');
}

/* ═══ FAQ ═══════════════════════════════════════════════════ */
const FAQ = [
  {
    q: 'Where does this data come from?',
    a: 'Every record is taken from the public healthcare licensing register. Names, professional categories, specialties, licence types, nationalities, spoken languages and facility links are all fields published there. Nothing is inferred and nothing is bought.',
  },
  {
    q: 'What does "Verified" mean here?',
    a: 'It means the register publishes a licence type for that professional — a full-time, part-time, registered-only or trainee licence. It is a field on the record, not a rating, a review score or an endorsement from us.',
  },
  {
    q: 'Why is a phone number or email missing?',
    a: 'Because the register does not publish one for that person. The directory records whether contact details exist at source and lets you filter on it, but it does not invent values. Use the "View official profile" link to see whatever the register publishes.',
  },
  {
    q: 'Does this cover the whole UAE?',
    a: 'No. This directory indexes the Dubai licensing register, so it covers professionals and facilities licensed in Dubai. Other emirates run their own registers and are not included here.',
  },
  {
    q: 'How current is it?',
    a: 'The footer shows the date this snapshot was generated. The directory is a static index of that snapshot, so it does not change until a new one is exported.',
  },
  {
    q: 'Is the ordering sponsored in any way?',
    a: 'No. Results are ordered by your search term, your chosen sort, and nothing else. There is no paid placement and no advertising anywhere in this directory.',
  },
];

export function renderFaq() {
  $('#faqList').innerHTML = FAQ.map((item, i) => `
    <div class="faq-item" data-open="false">
      <h3>
        <button class="faq-q" type="button" aria-expanded="false" aria-controls="faq-a-${i}" data-faq="${i}">
          ${esc(item.q)}<span class="faq-sign" aria-hidden="true"></span>
        </button>
      </h3>
      <div class="faq-a" id="faq-a-${i}" role="region"><div><p>${esc(item.a)}</p></div></div>
    </div>`).join('');
}

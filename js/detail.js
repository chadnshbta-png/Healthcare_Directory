/**
 * Detail views for #/doctor/<dhaUniqueId> and #/facility/<facilityId>.
 *
 * Rendered as an overlay over the directory so filter state survives a visit.
 * Only fields present in the bundled data are shown — nothing is inferred, and
 * anything the register does not publish is simply omitted rather than shown
 * as an empty row.
 */
import {
  db, R, FLAG, rowFacility, rowLanguages, rowHas, facilityTopSpecialties,
  doctorSourceUrl, facilityHref, doctorHref,
} from './data.js';
import { esc, num, initials, FACILITY_TYPE_LABEL, LICENCE_LABEL } from './utils.js';

let host = null;
let onClose = () => {};
let facilityQuery = '';

const ICON = {
  back: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 10H5m4-4-4 4 4 4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ext: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 4H4v12h12v-4M12 3h5v5M9.5 10.5 17 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  facility: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 17h14M5 17V7l5-3 5 3v10M8.5 10h3M10 8.5v3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevron: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5 4 5-4 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  shield: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.6 4.4 4.9v4.4c0 3.3 2.3 6.4 5.6 7.6 3.3-1.2 5.6-4.3 5.6-7.6V4.9z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="m7.5 9.9 1.8 1.8 3.3-3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m13 13 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

export function initDetail(container, closeHandler) {
  host = container;
  onClose = closeHandler;
  host.addEventListener('click', (e) => {
    const close = e.target.closest('[data-detail-close]');
    if (close) {
      e.preventDefault();
      // A breadcrumb may also ask the directory to come back on a given tab.
      onClose(close.dataset.view || null);
    }
  });
  host.addEventListener('input', (e) => {
    const box = e.target.closest('[data-facility-search]');
    if (!box) return;
    facilityQuery = box.value.toLowerCase();
    const list = host.querySelector('[data-facility-people]');
    if (list) list.innerHTML = facilityPeopleRows(box.dataset.facilitySearch);
  });
}

/** One fact; returns '' when there is no value, so nothing empty renders. */
const field = (label, value) =>
  value ? `<div class="dt-field"><dt>${esc(label)}</dt><dd>${value}</dd></div>` : '';

/** Only render a block when it actually has content. */
const block = (title, body) =>
  body ? `<section class="detail-block"><h2>${esc(title)}</h2>${body}</section>` : '';

const crumbs = (section, view, current) => `
  <nav class="crumbs" aria-label="Breadcrumb">
    <a href="#" data-detail-close>Directory</a>
    ${ICON.chevron}
    <a href="#" data-detail-close data-view="${view}">${esc(section)}</a>
    ${ICON.chevron}
    <span class="crumb-now" aria-current="page" title="${esc(current)}">${esc(current)}</span>
  </nav>`;

/* ═══ doctor ════════════════════════════════════════════════ */
function doctorView(id) {
  const i = db.rows.findIndex((r) => r[R.ID] === id);
  if (i < 0) return notFound('Professional not found', `No professional with DHA ID ${esc(id)} exists in this dataset.`);

  const r = db.rows[i];
  const name = r[R.NAME];
  const category = r[R.CATEGORY] >= 0 ? db.dict.category[r[R.CATEGORY]] : '';
  const specialty = r[R.SPECIALTY] >= 0 ? db.dict.specialty[r[R.SPECIALTY]] : '';
  const licence = r[R.LICENCE] >= 0 ? db.dict.licenseType[r[R.LICENCE]] : '';
  const nationality = r[R.NATIONALITY] >= 0 ? db.dict.nationality[r[R.NATIONALITY]] : '';
  const facility = rowFacility(r);
  const facilityName = facility ? facility.name : (r[R.FACILITY] >= 0 ? db.dict.facility[r[R.FACILITY]] : '');
  const facilityType = facility?.type ? (FACILITY_TYPE_LABEL[facility.type] ?? facility.type) : '';
  const langs = rowLanguages(r);

  const contact = [];
  if (rowHas(r, FLAG.MOBILE)) contact.push('Phone number');
  if (rowHas(r, FLAG.EMAIL)) contact.push('Email');
  if (rowHas(r, FLAG.LINKEDIN)) contact.push('LinkedIn');

  const records = [];
  if (rowHas(r, FLAG.EXPERIENCE)) records.push('Work history');
  if (rowHas(r, FLAG.EDUCATION)) records.push('Education');

  // A plain-language summary, assembled only from fields that exist.
  const bits = [];
  if (category) bits.push(`is registered with the Dubai Health Authority under <b>${esc(category)}</b>`);
  if (specialty) bits.push(`practising as a <b>${esc(specialty)}</b>`);
  if (facilityName) bits.push(`currently linked to <b>${esc(facilityName)}</b>`);
  const summary = bits.length
    ? `<p class="detail-prose">${esc(name)} ${bits.join(', ')}.</p>`
    : '';

  const sub = [];
  if (specialty) sub.push(`<b>${esc(specialty)}</b>`);
  if (category && category !== specialty) sub.push(esc(category));
  if (facilityName) sub.push(esc(facilityName));

  return `
  <article class="detail" role="dialog" aria-modal="true" aria-label="${esc(name)}">
    ${crumbs('Doctors', 'doctors', name)}

    <header class="detail-hero">
      <div class="detail-ident">
        <div class="avatar detail-avatar" aria-hidden="true">${esc(initials(name))}</div>
        <div class="detail-headline">
          ${licence ? `<span class="verified verified-solid">${ICON.shield}DHA Verified</span>` : ''}
          <h1 class="detail-name">${esc(name)}</h1>
          <p class="detail-sub">${sub.join('<span class="detail-dot" aria-hidden="true"></span>')}</p>
        </div>
      </div>
      <div class="detail-actions">
        <a class="btn btn-primary" href="${doctorSourceUrl(r[R.ID])}" target="_blank" rel="noopener">View official DHA profile ${ICON.ext}</a>
        <button class="btn btn-outline" type="button" data-detail-close>${ICON.back} Back to directory</button>
      </div>
    </header>

    <div class="detail-layout">
      <div>
        ${block('Professional information', summary + `<dl class="factlist" style="margin-top:16px">
          ${field('Professional category', esc(category))}
          ${field('Specialty', esc(specialty))}
          ${field('Nationality', esc(nationality))}
          ${field('DHA unique ID', `<span class="mono">${esc(r[R.ID])}</span>`)}
        </dl>`)}

        ${block('Languages spoken', langs.length
          ? `<div class="fac-specs" style="border:0;padding:0;margin:0">${langs.map((l) => `<span class="tag">${esc(l)}</span>`).join('')}</div>`
          : '')}

        ${block('Facility', facilityName
          ? `<dl class="factlist">
              ${field('Current facility', facility
                ? `<a class="link-brand" href="${facilityHref(facility)}">${esc(facilityName)}</a>`
                : esc(facilityName))}
              ${field('Facility type', esc(facilityType))}
              ${facility ? field('Professionals linked', num(facility.doctorCount)) : ''}
            </dl>`
          : '')}

        ${block('Licensing information', licence
          ? `<dl class="factlist">
              ${field('Licence type', `${esc(LICENCE_LABEL[licence] ?? licence)} <span class="mono dim">(${esc(licence)})</span>`)}
              ${field('Register', 'Dubai Health Authority')}
            </dl>`
          : '')}

        ${block('Records held by the register', (contact.length || records.length)
          ? `<dl class="factlist">
              ${field('Published contact', contact.length ? contact.map((c) => `<span class="tag tag-brand">${esc(c)}</span>`).join('') : '')}
              ${field('Additional records', records.length ? records.map((c) => `<span class="tag">${esc(c)}</span>`).join('') : '')}
            </dl>`
          : '')}
      </div>

      <aside class="detail-aside">
        <div class="aside-card">
          <h3>Full profile at the source</h3>
          <p>Contact details, work history and education are held by the authority and are not bundled in this package. This directory records whether they exist.</p>
          <a class="btn btn-primary" href="${doctorSourceUrl(r[R.ID])}" target="_blank" rel="noopener">Open DHA profile ${ICON.ext}</a>
        </div>
        ${facility ? `<div class="aside-card">
          <h3>${esc(facility.name)}</h3>
          <p>${num(facility.doctorCount)} licensed professionals are linked to this facility.</p>
          <a class="btn btn-outline" href="${facilityHref(facility)}">View facility</a>
        </div>` : ''}
        <p class="aside-note">Fields the register does not publish are left out of this page rather than shown as blank.</p>
      </aside>
    </div>
  </article>`;
}

/* ═══ facility ══════════════════════════════════════════════ */
function facilityPeopleRows(facilityId) {
  const fi = db.facilities.findIndex((f) => f.id === facilityId);
  if (fi < 0) return '';
  const q = facilityQuery;
  const out = [];
  for (let i = 0; i < db.rows.length && out.length < 60; i++) {
    const r = db.rows[i];
    if (r[R.FACILITY] !== fi) continue;
    if (q && !db.foldedName[i].includes(q)) continue;
    const spec = r[R.SPECIALTY] >= 0 ? db.dict.specialty[r[R.SPECIALTY]] : '';
    const cat = r[R.CATEGORY] >= 0 ? db.dict.category[r[R.CATEGORY]] : '';
    out.push(`<li class="person">
      <span class="person-avatar" aria-hidden="true">${esc(initials(r[R.NAME]))}</span>
      <span class="person-main">
        <a class="person-name" href="${doctorHref(r[R.ID])}">${esc(r[R.NAME])}</a>
        <span class="person-role">${esc(spec || cat)}</span>
      </span>
    </li>`);
  }
  return out.length
    ? out.join('')
    : '<li class="opt-none">No professionals match that name at this facility.</li>';
}

function facilityView(id) {
  const f = db.facilities.find((x) => x.id === id);
  if (!f) return notFound('Facility not found', `No facility with id ${esc(id)} exists in this dataset.`);

  const type = f.type ? (FACILITY_TYPE_LABEL[f.type] ?? f.type) : '';
  const specs = facilityTopSpecialties(f);
  facilityQuery = '';

  const sub = [];
  if (type) sub.push(`<b>${esc(type)}</b>`);
  sub.push(`${num(f.doctorCount)} linked ${f.doctorCount === 1 ? 'professional' : 'professionals'}`);

  return `
  <article class="detail" role="dialog" aria-modal="true" aria-label="${esc(f.name)}">
    ${crumbs('Facilities', 'facilities', f.name)}

    <header class="detail-hero">
      <div class="detail-ident">
        <div class="avatar facility detail-avatar" aria-hidden="true">${ICON.facility}</div>
        <div class="detail-headline">
          ${f.inDhaMasterList
            ? `<span class="verified verified-solid">${ICON.shield}DHA Listed</span>`
            : '<span class="tag tag-amber">Not on the DHA facility list</span>'}
          <h1 class="detail-name">${esc(f.name)}</h1>
          <p class="detail-sub">${sub.join('<span class="detail-dot" aria-hidden="true"></span>')}</p>
        </div>
      </div>
      <div class="detail-actions">
        ${f.sourceUrl ? `<a class="btn btn-primary" href="${esc(f.sourceUrl)}" target="_blank" rel="noopener">View on the DHA directory ${ICON.ext}</a>` : ''}
        <button class="btn btn-outline" type="button" data-detail-close>${ICON.back} Back to directory</button>
      </div>
    </header>

    <div class="detail-layout">
      <div>
        ${block('Facility information', `<dl class="factlist">
          ${field('Facility type', type ? `${esc(type)} <span class="dim">(from the facility name)</span>` : '')}
          ${field('Professionals linked', num(f.doctorCount))}
          ${field('DHA listing', f.inDhaMasterList ? 'Present on the DHA facility list' : 'Not present')}
          ${field('Facility ID', `<span class="mono">${esc(f.id)}</span>`)}
        </dl>`)}

        ${block('Most common specialties', specs.length
          ? `<div class="fac-specs" style="border:0;padding:0;margin:0">${specs.map((s) => `<span class="tag tag-brand">${esc(s.label)} <span class="mono">${num(s.count)}</span></span>`).join('')}</div>`
          : '')}

        <section class="detail-block">
          <div class="people-head">
            <h2>Healthcare professionals at this facility</h2>
            <label class="opt-search people-search">
              ${ICON.search}
              <input type="search" data-facility-search="${esc(f.id)}" placeholder="Search within this facility…" aria-label="Search professionals at this facility">
            </label>
          </div>
          <ul class="person-list" data-facility-people>${facilityPeopleRows(f.id)}</ul>
          ${f.doctorCount > 60 ? `<p class="detail-more">Showing the first 60 of ${num(f.doctorCount)}. Use the search above, or filter by this facility in the directory.</p>` : ''}
        </section>
      </div>

      <aside class="detail-aside">
        <div class="aside-card">
          <h3>Filter the directory</h3>
          <p>Narrow the whole directory to the ${num(f.doctorCount)} professionals linked to this facility.</p>
          <button class="btn btn-primary" type="button" data-facility-filter="${esc(f.name)}">Show these professionals</button>
        </div>
        <p class="aside-note">Facility type is derived from the registered facility name. Everything else on this page is a published field.</p>
      </aside>
    </div>
  </article>`;
}

function notFound(title, message) {
  return `<article class="detail">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#" data-detail-close>Directory</a>${ICON.chevron}<span class="crumb-now">Not found</span></nav>
    <div class="state state-empty">
      <div class="state-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m16 16 4.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
      </div>
      <h3>${title}</h3><p>${message}</p>
      <div class="state-actions"><button class="btn btn-primary" type="button" data-detail-close>Back to directory</button></div>
    </div>
  </article>`;
}

/**
 * Render the route. Returns true when a detail view was shown.
 * Accepts `#/doctor/<id>` and `#/facility/<id>`.
 */
export function renderRoute(hash) {
  const m = /^#\/(doctor|facility)\/(.+)$/.exec(hash || '');
  if (!m || !db.ready) {
    host.hidden = true;
    host.innerHTML = '';
    return false;
  }
  const [, kind, rawId] = m;
  const id = decodeURIComponent(rawId);
  host.innerHTML = kind === 'doctor' ? doctorView(id) : facilityView(id);
  host.hidden = false;
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  host.querySelector('.detail-name, .state h3')?.focus?.();
  return true;
}

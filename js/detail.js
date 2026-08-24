/**
 * Detail views for #/doctor/<dhaUniqueId> and #/facility/<facilityId>.
 *
 * Rendered as an overlay over the directory so filter state survives a visit.
 * Only fields present in the bundled data are shown — nothing is inferred, and
 * anything the register does not publish is simply omitted rather than shown
 * as an empty row.
 */
import {
  db, R, FLAG, rowFacility, rowFacilities, rowFacilityIdxs, rowLanguages, rowHas,
  facilityTopSpecialties,
  doctorSourceUrl, facilityHref, doctorHref,
} from './data.js';
import { esc, num, initials, FACILITY_TYPE_LABEL, LICENCE_LABEL, specialtyLabel } from './utils.js';
import { loadProfile, profileWork, profileLicences, profileEducation, profileContact } from './profile.js';

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
  work: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="6.5" width="14" height="9.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M3 10.5h14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  study: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4 2.8 7.4 10 10.8l7.2-3.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M5.6 9v3.9c0 .9 2 2.1 4.4 2.1s4.4-1.2 4.4-2.1V9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  phone: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.4 3.5H4.2c-.7 0-1.3.6-1.2 1.3.5 6 4.9 10.4 10.9 10.9.7.1 1.3-.5 1.3-1.2v-2.2c0-.6-.4-1.1-1-1.2l-2-.4c-.5-.1-1 .1-1.2.5l-.6 1a10 10 0 0 1-4-4l1-.6c.4-.2.6-.7.5-1.2l-.4-2c-.1-.6-.6-1-1.2-1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  mail: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.8" y="4.6" width="14.4" height="10.8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m3.4 6 6.6 4.6L16.6 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  linkedin: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.6 8.6V14M6.6 6.2v.1M9.8 14V8.6M9.8 11c0-1.4.9-2.4 2-2.4s1.9 1 1.9 2.4V14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
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

/**
 * One labelled group inside "Records held by the register".
 *
 * A group is a list of ROWS. Every row is either
 *   - a disclosure holding the actual records, when the directory has them;
 *   - a direct action (tel:/mailto:/profile URL), for a published contact; or
 *   - a flat inert tile, when the register publishes nothing of that kind.
 *
 * Nothing here reaches out to the register. Values come from the profile shard
 * for this professional, and a row only exists when its value does.
 */
const recRow = (it) => {
  if (it.absent) {
    return `<li><span class="recchip is-absent">
      <span class="recchip-ico" aria-hidden="true">${it.icon}</span>
      <span class="recchip-text"><b>${esc(it.label)}</b><em>${esc(it.note || 'Not published')}</em></span>
    </span></li>`;
  }
  if (it.href) {
    // A published contact channel: the value IS the action.
    return `<li><a class="recchip" href="${esc(it.href)}"${it.external ? ' target="_blank" rel="noopener"' : ''}>
      <span class="recchip-ico" aria-hidden="true">${it.icon}</span>
      <span class="recchip-text"><b>${esc(it.label)}</b><em class="recchip-value">${esc(it.value)}</em></span>
      <span class="recchip-go" aria-hidden="true">${it.external ? ICON.ext : ICON.chevron}</span>
    </a></li>`;
  }
  // A record set: opens in place rather than navigating away.
  return `<li><details class="recdisc"${it.open ? ' open' : ''}>
    <summary class="recchip">
      <span class="recchip-ico" aria-hidden="true">${it.icon}</span>
      <span class="recchip-text"><b>${esc(it.label)}</b><em>${esc(it.note)}</em></span>
      <span class="recchip-go recdisc-caret" aria-hidden="true">${ICON.chevron}</span>
    </summary>
    <div class="recdisc-body">${it.body}</div>
  </details></li>`;
};

const recGroup = (title, items, emptyNote) => `
  <section class="recgroup">
    <h3 class="recgroup-title">${esc(title)}</h3>
    ${items.length
      ? `<ul class="recgroup-list">${items.map(recRow).join('')}</ul>`
      : `<p class="recgroup-empty">${esc(emptyNote)}</p>`}
  </section>`;

/** One work-history entry, rendered from whichever fields the register gave. */
const workEntry = (w) => {
  const meta = [];
  if (w.n) meta.push(`<span class="rec-lic">Licence <span class="mono">${esc(w.n)}</span></span>`);
  if (w.s) meta.push(`<span>${esc(w.s)}${w.e ? ` — ${esc(w.e)}` : ''}${w.d ? ` <span class="dim">(${esc(w.d)})</span>` : ''}</span>`);
  if (w.l) meta.push(`<span>${esc(w.l)}</span>`);
  // `x` is a trailing value the register did not label as either a facility or
  // a city, so it is shown plainly rather than captioned as a workplace.
  const where = w.f
    ? `<p class="rec-where">${esc(w.f)}</p>`
    : (w.x ? `<p class="rec-where dim">${esc(w.x)}</p>` : '');
  return `<li class="rec-entry${w.c ? ' is-current' : ''}">
    <div class="rec-entry-head">
      <p class="rec-role">${esc(w.t || 'Role not published')}</p>
      ${w.c ? '<span class="rec-now">Present</span>' : ''}
    </div>
    ${where}
    ${meta.length ? `<p class="rec-meta">${meta.join('<span class="rec-dot" aria-hidden="true">·</span>')}</p>` : ''}
  </li>`;
};

/** One current licence exactly as the register lists it. */
const licenceEntry = (l) => `<li class="rec-entry is-current">
  <div class="rec-entry-head">
    <p class="rec-role">${esc(l.t || 'Role not published')}</p>
    ${l.s ? `<span class="rec-now">${esc(l.s)}</span>` : ''}
  </div>
  ${l.f ? `<p class="rec-where">${esc(l.f)}</p>` : ''}
  ${l.n ? `<p class="rec-meta"><span class="rec-lic">Licence <span class="mono">${esc(l.n)}</span></span></p>` : ''}
</li>`;

/** One education entry. */
const eduEntry = (e) => {
  const meta = [];
  if (e.g) meta.push(`<span>Graduated ${esc(e.g)}</span>`);
  if (e.l) meta.push(`<span>${esc(e.l)}</span>`);
  return `<li class="rec-entry">
    <div class="rec-entry-head"><p class="rec-role">${esc(e.i || 'Institution not published')}</p></div>
    ${meta.length ? `<p class="rec-meta">${meta.join('<span class="rec-dot" aria-hidden="true">·</span>')}</p>` : ''}
  </li>`;
};

const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

/**
 * Build both groups from a loaded profile.
 *
 * `flags` is what doctors.json already knows — which record types EXIST. It is
 * the fallback when the optional profile export is not deployed: the section
 * still reports what the register holds, it just cannot show the values.
 */
function recordsBody(profile, flags) {
  const work = profileWork(profile);
  const licences = profileLicences(profile);
  const edu = profileEducation(profile);
  const contact = profileContact(profile);
  const haveDetail = profile !== null;

  const records = [];

  if (licences.length) {
    records.push({
      icon: ICON.shield, label: 'Current licences', open: true,
      note: plural(licences.length, 'active placement', 'active placements'),
      body: `<ul class="rec-list">${licences.map(licenceEntry).join('')}</ul>`,
    });
  }

  if (work.length) {
    records.push({
      icon: ICON.work, label: 'Work history',
      note: plural(work.length, 'entry', 'entries'),
      body: `<ul class="rec-list">${work.map(workEntry).join('')}</ul>`,
    });
  } else {
    records.push({
      icon: ICON.work, label: 'Work history', absent: true,
      note: flags.experience
        ? (haveDetail ? 'Not published' : 'Held by the register')
        : 'Not published',
    });
  }

  if (edu.length) {
    records.push({
      icon: ICON.study, label: 'Education',
      note: plural(edu.length, 'entry', 'entries'),
      body: `<ul class="rec-list">${edu.map(eduEntry).join('')}</ul>`,
    });
  } else {
    records.push({
      icon: ICON.study, label: 'Education', absent: true,
      note: flags.education
        ? (haveDetail ? 'Not published' : 'Held by the register')
        : 'Not published',
    });
  }

  const ICON_FOR = { phone: ICON.phone, email: ICON.mail, linkedin: ICON.linkedin };
  let contactRows = contact.map((c) => ({
    icon: ICON_FOR[c.kind], label: c.label, value: c.value,
    href: c.href, external: c.kind === 'linkedin',
  }));

  // Without the profile export the values are unavailable, but doctors.json
  // still knows WHICH channels exist. Say so plainly instead of inventing a
  // value or pretending the channel is absent.
  if (!haveDetail) {
    contactRows = [];
    if (flags.mobile) contactRows.push({ icon: ICON.phone, label: 'Phone number', absent: true, note: 'Available on the register' });
    if (flags.email) contactRows.push({ icon: ICON.mail, label: 'Email', absent: true, note: 'Available on the register' });
    if (flags.linkedIn) contactRows.push({ icon: ICON.linkedin, label: 'LinkedIn', absent: true, note: 'Available on the register' });
  }

  return `<div class="recgroups">
    ${recGroup('Additional records', records, 'The register holds no further records for this professional.')}
    ${recGroup('Published contact', contactRows, 'The register publishes no contact channel for this professional.')}
  </div>`;
}

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
  if (i < 0) return notFound('Professional not found', `No professional with register ID ${esc(id)} exists in this dataset.`);

  const r = db.rows[i];
  const name = r[R.NAME];
  const category = r[R.CATEGORY] >= 0 ? db.dict.category[r[R.CATEGORY]] : '';
  const specialty = r[R.SPECIALTY] >= 0 ? db.dict.specialty[r[R.SPECIALTY]] : '';
  const licence = r[R.LICENCE] >= 0 ? db.dict.licenseType[r[R.LICENCE]] : '';
  const nationality = r[R.NATIONALITY] >= 0 ? db.dict.nationality[r[R.NATIONALITY]] : '';
  // A professional may hold several concurrent facility relationships.
  const facilities = rowFacilities(r);
  const facility = rowFacility(r);                       // the first, for the subtitle
  const facilityName = facilities.length ? facilities[0].name : '';
  const langs = rowLanguages(r);

  // What doctors.json knows: WHICH records exist, not their values. Used to
  // describe the section before the profile shard lands, and as the permanent
  // fallback when the optional profile export is not deployed at all.
  const recordFlags = {
    experience: rowHas(r, FLAG.EXPERIENCE),
    education: rowHas(r, FLAG.EDUCATION),
    mobile: rowHas(r, FLAG.MOBILE),
    email: rowHas(r, FLAG.EMAIL),
    linkedIn: rowHas(r, FLAG.LINKEDIN),
  };


  // A plain-language summary, assembled only from fields that exist.
  const sourceUrl = doctorSourceUrl(r[R.ID]);

  const bits = [];
  if (category) bits.push(`is registered on the official healthcare register under <b>${esc(category)}</b>`);
  if (specialty) bits.push(`practising as a <b>${esc(specialtyLabel(specialty))}</b>`);
  if (facilities.length === 1) bits.push(`currently linked to <b>${esc(facilities[0].name)}</b>`);
  else if (facilities.length > 1) bits.push(`currently linked to <b>${facilities.length} facilities</b>`);
  const summary = bits.length
    ? `<p class="detail-prose">${esc(name)} ${bits.join(', ')}.</p>`
    : '';

  const sub = [];
  if (specialty) sub.push(`<b>${esc(specialtyLabel(specialty))}</b>`);
  if (category && category !== specialty) sub.push(esc(category));
  if (facilityName) sub.push(esc(facilityName));

  return `
  <article class="detail" role="dialog" aria-modal="true" aria-label="${esc(name)}">
    ${crumbs('Doctors', 'doctors', name)}

    <header class="detail-hero">
      <div class="detail-ident">
        <div class="avatar detail-avatar" aria-hidden="true">${esc(initials(name))}</div>
        <div class="detail-headline">
          ${licence ? `<span class="verified verified-solid">${ICON.shield}Verified</span>` : ''}
          <h1 class="detail-name">${esc(name)}</h1>
          <p class="detail-sub">${sub.join('<span class="detail-dot" aria-hidden="true"></span>')}</p>
        </div>
      </div>
      <div class="detail-actions">
        <a class="btn btn-primary" href="${doctorSourceUrl(r[R.ID])}" target="_blank" rel="noopener">View official profile ${ICON.ext}</a>
        <button class="btn btn-outline" type="button" data-detail-close>${ICON.back} Back to directory</button>
      </div>
    </header>

    <div class="detail-layout">
      <div>
        ${block('Professional information', summary + `<dl class="factlist" style="margin-top:16px">
          ${field('Professional category', esc(category))}
          ${field('Specialty', esc(specialtyLabel(specialty)))}
          ${field('Nationality', esc(nationality))}
          ${field('Register ID', `<span class="mono">${esc(r[R.ID])}</span>`)}
        </dl>`)}

        ${block('Languages spoken', langs.length
          ? `<div class="fac-specs" style="border:0;padding:0;margin:0">${langs.map((l) => `<span class="tag">${esc(l)}</span>`).join('')}</div>`
          : '')}

        ${block(facilities.length > 1 ? 'Facilities' : 'Facility', facilities.length
          ? `<dl class="factlist">
              ${facilities.map((f) => field(
                f.record?.type ? (FACILITY_TYPE_LABEL[f.record.type] ?? f.record.type) : 'Facility',
                (f.record
                  ? `<a class="link-brand" href="${facilityHref(f.record)}">${esc(f.name)}</a>`
                  : esc(f.name))
                + (f.record ? ` <span class="dim">· ${num(f.record.doctorCount)} linked</span>` : ''),
              )).join('')}
            </dl>`
          : '')}

        ${block('Licensing information', licence
          ? `<dl class="factlist">
              ${field('Licence type', `${esc(LICENCE_LABEL[licence] ?? licence)} <span class="mono dim">(${esc(licence)})</span>`)}
            </dl>`
          : '')}

        ${block('Records held by the register',
          `<div id="recordsHost" data-records-for="${esc(r[R.ID])}"
                data-flags="${esc(JSON.stringify(recordFlags))}">${recordsBody(null, recordFlags)}</div>`)}
      </div>

      <aside class="detail-aside">
        <div class="aside-card">
          <h3>Official register entry</h3>
          <p>This page shows the work history, education and published contact this directory holds. The register is the authority on all of it.</p>
          <a class="btn btn-primary" href="${doctorSourceUrl(r[R.ID])}" target="_blank" rel="noopener">Open official profile ${ICON.ext}</a>
        </div>
        ${facilities.filter((f) => f.record).map((f) => `<div class="aside-card">
          <h3>${esc(f.name)}</h3>
          <p>${num(f.record.doctorCount)} licensed professionals are linked to this facility.</p>
          <a class="btn btn-outline" href="${facilityHref(f.record)}">View facility</a>
        </div>`).join('')}
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
    if (!rowFacilityIdxs(r).includes(fi)) continue;
    if (q && !db.foldedName[i].includes(q)) continue;
    const spec = r[R.SPECIALTY] >= 0 ? db.dict.specialty[r[R.SPECIALTY]] : '';
    const cat = r[R.CATEGORY] >= 0 ? db.dict.category[r[R.CATEGORY]] : '';
    out.push(`<li class="person">
      <span class="person-avatar" aria-hidden="true">${esc(initials(r[R.NAME]))}</span>
      <span class="person-main">
        <a class="person-name" href="${doctorHref(r[R.ID])}">${esc(r[R.NAME])}</a>
        <span class="person-role" title="${esc(spec ? specialtyLabel(spec) : cat)}">${esc(spec ? specialtyLabel(spec) : cat)}</span>
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
            ? `<span class="verified verified-solid">${ICON.shield}Verified</span>`
            : '<span class="tag tag-amber">Not on the official facility list</span>'}
          <h1 class="detail-name">${esc(f.name)}</h1>
          <p class="detail-sub">${sub.join('<span class="detail-dot" aria-hidden="true"></span>')}</p>
        </div>
      </div>
      <div class="detail-actions">
        ${f.sourceUrl ? `<a class="btn btn-primary" href="${esc(f.sourceUrl)}" target="_blank" rel="noopener">View on the official register ${ICON.ext}</a>` : ''}
        <button class="btn btn-outline" type="button" data-detail-close>${ICON.back} Back to directory</button>
      </div>
    </header>

    <div class="detail-layout">
      <div>
        ${block('Facility information', `<dl class="factlist">
          ${field('Facility type', type ? `${esc(type)} <span class="dim">(from the facility name)</span>` : '')}
          ${field('Professionals linked', num(f.doctorCount))}
          ${field('Register listing', f.inDhaMasterList ? 'Present on the official facility list' : 'Not present')}
          ${field('Facility ID', `<span class="mono">${esc(f.id)}</span>`)}
        </dl>`)}

        ${block('Most common specialties', specs.length
          ? `<div class="fac-specs" style="border:0;padding:0;margin:0">${specs.map((s) => `<span class="tag tag-brand">${esc(specialtyLabel(s.label))} <span class="mono">${num(s.count)}</span></span>`).join('')}</div>`
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
 * Fill the records section with the professional's actual records.
 *
 * The detail view renders synchronously from doctors.json; the values live in a
 * separate shard, so they arrive a moment later. The guard on `data-records-for`
 * means a fast click-through to another professional cannot have the previous
 * one's records land in it.
 */
async function hydrateRecords(id) {
  const mount = host.querySelector('#recordsHost');
  if (!mount) return;
  let flags = {};
  try { flags = JSON.parse(mount.dataset.flags || '{}'); } catch { flags = {}; }
  const profile = await loadProfile(id);
  const still = host.querySelector('#recordsHost');
  if (!still || still.dataset.recordsFor !== id) return;
  still.innerHTML = recordsBody(profile, flags);
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
  if (kind === 'doctor') hydrateRecords(id);
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  host.querySelector('.detail-name, .state h3')?.focus?.();
  return true;
}

/**
 * Detail views for #/doctor/<dhaUniqueId> and #/facility/<facilityId>.
 *
 * Rendered as an overlay over the directory so filter state survives a visit.
 * Only fields present in the bundled data are shown — nothing is inferred, and
 * anything the register does not publish is simply omitted rather than shown
 * as an empty row.
 */
import {
  db, R, FLAG, rowFacility, rowFacilities, rowFacilityIdxs, rowLanguages, rowHas, rowLicences,
  facilityTopSpecialties, rowRolesAt, rowHasRoleAt,
  rowIsLicensedAt, facilityLicensedCount,
  doctorSourceUrl, facilityHref, doctorHref,
} from './data.js';
import {
  esc, num, initials, facilityTypeLabel, LICENCE_LABEL, specialtyLabel,
} from './utils.js';
import { loadProfile, profileWork, profileLicences, profileEducation, profileContact } from './profile.js';
import { state } from './state.js';

let host = null;
let onClose = () => {};
let onPageChange = () => {};
let facilityQuery = '';
// A facility lists exactly one population — the professionals the register
// places there now (js/data.js ▸ rowIsLicensedAt). There is no scope switch:
// offering "all linked" or "registered" as alternative staff lists is what
// made the figures disagree with the register in the first place.

const ICON = {
  back: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 10H5m4-4-4 4 4 4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  fwd: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11m-4-4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
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
  twitter: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4h3l4.2 5.6L15.6 4H17l-5.1 6.2L17.2 16h-3l-4.4-5.9L5.2 16H4l5.4-6.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  pin: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17.5S4.8 12.7 4.8 9a5.2 5.2 0 1 1 10.4 0c0 3.7-5.2 8.5-5.2 8.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="10" cy="8.9" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
};

export function initDetail(container, closeHandler, pageChangeHandler = () => {}) {
  host = container;
  onClose = closeHandler;
  onPageChange = pageChangeHandler;
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
    // A new in-facility query is a new result set, so paging restarts at 1.
    // The specialty chip stays selected: query AND specialty compose.
    state.facilityPage = 1;
    repaintPeople(box.dataset.facilitySearch);
  });

  // Specialty chips: pick / unpick, and "Load more".
  host.addEventListener('click', (e) => {
    const more = e.target.closest('[data-spec-more]');
    if (more) {
      e.preventDefault();
      specShown += SPEC_STEP;
      repaintSpecialties();
      return;
    }
    const chip = e.target.closest('[data-spec-pick]');
    if (!chip) return;
    e.preventDefault();
    const label = chip.dataset.specPick;
    // Clicking the selected chip clears the filter.
    state.facilitySpecialty = state.facilitySpecialty === label ? '' : label;
    // A different population means paging starts again.
    state.facilityPage = 1;
    onPageChange();
    repaintSpecialties();
    const list = host.querySelector('[data-facility-people]');
    if (list?.dataset.facilityPeople) repaintPeople(list.dataset.facilityPeople);
  });

  // Pagination. The facility id travels on the list element, so the constraint
  // cannot be lost between pages.
  host.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-facility-page]');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const page = Number(btn.dataset.facilityPage);
    if (!Number.isFinite(page) || page < 1) return;
    const list = host.querySelector('[data-facility-people]');
    const id = list?.dataset.facilityPeople;
    if (!id) return;
    state.facilityPage = page;
    onPageChange();
    repaintPeople(id);
    host.querySelector('.people-block')?.scrollIntoView({ block: 'start', behavior: 'instant' });
  });
}

/** Redraw the chip row in place, preserving scroll position. */
function repaintSpecialties() {
  const list = host.querySelector('[data-facility-people]');
  const id = list?.dataset.facilityPeople;
  if (!id) return;
  const mount = host.querySelector('[data-spec-chips]')?.parentElement;
  if (!mount) return;
  mount.innerHTML = specialtyChips(facilityRegisteredSpecialties(id));
}

/** Redraw the current page of professionals and the pager beneath it. */
function repaintPeople(facilityId) {
  const list = host.querySelector('[data-facility-people]');
  if (list) list.innerHTML = facilityPeopleRows(facilityId);
  const pager = host.querySelector('[data-facility-pager]');
  if (pager) pager.innerHTML = facilityPager(facilityId);
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
  // Values the register added that have no named slot. Kept visible rather
  // than silently dropped between the parser and the page.
  for (const x of w.o ?? []) meta.push(`<span>${esc(x)}</span>`);
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

/**
 * One education entry, rendered from EVERY field the register published for it.
 *
 * Shard keys: q qualification · i institution · h unlabelled heading ·
 * g graduated · l location · y country · v verification note · o other parts.
 *
 * The headline is whichever of institution / qualification / heading the
 * register actually gave, in that order — and when both a place and a
 * qualification exist, both are shown. An entry is never reduced to one field,
 * and a list of entries is never reduced to one entry.
 */
const eduEntry = (e) => {
  const headline = e.i || e.q || e.h || '';
  // Whatever did not become the headline still belongs on the card.
  const secondary = [];
  if (e.i && e.q) secondary.push(e.q);
  if (e.i && e.h && e.h !== e.q) secondary.push(e.h);
  if (!e.i && e.q && e.h && e.h !== e.q) secondary.push(e.h);
  for (const x of e.o ?? []) secondary.push(x);

  const meta = [];
  if (e.g) meta.push(`<span class="rec-year">Graduated ${esc(e.g)}</span>`);
  const place = [e.l, e.y].filter(Boolean).join(', ');
  if (place) meta.push(`<span>${esc(place)}</span>`);
  if (e.v) meta.push(`<span class="dim">${esc(e.v)}</span>`);

  return `<li class="rec-entry">
    <div class="rec-entry-head">
      <p class="rec-role">${esc(headline || 'Institution not published')}</p>
    </div>
    ${secondary.length ? `<p class="rec-where">${esc(secondary.join(' · '))}</p>` : ''}
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
      // Open by default: the count in the summary and the list beneath it must
      // agree on sight. Every entry the register published is in this list —
      // the renderer maps the whole array and never slices it.
      icon: ICON.study, label: 'Education', open: true,
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

  const ICON_FOR = {
    phone: ICON.phone, email: ICON.mail, linkedin: ICON.linkedin, twitter: ICON.twitter,
  };
  let contactRows = contact.map((c) => ({
    icon: ICON_FOR[c.kind], label: c.label, value: c.value,
    href: c.href, external: c.kind === 'linkedin' || c.kind === 'twitter',
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
  const licences = rowLicences(r);
  const licence = licences[0] ?? '';
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
  if (category && category !== specialty) sub.push(`<b>${esc(category)}</b>`);
  if (facilityName) sub.push(esc(facilityName));
  if (facilities.length > 1) sub.push(`+${facilities.length - 1} more ${facilities.length === 2 ? 'facility' : 'facilities'}`);

  return `
  <article class="detail" role="dialog" aria-modal="true" aria-label="${esc(name)}">
    ${crumbs('Doctors', 'doctors', name)}

    <header class="detail-hero">
      <div class="detail-ident">
        <div class="avatar detail-avatar" aria-hidden="true">${esc(initials(name))}</div>
        <div class="detail-headline">
          <div class="detail-badges">
            ${licence ? `<span class="verified verified-solid">${ICON.shield}Verified</span>` : ''}
            ${specialty ? `<span class="tag tag-blue">${esc(specialtyLabel(specialty))}</span>` : ''}
          </div>
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
                f.record?.type ? facilityTypeLabel(f.record.type) : 'Facility',
                (f.record
                  ? `<a class="link-brand" href="${facilityHref(f.record)}">${esc(f.name)}</a>`
                  : esc(f.name))
                + (f.record ? ` <span class="dim">· ${num(f.record.doctorCount)} linked</span>` : ''),
              )).join('')}
            </dl>`
          : '')}

        ${block('Licensing information', licence
          ? `<dl class="factlist">
              ${field(licences.length > 1 ? 'Licence types' : 'Licence type',
                // The readable label only. The register's own value is still what
                // the licence facet filters on; repeating it here said the same
                // thing twice ("Registered only (Registered Only)").
                licences.map((l) => `<span class="tag tag-brand">${esc(LICENCE_LABEL[l] ?? l)}</span>`).join(' '))}
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
/**
 * One professional at a facility, as a card.
 *
 * Everything on it is a published field: the name, the registered specialty (or
 * the professional category when the register gives no specialty), the licence
 * types held, the languages spoken, and whether the person also practises
 * elsewhere. Fields the register does not publish are simply not there — the
 * card has no fixed slots to fill with placeholders.
 *
 * The whole card is the link. The name carries the href so it is a real,
 * copyable, keyboard-reachable anchor; a stretched ::after over the card makes
 * the rest of the surface clickable without nesting interactive elements.
 */
const personCard = (r, facilityIdx = -1) => {
  const name = r[R.NAME];
  // On a facility page the card states the role the register licenses this
  // person for HERE. Their other specialties are real but belong to their
  // other facilities, and printing one of those on this card would attribute
  // it to a facility the register never associated it with.
  const roleIdxs = facilityIdx >= 0 ? rowRolesAt(r, facilityIdx) : [];
  const spec = roleIdxs.length
    ? roleIdxs.map((i) => db.dict.specialty[i]).filter(Boolean).join(' · ')
    : (r[R.SPECIALTY] >= 0 ? db.dict.specialty[r[R.SPECIALTY]] : '');
  const cat = r[R.CATEGORY] >= 0 ? db.dict.category[r[R.CATEGORY]] : '';
  const role = spec
    ? spec.split(' · ').map((s) => specialtyLabel(s)).join(' · ')
    : cat;
  const langs = rowLanguages(r);
  const elsewhere = Math.max(0, rowFacilityIdxs(r).length - 1);

  const meta = [];
  if (spec && cat && cat !== spec) meta.push(esc(cat));
  if (langs.length) {
    meta.push(`${esc(langs.slice(0, 2).join(' · '))}${langs.length > 2 ? ` +${langs.length - 2}` : ''}`);
  }
  if (elsewhere) {
    meta.push(`Also at ${elsewhere} other ${elsewhere === 1 ? 'facility' : 'facilities'}`);
  }

  return `<li class="pcard">
    <span class="pcard-avatar" aria-hidden="true">${esc(initials(name))}</span>
    <span class="pcard-body">
      <a class="pcard-name" href="${doctorHref(r[R.ID])}">${esc(name)}</a>
      ${role ? `<span class="pcard-role" title="${esc(role)}">${esc(role)}</span>` : ''}
      ${meta.length
        // Each fact is its own element and the separator is drawn by CSS on the
        // item that FOLLOWS it, so a wrap can never strand a "·" at the end of
        // a line the way a joined-in separator does.
        ? `<span class="pcard-meta">${meta.map((m) => `<span>${m}</span>`).join('')}</span>`
        : ''}
    </span>
    <span class="pcard-go" aria-hidden="true">${ICON.chevron}</span>
  </li>`;
};

/**
 * Every distinct specialty practised by the professionals REGISTERED at this
 * facility — the same population the headline count describes, so the chips and
 * the number can never describe different groups of people.
 *
 * No counts and no frequency ordering: this answers "what is practised here",
 * not "what is practised most". Sorted alphabetically so the list is stable.
 */
function facilityRegisteredSpecialties(facilityId) {
  const fi = db.facilities.findIndex((f) => f.id === facilityId);
  if (fi < 0) return [];
  const seen = new Set();
  for (let i = 0; i < db.rows.length; i++) {
    const r = db.rows[i];
    // The chips describe the population currently listed below them, so they
    // follow the scope. Otherwise switching to "All linked" would show people
    // whose specialty has no chip, and a chip could describe nobody on screen.
    // A facility's people are those the register places here NOW: an active
    // licence covering this facility that the register also names directly.
    // Not the all-linked union, not the primary registration, and not every
    // facility a group licence happens to cover.
    const inScope = rowIsLicensedAt(r, fi);
    if (!inScope) continue;
    // The role held AT THIS FACILITY, not the professional's own specialty:
    // the register licenses per facility and prints a title on each licence.
    for (const si of rowRolesAt(r, fi)) {
      const label = db.dict.specialty[si];
      if (label) seen.add(label);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Specialty chips revealed initially, and per "Load more" click. */
const SPEC_FIRST = 5;
const SPEC_STEP = 10;
/** How many chips are currently revealed. Reset when a facility is opened. */
let specShown = SPEC_FIRST;

/**
 * The specialty chips.
 *
 * Every chip is a real filter over this facility's people, not a decoration:
 * clicking one narrows the list below to professionals who are BOTH in the
 * current population (registered or all-linked) AND hold that specialty.
 * Clicking the selected chip again clears it.
 */
function specialtyChips(labels) {
  // The SELECTED specialty is always rendered, pinned first. Without this a
  // choice that sits beyond the revealed window — restored from ?fspec= on
  // load, or chosen then collapsed — would filter the list while being
  // invisible and impossible to clear. Same convention the filter rail uses.
  const picked = state.facilitySpecialty;
  const rest = picked ? labels.filter((l) => l !== picked) : labels;
  const ordered = picked && labels.includes(picked) ? [picked, ...rest] : labels;
  const shown = ordered.slice(0, specShown);
  const remaining = ordered.length - shown.length;
  return `<div class="fac-specs fac-specs-all" data-spec-chips>
      ${shown.map((label) => {
        const on = state.facilitySpecialty === label;
        return `<button class="tag tag-brand spec-chip${on ? ' is-on' : ''}" type="button"
                data-spec-pick="${esc(label)}" aria-pressed="${on}">${esc(specialtyLabel(label))}</button>`;
      }).join('')}
    </div>
    ${remaining > 0
      // No button once everything is shown — not a disabled one.
      ? `<button class="btn btn-outline btn-sm spec-more" type="button" data-spec-more>
           Load more<span class="spec-more-n">${num(remaining)} left</span>
         </button>`
      : ''}`;
}

/** Professionals shown per page on a facility detail page. */
const PEOPLE_PER_PAGE = 24;

/**
 * Every professional the register links to this facility, honouring the
 * in-page search box. Returns row indices only — the page renders one slice.
 *
 * The facility constraint is applied here and nowhere else, so it can never be
 * lost by paging or searching: both operate on this already-scoped list.
 */
function facilityPeopleIdx(facilityId) {
  const fi = db.facilities.findIndex((f) => f.id === facilityId);
  if (fi < 0) return { fi: -1, idx: [] };
  const q = facilityQuery;
  const idx = [];
  for (let i = 0; i < db.rows.length; i++) {
    const r = db.rows[i];
    // 'registered' = the register's own primary facility for this person, which
    // is the figure DHA publishes. 'linked' = every current relationship. Both
    // are real; the scope decides which the list is showing, and the heading
    // above it says which.
    // A facility's people are those the register places here NOW: an active
    // licence covering this facility that the register also names directly.
    // Not the all-linked union, not the primary registration, and not every
    // facility a group licence happens to cover.
    const inScope = rowIsLicensedAt(r, fi);
    if (!inScope) continue;
    // The specialty chip is a real filter over the SAME scoped population, so
    // facility + specialty + name search compose as an intersection.
    // Matched against the role held AT THIS FACILITY. Filtering on the
    // professional-level specialty would return someone licensed here under a
    // different title purely because they hold that specialty somewhere else.
    if (state.facilitySpecialty && !rowHasRoleAt(r, fi, state.facilitySpecialty)) continue;
    if (q && !db.foldedName[i].includes(q)) continue;
    idx.push(i);
  }
  return { fi, idx };
}

/** The current page's cards. Only this slice is ever rendered. */
function facilityPeopleRows(facilityId) {
  const { fi, idx } = facilityPeopleIdx(facilityId);
  if (!idx.length) {
    return `<li class="pcard-none">No professionals match ${facilityQuery ? 'that name' : 'this facility'} in the register.</li>`;
  }
  const pages = Math.max(1, Math.ceil(idx.length / PEOPLE_PER_PAGE));
  const page = Math.min(Math.max(1, state.facilityPage), pages);
  const start = (page - 1) * PEOPLE_PER_PAGE;
  // A slice, never the whole set: 3,249 professionals must not become 3,249
  // DOM nodes just to show 24 of them.
  return idx.slice(start, start + PEOPLE_PER_PAGE).map((i) => personCard(db.rows[i], fi)).join('');
}

/**
 * Page controls: Previous · 1 2 3 … N · Next.
 *
 * Window of pages around the current one so the control stays a fixed width
 * whether the facility has 3 pages or 136.
 */
function facilityPager(facilityId) {
  const { idx } = facilityPeopleIdx(facilityId);
  const total = idx.length;
  const pages = Math.max(1, Math.ceil(total / PEOPLE_PER_PAGE));
  if (pages <= 1) {
    return total
      ? `<p class="pager-note">${num(total)} ${total === 1 ? 'professional' : 'professionals'}</p>`
      : '';
  }
  const page = Math.min(Math.max(1, state.facilityPage), pages);
  const from = (page - 1) * PEOPLE_PER_PAGE + 1;
  const to = Math.min(page * PEOPLE_PER_PAGE, total);

  const nums = [];
  const push = (n) => nums.push(
    `<button class="pager-num${n === page ? ' is-current' : ''}" type="button"
             data-facility-page="${n}"${n === page ? ' aria-current="page"' : ''}
             aria-label="Page ${n}">${n}</button>`);
  const gap = () => nums.push('<span class="pager-gap" aria-hidden="true">…</span>');
  const window = 1;
  let last = 0;
  for (let n = 1; n <= pages; n++) {
    const near = Math.abs(n - page) <= window;
    if (n === 1 || n === pages || near) {
      if (last && n - last > 1) gap();
      push(n);
      last = n;
    }
  }

  return `<nav class="pager" aria-label="Professional list pages">
    <p class="pager-note">Showing <b>${num(from)}–${num(to)}</b> of <b>${num(total)}</b>${facilityQuery ? ' matching' : ''}</p>
    <div class="pager-controls">
      <button class="pager-step" type="button" data-facility-page="${page - 1}"
              ${page === 1 ? 'disabled' : ''} aria-label="Previous page">${ICON.back} Previous</button>
      <div class="pager-nums">${nums.join('')}</div>
      <button class="pager-step" type="button" data-facility-page="${page + 1}"
              ${page === pages ? 'disabled' : ''} aria-label="Next page">Next ${ICON.fwd}</button>
    </div>
  </nav>`;
}

function facilityView(id) {
  const f = db.facilities.find((x) => x.id === id);
  if (!f) return notFound('Facility not found', `No facility with id ${esc(id)} exists in this dataset.`);

  const type = facilityTypeLabel(f.type);
  const specs = facilityTopSpecialties(f);
  const licensed = facilityLicensedCount(f);
  const regSpecs = facilityRegisteredSpecialties(f.id);
  facilityQuery = '';
  specShown = SPEC_FIRST;

  // Where the type came from, said plainly. The register publishes none, so the
  // page names the evidence rather than implying an official field.
  const TYPE_PROVENANCE = {
    name: 'read from the registered facility name',
    dha_type: "from the register's own keyword classification",
    staff: 'inferred from the specialties of the professionals licensed here',
    unclassified: 'no classifying evidence in the record',
  };
  /** The compact form, for the fact cell, which is one column wide. */
  const TYPE_PROVENANCE_SHORT = {
    name: 'From the facility name',
    dha_type: 'From the register’s keyword read',
    staff: 'From the linked professionals',
    unclassified: 'No classifying evidence',
  };
  const provenance = TYPE_PROVENANCE[f.typeSource] ?? TYPE_PROVENANCE.name;
  const provenanceShort = TYPE_PROVENANCE_SHORT[f.typeSource] ?? TYPE_PROVENANCE_SHORT.name;

  const sub = [];
  // The hero states the same figure the cards and the people list use: the
  // facility's staff. A different number here would read as a contradiction.
  sub.push(`<b>${num(licensed)}</b> licensed ${licensed === 1 ? 'professional' : 'professionals'}`);

  return `
  <article class="detail" role="dialog" aria-modal="true" aria-label="${esc(f.name)}">
    ${crumbs('Facilities', 'facilities', f.name)}

    <header class="detail-hero">
      <div class="detail-ident">
        <div class="avatar facility detail-avatar" aria-hidden="true">${ICON.facility}</div>
        <div class="detail-headline">
          <div class="detail-badges">
            ${f.inDhaMasterList
              ? `<span class="verified verified-solid">${ICON.shield}Verified</span>`
              : '<span class="tag tag-amber">Not on the official facility list</span>'}
            ${type ? `<span class="tag tag-blue">${esc(type)}</span>` : ''}
          </div>
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
          ${field('Facility type', type ? `${esc(type)}<span class="dt-note">${esc(provenanceShort)}</span>` : '')}
          ${field('Professionals working here', `${num(licensed)}<span class="dt-note">Currently licensed to practise at this facility</span>`)}
          ${field('Facility ID', `<span class="mono">${esc(f.id)}</span>`)}
        </dl>`)}

        ${block('Specialties', regSpecs.length ? specialtyChips(regSpecs) : '')}

        <section class="detail-block people-block">
          <div class="people-head">
            <div class="people-title">
              <h2>Healthcare professionals at this facility</h2>
              <p class="people-sub"><b>${num(licensed)}</b> currently ${licensed === 1 ? 'works' : 'work'} here, as the register states it</p>
            </div>
            <label class="opt-search people-search">
              ${ICON.search}
              <input type="search" data-facility-search="${esc(f.id)}" placeholder="Search within this facility…" aria-label="Search professionals at this facility">
            </label>
          </div>
          <ul class="pcard-grid" data-facility-people="${esc(f.id)}">${facilityPeopleRows(f.id)}</ul>
          <div data-facility-pager>${facilityPager(f.id)}</div>
        </section>
      </div>

      <aside class="detail-aside">
        <div class="aside-card">
          <h3>Filter the directory</h3>
          <p>Narrow the whole directory to the ${num(f.doctorCount)} professionals linked to this facility, however they are linked.</p>
          <button class="btn btn-primary" type="button" data-facility-filter="${esc(f.name)}">Show these professionals</button>
        </div>
        <p class="aside-note">The register publishes no facility type, so this one is ${esc(provenance)}. Everything else on this page is a published field.</p>
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

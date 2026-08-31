/** Small shared helpers. No dependencies. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const nf = new Intl.NumberFormat('en-US');
export const num = (n) => nf.format(n ?? 0);

/** Escape text before it is placed into innerHTML. */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Lowercase + strip accents/punctuation — used for search and option filtering. */
export const fold = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Up to two initials for an avatar. */
export const initials = (name) => {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase();
};

/** Title-case a slug-ish or shouty string for display. */
export const titleCase = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());

export const debounce = (fn, wait = 160) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), wait);
  };
};

/**
 * Readable label for a classified facility type.
 *
 * The keys are produced by tools/facility-type.mjs and stored on every facility
 * record, so a card, a facet, a chip, a query parameter and a detail page all
 * name the same thing. This map is the FALLBACK: the dataset ships its own
 * `facilityTypeLabels`, installed by `setFacilityTypeLabels()` as soon as the
 * data lands, so a vocabulary added by a later export reads correctly without
 * a matching change here.
 *
 * There is deliberately no "Type not published" entry. Every facility in the
 * register is classified — from its name, from DHA's own keyword read, or from
 * the specialties of the professionals linked to it — so the absence of a type
 * is a bug to fix in the exporter, not a bucket to show a visitor.
 */
export const FACILITY_TYPE_LABEL = {
  hospital: 'Hospital',
  day_surgery: 'Day surgery centre',
  polyclinic: 'Polyclinic',
  medical_center: 'Medical centre',
  clinic: 'Clinic',
  diagnostic_center: 'Diagnostic centre',
  laboratory: 'Laboratory',
  pharmacy: 'Pharmacy',
  dental: 'Dental centre',
  optical: 'Optical centre',
  physiotherapy: 'Physiotherapy & rehabilitation',
  home_healthcare: 'Home healthcare',
  nursing: 'Nursing & care',
  mental_health: 'Mental health & behavioural',
  maternity: 'Maternity & fertility',
  aesthetic: 'Aesthetic & skin centre',
  alternative: 'Traditional & complementary medicine',
  wellness: 'Wellness centre',
  veterinary: 'Veterinary',
  education: 'School & nursery',
  fitness: 'Fitness & sports',
  occupational: 'Occupational & corporate health',
  medical_supplier: 'Medical supplies & equipment',
  center: 'Centre',
  other: 'Other healthcare provider',
};

/**
 * Install the vocabulary the loaded dataset shipped with. Called once, by the
 * data layer, before anything renders — so the UI can never disagree with the
 * classifier that produced the values it is showing.
 */
export function setFacilityTypeLabels(labels) {
  if (!labels || typeof labels !== 'object') return;
  for (const [key, label] of Object.entries(labels)) {
    if (typeof label === 'string' && label) FACILITY_TYPE_LABEL[key] = label;
  }
}

/** Label for one facility type key. Never returns an empty string. */
export const facilityTypeLabel = (key) =>
  (key && (FACILITY_TYPE_LABEL[key] ?? key)) || FACILITY_TYPE_LABEL.other;

/**
 * Icon for a facility type — keyed by the SAME stored `type` value as the label
 * map above, so there is exactly one facility-type vocabulary in the app and
 * nothing here can drift from the classifier.
 *
 * Plain inline SVG in the house style already used by render.js and detail.js:
 * a 20x20 box, no fill, `currentColor` stroke, so a tile decides the colour and
 * the size. No icon library, no new dependency.
 *
 * Decorative: every caller renders these inside an `aria-hidden` wrapper, and
 * the type is always also present as text.
 */
const S = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
const svg = (body) => `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">${body}</svg>`;

export const FACILITY_TYPE_ICON = {
  // buildings — distinguished by silhouette, not by decoration
  hospital: svg(`<path d="M3 17h14M5.5 17V6.4L10 4l4.5 2.4V17" ${S}/><path d="M8.3 9.6h3.4M10 7.9v3.4" ${S}/>`),
  polyclinic: svg(`<path d="M3 17h14M4.8 17V6.6h10.4V17" ${S}/><path d="M7.4 9.4h1.6M11 9.4h1.6M7.4 12.4h1.6M11 12.4h1.6" ${S}/>`),
  medical_center: svg(`<circle cx="10" cy="10" r="6.8" ${S}/><path d="M7.6 10h4.8M10 7.6v4.8" ${S}/>`),
  center: svg(`<circle cx="10" cy="10" r="3.1" ${S}/><path d="M10 2.8v2.1M10 15.1v2.1M2.8 10h2.1M15.1 10h2.1" ${S}/>`),

  // single-discipline places
  clinic: svg(`<path d="M5 3v4a3.2 3.2 0 0 0 6.4 0V3M8.2 10.1V12a4 4 0 0 0 8 0v-1.2" ${S}/><circle cx="16.2" cy="9" r="1.6" ${S}/>`),
  day_surgery: svg(`<path d="M3.4 14.2 12 5.6a2.6 2.6 0 0 1 3.7 3.7l-8.6 8.6H3.4z" ${S}/><path d="M11 6.8 13.6 9.4" ${S}/>`),
  pharmacy: svg(`<rect x="3.1" y="7.2" width="13.8" height="5.6" rx="2.8" transform="rotate(-45 10 10)" ${S}/><path d="M7.6 7.6 12.4 12.4" ${S}/>`),
  dental: svg(`<path d="M10 5.4c-1.7-1.5-5-1.1-5.6 1.4-.5 2.1.6 3.4.9 5.3.3 1.7.2 4.3 1.6 4.3s1.2-2.6 1.7-3.9c.3-.6 1.5-.6 1.8 0 .5 1.3.3 3.9 1.7 3.9s1.3-2.6 1.6-4.3c.3-1.9 1.4-3.2.9-5.3-.6-2.5-3.9-2.9-5.6-1.4z" ${S}/>`),
  laboratory: svg(`<path d="M8.3 3v4.6l-4 7.1A1.6 1.6 0 0 0 5.7 17h8.6a1.6 1.6 0 0 0 1.4-2.3l-4-7.1V3" ${S}/><path d="M7.2 3h5.6M6.2 12.4h7.6" ${S}/>`),
  diagnostic_center: svg(`<rect x="2.6" y="4.2" width="14.8" height="10" rx="1.8" ${S}/><path d="M5.4 9.4h2l1.3-2.4 1.8 4.6 1.3-2.2h2.8" ${S}/><path d="M7.6 17h4.8" ${S}/>`),
  optical: svg(`<circle cx="5.9" cy="11.2" r="2.9" ${S}/><circle cx="14.1" cy="11.2" r="2.9" ${S}/><path d="M8.8 10.8c.7-.5 1.7-.5 2.4 0M3 10.2 4.6 6.2M17 10.2 15.4 6.2" ${S}/>`),

  // care and therapy
  physiotherapy: svg(`<circle cx="12.3" cy="4.4" r="1.7" ${S}/><path d="M12.6 7.3 9.4 9.9l2.1 2.4-.7 4.6M12.6 7.3l3 2.1M9.4 9.9 5.5 9M11.5 12.3l-3.9 1.3" ${S}/>`),
  home_healthcare: svg(`<path d="M3.2 9.3 10 3.8l6.8 5.5V16a1.2 1.2 0 0 1-1.2 1.2H4.4A1.2 1.2 0 0 1 3.2 16z" ${S}/><path d="M10 14.5s-2.3-1.5-2.3-3a1.4 1.4 0 0 1 2.3-1 1.4 1.4 0 0 1 2.3 1c0 1.5-2.3 3-2.3 3z" ${S}/>`),
  nursing: svg(`<path d="M10 8.4s-2.1-1.3-2.1-2.7A1.3 1.3 0 0 1 10 4.8a1.3 1.3 0 0 1 2.1.9c0 1.4-2.1 2.7-2.1 2.7z" ${S}/><path d="M3.6 12.2c1.4-1 2.6-.6 3.7.2l1.6 1.2h2.3a1.1 1.1 0 0 1 0 2.2H9.1" ${S}/><path d="m10.6 15.8 4.2-1.4a1.2 1.2 0 0 1 1 2.1l-4.5 2.1" ${S}/>`),
  mental_health: svg(`<path d="M12.6 16.6V14c2.3-.7 3.8-2.7 3.8-5.1A6 6 0 0 0 4.6 7.3c-.2 1 .1 1.8.5 2.6.3.5-.1 1.1-.7 1.1H3.6" ${S}/><path d="M9.6 8.2a1.6 1.6 0 1 1 1.7 2.6" ${S}/>`),
  maternity: svg(`<circle cx="8.6" cy="4.3" r="1.8" ${S}/><path d="M8.6 7.2c-1.6 0-2.5 1.3-2.7 2.8l-.5 3.4h1.5l.5 4h3l.4-4" ${S}/><path d="M11.5 11.4a2.6 2.6 0 1 0 0-3.4" ${S}/>`),
  aesthetic: svg(`<path d="M13.6 3.6a7 7 0 1 0 2.6 7.7" ${S}/><path d="M8 9.4v.01M12.4 9.4v.01M8.4 12.8c.9.8 2.3.8 3.2 0" ${S}/><path d="m15.6 3 .7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z" ${S}/>`),
  alternative: svg(`<path d="M10 17c0-5.4 2.6-8.6 6.6-9.4C16.6 12.4 14.4 16 10 17z" ${S}/><path d="M10 17C10 11.6 7.4 8.4 3.4 7.6 3.4 12.4 5.6 16 10 17z" ${S}/><path d="M10 17v-3.4" ${S}/>`),
  wellness: svg(`<path d="M10 16.6c-3-1.6-4.6-3.6-4.6-5.6a4.6 4.6 0 0 1 4.6-4.4 4.6 4.6 0 0 1 4.6 4.4c0 2-1.6 4-4.6 5.6z" ${S}/><path d="M10 6.6c0-1.8.9-3 2.6-3.6-.2 1.9-1 3.1-2.6 3.6z" ${S}/>`),
  veterinary: svg(`<ellipse cx="10" cy="13.2" rx="3.4" ry="2.8" ${S}/><ellipse cx="5.3" cy="8.8" rx="1.6" ry="2" ${S}/><ellipse cx="14.7" cy="8.8" rx="1.6" ry="2" ${S}/><ellipse cx="8.4" cy="5.4" rx="1.5" ry="1.9" ${S}/><ellipse cx="12.4" cy="5.6" rx="1.4" ry="1.8" ${S}/>`),

  // places licensed for their staff rather than for treatment
  education: svg(`<path d="M10 4 2.8 7.4 10 10.8l7.2-3.4z" ${S}/><path d="M5.6 9v3.9c0 1.1 2 2.1 4.4 2.1s4.4-1 4.4-2.1V9" ${S}/><path d="M17.2 7.4v4.2" ${S}/>`),
  fitness: svg(`<path d="M3 8.2v3.6M17 8.2v3.6M5.4 6.6v6.8M14.6 6.6v6.8M5.4 10h9.2" ${S}/>`),
  occupational: svg(`<rect x="2.8" y="6.4" width="14.4" height="9.6" rx="1.7" ${S}/><path d="M7.4 6.4V5a1.2 1.2 0 0 1 1.2-1.2h2.8A1.2 1.2 0 0 1 12.6 5v1.4" ${S}/><path d="M8.6 11.2h2.8M10 9.8v2.8" ${S}/>`),
  medical_supplier: svg(`<rect x="2.6" y="5.6" width="14.8" height="10.4" rx="1.8" ${S}/><path d="M2.6 9.4h14.8" ${S}/><path d="M8.2 4.6V3.4h3.6v1.2" ${S}/><path d="M8.6 12.7h2.8M10 11.3v2.8" ${S}/>`),

  // the residual bucket — a plain healthcare mark, distinct from every
  // classified type so an unclassified facility is never mistaken for one
  other: svg(`<path d="M10 2.8 4.2 5.2v4.6c0 3.5 2.4 6.7 5.8 7.9 3.4-1.2 5.8-4.4 5.8-7.9V5.2z" ${S}/><path d="M8 9.6h4M10 7.6v4" ${S}/>`),
};

/**
 * Icon markup for a facility type. Falls back to the residual mark so a type
 * added by a later export still renders something sensible.
 */
export const facilityTypeIcon = (key) =>
  FACILITY_TYPE_ICON[key] ?? FACILITY_TYPE_ICON.other;

/**
 * Display-only gloss for specialties the public knows by a plainer name.
 *
 *   ...Otolaryngology...          reads as "... - ENT"
 *   ...Ophthalmology...           reads as "... - Eye"
 *   ...Orthopedic/Orthopaedic...  reads as "... - Bone/Joint"
 *
 * The rules are SUBSTRING rules, so they hold wherever the term sits in the
 * stored wording and whatever title, grade or qualifier surrounds it.
 *
 * The register's own wording is kept verbatim and the gloss is appended, so the
 * stored value is still the thing on screen — nothing is renamed, merged or
 * invented. This is a LABEL map: it never touches the dictionary, the facets,
 * the filter state or any query. `Specialist Otolaryngology` is still the value
 * that gets filtered on; it just reads as `Specialist Otolaryngology - ENT`.
 */
const SPECIALTY_GLOSS = [
  { match: 'otolaryngology', gloss: 'ENT' },
  { match: 'ophthalmology', gloss: 'Eye' },
  // Both spellings the register uses. Deliberately NOT the shorter 'orthop',
  // which would also catch Orthoptist (an eye specialty); and nothing here
  // touches Orthodontics (dental) or Orthotics (devices), which merely share
  // the ortho- prefix.
  { match: 'orthopedic', gloss: 'Bone/Joint' },
  { match: 'orthopaedic', gloss: 'Bone/Joint' },
];

export const specialtyLabel = (label) => {
  if (!label) return label;
  const lower = label.toLowerCase();
  for (const { match, gloss } of SPECIALTY_GLOSS) {
    if (!lower.includes(match)) continue;
    // Idempotent: a label that already carries the gloss is returned as-is, so
    // a value passed through here twice cannot come out as "- ENT - ENT".
    return label.includes(` - ${gloss}`) ? label : `${label} - ${gloss}`;
  }
  return label;
};

/** Full licence-type names (register licence codes). */
export const LICENCE_LABEL = {
  // The search DTO's compact codes (schema v2 and earlier).
  FTL: 'Full-time licence',
  PTL: 'Part-time licence',
  REG: 'Registered only',
  TRL: 'Trainee licence',
  // The register's own filter vocabulary, which is what DoctorLicenceType
  // stores and therefore what schema v3 exports. Both forms are mapped so a
  // directory on either schema reads correctly.
  'Full-time License': 'Full-time licence',
  'Part-time License': 'Part-time licence',
  'Registered Only': 'Registered only',
  'Trainee License': 'Trainee licence',
};

/**
 * The compact form, for places with room for a badge and not a sentence.
 *
 * A professional can now carry several licence badges on one card, so the long
 * vocabulary would wrap the card. The full wording stays in the `title` and on
 * the detail page.
 */
export const LICENCE_SHORT = {
  'Full-time License': 'FTL',
  'Part-time License': 'PTL',
  'Registered Only': 'REG',
  'Trainee License': 'TRL',
};

/** Badge text for a licence value, whichever vocabulary it came from. */
export const licenceBadge = (v) => LICENCE_SHORT[v] ?? v;

export const scrollToEl = (el) => {
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - 84;
  window.scrollTo({ top, behavior: 'smooth' });
};

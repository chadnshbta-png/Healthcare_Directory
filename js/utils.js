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

/** Readable label for a facility typeGuess. */
export const FACILITY_TYPE_LABEL = {
  hospital: 'Hospital',
  polyclinic: 'Polyclinic',
  clinic: 'Clinic',
  medical_center: 'Medical centre',
  center: 'Centre',
  pharmacy: 'Pharmacy',
  dental: 'Dental',
  laboratory: 'Laboratory',
  optical: 'Optical',
  // The register publishes NO facility type field — see the note on the
  // Facility type filter. This bucket is every facility whose name carried
  // no recognisable keyword, which is a gap in the source, not a category.
  other: 'Type not published',
};

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

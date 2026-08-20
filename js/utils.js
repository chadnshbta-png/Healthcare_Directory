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
  other: 'Other / unclassified',
};

/** Full licence-type names (DHA codes). */
export const LICENCE_LABEL = {
  FTL: 'Full-time licence',
  PTL: 'Part-time licence',
  REG: 'Registered only',
  TRL: 'Trainee licence',
};

export const scrollToEl = (el) => {
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - 84;
  window.scrollTo({ top, behavior: 'smooth' });
};

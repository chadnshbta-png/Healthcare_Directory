/**
 * Data layer — the ONLY module that knows where records come from.
 *
 * Swap `loadDirectory()` for API calls and nothing else in the app changes.
 * See README.md ▸ "Replacing local data with an API" for the expected shapes.
 */
import { fold, setFacilityTypeLabels } from './utils.js';

/**
 * Data directory, resolved against THIS MODULE's location rather than the
 * document URL. That makes the package work no matter where it is mounted
 * (`/`, `/directory/`, `/a/b/c/`) and regardless of whether the URL carries a
 * trailing slash — the two ways a relative './data/' path silently 404s.
 */
const DATA_BASE = new URL('data/', new URL('.', import.meta.url).href.replace(/js\/$/, ''));
export const dataUrl = (file) => new URL(file, DATA_BASE).href;

/**
 * Row tuple positions, mirroring meta.json ▸ rowSchema.
 *
 * `FACILITY` holds EITHER a single dictionary index (schema v1, `facilityIdx`)
 * OR an array of them (schema v2, `facilityIdxs`) — a professional may hold
 * several concurrent facility relationships. Never read this slot directly;
 * use `rowFacilityIdxs()` so both shapes behave identically.
 */
export const R = {
  // LICENCE is an ARRAY of dictionary indices (schema v3): the register lets
  // one professional hold several licence types at once. FACILITY has been an
  // array since v2 for the same reason.
  //
  // PRIMARY (schema v4) is the register's OWN primary facility for this
  // professional — the `search_stage` relationship. FACILITY is the union of
  // every current relationship and stays exactly as it was; PRIMARY is the
  // narrower view that DHA's facility filter counts.
  // ROLES (schema v5) is the role held AT a given facility, stored sparsely as
  // [[facilityIdx, specialtyIdx, ...], ...]. A licence is issued per facility
  // and the register prints its own title on each, so the same person can be a
  // Consultant at one hospital and a Specialist at another. SPECIALTY (slot 3)
  // remains the professional-level value the register's own specialty filter
  // uses; ROLES only overrides it where the register says something different
  // at a particular facility. Read it through `rowRolesAt()`.
  // LICENSED (schema v6) is where the professional holds an ACTIVE current
  // licence. That — not FACILITY, and not PRIMARY — is a facility's staff:
  // FACILITY is the union of every current relationship (a job, a primary
  // registration, a licence), and PRIMARY is the single registration the
  // register's search stage names. Being employed somewhere, or registered
  // elsewhere, is not a licence to practise here.
  ID: 0, NAME: 1, CATEGORY: 2, SPECIALTY: 3, LICENCE: 4, NATIONALITY: 5, FACILITY: 6, LANGUAGES: 7, FLAGS: 8,
  PAST: 9, PRIMARY: 10, ROLES: 11, LICENSED: 12,
};

/**
 * The facility dictionary indices the register lists as this professional's
 * PRIMARY registration. Empty on a pre-v4 dataset, so an older data/ directory
 * degrades to "no primary information" rather than breaking.
 */
export function rowPrimaryFacilityIdxs(r) {
  const v = r[R.PRIMARY];
  if (typeof v === 'number') return v >= 0 ? [v] : [];
  if (!Array.isArray(v) || v.length === 0) return [];
  const out = [];
  for (const idx of v) if (idx >= 0 && !out.includes(idx)) out.push(idx);
  return out;
}

/**
 * The facilities where this professional holds an ACTIVE current licence —
 * the facilities whose staff list they belong on.
 *
 * On a pre-v6 dataset the slot is absent. Rather than silently showing an
 * empty facility, the reader falls back to the all-linked set, which is what
 * the directory listed before this distinction existed.
 */
export function rowLicensedFacilityIdxs(r) {
  const v = r[R.LICENSED];
  if (v === undefined) return rowFacilityIdxs(r);
  if (typeof v === 'number') return v >= 0 ? [v] : [];
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const idx of v) if (idx >= 0 && !out.includes(idx)) out.push(idx);
  return out;
}

/** True when an ACTIVE current licence places this professional at that facility. */
export function rowIsLicensedAt(r, facilityIdx) {
  const v = r[R.LICENSED];
  if (v === undefined) return rowFacilityIdxs(r).includes(facilityIdx);
  if (typeof v === 'number') return v === facilityIdx;
  if (!Array.isArray(v)) return false;
  for (let k = 0; k < v.length; k++) if (v[k] === facilityIdx) return true;
  return false;
}

/**
 * How many professionals a facility's staff list holds: those with an active
 * current licence there. Falls back to the all-linked count on a pre-v6
 * dataset so nothing renders blank.
 */
export const facilityLicensedCount = (f) =>
  (f && typeof f.licensedCount === 'number') ? f.licensedCount : (f?.doctorCount ?? 0);

/**
 * The specialty dictionary indices this professional is licensed under AT a
 * particular facility.
 *
 * The register issues a licence per facility and prints its role on each, so
 * "which specialties does this facility have" and "does this person practise
 * specialty X here" are questions about the LICENCE, not about the person.
 * Slot 11 carries an override only where the facility's licence titles differ
 * from the professional-level specialty; everywhere else — and on any pre-v5
 * dataset — the professional-level value is what the register states, so it is
 * returned unchanged.
 */
export function rowRolesAt(r, facilityIdx) {
  const roles = r[R.ROLES];
  if (Array.isArray(roles)) {
    for (let k = 0; k < roles.length; k++) {
      const entry = roles[k];
      if (entry && entry[0] === facilityIdx) {
        const out = [];
        for (let j = 1; j < entry.length; j++) if (entry[j] >= 0) out.push(entry[j]);
        if (out.length) return out;
      }
    }
  }
  const si = r[R.SPECIALTY];
  return si >= 0 ? [si] : [];
}

/** True when the register licenses this professional for `label` at that facility. */
export function rowHasRoleAt(r, facilityIdx, label) {
  const idxs = rowRolesAt(r, facilityIdx);
  for (let k = 0; k < idxs.length; k++) {
    if (db.dict.specialty[idxs[k]] === label) return true;
  }
  return false;
}

/** True when this professional is PRIMARILY registered at that facility index. */
export function rowIsPrimaryAt(r, facilityIdx) {
  const v = r[R.PRIMARY];
  if (typeof v === 'number') return v === facilityIdx;
  if (!Array.isArray(v)) return false;
  for (let k = 0; k < v.length; k++) if (v[k] === facilityIdx) return true;
  return false;
}

/**
 * The DHA-aligned headline figure for a facility: professionals whose PRIMARY
 * registered facility is this one. Falls back to the all-linked count on a
 * pre-v4 dataset so nothing renders blank.
 */
export const facilityPrimaryCount = (f) =>
  (f && typeof f.primaryCount === 'number') ? f.primaryCount : (f?.doctorCount ?? 0);

/**
 * Every facility dictionary index for a row, as an array, in published order.
 *
 * Accepts both row schemas, drops the -1 "no facility" sentinel, and removes
 * duplicates so the same facility can never be listed twice.
 */
export function rowFacilityIdxs(r) {
  const v = r[R.FACILITY];
  if (typeof v === 'number') return v >= 0 ? [v] : [];
  if (!Array.isArray(v) || v.length === 0) return [];
  const out = [];
  for (const idx of v) if (idx >= 0 && !out.includes(idx)) out.push(idx);
  return out;
}

/** How many facilities a row links to. Cheap; avoids allocating for the common cases. */
export function rowFacilityCount(r) {
  const v = r[R.FACILITY];
  if (typeof v === 'number') return v >= 0 ? 1 : 0;
  return Array.isArray(v) ? rowFacilityIdxs(r).length : 0;
}

/**
 * Visit each facility index of a row WITHOUT allocating.
 *
 * `rowFacilityIdxs` is the readable form, but it builds an array per call —
 * which costs 100k+ allocations in the load-time tallies and in facet counting.
 * This is the same logic for callers on a hot path. Duplicates are skipped.
 */
export function forEachFacilityIdx(r, fn) {
  const v = r[R.FACILITY];
  if (typeof v === 'number') {
    if (v >= 0) fn(v);
    return;
  }
  if (!Array.isArray(v)) return;
  for (let k = 0; k < v.length; k++) {
    const idx = v[k];
    if (idx < 0) continue;
    let dup = false;
    for (let j = 0; j < k; j++) if (v[j] === idx) { dup = true; break; }
    if (!dup) fn(idx);
  }
}

/** True when the row links to any facility whose index is in `set`. */
export function rowHasFacilityIn(r, set) {
  const v = r[R.FACILITY];
  if (typeof v === 'number') return v >= 0 && set.has(v);
  if (!Array.isArray(v)) return false;
  for (let k = 0; k < v.length; k++) if (v[k] >= 0 && set.has(v[k])) return true;
  return false;
}

/**
 * True when an ACTIVE current licence places the row at any facility in `set`.
 *
 * This is what "filter by facility" means: the professionals a facility would
 * list. `rowHasFacilityIn` answers the looser "has any current relationship
 * with", which would return people who merely worked there or are registered
 * elsewhere — a different question, and not the one a facility filter asks.
 */
export function rowLicensedIn(r, set) {
  const v = r[R.LICENSED];
  if (v === undefined) return rowHasFacilityIn(r, set); // pre-v6 dataset
  if (typeof v === 'number') return v >= 0 && set.has(v);
  if (!Array.isArray(v)) return false;
  for (let k = 0; k < v.length; k++) if (v[k] >= 0 && set.has(v[k])) return true;
  return false;
}

/** Bit flags stored in row[R.FLAGS]. */
export const FLAG = { MOBILE: 1, EMAIL: 2, LINKEDIN: 4, EXPERIENCE: 8, EDUCATION: 16 };

/** In-memory dataset shared by every other module. */
export const db = {
  meta: null,
  dict: null,
  facets: null,
  rows: [],
  facilities: [],
  /** foldedName[i] mirrors rows[i] — built once so search never re-folds. */
  foldedName: [],
  /** facilityIdx (dictionary position) -> facility record */
  facilityByDictIdx: new Map(),
  /** facility.id -> up to 3 { label, count } specialties, tallied from rows */
  facilitySpecialties: new Map(),
  /** rowFType[i] = facilityType index of rows[i]'s FIRST facility, or -1 */
  rowFType: null,
  /** rowIdx -> additional facilityType indices, only for multi-type rows */
  rowFTypeExtra: new Map(),
  /** facility-type rollup: [{ i, type, label, facilities, doctors }] */
  facilityTypes: [],
  ready: false,
};

/** Thrown with the exact URL that failed, so diagnostics can name the file. */
export class DataLoadError extends Error {
  constructor(file, url, detail) {
    super(`Failed to load data/${file}`);
    this.name = 'DataLoadError';
    this.file = `data/${file}`;
    this.url = url;
    this.detail = detail;
  }
}

/**
 * Cache strategy.
 *
 * `force-cache` (the previous setting) pinned the first response forever: a
 * regenerated data file was never picked up, so the app silently ran on stale
 * data — the root cause of the intermittent "could not be loaded" / "no results"
 * reports. Plain `no-store` fixes staleness but re-downloads 7.6 MB on every
 * visit, which is just as bad.
 *
 * So: meta.json is always revalidated (it is tiny), and the three large files
 * are requested with a `?v=<meta.generatedAt>` token. A new dataset produces a
 * new URL and downloads fresh; an unchanged dataset is served straight from
 * cache. Fresh AND fast.
 */
let dataVersion = '';

const fetchJson = async (file, onProgress, cacheMode = 'default') => {
  const url = dataVersion ? `${dataUrl(file)}?v=${encodeURIComponent(dataVersion)}` : dataUrl(file);
  onProgress?.(0);
  let res;
  try {
    res = await fetch(url, { cache: cacheMode });
  } catch (networkErr) {
    throw new DataLoadError(file, url, `Network request failed — ${networkErr.message}`);
  }
  if (!res.ok) {
    throw new DataLoadError(file, url, `Server responded ${res.status} ${res.statusText}`);
  }
  // Native parsing, deliberately. An earlier version read `res.body` chunk by
  // chunk to drive a byte-level progress bar; that hand-rolled reader could
  // stall after the last chunk and leave the app pinned on "Loading…" with no
  // error to show for it. `res.json()` decodes and parses the 5 MB payload in
  // about 10 ms, so the progress bar was buying nothing and costing reliability.
  let json;
  try {
    json = await res.json();
  } catch (parseErr) {
    throw new DataLoadError(file, url, `File is not valid JSON — ${parseErr.message}`);
  }
  onProgress?.(1);
  return json;
};

/**
 * Load everything the directory needs.
 * `onStage(stage, ratio)` reports progress so the UI can stay honest.
 */
export async function loadDirectory(onStage = () => {}) {
  if (location.protocol === 'file:') {
    const err = new DataLoadError('meta.json', dataUrl('meta.json'),
      'The page was opened directly from disk (file://). Browsers block both ES modules and data ' +
      'requests on file:// for security. Serve the folder over http instead.');
    err.isFileProtocol = true;
    throw err;
  }

  onStage('meta', 0);
  // Always revalidated, and it carries the version token for everything else.
  const meta = await fetchJson('meta.json', null, 'no-cache');
  db.meta = meta;
  dataVersion = String(meta.generatedAt ?? meta.version ?? '');
  // The dataset names its own facility types. Installed before anything renders
  // so the UI reads the classifier's vocabulary rather than a stale copy of it.
  setFacilityTypeLabels(meta.facilityTypeLabels);

  const facets = await fetchJson('facets.json');
  db.dict = facets.dict;
  db.facets = facets.facets;
  onStage('facets', 1);

  const [facilities, doctors] = await Promise.all([
    fetchJson('facilities.json'),
    fetchJson('doctors.json', (r) => onStage('doctors', r)),
  ]);

  db.facilities = facilities.facilities;
  // facilities.json v2 ships the vocabulary too, so a directory served with an
  // older meta.json still names its types correctly.
  setFacilityTypeLabels(facilities.facilityTypeLabels);
  db.rows = doctors.rows;

  // Precompute the search haystack once (name only; other fields resolve via dictionaries).
  db.foldedName = new Array(db.rows.length);
  for (let i = 0; i < db.rows.length; i++) db.foldedName[i] = fold(db.rows[i][R.NAME]);

  // Facilities are exported in the same order they were interned, so dictionary
  // index i maps to facilities[i] for every facility that exists as a row.
  db.facilityByDictIdx = new Map();
  for (let i = 0; i < db.facilities.length; i++) db.facilityByDictIdx.set(i, db.facilities[i]);

  // Which specialties a facility actually practises is not a stored field, so
  // tally it from the professionals linked to it. One pass over 102k rows,
  // derived entirely from real records — nothing here is guessed.
  const perFacility = new Map();
  for (let i = 0; i < db.rows.length; i++) {
    const r = db.rows[i];
    const si = r[R.SPECIALTY];
    if (si < 0) continue;
    // A professional linked to several facilities counts toward each of them.
    forEachFacilityIdx(r, (fi) => {
      let tally = perFacility.get(fi);
      if (!tally) perFacility.set(fi, (tally = new Map()));
      tally.set(si, (tally.get(si) ?? 0) + 1);
    });
  }
  db.facilitySpecialties = new Map();
  for (const [fi, tally] of perFacility) {
    const facility = db.facilityByDictIdx.get(fi);
    if (!facility) continue;
    const top = [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([si, count]) => ({ label: db.dict.specialty[si], count }))
      .filter((x) => x.label);
    if (top.length) db.facilitySpecialties.set(facility.id, top);
  }

  buildFacilityTypes();

  db.ready = true;
  onStage('done', 1);
  return db;
}

/**
 * Facility type is a real field on each facility record, but professionals only
 * reference a facility — not its type. Promote it to a first-class facet by
 * interning the types into their own dictionary and stamping each row with the
 * type of the facility it is linked to. After this it behaves exactly like the
 * other integer-indexed facets, so filtering and counting on it cost the same.
 */
function buildFacilityTypes() {
  const order = [];
  const indexOfType = new Map();
  const facilityCount = [];
  for (const f of db.facilities) {
    const t = f.type || 'other';
    if (!indexOfType.has(t)) {
      indexOfType.set(t, order.length);
      order.push(t);
      facilityCount.push(0);
    }
    facilityCount[indexOfType.get(t)] += 1;
  }

  // dictionary index per facility, then per row
  const typeOfFacilityIdx = new Int16Array(db.facilities.length);
  for (let i = 0; i < db.facilities.length; i++) {
    typeOfFacilityIdx[i] = indexOfType.get(db.facilities[i].type || 'other');
  }

  // Fast path: one Int16 per row for its FIRST facility's type, which is all
  // the overwhelming majority of rows need. Rows linked to facilities of
  // several DIFFERENT types keep the remainder in a side map, so the hot filter
  // loop stays a single typed-array read and only rare rows cost more.
  const rowFType = new Int16Array(db.rows.length);
  const rowFTypeExtra = new Map();
  const doctorCount = new Array(order.length).fill(0);
  for (let i = 0; i < db.rows.length; i++) {
    let primary = -1;
    let extra = null;
    forEachFacilityIdx(db.rows[i], (fi) => {
      if (fi >= typeOfFacilityIdx.length) return;
      const ti = typeOfFacilityIdx[fi];
      if (primary === -1) primary = ti;
      else if (ti !== primary) {
        if (!extra) extra = [];
        if (!extra.includes(ti)) extra.push(ti);
      }
    });
    rowFType[i] = primary;
    if (extra) rowFTypeExtra.set(i, extra);
    // A doctor counts once per distinct type they practise under.
    if (primary >= 0) doctorCount[primary] += 1;
    if (extra) for (const ti of extra) doctorCount[ti] += 1;
  }

  db.rowFType = rowFType;
  db.rowFTypeExtra = rowFTypeExtra;
  db.typeOfFacilityIdx = typeOfFacilityIdx;
  db.dict.facilityType = order;
  db.facets.facilityType = order.map((t, i) => ({ i, label: t, count: doctorCount[i] }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);
  db.facilityTypes = order.map((t, i) => ({
    i, type: t, facilities: facilityCount[i], doctors: doctorCount[i],
  })).sort((a, b) => b.doctors - a.doctors);
}

/* ── row accessors (keep tuple indices out of the rest of the app) ── */
export const rowId = (r) => r[R.ID];
export const rowName = (r) => r[R.NAME];
export const rowCategory = (r) => (r[R.CATEGORY] >= 0 ? db.dict.category[r[R.CATEGORY]] : '');
export const rowSpecialty = (r) => (r[R.SPECIALTY] >= 0 ? db.dict.specialty[r[R.SPECIALTY]] : '');
/**
 * EVERY licence type this professional holds.
 *
 * Tolerates the v2 scalar so a directory still holding an older doctors.json
 * keeps working: a number becomes a one-element list, -1 becomes empty.
 */
export function rowLicenceIdxs(r) {
  const v = r[R.LICENCE];
  if (typeof v === 'number') return v >= 0 ? [v] : [];
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const i of v) if (i >= 0 && !out.includes(i)) out.push(i);
  return out;
}

export const rowLicences = (r) =>
  rowLicenceIdxs(r).map((i) => db.dict.licenseType[i]).filter(Boolean);

/** The first licence type, for places with room for exactly one badge. */
export const rowLicence = (r) => rowLicences(r)[0] ?? '';
export const rowNationality = (r) => (r[R.NATIONALITY] >= 0 ? db.dict.nationality[r[R.NATIONALITY]] : '');
/** Name of the row's FIRST facility (compact contexts such as result cards). */
export const rowFacilityName = (r) => {
  const [first] = rowFacilityIdxs(r);
  return first === undefined ? '' : db.dict.facility[first] ?? '';
};

/** The row's FIRST facility record, or null. */
export const rowFacility = (r) => {
  const [first] = rowFacilityIdxs(r);
  return first === undefined ? null : db.facilityByDictIdx.get(first) ?? null;
};

/**
 * EVERY facility a row links to, resolved to records.
 *
 * A facility present in the dictionary but absent from facilities.json (a name
 * seen on a professional that never became a facility row) still yields an
 * entry, with `record: null`, so the name is shown rather than silently lost.
 */
export const rowFacilities = (r) =>
  rowFacilityIdxs(r).map((idx) => ({
    idx,
    name: db.dict.facility[idx] ?? '',
    record: db.facilityByDictIdx.get(idx) ?? null,
  })).filter((f) => f.name !== '');
export const rowLanguages = (r) => (r[R.LANGUAGES] || []).map((i) => db.dict.language[i]).filter(Boolean);
export const rowHas = (r, flag) => (r[R.FLAGS] & flag) !== 0;

/** The facility-type key for a facility record ('other' when unclassified). */
/**
 * When Healthcare was last successfully synchronized with ScrapeFlow.
 *
 * Written by tools/publish.mjs AFTER a dataset has been validated and swapped
 * in, so its presence means "this data passed reconciliation", not merely
 * "a script ran". Absent on a directory published before atomic publishing
 * existed, which is why every caller treats it as optional.
 */
export async function loadSyncStatus() {
  try {
    const res = await fetch(dataUrl('sync-status.json'), { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export const facilityTypeKey = (facility) => (facility && facility.type) || 'other';

/** Top three specialties practised at a facility, derived from linked rows. */
export const facilityTopSpecialties = (facility) =>
  (facility && db.facilitySpecialties.get(facility.id)) || [];

/** DHA profile link, rebuilt from the id rather than stored per row. */
export const doctorSourceUrl = (id) =>
  `https://services.dha.gov.ae/sheryan/wps/portal/home/medical-directory/professional-details?dhaUniqueId=${encodeURIComponent(id)}`;

/** Future route for a doctor detail page (see README ▸ Routing). */
export const doctorHref = (id) => `#/doctor/${encodeURIComponent(id)}`;
export const facilityHref = (facility) => `#/facility/${encodeURIComponent(facility.id)}`;

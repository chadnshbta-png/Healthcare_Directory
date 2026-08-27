/**
 * Query engine — search + filter + sort + facet counts.
 *
 * Everything runs against the compact row tuples from data.js, so a full pass
 * over 102k professionals stays in the low milliseconds. No DOM here.
 */
import {
  db, R, FLAG, rowFacilityIdxs, rowFacilityCount, forEachFacilityIdx, rowHasFacilityIn,
  rowLicenceIdxs, facilityTypeKey,
} from './data.js';
import { state, MULTI } from './state.js';
import { fold } from './utils.js';

/** Toggles backed directly by a bit in row[R.FLAGS]. */
const TOGGLE_FLAG = {
  mobile: FLAG.MOBILE,
  email: FLAG.EMAIL,
  linkedin: FLAG.LINKEDIN,
  experience: FLAG.EXPERIENCE,
  education: FLAG.EDUCATION,
};
/** Toggles derived from row shape rather than a single flag bit. */
const TOGGLE_TEST = {
  facility: (row) => rowFacilityCount(row) > 0,
  languages: (row) => row[R.LANGUAGES].length > 0,
  contact: (row) => (row[R.FLAGS] & (FLAG.MOBILE | FLAG.EMAIL)) !== 0,
};

/** Build dictionary-index sets once per query, so the hot loop compares ints. */
function buildIndexSets() {
  const setOf = (dictName, labels) => {
    if (!labels.size) return null;
    const out = new Set();
    const dict = db.dict[dictName];
    for (let i = 0; i < dict.length; i++) if (labels.has(dict[i])) out.add(i);
    return out;
  };
  return {
    cat: setOf('category', state.categories),
    spec: setOf('specialty', state.specialties),
    fac: setOf('facility', state.facilities),
    ftype: setOf('facilityType', state.facilityTypes),
    lang: setOf('language', state.languages),
    nat: setOf('nationality', state.nationalities),
    lic: setOf('licenseType', state.licences),
  };
}

/** Search terms are ANDed; each term may match name, specialty, facility or id. */
function buildTerms(q) {
  const folded = fold(q);
  return folded ? folded.split(' ').filter(Boolean) : [];
}

/**
 * Resolve a term against the (small) dictionaries once per query. The row loop
 * then only does integer Set lookups, which is what keeps search interactive
 * across 100k+ rows.
 */
function buildTermMatchers(terms) {
  const idxSet = (folded) => (t) => {
    const s = new Set();
    for (let i = 0; i < folded.length; i++) if (folded[i].includes(t)) s.add(i);
    return s;
  };
  const specOf = idxSet(db.foldedSpecialty);
  const catOf = idxSet(db.foldedCategory);
  const facOf = idxSet(db.foldedFacility);
  return terms.map((t) => ({ t, spec: specOf(t), cat: catOf(t), fac: facOf(t) }));
}

function rowMatchesTerms(row, i, matchers, rawQ, idQuery) {
  if (!matchers.length) return true;
  // Licence / DHA id search: digits typed straight into the box.
  if (idQuery && String(row[R.ID]).includes(idQuery)) return true;

  const name = db.foldedName[i];
  for (let k = 0; k < matchers.length; k++) {
    const m = matchers[k];
    if (name.includes(m.t)) continue;
    if (row[R.SPECIALTY] >= 0 && m.spec.has(row[R.SPECIALTY])) continue;
    if (row[R.CATEGORY] >= 0 && m.cat.has(row[R.CATEGORY])) continue;
    if (m.fac.size && rowHasFacilityIn(row, m.fac)) continue;
    return false;
  }
  return true;
}

/** Fold the dictionaries once; cheap, and keeps the row loop allocation-free. */
export function primeSearchIndex() {
  db.foldedSpecialty = db.dict.specialty.map(fold);
  db.foldedCategory = db.dict.category.map(fold);
  db.foldedFacility = db.dict.facility.map(fold);
}

/**
 * Run the current query.
 * Returns matching row indices plus facet counts computed over the same pass.
 */
export function runQuery() {
  const sets = buildIndexSets();
  const terms = buildTerms(state.q);
  const matchers = buildTermMatchers(terms);
  const rawQ = state.q;
  const idQuery = /^\d{4,}$/.test(rawQ.trim()) ? rawQ.trim() : null;
  const toggleMask = [...state.toggles].reduce((m, t) => m | (TOGGLE_FLAG[t] ?? 0), 0);
  const toggleTests = [...state.toggles].map((t) => TOGGLE_TEST[t]).filter(Boolean);

  const rows = db.rows;
  const matches = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (sets.cat && !sets.cat.has(row[R.CATEGORY])) continue;
    if (sets.spec && !sets.spec.has(row[R.SPECIALTY])) continue;
    if (sets.fac && !rowHasFacilityIn(row, sets.fac)) continue;
    if (sets.ftype) {
      let hit = sets.ftype.has(db.rowFType[i]);
      if (!hit) {
        const extra = db.rowFTypeExtra.get(i);
        if (extra) for (const ti of extra) if (sets.ftype.has(ti)) { hit = true; break; }
      }
      if (!hit) continue;
    }
    if (sets.nat && !sets.nat.has(row[R.NATIONALITY])) continue;
    // A doctor matches a licence filter if ANY of their types is selected —
    // someone Full-time at one facility and Part-time at another belongs in
    // both facets, and must not be deduplicated into whichever came first.
    if (sets.lic) {
      const licIdxs = rowLicenceIdxs(row);
      let hit = false;
      for (const i of licIdxs) if (sets.lic.has(i)) { hit = true; break; }
      if (!hit) continue;
    }
    if (toggleMask && (row[R.FLAGS] & toggleMask) !== toggleMask) continue;
    if (toggleTests.length) {
      let pass = true;
      for (let k = 0; k < toggleTests.length; k++) if (!toggleTests[k](row)) { pass = false; break; }
      if (!pass) continue;
    }
    if (sets.lang) {
      const langs = row[R.LANGUAGES];
      let ok = false;
      for (let k = 0; k < langs.length; k++) if (sets.lang.has(langs[k])) { ok = true; break; }
      if (!ok) continue;
    }
    if (!rowMatchesTerms(row, i, matchers, rawQ, idQuery)) continue;
    matches.push(i);
  }
  return matches;
}

/**
 * Counts for one facet, computed with that facet's own selection ignored — so
 * ticking "Dermatology" doesn't zero out every other specialty in the list.
 *
 * `current` is the already-computed result set. When this facet has nothing
 * selected, ignoring its selection changes nothing, so those counts can be
 * tallied straight off `current` instead of paying for another full pass. With
 * the usual one or two active facets that turns six passes into one or two.
 */
export function facetCounts(facetKey, current) {
  let matches;
  if (current && state[MULTI[facetKey]].size === 0) {
    matches = current;
  } else {
    const saved = state[MULTI[facetKey]];
    state[MULTI[facetKey]] = new Set();
    matches = runQuery();
    state[MULTI[facetKey]] = saved;
  }

  const field = { cat: R.CATEGORY, spec: R.SPECIALTY, fac: R.FACILITY, nat: R.NATIONALITY, lic: R.LICENCE }[facetKey];
  const counts = new Map();
  const rows = db.rows;
  if (facetKey === 'ftype') {
    // Not a column on the row tuple — it lives in the parallel rowFType array,
    // plus a side map for rows spanning facilities of several types.
    for (const i of matches) {
      const v = db.rowFType[i];
      if (v >= 0) counts.set(v, (counts.get(v) ?? 0) + 1);
      const extra = db.rowFTypeExtra.get(i);
      if (extra) for (const ti of extra) counts.set(ti, (counts.get(ti) ?? 0) + 1);
    }
  } else if (facetKey === 'fac') {
    // A professional at several facilities counts toward each of them.
    for (const i of matches) {
      forEachFacilityIdx(rows[i], (fi) => counts.set(fi, (counts.get(fi) ?? 0) + 1));
    }
  } else if (facetKey === 'lang') {
    for (const i of matches) {
      for (const l of rows[i][R.LANGUAGES]) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
  } else if (facetKey === 'lic') {
    // A professional holding several licence types counts toward EACH bucket,
    // exactly as the register's own filter does. This is why the four buckets
    // legitimately sum to more than the number of professionals.
    for (const i of matches) {
      for (const li of rowLicenceIdxs(rows[i])) counts.set(li, (counts.get(li) ?? 0) + 1);
    }
  } else {
    for (const i of matches) {
      const v = rows[i][field];
      if (v >= 0) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Live counts for the four profile-data filters, from the current match set.
 *
 * Same "ignore my own selection" rule the facets use, but it needs no extra
 * passes. If a toggle is *not* active the current matches already exclude it,
 * so its count is simply how many of them satisfy it. If a toggle *is* active
 * then every current match satisfies it by definition, so removing it and
 * re-counting gives back the same number — the current total.
 */
export function toggleCounts(matches) {
  const rows = db.rows;
  const keys = Object.keys({ ...TOGGLE_FLAG, ...TOGGLE_TEST });
  const counts = new Map();
  const pending = [];

  for (const k of keys) {
    if (state.toggles.has(k)) counts.set(k, matches.length);
    else pending.push(k);
  }
  if (!pending.length) return counts;

  const tests = pending.map((k) => {
    const flag = TOGGLE_FLAG[k];
    return flag ? (row) => (row[R.FLAGS] & flag) !== 0 : TOGGLE_TEST[k];
  });
  const tally = new Array(pending.length).fill(0);
  for (let i = 0; i < matches.length; i++) {
    const row = rows[matches[i]];
    for (let k = 0; k < tests.length; k++) if (tests[k](row)) tally[k]++;
  }
  pending.forEach((k, k2) => counts.set(k, tally[k2]));
  return counts;
}

/** Sort matching row indices in place. */
export function sortMatches(matches, sort) {
  const rows = db.rows;
  // Compare the pre-folded names: plain string comparison is an order of
  // magnitude cheaper than localeCompare across 100k+ rows.
  const fn = db.foldedName;
  const byName = (a, b) => (fn[a] < fn[b] ? -1 : fn[a] > fn[b] ? 1 : 0);
  switch (sort) {
    case 'name-asc':
      return matches.sort(byName);
    case 'name-desc':
      return matches.sort((a, b) => byName(b, a));
    case 'specialty': {
      const fs = db.foldedSpecialty;
      const key = (i) => (rows[i][R.SPECIALTY] >= 0 ? fs[rows[i][R.SPECIALTY]] : '￿');
      return matches.sort((a, b) => {
        const ka = key(a), kb = key(b);
        return ka < kb ? -1 : ka > kb ? 1 : byName(a, b);
      });
    }
    case 'facility': {
      const ff = db.foldedFacility;
      // Sorted on the FIRST facility; a row with several has no single
      // position, and the published order is the meaningful one.
      const key = (i) => {
        const [first] = rowFacilityIdxs(rows[i]);
        return first === undefined ? '￿' : ff[first];
      };
      return matches.sort((a, b) => {
        const ka = key(a), kb = key(b);
        return ka < kb ? -1 : ka > kb ? 1 : byName(a, b);
      });
    }
    default: {
      // Relevance with no search term: rows are already exported name-ascending,
      // so leave them alone rather than paying for a full sort every keystroke.
      if (!state.q) return matches;
      {
        const t = fold(state.q);
        const score = (i) => {
          const n = db.foldedName[i];
          if (n.startsWith(t)) return 0;
          if (n.includes(t)) return 1;
          return 2;
        };
        return matches.sort((a, b) => score(a) - score(b) || byName(a, b));
      }
    }
  }
}

/** Facilities matching the current query (used by the Facilities view). */
export function facilityResults(matchedRowIdx) {
  const rows = db.rows;
  const filtered = matchedRowIdx.length !== rows.length;
  let list;

  if (!filtered) {
    list = db.facilities.filter((f) => f.doctorCount > 0);
  } else {
    // Only facilities represented by the matching professionals.
    const counts = new Map();
    for (const i of matchedRowIdx) {
      forEachFacilityIdx(rows[i], (fi) => counts.set(fi, (counts.get(fi) ?? 0) + 1));
    }
    list = [];
    for (const [fi, n] of counts) {
      const f = db.facilityByDictIdx.get(fi);
      if (f) list.push({ ...f, matchingDoctors: n });
    }
  }

  /**
   * Facility-type filtering, resolved against the FACILITY'S OWN stored type.
   *
   * The list above is built from the matching PROFESSIONALS, so it contains
   * every facility each of them is linked to. A professional licensed at both
   * a medical centre and a hospital therefore dragged that hospital into a
   * "Medical centre" result — the relationship is real, but the facility is
   * not a medical centre and listing it as one was misleading.
   *
   * In the default 'type' mode a facility survives only when its own classified
   * `type` is one of the selected values. 'linked' keeps the broad behaviour for
   * anyone who deliberately wants every placement of the matching professionals.
   *
   * Nothing is deleted: the doctor-facility links, the counts and the stored
   * types are untouched. This decides which of them the Facilities view shows.
   */
  if (state.facilityTypes.size && state.facilityMatch === 'type') {
    list = list.filter((f) => state.facilityTypes.has(facilityTypeKey(f)));
  }

  // A facility name search should still work when no professional matched.
  const terms = buildTerms(state.q);
  if (terms.length && !filtered) {
    list = list.filter((f) => {
      const n = fold(f.name);
      return terms.every((t) => n.includes(t));
    });
  }

  switch (state.sort) {
    case 'name-asc': return list.sort((a, b) => a.name.localeCompare(b.name));
    case 'name-desc': return list.sort((a, b) => b.name.localeCompare(a.name));
    default: return list.sort((a, b) => (b.matchingDoctors ?? b.doctorCount) - (a.matchingDoctors ?? a.doctorCount) || a.name.localeCompare(b.name));
  }
}

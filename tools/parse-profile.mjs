/**
 * Parsers for the two flattened profile sections the register publishes.
 *
 * `Doctor.experience` and `Doctor.education` are stored as ONE string each:
 * entries joined by " | ", and the fields inside an entry joined by " · ".
 * Neither column is structured, so the directory cannot render "Position",
 * "License" or "Graduated" from it without splitting it back apart.
 *
 * Everything here is READ-ONLY reshaping. No value is invented, corrected or
 * defaulted: a field that cannot be identified is left off the entry, and the
 * untouched original text is always carried along as `raw` so the UI can fall
 * back to showing exactly what the register published.
 *
 * Parts are classified by PATTERN, not by position, because the register omits
 * fields freely — plenty of entries carry a title and dates but no facility.
 */

const ENTRY_SPLIT = ' | ';
const PART_SPLIT = ' · ';

const LICENCE_RE = /^Licen[cs]e\s*:\s*(.+)$/i;
const GRADUATED_RE = /^Graduated\s+(\d{4})$/i;
/** "05 December 2025 - 05 December 2026", optionally "(8 Months)". */
const DATE_RANGE_RE =
  /^(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s*-\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4}|Present|Current)\s*(?:\(([^)]*)\))?$/i;
/** A trailing "(Present)" marks the placement the professional still holds. */
const PRESENT_RE = /\s*\((?:Present|Current)\)\s*$/i;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Split one flattened section into entries, stripping the "(Present)" marker
 * from whichever part carries it and reporting it once for the whole entry.
 */
function splitEntries(text) {
  return clean(text)
    .split(ENTRY_SPLIT)
    .map((e) => clean(e))
    .filter(Boolean)
    .map((entry) => {
      const isCurrent = PRESENT_RE.test(entry);
      const parts = entry
        .replace(PRESENT_RE, '')
        .split(PART_SPLIT)
        .map(clean)
        .filter(Boolean);
      return { raw: entry, parts, isCurrent };
    });
}

/**
 * Work history entries.
 *
 * Shape: { title?, facility?, place?, licenseNumber?, startDate?, endDate?,
 *          duration?, location?, isCurrent, raw }
 *
 * `place` is an unlabelled trailing value that could be either a facility or a
 * city — reported as-is so the UI can show it without asserting which.
 */
export function parseExperience(text) {
  if (!text) return [];
  return splitEntries(text).map(({ raw, parts, isCurrent }) => {
    const out = { raw, isCurrent };
    const leftovers = [];

    for (const part of parts) {
      const lic = LICENCE_RE.exec(part);
      if (lic) {
        out.licenseNumber = clean(lic[1]);
        continue;
      }
      const dates = DATE_RANGE_RE.exec(part);
      if (dates) {
        out.startDate = clean(dates[1]);
        out.endDate = clean(dates[2]);
        if (dates[3]) out.duration = clean(dates[3]);
        continue;
      }
      leftovers.push(part);
    }

    // The register always leads an entry with the role held. What follows is
    // positional and the register omits fields freely, so the remainder is only
    // labelled where the shape makes it unambiguous:
    //
    //   [role, place, ..., city]  three or more -> place is the facility
    //   [role, X] + a licence     a licence is issued against a facility, so X is one
    //   [role, X] and no licence  X could be either. It is reported as `place`
    //                             and the UI shows it WITHOUT calling it a
    //                             facility, rather than guessing (7,210 of
    //                             338,735 entries, 2.1%).
    if (leftovers.length > 0) out.title = leftovers[0];
    if (leftovers.length > 2) {
      out.facility = leftovers[1];
      out.location = leftovers[leftovers.length - 1];
      // Anything between the facility and the city is a value the register
      // added and this parser has no named slot for. Kept rather than dropped.
      const extra = leftovers.slice(2, -1);
      if (extra.length) out.extra = extra;
    } else if (leftovers.length === 2) {
      if (out.licenseNumber) out.facility = leftovers[1];
      else out.place = leftovers[1];
    }
    return out;
  });
}

/**
 * Words that identify a value as the place someone STUDIED rather than what
 * they studied. Used only to disambiguate a single unlabelled value.
 */
const INSTITUTION_RE =
  /\b(universit(y|e|ies|à|ä|é)|univ|college|colleges|institute|institutes|institut|school|schools|academy|faculty|hospital|board|council|society|royal college|department|directorate|centre|center|polytechnic|seminary|conservatory|escuela|escola|universidad|universidade|universita|universitas|universitat|universite)\b/i;

/**
 * Qualification vocabulary. Every one of these is a DEGREE, AWARD or LEVEL, so
 * a value that matches is what was earned, never where.
 *
 * The list is drawn from the register's own wording — the four-part entries
 * prove the shape, because there the qualification and the institution are in
 * separate slots and can be read off directly.
 */
const QUALIFICATION_RE =
  /^(?:.*\b)?(diploma|diplome|certificate|certification|certified|degree|bachelor|bachelors|master|masters|doctorate|doctoral|doctor of|fellowship|membership|residency|internship|licentiate|associate|higher secondary|pre[- ]?university|post[- ]?graduate|postgraduate|undergraduate|specialization|specialisation|m\.?b\.?b\.?s|b\.?d\.?s|m\.?d\.?s|m\.?d|m\.?sc|b\.?sc|m\.?s|b\.?s|b\.?a|m\.?a|m\.?ph|d\.?d\.?s|d\.?m\.?d|ph\.?d|pharm\.?d|b\.?pharm|m\.?pharm|d\.?n\.?b|f\.?r\.?c\.?[a-z]|m\.?r\.?c\.?[a-z]|d\.?c\.?h|b\.?p\.?t|m\.?p\.?t|dip)\b/i;

/**
 * Values the register uses to mean "nothing was supplied here". They are kept
 * verbatim rather than dropped — an explicit blank is a published value — but
 * they are never dressed up as an institution or a qualification.
 */
const PLACEHOLDER_RE = /^(?:-+|n\/?a|na|none|nil|not specified|not_specified|others?|unknown|\.+)$/i;

/**
 * Education LEVELS, matched against the whole value.
 *
 * Checked before the institution vocabulary because "Pre-University" (2,892
 * entries) contains the word "University" and would otherwise be read as the
 * name of a place. The whole-value anchor is what keeps "Higher Secondary
 * School", which IS a place, on the institution side.
 */
const LEVEL_RE =
  /^(?:pre[- ]?university|higher secondary|secondary|high school|intermediate|matriculation|primary|foundation)$/i;

/**
 * A status the register appends to the LAST value of an entry, e.g.
 * "Kochi (Verified by DataFlow)". It qualifies the record, not the city.
 */
const VERIFICATION_RE = /\s*\(([^)]*verified[^)]*)\)\s*$/i;

/**
 * "Country, City" — the shape the register uses for the location of a
 * qualification earned abroad, e.g. "United Arab Emirates (UAE), Dubai".
 * The country is ALWAYS on the left (audited: 123 distinct left-hand values
 * across 31,658 comma-bearing locations, every one of them a country).
 */
const COUNTRY_CITY_RE = /^([^,]+),\s*(.+)$/;

/**
 * Education entries.
 *
 * Shape: { qualification?, institution?, heading?, graduated?, location?,
 *          country?, verification?, extra?, raw }
 *
 * EVERY entry the register published is returned, in published order. Entries
 * are NOT de-duplicated: the register repeats a qualification once per licence
 * it supports, and an earlier version of this parser treated identical lines as
 * one record and dropped the rest. Whether two identical lines are one degree
 * recorded twice or two equivalent degrees is not something the flattened text
 * can answer, so the parser reports what is there and leaves the judgement to
 * the reader.
 *
 * Field assignment is by SHAPE, read off the register's own slot order
 * (heading = qualification, profileBlue = institution, profileGrey = graduation
 * year then place):
 *
 *   [qualification, institution, place]   three values -> all three known
 *   [X, place]                            X is decided by vocabulary: an
 *                                         institution word wins, otherwise the
 *                                         value is reported as the qualification,
 *                                         which is the slot the register leads with
 *   [place]                               a lone value, unless it names an institution
 *
 * Nothing is discarded: a value that fits no slot lands in `extra`.
 */
export function parseEducation(text) {
  if (!text) return [];
  return splitEntries(text).map(({ raw, parts }) => {
    const entry = { raw };
    const leftovers = [];

    for (const part of parts) {
      const grad = GRADUATED_RE.exec(part);
      if (grad) {
        entry.graduated = grad[1];
        continue;
      }
      leftovers.push(part);
    }

    /** Split the trailing value into place / country / verification note. */
    const takePlace = (value) => {
      let v = value;
      const verified = VERIFICATION_RE.exec(v);
      if (verified) {
        entry.verification = clean(verified[1]);
        v = clean(v.replace(VERIFICATION_RE, ''));
      }
      if (!v) return;
      const cc = COUNTRY_CITY_RE.exec(v);
      if (cc) {
        entry.country = clean(cc[1]);
        entry.location = clean(cc[2]);
      } else {
        entry.location = v;
      }
    };

    /**
     * What KIND of thing an unlabelled leading value is.
     *
     * Order matters and is measured, not assumed: of the 523 distinct values
     * that match both vocabularies, all but "Pre-University" are genuinely the
     * names of places ("Sudan Medical Specialization Board", "Board Of Higher
     * Secondary Examination"), so the institution vocabulary wins — with the
     * whole-value LEVEL check taking "Pre-University" back out first.
     */
    const classify = (value) => {
      if (PLACEHOLDER_RE.test(value)) return 'placeholder';
      if (LEVEL_RE.test(value)) return 'qualification';
      if (INSTITUTION_RE.test(value)) return 'institution';
      if (QUALIFICATION_RE.test(value)) return 'qualification';
      return 'unknown';
    };

    if (leftovers.length >= 3) {
      // The register filled every slot: heading, institution, place.
      entry.qualification = leftovers[0];
      entry.institution = leftovers[1];
      takePlace(leftovers[leftovers.length - 1]);
      // Anything between the institution and the place is a value the register
      // added and this parser has no slot for. Kept, never dropped.
      const extra = leftovers.slice(2, -1);
      if (extra.length) entry.extra = extra;
    } else if (leftovers.length === 2) {
      const kind = classify(leftovers[0]);
      // A value neither vocabulary recognises ("Nursing", "Ministry Of Health",
      // "-") is reported under `heading` — the register's own name for the slot
      // it came from — rather than being asserted to be a degree or a place.
      if (kind === 'institution') entry.institution = leftovers[0];
      else if (kind === 'qualification') entry.qualification = leftovers[0];
      else entry.heading = leftovers[0];
      takePlace(leftovers[1]);
    } else if (leftovers.length === 1) {
      // A lone value is the place unless it names an institution — the register
      // drops the heading far more often than it drops the city.
      if (classify(leftovers[0]) === 'institution') entry.institution = leftovers[0];
      else takePlace(leftovers[0]);
    }

    return entry;
  });
}

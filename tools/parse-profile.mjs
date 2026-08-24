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
    } else if (leftovers.length === 2) {
      if (out.licenseNumber) out.facility = leftovers[1];
      else out.place = leftovers[1];
    }
    return out;
  });
}

/**
 * Education entries.
 *
 * Shape: { institution?, graduated?, location?, raw }
 */
export function parseEducation(text) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  for (const { raw, parts } of splitEntries(text)) {
    // The register repeats a qualification once per licence it supports, so the
    // same line commonly appears two or three times. Identical lines are the
    // same record, not several degrees.
    if (seen.has(raw)) continue;
    seen.add(raw);

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
    if (leftovers.length > 0) entry.institution = leftovers[0];
    if (leftovers.length > 1) entry.location = leftovers[leftovers.length - 1];
    out.push(entry);
  }
  return out;
}

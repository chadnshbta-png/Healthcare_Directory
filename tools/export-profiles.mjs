#!/usr/bin/env node
/**
 * Doctorna Directory — profile detail exporter (OPTIONAL TOOL)
 * ------------------------------------------------------------
 * `data/doctors.json` deliberately carries only BOOLEAN flags for work history,
 * education and contact: at ~102k rows the values themselves are ~82 MB, which
 * has no business sitting in the payload every visitor downloads to see a list.
 *
 * This tool writes those values to a separate, SHARDED, lazily-fetched set of
 * files so a detail page can show them without the directory paying for them.
 *
 *   data/profiles/index.json   the shard rule + totals
 *   data/profiles/<NNN>.json   { "<dhaUniqueId>": <record>, ... }
 *
 * A profile lives in the shard named by the LAST THREE characters of its
 * dhaUniqueId. The rule is deliberately trivial — no hash to keep in sync
 * between this tool and the browser (see js/profile.js).
 *
 * This tool NEVER writes doctors.json, facilities.json, facets.json or
 * meta.json, and never opens the database for writing. The directory works with
 * data/profiles absent: the UI falls back to reporting availability only.
 *
 * Usage:
 *   node tools/export-profiles.mjs --db ../backend/prisma/dev.db [--out ./data/profiles]
 *
 * Record shape (keys kept short — this is the bulk of the payload):
 *   w  work history   [{ t title, f facility, x unlabelled place, n licence,
 *                      s start, e end, d duration, l location, o other parts,
 *                      c isCurrent }]
 *   l  live licences  [{ t title, f facility, n licence, s status }]
 *   e  education      [{ q qualification, i institution, h unlabelled heading,
 *                      g graduated, l location, y country, v verification note,
 *                      o other parts }]
 *   c  contact        { p phone, p2 second phone, m email, m2 second email,
 *                      i linkedIn, t twitter }
 * Absent fields are omitted, never emitted as null or "".
 *
 * EVERY entry of a repeated section is written. Nothing is de-duplicated,
 * truncated or collapsed: if the register publishes a qualification twice,
 * this file carries it twice, because the flattened source cannot tell a
 * duplicated record from two equivalent ones and the exporter must not decide.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseExperience, parseEducation } from './parse-profile.mjs';
import { lifecycle } from './lifecycle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

if (!args.db) {
  console.error('ERROR: --db <path-to-sqlite> is required.\n' +
    'Example: node tools/export-profiles.mjs --db ../backend/prisma/dev.db');
  process.exit(1);
}

/** Characters of the id that name its shard. Mirrored in js/profile.js. */
export const SHARD_CHARS = 3;
export const shardOf = (id) => String(id).slice(-SHARD_CHARS).padStart(SHARD_CHARS, '0');

const dbPath = resolve(process.cwd(), args.db);
const outDir = resolve(here, '..', typeof args.out === 'string' ? args.out : 'data/profiles');

console.log(`reading  : ${dbPath}`);
console.log(`writing  : ${outDir}`);

// Rebuild from empty: a doctor removed upstream must not leave a stale profile
// behind in a shard that this run no longer writes.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const db = new DatabaseSync(dbPath, { readOnly: true });

// Profiles are exported for the ACTIVE register only, matching doctors.json.
// A shard keyed by a de-listed professional's id would be a record the
// directory can never route to, and its education would be counted against a
// population that no longer contains them. See tools/lifecycle.mjs.
const life = lifecycle(db);
console.log(`lifecycle: ${life.describe()}`);

/**
 * Current licences, read from the RELATIONAL table rather than re-parsing text.
 * These are the placements the register still lists as held, with the licence
 * number and the status label exactly as published.
 */
const licencesByDoctor = new Map();
for (const l of db.prepare(`
  select df.doctorId, df.licenseNumber, df.statusLabel, df.sourceText, f.nameTrimmed as facility
  from DoctorFacility df
  join Facility f on f.id = df.facilityId
  where df.relationType = 'current_license' and ${life.viaDoctorId('df')}
  order by df.createdAt asc`).all()) {
  let list = licencesByDoctor.get(l.doctorId);
  if (!list) licencesByDoctor.set(l.doctorId, (list = []));
  // "Specialist Orthodontics Active · <facility> · License: N (Active License)"
  // — the role is everything before the first separator, minus the trailing
  // status word the register appends to it.
  const head = String(l.sourceText ?? '').split(' · ')[0] ?? '';
  const title = head.replace(/\s+(Active|Inactive)(,[^·]*)?$/i, '').trim();
  const row = {};
  if (title) row.t = title;
  if (l.facility) row.f = l.facility;
  if (l.licenseNumber) row.n = l.licenseNumber;
  if (l.statusLabel) row.s = l.statusLabel;
  list.push(row);
}

const trim = (s) => {
  const v = s === null || s === undefined ? '' : String(s).replace(/\s+/g, ' ').trim();
  return v === '' ? undefined : v;
};
const put = (obj, key, value) => { if (value !== undefined) obj[key] = value; };

const shards = new Map();
let doctors = 0, withWork = 0, withEdu = 0, withContact = 0, withLicence = 0;

/** Non-empty strings only, de-duplicated, order preserved. */
const putList = (obj, key, values) => {
  const out = [];
  for (const v of values ?? []) {
    const t = trim(v);
    if (t !== undefined && !out.includes(t)) out.push(t);
  }
  if (out.length) obj[key] = out;
};

let eduEntries = 0;
let workEntries = 0;

for (const d of db.prepare(`
  select d.id, d.dhaUniqueId, d.experience, d.education,
         d.mobileNumber, d.mobileNumber2, d.personalEmail, d.linkedIn, d.extraFields
  from Doctor d where ${life.doctor('d')}`).iterate()) {
  const rec = {};

  const work = parseExperience(d.experience).map((e) => {
    const row = {};
    put(row, 't', trim(e.title));
    put(row, 'f', trim(e.facility));
    put(row, 'x', trim(e.place));   // unlabelled: facility or city, register does not say
    put(row, 'n', trim(e.licenseNumber));
    put(row, 's', trim(e.startDate));
    put(row, 'e', trim(e.endDate));
    put(row, 'd', trim(e.duration));
    put(row, 'l', trim(e.location));
    putList(row, 'o', e.extra);
    if (e.isCurrent) row.c = 1;
    return row;
  }).filter((row) => Object.keys(row).length > 0);
  if (work.length) { rec.w = work; withWork++; workEntries += work.length; }

  const licences = licencesByDoctor.get(d.id) ?? [];
  if (licences.length) { rec.l = licences; withLicence++; }

  // EVERY education entry, in published order. No `seen` set, no `[0]`, no
  // `find()` — a professional with five qualifications exports five rows.
  const edu = parseEducation(d.education).map((e) => {
    const row = {};
    put(row, 'q', trim(e.qualification));
    put(row, 'i', trim(e.institution));
    put(row, 'h', trim(e.heading));     // unlabelled leading value
    put(row, 'g', trim(e.graduated));
    put(row, 'l', trim(e.location));
    put(row, 'y', trim(e.country));
    put(row, 'v', trim(e.verification));
    putList(row, 'o', e.extra);
    return row;
  }).filter((row) => Object.keys(row).length > 0);
  if (edu.length) { rec.e = edu; withEdu++; eduEntries += edu.length; }

  // Published contact, verbatim. Only what the register actually carries — a
  // missing channel is an absent key, never a placeholder.
  //
  // `extraFields` holds every contact label DHA renders that has no promoted
  // column of its own — a SECOND email for 3,125 professionals and a Twitter
  // handle for 188. Those were published and this export used to drop them.
  let extra = {};
  try { extra = JSON.parse(d.extraFields || '{}') || {}; } catch { extra = {}; }

  const contact = {};
  put(contact, 'p', trim(d.mobileNumber));
  // The office number lands in `mobileNumber2` when the profile publishes two,
  // and in extraFields when the promotion did not run for that record.
  put(contact, 'p2', trim(d.mobileNumber2) ?? trim(extra.contact_details_office_number));
  put(contact, 'm', trim(d.personalEmail));
  // The second address, whichever key the enrichment recorded it under.
  const secondEmail = trim(extra.secondary_email) ?? trim(extra.contact_details_work_email);
  if (secondEmail && secondEmail.toLowerCase() !== String(contact.m ?? '').toLowerCase()) {
    contact.m2 = secondEmail;
  }
  put(contact, 'i', trim(d.linkedIn));
  put(contact, 't', trim(extra.twitter) ?? trim(extra.contact_details_twitter));
  if (Object.keys(contact).length) { rec.c = contact; withContact++; }

  if (Object.keys(rec).length === 0) continue;

  const key = shardOf(d.dhaUniqueId);
  let bucket = shards.get(key);
  if (!bucket) shards.set(key, (bucket = {}));
  bucket[d.dhaUniqueId] = rec;
  doctors++;
}
db.close();

for (const [key, bucket] of [...shards.entries()].sort()) {
  writeFileSync(resolve(outDir, `${key}.json`), JSON.stringify(bucket));
}

const index = {
  version: 1,
  generatedAt: new Date().toISOString(),
  // The browser derives a shard name with exactly this rule.
  shard: { by: 'dhaUniqueId', chars: SHARD_CHARS, from: 'end' },
  shards: shards.size,
  profiles: doctors,
  counts: { withWork, withLicence, withEducation: withEdu, withContact },
  /**
   * Total RECORDS, not professionals. `educationEntries` is the number the
   * reconciler compares against the register's own entry count, which is what
   * proves no repeated section was collapsed on the way out.
   */
  entries: { work: workEntries, education: eduEntries },
};
writeFileSync(resolve(outDir, 'index.json'), JSON.stringify(index));

const bytes = readdirSync(outDir).reduce((s, f) => s + statSync(resolve(outDir, f)).size, 0);
console.log('');
console.log('done.');
console.log(`  profiles        ${doctors.toLocaleString()}`);
console.log(`  shards          ${shards.size}`);
console.log(`  with work       ${withWork.toLocaleString()}`);
console.log(`  with licences   ${withLicence.toLocaleString()}`);
console.log(`  with education  ${withEdu.toLocaleString()}  (${eduEntries.toLocaleString()} entries)`);
console.log(`  work entries    ${workEntries.toLocaleString()}`);
console.log(`  with contact    ${withContact.toLocaleString()}`);
console.log(`  total size      ${(bytes / 1048576).toFixed(1)} MB  (avg ${(bytes / shards.size / 1024).toFixed(0)} KB per shard)`);

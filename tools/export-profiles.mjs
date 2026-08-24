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
 *                      s start, e end, d duration, l location, c isCurrent }]
 *   l  live licences  [{ t title, f facility, n licence, s status }]
 *   e  education      [{ i institution, g graduated, l location }]
 *   c  contact        { p phone, p2 second phone, m email, i linkedIn }
 * Absent fields are omitted, never emitted as null or "".
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseExperience, parseEducation } from './parse-profile.mjs';

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
  where df.relationType = 'current_license'
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

for (const d of db.prepare(`
  select id, dhaUniqueId, experience, education,
         mobileNumber, mobileNumber2, personalEmail, linkedIn
  from Doctor`).iterate()) {
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
    if (e.isCurrent) row.c = 1;
    return row;
  }).filter((row) => Object.keys(row).length > 0);
  if (work.length) { rec.w = work; withWork++; }

  const licences = licencesByDoctor.get(d.id) ?? [];
  if (licences.length) { rec.l = licences; withLicence++; }

  const edu = parseEducation(d.education).map((e) => {
    const row = {};
    put(row, 'i', trim(e.institution));
    put(row, 'g', trim(e.graduated));
    put(row, 'l', trim(e.location));
    return row;
  }).filter((row) => Object.keys(row).length > 0);
  if (edu.length) { rec.e = edu; withEdu++; }

  // Published contact, verbatim. Only what the register actually carries — a
  // missing channel is an absent key, never a placeholder.
  const contact = {};
  put(contact, 'p', trim(d.mobileNumber));
  put(contact, 'p2', trim(d.mobileNumber2));
  put(contact, 'm', trim(d.personalEmail));
  put(contact, 'i', trim(d.linkedIn));
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
};
writeFileSync(resolve(outDir, 'index.json'), JSON.stringify(index));

const bytes = readdirSync(outDir).reduce((s, f) => s + statSync(resolve(outDir, f)).size, 0);
console.log('');
console.log('done.');
console.log(`  profiles        ${doctors.toLocaleString()}`);
console.log(`  shards          ${shards.size}`);
console.log(`  with work       ${withWork.toLocaleString()}`);
console.log(`  with licences   ${withLicence.toLocaleString()}`);
console.log(`  with education  ${withEdu.toLocaleString()}`);
console.log(`  with contact    ${withContact.toLocaleString()}`);
console.log(`  total size      ${(bytes / 1048576).toFixed(1)} MB  (avg ${(bytes / shards.size / 1024).toFixed(0)} KB per shard)`);

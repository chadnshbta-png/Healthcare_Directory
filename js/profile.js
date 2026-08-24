/**
 * Lazy loader for the per-professional profile detail (work history, education,
 * published contact).
 *
 * These values are NOT in doctors.json — at ~102k rows they are ~66 MB, so they
 * live in data/profiles/<NNN>.json and are fetched only when a detail page for
 * a doctor in that shard is opened. One shard is ~67 KB and is kept in memory
 * afterwards, so a second profile from the same shard costs nothing.
 *
 * The whole directory is designed to work WITHOUT this data present. If
 * data/profiles was never generated (it is an optional exporter output) every
 * lookup resolves to null and the records section falls back to reporting which
 * records the register holds, exactly as it did before.
 *
 * Field names are the short keys the exporter writes; see tools/export-profiles.mjs.
 */
import { dataUrl } from './data.js';

/** Must match SHARD_CHARS in tools/export-profiles.mjs. */
const SHARD_CHARS = 3;
const shardOf = (id) => String(id).slice(-SHARD_CHARS).padStart(SHARD_CHARS, '0');

/** shard name -> Promise<record map>. Doubles as the in-flight de-duplicator. */
const shards = new Map();
/** null until probed; false when the optional export is simply not deployed. */
let available = null;

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'default' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/**
 * Is the profile export deployed at all? Probed once, and a miss is remembered
 * so a directory shipped without data/profiles does not retry on every click.
 */
export async function profilesAvailable() {
  if (available !== null) return available;
  try {
    const index = await fetchJson(dataUrl('profiles/index.json'));
    available = Number(index?.profiles) > 0;
  } catch {
    available = false;
  }
  return available;
}

/**
 * The profile record for one dhaUniqueId, or null when there is none — whether
 * because the export is absent, the shard failed to load, or the register
 * simply publishes nothing extra for that professional.
 */
export async function loadProfile(id) {
  if (!id) return null;
  if (!(await profilesAvailable())) return null;

  const key = shardOf(id);
  let pending = shards.get(key);
  if (!pending) {
    pending = fetchJson(dataUrl(`profiles/${key}.json`)).catch(() => ({}));
    shards.set(key, pending);
  }
  const bucket = await pending;
  return bucket?.[id] ?? null;
}

/** Work history entries, current placements first, then most recent. */
export const profileWork = (p) => (p && Array.isArray(p.w) ? p.w : []);
/** Live licences as the register lists them (role, facility, number, status). */
export const profileLicences = (p) => (p && Array.isArray(p.l) ? p.l : []);
/** Education entries. */
export const profileEducation = (p) => (p && Array.isArray(p.e) ? p.e : []);

/**
 * Published contact channels, normalised into what the UI needs to render an
 * action. Only channels the register actually publishes appear; there is no
 * placeholder entry and no fabricated value.
 */
export function profileContact(p) {
  const c = (p && p.c) || {};
  const out = [];
  if (c.p) out.push({ kind: 'phone', label: 'Phone number', value: c.p, href: `tel:${c.p.replace(/[^\d+]/g, '')}` });
  if (c.p2) out.push({ kind: 'phone', label: 'Second phone', value: c.p2, href: `tel:${c.p2.replace(/[^\d+]/g, '')}` });
  if (c.m) out.push({ kind: 'email', label: 'Email', value: c.m, href: `mailto:${c.m}` });
  if (c.i) out.push({ kind: 'linkedin', label: 'LinkedIn', value: c.i, href: c.i });
  return out;
}

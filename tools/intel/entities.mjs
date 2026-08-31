/**
 * Link an article to the EXISTING Doctorna entities, by stable id.
 *
 * Reads the published directory dataset (data/facets.json, data/facilities.json,
 * data/doctors.json) — the same files the site serves — so Intelligence
 * consumes the healthcare data and cannot alter it. Nothing is written back.
 *
 * The bar for a link is deliberately high, because a wrong link is worse than
 * no link: it would put a real named doctor next to a news story they have
 * nothing to do with.
 *
 *   specialty  the specialty label appears as a whole phrase in the text.
 *   facility   the facility's registered name appears as a whole phrase, and
 *              the name is long enough to be unambiguous.
 *   doctor     the professional's FULL name appears, and exactly one
 *              professional in the register has that name. Ambiguous names are
 *              skipped rather than guessed at.
 *   location   the register publishes no area/location field for professionals
 *              or facilities, so there is nothing to match against. The column
 *              and the API exist; they stay empty until a location dimension
 *              exists in the source data. This is a gap in the SOURCE, not a
 *              gap in the pipeline, and it is never filled with a guess.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Orthographic normalisation ONLY — British to American spelling, because the
 * register is written in American forms ("Pediatrics", "Anesthesia") and UAE
 * newsrooms write British ones ("paediatric", "anaesthesia"). This changes how
 * a word is spelled, never what it means, so it cannot create a false match.
 * Applied to both sides, so the comparison is symmetric.
 */
const SPELLING = [
  [/\bpaediatric/g, 'pediatric'], [/\bpaediatrics/g, 'pediatrics'],
  [/\banaesthes/g, 'anesthes'], [/\bhaemat/g, 'hemat'], [/\bhaemorrh/g, 'hemorrh'],
  [/\borthopaedic/g, 'orthopedic'], [/\bgynaecolog/g, 'gynecolog'],
  [/\boesophag/g, 'esophag'], [/\bfoetal/g, 'fetal'], [/\bleukaemia/g, 'leukemia'],
  [/\bpaediatr/g, 'pediatr'], [/\bophthalmolog/g, 'ophthalmolog'],
];
const norm = (s) => {
  let t = String(s ?? '').toLowerCase();
  for (const [re, to] of SPELLING) t = t.replace(re, to);
  return ` ${t.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
};

/**
 * Lay term → clinical discipline.
 *
 * News writes "cancer care"; the register writes "Medical Oncology". Without a
 * bridge the two can never meet, which is why the first corpus linked nothing.
 *
 * This table is deliberately TINY and only contains mappings that are
 * definitional rather than inferential — a story about cancer is a story about
 * oncology. It is curated, not derived, so it is listed here in full for
 * review, and every link it produces is recorded with method `lay_term` so an
 * editor can tell it apart from a match on the register's own wording.
 */
const LAY_TERMS = [
  [/\bcancers?\b|\boncolog/i, 'oncology'],
  [/\bcardiac\b|\bheart (disease|failure|attack)\b/i, 'cardiology'],
  [/\bmental health\b|\bpsychiatric\b/i, 'psychiatry'],
  [/\bdiabet/i, 'endocrinology'],
  [/\bkidney\b|\brenal\b/i, 'nephrology'],
  [/\bnewborns?\b|\bneonatal\b/i, 'neonatology'],
  [/\bmaternal\b|\bobstetric/i, 'obstetrics'],
  [/\bstrokes?\b|\bneurological\b/i, 'neurology'],
  [/\bfertility\b|\bivf\b/i, 'reproductive'],
  [/\bdental\b|\bdentistry\b/i, 'dentistry'],
];

/** Build the lookup once per run; it is read-only for the whole pipeline. */
export function loadDirectory(dataDir) {
  const read = (f) => JSON.parse(readFileSync(resolve(dataDir, f), 'utf8'));
  let facets, facilities, doctors;
  try {
    facets = read('facets.json');
    facilities = read('facilities.json');
    doctors = read('doctors.json');
  } catch (err) {
    return { available: false, reason: `directory data unreadable: ${err.message}` };
  }

  // Specialties — the directory's own dictionary.
  const specialties = (facets.dict?.specialty ?? [])
    .map((label) => ({ id: label, label, key: norm(label) }))
    .filter((s) => s.label.length >= 5);

  /**
   * The register writes specialties in ROLE form — "Consultant Cardiology",
   * "Specialist Dermatology", "Registered Nurse". News prose writes the
   * discipline — "cardiology". Whole-phrase matching on the role form can
   * therefore never fire on an article, which is exactly why the first corpus
   * produced no specialty links.
   *
   * So the discipline is derived FROM the existing dictionary by removing the
   * seniority prefix. No vocabulary is invented: every discipline here is a
   * substring of a label the directory already publishes, and it maps back to
   * the real labels so the link target is still a directory value.
   */
  const ROLE_PREFIX = /^(consultant|specialist|general|registered|trainee|assistant|senior|principal|chief|head|resident|fellow|physician|technician|technologist|therapist)\s+/i;
  /**
   * Disciplines too generic to carry a link on their own. "Surgery" in prose
   * usually means an operation, "Emergency" a situation, "Nurse" a person —
   * matching them would produce links an editor would have to undo.
   */
  const GENERIC = new Set(['surgery', 'medicine', 'nurse', 'nursing', 'emergency', 'practitioner',
    'dentist', 'pharmacy', 'therapy', 'care', 'health', 'clinical', 'medical', 'doctor',
    'midwife', 'assistant', 'technician', 'technologist', 'therapist', 'privilege', 'admin']);
  const disciplineMap = new Map();  // discipline key -> [full labels]
  for (const s of specialties) {
    let d = s.label;
    // Strip up to two seniority words ("Specialist Under Supervision Orthopedic").
    for (let i = 0; i < 2; i++) d = d.replace(ROLE_PREFIX, '');
    d = d.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const key = norm(d);
    const bare = key.trim();
    if (bare.length < 7) continue;                 // too short to be discriminating
    if (GENERIC.has(bare)) continue;
    if (bare.split(' ').every((w) => GENERIC.has(w))) continue;
    if (!disciplineMap.has(key)) disciplineMap.set(key, { label: d, key, labels: [] });
    disciplineMap.get(key).labels.push(s.label);
  }
  const disciplines = [...disciplineMap.values()];

  // Facilities — registered name, keyed by the stable facility id.
  const facs = (facilities.facilities ?? [])
    .map((f) => ({ id: f.id, label: f.name, key: norm(f.name) }))
    // Two-word-or-shorter names ("Dubai Hospital" is fine, "Clinic" is not)
    // would match far too much prose.
    .filter((f) => f.label && f.label.replace(/[^a-z0-9]+/gi, ' ').trim().split(/\s+/).length >= 2
      && f.label.length >= 10);

  // Doctors — only names that identify exactly ONE professional.
  const byName = new Map();
  for (const r of doctors.rows ?? []) {
    const name = String(r[1] ?? '').trim();
    if (name.split(/\s+/).length < 2) continue;
    const k = norm(name);
    const seen = byName.get(k);
    if (seen === undefined) byName.set(k, { id: String(r[0]), label: name, count: 1 });
    else seen.count++;
  }
  const uniqueDoctors = [...byName.entries()]
    .filter(([, v]) => v.count === 1 && v.label.length >= 8)
    .map(([key, v]) => ({ id: v.id, label: v.label, key }));

  // Names held by more than one professional. Recorded so an ambiguous mention
  // can be reported as ambiguous rather than silently dropped.
  const ambiguousDoctors = [...byName.entries()]
    .filter(([, v]) => v.count > 1 && v.label.length >= 8)
    .map(([key, v]) => ({ label: v.label, key, count: v.count }));

  return {
    available: true,
    specialties,
    disciplines,
    facilities: facs,
    doctors: uniqueDoctors,
    ambiguousDoctors,
    counts: {
      specialties: specialties.length,
      disciplines: disciplines.length,
      facilities: facs.length,
      doctors: uniqueDoctors.length,
      ambiguousDoctorNames: ambiguousDoctors.length,
      locations: 0, // the register publishes none — see the note above
    },
  };
}

/**
 * Match one article's text. `text` should be the publisher's own title plus
 * excerpt — never generated prose, so a link can always be traced to something
 * the source actually said.
 */
export function linkEntities(text, dir, { maxPerType = 8 } = {}) {
  if (!dir?.available) return [];
  const hay = norm(text);
  const out = [];
  const scan = (list, entityType, method) => {
    let n = 0;
    for (const e of list) {
      if (n >= maxPerType) break;
      if (hay.includes(e.key)) {
        out.push({
          entityType,
          entityId: e.id,
          entityLabel: e.label,
          // Whole-phrase match on a published label. Confidence reflects how
          // discriminating the phrase is, not a model's opinion.
          confidence: Math.min(1, 0.55 + Math.min(e.key.trim().length, 60) / 120),
          method,
        });
        n++;
      }
    }
  };
  // Highest-confidence first: the register's own label, written out in full.
  scan(dir.specialties, 'specialty', 'normalized_exact');
  scan(dir.facilities, 'facility', 'normalized_exact');
  scan(dir.doctors, 'doctor', 'unique_full_name');

  /**
   * Discipline match: the article names the discipline ("cardiology") and the
   * directory writes it in role form. Every label sharing that discipline is
   * linked — an article about cardiology genuinely concerns the consultant and
   * the specialist alike — at a lower confidence and under its own method, so
   * an editor can tell the two kinds of match apart.
   */
  const alreadySpec = new Set(out.filter((o) => o.entityType === 'specialty').map((o) => o.entityId));
  let dn = 0;
  const addDiscipline = (d, method, confidence) => {
    // A discipline can expand to many seniority labels; cap it so a single
    // word cannot fill the page with chips.
    for (const label of d.labels.slice(0, 4)) {
      if (alreadySpec.has(label)) continue;
      alreadySpec.add(label);
      out.push({ entityType: 'specialty', entityId: label, entityLabel: label, confidence, method });
    }
  };
  for (const d of dir.disciplines ?? []) {
    if (dn >= maxPerType) break;
    if (!hay.includes(d.key)) continue;
    addDiscipline(d, 'discipline_match', 0.62);
    dn++;
  }

  // Lay wording, bridged to the register's clinical vocabulary.
  if (dn < maxPerType) {
    for (const [re, discipline] of LAY_TERMS) {
      if (dn >= maxPerType) break;
      if (!re.test(text)) continue;
      const key = norm(discipline);
      const matches = (dir.disciplines ?? []).filter((d) => d.key.includes(key.trim()));
      if (matches.length === 0) continue;
      for (const d of matches.slice(0, 2)) addDiscipline(d, 'lay_term', 0.55);
      dn++;
    }
  }

  /**
   * Ambiguity is RECORDED, not guessed at. A name held by several registered
   * professionals produces no link; it produces a note that something was
   * seen and deliberately not resolved.
   */
  for (const a of (dir.ambiguousDoctors ?? []).slice(0, 200)) {
    if (!hay.includes(a.key)) continue;
    out.push({
      entityType: 'doctor',
      entityId: `ambiguous:${a.key.trim().replace(/\s+/g, '-')}`,
      entityLabel: a.label,
      confidence: 0,
      method: 'ambiguous',
    });
  }
  return out;
}

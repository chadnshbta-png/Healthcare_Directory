/**
 * Facility-type classification — the single source of truth for what KIND of
 * place a facility is.
 *
 * WHY THIS EXISTS
 * ---------------
 * DHA publishes no facility-type field. The database carries `Facility.typeGuess`,
 * a keyword guess made when the master list was seeded, and it is null for 964
 * of 5,652 rows — which the directory used to surface as "Type not published".
 * That is a gap in one derivation, not a property of the facility, and the
 * dataset already holds enough to close it.
 *
 * So the type is derived HERE, deterministically, from three sources in
 * descending order of authority:
 *
 *   1. the facility NAME, normalised and matched against ordered rules;
 *   2. `typeGuess`, the seeder's own keyword read, mapped onto this vocabulary
 *      — corroboration only, never the sole authority (it is the narrower
 *      ruleset and it is the thing that produced the gap);
 *   3. the PROFESSIONALS actually linked to the facility — a place staffed
 *      entirely by pharmacists is a pharmacy whatever its registered name says.
 *
 * Everything here is pure: no I/O, no database, no DOM. `tools/export-data.mjs`
 * calls it once per facility and writes the answer into facilities.json, so the
 * cards, the facets, the counts, the filters, the query string and the detail
 * pages all read the same stored value rather than each deriving their own.
 *
 * NOTHING IS INVENTED. A rule fires on a word the register itself published in
 * the facility's name, or on the registered specialty of a professional the
 * register itself linked to it.
 */

/* ── canonical vocabulary ──────────────────────────────────────────────────
 * key -> label shown in the UI. The key is what lands in facilities.json, the
 * facets, and the ?ftype= query parameter, so it must stay stable.
 * `medical_center`, `center`, `clinic`, `polyclinic`, `pharmacy`, `dental`,
 * `laboratory`, `optical` and `hospital` are the keys the previous exports
 * already used and are deliberately unchanged — an existing shared link keeps
 * working.
 */
export const FACILITY_TYPES = {
  hospital: 'Hospital',
  day_surgery: 'Day surgery centre',
  polyclinic: 'Polyclinic',
  medical_center: 'Medical centre',
  clinic: 'Clinic',
  diagnostic_center: 'Diagnostic centre',
  laboratory: 'Laboratory',
  pharmacy: 'Pharmacy',
  dental: 'Dental centre',
  optical: 'Optical centre',
  physiotherapy: 'Physiotherapy & rehabilitation',
  home_healthcare: 'Home healthcare',
  nursing: 'Nursing & care',
  mental_health: 'Mental health & behavioural',
  maternity: 'Maternity & fertility',
  aesthetic: 'Aesthetic & skin centre',
  alternative: 'Traditional & complementary medicine',
  wellness: 'Wellness centre',
  veterinary: 'Veterinary',
  education: 'School & nursery',
  fitness: 'Fitness & sports',
  occupational: 'Occupational & corporate health',
  medical_supplier: 'Medical supplies & equipment',
  center: 'Centre',
  other: 'Other healthcare provider',
};

/** Every key, in the order the UI should prefer when counts tie. */
export const FACILITY_TYPE_KEYS = Object.keys(FACILITY_TYPES);

export const facilityTypeLabel = (key) => FACILITY_TYPES[key] ?? key;

/* ── name normalisation ────────────────────────────────────────────────────
 * Classification must not depend on how a name was typed. "Prime Medical
 * Center L L C", "PRIME MEDICAL CENTER LLC" and "Prime Medical Centre
 * (Branch)" are the same kind of place and must classify identically.
 */

/**
 * Company forms, ownership markers and branch markers. These say who OWNS a
 * facility, never what it IS, so they are removed before any rule runs —
 * otherwise "… Co." or "… BR" competes with the real keyword.
 */
const COMPANY_SUFFIX = new Set([
  'llc', 'lc', 'fzllc', 'fzco', 'fzc', 'fze', 'fz', 'dmcc', 'dwc', 'dwtc', 'jlt',
  'pjsc', 'psc', 'jsc', 'wll', 'ltd', 'limited', 'inc', 'incorporated', 'plc',
  'est', 'establishment', 'co', 'company', 'corp', 'corporation', 'holding',
  'holdings', 'group', 'enterprises', 'enterprise', 'trading', 'general',
  'investment', 'investments', 'sole', 'proprietorship', 'partnership',
  'br', 'brof', 'branch', 'branches', 'llp', 'lp', 'pvt', 'private',
  'owned', 'person', 'single', 'ope',
]);

/**
 * Fold a facility name to a matchable form:
 *   - accents removed, lowercased
 *   - every run of punctuation becomes one space ("L.L.C" -> "l l c")
 *   - runs of single letters glued back together, so "l l c" -> "llc" and
 *     "f z llc" -> "fzllc" (the same rule Facility.nameMatchKey uses)
 *   - British/American spelling unified: "center" -> "centre"
 *   - company and branch words dropped
 * The result is a space-delimited token string, always with a leading and
 * trailing space so a rule can test whole words with plain `includes`.
 */
export function normalizeFacilityName(name) {
  let s = String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return ' ';

  // Glue runs of 2+ single letters: "l l c" -> "llc", "f z llc" -> "fzllc".
  s = s.replace(/\b(?:[a-z] )+[a-z]\b/g, (run) => run.replace(/ /g, ''));

  const kept = [];
  for (let word of s.split(' ')) {
    if (!word) continue;
    // Unify spelling so one rule covers both. Applied per WORD so it cannot
    // touch "centers"/"centres" inconsistently or damage an unrelated word.
    word = word
      .replace(/^centers?$/, 'centre')
      .replace(/^centres$/, 'centre')
      .replace(/^cntr$/, 'centre')
      .replace(/^clinics$/, 'clinic')
      .replace(/^pharmacies$/, 'pharmacy')
      .replace(/^laboratories$/, 'laboratory')
      .replace(/^labs$/, 'lab')
      .replace(/^hospitals$/, 'hospital');
    if (COMPANY_SUFFIX.has(word)) continue;
    kept.push(word);
  }
  // A name made ENTIRELY of company words keeps its original tokens rather
  // than becoming empty — there would be nothing left to classify on.
  const body = kept.length ? kept.join(' ') : s;
  return ` ${body} `;
}

/* ── ordered rules ─────────────────────────────────────────────────────────
 * FIRST MATCH WINS, so the list runs most-specific to most-generic. This is
 * what makes "Premier Diagnostic Center" a Diagnostic centre rather than a
 * Centre, and "Prime Medical Center" a Medical centre rather than a Centre.
 *
 * Every pattern is anchored on whole words (the normalised form is a
 * space-delimited token string), so "care" never fires inside "cardiology"
 * and "lab" never fires inside "labour".
 */
const w = (...words) => words.map((x) => new RegExp(`(?:^| )${x}(?: |$)`));

const RULES = [
  // ── unambiguous institutional forms ──────────────────────────────────────
  ['hospital', w('hospital', 'medical city', 'infirmary')],
  ['day_surgery', w('day surgery', 'day surgical', 'daysurgery', 'surgical centre', 'surgery centre', 'ambulatory surgery')],
  ['polyclinic', w('polyclinic', 'poly clinic')],

  // ── single-discipline places, before any generic clinic/centre word ──────
  ['pharmacy', w('pharmacy', 'pharma', 'pharmacie', 'pharamcy', 'phrmacy', 'drug store', 'drugstore', 'chemist', 'apothecary', 'nahdi', 'boots')],
  ['dental', w('dental', 'dentist', 'dentistry', 'dentalcare', 'orthodontic', 'orthodontics', 'endodontic', 'periodontic', 'implantology', 'denture', 'teeth', 'tooth')],
  ['optical', w('optical', 'optics', 'optic', 'optician', 'opticians', 'optometry', 'eyewear', 'eye wear', 'spectacles', 'glasses', 'sunglasses', 'eyeglasses', 'magrabi', 'yateem')],
  ['laboratory', w('laboratory', 'lab', 'pathology', 'histopathology', 'cytology', 'genomics', 'genomic', 'genetics', 'biolab', 'medlab', 'blood bank', 'bloodbank')],
  ['diagnostic_center', w('diagnostic', 'diagnostics', 'diagnosis', 'imaging', 'radiology', 'radiologic', 'mri', 'ct scan', 'ultrasound', 'sonography', 'screening', 'scan', 'scanning', 'x ray', 'xray', 'mammography', 'endoscopy')],
  ['physiotherapy', w('physiotherapy', 'physiotherapies', 'physio', 'physical therapy', 'rehabilitation', 'rehab', 'chiropractic', 'chiropractor', 'osteopathy', 'osteopathic', 'podiatry', 'prosthetic', 'prosthetics', 'orthotic', 'orthotics')],
  ['home_healthcare', w('home health', 'home healthcare', 'home health care', 'homehealth', 'home care', 'homecare', 'home nursing', 'home medical', 'at home', 'domiciliary')],
  ['nursing', w('nursing', 'nurses', 'nurse', 'care home', 'caregiver', 'caregivers', 'elderly', 'geriatric', 'long term care', 'hospice', 'palliative')],
  ['mental_health', w('psychology', 'psychological', 'psychiatry', 'psychiatric', 'psychotherapy', 'psychiatrist', 'psychologist', 'mental health', 'mental', 'behavioural', 'behavioral', 'behaviour', 'behavior', 'autism', 'counselling', 'counseling', 'counsellor', 'speech therapy', 'occupational therapy', 'wellbeing', 'well being', 'psyche', 'neurofeedback')],
  ['maternity', w('maternity', 'fertility', 'ivf', 'obstetric', 'obstetrics', 'gynecology', 'gynaecology', 'birthing', 'midwifery', 'lactation', 'reproductive', 'fetal', 'foetal', 'neonatal')],
  ['veterinary', w('veterinary', 'veterinarian', 'vet', 'vets', 'animal', 'animals')],
  ['medical_supplier', w('medical supplies', 'medical supply', 'medical equipment', 'medical equipments', 'surgical supplies', 'surgical equipment', 'medical devices', 'medical device', 'prosthesis', 'hearing aid', 'hearing aids', 'supplies', 'supply', 'equipment', 'equipments', 'manufacturing', 'manufacture', 'printing', 'retail', 'distribution', 'wholesale')],

  // ── appearance / lifestyle / traditional ────────────────────────────────
  ['aesthetic', w('aesthetic', 'aesthetics', 'esthetic', 'esthetics', 'cosmetic', 'cosmetics', 'cosmetology', 'beauty', 'laser', 'skin', 'derma', 'dermatology', 'dermatologic', 'plastic surgery', 'cosmetic surgery', 'slimming', 'salon', 'salons', 'hair', 'nails', 'grooming', 'barber', 'makeup', 'tattoo', 'piercing', 'brow', 'lash', 'botox', 'filler', 'fillers')],
  ['alternative', w('ayurveda', 'ayurvedic', 'ayurved', 'homeopathy', 'homeopathic', 'homoeopathy', 'homoeopathic', 'unani', 'acupuncture', 'chinese medicine', 'tcm', 'naturopathy', 'naturopathic', 'herbal', 'herbs', 'yoga', 'meditation', 'reiki', 'hijama', 'cupping', 'holistic', 'siddha', 'panchakarma')],
  ['wellness', w('wellness', 'spa', 'spas', 'thalasso', 'hydrotherapy', 'detox', 'nutrition', 'nutritional', 'dietetic', 'dietetics', 'dietician', 'dietitian', 'longevity', 'anti aging', 'antiaging', 'regenerative', 'iv therapy', 'iv drip')],
  ['fitness', w('fitness', 'gym', 'gyms', 'sports', 'sport', 'athletic', 'athletics', 'pilates', 'crossfit', 'personal training', 'swimming', 'football')],

  // ── places licensed for their staff rather than for treatment ───────────
  ['education', w('school', 'schools', 'nursery', 'nurseries', 'kindergarten', 'academy', 'academies', 'college', 'university', 'institute', 'institutes', 'education', 'educational', 'learning', 'childhood', 'preschool', 'pre school', 'montessori', 'tuition', 'campus')],
  ['occupational', w('occupational health', 'corporate health', 'employee health', 'workplace health', 'labour camp', 'labor camp', 'industrial', 'offshore', 'aviation medical', 'marine medical', 'driving')],

  // ── generic clinical forms, LAST so a specific rule always wins ─────────
  ['medical_center', w('medical centre', 'medcentre', 'medicalcentre', 'medical complex', 'health centre', 'healthcare centre', 'medcare', 'medi centre', 'medical polyclinic')],
  ['clinic', w('clinic', 'clinique', 'kliniek', 'klinik', 'mediclinic', 'medclinic', 'surgery', 'surgeries', 'practice', 'doctors', 'doctor', 'dr', 'physician', 'physicians')],
  ['medical_center', w('medical', 'medicine', 'medicare', 'medico', 'healthcare', 'health care', 'medi')],
  ['center', w('centre', 'health', 'care', 'hub')],
];

/**
 * Map the seeder's own `typeGuess` vocabulary onto this one. Used ONLY as
 * corroboration when the name rules found nothing — it is the narrower
 * ruleset, and it is what left 964 facilities unclassified in the first place.
 */
const TYPE_GUESS_MAP = {
  hospital: 'hospital',
  polyclinic: 'polyclinic',
  pharmacy: 'pharmacy',
  dental: 'dental',
  laboratory: 'laboratory',
  optical: 'optical',
  medical_center: 'medical_center',
  clinic: 'clinic',
  center: 'center',
};

/**
 * Which type a facility's own STAFF imply, when its name says nothing.
 *
 * Read from the specialties the register itself records for the professionals
 * it linked to that facility — a real relationship, not a guess about the
 * name. A rule fires only when the discipline DOMINATES the facility, so a
 * single pharmacist working inside a mixed clinic can never rename it.
 *
 * Ordered: the first rule whose share threshold is met wins.
 */
const STAFF_RULES = [
  { type: 'pharmacy', share: 0.6, test: /pharmacist|pharmacy technician|pharmaceutical/i },
  { type: 'dental', share: 0.5, test: /dentist|dental|orthodont|prosthodont|endodont|periodont/i },
  { type: 'optical', share: 0.5, test: /optometrist|optician|ophthalmic technician|orthoptist/i },
  { type: 'laboratory', share: 0.5, test: /laboratory (technologist|technician|aide)|medical laboratory|microbiolog|histopatholog|phlebotom/i },
  { type: 'diagnostic_center', share: 0.5, test: /radiograph|radiolog|sonograph|nuclear medicine|imaging/i },
  { type: 'physiotherapy', share: 0.5, test: /physiotherapist|physical therap|occupational therapist|chiropract|osteopath|podiatrist|prosthetist|orthotist/i },
  { type: 'mental_health', share: 0.5, test: /psycholog|psychiatr|speech (therapist|and language)|behavio(?:u)?r|counsell?or/i },
  { type: 'aesthetic', share: 0.5, test: /aesthetician|beauty therapist|laser hair|cosmetolog|dermatolog/i },
  { type: 'alternative', share: 0.5, test: /ayurved|homeopath|homoeopath|unani|acupunctur|naturopath|chinese medicine|tcim/i },
  { type: 'wellness', share: 0.5, test: /dietician|dietitian|nutrition/i },
  { type: 'nursing', share: 0.6, test: /nurse|midwife|midwifery/i },
  { type: 'clinic', share: 0.5, test: /general practitioner|family medicine|physician|specialist|consultant|medical (?:resident|intern)/i },
];

/**
 * Classify one facility.
 *
 * @param {object} facility
 * @param {string} facility.name         registered name (trimmed form)
 * @param {string|null} facility.dhaType `Facility.typeGuess`, or null
 * @param {Array<{label:string,count:number}>} facility.staff
 *        specialty tallies for the professionals linked to this facility
 * @returns {{type:string, source:'name'|'dha_type'|'staff'|'unclassified'}}
 */
export function classifyFacility({ name, dhaType = null, staff = [] } = {}) {
  const norm = normalizeFacilityName(name);

  // 1. the name itself — ordered, most specific first.
  for (const [type, patterns] of RULES) {
    for (const re of patterns) {
      if (re.test(norm)) return { type, source: 'name' };
    }
  }

  // 2. the seeder's keyword read, mapped onto this vocabulary.
  const mapped = dhaType ? TYPE_GUESS_MAP[String(dhaType).toLowerCase()] : null;
  if (mapped) return { type: mapped, source: 'dha_type' };

  // 3. who actually works there.
  let total = 0;
  for (const x of staff) total += x.count || 0;
  if (total > 0) {
    for (const rule of STAFF_RULES) {
      let hit = 0;
      for (const x of staff) if (rule.test.test(x.label)) hit += x.count || 0;
      if (hit / total >= rule.share) return { type: rule.type, source: 'staff' };
    }
    // Staffed by licensed professionals, but by no dominant discipline. That is
    // a real, describable thing: a mixed clinical site.
    return { type: 'center', source: 'staff' };
  }

  return { type: 'other', source: 'unclassified' };
}

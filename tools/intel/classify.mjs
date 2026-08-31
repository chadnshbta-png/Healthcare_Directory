/**
 * Classification and the AI abstraction.
 *
 * TWO paths, and the store records which one ran, per article, in
 * `Article.classifier`. That matters: a reader (and an auditor) must be able to
 * tell a model's output from a deterministic rule.
 *
 *   rule_based   default. Keyword rules over the publisher's OWN title and
 *                excerpt. It classifies and it flags medical content for
 *                review. It does NOT write prose: the published summary is the
 *                source's own excerpt, verbatim and attributed. Nothing is
 *                generated, so nothing can be invented.
 *
 *   an AI model  only when a provider is configured. It may classify,
 *                summarise, extract entities and draft analysis — always
 *                grounded in the supplied source text, never from its own
 *                knowledge, and clinical output is always routed to medical
 *                review before it can publish.
 *
 * With no provider configured `analyse()` returns `{ available: false }` and
 * the pipeline proceeds on the rule-based path. It never pretends a model ran.
 */

/**
 * UAE detection, in two parts, because "mentions the UAE once" is not UAE news.
 *
 *   PLACE   a UAE place or jurisdiction
 *   BODY    a named UAE health authority, operator or programme — on its own
 *           this is decisive, since only UAE healthcare writes about them
 *
 * A story is UAE healthcare news when a NAMED BODY appears, or when a PLACE
 * appears together with healthcare vocabulary, or when a place is mentioned
 * repeatedly (a passing dateline says "Dubai" once; a story about Dubai does
 * not). The source's own region is used as corroboration, never as the sole
 * reason — an Abu Dhabi regulator can publish about somewhere else.
 */
const UAE_PLACE = /\b(uae|u\.a\.e\.|emirat\w*|dubai|abu dhabi|sharjah|ajman|fujairah|ras al[- ]khaimah|umm al[- ]quwain|al ain)\b/gi;
const UAE_BODY = /\b(dha|dubai health authority|dubai health|doh|department of health\s*[-–—]?\s*abu dhabi|mohap|ministry of health and prevention|ehs|emirates health services|seha|purehealth|pure health|m42|mubadala health|malaffi|riayati|daman|thiqa|nabidh|dubai academic health corporation|arab health)\b/i;
/**
 * Healthcare vocabulary, wide enough to recognise how health authorities
 * actually write. The first pass listed only clinical service words, so real
 * DoH headlines — "organ donation", "paediatric cardiac biopsy", "life
 * sciences", "mental wellness" — read as non-healthcare and their stories were
 * filed as global. Breadth here costs nothing: this term only ever CORROBORATES
 * a UAE place or body, it never establishes UAE on its own.
 */
const HEALTH_CONTEXT = new RegExp([
  'health\\w*', 'hospital\\w*', 'clinic\\w*', 'patients?', 'medical', 'medicine', 'physicians?',
  'doctors?', 'nurses?', 'licens\\w*', 'regulat\\w*', 'treatments?', 'care', 'therap\\w*',
  'surg\\w*', 'vaccin\\w*', 'insur\\w*', 'pharmac\\w*', 'screening', 'diagnos\\w*',
  'wellbeing', 'well-being', 'wellness', 'disease\\w*', 'cancer', 'oncolog\\w*',
  'cardiac', 'cardio\\w*', 'p[ae]diatric\\w*', 'neonat\\w*', 'newborns?', 'maternal',
  'mental', 'psychiatr\\w*', 'diabet\\w*', 'transplant\\w*', 'organ donation', 'donors?',
  'biops\\w*', 'genom\\w*', 'genetic\\w*', 'life sciences', 'biotech\\w*', 'pharma\\w*',
  'trials?', 'therapeutic\\w*', 'ambulance\\w*', 'emergency care', 'apnoea', 'apnea',
  'anxiety', 'rehabilitation', 'nutrition', 'immunis\\w*', 'immuniz\\w*', 'epidemi\\w*',
  'medicaid|medicare', 'telemedicine', 'telehealth', 'drug\\w*', 'medication\\w*',
].map((x) => `(?:${x})`).join('|'), 'i');

export function uaeSignal(text, sourceRegion = null) {
  const places = [...String(text ?? '').matchAll(UAE_PLACE)].length;
  const body = UAE_BODY.test(text ?? '');
  const health = HEALTH_CONTEXT.test(text ?? '');
  // A named UAE health body is decisive on its own.
  if (body && health) return { uae: true, reason: 'named_uae_health_body', places, body: true };
  // A place plus healthcare vocabulary, where the place is more than a dateline.
  if (places >= 2 && health) return { uae: true, reason: 'repeated_place_with_health_context', places, body };
  if (places >= 1 && health && sourceRegion === 'uae') {
    return { uae: true, reason: 'place_with_health_context_from_uae_source', places, body };
  }
  return { uae: false, reason: places ? 'passing_mention_only' : 'no_uae_signal', places, body };
}

/** Category rules. First match wins; order is significance, not alphabet. */
const CATEGORY_RULES = [
  ['insurance',           /\b(insur\w*|reimburse\w*|claims?|payer|coverage|copay|premium|daman|thiqa)\b/i],
  ['medical-tourism',     /\b(medical tourism|health tourism|medical travel|inbound patients?)\b/i],
  ['healthcare-technology', /\b(digital health|telehealth|telemedicine|health tech|\bAI\b|artificial intelligence|machine learning|wearable|robotic|electronic health record|\bEHR\b|health informatics)\b/i],
  ['research-and-insights', /\b(stud(?:y|ies)|trial|clinical trial|research|findings|cohort|randomi[sz]ed|peer[- ]reviewed|journal|evidence)\b/i],
  ['doctors-and-clinics', /\b(clinic|hospital|physician|surgeon|nurse|practition\w*|facilit(?:y|ies)|accredit\w*|licens\w*)\b/i],
  ['health-and-wellness', /\b(wellness|nutrition|diet|exercise|lifestyle|mental health|well[- ]being|sleep|smoking|obesity)\b/i],
  ['medical-news',        /\b(disease|outbreak|vaccin\w*|drug|treatment|therap\w*|patients?|health|medic\w*|cancer|diabet\w*|infect\w*)\b/i],
];

/** Content type. Clinical language is what forces medical review. */
const CLINICAL_RE = /\b(dosage|dose|contraindicat\w*|adverse (?:event|reaction)|efficacy|indication|prescrib\w*|treatment protocol|clinical guidance|therapy|symptom|diagnos\w*|mortality|morbidity|side effects?)\b/i;
const RESEARCH_RE = /\b(stud(?:y|ies)|trial|randomi[sz]ed|cohort|meta[- ]analysis|peer[- ]reviewed|journal|preprint|findings)\b/i;
const BREAKING_RE = /\b(urgent|breaking|immediate(?:ly)?|recall|outbreak|emergency|alert|warning|suspend\w*|withdraw\w*)\b/i;

/** Deterministic classification over the publisher's own words. */
export function ruleClassify({ title, excerpt, categories = [], defaultCategory = null, sourceRegion = null }) {
  const text = `${title ?? ''} ${excerpt ?? ''} ${categories.join(' ')}`.trim();

  const uae = uaeSignal(text, sourceRegion);

  let category = null;
  for (const [cat, re] of CATEGORY_RULES) { if (re.test(text)) { category = cat; break; } }
  category = category ?? defaultCategory ?? 'medical-news';
  // A genuine UAE signal outranks the generic category rules — but only the
  // generic ones. A UAE story about insurance or health technology keeps that
  // more specific category and is surfaced as UAE by `region`.
  if (uae.uae && (category === 'medical-news' || category === 'doctors-and-clinics'
      || category === 'health-and-wellness')) {
    category = 'uae-healthcare-news';
  }

  const isClinical = CLINICAL_RE.test(text);
  let contentType = 'news';
  if (BREAKING_RE.test(text)) contentType = 'breaking-news';
  if (RESEARCH_RE.test(text)) contentType = 'research';
  if (isClinical) contentType = 'medical';

  // Tags are drawn from the feed's OWN categories plus the matched vocabulary.
  const tags = [...new Set(categories.map((c) => c.trim()).filter(Boolean))].slice(0, 8);

  return {
    category,
    contentType,
    tags,
    requiresMedicalReview: isClinical,
    classifier: 'rule_based',
    region: uae.uae ? 'uae' : (sourceRegion === 'gcc' ? 'gcc' : 'global'),
    uaeReason: uae.reason,
  };
}

/**
 * AI provider abstraction. Configuration only — no key, no call, no pretence.
 *
 * Set DOCTORNA_AI_PROVIDER=anthropic and ANTHROPIC_API_KEY to enable. The
 * prompt contract is deliberately narrow: the model is given ONLY the source
 * text and must answer from it; anything it cannot ground it must leave empty.
 */
export function aiConfig(env = process.env) {
  const provider = (env.DOCTORNA_AI_PROVIDER ?? '').trim().toLowerCase();
  if (!provider || provider === 'none') {
    return { available: false, provider: 'none', reason: 'DOCTORNA_AI_PROVIDER is not set' };
  }
  if (provider === 'anthropic') {
    const key = (env.ANTHROPIC_API_KEY ?? '').trim();
    if (!key) return { available: false, provider, reason: 'ANTHROPIC_API_KEY is not set' };
    return {
      available: true, provider, key,
      model: env.DOCTORNA_AI_MODEL ?? 'claude-sonnet-5',
      endpoint: 'https://api.anthropic.com/v1/messages',
    };
  }
  return { available: false, provider, reason: `unknown provider "${provider}"` };
}

const SYSTEM = [
  'You classify and summarise healthcare news for a directory.',
  'You are given ONLY a headline and the publisher\'s own excerpt.',
  'Rules you must not break:',
  '- Use nothing but the supplied text. Never add facts, figures, names or dates.',
  '- If the text does not support a field, return an empty value for it.',
  '- Do not give medical advice and do not state clinical conclusions.',
  'Reply with JSON only: {"category":"","contentType":"","summary":"","tags":[],',
  '"entities":{"specialties":[],"facilities":[],"locations":[]},"clinical":false}',
].join('\n');

/**
 * Ask the configured model about one item. Returns `{ available:false }` when
 * unconfigured so the caller can fall back without special-casing.
 */
export async function analyse(item, cfg = aiConfig()) {
  if (!cfg.available) return { available: false, reason: cfg.reason };
  const body = {
    model: cfg.model,
    max_tokens: 700,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `HEADLINE: ${item.title}\n\nEXCERPT: ${item.excerpt ?? '(none)'}\n\nSOURCE: ${item.sourceName}`,
    }],
  };
  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { available: true, ok: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    const text = (json.content ?? []).map((c) => c.text ?? '').join('').trim();
    const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
    return { available: true, ok: true, model: cfg.model, result: parsed };
  } catch (err) {
    return { available: true, ok: false, error: `${err.name}: ${err.message}` };
  }
}

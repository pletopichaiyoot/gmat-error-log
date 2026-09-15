// scripts/classify-og-difficulty.core.mjs
// Pure, network-free helpers for rating OG question difficulty.
//
// The first version asked for an Easy/Medium/Hard label directly and told the
// model to expect "roughly a third each". That produced 251/171/26 across the
// pool and a correlation of only 0.166 against printed question order, which
// the Official Guide arranges roughly easy-to-hard. Two reasons:
//
//  - A distribution is not something a model can honour. Items are rated in
//    small independent batches, so it cannot see the global spread; the
//    instruction only added noise.
//  - "Easy / Medium / Hard" are adjectives with no anchor. Different batches
//    drift to different internal scales.
//
// So the model now estimates one OBSERVABLE quantity per item — the share of
// well-prepared test takers who answer it correctly — against anchors written
// in terms of what the answer choices actually do. The label is derived from
// that number here, in code. Storing the estimate means the cutoffs can be
// retuned later without paying for the pass again.

export const VALID_LABELS = ['Easy', 'Medium', 'Hard'];

// The model's ABSOLUTE estimates are not trustworthy: asked what share of a
// 655-705 cohort answers each question correctly, it compresses nearly every
// answer into 72-82 regardless of the question. Fixed cutoffs against that
// distribution put 319 of 448 questions in one bucket.
//
// Its RELATIVE ordering is the part worth keeping, so the labels are tertiles
// of the estimates within a subject — "the third of OG Critical Reasoning this
// model judged hardest" — rather than absolute thresholds. CR and RC are cut
// separately because their estimate distributions differ.
//
// Treat the axis as a rough relative ranking. Measured against printed order,
// which the Official Guide arranges roughly easy-to-hard, the estimates
// correlate only about 0.15-0.22; raising reasoning effort to "high" did not
// improve it (0.187 against 0.219 at medium on the largest clean sample).
export function bucketByTertile(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 3) return { hardMax: -Infinity, mediumMax: -Infinity };
  return {
    hardMax: sorted[Math.floor(sorted.length / 3)],
    mediumMax: sorted[Math.floor((sorted.length * 2) / 3)],
  };
}

// Lower pctCorrect = harder.
export function labelForPct(pct, cuts) {
  if (!Number.isFinite(pct)) return null;
  if (!cuts) return null;
  if (pct <= cuts.hardMax) return 'Hard';
  if (pct <= cuts.mediumMax) return 'Medium';
  return 'Easy';
}

export const OG_SYSTEM_PROMPT = [
  'You are a GMAT psychometrician calibrating official Official Guide questions.',
  '',
  'For each question, estimate pctCorrect: of test takers who are well prepared and',
  'currently scoring 655-705, what percentage answer THIS question correctly?',
  '',
  'Anchor the estimate on what the answer choices do, not on how the question feels:',
  '',
  '  ~90  The key restates the stimulus almost directly. Every distractor is off topic,',
  '       contradicts the stimulus, or is obviously too strong.',
  '  ~75  One distractor is tempting on a careless read, but a second look separates it',
  '       on scope, degree, or direction.',
  '  ~60  Two choices are defensible until the stimulus is re-read closely. The key turns',
  '       on a qualifier, a comparison class, or which party the claim is about.',
  '  ~45  The argument depends on an unstated assumption the reader must supply, or the',
  '       task is inverted (EXCEPT, LEAST, the role of a boldface portion).',
  '  ~30  Two choices survive full analysis and the key is counterintuitive, or the',
  '       correct reading depends on a detail most readers skim past.',
  '',
  'Reading Comprehension: judge against the passage. A question answerable from one',
  'named line is easier than one requiring the author\'s attitude or the function of a',
  'paragraph within the whole argument.',
  '',
  'CENTRE OF THE SCALE: across the Official Guide as a whole, this cohort averages',
  'about 65% correct on Critical Reasoning and about 60% on Reading Comprehension.',
  'An estimate above 85 means the question is easier than all but a handful in the',
  'book; reserve it for those. Most questions land between 45 and 80.',
  '',
  'Rate each question independently on its own merits. Do NOT aim for any particular',
  'distribution across a batch — some batches are genuinely uniform.',
].join('\n');

// RC entries carry a passage and are far longer, so they batch smaller.
const CR_BATCH = 12;
const RC_BATCH = 6;

// Strict schema: the model cannot return a shape the caller has to repair.
export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    ratings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer' },
          pctCorrect: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['number', 'pctCorrect', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['ratings'],
  additionalProperties: false,
};

export function collectTargets(pool, { book = null, kind = null, force = false, limit = null } = {}) {
  const out = [];
  for (const b of pool.books) {
    if (book && b.code !== book) continue;
    for (const section of b.sections) {
      if (kind && section.kind !== kind) continue;
      const passages = new Map((section.passages || []).map(p => [p.id, p]));
      for (const q of section.questions) {
        // Only questions the practice track would serve are worth rating.
        if (!q.usable) continue;
        if (!force && q.difficulty) continue;
        const passage = q.passageId ? passages.get(q.passageId) : null;
        out.push({
          id: q.id,
          bookCode: b.code,
          kind: section.kind,
          stem: q.stem,
          choices: q.choices || [],
          passageId: q.passageId || null,
          passageText: passage ? passage.text : null,
          q,
        });
      }
    }
  }
  return limit ? out.slice(0, Number(limit)) : out;
}

// RC batches group by passage so its text is sent once per batch.
export function buildBatches(targets, { crBatchSize = CR_BATCH, rcBatchSize = RC_BATCH } = {}) {
  const batches = [];
  const cr = targets.filter(t => t.kind === 'CR');
  for (let i = 0; i < cr.length; i += crBatchSize) {
    batches.push({ kind: 'CR', passageText: null, entries: cr.slice(i, i + crBatchSize) });
  }

  const byPassage = new Map();
  for (const t of targets.filter(t => t.kind === 'RC')) {
    const key = t.passageId || t.id;
    if (!byPassage.has(key)) byPassage.set(key, []);
    byPassage.get(key).push(t);
  }
  for (const [, group] of byPassage) {
    for (let i = 0; i < group.length; i += rcBatchSize) {
      const entries = group.slice(i, i + rcBatchSize);
      batches.push({ kind: 'RC', passageText: entries[0].passageText, entries });
    }
  }

  for (const batch of batches) {
    batch.entries.forEach((e, i) => { e.number = i + 1; });
  }
  return batches;
}

export function buildUserMessage(batch) {
  const payload = {
    section: batch.kind === 'RC' ? 'Reading Comprehension' : 'Critical Reasoning',
    ...(batch.passageText ? { passage: batch.passageText } : {}),
    questions: batch.entries.map(e => ({
      number: e.number,
      stem: e.stem,
      choices: e.choices.map(c => `(${c.label}) ${c.text}`),
    })),
  };
  return JSON.stringify(payload, null, 1);
}

// The schema guarantees the shape, so this only has to reject values out of
// range and numbers that were not asked for.
export function parseRatings(parsed, expectedNumbers) {
  const expected = new Set(expectedNumbers);
  const ratings = new Map();
  const errors = [];
  for (const r of (parsed && parsed.ratings) || []) {
    if (!expected.has(r.number)) { errors.push(`unexpected number ${r.number}`); continue; }
    if (!Number.isFinite(r.pctCorrect) || r.pctCorrect < 1 || r.pctCorrect > 99) {
      errors.push(`pctCorrect out of range for #${r.number}: ${r.pctCorrect}`);
      continue;
    }
    ratings.set(r.number, { pctCorrect: r.pctCorrect, reason: String(r.reason || '') });
  }
  return { ratings, errors };
}

export function applyRatings(batch, ratings, model) {
  let applied = 0;
  const missing = [];
  for (const e of batch.entries) {
    const r = ratings.get(e.number);
    if (!r) { missing.push(e.id); continue; }
    // The label is assigned by relabelPool once the whole subject is rated —
    // a tertile cannot be known from one batch.
    e.q.difficulty_pct = r.pctCorrect;
    e.q.difficulty_source = 'llm';
    e.q.difficulty_model = model;
    if (r.reason) e.q.difficulty_reason = r.reason;
    applied++;
  }
  return { applied, missing };
}

// Assign labels from the stored estimates, cut at tertiles within each
// subject. Free — no API call — so cutoffs can be revisited at any time.
export function relabelPool(pool) {
  const byKind = new Map();
  for (const b of pool.books) {
    for (const s of b.sections) {
      for (const q of s.questions) {
        if (!q.usable || !Number.isFinite(q.difficulty_pct)) continue;
        if (!byKind.has(s.kind)) byKind.set(s.kind, []);
        byKind.get(s.kind).push(q.difficulty_pct);
      }
    }
  }
  const cuts = new Map([...byKind].map(([kind, vals]) => [kind, bucketByTertile(vals)]));

  let labelled = 0;
  let cleared = 0;
  for (const b of pool.books) {
    for (const s of b.sections) {
      for (const q of s.questions) {
        if (!Number.isFinite(q.difficulty_pct)) {
          // A label with no estimate behind it is a leftover from an earlier
          // scheme and cannot be re-derived. Drop it so the batch that failed
          // gets picked up on the next run instead of looking rated.
          if (q.difficulty) {
            delete q.difficulty;
            delete q.difficulty_model;
            delete q.difficulty_source;
            cleared++;
          }
          continue;
        }
        if (!q.usable) continue;
        const label = labelForPct(q.difficulty_pct, cuts.get(s.kind));
        if (label) { q.difficulty = label; labelled++; }
      }
    }
  }
  return { labelled, cleared, cuts: Object.fromEntries(cuts) };
}

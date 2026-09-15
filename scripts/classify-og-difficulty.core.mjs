// scripts/classify-og-difficulty.core.mjs
// Pure, network-free helpers for rating OG question difficulty.
//
// Response parsing and the label vocabulary are shared with the LSAT rater, so
// the model contract stays in one place. Only the data shape and the prompt's
// calibration differ: the Official Guide spans the whole exam range, opening
// each chapter with easy items, where the LSAT pool sits at the hard end.

import {
  VALID_LABELS, extractText, parseModelResponse,
} from './classify-lsat-difficulty.core.mjs';

export { VALID_LABELS, extractText, parseModelResponse };

export const OG_SYSTEM_PROMPT = [
  'You are a GMAT difficulty rater. You are given official GMAT Critical Reasoning and',
  'Reading Comprehension questions from the Official Guide, and must rate how hard each',
  'one is for a test taker aiming at a 705+ total score.',
  '',
  'CALIBRATION: The Official Guide spans the whole exam range — each chapter opens with',
  'genuinely easy items and works upward — so expect a broad spread, roughly a third Easy,',
  'a third Medium and a third Hard. Do NOT default to Medium.',
  '',
  'Easy: the reasoning is direct, the wrong answers are obviously wrong.',
  'Medium: one real trap, or a scope distinction that rewards care.',
  'Hard: the argument turns on a subtle gap, or two answers survive a first pass.',
  '',
  'Reply with ONLY a JSON array, one object per question:',
  '[{"number": 1, "difficulty": "Easy|Medium|Hard", "reason": "a few words"}]',
].join('\n');

// RC entries carry a passage and are far longer, so they batch smaller.
const CR_BATCH = 15;
const RC_BATCH = 6;

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

// RC batches are grouped by passage so its text is sent once per batch.
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

  // The shared parser keys on an integer, so number the entries within a batch.
  for (const batch of batches) {
    batch.entries.forEach((e, i) => { e.number = i + 1; });
  }
  return batches;
}

export function buildPromptPayload(batch) {
  const user = {
    kind: batch.kind === 'RC' ? 'Reading Comprehension' : 'Critical Reasoning',
    ...(batch.passageText ? { passage: batch.passageText } : {}),
    questions: batch.entries.map(e => ({
      number: e.number,
      stem: e.stem,
      choices: e.choices.map(c => ({ label: c.label, text: c.text })),
    })),
  };
  return { system: OG_SYSTEM_PROMPT, user: JSON.stringify(user, null, 2) };
}

export function applyLabels(batch, labels, model) {
  let applied = 0;
  const missing = [];
  for (const e of batch.entries) {
    const lab = labels.get(e.number);
    if (!lab || !VALID_LABELS.includes(lab.difficulty)) {
      missing.push(e.id);
      continue;
    }
    e.q.difficulty = lab.difficulty;
    e.q.difficulty_source = 'llm';
    e.q.difficulty_model = model;
    applied++;
  }
  return { applied, missing };
}

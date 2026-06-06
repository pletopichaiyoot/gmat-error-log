// Pure, network-free helpers for LSAT difficulty classification.
// No fs / no langchain here so this module is unit-testable in isolation.

export const VALID_LABELS = ['Easy', 'Medium', 'Hard'];

export const SYSTEM_PROMPT = [
  'You are a GMAT difficulty rater. You are given LSAT questions and must rate how hard',
  'each one would be ON THE GMAT, not on the LSAT. LSAT Logical Reasoning maps to GMAT',
  'Critical Reasoning; LSAT Reading Comprehension maps to GMAT Reading Comprehension.',
  '',
  'Use exactly three labels — Easy, Medium, Hard — by GMAT criteria:',
  '- Easy (approx sub-555): single-step reasoning, literal/explicit content, an obvious',
  '  correct answer, weak distractors.',
  '- Medium (approx 555-655): moderate inference, some abstraction, one genuinely',
  '  plausible trap answer.',
  '- Hard (approx 655+): multi-step or abstract reasoning, dense/technical language,',
  '  subtle trap answers that require careful elimination.',
  '',
  'Weigh these drivers: number of logical steps, abstraction level, trap-answer subtlety,',
  'language/passage density, inference depth.',
  '',
  'Respond with ONLY a JSON array, no prose, no code fences. Each element must be',
  '{"number": <int>, "difficulty": "Easy"|"Medium"|"Hard", "reason": "<=12 words"}.',
  'Return exactly one element per question given, reusing the same "number" values.',
].join('\n');

export function parseArgs(argv) {
  const args = { test: null, limit: null, force: false, dryRun: false, model: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--test') args.test = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--model') args.model = String(argv[++i]);
  }
  return args;
}

// Resolve passage text for one RC question. Mirrors lsat-dashboard.js: a question
// belongs to the passage with the largest firstQuestion <= its number.
export function resolvePassage(section, questionNumber) {
  const passages = (Array.isArray(section.passages) ? section.passages : [])
    .filter((p) => p && typeof p.text === 'string' && p.text.trim());
  if (passages.length) {
    const sorted = passages.slice().sort((a, b) => (a.firstQuestion || 0) - (b.firstQuestion || 0));
    let match = null;
    for (const p of sorted) if ((p.firstQuestion || 0) <= questionNumber) match = p;
    return (match || sorted[0]).text;
  }
  if (typeof section.passage === 'string' && section.passage.trim()) return section.passage;
  return null;
}

// Flatten the bank into classification targets (each carries a live question ref `q`).
export function collectTargets(bank, { test = null, force = false, limit = null } = {}) {
  const targets = [];
  for (const t of bank.tests || []) {
    if (test != null && Number(t.num) !== Number(test)) continue;
    for (const s of t.sections || []) {
      const kind = String(s.kind || '').toUpperCase();
      if (kind !== 'RC' && kind !== 'LR') continue; // GMAT has no Logic-Games (AR) analog
      for (const q of s.questions || []) {
        if (!force && q.difficulty) continue;
        targets.push({
          q,
          kind,
          testNum: t.num,
          roman: s.roman,
          number: q.number,
          passageText: kind === 'RC' ? resolvePassage(s, q.number) : null,
        });
        if (limit != null && targets.length >= limit) return targets;
      }
    }
  }
  return targets;
}

// Group targets into model batches.
// RC: one batch per (test, section, passage) so the passage is sent once.
// LR: chunk each section's targets into groups of lrBatchSize (stems are self-contained).
export function buildBatches(targets, { lrBatchSize = 15 } = {}) {
  const batches = [];
  const rcGroups = new Map();
  for (const tgt of targets) {
    const entry = { q: tgt.q, number: tgt.number, stem: tgt.q.stem || '', choices: tgt.q.choices || [] };
    if (tgt.kind === 'RC') {
      const key = `${tgt.testNum}|${tgt.roman}|${tgt.passageText || ''}`;
      let batch = rcGroups.get(key);
      if (!batch) {
        batch = { kind: 'RC', testNum: tgt.testNum, roman: tgt.roman, passageText: tgt.passageText || null, entries: [] };
        rcGroups.set(key, batch);
        batches.push(batch);
      }
      batch.entries.push(entry);
    } else {
      let batch = batches[batches.length - 1];
      const sameSection = batch && batch.kind === 'LR'
        && batch.testNum === tgt.testNum && batch.roman === tgt.roman
        && batch.entries.length < lrBatchSize;
      if (!sameSection) {
        batch = { kind: 'LR', testNum: tgt.testNum, roman: tgt.roman, passageText: null, entries: [] };
        batches.push(batch);
      }
      batch.entries.push(entry);
    }
  }
  return batches;
}

// Build the {system, user} payload for one batch. Pure strings; the CLI wraps them
// in langchain message objects.
export function buildPromptPayload(batch) {
  const questions = batch.entries.map((e) => ({
    number: e.number,
    stem: e.stem,
    choices: (e.choices || []).map((c) => ({ label: c.label, text: c.text })),
  }));
  const user = {
    kind: batch.kind === 'RC' ? 'Reading Comprehension' : 'Logical Reasoning',
    ...(batch.passageText ? { passage: batch.passageText } : {}),
    questions,
  };
  return { system: SYSTEM_PROMPT, user: JSON.stringify(user, null, 2) };
}

// Pull plain text from a langchain response.content (string or content-part array).
export function extractText(response) {
  const content = response && response.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (p && (p.text || p.value)) || '')).join('');
  }
  return '';
}

// Parse the model's JSON array into labels Map<number,{difficulty,reason}> + errors[].
export function parseModelResponse(text, expectedNumbers) {
  const labels = new Map();
  const errors = [];
  const expected = new Set(expectedNumbers);
  let body = String(text || '').trim();
  body = body.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    errors.push('no JSON array found in response');
    return { labels, errors };
  }
  let arr;
  try {
    arr = JSON.parse(body.slice(start, end + 1));
  } catch (e) {
    errors.push(`JSON parse failed: ${e.message}`);
    return { labels, errors };
  }
  if (!Array.isArray(arr)) {
    errors.push('parsed value is not an array');
    return { labels, errors };
  }
  for (const item of arr) {
    const num = Number(item && item.number);
    const raw = item && typeof item.difficulty === 'string' ? item.difficulty.trim() : '';
    const norm = VALID_LABELS.find((l) => l.toLowerCase() === raw.toLowerCase());
    if (!Number.isFinite(num) || !expected.has(num)) {
      errors.push(`unexpected number: ${item && item.number}`);
      continue;
    }
    if (!norm) {
      errors.push(`bad label for #${num}: ${JSON.stringify(item && item.difficulty)}`);
      continue;
    }
    labels.set(num, { difficulty: norm, reason: item && item.reason ? String(item.reason) : '' });
  }
  return { labels, errors };
}

// Apply parsed labels to the live question objects. Returns { applied, missing[] }.
export function applyLabels(batch, labels, model) {
  let applied = 0;
  const missing = [];
  for (const e of batch.entries) {
    const lab = labels.get(e.number);
    if (!lab) {
      missing.push(e.number);
      continue;
    }
    e.q.difficulty = lab.difficulty;
    e.q.difficulty_source = model;
    applied++;
  }
  return { applied, missing };
}

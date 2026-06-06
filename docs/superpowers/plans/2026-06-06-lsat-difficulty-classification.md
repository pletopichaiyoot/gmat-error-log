# LSAT Difficulty Classification (gpt-5-nano) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Label every LSAT question in `data/lsat-questions.json` Easy/Medium/Hard on GMAT difficulty criteria using OpenAI gpt-5-nano, and surface those labels in the dashboard.

**Architecture:** A pure, network-free core module (`scripts/classify-lsat-difficulty.core.mjs`) holds all testable logic — arg parsing, target collection, batching, prompt building, response parsing, label application. A thin CLI (`scripts/classify-lsat-difficulty.mjs`) wires the core to a gpt-5-nano `ChatOpenAI` client, does I/O (backup + incremental write), and emits a `/tmp` review report. A 2-line edit in `src/lsat-dashboard.js` surfaces the new field. Tests are plain `node:assert/strict` scripts, matching the repo's existing `scripts/*.mjs` convention.

**Tech Stack:** Node 20+ ESM (`.mjs`), `@langchain/openai` (`ChatOpenAI`), `@langchain/core/messages`, `dotenv`, `node:assert/strict`.

---

## File Structure

- **Create** `scripts/classify-lsat-difficulty.core.mjs` — pure helpers (no fs, no network, no langchain). Exports: `VALID_LABELS`, `SYSTEM_PROMPT`, `parseArgs`, `resolvePassage`, `collectTargets`, `buildBatches`, `buildPromptPayload`, `extractText`, `parseModelResponse`, `applyLabels`.
- **Create** `scripts/classify-lsat-difficulty.test.mjs` — `node:assert/strict` tests for the core module.
- **Create** `scripts/classify-lsat-difficulty.mjs` — CLI orchestration: model client, batch loop, backup + incremental write, review report.
- **Modify** `src/lsat-dashboard.js` — `questionIndex()` (~line 60) and `buildQuestionRow()` (line 172) to read `difficulty` from the bank.

**Data shape written** (per question object in `data/lsat-questions.json`, 2-space pretty JSON, no trailing newline):

```json
{ "number": 1, "stem": "...", "choices": [{ "label": "A", "text": "..." }], "correct": "B",
  "difficulty": "Hard", "difficulty_source": "gpt-5-nano" }
```

---

## Task 1: Core module + unit tests (TDD)

**Files:**
- Create: `scripts/classify-lsat-difficulty.test.mjs`
- Create: `scripts/classify-lsat-difficulty.core.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/classify-lsat-difficulty.test.mjs`:

```js
import assert from 'node:assert/strict';
import {
  parseArgs, collectTargets, buildBatches, parseModelResponse,
  applyLabels, extractText, resolvePassage, VALID_LABELS,
} from './classify-lsat-difficulty.core.mjs';

const fixture = () => ({
  tests: [
    {
      num: 1,
      sections: [
        {
          roman: 'I', kind: 'RC', passage: 'PASSAGE TEXT', passages: [],
          questions: [
            { number: 1, stem: 'rc q1', choices: [{ label: 'A', text: 'a' }], correct: 'A' },
            { number: 2, stem: 'rc q2', choices: [{ label: 'A', text: 'a' }], correct: 'A', difficulty: 'Hard' },
          ],
        },
        {
          roman: 'III', kind: 'LR', passage: null, passages: [],
          questions: Array.from({ length: 18 }, (_, i) => ({
            number: i + 1, stem: 'lr ' + (i + 1), choices: [{ label: 'A', text: 'a' }], correct: 'A',
          })),
        },
      ],
    },
    {
      num: 2,
      sections: [{ roman: 'I', kind: 'AR', passages: [], questions: [{ number: 1, stem: 'ar', choices: [], correct: 'A' }] }],
    },
  ],
});

// parseArgs
{
  const a = parseArgs(['--test', '1', '--limit', '5', '--force', '--dry-run', '--model', 'gpt-x']);
  assert.equal(a.test, 1);
  assert.equal(a.limit, 5);
  assert.equal(a.force, true);
  assert.equal(a.dryRun, true);
  assert.equal(a.model, 'gpt-x');
  const b = parseArgs([]);
  assert.equal(b.test, null);
  assert.equal(b.force, false);
  assert.equal(b.dryRun, false);
}

// collectTargets: skips already-labeled (q2) and AR section
{
  const t = collectTargets(fixture(), {});
  assert.equal(t.length, 19); // RC q1 + 18 LR; RC q2 skipped (labeled); AR excluded
  assert.ok(t.every((x) => x.kind === 'RC' || x.kind === 'LR'));
  assert.equal(t.find((x) => x.kind === 'RC').passageText, 'PASSAGE TEXT');
}
// collectTargets force re-includes labeled
{
  assert.equal(collectTargets(fixture(), { force: true }).length, 20);
}
// collectTargets test filter + limit
{
  assert.equal(collectTargets(fixture(), { test: 2 }).length, 0); // test 2 is AR-only
  assert.equal(collectTargets(fixture(), { limit: 3 }).length, 3);
}

// buildBatches: RC grouped to 1 batch; LR 18 -> 2 batches (15 + 3)
{
  const t = collectTargets(fixture(), { force: true });
  const b = buildBatches(t, { lrBatchSize: 15 });
  const rc = b.filter((x) => x.kind === 'RC');
  const lr = b.filter((x) => x.kind === 'LR');
  assert.equal(rc.length, 1);
  assert.equal(rc[0].entries.length, 2);
  assert.equal(rc[0].passageText, 'PASSAGE TEXT');
  assert.equal(lr.length, 2);
  assert.equal(lr[0].entries.length, 15);
  assert.equal(lr[1].entries.length, 3);
}

// parseModelResponse: normalizes case, rejects bad label + unknown number, handles fences
{
  const r = parseModelResponse(
    '```json\n[{"number":1,"difficulty":"hard","reason":"x"},{"number":2,"difficulty":"Nope"},{"number":9,"difficulty":"Easy"}]\n```',
    [1, 2],
  );
  assert.equal(r.labels.get(1).difficulty, 'Hard');
  assert.ok(!r.labels.has(2));
  assert.ok(!r.labels.has(9));
  assert.ok(r.errors.length >= 2);
}
{
  const r = parseModelResponse('total garbage', [1]);
  assert.equal(r.labels.size, 0);
  assert.ok(r.errors.length >= 1);
}

// applyLabels mutates the live question object + reports missing
{
  const t = collectTargets(fixture(), { force: true });
  const batch = buildBatches(t)[0];
  const labels = new Map([[batch.entries[0].number, { difficulty: 'Medium', reason: 'r' }]]);
  const res = applyLabels(batch, labels, 'gpt-5-nano');
  assert.equal(batch.entries[0].q.difficulty, 'Medium');
  assert.equal(batch.entries[0].q.difficulty_source, 'gpt-5-nano');
  assert.equal(res.applied, 1);
  assert.ok(res.missing.length >= 1);
}

// extractText: string and content-part array
{
  assert.equal(extractText({ content: 'hi' }), 'hi');
  assert.equal(extractText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab');
  assert.equal(extractText({}), '');
}

// resolvePassage: largest firstQuestion <= number
{
  const sec = { passages: [{ firstQuestion: 1, text: 'P1' }, { firstQuestion: 5, text: 'P2' }] };
  assert.equal(resolvePassage(sec, 3), 'P1');
  assert.equal(resolvePassage(sec, 6), 'P2');
  assert.equal(resolvePassage({ passage: 'SOLO', passages: [] }, 1), 'SOLO');
}

assert.deepEqual(VALID_LABELS, ['Easy', 'Medium', 'Hard']);
console.log('All LSAT difficulty core tests passed.');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/classify-lsat-difficulty.test.mjs`
Expected: FAIL — `Cannot find module './classify-lsat-difficulty.core.mjs'` (the core module does not exist yet).

- [ ] **Step 3: Write the core module**

Create `scripts/classify-lsat-difficulty.core.mjs`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/classify-lsat-difficulty.test.mjs`
Expected: PASS — prints `All LSAT difficulty core tests passed.`

- [ ] **Step 5: Commit**

```bash
git add scripts/classify-lsat-difficulty.core.mjs scripts/classify-lsat-difficulty.test.mjs
git commit -m "feat: LSAT difficulty classification core + tests"
```

---

## Task 2: CLI orchestration script

**Files:**
- Create: `scripts/classify-lsat-difficulty.mjs`

- [ ] **Step 1: Write the CLI script**

Create `scripts/classify-lsat-difficulty.mjs`:

```js
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import {
  parseArgs, collectTargets, buildBatches, buildPromptPayload,
  extractText, parseModelResponse, applyLabels,
} from './classify-lsat-difficulty.core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANK_PATH = path.join(__dirname, '..', 'data', 'lsat-questions.json');
const TMP_DIR = path.join(__dirname, '..', 'tmp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildModel(model) {
  const apiKey = (process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '').trim();
  if (!apiKey) {
    console.error('ERROR: missing OPENAI_API_KEY (or LLM_API_KEY) in .env');
    process.exit(1);
  }
  const base = (process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL || '').trim();
  return new ChatOpenAI({
    model,
    apiKey,
    maxRetries: 2,
    useResponsesApi: false,
    ...(base ? { configuration: { baseURL: base } } : {}),
  });
}

async function classifyBatch(client, batch) {
  const { system, user } = buildPromptPayload(batch);
  const expected = batch.entries.map((e) => e.number);
  for (let attempt = 1; attempt <= 2; attempt++) {
    let text = '';
    try {
      const resp = await client.invoke([new SystemMessage(system), new HumanMessage(user)]);
      text = extractText(resp);
    } catch (e) {
      if (attempt === 2) return { labels: new Map(), errors: [`model error: ${e.message}`] };
      await sleep(1500);
      continue;
    }
    const parsed = parseModelResponse(text, expected);
    if (parsed.labels.size > 0) return parsed;
    if (attempt === 2) return { labels: parsed.labels, errors: parsed.errors.length ? parsed.errors : ['empty result'] };
    await sleep(1500);
  }
  return { labels: new Map(), errors: ['unreachable'] };
}

function backupOnce(state) {
  if (state.backedUp) return;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dest = `${BANK_PATH}.bak-difficulty-${stamp}`;
  fs.copyFileSync(BANK_PATH, dest);
  state.backedUp = dest;
  console.log(`\nBacked up bank -> ${path.basename(dest)}`);
}

function flush(bank) {
  fs.writeFileSync(BANK_PATH, JSON.stringify(bank, null, 2));
}

function writeReview(scope, rows) {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const out = path.join(TMP_DIR, `lsat-difficulty-review-${scope}.md`);
  const lines = ['| test | sec | kind | # | difficulty | reason | stem |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const stem = String(r.stem || '').replace(/\s+/g, ' ').slice(0, 60).replace(/\|/g, '/');
    const reason = String(r.reason || '').replace(/\s+/g, ' ').replace(/\|/g, '/');
    lines.push(`| ${r.testNum} | ${r.roman} | ${r.kind} | ${r.number} | ${r.difficulty} | ${reason} | ${stem} |`);
  }
  fs.writeFileSync(out, lines.join('\n'));
  console.log(`Review report -> ${out}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = args.model || process.env.LSAT_DIFFICULTY_MODEL || 'gpt-5-nano';
  const bank = JSON.parse(fs.readFileSync(BANK_PATH, 'utf8'));

  const targets = collectTargets(bank, { test: args.test, force: args.force, limit: args.limit });
  if (targets.length === 0) {
    console.log('Nothing to classify (already labeled? pass --force, or check --test).');
    return;
  }
  const batches = buildBatches(targets, { lrBatchSize: 15 });
  console.log(`Model: ${model} | targets: ${targets.length} | batches: ${batches.length}${args.dryRun ? ' | DRY RUN (no write)' : ''}`);

  const client = buildModel(model);
  const state = { backedUp: null };
  const reviewRows = [];
  let applied = 0, missing = 0, done = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const { labels, errors } = await classifyBatch(client, batch);
    const res = applyLabels(batch, labels, model);
    applied += res.applied;
    missing += res.missing.length;
    for (const e of batch.entries) {
      const lab = labels.get(e.number);
      reviewRows.push({
        testNum: batch.testNum, roman: batch.roman, kind: batch.kind, number: e.number,
        difficulty: lab ? lab.difficulty : 'MISSING', reason: lab ? lab.reason : (errors[0] || ''), stem: e.stem,
      });
    }
    if (errors.length) {
      console.warn(`\n  batch ${i + 1}/${batches.length} (${batch.kind} t${batch.testNum} ${batch.roman}) issues: ${errors.slice(0, 3).join('; ')}`);
    }
    if (!args.dryRun && res.applied > 0) {
      backupOnce(state);
      flush(bank);
    }
    done++;
    process.stdout.write(`\r  progress: ${done}/${batches.length} batches | labeled ${applied} | missing ${missing}   `);
    await sleep(400);
  }
  process.stdout.write('\n');

  const scope = args.test != null ? `test-${args.test}` : 'all';
  writeReview(scope, reviewRows);
  console.log(`Done. labeled=${applied}, missing=${missing}${args.dryRun ? ' (DRY RUN — bank NOT written)' : `, bank written${state.backedUp ? `, backup=${path.basename(state.backedUp)}` : ''}`}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Smoke-test the wiring with a tiny dry run (real model, no write)**

This verifies the ESM imports resolve, the gpt-5-nano model id is accepted by your key, and the parse pipeline produces labels — without mutating the bank.

Run: `node scripts/classify-lsat-difficulty.mjs --test 1 --limit 3 --dry-run`
Expected:
- Prints `Model: gpt-5-nano | targets: 3 | batches: ...`
- Progress line ends with `labeled 3 | missing 0` (1-2 missing tolerable for a smoke test).
- Writes `tmp/lsat-difficulty-review-test-1.md`.
- Prints `... (DRY RUN — bank NOT written)`.
- No new `data/lsat-questions.json.bak-difficulty-*` file is created (dry run does not back up or write).

If the model id is rejected (404/400 model error), find the correct id and retry: `LSAT_DIFFICULTY_MODEL=<id> node scripts/classify-lsat-difficulty.mjs --test 1 --limit 3 --dry-run`. Report the working id back to the user.

- [ ] **Step 3: Commit**

```bash
git add scripts/classify-lsat-difficulty.mjs
git commit -m "feat: LSAT difficulty classification CLI (gpt-5-nano)"
```

---

## Task 3: Surface difficulty in the dashboard

**Files:**
- Modify: `src/lsat-dashboard.js` (`questionIndex()` ~line 60; `buildQuestionRow()` line 172; header comment lines 7-9)

- [ ] **Step 1: Carry difficulty through the question index**

In `src/lsat-dashboard.js`, find the `idx.set(...)` call inside `questionIndex()`:

```js
        idx.set(`${t.num}|${s.roman}|${q.number}`, {
          stem: q.stem || '',
          choices: Array.isArray(q.choices) ? q.choices : [],
          correct: q.correct || null,
          kind: s.kind,
          passage: passageForQuestion(s, q.number),
        });
```

Replace it with (adds two fields):

```js
        idx.set(`${t.num}|${s.roman}|${q.number}`, {
          stem: q.stem || '',
          choices: Array.isArray(q.choices) ? q.choices : [],
          correct: q.correct || null,
          kind: s.kind,
          passage: passageForQuestion(s, q.number),
          difficulty: q.difficulty || null,
          difficulty_source: q.difficulty_source || null,
        });
```

- [ ] **Step 2: Use the indexed difficulty in the question row**

In `buildQuestionRow()`, change the hardcoded null at line 172:

```js
    difficulty: null,
```

to:

```js
    difficulty: q.difficulty || null,
```

- [ ] **Step 3: Correct the now-stale header comment**

Find the file header comment (lines 7-9):

```js
// (GMAT's Critical Reasoning analog). LSAT has no difficulty bands, so difficulty
// columns are left null (the frontend renders them as "—").
```

Replace with:

```js
// (GMAT's Critical Reasoning analog). Difficulty (Easy/Medium/Hard) comes from the
// gpt-5-nano classifier written into lsat-questions.json; unclassified questions
// stay null (the frontend renders them as "—").
```

- [ ] **Step 4: Verify the module still loads**

Run: `node -e "require('./src/lsat-dashboard.js'); console.log('lsat-dashboard loads OK')"`
Expected: prints `lsat-dashboard loads OK` (no syntax/require errors).

- [ ] **Step 5: Commit**

```bash
git add src/lsat-dashboard.js
git commit -m "feat: surface LSAT difficulty in dashboard rows"
```

---

## Task 4: Pilot run (PrepTest 1) + review gate

**Files:** none created — runs the script, mutates `data/lsat-questions.json` for test 1 only.

- [ ] **Step 1: Classify PrepTest 1 for real**

Run: `node scripts/classify-lsat-difficulty.mjs --test 1`
Expected:
- `targets:` roughly 75-80 (PrepTest 1's RC + LR questions).
- A `Backed up bank -> lsat-questions.json.bak-difficulty-<stamp>` line.
- Ends with `Done. labeled=<n>, missing=<m>, bank written, backup=...` (m should be 0 or very small).
- Writes `tmp/lsat-difficulty-review-test-1.md`.

- [ ] **Step 2: Eyeball the review report**

Run: `cat tmp/lsat-difficulty-review-test-1.md`
Then check the distribution:

Run: `node -e "const d=require('./data/lsat-questions.json'); const c={}; for(const t of d.tests) if(t.num===1) for(const s of t.sections) for(const q of s.questions||[]) if(q.difficulty){c[q.difficulty]=(c[q.difficulty]||0)+1;} console.log(c);"`
Expected: a non-degenerate spread across Easy/Medium/Hard (not 100% one label). The `reason` column should read as plausible GMAT-difficulty justifications.

- [ ] **Step 3: Confirm the labels are scoped to test 1 only**

Run: `node -e "const d=require('./data/lsat-questions.json'); let labeled=0,total=0; for(const t of d.tests) for(const s of t.sections) for(const q of s.questions||[]){total++; if(q.difficulty)labeled++;} console.log('labeled',labeled,'of',total);"`
Expected: `labeled` ≈ 75-80 (test 1 only), `of` 2805.

- [ ] **Step 4: STOP — user review gate**

Present the distribution and 5-10 sample rows from the review report to the user. Do **not** proceed to the full run until the user confirms the labels and rubric look right. If the user wants rubric tweaks, edit `SYSTEM_PROMPT` in the core module, re-run `--test 1 --force`, and re-review.

---

## Task 5: Full run + finalize

**Files:** none created — mutates `data/lsat-questions.json` for the remaining ~2725 questions.

- [ ] **Step 1: Classify the rest of the bank**

(Idempotent — test 1 is already labeled and will be skipped automatically.)
Run: `node scripts/classify-lsat-difficulty.mjs`
Expected:
- `targets:` ≈ 2725 (everything except the already-labeled test 1).
- Progress climbs through all batches; ends `Done. labeled=<~2725>, missing=<small>, bank written, backup=...`.

- [ ] **Step 2: Verify full coverage**

Run: `node -e "const d=require('./data/lsat-questions.json'); const c={}; let total=0,miss=0; for(const t of d.tests) for(const s of t.sections) for(const q of s.questions||[]){total++; if(q.difficulty)c[q.difficulty]=(c[q.difficulty]||0)+1; else miss++;} console.log('total',total,'unlabeled',miss,'dist',c);"`
Expected: `total 2805`, `unlabeled` 0 (or a small handful from failed batches), a reasonable 3-way distribution.

- [ ] **Step 3: Mop up any stragglers (only if unlabeled > 0)**

Run: `node scripts/classify-lsat-difficulty.mjs`
Expected: picks up only the still-unlabeled questions. Repeat once if needed.

- [ ] **Step 4: Clean up scratch artifacts**

Per CLAUDE.md, clear the repo `tmp/` (preserving `.gitkeep`):
Run: `find tmp -type f ! -name '.gitkeep' -delete`

- [ ] **Step 5: Note for the user**

Tell the user: the enriched `data/lsat-questions.json` is on disk (untracked, like before). `lsat-dashboard.js` caches the bank in memory, so the running API must be **restarted by the user** (do not kill it yourself) to pick up the new difficulty labels. Mention the timestamped `data/lsat-questions.json.bak-difficulty-*` backups exist as rollback points and can be deleted once the result is confirmed good.

---

## Self-Review

- **Spec coverage:**
  - Easy/Medium/Hard scale → `VALID_LABELS`, `SYSTEM_PROMPT` rubric (Task 1).
  - Stored in `lsat-questions.json` as `difficulty` + `difficulty_source` → `applyLabels` + writer (Tasks 1, 2).
  - gpt-5-nano forced regardless of `LLM_PROVIDER`, overridable via `LSAT_DIFFICULTY_MODEL` → `buildModel` + model resolution (Task 2).
  - LR ~15/batch, RC grouped per passage → `buildBatches` (Task 1).
  - Idempotent skip / `--force` / `--test` / `--limit` / `--dry-run` → `parseArgs` + `collectTargets` + CLI (Tasks 1, 2).
  - Backup + incremental write → `backupOnce` + `flush` (Task 2).
  - One-retry-then-skip per batch → `classifyBatch` (Task 2).
  - Pilot → review → full → `--test 1` gate then full run (Tasks 4, 5).
  - Dashboard wiring → Task 3.
- **Placeholder scan:** none — every code step has complete content.
- **Type consistency:** batch shape `{ kind, testNum, roman, passageText, entries:[{ q, number, stem, choices }] }` is identical across `buildBatches`, `buildPromptPayload`, `applyLabels`, and the CLI loop. `parseModelResponse` returns `{ labels: Map, errors: [] }` consumed consistently by `classifyBatch` and `applyLabels`. Labels are `{ difficulty, reason }` throughout.
- **Note on AR:** `collectTargets` filters to RC/LR; the bank's `.sections[]` contains no AR questions anyway (confirmed), so this is defensive.

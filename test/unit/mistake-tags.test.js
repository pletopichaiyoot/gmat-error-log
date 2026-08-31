/* global require */
const test = require('node:test');
const assert = require('node:assert');

const {
  parseMistakeTags,
  canonicalizeMistakeTags,
  canonicalizeMistakeTypeValue,
} = require('../../src/mistake-tags');

test('parseMistakeTags accepts JSON arrays, bare strings, and arrays', () => {
  assert.deepStrictEqual(parseMistakeTags('["Misread","Logic Slip"]'), ['Misread', 'Logic Slip']);
  assert.deepStrictEqual(parseMistakeTags('Misread'), ['Misread']);
  assert.deepStrictEqual(parseMistakeTags(['Misread']), ['Misread']);
  assert.deepStrictEqual(parseMistakeTags(null), []);
  assert.deepStrictEqual(parseMistakeTags(''), []);
  assert.deepStrictEqual(parseMistakeTags('[]'), []);
});

test('malformed JSON is kept as one literal tag rather than dropped', () => {
  assert.deepStrictEqual(parseMistakeTags('["Misread"'), ['["Misread"']);
});

test('legacy names fold onto the canonical vocabulary', () => {
  assert.deepStrictEqual(canonicalizeMistakeTags('["Misread Passage"]'), ['Misread']);
  assert.deepStrictEqual(canonicalizeMistakeTags('["Logic Breakdown"]'), ['Logic Slip']);
  assert.deepStrictEqual(canonicalizeMistakeTags('["Wrong Variable Setup"]'), ['Wrong Setup']);
  assert.deepStrictEqual(canonicalizeMistakeTags('["Could Not Start / No Plan"]'), ['No Plan / Stuck']);
  assert.deepStrictEqual(canonicalizeMistakeTags('["Incomplete Casework"]'), ['Calc/Casework Slip']);
});

test("TTP's plain-English taxonomy maps onto picker tags", () => {
  assert.deepStrictEqual(canonicalizeMistakeTags('I misread / misinterpreted the question.'), ['Misread']);
  assert.deepStrictEqual(
    canonicalizeMistakeTags('I understood the concept tested but failed to properly apply it.'),
    ['Wrong Setup']
  );
  assert.deepStrictEqual(canonicalizeMistakeTags('I did not understand the concept tested.'), ['Concept Gap']);
  assert.deepStrictEqual(canonicalizeMistakeTags('I fell for a trap answer.'), ['Trap: Real-World Distraction']);
});

test('v3 trap names fold onto the v4 Manhattan vocabulary', () => {
  assert.deepStrictEqual(canonicalizeMistakeTags('["Trap: Half-Right"]'), ['Trap: One Word Off']);
  assert.deepStrictEqual(canonicalizeMistakeTags('["Trap: Reversed"]'), ['Trap: Reverse Logic']);
  assert.deepStrictEqual(canonicalizeMistakeTags('["Trap: Plausible-but-Unstated"]'), ['Trap: Real-World Distraction']);
  assert.deepStrictEqual(canonicalizeMistakeTags('["Trap: True-but-Irrelevant"]'), ['Trap: True but Not Right']);
  assert.deepStrictEqual(canonicalizeMistakeTags('["Trap: Distortion/Familiar-Language"]'), ['Trap: Mix-Up']);
  // Scope/Strength lumped two tells; the write-path fallback is Out of Scope
  // (migration 0006 split the tagged rows row-by-row using their notes).
  assert.deepStrictEqual(canonicalizeMistakeTags('["Trap: Scope/Strength"]'), ['Trap: Out of Scope']);
  // Pre-v3 chains re-point at v4 directly.
  assert.deepStrictEqual(canonicalizeMistakeTags('["RC Trap: Too Extreme"]'), ['Trap: Extreme']);
  assert.deepStrictEqual(canonicalizeMistakeTags('["RC Trap: Opposite Direction"]'), ['Trap: Reverse Logic']);
  // v4 names are canonical: unchanged, and trap tags sort between cause and timing.
  assert.deepStrictEqual(
    canonicalizeMistakeTags('["Ran Out of Time","Trap: No Tie to Argument","Misread"]'),
    ['Misread', 'Trap: No Tie to Argument', 'Ran Out of Time']
  );
});

test('"I guessed correctly" is dropped — a self-report, not an error tag', () => {
  assert.deepStrictEqual(canonicalizeMistakeTags('I guessed correctly'), []);
  // Must yield null so the caller falls through to the preserved annotation
  // instead of overwriting it on a TTP rescrape.
  assert.strictEqual(canonicalizeMistakeTypeValue('I guessed correctly'), null);
});

test('the ASCII-x Overinvested spelling folds onto the U+00D7 picker tag', () => {
  const target = 'Overinvested (>2× median)';
  assert.deepStrictEqual(canonicalizeMistakeTags('["Overinvested (>2x median)"]'), [target]);
  assert.deepStrictEqual(canonicalizeMistakeTags('["Overinvested Time (>2x median)"]'), [target]);
  // Already canonical: unchanged, not double-mapped.
  assert.deepStrictEqual(canonicalizeMistakeTags(`["${target}"]`), [target]);
});

test('identical tag SETS serialize identically regardless of click order', () => {
  const a = canonicalizeMistakeTypeValue('["Calc/Casework Slip","Wrong Setup"]');
  const b = canonicalizeMistakeTypeValue('["Wrong Setup","Calc/Casework Slip"]');
  assert.strictEqual(a, b);
  // Canonical order is the picker's dimension order: cause before timing.
  assert.strictEqual(
    canonicalizeMistakeTypeValue('["Ran Out of Time","Misread"]'),
    '["Misread","Ran Out of Time"]'
  );
});

test('duplicates collapse, including after mapping', () => {
  assert.deepStrictEqual(canonicalizeMistakeTags('["Misread","Misread Passage","Misread Question"]'), ['Misread']);
});

test('unknown tags are preserved and sort last', () => {
  assert.deepStrictEqual(canonicalizeMistakeTags('["Something New","Misread"]'), ['Misread', 'Something New']);
  // Legacy 'Time Trap' is deliberately unmapped: direction is only recoverable
  // from the clock, which migration 0005 handles.
  assert.deepStrictEqual(canonicalizeMistakeTags('["Time Trap"]'), ['Time Trap']);
});

test('storage shape is always a JSON array, or null when empty', () => {
  assert.strictEqual(canonicalizeMistakeTypeValue('Misread'), '["Misread"]');
  assert.strictEqual(canonicalizeMistakeTypeValue('[]'), null);
  assert.strictEqual(canonicalizeMistakeTypeValue(''), null);
  assert.strictEqual(canonicalizeMistakeTypeValue(null), null);
});

test('canonicalizing is idempotent', () => {
  const once = canonicalizeMistakeTypeValue('["Misread Passage","Overinvested Time","Misread"]');
  assert.strictEqual(canonicalizeMistakeTypeValue(once), once);
});

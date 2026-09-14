// test/unit/og-explanations.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseExplanations, canonicalTypeLabel,
} = require('../../scripts/og/explanations');

const CR = [
  '16. Which of the following best completes the passage below?',
  'People buy prestige when they buy a premium product.',
  '(A) affluent purchasers represent a shrinking portion',
  '(B) continued sales depend on an aura of exclusivity',
  '(C) purchasers are concerned with quality as well as price',
  '(D) expansion of the market niche will increase profits',
  '(E) manufacturing a premium brand is not more costly',
  'Argument Construction',
  'Situation Consumers seek prestige when they buy premium products.',
  'Reasoning The correct answer will be the option that best answers this.',
  'A This information suggests the percentage may be shrinking.',
  'B Correct. This information provides a good reason for the avoidance.',
  'C Using mass-marketing could sometimes suggest low quality.',
  'D This statement provides a reason why broader marketing should be used.',
  'E Manufacturing costs are not discussed and so are irrelevant.',
  'ThecorrectanswerisB.542',
];

test('parses a CR explanation entry end to end', () => {
  const { entries } = parseExplanations(CR);
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.number, 16);
  assert.equal(e.typeLabel, 'Argument Construction');
  assert.match(e.situation, /^Consumers seek prestige/);
  assert.match(e.reasoning, /^The correct answer will be/);
  assert.match(e.choiceNotes.B, /^Correct\./);
  assert.match(e.choiceNotes.E, /^Manufacturing costs/);
  assert.equal(e.key, 'B');
  assert.equal(e.keySource, 'both');
});

test('RC entries have no Situation/Reasoning and key off Correct. alone', () => {
  const { entries } = parseExplanations([
    '1. The primary purpose of the passage is to',
    '(A) explain why a strategy has been less successful',
    '(B) propose an alternative to a strategy',
    '(C) present a concern about the consequences',
    '(D) make a case for applying a strategy',
    '(E) suggest several possible outcomes',
    'Main idea',
    'This question requires understanding the passage as a whole.',
    'A The passage never discusses whether it is successful.',
    'B Lines 26-28 state that a new approach must be found.',
    'C Correct. After defining the term, the rest describes the concerns.',
    'D No case is made.',
    'E No outcomes are suggested.',
  ]);
  assert.equal(entries[0].typeLabel, 'Main idea');
  assert.equal(entries[0].situation, null);
  assert.match(entries[0].reasoning, /^This question requires/);
  assert.equal(entries[0].key, 'C');
  assert.equal(entries[0].keySource, 'correct-marker');
});

test('disagreeing key sources yield no key and a warning', () => {
  const lines = CR.slice(0, -1).concat(['The correct answer is D.']);
  const { entries, warnings } = parseExplanations(lines);
  assert.equal(entries[0].key, null);
  assert.ok(warnings.some(w => /16/.test(w) && /disagree/i.test(w)));
});

test('passage references are captured with their page', () => {
  const { passageRefs } = parseExplanations([
    'Questions 1-3 refer to the passage on page 358.',
    '1. The primary purpose of the passage is to',
    '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
    'Main idea',
    'Prose.',
    'A no', 'B no', 'C Correct. yes', 'D no', 'E no',
    'Questions 4-8 refer to the passage on page 360.',
    '4. Another question',
    '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
    'Inference',
    'Prose.',
    'A Correct. yes', 'B no', 'C no', 'D no', 'E no',
  ]);
  assert.deepEqual(passageRefs, [
    { firstQuestion: 1, lastQuestion: 3, page: 358 },
    { firstQuestion: 4, lastQuestion: 8, page: 360 },
  ]);
});

test('an en-dash range and "the passage above" are both accepted', () => {
  const { passageRefs } = parseExplanations([
    'Questions 1–3 refer to the passage above.',
    '1. Stem', '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
    'Main idea', 'Prose.', 'A Correct. yes', 'B n', 'C n', 'D n', 'E n',
  ]);
  assert.equal(passageRefs.length, 1);
  assert.equal(passageRefs[0].firstQuestion, 1);
  assert.equal(passageRefs[0].lastQuestion, 3);
  assert.equal(passageRefs[0].page, null);
});

test('canonicalTypeLabel folds plurals and OCR spacing', () => {
  assert.equal(canonicalTypeLabel('Supporting idea'), 'Supporting ideas');
  assert.equal(canonicalTypeLabel('Supporting ideas'), 'Supporting ideas');
  assert.equal(canonicalTypeLabel('Argument Evaluat ion'), 'Argument Evaluation');
  assert.equal(canonicalTypeLabel('Main idea'), 'Main idea');
  assert.equal(canonicalTypeLabel('A This information suggests'), null);
});

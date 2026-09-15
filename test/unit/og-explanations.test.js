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

test('entries segment on the type label, not on question numbers', () => {
  // The scans keep labels almost perfectly (124/124 for OG13 CR) and lose
  // numbers wholesale, so numbering is the wrong thing to segment on.
  const { entries } = parseExplanations([
    'A stem whose number the scan dropped.',
    '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
    'Argument Construction',
    'Reasoning Some reasoning.',
    'A no', 'B Correct. yes', 'C no', 'D no', 'E no',
    'Another stem, also unnumbered.',
    '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
    'Inference',
    'Reasoning More reasoning.',
    'A Correct. yes', 'B no', 'C no', 'D no', 'E no',
  ]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => e.position), [1, 2]);
  assert.deepEqual(entries.map(e => e.number), [null, null]);
  assert.deepEqual(entries.map(e => e.typeLabel), ['Argument Construction', 'Inference']);
  assert.deepEqual(entries.map(e => e.key), ['B', 'A']);
});

test('a rationale whose letter the scan dropped takes its place in the run', () => {
  // 120 of OG13 CR's 124 entries leave a bare "Correct." with no letter.
  const { entries } = parseExplanations([
    '1. A stem.', '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
    'Evaluation of a Plan',
    'Reasoning Some reasoning.',
    'A There is no basis in the passage.',
    'B The passage states otherwise.',
    'Correct. This statement would strengthen the prediction.',
    'D Not relevant.',
    'E Also not relevant.',
  ]);
  assert.equal(entries[0].key, 'C', 'third rationale in the run is C');
  assert.equal(entries[0].keySource, 'correct-marker');
  assert.match(entries[0].choiceNotes.C, /^Correct\./);
  assert.equal(entries[0].choiceNotes.B, 'The passage states otherwise.');
});

test('an explicit letter resyncs the run after a dropped one', () => {
  const { entries } = parseExplanations([
    '1. A stem.',
    'Inference',
    'Reasoning r.',
    'A first.',
    'Correct. second, letter lost.',
    'D fourth, letter present and out of step.',
    'E fifth.',
  ]);
  assert.equal(entries[0].key, 'B');
  assert.equal(entries[0].choiceNotes.D, 'fourth, letter present and out of step.');
});

test('a bare Correct. with nothing to anchor the run infers no letter', () => {
  // Guessing "A" because it is first would be a confidently wrong key. With no
  // explicit letter to fix the position, only the closing line can say.
  const { entries } = parseExplanations([
    '1. A stem.',
    'Inference',
    'Reasoning r.',
    'Some rationale prose whose letter the scan dropped.',
    'Correct. This one is right, but which letter is it?',
    'More prose, also letterless.',
  ]);
  assert.equal(entries[0].key, null);
  assert.equal(entries[0].keySource, null);
});

test('the closing line still keys an entry whose letters are all lost', () => {
  const { entries } = parseExplanations([
    '1. A stem.',
    'Inference',
    'Reasoning r.',
    'Letterless prose.',
    'Correct. Right answer, letter unknown.',
    'The correct answer is D.',
  ]);
  assert.equal(entries[0].key, 'D');
  assert.equal(entries[0].keySource, 'closing-line');
});

test('the printed number is kept when the scan left one', () => {
  const { entries } = parseExplanations([
    '7. A stem.', '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
    'Inference', 'Reasoning r.', 'A Correct. y', 'B n', 'C n', 'D n', 'E n',
  ]);
  assert.equal(entries[0].number, 7);
  assert.equal(entries[0].position, 1);
});

test('canonicalTypeLabel folds plurals and OCR spacing', () => {
  assert.equal(canonicalTypeLabel('Supporting idea'), 'Supporting ideas');
  assert.equal(canonicalTypeLabel('Supporting ideas'), 'Supporting ideas');
  assert.equal(canonicalTypeLabel('Argument Evaluat ion'), 'Argument Evaluation');
  assert.equal(canonicalTypeLabel('Main idea'), 'Main idea');
  assert.equal(canonicalTypeLabel('Tone'), 'Style and tone');
  assert.equal(canonicalTypeLabel('A This information suggests'), null);
});

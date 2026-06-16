/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { splitStemAndPassage } = require('../../src/scrapers/question-stem-split');

const BOILERPLATE = 'This is a multiple choice question for which you need to select 1 answer from 5 choices.';

// ---- Real-world fixture 1: CR "completes the passage" (prompt FIRST) ----
// Mirrors DB row id 14867 (ope-V188_001405). Layout: boilerplate \n prompt,
// blank lines, argument with the ____ blank, then the 5 choices.
const CR_COMPLETES_CHOICES = [
  'as machines increasingly incorporate computerized components, the diagnosis and reconstruction of failed parts is being supplanted by the substitution of new parts in repairing the machines',
  'the more complex a piece of machinery is, the more automatic control functions will be built into it, reducing the need for human monitoring',
  'as the dependability of machines increases, those operating the machines get less practice in handling malfunctions',
  'the less frequently a machine malfunctions, the more attention its operator will pay to its repair',
  'in addition to repairing their machines after a malfunction, machine operators are often responsible for regularly scheduled maintenance of their machines',
];
const CR_COMPLETES_ARGUMENT =
  "Machine operators are often responsible for repair of their machines. The more dependable a machine is, however, the less dependable is its human operator's performance in repairing occasional malfunctions of the machine, since __________.";
const CR_COMPLETES_STEM = [
  BOILERPLATE,
  'Which of the following most logically completes the passage?',
  '',
  ' ',
  '',
  CR_COMPLETES_ARGUMENT,
  ...CR_COMPLETES_CHOICES,
].join('\n');

test('CR completes-the-passage: prompt extracted, argument becomes passage, choices stripped', () => {
  const { stem, passage } = splitStemAndPassage(CR_COMPLETES_STEM, CR_COMPLETES_CHOICES);
  assert.equal(stem, 'Which of the following most logically completes the passage?');
  assert.equal(passage, CR_COMPLETES_ARGUMENT);
  // No boilerplate, and no choice text leaks into either field.
  assert.ok(!/This is a multiple choice/.test(stem + passage));
  for (const c of CR_COMPLETES_CHOICES) {
    assert.ok(!stem.includes(c) && !passage.includes(c), 'choice leaked');
  }
});

// ---- Real-world fixture 2: CR criticism (prompt LAST) ----
// Mirrors DB row id 14884. Layout: boilerplate \n argument, blank lines,
// prompt, then the 5 choices.
const CR_CRIT_CHOICES = [
  'does not address the possibility that there are reasons decades-old catch phrases remain in commercials even if the catch phrases themselves do not continue to boost sales',
  'fails to address the possibility that an advertising approach used in the past could still be effective simply because more-effective approaches have not yet been developed',
  'illicitly infers that more-effective catch phrases will not be developed in the future merely from the fact that they have not yet been developed',
  'illicitly infers that one of the primary means of pursuing advertising’s main goal should not be reevaluated merely from the fact that that goal has persisted for decades',
  'overlooks the possibility that particularly effective catch phrases remain in consumers’ memories even when they have not appeared in commercials for years',
];
const CR_CRIT_ARGUMENT =
  'The main goal of advertising is to increase sales, and using particular catch phrases in ads is one way advertisers have pursued this goal. Many of these catch phrases were developed decades ago, but they continue to this day to boost sales, as is proven by the prevalence of commercials that still use them.';
const CR_CRIT_PROMPT = 'The reasoning above is most vulnerable to the criticism that it';
const CR_CRIT_STEM = [
  BOILERPLATE,
  CR_CRIT_ARGUMENT,
  '',
  ' ',
  '',
  CR_CRIT_PROMPT,
  ...CR_CRIT_CHOICES,
].join('\n');

test('CR criticism: prompt detected even when it FOLLOWS the argument', () => {
  const { stem, passage } = splitStemAndPassage(CR_CRIT_STEM, CR_CRIT_CHOICES);
  assert.equal(stem, CR_CRIT_PROMPT);
  assert.equal(passage, CR_CRIT_ARGUMENT);
});

// ---- Real-world fixture 3: DS (no passage; statements stay in the stem) ----
const DS_CHOICES = [
  'Statement (1) ALONE is sufficient, but statement (2) alone is not sufficient.',
  'Statement (2) ALONE is sufficient, but statement (1) alone is not sufficient.',
  'BOTH statements TOGETHER are sufficient, but NEITHER statement ALONE is sufficient.',
  'EACH statement ALONE is sufficient.',
  'Statements (1) and (2) TOGETHER are NOT sufficient.',
];
const DS_STEM = [
  BOILERPLATE,
  '',
  'Pete is arranging layer upon layer of lines of brick to build a wall. How many bricks will Pete need for the wall?',
  '',
  '(1)   The pieces at both ends of the top layer are full bricks.',
  '',
  '(2)   The combined height of twenty-two bricks equals the height of the wall.',
  '',
  ...DS_CHOICES,
].join('\n');

test('DS: boilerplate + standard 5 choices stripped, no passage split, statements preserved', () => {
  const { stem, passage } = splitStemAndPassage(DS_STEM, DS_CHOICES);
  assert.equal(passage, '');
  assert.ok(!/This is a multiple choice/.test(stem));
  assert.ok(stem.includes('Pete is arranging'));
  assert.ok(stem.includes('(1)') && stem.includes('(2)'), 'both statements kept in stem');
  for (const c of DS_CHOICES) assert.ok(!stem.includes(c), 'DS choice leaked into stem');
});

// ---- Real-world fixture 4: RC prompt-only stem (argument lives elsewhere) ----
const RC_CHOICES = [
  'is one of at least several long works of fiction by Villegas de Magnón',
  'was published first in Spanish and then years later in an English-language version',
  'contains descriptions of real-life events',
  'was written in Mexico before 1920 and later published in the U.S.',
  'was published in 1994 in a version that was heavily revised from the 1940s version',
];
const RC_STEM = [
  BOILERPLATE,
  'The passage most strongly suggests that The Rebel',
  ...RC_CHOICES,
].join('\n');

test('RC prompt-only: choices stripped, prompt kept as stem, no fabricated passage', () => {
  const { stem, passage } = splitStemAndPassage(RC_STEM, RC_CHOICES);
  assert.equal(stem, 'The passage most strongly suggests that The Rebel');
  assert.equal(passage, '');
});

// ---- Idempotency: re-running on cleaned output is a no-op ----
test('idempotent: feeding a cleaned stem back yields the same stem and empty passage', () => {
  const first = splitStemAndPassage(CR_COMPLETES_STEM, CR_COMPLETES_CHOICES);
  const second = splitStemAndPassage(first.stem, CR_COMPLETES_CHOICES);
  assert.equal(second.stem, first.stem);
  assert.equal(second.passage, '');
});

// ---- Edge cases ----
test('empty / nullish input returns empty fields', () => {
  assert.deepEqual(splitStemAndPassage('', []), { stem: '', passage: '' });
  assert.deepEqual(splitStemAndPassage(null, []), { stem: '', passage: '' });
  assert.deepEqual(splitStemAndPassage(undefined), { stem: '', passage: '' });
});

test('no choices supplied: strips boilerplate but does NOT extract a passage', () => {
  // Without choice texts we cannot tell a trailing choice block from an
  // argument, so passage extraction is suppressed and everything stays in the
  // stem (boilerplate still removed). This guards image/roman-numeral choices
  // (text:null) from having their option block misread as a passage.
  const { stem, passage } = splitStemAndPassage(
    `${BOILERPLATE}\n${CR_CRIT_ARGUMENT}\n\n${CR_CRIT_PROMPT}`,
    []
  );
  assert.equal(passage, '');
  assert.ok(!/This is a multiple choice/.test(stem));
  assert.ok(stem.includes(CR_CRIT_PROMPT) && stem.includes('The main goal of advertising'));
});

test('image/roman-numeral choices (text:null) get boilerplate stripped, no fake passage', () => {
  // Mirrors PS row 13575: roman-numeral options live in the stem but are stored
  // as text:null, so nothing can be stripped and no passage may be invented.
  const stemIn = [
    BOILERPLATE,
    'If x > y > 0, which of the following must be negative?',
    '',
    'I only',
    'II only',
    'III only',
  ].join('\n');
  const { stem, passage } = splitStemAndPassage(stemIn, []); // text:null -> [] after filter(Boolean)
  assert.equal(passage, '');
  assert.ok(!/This is a multiple choice/.test(stem));
  assert.ok(stem.includes('which of the following must be negative'));
});

test('single clean block (already prompt-only, no boilerplate) is returned untouched', () => {
  const { stem, passage } = splitStemAndPassage('Which of the following most weakens the argument?', []);
  assert.equal(stem, 'Which of the following most weakens the argument?');
  assert.equal(passage, '');
});

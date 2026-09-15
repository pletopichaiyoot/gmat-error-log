// test/unit/og-assemble.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { assembleSection, matchExplanations } = require('../../scripts/og/assemble');
const { bookByCode } = require('../../scripts/og/books');

const OG13 = bookByCode('OG13');

const choices = 'ABCDE'.split('').map(l => ({ label: l, text: l.toLowerCase() }));
const q = (number, over = {}) => ({ number, stem: `Stem ${number}.`, choices, ...over });
const e = (position, over = {}) => ({
  position, number: position, typeLabel: 'Inference', situation: null,
  reasoning: 'r', choiceNotes: { A: 'Correct. y' }, key: 'A',
  keySource: 'correct-marker', ...over,
});

test('numbered explanations match their question by number', () => {
  const m = matchExplanations([q(1), q(2), q(3)], [e(3), e(1), e(2)]);
  assert.equal(m.get(1).number, 1);
  assert.equal(m.get(3).number, 3);
});

test('unnumbered explanations fill the remaining questions in order', () => {
  // OG13 CR keeps only 97 of 124 printed numbers in its explanations.
  const m = matchExplanations(
    [q(1), q(2), q(3), q(4)],
    [e(1, { number: null }), e(2, { number: 2 }), e(3, { number: null }), e(4, { number: null })]);
  assert.equal(m.get(2).position, 2, 'the numbered one is placed by its number');
  assert.equal(m.get(1).position, 1);
  assert.equal(m.get(3).position, 3);
  assert.equal(m.get(4).position, 4);
});

test('a number the practice section does not have is not forced on', () => {
  const m = matchExplanations([q(1), q(2)], [e(1), e(2), e(9)]);
  assert.equal(m.size, 2);
});

test('assembles a question with both key sources agreeing', () => {
  const { section, stats } = assembleSection({
    book: OG13, kind: 'CR', questions: [q(1)], keys: new Map([[1, 'A']]),
    explanations: [e(1)], passageRefs: [],
  });
  const out = section.questions[0];
  assert.equal(out.id, 'OG13-CR-1');
  assert.equal(out.correct, 'A');
  assert.equal(out.keySource, 'printed+explanation');
  assert.equal(out.keyDisputed, false);
  assert.equal(out.typeLabel, 'Inference');
  assert.equal(out.explanation.reasoning, 'r');
  assert.deepEqual(out.refs, [{ book: 'OG13', number: 1 }]);
  assert.equal(stats.keyed, 1);
  assert.equal(stats.disputed, 0);
});

test('an unreadable printed key falls back to the explanation key', () => {
  // This is OG13 CR: its printed key is a rotated table the scan destroyed.
  const { section, stats } = assembleSection({
    book: OG13, kind: 'CR', questions: [q(1)], keys: new Map(),
    explanations: [e(1)], passageRefs: [],
  });
  assert.equal(section.questions[0].correct, 'A');
  assert.equal(section.questions[0].keySource, 'explanation');
  assert.equal(stats.keyed, 1);
});

test('disagreeing keys leave the question unkeyed and disputed', () => {
  const { section, stats, warnings } = assembleSection({
    book: OG13, kind: 'CR', questions: [q(1)], keys: new Map([[1, 'D']]),
    explanations: [e(1)], passageRefs: [],
  });
  assert.equal(section.questions[0].correct, null);
  assert.equal(section.questions[0].keyDisputed, true);
  assert.equal(stats.disputed, 1);
  assert.equal(stats.keyed, 0);
  assert.ok(warnings.some(w => /OG13-CR-1/.test(w)));
});

test('a question with no explanation still carries its printed key', () => {
  const { section, stats } = assembleSection({
    book: OG13, kind: 'CR', questions: [q(1), q(2)], keys: new Map([[1, 'A'], [2, 'B']]),
    explanations: [e(1)], passageRefs: [],
  });
  assert.equal(section.questions[1].correct, 'B');
  assert.equal(section.questions[1].keySource, 'printed');
  assert.equal(section.questions[1].typeLabel, null);
  assert.equal(stats.labelled, 1);
});

test('a question is usable only when it is actually answerable', () => {
  // The repo's curation rules (CLAUDE.md): a gradeable row needs a non-empty
  // stem, five choices with text, and a key. A disputed key is not a key.
  const blank = [{ label: 'A', text: 'a' }, { label: 'B', text: '  ' },
    { label: 'C', text: 'c' }, { label: 'D', text: 'd' }, { label: 'E', text: 'e' }];
  const { section, stats } = assembleSection({
    book: OG13, kind: 'CR',
    questions: [q(1), q(2, { choices: choices.slice(0, 3) }), q(3), q(4, { stem: '' }),
      q(5, { choices: blank })],
    keys: new Map([[1, 'A'], [2, 'A'], [3, 'D'], [4, 'A'], [5, 'A']]),
    explanations: [e(1), e(2), e(3), e(4), e(5)],
    passageRefs: [],
  });
  const usable = section.questions.filter(x => x.usable).map(x => x.number);
  assert.deepEqual(usable, [1], 'only the complete, agreed, five-choice question');
  assert.equal(section.questions[1].unusable, 'choices');
  assert.equal(section.questions[2].unusable, 'key-disputed');
  assert.equal(section.questions[3].unusable, 'stem');
  assert.equal(section.questions[4].unusable, 'blank-choice');
  assert.equal(stats.usable, 1);
});

test('an RC question with no passage is not usable', () => {
  // Reading Comprehension without its passage is unanswerable. Passages are
  // attached by the pdfplumber pass, so until it runs RC is not practiceable.
  const { section, stats } = assembleSection({
    book: OG13, kind: 'RC', questions: [q(1)], keys: new Map([[1, 'A']]),
    explanations: [e(1)], passageRefs: [],
  });
  assert.equal(section.questions[0].usable, false);
  assert.equal(section.questions[0].unusable, 'no-passage');
  assert.equal(stats.usable, 0);
});

test('an RC question with a passage is usable', () => {
  const { section } = assembleSection({
    book: OG13, kind: 'RC', questions: [q(1, { passageId: 'OG13-RC-p358' })],
    keys: new Map([[1, 'A']]), explanations: [e(1)], passageRefs: [],
  });
  assert.equal(section.questions[0].usable, true);
});

test('CR needs no passage', () => {
  const { section } = assembleSection({
    book: OG13, kind: 'CR', questions: [q(1)], keys: new Map([[1, 'A']]),
    explanations: [e(1)], passageRefs: [],
  });
  assert.equal(section.questions[0].usable, true);
});

test('a choice wildly longer than its siblings is not a real option', () => {
  // Residual scan damage glues following text onto a choice. A real A-E set is
  // roughly even in length; one option many times the rest is not answerable.
  const lopsided = [
    { label: 'A', text: 'a short option' },
    { label: 'B', text: 'another short option' },
    { label: 'C', text: 'a third short option' },
    { label: 'D', text: 'a fourth short option' },
    { label: 'E', text: 'x'.repeat(600) },
  ];
  const { section } = assembleSection({
    book: OG13, kind: 'CR', questions: [q(1, { choices: lopsided })],
    keys: new Map([[1, 'A']]), explanations: [e(1)], passageRefs: [],
  });
  assert.equal(section.questions[0].usable, false);
  assert.equal(section.questions[0].unusable, 'lopsided-choice');
});

test('a legitimately long choice set is kept', () => {
  const long = 'ABCDE'.split('').map(l => ({ label: l, text: `${l} `.repeat(90) }));
  const { section } = assembleSection({
    book: OG13, kind: 'CR', questions: [q(1, { choices: long })],
    keys: new Map([[1, 'A']]), explanations: [e(1)], passageRefs: [],
  });
  assert.equal(section.questions[0].usable, true);
});

test('passageRefs ride along on the section', () => {
  const refs = [{ firstQuestion: 1, lastQuestion: 3, page: 358 }];
  const { section } = assembleSection({
    book: OG13, kind: 'RC', questions: [q(1)], keys: new Map([[1, 'A']]),
    explanations: [e(1)], passageRefs: refs,
  });
  assert.deepEqual(section.passageRefs, refs);
});

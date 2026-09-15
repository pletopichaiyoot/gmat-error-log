// test/unit/og-assemble.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { assembleSection, matchExplanations } = require('../../scripts/og/assemble');
const { bookByCode } = require('../../scripts/og/books');

const OG13 = bookByCode('OG13');

const choices = 'ABCDE'.split('').map(l => ({ label: l, text: `the ${l} option` }));
const q = (number, over = {}) => ({ number, stem: `Stem ${number}.`, choices, ...over });
const e = (position, over = {}) => ({
  position, number: position, typeLabel: 'Inference', situation: null,
  reasoning: 'r', choiceNotes: { A: 'Correct. y' }, key: 'A',
  keySource: 'correct-marker', ...over,
});

test('a question whose number was inferred matches on its text, not its number', () => {
  // VR2's RC scan loses numbers, so the parser infers them and they drift out
  // of step with the explanations. Matching on the number paired a "primary
  // purpose" question with the explanation for a different one — wrong type
  // label, wrong rationale, and a key the cross-check then reported as
  // disputed.
  const questions = [
    { number: 61, stem: 'The primary purpose of the passage is to', choices, numberInferred: true },
    { number: 62, stem: 'According to the passage, the earliest research produced which?', choices, numberInferred: true },
  ];
  const entries = [
    e(1, { number: 62, questionBlock: ['62. According to the passage, the earliest research produced which?'] }),
    e(2, { number: 63, questionBlock: ['63. The primary purpose of the passage is to'] }),
  ];
  const m = matchExplanations(questions, entries);
  assert.equal(m.get(61).number, 63, 'paired on the stem it actually reprints');
  assert.equal(m.get(62).number, 62);
});

test('an explanation that reprints a different question is not attached', () => {
  // A wrong type label and rationale is worse than none: it silently corrupts
  // the drill taxonomy and attaches another question's reasoning.
  const questions = [{ number: 62, stem: 'The primary purpose of the passage is to', choices }];
  const entries = [e(1, {
    number: 62, typeLabel: 'Supporting ideas',
    questionBlock: ['62. According to the passage, the earliest research on mangrove forests produced which of the following?'],
  })];
  const { section, warnings } = assembleSection({
    book: OG13, kind: 'CR', questions, keys: new Map([[62, 'B']]),
    explanations: entries, passageRefs: [],
  });
  const out = section.questions[0];
  assert.equal(out.typeLabel, null, 'no label rather than the wrong one');
  assert.equal(out.explanation, null);
  assert.equal(out.correct, 'B', 'the printed key still stands');
  assert.equal(out.keySource, 'printed');
  assert.ok(warnings.some(w => /OG13-CR-62/.test(w) && /different question/i.test(w)));
});

test('a pairing survives ordinary OCR differences between the two copies', () => {
  const questions = [{ number: 1, stem: 'The primary purpose of the passage is to', choices }];
  const entries = [e(1, {
    number: 1,
    questionBlock: ['1. The primarypurpose of thepassage isto'],
  })];
  const { section } = assembleSection({
    book: OG13, kind: 'CR', questions, keys: new Map([[1, 'A']]),
    explanations: entries, passageRefs: [],
  });
  assert.equal(section.questions[0].typeLabel, 'Inference');
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

test('a choice cut off mid-phrase is not answerable', () => {
  // The scans truncate a choice at a line break: 58 of 448 end on a dangling
  // "to", "of" or "and" with no terminal punctuation.
  const cut = [
    { label: 'A', text: 'a complete option.' },
    { label: 'B', text: 'another complete option.' },
    { label: 'C', text: 'a third complete option.' },
    { label: 'D', text: 'a fourth complete option.' },
    { label: 'E', text: 'Immigration Service reports from 1914 to' },
  ];
  const { section } = assembleSection({
    book: OG13, kind: 'CR', questions: [q(1, { choices: cut })],
    keys: new Map([[1, 'A']]), explanations: [e(1)], passageRefs: [],
  });
  assert.equal(section.questions[0].usable, false);
  assert.equal(section.questions[0].unusable, 'truncated-choice');
});

test('a short but complete choice is kept', () => {
  // "Size" and "evaluation of a problem" are real RC options; only a dangling
  // function word with no terminal punctuation means truncation.
  const short = [
    { label: 'A', text: 'Size' },
    { label: 'B', text: 'evaluation of a problem' },
    { label: 'C', text: 'records where they came from.' },
    { label: 'D', text: 'a fourth option' },
    { label: 'E', text: 'a fifth option' },
  ];
  const { section } = assembleSection({
    book: OG13, kind: 'CR', questions: [q(1, { choices: short })],
    keys: new Map([[1, 'A']]), explanations: [e(1)], passageRefs: [],
  });
  assert.equal(section.questions[0].usable, true);
});

test('a truncated choice is repaired from the explanation copy', () => {
  // The explanations reprint the question in single-column flow, so the copy
  // survives where the two-column practice section cut it at a line break.
  const cut = [
    { label: 'A', text: 'refute the idea' },
    { label: 'B', text: 'describe the pattern' },
    { label: 'C', text: 'argue that Davis' },
    { label: 'D', text: 'discuss hypotheses' },
    { label: 'E', text: 'establish that plants that do well in saline forest' },
  ];
  const entry = e(1, {
    questionBlock: [
      '1. The primary purpose of the passage is to',
      '(A) refute the idea', '(B) describe the pattern', '(C) argue that Davis',
      '(D) discuss hypotheses',
      '(E) establish that plants that do well in saline forest',
      'environments require salt to achieve maximum',
      'metabolic efficiency',
    ],
  });
  const { section } = assembleSection({
    book: OG13, kind: 'CR', questions: [q(1, { choices: cut })],
    keys: new Map([[1, 'A']]), explanations: [entry], passageRefs: [],
  });
  const out = section.questions[0];
  assert.equal(out.usable, true);
  assert.equal(out.choicesSource, 'explanation');
  assert.match(out.choices[4].text, /metabolic efficiency$/);
});

test('a repair is refused when the explanation copy is cut the same way', () => {
  // Both renderings agree, so there is no evidence of a cut to repair from.
  // The dangling-function-word fallback still rejects the question.
  const bad = [
    { label: 'A', text: 'one complete.' }, { label: 'B', text: 'two complete.' },
    { label: 'C', text: 'three complete.' }, { label: 'D', text: 'four complete.' },
    { label: 'E', text: 'Immigration Service reports from 1914 to' },
  ];
  const entry = e(1, { questionBlock: [
    '1. Stem.', '(A) one complete.', '(B) two complete.', '(C) three complete.',
    '(D) four complete.', '(E) Immigration Service reports from 1914 to',
  ] });
  const { section } = assembleSection({
    book: OG13, kind: 'CR', questions: [q(1, { choices: bad })],
    keys: new Map([[1, 'A']]), explanations: [entry], passageRefs: [],
  });
  assert.equal(section.questions[0].usable, false);
  assert.equal(section.questions[0].unusable, 'truncated-choice');
});

test('a repair appends the missing tail and keeps the better spacing', () => {
  // The reprint often comes from a worse OCR pass ("plantsthat dowell"), so
  // replacing the whole choice trades a cut for glued words. Only the part
  // that was cut off is taken.
  const cut = [
    { label: 'A', text: 'refute the idea that zonation is caused by salinity' },
    { label: 'B', text: 'describe the pattern of zonation in mangrove forests' },
    { label: 'C', text: 'argue that the paradigm cannot be applied here' },
    { label: 'D', text: 'discuss hypotheses that explain the zonation' },
    { label: 'E', text: 'establish that plants that do well in saline forest' },
  ];
  const reprint = e(1, { number: 1, questionBlock: [
    '1. The primary purpose of the passage is to',
    '(A) refute the idea that zonation is caused by salinity',
    '(B) describe the pattern of zonation in mangrove forests',
    '(C) argue that the paradigm cannot be applied here',
    '(D) discuss hypotheses that explain the zonation',
    '(E) establish that plantsthat dowell insalineforest environments require salt',
  ] });
  const { section } = assembleSection({
    book: OG13, kind: 'CR', questions: [q(1, { choices: cut })],
    keys: new Map([[1, 'B']]), explanations: [reprint], passageRefs: [],
  });
  const E = section.questions[0].choices[4].text;
  assert.match(E, /^establish that plants that do well in saline forest/,
    'the practice rendering is kept');
  assert.match(E, /environments require salt$/, 'the cut-off tail is appended');
});

test('good choices are never replaced by the explanation copy', () => {
  const entry = e(1, { questionBlock: [
    '1. Stem.', '(A) a different rendering', '(B) b', '(C) c', '(D) d', '(E) e',
  ] });
  const { section } = assembleSection({
    book: OG13, kind: 'CR', questions: [q(1)],
    keys: new Map([[1, 'A']]), explanations: [entry], passageRefs: [],
  });
  assert.equal(section.questions[0].choices[0].text, 'the A option');
  assert.equal(section.questions[0].choicesSource, undefined);
});

test('a section with no printed key and guessed numbering is not trusted', () => {
  // OG13's CR section: its printed key is a table the scan destroyed, and its
  // question numbers are inferred, so explanations are matched to questions by
  // a guess. Checked against OG12, which reprints 49 of the same questions
  // with double-confirmed keys, only 3 of its surviving keys agreed and 4
  // disagreed — worse than no key at all.
  const questions = [1, 2, 3, 4].map(n => (
    { number: n, stem: `Stem ${n} which of the following most weakens it?`, choices,
      numberInferred: true }));
  const { section, stats, warnings } = assembleSection({
    book: OG13, kind: 'CR', questions, keys: new Map(),
    explanations: questions.map((_, i) => e(i + 1, { number: i + 1 })),
    passageRefs: [],
  });
  assert.equal(stats.usable, 0);
  assert.ok(section.questions.every(q => q.unusable === 'unverifiable-key'));
  assert.ok(warnings.some(w => /cannot be cross-checked/i.test(w)));
});

test('a section with a printed key is trusted even when numbering is inferred', () => {
  // The printed key cross-checks the pairing, so a guessed number is survivable.
  const questions = [1, 2].map(n => (
    { number: n, stem: `Stem ${n} which of the following most weakens it?`, choices,
      numberInferred: true }));
  const { stats } = assembleSection({
    book: OG13, kind: 'CR', questions, keys: new Map([[1, 'A'], [2, 'A']]),
    explanations: questions.map((_, i) => e(i + 1, { number: i + 1 })),
    passageRefs: [],
  });
  assert.equal(stats.usable, 2);
});

test('choices are repaired from whichever explanation reprints them', () => {
  // The repair must not depend on the number pairing: VR2-RC-62's choices were
  // cut, and the entry that reprints them was NOT the one its number matched.
  const cut = [
    { label: 'A', text: 'refute the idea that zonation is caused by salinity' },
    { label: 'B', text: 'describe the pattern of zonation in Florida mangrove forests' },
    { label: 'C', text: 'argue that the succession paradigm cannot be applied' },
    { label: 'D', text: 'discuss hypotheses that explain the zonation of forests' },
    { label: 'E', text: 'establish that plants that do well in saline forest' },
  ];
  const wrongPairing = e(1, { number: 1, typeLabel: 'Inference',
    questionBlock: ['1. According to the passage, the earliest research produced which?',
      '(A) something else entirely here', '(B) b', '(C) c', '(D) d', '(E) e'] });
  const reprint = e(2, { number: 2, typeLabel: 'Main idea', questionBlock: [
    '2. The primary purpose of the passage is to',
    '(A) refute the idea that zonation is caused by salinity',
    '(B) describe the pattern of zonation in Florida mangrove forests',
    '(C) argue that the succession paradigm cannot be applied',
    '(D) discuss hypotheses that explain the zonation of forests',
    '(E) establish that plants that do well in saline forest',
    'environments require salt to achieve maximum',
    'metabolic efficiency',
  ] });
  const { section } = assembleSection({
    book: OG13, kind: 'CR',
    questions: [q(1, { stem: 'The primary purpose of the passage is to', choices: cut })],
    keys: new Map([[1, 'B']]), explanations: [wrongPairing, reprint], passageRefs: [],
  });
  const out = section.questions[0];
  assert.match(out.choices[4].text, /metabolic efficiency$/, 'repaired from the reprint');
  assert.equal(out.choicesSource, 'explanation');
  assert.equal(out.usable, true);
});

test('passageRefs ride along on the section', () => {
  const refs = [{ firstQuestion: 1, lastQuestion: 3, page: 358 }];
  const { section } = assembleSection({
    book: OG13, kind: 'RC', questions: [q(1)], keys: new Map([[1, 'A']]),
    explanations: [e(1)], passageRefs: refs,
  });
  assert.deepEqual(section.passageRefs, refs);
});

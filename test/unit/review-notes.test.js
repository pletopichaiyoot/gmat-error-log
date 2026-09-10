/* global require */
const test = require('node:test');
const assert = require('node:assert');

let parseReviewNotes;
let serializeReviewNotes;
let parseRule;
let formatRule;
let collectRules;
let rollupRules;
test.before(async () => {
  ({ parseReviewNotes, serializeReviewNotes, parseRule, formatRule, collectRules, rollupRules } = await import(
    '../../client/src/lib/reviewNotes.mjs'
  ));
});

test('parses the three slots out of a serialized note', () => {
  const parsed = parseReviewNotes(
    'What happened: Read "at least" as "exactly".\n\nTakeaway: Circle quantifiers.\n\nNext time: Restate the stem before solving.'
  );
  assert.deepEqual(parsed, {
    happened: 'Read "at least" as "exactly".',
    takeaway: 'Circle quantifiers.',
    next: 'Restate the stem before solving.',
    other: '',
  });
});

test('keeps a legacy free-form note in the other slot, byte-identical on re-save', () => {
  const legacy = 'guessed between B and D, picked wrong\nsecond line';
  const parsed = parseReviewNotes(legacy);
  assert.equal(parsed.other, legacy);
  assert.equal(parsed.happened, '');
  assert.equal(serializeReviewNotes(parsed), legacy);
});

test('round-trips multi-line slot values and a labelled other slot', () => {
  const values = {
    happened: 'line one\nline two',
    takeaway: 'Weighted average shortcut.',
    next: '',
    other: 'ask tutor about case 3',
  };
  assert.deepEqual(parseReviewNotes(serializeReviewNotes(values)), values);
});

test('labels are case-insensitive and tolerate loose spacing', () => {
  const parsed = parseReviewNotes('what happened :  rushed\nTAKEAWAY: slow down');
  assert.equal(parsed.happened, 'rushed');
  assert.equal(parsed.takeaway, 'slow down');
});

test('a value on the line after its label still belongs to that slot', () => {
  const parsed = parseReviewNotes('Next time:\n  cap at 2.5 min and move');
  assert.equal(parsed.next, 'cap at 2.5 min and move');
});

test('empty input and an all-empty save produce an empty note', () => {
  assert.deepEqual(parseReviewNotes('   '), { happened: '', takeaway: '', next: '', other: '' });
  assert.equal(serializeReviewNotes({ happened: '  ', takeaway: '', next: '', other: '' }), '');
  assert.equal(serializeReviewNotes(null), '');
});

test('a rule round-trips through its trigger and action halves', () => {
  const rule = { when: 'a DS stem gives only ratios and asks for an absolute value', then: 'hunt for an anchor before considering C' };
  const line = formatRule(rule);
  assert.equal(line, 'When a DS stem gives only ratios and asks for an absolute value \u2192 hunt for an anchor before considering C');
  assert.deepEqual(parseRule(line), rule);
});

test('a rule survives an ASCII arrow and a missing When', () => {
  assert.deepEqual(parseRule('TPA columns look symmetric -> re-read both headers aloud'), {
    when: 'TPA columns look symmetric',
    then: 're-read both headers aloud',
  });
});

test('a legacy triggerless note becomes the action half, never a fake trigger', () => {
  assert.deepEqual(parseRule('slow down on quantifiers'), { when: '', then: 'slow down on quantifiers' });
  assert.equal(formatRule({ when: '', then: 'slow down on quantifiers' }), 'slow down on quantifiers');
});

test('formatRule keeps a half-written rule instead of dropping it', () => {
  assert.equal(formatRule({ when: 'RC first question', then: '' }), 'When RC first question');
  assert.equal(formatRule({}), '');
});

test('collectRules counts repeats of the same trigger, most-used first', () => {
  const rows = [
    { notes: 'Next time: When ratios only -> find an anchor' },
    { notes: 'What happened: rushed\n\nNext time: When RATIOS ONLY \u2192 find an anchor' },
    { notes: 'Next time: When the clock passes 2:30 \u2192 pick and move' },
    { notes: 'no rule here' },
    { notes: '' },
  ];
  assert.deepEqual(collectRules(rows), [
    { when: 'ratios only', then: 'find an anchor', hits: 2 },
    { when: 'the clock passes 2:30', then: 'pick and move', hits: 1 },
  ]);
});

const ANCHOR = 'When ratios only \u2192 find an anchor';

test('rollupRules separates hits from distinct questions', () => {
  const rows = [
    { notes: `Next time: ${ANCHOR}`, q_code: 'q1', category_code: 'DS', subject_code: 'DI', session_date: '2026-08-01' },
    // Same question, redone later — a second hit, not a second lesson.
    { notes: `Next time: ${ANCHOR}`, q_code: 'q1', category_code: 'DS', subject_code: 'DI', session_date: '2026-09-01' },
    { notes: `Next time: ${ANCHOR}`, q_code: 'q2', category_code: 'GI', subject_code: 'DI', session_date: '2026-08-15' },
  ];
  const [rule] = rollupRules(rows);
  assert.equal(rule.hits, 3);
  assert.equal(rule.questions, 2);
  assert.deepEqual(rule.categories, ['DS', 'GI']);
  assert.deepEqual(rule.subjects, ['DI']);
  assert.equal(rule.firstSeen, '2026-08-01');
  assert.equal(rule.lastSeen, '2026-09-01');
  assert.deepEqual(rule.sampleQCodes, ['q1', 'q2']);
});

test('rollupRules takes the wording from the most recent row', () => {
  const rows = [
    { notes: 'Next time: When ratios only \u2192 find an anchor', session_date: '2026-08-01' },
    { notes: 'Next time: When RATIOS  ONLY \u2192 build two valid values before you pick C', session_date: '2026-09-01' },
  ];
  const [rule] = rollupRules(rows);
  assert.equal(rule.hits, 2);
  assert.equal(rule.when, 'RATIOS  ONLY');
  assert.equal(rule.then, 'build two valid values before you pick C');
});

test('rollupRules ranks by hits, then by most recent', () => {
  const rows = [
    { notes: 'Next time: When A \u2192 do a', session_date: '2026-01-01' },
    { notes: 'Next time: When B \u2192 do b', session_date: '2026-09-01' },
    { notes: 'Next time: When B \u2192 do b', session_date: '2026-09-02' },
    { notes: 'Next time: When C \u2192 do c', session_date: '2026-05-01' },
  ];
  assert.deepEqual(rollupRules(rows).map((rule) => rule.when), ['B', 'C', 'A']);
});

test('rollupRules tolerates a Date session_date and rows with no rule', () => {
  const rows = [
    { notes: `Next time: ${ANCHOR}`, q_code: 'q1', session_date: new Date('2026-09-03T00:00:00Z') },
    { notes: 'What happened: rushed', q_code: 'q2', session_date: new Date('2026-09-04T00:00:00Z') },
    { notes: '', q_code: 'q3', session_date: null },
  ];
  const rules = rollupRules(rows);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].lastSeen, '2026-09-03');
});

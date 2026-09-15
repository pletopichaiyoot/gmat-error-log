// test/unit/og-dedup.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { fingerprint, questionKey, dedupPool } = require('../../scripts/og/dedup');

test('fingerprint ignores punctuation, case and spacing', () => {
  assert.equal(
    fingerprint('Kale has more nutritional value than spinach.'),
    fingerprint('kale  has more, nutritional value than spinach'));
});

test('fingerprint matches a stem whose scan glued its words', () => {
  // OG13 and VR2 lose spaces wholesale, so the same question reprinted in two
  // editions must still fingerprint alike.
  assert.equal(
    fingerprint('The argument is concerned with what happens when people move.'),
    fingerprint('Theargumentisconcerned with whathappens whenpeople move.'));
});

test('a leading fragment from the scan does not hide a duplicate', () => {
  // OG13's CR stems open with a fragment of the previous question, which
  // shifts any prefix-based key. Anchoring on the stem's END survives it.
  const clean = { stem: 'Homeowners aged 40 to 50 are more likely to purchase ice cream in larger amounts. Which of the following most weakens the argument?',
    choices: [{ label: 'A', text: 'Ice cream is cheaper in summer.' }] };
  const scanned = { stem: 'problem of water shortage Homeowners aged 40 to 50 are more likely to purchase ice cream in larger amounts. Which of the following most weakens the argument?',
    choices: [{ label: 'A', text: 'Ice cream is cheaper in summer.' }] };
  assert.equal(questionKey(clean), questionKey(scanned));
});

test('two questions sharing a boilerplate ending stay distinct', () => {
  // Many CR stems end "which of the following most weakens the argument?" —
  // the ending alone collided 16 times inside OG12 CR, so the first choice
  // is part of the key.
  const a = { stem: 'Kale has more nutritional value than spinach. Which of the following most weakens the argument?',
    choices: [{ label: 'A', text: 'Collard greens are cheaper.' }] };
  const b = { stem: 'Rainfall in Parland has declined. Which of the following most weakens the argument?',
    choices: [{ label: 'A', text: 'Alligators prey on fish.' }] };
  assert.notEqual(questionKey(a), questionKey(b));
});

test('a question with no choices falls back to its whole stem', () => {
  const q = { stem: 'A stem with no choices at all.', choices: [] };
  assert.equal(questionKey(q), fingerprint(q.stem));
});

test('fingerprint separates genuinely different stems', () => {
  assert.notEqual(fingerprint('Kale has more nutritional value than spinach.'),
                  fingerprint('Collard greens have more nutritional value.'));
});

const cr = (book, n, stem) => ({
  id: `${book}-CR-${n}`, number: n, stem, choices: [], correct: 'A',
  usable: true, refs: [{ book, number: n }],
});
const rc = (book, n, stem, pid) => ({
  id: `${book}-RC-${n}`, number: n, stem, choices: [], correct: 'A',
  usable: true, passageId: pid, refs: [{ book, number: n }],
});

const pool = () => ({ books: [
  { code: 'OG13', title: 'thirteenth', sections: [
    { kind: 'CR', passageRefs: [], questions: [
      cr('OG13', 1, 'Shared stem about kale.'), cr('OG13', 2, 'Unique to thirteen.')] },
    { kind: 'RC', passageRefs: [],
      passages: [{ id: 'OG13-RC-p358', text: 'A passage about ecoefficiency.' }],
      questions: [rc('OG13', 1, 'Primary purpose?', 'OG13-RC-p358'),
        rc('OG13', 2, 'Author implies?', 'OG13-RC-p358')] },
  ] },
  { code: 'OG12', title: 'twelfth', sections: [
    { kind: 'CR', passageRefs: [], questions: [
      cr('OG12', 9, 'Shared stem about kale.'), cr('OG12', 10, 'Unique to twelve.')] },
    { kind: 'RC', passageRefs: [],
      passages: [{ id: 'OG12-RC-p120', text: 'A passage about ecoefficiency.' }],
      questions: [rc('OG12', 5, 'Primary purpose?', 'OG12-RC-p120'),
        rc('OG12', 6, 'Something else?', 'OG12-RC-p120')] },
  ] },
] });

test('a duplicated CR question survives once, in the preferred edition', () => {
  const { pool: out, report } = dedupPool(pool(), { prefer: ['OG13', 'OG12'] });
  const og13 = out.books.find(b => b.code === 'OG13').sections.find(s => s.kind === 'CR');
  const og12 = out.books.find(b => b.code === 'OG12').sections.find(s => s.kind === 'CR');
  assert.deepEqual(og13.questions.map(q => q.id), ['OG13-CR-1', 'OG13-CR-2']);
  assert.deepEqual(og12.questions.map(q => q.id), ['OG12-CR-10']);
  assert.equal(report.crDropped, 1);
});

test('the survivor records where else it was printed', () => {
  const { pool: out } = dedupPool(pool(), { prefer: ['OG13', 'OG12'] });
  const kept = out.books[0].sections[0].questions.find(q => q.id === 'OG13-CR-1');
  assert.deepEqual(kept.refs, [{ book: 'OG13', number: 1 }, { book: 'OG12', number: 9 }]);
});

test('a shared RC passage drops its whole group, never part of it', () => {
  const { pool: out, report } = dedupPool(pool(), { prefer: ['OG13', 'OG12'] });
  const og12 = out.books.find(b => b.code === 'OG12').sections.find(s => s.kind === 'RC');
  assert.equal(og12.questions.length, 0,
    'the whole OG12 group goes, including its non-matching question');
  assert.equal(og12.passages.length, 0);
  assert.equal(report.rcGroupsDropped, 1);
  const og13 = out.books.find(b => b.code === 'OG13').sections.find(s => s.kind === 'RC');
  assert.equal(og13.questions.length, 2);
});

test('preference decides which edition keeps the copy', () => {
  const { pool: out } = dedupPool(pool(), { prefer: ['OG12', 'OG13'] });
  const og12 = out.books.find(b => b.code === 'OG12').sections.find(s => s.kind === 'CR');
  assert.ok(og12.questions.some(q => q.id === 'OG12-CR-9'));
});

test('an unusable duplicate never displaces a usable one', () => {
  // A question the scan mangled should not win the slot just because its
  // edition is preferred.
  const p = pool();
  p.books[0].sections[0].questions[0].usable = false;
  const { pool: out } = dedupPool(p, { prefer: ['OG13', 'OG12'] });
  const kept = out.books.flatMap(b => b.sections.filter(s => s.kind === 'CR')
    .flatMap(s => s.questions)).filter(q => /kale/i.test(q.stem));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 'OG12-CR-9', 'the usable copy survives');
});

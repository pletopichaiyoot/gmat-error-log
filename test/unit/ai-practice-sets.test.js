/* global require */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isFlatGradeableChoices, parseSetObject, readSetFiles } = require('../../src/ai-practice-sets');

test('isFlatGradeableChoices accepts a flat labelled array', () => {
  assert.equal(isFlatGradeableChoices('[{"label":"A","text":"x"},{"label":"B","text":"y"}]'), true);
  assert.equal(isFlatGradeableChoices([{ label: 'A', text: 'x' }]), true);
});

test('isFlatGradeableChoices rejects empty, nested, and malformed', () => {
  assert.equal(isFlatGradeableChoices('[]'), false);
  assert.equal(isFlatGradeableChoices(''), false);
  assert.equal(isFlatGradeableChoices(null), false);
  assert.equal(isFlatGradeableChoices('[{"label":"A","options":[{"label":"1"}]}]'), false);
  assert.equal(isFlatGradeableChoices('[{"text":"no label"}]'), false);
  assert.equal(isFlatGradeableChoices('not json'), false);
});

test('parseSetObject validates required fields and coerces items to ints', () => {
  const ok = parseSetObject({ slug: 'redo-01', title: 'T', focusNote: 'n', subject: 'Quant', items: [1, '2', 3] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.set.items, [1, 2, 3]);
  assert.equal(parseSetObject({ slug: 'redo-01', items: [1] }).ok, true); // title/subject optional
  assert.equal(parseSetObject({ title: 'no slug', items: [1] }).ok, false);
  assert.equal(parseSetObject({ slug: 'bad slug!', items: [1] }).ok, false);
  assert.equal(parseSetObject({ slug: 'empty', items: [] }).ok, false);
});

test('readSetFiles skips malformed files and returns valid sets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipset-'));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ slug: 'a', title: 'A', subject: 'Quant', items: [1, 2] }));
  fs.writeFileSync(path.join(dir, 'b.json'), '{ this is not json');
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ title: 'no slug', items: [3] }));
  const sets = readSetFiles(dir);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].slug, 'a');
});

test('readSetFiles returns [] for a missing dir', () => {
  assert.deepEqual(readSetFiles('/no/such/dir/xyz'), []);
});

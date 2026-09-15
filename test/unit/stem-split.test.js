/* global require */
const test = require('node:test');
const assert = require('node:assert');

let splitStem;
let tagsBalanced;
test.before(async () => {
  ({ splitStem, tagsBalanced } = await import('../../client/src/lib/stemSplit.mjs'));
});

// LSAT LR and GMAT CR both store the argument and the question as one
// paragraph; the prompt is always the final sentence.
test('splits an argument from its closing prompt', () => {
  const stem = 'Machine operators repair their own machines. The more dependable a machine is, '
    + 'the less practice its operator gets. Which of the following, if true, most weakens the argument?';
  assert.deepStrictEqual(splitStem(stem), {
    stimulus: ['Machine operators repair their own machines. The more dependable a machine is, the less practice its operator gets.'],
    prompt: 'Which of the following, if true, most weakens the argument?',
  });
});

// RC stems are prompt-only. A single sentence must come back whole rather than
// as an empty stimulus plus a prompt.
test('a one-sentence stem is all prompt', () => {
  const stem = 'The primary purpose of the passage is to';
  assert.deepStrictEqual(splitStem(stem), { stimulus: [], prompt: stem });
});

test('an empty stem yields empty parts', () => {
  assert.deepStrictEqual(splitStem(''), { stimulus: [], prompt: '' });
  assert.deepStrictEqual(splitStem(null), { stimulus: [], prompt: '' });
});

// Abbreviations must not end a sentence, or the prompt starts mid-phrase.
test('does not break on an abbreviation', () => {
  const stem = 'Dr. Smith argues that the policy failed. Which of the following most supports Dr. Smith?';
  const { stimulus, prompt } = splitStem(stem);
  assert.deepStrictEqual(stimulus, ['Dr. Smith argues that the policy failed.']);
  assert.strictEqual(prompt, 'Which of the following most supports Dr. Smith?');
});

// Two or more speakers is a dialogue and gets one paragraph per turn; a lone
// label stays a single paragraph.
test('a dialogue stimulus gets one paragraph per speaker', () => {
  const stem = 'Ann: The bridge is unsafe. It should close. Bill: The inspection found nothing. '
    + 'Which of the following is at issue between Ann and Bill?';
  const { stimulus, prompt } = splitStem(stem);
  assert.deepStrictEqual(stimulus, [
    'Ann: The bridge is unsafe. It should close.',
    'Bill: The inspection found nothing.',
  ]);
  assert.strictEqual(prompt, 'Which of the following is at issue between Ann and Bill?');
});

test('a single speaker label stays one paragraph', () => {
  const stem = 'Editorial: The tax is unfair. It burdens the poor. Which of the following is assumed?';
  assert.deepStrictEqual(splitStem(stem).stimulus, ['Editorial: The tax is unfair. It burdens the poor.']);
});

// GMAT boldface stems carry <b> spans. The splitter is blind to them, so the
// caller checks each piece — an unbalanced one means a span crossed a sentence
// boundary and the stem must render whole instead.
test('reports whether a fragment closes every tag it opens', () => {
  assert.strictEqual(tagsBalanced('plain text'), true);
  assert.strictEqual(tagsBalanced('a <b>bold</b> run'), true);
  assert.strictEqual(tagsBalanced('opens <b>here'), false);
  assert.strictEqual(tagsBalanced('closes</b> here'), false);
});

test('a boldface stem splits with both pieces balanced', () => {
  const html = '<b>Delta switched to electricity</b>. The question is whether output fell. '
    + 'In the argument given, the two boldfaced portions play which of the following roles?';
  const { stimulus, prompt } = splitStem(html);
  assert.ok([...stimulus, prompt].every(tagsBalanced));
  assert.strictEqual(prompt, 'In the argument given, the two boldfaced portions play which of the following roles?');
});

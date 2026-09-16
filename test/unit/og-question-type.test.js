/* global require */
const test = require('node:test');
const assert = require('node:assert');

let classifyQuestionType;
let QUESTION_TYPES;
test.before(async () => {
  ({ classifyQuestionType, QUESTION_TYPES } = await import('../../client/src/lib/questionType.mjs'));
});

const cr = (prompt) => classifyQuestionType(`Some argument sets up the situation here. ${prompt}`, 'CR');
const rc = (prompt) => classifyQuestionType(prompt, 'RC');

test('classifies the common CR prompts', () => {
  assert.strictEqual(cr('Which of the following is an assumption on which the argument depends?'), 'Assumption');
  assert.strictEqual(cr('Which of the following, if true, most seriously weakens the argument above?'), 'Weaken');
  assert.strictEqual(cr('Which of the following, if true, most strengthens the argument above?'), 'Strengthen');
  assert.strictEqual(cr('Which of the following would it be most useful to determine in order to evaluate the argument?'), 'Evaluate');
  assert.strictEqual(cr('Which of the following can be properly inferred from the statements above?'), 'Inference');
  assert.strictEqual(cr('Which of the following, if true, best explains the apparent discrepancy described above?'), 'Paradox');
  assert.strictEqual(cr('In the argument given, the two boldfaced portions play which of the following roles?'), 'Boldface');
});

test('classifies the common RC prompts', () => {
  assert.strictEqual(rc('The primary purpose of the passage is to'), 'Main Idea');
  assert.strictEqual(rc('According to the passage, which of the following contributed to the decline?'), 'Detail');
  assert.strictEqual(rc('It can be inferred from the passage that the authors believe which of the following?'), 'Inference');
  assert.strictEqual(rc('The author mentions the supervision of schools primarily in order to'), 'Function');
  assert.strictEqual(rc("The author's attitude toward the new theory is best described as"), 'Tone');
});

// Ligature glyphs survive the scans and match none of the patterns until they
// are expanded — the same trap the boldface extraction hit.
test('sees through ligature glyphs', () => {
  assert.strictEqual(rc('The passage is chieﬂy concerned with'), 'Main Idea');
  assert.strictEqual(rc('Which best describes the relation of the ﬁrst paragraph to the passage?'), 'Function');
});

// The scans also glue words together, so every pattern is retried with its
// spaces made optional.
test('sees through glued words', () => {
  assert.strictEqual(rc('The author is primarilyconcerned with'), 'Main Idea');
  assert.strictEqual(rc('In the context of the passage, the second paragraph serves primarilyto'), 'Function');
});

// The prompt is the final sentence; words in the argument must not decide the
// type. "weakens" here belongs to the stimulus, not to the question.
test('classifies on the prompt, not on the argument', () => {
  const stem = 'A study found that the new drug weakens the immune response in some patients. '
    + 'Which of the following is an assumption on which the conclusion depends?';
  assert.strictEqual(classifyQuestionType(stem, 'CR'), 'Assumption');
});

test('an unmatched prompt returns null rather than a guess', () => {
  assert.strictEqual(cr('Ls Oe.'), null);
  assert.strictEqual(classifyQuestionType('', 'CR'), null);
  assert.strictEqual(classifyQuestionType('The primary purpose of the passage is to', 'XX'), null);
});

test('every rule label is exposed for the builder facet order', () => {
  assert.ok(QUESTION_TYPES.CR.includes('Assumption'));
  assert.ok(QUESTION_TYPES.RC.includes('Main Idea'));
  assert.strictEqual(new Set(QUESTION_TYPES.CR).size, QUESTION_TYPES.CR.length);
});

/* global require */
// StartTest's Content Area names ("Weaken", "Explanation") stay in `subcategory`
// — what the dashboard tables show — while `topic` takes the canonical label
// the pattern charts group by. Translating subcategory too left sessions
// reading "Attack" beside untranslatable leaves like "Error" and "Premise".
const test = require('node:test');
const assert = require('node:assert');
const { classifyScrapedQuestions } = require('../../src/question-topic-classifier');

const row = (leaf, over = {}) => ({
  subject_code: 'V', category_code: 'CR', subcategory: leaf, topic: leaf,
  topic_source: 'starttest-report', taxonomy_path: `Verbal.CR.CTQ.${leaf.slice(0, 3).toUpperCase()}`, ...over,
});

test('a canonicalized StartTest row keeps its own name in subcategory', async () => {
  const qs = [row('Weaken'), row('Strengthen'), row('Assumption')];
  const result = await classifyScrapedQuestions({ sessions: [{ source: 'GMAT™ Official Guide 2024-2025', questions: qs }] });
  assert.strictEqual(result.attempted, 0); // never reaches the LLM
  assert.deepStrictEqual(qs.map((q) => q.subcategory), ['Weaken', 'Strengthen', 'Assumption']);
  assert.deepStrictEqual(qs.map((q) => q.topic), ['Attack', 'Support', 'Assumption']);
  assert.ok(qs.every((q) => q.topic_source === 'starttest-canonical'));
});

test('a leaf with no canonical label is left exactly as StartTest named it', async () => {
  const qs = [row('Error'), row('Premise')];
  await classifyScrapedQuestions({ sessions: [{ source: 'GMAT™ Official Guide 2024-2025', questions: qs }] });
  assert.deepStrictEqual(qs.map((q) => [q.subcategory, q.topic, q.topic_source]),
    [['Error', 'Error', 'starttest-report'], ['Premise', 'Premise', 'starttest-report']]);
});

/* global require */
const test = require('node:test');
const assert = require('node:assert');
const { buildAccuracyTrend, pickWeakestCategory, buildSubjectDifficultyMatrix } = require('../../client/src/lib/trend.mjs');

test('buildAccuracyTrend orders oldest→newest and computes delta', () => {
  const sessions = [
    { session_date: '2026-07-03', answered_accuracy_pct: 70 },
    { session_date: '2026-07-01', answered_accuracy_pct: 60 },
    { session_date: '2026-07-02', answered_accuracy_pct: 65 },
  ];
  const { series, delta } = buildAccuracyTrend(sessions);
  assert.deepStrictEqual(series, [60, 65, 70]);
  assert.strictEqual(delta, 10);
});

test('buildAccuracyTrend caps to the most recent `limit` points', () => {
  const sessions = Array.from({ length: 20 }, (_, i) => ({
    session_date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    answered_accuracy_pct: i,
  }));
  const { series } = buildAccuracyTrend(sessions, { limit: 5 });
  assert.deepStrictEqual(series, [15, 16, 17, 18, 19]);
});

test('buildAccuracyTrend returns null delta for <2 valid points', () => {
  assert.strictEqual(buildAccuracyTrend([]).delta, null);
  assert.strictEqual(buildAccuracyTrend([{ session_date: '2026-07-01', answered_accuracy_pct: 50 }]).delta, null);
});

test('buildAccuracyTrend ignores rows with bad dates or NaN accuracy', () => {
  const { series } = buildAccuracyTrend([
    { session_date: 'nope', answered_accuracy_pct: 99 },
    { session_date: '2026-07-01', answered_accuracy_pct: 'x' },
    { session_date: '2026-07-02', answered_accuracy_pct: 55 },
    { session_date: '2026-07-03T12:00:00Z', answered_accuracy_pct: 66 },
  ]);
  assert.deepStrictEqual(series, [55, 66]);
});

test('pickWeakestCategory returns lowest accuracy above the volume floor', () => {
  const rows = [
    { category: 'PS', accuracy_pct: 80, total_questions: 40 },
    { category: 'MSR', accuracy_pct: 49, total_questions: 10 },
    { category: 'GI', accuracy_pct: 20, total_questions: 3 }, // below floor
  ];
  assert.strictEqual(pickWeakestCategory(rows).category, 'MSR');
});

test('pickWeakestCategory returns null when nothing clears the floor', () => {
  assert.strictEqual(pickWeakestCategory([{ category: 'GI', accuracy_pct: 20, total_questions: 2 }]), null);
  assert.strictEqual(pickWeakestCategory([]), null);
});

test('buildSubjectDifficultyMatrix aggregates weighted accuracy per subject/band', () => {
  const rows = [
    { subject_family: 'Quant', hard_total: 10, hard_accuracy_pct: 50, medium_total: 20, medium_accuracy_pct: 70, easy_total: 0, easy_accuracy_pct: 0 },
    { subject_family: 'Quant', hard_total: 10, hard_accuracy_pct: 70, medium_total: 0, medium_accuracy_pct: 0, easy_total: 5, easy_accuracy_pct: 80 },
    { subject_family: 'Verbal', hard_total: 8, hard_accuracy_pct: 25, medium_total: 0, medium_accuracy_pct: 0, easy_total: 0, easy_accuracy_pct: 0 },
  ];
  const m = buildSubjectDifficultyMatrix(rows, { subjects: ['Quant', 'Verbal', 'Data Insights'] });
  const quant = m.find((r) => r.subject === 'Quant');
  // hard: (10*.5 + 10*.7)/20 = 60
  assert.strictEqual(quant.cells.find((c) => c.band === 'hard').accuracy, 60);
  // medium: only first row contributes -> 70
  assert.strictEqual(quant.cells.find((c) => c.band === 'medium').accuracy, 70);
  // easy: only second row -> 80
  assert.strictEqual(quant.cells.find((c) => c.band === 'easy').accuracy, 80);
  const di = m.find((r) => r.subject === 'Data Insights');
  // no DI rows -> all null
  assert.strictEqual(di.cells.every((c) => c.accuracy === null), true);
});

test('buildSubjectDifficultyMatrix uses keyOf to normalize subject and skips unknown', () => {
  const rows = [
    { subject_family: 'DATA INSIGHTS', hard_total: 4, hard_accuracy_pct: 50, medium_total: 0, medium_accuracy_pct: 0, easy_total: 0, easy_accuracy_pct: 0 },
    { subject_family: 'Nonsense', hard_total: 100, hard_accuracy_pct: 100, medium_total: 0, medium_accuracy_pct: 0, easy_total: 0, easy_accuracy_pct: 0 },
  ];
  const norm = (s) => (String(s).toUpperCase() === 'DATA INSIGHTS' ? 'Data Insights' : s);
  const m = buildSubjectDifficultyMatrix(rows, { subjects: ['Data Insights'], keyOf: (r) => norm(r.subject_family) });
  assert.strictEqual(m[0].cells.find((c) => c.band === 'hard').accuracy, 50); // 'Nonsense' skipped
  assert.strictEqual(m[0].cells.find((c) => c.band === 'hard').total, 4);
});

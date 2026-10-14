/* global require */
// The GMAT Club Error Log scraper reads /api/errorlog/v1/answers instead of the
// rendered table, because the table drops `forum` — the question format — and
// the topic chips it keeps are shared across formats, so every DS and TPA row
// used to be filed under Quant. Fixtures mirror real payload rows.
const test = require('node:test');
const assert = require('node:assert');
const { forumToCode, dayKey, toQuestion, buildSessions, hashSessionId } =
  require('../../src/scrapers/gmat_club_scraper')._internals;
const { deriveQuestionMetadata } = require('../../src/question-metadata');

const row = (over = {}) => ({
  question: 'In an experiment, researchers posed simple questions in geometry to',
  question_url: '/forum/topic318327.html', question_id: '318327', question_attempts: 1,
  forum: 'TPA', forum_title: 'Two-part Analysis ', category: ['Non-Math Related'],
  date: '2026-09-27T01:08:07-08:00', difficulty: '555-605', spent_time: 152,
  is_correct: true, note: null, mistakes: [], type: 'answer',
  id: 'phpbb_topics_timer_di_history-3442830', group_name: null, group_id: null,
  ...over,
});

test('every forum tag maps to its format, including the two special cases', () => {
  assert.strictEqual(forumToCode('PS'), 'PS');
  assert.strictEqual(forumToCode('DS'), 'DS');
  assert.strictEqual(forumToCode('TPA'), 'TPA');
  assert.strictEqual(forumToCode('MSR'), 'MSR');
  assert.strictEqual(forumToCode('CR'), 'CR');
  assert.strictEqual(forumToCode('RC'), 'RC');
  // Filed under GMAT Club's GRE section, but GMAT DS all the same.
  assert.strictEqual(forumToCode('DS Retired Questions'), 'DS');
  // One forum, two Focus formats: the chips decide.
  assert.strictEqual(forumToCode('G&T', ['Graphs', 'Math Related']), 'GI');
  assert.strictEqual(forumToCode('G&T', ['Tables', 'Non-Math Related']), 'TA');
  assert.strictEqual(forumToCode('G&T', ['Math Related']), null);
  assert.strictEqual(forumToCode(undefined), null);
});

// The bug that started this: a TPA question arrives with a topic chip that
// says nothing about format, and must still land in Data Insights.
test('a tagged row carries an authoritative subject and category', () => {
  const q = toQuestion(row());
  assert.strictEqual(q.category_code, 'TPA');
  assert.strictEqual(q.subject_code, 'DI');
  assert.strictEqual(q.topic_source, 'gmatclub-canonical');
  const ds = toQuestion(row({ forum: 'DS', category: ['Word Problems'] }));
  assert.deepStrictEqual([ds.subject_code, ds.category_code], ['DI', 'DS']);
  const ps = toQuestion(row({ forum: 'PS', category: ['Word Problems'] }));
  assert.deepStrictEqual([ps.subject_code, ps.category_code], ['Q', 'PS']);
});

// saveScrapeResult merges `q.category_code || stored.category_code`, so the
// tag only corrects an old row if it arrives as category_code. This replays
// that merge for a row the old guess filed as Quant.
test('the tag overrules a stale stored Quant classification on re-scrape', () => {
  const q = toQuestion(row({ forum: 'DS', category: ['Number Properties'] }));
  const merged = { ...q, category_code: q.category_code || 'PS', subject_code: q.subject_code || 'Q' };
  const m = deriveQuestionMetadata(merged, { subject: 'Quant' });
  assert.deepStrictEqual([m.subject_code, m.category_code], ['DI', 'DS']);
});

test('an untagged row falls back to the topic guess, kept overridable', () => {
  const q = toQuestion(row({ forum: undefined, category: ['Strengthen'] }));
  assert.strictEqual(q.category_code, null); // never authoritative
  assert.strictEqual(q.subject_sub_raw, 'CR');
});

test('fields the table used to render are carried over in the same form', () => {
  const q = toQuestion(row({ mistakes: ['Careless Mistake', 'Misread'], note: 'missed  the  unit', is_correct: false }));
  assert.strictEqual(q.q_id, 'gc-att-3442830');
  assert.strictEqual(q.q_code, 'gc-q-318327');
  assert.strictEqual(q.question_url, 'https://gmatclub.com/forum/topic318327.html');
  assert.strictEqual(q.difficulty, 'Medium');
  assert.strictEqual(q.time_sec, 152);
  assert.strictEqual(q.correct, false);
  // Chips then note, as the Mistakes/Notes cell read.
  assert.strictEqual(q.notes, 'Careless Mistake Misread missed the unit');
  // RC position suffix survives: Phase 2 pins sub-questions on it.
  assert.strictEqual(toQuestion(row({ question: 'can lead to epidemi (№6)' })).question_stem, 'can lead to epidemi (№6)');
});

// Session ids hash the day, so the day must be the one GMAT Club's page showed
// — the browser's zone, not the timestamp's own -08:00 date.
test('rows are keyed to the browser-local day, not the API timestamp date', () => {
  assert.strictEqual(dayKey('2026-09-26T23:58:28-08:00', 'Asia/Bangkok'), '2026-09-27');
  assert.strictEqual(dayKey('2026-09-21T18:11:46-08:00', 'Asia/Bangkok'), '2026-09-22');
  assert.strictEqual(dayKey('2026-09-27T01:08:07-08:00', 'Asia/Bangkok'), '2026-09-27');
  assert.strictEqual(dayKey('', 'Asia/Bangkok'), '');
});

test('buildSessions groups by day, skips non-questions, honours since, keeps ids stable', () => {
  const rows = [
    row({ id: 'phpbb_topics_timer_history-1', date: '2026-09-26T23:58:28-08:00' }),
    row({ id: 'phpbb_topics_timer_history-2', date: '2026-09-27T01:08:07-08:00', is_correct: false }),
    row({ id: 'phpbb_topics_timer_history-3', date: '2026-09-20T01:00:00-08:00' }),
    row({ id: 'gmatclub_tests_v3.test_sessions-9', type: 'gmat_test', question: undefined, forum: undefined }),
  ];
  const sessions = buildSessions(rows, { source: 'GMAT Club Error Log', timeZone: 'Asia/Bangkok', sinceKey: '2026-09-25' });
  assert.strictEqual(sessions.length, 1);
  const [s] = sessions;
  assert.strictEqual(s.date, '2026-09-27');
  assert.strictEqual(s.session_id, hashSessionId('GMAT Club Error Log|2026-09-27'));
  assert.strictEqual(s.questions.length, 2);
  assert.deepStrictEqual([s.stats.correct, s.stats.errors], [1, 1]);
  assert.deepStrictEqual(s.wrong_q_ids, [{ q_id: 'gc-att-2', cat_id: null }]);
});

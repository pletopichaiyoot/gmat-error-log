// test/unit/gmatclub-cat-parse.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseTypeCell, mapSectionToSubject, parseTimeSec, parseGridTimestamp,
  parseScoreReport, parseSinceDateKey,
} = require('../../src/scrapers/gmat_club_cat_scraper')._internals;

test('parseTypeCell splits Section / Code / Topic', () => {
  assert.deepEqual(parseTypeCell('Data Insights / TPA / Two-Part Analysis'),
    { subjectCode: 'DI', categoryCode: 'TPA', topic: 'Two-Part Analysis' });
  assert.deepEqual(parseTypeCell('Quant / PS / Algebra'),
    { subjectCode: 'Q', categoryCode: 'PS', topic: 'Algebra' });
  assert.deepEqual(parseTypeCell('Verbal / CR / Strengthen'),
    { subjectCode: 'V', categoryCode: 'CR', topic: 'Strengthen' });
  assert.deepEqual(parseTypeCell('Data Insights / DS / Word problems'),
    { subjectCode: 'DI', categoryCode: 'DS', topic: 'Word problems' });
});

test('parseTypeCell tolerates missing topic / blank', () => {
  assert.deepEqual(parseTypeCell('Quant / PS'),
    { subjectCode: 'Q', categoryCode: 'PS', topic: null });
  assert.deepEqual(parseTypeCell(''),
    { subjectCode: null, categoryCode: null, topic: null });
});

test('mapSectionToSubject', () => {
  assert.equal(mapSectionToSubject('Quant'), 'Q');
  assert.equal(mapSectionToSubject('Quantitative Reasoning'), 'Q');
  assert.equal(mapSectionToSubject('Verbal'), 'V');
  assert.equal(mapSectionToSubject('Data Insights'), 'DI');
  assert.equal(mapSectionToSubject('nonsense'), null);
});

test('parseTimeSec mm:ss and h:mm:ss', () => {
  assert.equal(parseTimeSec('2:15'), 135);
  assert.equal(parseTimeSec('0:45'), 45);
  assert.equal(parseTimeSec('1:02:03'), 3723);
  assert.equal(parseTimeSec(''), null);
});

test('parseGridTimestamp', () => {
  assert.deepEqual(parseGridTimestamp('Jun 21, 2026 12:05 AM').dateKey, '2026-06-21');
  assert.equal(parseGridTimestamp('garbage').dateKey, null);
});

test('parseScoreReport extracts section scores + percentiles', () => {
  const rows = [
    ['Total Score', '51st', '205 554.67 565 805'],
    ['Quantitative Reasoning', '70th', '60 78.06 81 90'],
    ['Verbal Reasoning', '47th', '60 79.34 79 90'],
    ['Data Insights', '41st', '60 75.03 74 90'],
  ];
  const got = parseScoreReport(rows);
  assert.deepEqual(got.total, { score: 565, percentile: 51 });
  assert.deepEqual(got.quant, { score: 81, percentile: 70 });
  assert.deepEqual(got.verbal, { score: 79, percentile: 47 });
  assert.deepEqual(got.di, { score: 74, percentile: 41 });
});

test('parseSinceDateKey', () => {
  assert.equal(parseSinceDateKey('20250101000000'), '2025-01-01');
  assert.equal(parseSinceDateKey(''), '');
});

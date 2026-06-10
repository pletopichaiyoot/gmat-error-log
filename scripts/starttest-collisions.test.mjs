// Tests for findThemeCollisions in the StartTest scraper.
// Run: node --test scripts/starttest-collisions.test.mjs
//
// A "theme collision" means the QHistory Content Area label cannot identify a
// unique taxonomy leaf, so the per-leaf disambiguation post-pass must run.
// Verified live 2026-06-10 (sid 122741): the Official Practice Verbal CR tree
// repeats the leaf label "Weaken" under two tier-3 branches of the SAME tier-2
// (Critique and Plan), so collision detection must compare full paths, not
// tier-2 types.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _internals } = require('../src/scrapers/starttest_scraper.js');
const { findThemeCollisions } = _internals;

const rec = (listitemid, path, labels) => ({
  listitemid,
  path,
  parts: path.split('.'),
  labels,
  depth: path.split('.').length,
});

test('tier-2 collision: DI Tradeoffs under MSR and TPA is flagged', () => {
  const taxonomy = [
    rec(101, 'Data.MSR.TRA', ['Data Insights', 'Multi-source Reasoning', 'Tradeoffs']),
    rec(102, 'Data.TPA.TRA', ['Data Insights', 'Two-part Analysis', 'Tradeoffs']),
  ];
  const colliding = findThemeCollisions(taxonomy);
  assert.equal(colliding.size, 1);
  assert.ok(colliding.has('Data|Tradeoffs'));
  assert.equal(colliding.get('Data|Tradeoffs').length, 2);
});

test('tier-3 collision: Verbal CR Weaken under Critique and Plan is flagged', () => {
  const taxonomy = [
    rec(1325, 'Verbal.CR.CTQ.WKN', ['Verbal', 'Critical Reasoning', 'Critique', 'Weaken']),
    rec(1337, 'Verbal.CR.PLA.WKN', ['Verbal', 'Critical Reasoning', 'Plan', 'Weaken']),
    rec(1335, 'Verbal.CR.PLA.STR', ['Verbal', 'Critical Reasoning', 'Plan', 'Strengthen']),
  ];
  const colliding = findThemeCollisions(taxonomy);
  assert.equal(colliding.size, 1, 'same-tier-2 duplicate leaf labels must be flagged');
  assert.ok(colliding.has('Verbal|Weaken'));
  const leaves = colliding.get('Verbal|Weaken').map((r) => r.path).sort();
  assert.deepEqual(leaves, ['Verbal.CR.CTQ.WKN', 'Verbal.CR.PLA.WKN']);
});

test('no collision: unique leaf labels produce an empty map', () => {
  const taxonomy = [
    rec(1, 'Verbal.CR.ANA.MET', ['Verbal', 'Critical Reasoning', 'Analysis', 'Method']),
    rec(2, 'Verbal.CR.CST.ASS', ['Verbal', 'Critical Reasoning', 'Construction', 'Assumption']),
  ];
  assert.equal(findThemeCollisions(taxonomy).size, 0);
});

test('no collision: same leaf label in different subjects stays separate', () => {
  const taxonomy = [
    rec(11, 'Q.PS.PCT', ['Quantitative', 'Problem Solving', 'Percent']),
    rec(12, 'Data.GI.PCT', ['Data Insights', 'Graphics Interpretation', 'Percent']),
  ];
  assert.equal(findThemeCollisions(taxonomy).size, 0);
});

test('handles null/empty taxonomy without throwing', () => {
  assert.equal(findThemeCollisions(null).size, 0);
  assert.equal(findThemeCollisions([]).size, 0);
});

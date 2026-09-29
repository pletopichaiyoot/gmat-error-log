/* global require */
// The report tree -> taxonomy/label index that QHistory "Content Area" text is
// matched against. Fixture: the live tree of session 404605 (2026-09-28), where
// StartTest filed two "Other" questions on Verbal.CR.OTH — an interior node
// flagged as having children and rendered with none — and both came back with
// no taxonomy path because only data-has-children="False" rows were indexed.
const test = require('node:test');
const assert = require('node:assert');
const { buildTaxonomy, findThemeCollisions } = require('../../src/scrapers/starttest_scraper')._internals;

// [path, depth, hasChildren, label, listitemid] in DOM order.
const TREE_404605 = [["Verbal",1,true,"Verbal","1305"],["Verbal.CR",2,true,"Critical Reasoning","1306"],["Verbal.CR.ANA",3,true,"Analysis","1307"],["Verbal.CR.ANA.MET",4,false,"Method","1309"],["Verbal.CR.CST",3,true,"Construction","1312"],["Verbal.CR.CST.CCN",4,false,"Conclusion","1314"],["Verbal.CR.CST.EXP",4,false,"Explanation","1315"],["Verbal.CR.CST.PRE",4,false,"Premise","1317"],["Verbal.CR.CTQ",3,true,"Critique","1319"],["Verbal.CR.CTQ.ERR",4,false,"Error","1320"],["Verbal.CR.CTQ.STR",4,false,"Strengthen","1323"],["Verbal.CR.CTQ.WKN",4,false,"Weaken","1325"],["Verbal.CR.OTH",3,true,"Other","1326"],["Verbal.CR.PLA",3,true,"Plan","1327"],["Verbal.CR.PLA.IFN",4,false,"Information","1426"],["Verbal.CR.PLA.WKN",4,false,"Weaken","1337"],["",0,false,"Total","0"]];
const rows = TREE_404605.map(([path, depth, hasChildren, label, listitemid]) => ({ path, depth, hasChildren, label, listitemid }));

// Every Content Area value that session's Question History carried.
const CONTENT_AREAS = ['Other', 'Error', 'Strengthen', 'Weaken', 'Method', 'Conclusion', 'Explanation', 'Information', 'Premise'];

test('a childless interior node is indexed, so "Other" resolves', () => {
  const { labelIndex } = buildTaxonomy(rows);
  const hit = labelIndex.get('Verbal|Other');
  assert.ok(hit, '"Other" missing from the label index');
  assert.strictEqual(hit.path, 'Verbal.CR.OTH');
  assert.deepStrictEqual(hit.labels, ['Verbal', 'Critical Reasoning', 'Other']);
  assert.strictEqual(hit.listitemid, 1326);
});

test('every Content Area in the session maps to a path', () => {
  const { labelIndex } = buildTaxonomy(rows);
  for (const area of CONTENT_AREAS) assert.ok(labelIndex.get(`Verbal|${area}`), `no path for ${area}`);
});

test('interior nodes with rendered children are still not leaves', () => {
  const paths = buildTaxonomy(rows).taxonomy.map((r) => r.path);
  for (const interior of ['Verbal', 'Verbal.CR', 'Verbal.CR.ANA', 'Verbal.CR.CST', 'Verbal.CR.CTQ', 'Verbal.CR.PLA']) {
    assert.ok(!paths.includes(interior), `${interior} indexed as a leaf`);
  }
  assert.strictEqual(paths.length, 10); // 9 real leaves + Verbal.CR.OTH
});

test('the Weaken collision between Critique and Plan is still detected', () => {
  const collisions = findThemeCollisions(buildTaxonomy(rows).taxonomy);
  assert.deepStrictEqual([...collisions.keys()], ['Verbal|Weaken']);
  assert.deepStrictEqual(collisions.get('Verbal|Weaken').map((r) => r.path), ['Verbal.CR.CTQ.WKN', 'Verbal.CR.PLA.WKN']);
});

'use strict';
/* global require */

const test = require('node:test');
const assert = require('node:assert');

const { findStartTestPage } = require('../../src/scraper-runner.js');

// A spent ITD harness shell keeps a starttest.com URL, so the old "first tab that
// matches" pick handed runs a dead tab — surfacing much later as "Product <id> not
// found in the StartTest home menu" or "No ITDReview.aspx frame ever appeared".
// Verified live 2026-09-10: session 410 failed twice on a stale tab, then enriched
// 20/20 once the picker started scoring candidates.
function fakePage(url, evaluateResult) {
  return {
    url: () => url,
    evaluate: async (fn) => {
      if (evaluateResult instanceof Error) throw evaluateResult;
      if (evaluateResult === 'hang') return new Promise(() => {});
      return typeof fn === 'function' ? evaluateResult : evaluateResult;
    },
  };
}

const fakeBrowser = (pages) => ({ contexts: () => [{ pages: () => pages }] });

test('prefers the tab that has the product switcher over a spent harness shell', async () => {
  const dead = fakePage('https://www.starttest.com/starttest2/13.2/router?session=1', 0);
  const live = fakePage('https://www.starttest.com/starttest2/13.2/router?session=2', 3);
  assert.strictEqual(await findStartTestPage(fakeBrowser([dead, live])), live);
});

test('falls back to a titled tab when none shows the menu, newest first', async () => {
  const blank = fakePage('https://www.starttest.com/a', 0);
  const titledOld = fakePage('https://www.starttest.com/b', 2);
  const titledNew = fakePage('https://www.starttest.com/c', 2);
  assert.strictEqual(await findStartTestPage(fakeBrowser([blank, titledOld, titledNew])), titledNew);
});

test('a wedged tab scores zero instead of stalling the pick', async () => {
  const wedged = fakePage('https://www.starttest.com/a', 'hang');
  const live = fakePage('https://www.starttest.com/b', 3);
  assert.strictEqual(await findStartTestPage(fakeBrowser([wedged, live])), live);
});

test('an evaluate that throws does not lose the tab list', async () => {
  const broken = fakePage('https://www.starttest.com/a', new Error('Target closed'));
  assert.strictEqual(await findStartTestPage(fakeBrowser([broken])), broken);
});

test('ignores non-starttest tabs and returns null when there are none', async () => {
  const other = fakePage('https://gmatclub.com/forum/', 3);
  assert.strictEqual(await findStartTestPage(fakeBrowser([other])), null);
  assert.strictEqual(await findStartTestPage(fakeBrowser([])), null);
});

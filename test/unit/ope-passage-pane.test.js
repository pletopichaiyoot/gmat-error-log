'use strict';
/* global require */

const test = require('node:test');
const assert = require('node:assert');

const { _internals } = require('../../src/scrapers/ope_mock_scraper');

const { isDisplayFrameUrl, waitForPassageFrame, readPassageFrame, readPassagePane } = _internals;

const ITD = 'https://www.starttest.com/starttest2/13.0/itd.aspx';

// What the in-page read returns for an MSR pane after it has marked the figure
// and turned the tab buttons into spans.
const MSR_PANE = {
  isMsr: true,
  text: 'Situation\nDebate\nSit text\n\nDebate text',
  html: '<div class="tab"><span class="tablinks">Situation</span><span class="tablinks">Debate</span></div>'
    + '<div class="tabcontent"><p>Sit text</p><img src="itdmedia.aspx?f=1" data-shot="0"></div>'
    + '<div class="tabcontent"><p>Debate text</p></div>',
  hasChart: true,
  hasTable: false,
  itdmediaSelectors: ['[data-shot="0"]'],
};

const RC_PANE = { isMsr: false, text: 'Para one.\n\nPara two.', html: '', hasChart: false, hasTable: false, itdmediaSelectors: [] };

// A frame whose evaluate answers the three page functions the reader runs: the
// readiness probe, the pane read, and captureItdmediaImage's fetch (the only one
// that takes an argument).
function frameOf(url, { ready = true, pane = RC_PANE, reads = [] } = {}) {
  return {
    url: () => url,
    evaluate: async (fn, arg) => {
      if (arg !== undefined) return { contentType: 'image/gif', base64: 'R0lG' };
      if (String(fn).includes('readyState')) {
        if (ready instanceof Error) throw ready;
        return ready;
      }
      reads.push(url);
      return pane;
    },
  };
}

const popupOf = (frames) => ({ frames: () => frames });

test('a display frame is itd.aspx with cmd=display', () => {
  assert.strictEqual(isDisplayFrameUrl(`${ITD}?cmd=display&data=abc`), true);
  assert.strictEqual(isDisplayFrameUrl(`${ITD}?cmd=item&data=abc`), false);
  assert.strictEqual(isDisplayFrameUrl('https://www.starttest.com/other.aspx?cmd=display'), false);
  assert.strictEqual(isDisplayFrameUrl('not a url'), false);
});

test('an MSR pane becomes the tabbed source the review modal renders, figure inlined', async () => {
  const reads = [];
  const read = await readPassageFrame(frameOf(`${ITD}?cmd=display&data=m1`, { pane: MSR_PANE, reads }));
  assert.strictEqual(read.passage, null);
  assert.strictEqual(read.stimulus.kind, 'msr');
  assert.strictEqual(read.stimulus.html, '');
  assert.strictEqual(read.stimulus.sources.length, 1);
  const src = read.stimulus.sources[0];
  assert.strictEqual(src.title, 'Passage:');
  assert.strictEqual(src.text, MSR_PANE.text);
  assert.strictEqual((src.html.match(/class="tabcontent"/g) || []).length, 2);
  assert.strictEqual((src.html.match(/class="tablinks"/g) || []).length, 2);
  assert.ok(src.html.includes('<img src="data:image/gif;base64,R0lG">'), src.html);
  assert.ok(!src.html.includes('itdmedia'), 'the itdmedia URL must not survive');
  assert.ok(read.stimulus.dataText.startsWith('Passage:'));
});

test('an RC pane becomes passage text with no stimulus', async () => {
  const read = await readPassageFrame(frameOf(`${ITD}?cmd=display&data=r1`));
  assert.deepStrictEqual(read, { passage: 'Para one.\n\nPara two.', stimulus: null });
});

test('an RC pane with a table keeps the table as the stimulus, not the prose', async () => {
  const pane = { ...RC_PANE, html: '<table><tr><td>1</td></tr></table>', hasTable: true };
  const read = await readPassageFrame(frameOf(`${ITD}?cmd=display&data=r2`, { pane }));
  assert.strictEqual(read.passage, 'Para one.\n\nPara two.');
  assert.strictEqual(read.stimulus.kind, 'table');
  assert.strictEqual(read.stimulus.html, '<table><tr><td>1</td></tr></table>');
  assert.deepStrictEqual(read.stimulus.sources, []);
});

test('the pane is read once per passage name and not at all without one', async () => {
  const reads = [];
  const fresh = frameOf(`${ITD}?cmd=display&data=p1`, { reads });
  const pane = { name: null, read: null, staleUrls: new Set() };
  const popup = popupOf([fresh]);

  assert.strictEqual(await readPassagePane(popup, pane, null), null);
  assert.deepStrictEqual(reads, []);

  const first = await readPassagePane(popup, pane, 'V188_000439-00');
  const second = await readPassagePane(popup, pane, 'V188_000439-00');
  assert.strictEqual(second, first);
  assert.deepStrictEqual(reads, [`${ITD}?cmd=display&data=p1`]);
  assert.strictEqual(pane.name, 'V188_000439-00');
});

test('a passage change waits for a pane whose URL predates nothing, freshest first', async () => {
  const reads = [];
  const stale = frameOf(`${ITD}?cmd=display&data=old`, { reads, pane: { ...RC_PANE, text: 'OLD' } });
  const older = frameOf(`${ITD}?cmd=display&data=new1`, { reads, pane: { ...RC_PANE, text: 'NEW1' } });
  const newest = frameOf(`${ITD}?cmd=display&data=new2`, { reads, pane: { ...RC_PANE, text: 'NEW2' } });
  const item = frameOf(`${ITD}?cmd=item&data=new3`, { reads });
  const pane = { name: 'A', read: { passage: 'OLD', stimulus: null }, staleUrls: new Set([stale.url()]) };

  const read = await readPassagePane(popupOf([stale, older, newest, item]), pane, 'B');
  assert.strictEqual(read.passage, 'NEW2');
  assert.deepStrictEqual(reads, [newest.url()]);
  assert.strictEqual(pane.name, 'B');
});

test('a pane still loading, or detached, is skipped until it is ready', async () => {
  const loading = frameOf(`${ITD}?cmd=display&data=l`, { ready: false });
  const detached = frameOf(`${ITD}?cmd=display&data=d`, { ready: new Error('Execution context was destroyed') });
  await assert.rejects(
    waitForPassageFrame(popupOf([loading, detached]), new Set(), { timeoutMs: 30, pollMs: 5 }),
    /passage pane did not appear within 30ms/,
  );
  const ready = frameOf(`${ITD}?cmd=display&data=ok`);
  const got = await waitForPassageFrame(popupOf([loading, detached, ready]), new Set(), { timeoutMs: 30, pollMs: 5 });
  assert.strictEqual(got, ready);
});

test('no fresh pane in time leaves the record on the previous passage, so the next sub-question retries', async () => {
  const stale = frameOf(`${ITD}?cmd=display&data=old`);
  const pane = { name: 'A', read: { passage: 'OLD', stimulus: null }, staleUrls: new Set([stale.url()]) };
  await assert.rejects(
    readPassagePane(popupOf([stale]), pane, 'B', { timeoutMs: 20, pollMs: 5 }),
    /passage pane did not appear/,
  );
  assert.strictEqual(pane.name, 'A');
  assert.strictEqual(pane.read.passage, 'OLD');
});

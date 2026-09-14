// scripts/og/regions.js
// Slice a book's text into the practice / key / explanations regions for one
// subject.
//
// Two structural facts drive the design, both established against the real
// PDFs rather than assumed:
//
//  1. The "X.4 Practice Questions" heading is NOT the start of the practice
//     material. Its heading-and-directions block is emitted after the
//     section's first passage page, so question 1 physically precedes it in
//     the text stream. The practice region is therefore bounded by the
//     directions heading (X.3) on the left and the answer key (X.5) on the
//     right.
//  2. Every heading appears first in the table of contents, where the
//     chapter's sub-headings sit on adjacent lines. Picking the triple with
//     the widest practice region separates the body from the TOC without any
//     tuned threshold: the TOC triple spans about one line, the body triple
//     hundreds.

const { squash, isRunningHead, normalizeLine } = require('./text');

const QUESTION_ONE = /^1\.\s+\S/;
const KEY_ENTRY = /(?:^|\s)[0-9IlO]{1,4}\.\s*[A-E0](?=\s|$)/;

const VALIDATORS = {
  key: (lines, i) => lines.slice(i + 1, i + 20).some(l => KEY_ENTRY.test(l.trim())),
  explanations: (lines, i) => lines.slice(i + 1, i + 80).some(l => QUESTION_ONE.test(l.trim())),
};

function headingsFor(book, kind) {
  const ch = book.chapters[kind];
  return {
    directions: `${ch}.3 `,
    practice: `${ch}.4 ${book.practiceSuffix}`,
    key: `${ch}.5 ${book.keySuffix}`,
    explanations: `${ch}.6 ${book.explanationsSuffix}`,
    nextChapter: `${ch + 1}.0 `,
  };
}

function candidates(lines, heading, isValid) {
  const want = squash(heading);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!squash(lines[i]).startsWith(want)) continue;
    if (isValid && !isValid(lines, i)) continue;
    out.push(i);
  }
  return out;
}

// Widest practice region wins — see note 2 above.
function bestTriple(directions, key, explanations) {
  let best = null;
  for (const d of directions) {
    const k = key.find(x => x > d);
    if (k === undefined) continue;
    const e = explanations.find(x => x > k);
    if (e === undefined) continue;
    if (!best || k - d > best.key - best.directions) {
      best = { directions: d, key: k, explanations: e };
    }
  }
  return best;
}

function findRegions(lines, book, kind) {
  const h = headingsFor(book, kind);
  const ch = book.chapters[kind];

  const cDirections = candidates(lines, h.directions, null);
  if (cDirections.length === 0) throw new Error(`Could not locate heading: ${h.directions}`);
  const cKey = candidates(lines, h.key, VALIDATORS.key);
  if (cKey.length === 0) throw new Error(`Could not locate heading: ${h.key}`);
  const cExpl = candidates(lines, h.explanations, VALIDATORS.explanations);
  if (cExpl.length === 0) throw new Error(`Could not locate heading: ${h.explanations}`);

  const picked = bestTriple(cDirections, cKey, cExpl);
  if (!picked) {
    throw new Error(`Could not order headings ${h.directions} / ${h.key} / ${h.explanations}`);
  }

  // The explanations run to the next chapter, not to end of file, so an RC
  // parse does not swallow the CR chapter that follows it.
  const cNext = candidates(lines, h.nextChapter, null).filter(i => i > picked.explanations);
  const iEnd = cNext.length ? cNext[cNext.length - 1] : lines.length;

  // Every heading in this chapter doubles as a running head to strip.
  const runningHeads = [
    h.practice, h.key, h.explanations,
    `${ch}.3 `, `${ch}.4 `, `${ch}.5 `, `${ch}.6 `,
  ];

  const clean = (from, to) => lines
    .slice(from, to)
    .map(normalizeLine)
    .filter(l => l.trim() !== '' && !isRunningHead(l, runningHeads));

  return {
    practice: clean(picked.directions + 1, picked.key),
    key: clean(picked.key + 1, picked.explanations),
    explanations: clean(picked.explanations + 1, iEnd),
  };
}

module.exports = { findRegions, headingsFor };

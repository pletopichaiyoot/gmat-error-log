// scripts/og/regions.js
// Slice a book's text into the practice / key / explanations regions for one
// subject.
//
// Two structural facts drive the design, both established against the real
// PDFs rather than assumed:
//
//  1. The "X.4 Practice Questions" heading is NOT the start of the practice
//     material. Its heading-and-directions block is emitted after the
//     section's first passage page, so question 1 precedes it in the text
//     stream. The practice region is bounded by the directions heading (X.3)
//     on the left and the answer key (X.5) on the right.
//  2. Every heading appears first in the table of contents, with a page
//     number attached. Bounding a region with those lines yields nothing, so
//     the contents block is located and skipped.

const { squash, isRunningHead, normalizeLine } = require('./text');

// A key line is a numbered entry, with or without its letter: re-OCR can
// recover a rotated key table's numbers while losing the letter column
// entirely (OG13 CR). The heading still has to be findable so the caller can
// see the region and judge it unusable.
const KEY_LINE = /^[0-9IlO]{1,4}[.,;]/;

// The explanations heading needs no content check: it is taken as the first
// X.6 after the chosen key heading. Requiring a numbered question beneath it
// would fail on the scans that lose those numbers.
const VALIDATORS = {
  key: (lines, i) => lines.slice(i + 1, i + 20).filter(l => KEY_LINE.test(l.trim())).length >= 3,
  explanations: null,
};

// A contents line is the heading followed by nothing but its page number
// ("8.5 Answer Key 539"); the body prints the heading bare, or as a running
// head with the subject inserted ("8.5 Critical Reasoning Answer Key").
//
// This replaced a density scan for the contents block: re-OCR reflows the
// contents across more lines, so "a dozen headings within sixty lines" held
// for the original text layer of OG13 and not for its Tesseract redo.
const TOC_TAIL = /\s\d{1,4}\s*$/;

function isContentsLine(line) {
  return TOC_TAIL.test(String(line).trimEnd());
}

// A heading carries a title. Two things in the scans squash to a heading
// prefix without being one: a bare contents entry whose page number reflowed
// onto its own line ("8.3"), and a line of answer-key table noise
// ("8. 39, 70. 101. 132."). Both are letterless.
const MIN_HEADING_LETTERS = 3;

function looksLikeHeading(line) {
  return (String(line).match(/[A-Za-z]/g) || []).length >= MIN_HEADING_LETTERS;
}

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

function candidates(lines, heading, isValid, after) {
  const want = squash(heading);
  const out = [];
  for (let i = after; i < lines.length; i++) {
    if (!squash(lines[i]).startsWith(want)) continue;
    if (isContentsLine(lines[i]) || !looksLikeHeading(lines[i])) continue;
    if (isValid && !isValid(lines, i)) continue;
    out.push(i);
  }
  return out;
}

function findRegions(lines, book, kind) {
  const h = headingsFor(book, kind);
  const ch = book.chapters[kind];

  const first = (heading, isValid, after) => {
    const c = candidates(lines, heading, isValid, after);
    return c.length ? c[0] : -1;
  };

  const iDirections = first(h.directions, null, 0);
  if (iDirections < 0) throw new Error(`Could not locate heading: ${h.directions}`);
  const iKey = first(h.key, VALIDATORS.key, iDirections + 1);
  if (iKey < 0) throw new Error(`Could not locate heading: ${h.key}`);
  const iExpl = first(h.explanations, VALIDATORS.explanations, iKey + 1);
  if (iExpl < 0) throw new Error(`Could not locate heading: ${h.explanations}`);

  // The explanations run to the next chapter, not to end of file, so an RC
  // parse does not swallow the CR chapter that follows it.
  const cNext = candidates(lines, h.nextChapter, null, iExpl + 1);
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
    practice: clean(iDirections + 1, iKey),
    key: clean(iKey + 1, iExpl),
    explanations: clean(iExpl + 1, iEnd),
  };
}

module.exports = { findRegions, headingsFor, isContentsLine };

// scripts/og/answer-key.js
// The books print their keys two ways. OG12/OG13 use one "N. X" per line.
// VR2 uses a four-column grid whose OCR reads 1 as I, 11 as II, 101 as lOI,
// and the letter D as a bare 0.
//
// OG13's CR key (section 8.5) is a rotated table that OCR destroyed; that
// region returns layout 'unreadable' and an empty map, and the caller falls
// back to the key derived from the answer explanations.

const { repairKeyNumeral } = require('./text');

// "<number>. <letter>" with both halves possibly OCR-damaged.
const ENTRY = /(?:^|\s)([0-9IlO]{1,4})\.\s*([A-E0])(?=\s|$)/g;

function entriesIn(line) {
  const out = [];
  ENTRY.lastIndex = 0;
  let m;
  while ((m = ENTRY.exec(line)) !== null) {
    const num = Number(repairKeyNumeral(m[1]));
    // A bare 0 in the letter position is D — VR2's OCR reads them identically.
    const letter = m[2] === '0' ? 'D' : m[2];
    if (Number.isInteger(num) && num > 0 && /^[A-E]$/.test(letter)) {
      out.push({ number: num, letter });
    }
  }
  return out;
}

function detectKeyLayout(lines) {
  if (lines.length === 0) return 'unreadable';
  const counts = lines.map(l => entriesIn(l).length);
  const withEntries = counts.filter(c => c > 0).length;
  if (withEntries === 0) return 'unreadable';
  // A region where most lines carry nothing parseable is noise, not a layout.
  if (withEntries / lines.length < 0.5) return 'unreadable';
  const multi = counts.filter(c => c > 1).length;
  return multi / withEntries > 0.5 ? 'grid' : 'single';
}

function parseAnswerKey(lines) {
  const layout = detectKeyLayout(lines);
  const keys = new Map();
  const skipped = [];
  if (layout === 'unreadable') return { layout, keys, skipped: lines.slice() };

  for (const line of lines) {
    const found = entriesIn(line);
    if (found.length === 0) { skipped.push(line); continue; }
    for (const { number, letter } of found) keys.set(number, letter);
  }
  return { layout, keys, skipped };
}

module.exports = { parseAnswerKey, detectKeyLayout };

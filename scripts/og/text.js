// scripts/og/text.js
// Normalization shared by every OG parser. The OCR damage in OG13 and Verbal
// Review 2e is systematic, so it is repaired in one place rather than in each
// parser's own regexes.

const WATERMARK = /QQ:\d{6,}制作/g;

// Collapse to a comparable key: OCR splits words inside running heads at a
// different point on nearly every VR2 page, so only the letters matter.
function squash(s) {
  return String(s).toLowerCase().replace(/\s+/g, '');
}

function stripWatermark(line) {
  return String(line).replace(WATERMARK, '');
}

// "(0 text"  -> "(C) text"   (OG13: C read as 0, closing paren lost)
// "(8) text" -> "(B) text"   (VR2: B read as 8)
// Anchored at line start so "(0.5)" mid-sentence is untouched.
function repairChoiceLabels(line) {
  return String(line)
    .replace(/^\(0(?=\s)/, '(C)')
    .replace(/^\(8\)/, '(B)');
}

// VR2's key grid reads 1 as I, 11 as II, 21 as 2I, 101 as lOI.
// Only I, l and O are ambiguous; everything else is already a digit.
function repairKeyNumeral(token) {
  const t = String(token);
  if (/^\d+$/.test(t)) return t;
  if (!/^[0-9IlO]+$/.test(t)) return t;
  return t.replace(/[Il]/g, '1').replace(/O/g, '0');
}

function isRunningHead(line, headings) {
  const k = squash(stripWatermark(line));
  if (!k) return false;
  return headings.some(h => k === squash(h) || k.startsWith(squash(h)));
}

function normalizeLine(line) {
  return repairChoiceLabels(stripWatermark(line));
}

module.exports = {
  squash, stripWatermark, repairChoiceLabels, repairKeyNumeral,
  isRunningHead, normalizeLine,
};

// scripts/og/ocr-quality.js
// Measures how badly a book's text layer is corrupted, so the re-OCR decision
// and the amount of repair logic downstream are based on counts, not vibes.

// A line is "noise" when it is mostly single characters separated by spaces —
// the shape OCR produces from a rotated table (see OG13 section 8.5).
function isNoiseLine(line) {
  const toks = line.trim().split(/\s+/);
  if (toks.length < 12) return false;
  const singles = toks.filter(t => t.length === 1).length;
  return singles / toks.length > 0.6;
}

// A line is "glued" when spaces were dropped between words, leaving a long
// run of letters that swallows a function word — "Theargumentisconcerned".
function isGluedLine(line) {
  return /[a-z]{4,}(?:the|and|that|with|of|is|in|to|for)[a-z]{3,}/i.test(line)
    || /\b[a-z]{16,}\b/.test(line);
}

function scoreText(text) {
  const lines = String(text).split('\n');
  let badChoiceC = 0, badChoiceB = 0, badKeyNumerals = 0;
  let glued = 0, watermark = 0, noise = 0;

  for (const line of lines) {
    if (/^\(0\s/.test(line)) badChoiceC++;
    if (/^\(8\)/.test(line)) badChoiceB++;
    // Key-grid numerals: a token in "<number>." position built from I/l/O
    // instead of digits, e.g. "I.", "II.", "2I.", "lOI."
    const m = line.match(/(?:^|\s)(?=[0-9IlO]*[IlO])[0-9IlO]{1,4}\.(?=\s)/g);
    if (m) badKeyNumerals += m.length;
    if (line.includes('QQ:1014347461')) watermark++;
    if (isNoiseLine(line)) noise++;
    else if (isGluedLine(line)) glued++;
  }

  return { lines: lines.length, badChoiceC, badChoiceB, badKeyNumerals, glued, watermark, noise };
}

module.exports = { scoreText, isNoiseLine, isGluedLine };

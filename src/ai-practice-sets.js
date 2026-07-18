'use strict';
const fs = require('fs');
const path = require('path');

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const LABEL_SEQUENCE = 'ABCDEFGH';

// A choice is renderable if it has visible text (after stripping zero-width
// junk the scraper leaves behind) OR an inline image (math questions).
function choiceHasContent(c) {
  const text = String(c.text ?? '').replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, '').trim();
  if (text !== '') return true;
  return !!(c.textHtml && String(c.textHtml).trim() !== '');
}

// True iff answer_choices is a well-formed single-answer choice list we can
// actually show and grade: a non-empty flat array (no nested options[] / DI),
// every choice has renderable content, and the labels are the real GMAT
// sequence A, B, C, … from A. The last check rejects the StartTest scrape bug
// that mislabels choices B/D/F/H/J (every other letter) — those rows can't be
// shown or graded honestly. Accepts a JSON string or an array.
function isFlatGradeableChoices(answerChoices) {
  let arr = answerChoices;
  if (typeof arr === 'string') {
    const text = arr.trim();
    if (!text) return false;
    try { arr = JSON.parse(text); } catch (_e) { return false; }
  }
  if (!Array.isArray(arr) || arr.length === 0 || arr.length > LABEL_SEQUENCE.length) return false;
  return arr.every(
    (c, i) => c && typeof c === 'object' && !Array.isArray(c)
      && typeof c.label === 'string'
      && c.label.trim().toUpperCase() === LABEL_SEQUENCE[i]  // sequential from A
      && !('options' in c)
      && choiceHasContent(c)
  );
}

// True iff the stored correct_answer is one of the choice labels — a row whose
// answer key points at a choice that doesn't exist can't be graded.
function correctAnswerInChoices(answerChoices, correctAnswer) {
  const key = String(correctAnswer || '').trim().toUpperCase();
  if (!key) return false;
  let arr = answerChoices;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (_e) { return false; } }
  if (!Array.isArray(arr)) return false;
  return arr.some((c) => String(c.label || '').trim().toUpperCase() === key);
}

// Validate + normalize one parsed set object.
function parseSetObject(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'not an object' };
  const slug = String(obj.slug || '').trim();
  if (!SLUG_RE.test(slug)) return { ok: false, error: 'missing/invalid slug' };
  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const items = rawItems.map((n) => Number.parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0);
  if (items.length === 0) return { ok: false, error: 'no valid items' };
  return {
    ok: true,
    set: {
      slug,
      title: String(obj.title || slug).trim(),
      focusNote: String(obj.focusNote || '').trim(),
      subject: String(obj.subject || '').trim(),
      items,
    },
  };
}

// Read every *.json in dir, return valid sets. Never throws; skips malformed.
function readSetFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_e) { return []; }
  const sets = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')); } catch (_e) { continue; }
    const res = parseSetObject(parsed);
    if (res.ok) sets.push(res.set);
  }
  return sets;
}

module.exports = { isFlatGradeableChoices, correctAnswerInChoices, choiceHasContent, parseSetObject, readSetFiles, SLUG_RE };

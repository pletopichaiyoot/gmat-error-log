'use strict';
const fs = require('fs');
const path = require('path');

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const LABEL_SEQUENCE = 'ABCDEFGH';

// A choice is renderable if it has visible text (after stripping zero-width
// junk the scraper leaves behind) OR an inline image (math questions).
function choiceHasContent(c) {
  const text = String(c.text ?? '').replace(/[\u200B\u200C\uFEFF\u00A0]/g, '').trim();
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
  // Items may be q_codes (strings — stable across rescrapes) or legacy
  // question_attempts.id (positive integers). Preserve each type as-is:
  // a numeric-looking q_code ("300263") MUST stay a string so the resolver
  // routes it by q_code, not by row id. (Do NOT Number.parseInt here — that
  // both mislabels numeric q_codes as ids and silently drops prefixed q_codes
  // like "ope-…"/"ttp-…".)
  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const items = rawItems
    .map((it) => {
      if (typeof it === 'number' && Number.isInteger(it) && it > 0) return it;
      if (typeof it === 'string' && it.trim()) return it.trim();
      return null;
    })
    .filter((it) => it !== null);
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

// Classify each `items` entry so a set file can reference questions two ways:
//   - a JSON string  → a stable `q_code` (survives Phase-1 rescrapes, which
//     delete+reinsert attempts and REASSIGN question_attempts.id).
//   - a JSON number  → a legacy question_attempts.id (still used by old set
//     files and by the per-question /grade endpoint, which posts a row id).
// Order is preserved so the runner shows questions in the curated sequence.
function classifySetItems(list) {
  const order = [];
  const ids = [];
  const qCodes = [];
  for (const it of Array.isArray(list) ? list : []) {
    if (typeof it === 'number' && Number.isInteger(it) && it > 0) {
      ids.push(it);
      order.push({ type: 'id', key: it });
    } else if (typeof it === 'string' && it.trim()) {
      const key = it.trim();
      qCodes.push(key);
      order.push({ type: 'qcode', key });
    }
  }
  return { ids, qCodes, order };
}

// A q_code can have several attempt rows (re-attempts across dates, or a
// corrupted duplicate next to a clean one). Among the gradeable ones, prefer the
// most-complete: a rendered-math stem (question_stem_html) wins big, then the
// longest stem (most enriched). Returns null if none are gradeable.
function pickBestGradeableRow(rows) {
  const ok = (Array.isArray(rows) ? rows : []).filter(
    (r) => r && isFlatGradeableChoices(r.answer_choices) && correctAnswerInChoices(r.answer_choices, r.correct_answer)
  );
  if (!ok.length) return null;
  const score = (r) => (String(r.question_stem_html || '').trim() ? 1e7 : 0) + String(r.question_stem || '').length;
  return ok.reduce((best, r) => (score(r) > score(best) ? r : best), ok[0]);
}

module.exports = { isFlatGradeableChoices, correctAnswerInChoices, choiceHasContent, parseSetObject, readSetFiles, SLUG_RE, classifySetItems, pickBestGradeableRow };

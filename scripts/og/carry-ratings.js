// scripts/og/carry-ratings.js
// Re-running the parse rebuilds the pool from the PDFs, which would discard
// the difficulty pass — the one step that costs money. Ratings are keyed on
// the question id, which is stable across parses (book, subject, printed
// number), so they are carried over instead.
//
// Only a rating backed by a stored estimate is carried: a bare label is a
// leftover from an older scheme and cannot be re-derived.

const FIELDS = [
  'difficulty', 'difficulty_pct', 'difficulty_source',
  'difficulty_model', 'difficulty_reason',
];

function indexById(pool) {
  const out = new Map();
  if (!pool) return out;
  for (const b of pool.books || []) {
    for (const s of b.sections || []) {
      for (const q of s.questions || []) out.set(q.id, q);
    }
  }
  return out;
}

function carryRatings(next, prior) {
  const before = indexById(prior);
  let carried = 0;
  for (const b of next.books || []) {
    for (const s of b.sections || []) {
      for (const q of s.questions || []) {
        const was = before.get(q.id);
        if (!was || !Number.isFinite(was.difficulty_pct)) continue;
        for (const f of FIELDS) if (was[f] !== undefined) q[f] = was[f];
        carried++;
      }
    }
  }
  return carried;
}

module.exports = { carryRatings, indexById };

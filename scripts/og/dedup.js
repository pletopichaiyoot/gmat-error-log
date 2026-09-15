// scripts/og/dedup.js
// OG12 and OG13 reprint a large share of the same questions.
//
// CR dedups per question. RC dedups per PASSAGE, because dropping only the
// questions that happen to match would leave the other edition's passage with
// part of its group — and a partial RC group is not practiceable.

// Whitespace is dropped entirely, not just collapsed: the scanned editions
// glue words together, so "the argument" and "theargument" are the same
// question printed twice and must fingerprint alike.
function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function fingerprint(text) {
  return normalize(text).slice(0, 200);
}

// Matching one printing of a question to another has to survive what the scans
// did to the text. Measured across the three books:
//
//  - OG13's CR stems open with a fragment of the previous question, so any
//    key built from the START of the stem misses the duplicate.
//  - Many CR stems END with the same boilerplate ("...most seriously weakens
//    the argument above?"), which on its own collided 16 times inside OG12 CR
//    and would have deleted distinct questions.
//
// The stem's tail plus the first choice satisfies both: zero collisions within
// a book, 49 CR and 74 RC duplicates found across the two OG editions, and
// zero false matches against Verbal Review 2e, which is a distinct pool.
const KEY_STEM_TAIL = 40;
const KEY_CHOICE_HEAD = 40;

function questionKey(q) {
  const first = q.choices && q.choices[0] ? q.choices[0].text : null;
  if (!first) return fingerprint(q.stem);
  // The TAIL of the whole stem, not of a truncated fingerprint.
  return `${normalize(q.stem).slice(-KEY_STEM_TAIL)}|${normalize(first).slice(0, KEY_CHOICE_HEAD)}`;
}

function sectionsOf(pool, kind) {
  const out = [];
  for (const book of pool.books) {
    for (const section of book.sections) {
      if (section.kind === kind) out.push({ book, section });
    }
  }
  return out;
}

function dedupPool(pool, { prefer }) {
  const rank = code => {
    const i = prefer.indexOf(code);
    return i < 0 ? prefer.length : i;
  };
  const report = { crDropped: 0, rcGroupsDropped: 0, collisions: [] };

  // --- CR: per question ------------------------------------------------
  // Usable copies are considered first, so a question the scan mangled never
  // displaces a clean one just because its edition is preferred.
  const crSections = sectionsOf(pool, 'CR')
    .sort((a, b) => rank(a.book.code) - rank(b.book.code));
  const crSeen = new Map();
  for (const pass of [true, false]) {
    for (const { book, section } of crSections) {
      for (const q of section.questions) {
        if (Boolean(q.usable) !== pass || q.dropped) continue;
        const fp = questionKey(q);
        const prior = crSeen.get(fp);
        if (prior) {
          prior.refs.push({ book: book.code, number: q.number });
          q.dropped = true;
          report.crDropped++;
          report.collisions.push({ kept: prior.id, dropped: q.id });
        } else {
          crSeen.set(fp, q);
        }
      }
    }
  }
  for (const { section } of crSections) {
    section.questions = section.questions.filter(q => !q.dropped);
  }

  // --- RC: per passage group -------------------------------------------
  const rcSeen = new Map();
  for (const { book, section } of sectionsOf(pool, 'RC')
    .sort((a, b) => rank(a.book.code) - rank(b.book.code))) {
    const keptPassages = [];
    const dropIds = new Set();
    for (const p of (section.passages || [])) {
      const fp = fingerprint(p.text);
      const prior = rcSeen.get(fp);
      if (prior) {
        (prior.refs = prior.refs || []).push({ book: book.code, passageId: p.id });
        dropIds.add(p.id);
        report.rcGroupsDropped++;
        report.collisions.push({ kept: prior.id, dropped: p.id });
      } else {
        rcSeen.set(fp, p);
        keptPassages.push(p);
      }
    }
    section.passages = keptPassages;
    section.questions = section.questions.filter(q => !dropIds.has(q.passageId));
  }

  // A passage no usable question points at is dead weight: it would show up in
  // a passage list with nothing to practise on it.
  report.orphanPassagesDropped = 0;
  const served = new Set();
  for (const b of pool.books) {
    for (const s of b.sections) {
      for (const q of s.questions) if (q.usable && q.passageId) served.add(q.passageId);
    }
  }
  for (const { section } of sectionsOf(pool, 'RC')) {
    const before = (section.passages || []).length;
    section.passages = (section.passages || []).filter(p => served.has(p.id));
    report.orphanPassagesDropped += before - section.passages.length;
  }

  return { pool, report };
}

module.exports = { fingerprint, normalize, questionKey, dedupPool };

// scripts/og/dedup.js
// OG12 and OG13 reprint a large share of the same questions.
//
// CR dedups per question. RC dedups per PASSAGE, because dropping only the
// questions that happen to match would leave the other edition's passage with
// part of its group — and a partial RC group is not practiceable.

// Whitespace is dropped entirely, not just collapsed: the scanned editions
// glue words together, so "the argument" and "theargument" are the same
// question printed twice and must fingerprint alike.
function fingerprint(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 200);
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
        const fp = fingerprint(q.stem);
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

  return { pool, report };
}

module.exports = { fingerprint, dedupPool };

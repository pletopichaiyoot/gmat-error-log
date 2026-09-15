// scripts/og/verify.js
// The spec's acceptance criteria, as runnable checks.
//
// The checks apply to the USABLE pool — the questions the practice track would
// actually serve. A question the scans mangled is already marked unusable and
// carries its reason; counting those as failures would only restate what the
// parse report says.

const JUNK = /QQ:\d{6,}|制作/;

function usableQuestions(pool) {
  const out = [];
  for (const b of pool.books) {
    for (const s of b.sections) {
      for (const q of s.questions) if (q.usable) out.push({ book: b, section: s, q });
    }
  }
  return out;
}

function verifyPool(pool) {
  const all = usableQuestions(pool);
  const checks = [];
  const add = (name, bad) => checks.push({
    name, ok: bad.length === 0,
    detail: bad.length ? `${bad.length}: ${bad.slice(0, 8).join(', ')}` : `${all.length} checked`,
  });

  add('every usable question is keyed', all.filter(x => !x.q.correct).map(x => x.q.id));
  add('no usable question has a disputed key', all.filter(x => x.q.keyDisputed).map(x => x.q.id));
  add('every usable question has five choices',
    all.filter(x => (x.q.choices || []).length !== 5).map(x => x.q.id));
  add('no choice is blank',
    all.filter(x => (x.q.choices || []).some(c => !c.text || !c.text.trim())).map(x => x.q.id));
  add('no watermark or footer junk',
    all.filter(x => JUNK.test(x.q.stem) || (x.q.choices || []).some(c => JUNK.test(c.text)))
      .map(x => x.q.id));
  // The type label and rationale come from the explanation, which is dropped
  // when it turns out to reprint a different question. The question is still
  // answerable — stem, choices and printed key — so enrichment is reported,
  // not required.
  add('every attached explanation carries a type label',
    all.filter(x => x.q.explanation && !x.q.typeLabel).map(x => x.q.id));
  const unenriched = all.filter(x => !x.q.explanation).length;
  checks.push({
    name: 'questions carrying an explanation', ok: true,
    detail: `${all.length - unenriched} of ${all.length}` +
      (unenriched ? ` (${unenriched} keyed but unenriched)` : ''),
  });

  add('every usable RC question has a passage',
    all.filter(x => x.section.kind === 'RC' && !x.q.passageId).map(x => x.q.id));

  const known = new Set();
  for (const b of pool.books) {
    for (const s of b.sections) for (const p of (s.passages || [])) known.add(p.id);
  }
  add('every referenced passage exists',
    all.filter(x => x.q.passageId && !known.has(x.q.passageId)).map(x => x.q.id));

  const used = new Set(all.filter(x => x.q.passageId).map(x => x.q.passageId));
  const orphans = [];
  for (const b of pool.books) {
    for (const s of b.sections) {
      for (const p of (s.passages || [])) if (!used.has(p.id)) orphans.push(p.id);
    }
  }
  add('every passage serves a usable question', orphans);

  const seen = new Set();
  const dupes = [];
  for (const b of pool.books) {
    for (const s of b.sections) {
      for (const q of s.questions) {
        if (seen.has(q.id)) dupes.push(q.id);
        seen.add(q.id);
      }
    }
  }
  add('question ids are unique', dupes);

  return { ok: checks.every(c => c.ok), checks, usable: all.length };
}

module.exports = { verifyPool };
